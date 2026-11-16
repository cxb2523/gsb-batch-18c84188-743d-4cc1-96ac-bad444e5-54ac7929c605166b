#!/usr/bin/env python3
"""
Fake, dependency-free stand-in for ffmpeg, used by test_exporter.py.

Two invocations are supported (same shapes as exporter.py):

1. Raw video encoder:
       ffmpeg ... -f rawvideo -pix_fmt rgb24 -s WxH -r FPS -i - ... out.mp4
   The raw RGB frames on stdin are counted (W * H * 3 bytes per frame) and the
   count is written next to the output as "<out>.frames".

2. Mux invocation (several -i inputs + an ffmetadata file):
   The meta file is copied next to the output as "<out>.meta", all arguments
   are dumped to "<out>.cmd" and an (empty) output file is created, so the real
   exporter's success path runs end to end.
"""
import json
import os
import sys


def main():
    args = sys.argv[1:]
    inputs = []
    i = 0
    fps = 60
    size = None
    while i < len(args):
        a = args[i]
        if a == "-i":
            inputs.append(args[i + 1])
            i += 2
            continue
        if a == "-r" and i + 1 < len(args):
            try:
                fps = int(float(args[i + 1]))
            except ValueError:
                pass
        if a == "-s" and i + 1 < len(args):
            size = args[i + 1]
        i += 1

    output = args[-1]
    with open(output + ".cmd", "w", encoding="utf-8") as f:
        json.dump(args, f)

    if "-f" in args and "rawvideo" in args:
        width, height = (int(x) for x in size.split("x"))
        frame_bytes = width * height * 3
        data = sys.stdin.buffer.read()
        frames = len(data) // frame_bytes
        with open(output + ".frames", "w", encoding="utf-8") as f:
            f.write(str(frames))
    else:
        # mux call: persist the ffmetadata input so tests can inspect chapters
        for inp in inputs:
            if inp != "-" and os.path.exists(inp):
                with open(inp, "r", encoding="utf-8") as src:
                    head = src.read(4096)
                if head.startswith(";FFMETADATA1"):
                    with open(output + ".meta", "w", encoding="utf-8") as dst:
                        dst.write(head)
                    break

    with open(output, "wb") as f:
        f.write(b"FAKE-MP4")
    return 0


if __name__ == "__main__":
    sys.exit(main())
