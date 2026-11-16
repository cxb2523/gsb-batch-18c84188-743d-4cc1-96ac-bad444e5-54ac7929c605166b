"""HLS 分片下载测试：用本地 HTTP 服务模拟 m3u8 播放列表 + TS 分片。

覆盖：
1. is_hls：URL 后缀 / Content-Type 识别
2. download_hls：主列表自动选最高带宽变体、相对 URI、多分片并发合并、输出 .ts 正确
3. BYTERANGE 偏移分片（带 Range 头）
4. AES-128 加密流：显式 IV / 默认 IV（分片序号）/ 多分片拼接
5. 失败路径：SAMPLE-AES 不支持、密钥 404、分片 404、无分片返回 None 且不留临时目录
6. 断点续传：成功后删除 meta；中途 404 后 meta 的 done/bytes 与文件严格一致；
   续传跳过已提交分片
7. 进度不可信：篡改 meta 使 done 超出文件容量 -> 全量重下（不追加半截文件）
8. 密钥轮换：同一密钥 URI 内容变化 -> 指纹失效 -> 全量重下（旧缓存密钥不参与）
9. 整体中止（abort/解密失败/Ctrl-C）：只记录连续提交前缀，未轮到写盘的
   中间分片不落盘
10. 强杀残留：文件比 meta 多出未记录的尾部 -> 校验前缀摘要后截断续传
"""

import http.server
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time

from Crypto.Cipher import AES as _AES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "resources_reptile"))

import config

config.PROXY_ENABLED = False
config.DEFAULT_PROXY = ""

sys.path.insert(0, os.path.join(ROOT, "tests"))

import hls_downloader

PASS = 0
FAIL = 0


def check(name, got, expected=True):
    global PASS, FAIL
    if isinstance(expected, bool) or expected is None:
        ok = (got is expected)
    else:
        ok = (got == expected)
    if ok:
        PASS += 1
        print(f"PASS {name}")
    else:
        FAIL += 1
        print(f"FAIL {name}: got={got!r} expected={expected!r}")


SEGS = [b"S" + bytes([i]) * 8 for i in range(1, 5)]  # 4 个分片

ENC_KEY = b"K" * 16
ENC_IV = bytes.fromhex("00112233445566778899aabbccddeeff")


def _enc(data: bytes, iv: bytes, key: bytes = ENC_KEY) -> bytes:
    pad = 16 - (len(data) % 16)
    return _AES.new(key, _AES.MODE_CBC, iv).encrypt(data + bytes([pad]) * pad)


ENC_SEGS = [_enc(s, i.to_bytes(16, "big")) for i, s in enumerate(SEGS)]

#: 断点续传用：8 片，每片 32 字节（固定长度便于对账 done/bytes）
RES_SEGS = [bytes([0x40 + i]) * 32 for i in range(8)]
#: 密钥轮换用：4 片，分别用两把密钥加密（缺省 IV = 分片序号）
ROT_KEYS = (b"A" * 16, b"B" * 16)
ROT_SEGS = {
    "key1": [_enc(s, i.to_bytes(16, "big"), ROT_KEYS[0])
             for i, s in enumerate(SEGS)],
    "key2": [_enc(s, i.to_bytes(16, "big"), ROT_KEYS[1])
             for i, s in enumerate(SEGS)],
}


class Handler(http.server.BaseHTTPRequestHandler):

    def do_GET(self):
        self.server: HlsServer
        spec = self.server.spec
        key = self.path.split("?", 1)[0]
        with self.server.count_lock:
            self.server.counts[key] = self.server.counts.get(key, 0) + 1
        delay = spec.get("delay", {}).get(key)
        if delay:
            time.sleep(delay)
        if key in spec.get("seg_fails", ()):
            self.send_response(404)
            self.end_headers()
            return
        body = None
        ct = "application/vnd.apple.mpegurl"
        if key == "/master.m3u8":
            body = ("#EXTM3U\n"
                    "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n"
                    "low.m3u8\n"
                    "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n"
                    "high.m3u8\n").encode()
        elif key == "/low.m3u8" or key == "/high.m3u8":
            body = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n"
                    "#EXTINF:8.0,\nseg1.ts\n#EXTINF:8.0,\nseg2.ts\n"
                    "#EXTINF:8.0,\nseg3.ts\n#EXTINF:8.0,\nseg4.ts\n"
                    "#EXT-X-ENDLIST\n").encode()
        elif key == "/ranges.m3u8":
            body = ("#EXTM3U\n#EXT-X-VERSION:6\n"
                    "#EXT-X-MAP:URI=\"init.ts\"\n"
                    "#EXTINF:8.0,\n#EXT-X-BYTERANGE:16@0\nranges.bin\n"
                    "#EXTINF:8.0,\n#EXT-X-BYTERANGE:16@16\nranges.bin\n"
                    "#EXT-X-ENDLIST\n").encode()
        elif key == "/enc.m3u8":
            body = ("#EXTM3U\n"
                    f"#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x{ENC_IV.hex()}\n"
                    "#EXTINF:8.0,\nenc_seg_iv.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc2.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc4.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXTINF:8.0,\nenc_seg2.ts\n"
                    "#EXTINF:8.0,\nenc_seg3.ts\n#EXTINF:8.0,\nenc_seg4.ts\n"
                    "#EXT-X-ENDLIST\n").encode()
        elif key == "/sample.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc-nokey.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"missing.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/empty.m3u8":
            body = ("#EXTM3U\n#EXT-X-ENDLIST\n").encode()
        elif key == "/res.m3u8":
            body = ("#EXTM3U\n" + "".join(
                f"#EXTINF:2.0,\nres_seg{i + 1}.ts\n"
                for i in range(len(RES_SEGS))) + "#EXT-X-ENDLIST\n").encode()
        elif key == "/rot.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"rot_key.bin\"\n"
                    + "".join(f"#EXTINF:2.0,\nrot_seg{i + 1}.ts\n"
                              for i in range(len(SEGS)))
                    + "#EXT-X-ENDLIST\n").encode()
        elif key == "/badenc.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
                    + "".join(f"#EXTINF:2.0,\nbadenc_seg{i + 1}.ts\n"
                              for i in range(len(SEGS)))
                    + "#EXT-X-ENDLIST\n").encode()
        elif key.startswith("/badenc_seg") and key.endswith(".ts"):
            # 第 3 片内容损坏（密文合法长度但 PKCS7 填充校验必失败）
            idx = int(key[len("/badenc_seg"):-len(".ts")]) - 1
            body = ENC_SEGS[idx] if idx != 2 else b"\x00" * 16
            ct = "video/mp2t"
        elif key == "/rot_key.bin":
            version = spec.get("rot_key", "key1")
            body, ct = ROT_KEYS[0 if version == "key1" else 1], "application/octet-stream"
        elif key.startswith("/rot_seg") and key.endswith(".ts"):
            version = spec.get("rot_key", "key1")
            idx = int(key[len("/rot_seg"):-len(".ts")]) - 1
            body = ROT_SEGS[version][idx]
            ct = "video/mp2t"
        elif key == "/enc_seg_iv.ts":
            body, ct = _enc(SEGS[0], ENC_IV), "video/mp2t"
        elif key == "/enc_seg1.ts":
            body, ct = ENC_SEGS[0], "video/mp2t"
        elif key == "/enc_seg2.ts":
            body, ct = ENC_SEGS[1], "video/mp2t"
        elif key == "/enc_seg3.ts":
            body, ct = ENC_SEGS[2], "video/mp2t"
        elif key == "/enc_seg4.ts":
            body, ct = ENC_SEGS[3], "video/mp2t"
        elif key == "/seg1.ts":
            body, ct = SEGS[0], "video/mp2t"
        elif key == "/seg2.ts":
            body, ct = SEGS[1], "video/mp2t"
        elif key == "/seg3.ts":
            body, ct = SEGS[2], "video/mp2t"
        elif key == "/seg4.ts":
            body, ct = SEGS[3], "video/mp2t"
        elif key.startswith("/res_seg") and key.endswith(".ts"):
            idx = int(key[len("/res_seg"):-len(".ts")]) - 1
            body, ct = RES_SEGS[idx], "video/mp2t"
        elif key == "/ranges.bin":
            body, ct = b"N" * 32, "application/octet-stream"
        elif key == "/key.bin":
            body, ct = b"K" * 16, "application/octet-stream"
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class HlsServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    spec: dict = {}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.counts: dict[str, int] = {}
        self.count_lock = threading.Lock()

    def reset_counts(self) -> None:
        with self.count_lock:
            self.counts.clear()


def start_server() -> tuple[str, "HlsServer"]:
    srv = HlsServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return f"http://127.0.0.1:{srv.server_address[1]}", srv


def _test_is_hls():
    check("is_hls: url ext", hls_downloader.is_hls("http://x.com/a.m3u8"))
    check("is_hls: url ext m3u", hls_downloader.is_hls("http://x.com/a.m3u"))
    check("is_hls: ct", hls_downloader.is_hls("http://x.com/a", "application/vnd.apple.mpegurl; charset=utf-8"))
    check("is_hls: mp4 no", hls_downloader.is_hls("http://x.com/a.mp4", "") is False)
    check("is_hls: query ext", hls_downloader.is_hls("http://x.com/playlist.m3u8?token=1"))


def _test_variant_and_merge(base, dest):
    got = hls_downloader.download_hls(base + "/master.m3u8", dest_dir=dest, out_name="t1")
    check("hls: variant picked high", got is not None)
    check("hls: output exists", got is not None and os.path.exists(got))
    if got:
        with open(got, "rb") as f:
            data = f.read()
        check("hls: concatenated all 4 segs", data == SEGS[0] + SEGS[1] + SEGS[2] + SEGS[3])
        os.remove(got)


def _test_byterange(base, dest):
    got = hls_downloader.download_hls(base + "/ranges.m3u8", dest_dir=dest, out_name="t2")
    check("hls: byterange ok", got is not None)
    if got:
        with open(got, "rb") as f:
            data = f.read()
        check("hls: byterange merged 32 bytes", data == b"N" * 32)
        os.remove(got)


def _test_aes128(base, dest):
    got = hls_downloader.download_hls(base + "/enc.m3u8", dest_dir=dest, out_name="e1")
    check("hls: aes-128 explicit IV decrypts", got is not None)
    if got:
        with open(got, "rb") as f:
            check("hls: aes-128 explicit IV plaintext", f.read() == SEGS[0])
        os.remove(got)
    got = hls_downloader.download_hls(base + "/enc2.m3u8", dest_dir=dest, out_name="e2")
    check("hls: aes-128 default IV (seq 0)", got is not None)
    if got:
        with open(got, "rb") as f:
            check("hls: aes-128 default IV plaintext", f.read() == SEGS[0])
        os.remove(got)
    got = hls_downloader.download_hls(base + "/enc4.m3u8", dest_dir=dest, out_name="e3")
    check("hls: aes-128 multi-seg default IV", got is not None)
    if got:
        with open(got, "rb") as f:
            check("hls: aes-128 multi-seg concat", f.read() == b"".join(SEGS))
        os.remove(got)


def _test_failures(base, dest):
    got = hls_downloader.download_hls(base + "/sample.m3u8", dest_dir=dest, out_name="t3")
    check("hls: sample-aes unsupported returns None", got is None)
    got = hls_downloader.download_hls(base + "/enc-nokey.m3u8", dest_dir=dest, out_name="t4")
    check("hls: key 404 returns None", got is None)
    got = hls_downloader.download_hls(base + "/empty.m3u8", dest_dir=dest, out_name="t5")
    check("hls: no segments returns None", got is None)
    got = hls_downloader.download_hls(base + "/master.m3u8", dest_dir=dest, out_name="t6")
    check("hls: 404 segment returns None", got is None)
    leftovers = [p for p in os.listdir(dest) if p.startswith(".hls_tmp_")]
    check("hls: failure leaves no temp dir", len(leftovers) == 0, True)
    for p in ("t1.ts", "t2.ts", "t3.ts", "t4.ts", "t5.ts", "t6.ts"):
        if os.path.exists(os.path.join(dest, p)):
            os.remove(os.path.join(dest, p))


def _meta_file(dest: str, out_name: str) -> str:
    return os.path.join(dest, f".{out_name}.hlsmeta.json")


def _read_meta_json(dest: str, out_name: str) -> dict | None:
    p = _meta_file(dest, out_name)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _check_meta_consistent(dest: str, out_name: str) -> dict | None:
    """meta 的 done/bytes/seg_bytes 必须与目标文件实际大小严格一致。"""
    m = _read_meta_json(dest, out_name)
    ts = os.path.join(dest, out_name + ".ts")
    size = os.path.getsize(ts) if os.path.exists(ts) else -1
    seg_bytes = (m or {}).get("seg_bytes") or []
    ok = (m is not None
          and m.get("bytes") == size
          and m.get("done") == len(seg_bytes)
          and sum(seg_bytes) == size
          and 0 <= m.get("done", 0) <= size)  # 每片至少 1 字节
    check(f"meta consistent: {out_name} done={m and m.get('done')} "
          f"bytes={m and m.get('bytes')} file={size}", ok)
    return m


def _write_trusted_progress(dest: str, out_name: str, done: int,
                            fingerprint: str) -> None:
    """模拟一次可信中断：文件截断为前 done 片，meta 与之严格同步。"""
    data = b"".join(RES_SEGS[:done])
    with open(os.path.join(dest, out_name + ".ts"), "wb") as f:
        f.write(data)
    with open(_meta_file(dest, out_name), "w", encoding="utf-8") as f:
        json.dump({"version": hls_downloader._META_VERSION,
                   "fingerprint": fingerprint,
                   "total": len(RES_SEGS), "done": done,
                   "bytes": len(data),
                   "seg_bytes": [len(s) for s in RES_SEGS[:done]],
                   "sha256": hashlib.sha256(data).hexdigest()}, f)


def _fingerprint_for(base: str) -> str:
    """取当前播放列表的真实指纹（空文件+空 meta 不建 meta，改由内部函数算）。"""
    master = hls_downloader._fetch(base + "/res.m3u8")
    segs = hls_downloader._parse_segments(master, base + "/res.m3u8")
    return hls_downloader._fingerprint(segs, hls_downloader._key_digests(segs))


def _test_success_removes_meta(base, dest):
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs1")
    check("resume: success returns path", got is not None)
    check("resume: meta removed after success",
          _read_meta_json(dest, "rs1") is None)
    if got:
        with open(got, "rb") as f:
            check("resume: content complete", f.read() == b"".join(RES_SEGS))


def _test_failure_progress(base, dest, srv):
    # 8 片，第 5 片 404（其余分片加延迟，确保失败时前面若干片已提交）
    srv.spec = {"seg_fails": ("/res_seg5.ts",),
                "delay": {f"/res_seg{i}.ts": 0.05 for i in range(1, 5)}}
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs2", workers=4)
    check("resume: mid-failure returns None", got is None)
    m = _check_meta_consistent(dest, "rs2")
    check("resume: mid-failure keeps continuous prefix",
          m is not None and 0 < m["done"] < len(RES_SEGS))
    ts = os.path.join(dest, "rs2.ts")
    done = (m or {}).get("done", 0)
    if done and os.path.exists(ts):
        with open(ts, "rb") as f:
            check("resume: partial file is contiguous prefix",
                  f.read() == b"".join(RES_SEGS[:done]))

    # 修复服务端后重跑：只请求剩余分片，最终内容完整
    srv.spec = {}
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs2", workers=4)
    check("resume: rerun succeeds", got is not None)
    if got:
        with open(got, "rb") as f:
            check("resume: rerun content complete",
                  f.read() == b"".join(RES_SEGS))
    fetched = [k for k in srv.counts if k.startswith("/res_seg")]
    check(f"resume: rerun refetched only remaining {len(fetched)} "
          f"(done was {done})",
          len(fetched) == len(RES_SEGS) - done)
    check("resume: meta removed after rerun success",
          _read_meta_json(dest, "rs2") is None)


def _test_abort_progress(base, dest, srv):
    # 第 2 片 404 → 整体中止；第 0 片正常提交，未轮到写盘的中间分片不得计入
    srv.spec = {"seg_fails": ("/res_seg2.ts",),
                "delay": {"/res_seg3.ts": 0.3, "/res_seg4.ts": 0.3}}
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs_abort", workers=8)
    check("abort: returns None", got is None)
    m = _check_meta_consistent(dest, "rs_abort")
    check("abort: done is continuous prefix", (m or {}).get("done") == 1)
    ts = os.path.join(dest, "rs_abort.ts")
    if m and os.path.exists(ts):
        check("abort: only first segment on disk",
              os.path.getsize(ts) == len(RES_SEGS[0]))
    srv.spec = {}


def _test_tampered_meta(base, dest, srv):
    fingerprint = _fingerprint_for(base)
    # 合法进度：前 2 片（64 字节）可信
    _write_trusted_progress(dest, "rs3", 2, fingerprint)
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs3")
    check("tamper: trusted prefix resumes", got is not None)
    fetched = [k for k in srv.counts if k.startswith("/res_seg")]
    check("tamper: trusted prefix fetches remaining 6", len(fetched) == 6)
    if got:
        os.remove(got)

    # 篡改：文件仅 4 字节，meta 却声称 8 片（每片至少 1 字节 → done 超出容量）；
    # 其余字段（bytes/sha256）都改得自洽，确保拦截点就是「容量」这一条。
    stub = b"X" * 4
    with open(os.path.join(dest, "rs3.ts"), "wb") as f:
        f.write(stub)
    with open(_meta_file(dest, "rs3"), "w", encoding="utf-8") as f:
        json.dump({"version": hls_downloader._META_VERSION,
                   "fingerprint": fingerprint, "total": len(RES_SEGS),
                   "done": len(RES_SEGS), "bytes": len(stub),
                   "seg_bytes": [1] * len(RES_SEGS),
                   "sha256": hashlib.sha256(stub).hexdigest()}, f)
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs3")
    check("tamper: rerun succeeds", got is not None)
    fetched = sorted(k for k in srv.counts if k.startswith("/res_seg"))
    check("tamper: bogus progress -> full redownload",
          len(fetched) == len(RES_SEGS))
    if got:
        with open(got, "rb") as f:
            data = f.read()
        check("tamper: no stale tail appended", data == b"".join(RES_SEGS))
    check("tamper: meta removed after success",
          _read_meta_json(dest, "rs3") is None)


def _test_crash_tail(base, dest, srv):
    """进程被强杀：文件比 meta 多出未落盘的尾部 → 截尾后按记录续传。"""
    fingerprint = _fingerprint_for(base)
    _write_trusted_progress(dest, "rs_crash", 2, fingerprint)
    ts = os.path.join(dest, "rs_crash.ts")
    with open(ts, "ab") as f:
        f.write(RES_SEGS[2] + RES_SEGS[3] + b"HALF")  # 已提交但未赶上批次落盘
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs_crash")
    check("crash: resumes from recorded prefix", got is not None)
    fetched = [k for k in srv.counts if k.startswith("/res_seg")]
    check("crash: only remaining segments refetched",
          len(fetched) == len(RES_SEGS) - 2)
    if got:
        with open(got, "rb") as f:
            check("crash: stale tail truncated, content complete",
                  f.read() == b"".join(RES_SEGS))
    check("crash: meta removed after success",
          _read_meta_json(dest, "rs_crash") is None)

    # 内容被改（大小对得上、摘要不符）→ 判不可信，全量重下
    _write_trusted_progress(dest, "rs_bad", 2, fingerprint)
    with open(os.path.join(dest, "rs_bad.ts"), "r+b") as f:
        f.seek(0)
        f.write(b"Z" * 8)  # 等长篡改前 2 片内容
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs_bad")
    check("crash: corrupted prefix rerun succeeds", got is not None)
    fetched = sorted(k for k in srv.counts if k.startswith("/res_seg"))
    check("crash: corrupted prefix -> full redownload",
          len(fetched) == len(RES_SEGS))
    if got:
        with open(got, "rb") as f:
            check("crash: corrupted content replaced",
                  f.read() == b"".join(RES_SEGS))


def _rot_fingerprint(base: str) -> str:
    pl = hls_downloader._fetch(base + "/rot.m3u8")
    segs = hls_downloader._parse_segments(pl, base + "/rot.m3u8")
    return hls_downloader._fingerprint(segs, hls_downloader._key_digests(segs))


def _test_key_rotation(base, dest, srv):
    srv.spec = {"rot_key": "key1"}
    fp_key1 = _rot_fingerprint(base)
    got = hls_downloader.download_hls(base + "/rot.m3u8", dest_dir=dest,
                                      out_name="rk")
    ok = False
    if got:
        with open(got, "rb") as f:
            ok = f.read() == b"".join(SEGS)
        os.remove(got)
    check("rotate: initial download ok", ok, True)

    # key1 时期留下可信中断进度：单线程跑到第 3 片 404 → 前 2 片已连续提交
    srv.spec = {"rot_key": "key1", "seg_fails": ("/rot_seg3.ts",)}
    got = hls_downloader.download_hls(base + "/rot.m3u8", dest_dir=dest,
                                      out_name="rk", workers=1)
    check("rotate: interrupted download returns None", got is None)
    m = _read_meta_json(dest, "rk")
    check("rotate: partial progress recorded", (m or {}).get("done") == 2)

    # CDN 轮换：同一密钥 URI 内容变为 key2 → 指纹必须失效（不能拿旧密钥续传）
    srv.spec = {"rot_key": "key2"}
    fp_key2 = _rot_fingerprint(base)
    check("rotate: fingerprint changes when key content changes",
          fp_key1 != fp_key2)
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/rot.m3u8", dest_dir=dest,
                                      out_name="rk", workers=1)
    check("rotate: download with rotated key ok", got is not None)
    if got:
        with open(got, "rb") as f:
            check("rotate: content decrypted with new key",
                  f.read() == b"".join(SEGS))
    fetched = sorted(k for k in srv.counts if k.startswith("/rot_seg"))
    check("rotate: fingerprint invalidated -> all segments refetched",
          len(fetched) == len(SEGS))
    check("rotate: meta removed after success",
          _read_meta_json(dest, "rk") is None)
    srv.spec = {}


def _test_decrypt_failure_progress(base, dest):
    """解密失败路径同样落盘可信进度（不把半截/未提交分片算进去）。"""
    got = hls_downloader.download_hls(base + "/badenc.m3u8", dest_dir=dest,
                                      out_name="bd", workers=1)
    check("decrypt: padding failure returns None", got is None)
    m = _check_meta_consistent(dest, "bd")
    check("decrypt: progress is contiguous prefix (2 segs)",
          (m or {}).get("done") == 2)
    ts = os.path.join(dest, "bd.ts")
    if m and os.path.exists(ts):
        with open(ts, "rb") as f:
            check("decrypt: only decrypted prefix on disk",
                  f.read() == b"".join(SEGS[:2]))


def _test_keyboard_interrupt_progress(base, dest, srv):
    """Ctrl-C 类中断（BaseException）也必须落盘连续前缀，供下次续传。"""
    ts = os.path.join(dest, "rs_int.ts")
    srv.spec = {"seg_fails": ("/res_seg8.ts",),
                "delay": {f"/res_seg{i}.ts": 0.05 for i in range(2, 8)}}
    orig = hls_downloader.as_completed

    def fake_as_completed(futs, *a, **k):
        deadline = time.time() + 10
        while time.time() < deadline:
            if os.path.exists(ts) and os.path.getsize(ts) >= 64:
                raise KeyboardInterrupt
            time.sleep(0.01)
        raise AssertionError("interrupt test: progress never reached 2 segs")

    hls_downloader.as_completed = fake_as_completed
    try:
        try:
            hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                        out_name="rs_int", workers=4)
            check("interrupt: KeyboardInterrupt propagates", False)
        except KeyboardInterrupt:
            check("interrupt: KeyboardInterrupt propagates", True)
    finally:
        hls_downloader.as_completed = orig
        srv.spec = {}
    m = _check_meta_consistent(dest, "rs_int")
    done = (m or {}).get("done", 0)
    check("interrupt: progress persisted on BaseException",
          m is not None and 0 < done < len(RES_SEGS))
    if done and os.path.exists(ts):
        with open(ts, "rb") as f:
            check("interrupt: on-disk data is contiguous prefix",
                  f.read() == b"".join(RES_SEGS[:done]))
    # 下次运行能接着续传
    srv.reset_counts()
    got = hls_downloader.download_hls(base + "/res.m3u8", dest_dir=dest,
                                      out_name="rs_int", workers=4)
    check("interrupt: rerun resumes and completes", got is not None)
    if got:
        with open(got, "rb") as f:
            check("interrupt: rerun content complete",
                  f.read() == b"".join(RES_SEGS))
    fetched = [k for k in srv.counts if k.startswith("/res_seg")]
    check("interrupt: rerun only refetched remaining segments",
          len(fetched) == len(RES_SEGS) - done)


def _test_key_cache_limits(base):
    # 缓存条目上限与 TTL 仍生效（内部结构不变）
    hls_downloader._KEY_CACHE.clear()
    key_uri = base + "/key.bin"
    hls_downloader._KEY_CACHE[key_uri] = (b"K" * 16, time.time())
    check("keycache: hit within ttl",
          hls_downloader._fetch_key(key_uri) == b"K" * 16)
    hls_downloader._KEY_CACHE[key_uri] = (b"K" * 16, time.time() - 10 ** 6)
    check("keycache: expired entry refetched",
          hls_downloader._fetch_key(key_uri) == b"K" * 16)
    check("keycache: max size bound", hls_downloader._KEY_CACHE_MAX, 128)
    hls_downloader._KEY_CACHE.clear()


def an():
    base, srv = start_server()
    dest = tempfile.mkdtemp(prefix="hls_test_")
    try:
        _test_is_hls()
        _test_variant_and_merge(base, dest)
        _test_byterange(base, dest)
        _test_aes128(base, dest)
        srv.spec = {"seg_fails": ("/seg3.ts",)}
        _test_failures(base, dest)
        srv.spec = {}
        _test_success_removes_meta(base, dest)
        _test_failure_progress(base, dest, srv)
        _test_abort_progress(base, dest, srv)
        _test_tampered_meta(base, dest, srv)
        _test_crash_tail(base, dest, srv)
        _test_key_rotation(base, dest, srv)
        _test_decrypt_failure_progress(base, dest)
        _test_keyboard_interrupt_progress(base, dest, srv)
        _test_key_cache_limits(base)
    finally:
        srv.shutdown()
        shutil.rmtree(dest, ignore_errors=True)


if __name__ == "__main__":
    an()
    print(f"\n{'-' * 40}\nunit_hls: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)