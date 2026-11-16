// Frame-perfect clip export. Steps the world at a fixed frame rate (no matter how fast the machine is),
// encodes H.264 video and AAC audio with WebCodecs, and writes a standard MP4 (index first, one mdat),
// which is what X and most uploaders expect. Sound is rendered offline in sync with the frames.

const enc = new TextEncoder();
const u8 = (...b) => new Uint8Array(b);
const u16 = (v) => u8((v >> 8) & 255, v & 255);
const u32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const i32 = (v) => u32(v >>> 0);
const u64 = (v) => {
  const hi = Math.floor(v / 2 ** 32), lo = v >>> 0;
  return cat(u32(hi), u32(lo));
};
function cat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...body) => { const b = cat(...body); return cat(u32(8 + b.length), enc.encode(type), b); };
const full = (type, version, flags, ...body) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);
const MATRIX = cat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

function runLength(values) {
  const out = [];
  for (const v of values) {
    if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
    else out.push([1, v]);
  }
  return out;
}

function descriptor(tag, ...body) {
  const b = cat(...body);
  return cat(u8(tag, b.length), b);
}

function trak({ id, handler, timescale, samples, sampleEntry, width = 0, height = 0, offsets, movieTs }) {
  const mediaDur = samples.reduce((a, s) => a + s.dur, 0);
  const trackDur = Math.round((mediaDur * movieTs) / timescale);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(trackDur), u32(0), u32(0), u16(0), u16(0),
    u16(handler === 'soun' ? 0x100 : 0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDur), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), enc.encode(handler), u32(0), u32(0), u32(0), enc.encode(handler === 'vide' ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mh = handler === 'vide' ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const stts = runLength(samples.map((s) => s.dur));
  const parts = [
    full('stsd', 0, 0, u32(1), sampleEntry),
    full('stts', 0, 0, u32(stts.length), ...stts.map(([n, d]) => cat(u32(n), u32(d)))),
  ];
  if (samples.some((s) => s.cto)) {
    const ctts = runLength(samples.map((s) => s.cto || 0));
    parts.push(full('ctts', 1, 0, u32(ctts.length), ...ctts.map(([n, o]) => cat(u32(n), i32(o)))));
  }
  if (handler === 'vide' && !samples.every((s) => s.key)) {
    const sync = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    parts.push(full('stss', 0, 0, u32(sync.length), ...sync.map((i) => u32(i))));
  }
  // one chunk per track (samples are written contiguously)
  parts.push(full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)));
  parts.push(full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))));
  parts.push(full('co64', 0, 0, u32(1), u64(offsets)));
  return { box: box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mh, dinf, box('stbl', ...parts)))), trackDur };
}

/** video: { width, height, timescale, samples: [{ data, dur, key, cto }], avcC }, audio: { timescale, samples: [{ data, dur }], asc, channels, sampleRate } */
export function muxMp4(video, audio) {
  const movieTs = 1000;
  const avc1 = box('avc1', u8(0, 0, 0, 0, 0, 0), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0), u16(video.width), u16(video.height),
    u32(0x480000), u32(0x480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff), box('avcC', video.avcC));
  let mp4a = null;
  if (audio) {
    const bitrate = 192000;
    const esds = full('esds', 0, 0, descriptor(0x03, u16(1), u8(0),
      descriptor(0x04, u8(0x40, 0x15), u8(0, 0x18, 0), u32(bitrate), u32(bitrate), descriptor(0x05, audio.asc)),
      descriptor(0x06, u8(0x02))));
    mp4a = box('mp4a', u8(0, 0, 0, 0, 0, 0), u16(1), u32(0), u32(0), u16(audio.channels), u16(16), u16(0), u16(0), u32(audio.sampleRate * 65536), esds);
  }
  const vBytes = video.samples.reduce((a, s) => a + s.data.length, 0);
  const aBytes = audio ? audio.samples.reduce((a, s) => a + s.data.length, 0) : 0;
  const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso2avc1mp41'));
  const build = (mdatStart) => {
    const v = trak({ id: 1, handler: 'vide', timescale: video.timescale, samples: video.samples, sampleEntry: avc1, width: video.width, height: video.height, offsets: mdatStart, movieTs });
    const a = audio ? trak({ id: 2, handler: 'soun', timescale: audio.timescale, samples: audio.samples, sampleEntry: mp4a, offsets: mdatStart + vBytes, movieTs }) : null;
    const dur = Math.max(v.trackDur, a ? a.trackDur : 0);
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(dur), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(audio ? 3 : 2));
    return box('moov', mvhd, v.box, ...(a ? [a.box] : []));
  };
  const mdatSize = 16 + vBytes + aBytes;
  const moov = build(ftyp.length + build(0).length + 16);
  const mdatHeader = cat(u32(1), enc.encode('mdat'), u64(mdatSize));
  return new Blob([ftyp, moov, mdatHeader, ...video.samples.map((s) => s.data), ...(audio ? audio.samples.map((s) => s.data) : [])], { type: 'video/mp4' });
}

// H.264 High profile at the lowest level that fits the frame size and rate: 4K at 60fps needs level 5.2,
// 1080p 4.2. [level_idc, max frame size in macroblocks, max macroblocks per second]
const LEVELS = [[0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
async function pickCodec(width, height, fps, bitrate) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const codecs = LEVELS.filter(([, fs, rate]) => mbs <= fs && mbs * fps <= rate).map(([l]) => `avc1.6400${l.toString(16)}`);
  for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
    for (const codec of codecs) {
      // quality, not realtime: offline renders can let the encoder take its time and spend bits on detail
      const cfg = { codec, width, height, bitrate, bitrateMode: 'variable', framerate: fps, latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
      } catch (e) { /* try the next */ }
    }
  }
  throw new Error(`This browser cannot encode ${width}×${height} H.264 at ${fps}fps (use Chrome)`);
}

// Yield to the browser without timers: background tabs throttle setTimeout/requestAnimationFrame to once a
// second (or a minute), which would stall a render if you switch tabs. MessageChannel tasks are not
// throttled, and neither are microtasks, so the export keeps pumping while hidden.
const channel = new MessageChannel();
const waiting = [];
channel.port1.onmessage = () => waiting.shift()?.();
const yieldTask = () => new Promise((r) => { waiting.push(r); channel.port2.postMessage(0); });

// If the tab is hidden while a yield is pending, resolve it straight away too. The channel messages are
// already unthrottled, so this only covers browsers that defer even those tasks on visibility changes.
const onVisibility = () => { if (document.hidden) while (waiting.length) waiting.shift()?.(); };

/**
 * Render `seconds` of the current scene to an MP4 Blob.
 * step(dt, t): advance the world one frame (env + scene update). render(): draw the frame to the canvas.
 * script: [{ at: seconds, run() }] events fired on time (scene buttons, time and weather changes).
 * audio: the Ambience (sound is rendered offline in sync), or null for a silent clip.
 *
 * Audio and video share one clock: before every frame the audio clock is pinned to the frame time, so the
 * play()/setLoop() calls the scene makes inside update() land exactly on the frame that triggered them.
 * If no audio encoder is available (or the audio render fails), the clip is written without a sound track
 * instead of failing the whole export.
 */
export async function renderClip({ canvas, step, render, audio = null, seconds = 15, fps = 60, bitrate = 18e6, script = [], onProgress }) {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser has no WebCodecs (use Chrome)');
  const width = canvas.width, height = canvas.height;
  const cfg = await pickCodec(width, height, fps, bitrate);
  const timescale = 90000;
  const frameTicks = Math.round(timescale / fps);
  const vSamples = [];
  let avcC = null;
  let failure = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      vSamples.push({ data, pts: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => { failure = e; },
  });
  venc.configure(cfg);

  // Copy each rendered frame through a 2D canvas: a VideoFrame made straight from a WebGL canvas can return
  // the last frame shown on screen instead of the one just drawn (frames are never presented during export).
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const ctx2d = copy.getContext('2d', { alpha: false });
  // A null audio here means a deliberately silent clip; offlineAudio tracks whether *this* render built an
  // offline graph that must be torn down again.
  const offlineAudio = audio ? audio.beginOfflineForExport(seconds + 0.25) : null;
  const events = [...script].sort((a, b) => a.at - b.at);
  const frames = Math.round(seconds * fps);
  const dt = 1 / fps;
  let ei = 0;
  document.addEventListener('visibilitychange', onVisibility);
  try {
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure;
      const t = i * dt;
      // Pin the audio clock to the frame time *before* anything runs this frame: script events and the
      // scene update both schedule at now() === t, so one-shot sounds sit exactly on their visual event
      // and loop-bed gain ramps advance on the same timeline as the frames (no hardware clock involved).
      if (offlineAudio) audio._clock = t;
      while (ei < events.length && events[ei].at <= t + 1e-9) events[ei++].run();
      step(dt, t);
      render();
      ctx2d.drawImage(canvas, 0, 0);
      const frame = new VideoFrame(copy, { timestamp: Math.round(t * 1e6), duration: Math.round(dt * 1e6) });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6 && !failure) await yieldTask();
      if (i % 15 === 0) {
        onProgress?.(i / frames * (offlineAudio ? 0.85 : 1));
        await yieldTask();
      }
    }
    await venc.flush();
  } catch (e) {
    // The video path failed: drop the offline graph and restore the live audio graph before propagating.
    // abortOffline is a no-op unless an offline graph is actually active.
    audio?.abortOffline?.();
    throw e;
  } finally {
    venc.close();
    document.removeEventListener('visibilitychange', onVisibility);
  }
  if (failure) {
    audio?.abortOffline?.();
    throw failure;
  }
  // decode order is output order; presentation times give composition offsets if the encoder reorders
  const samples = vSamples.map((s, i) => {
    const dts = i * frameTicks;
    const pts = Math.round((s.pts / 1e6) * timescale);
    return { data: s.data, dur: frameTicks, key: s.key, cto: pts - dts };
  });

  // Sound is best-effort: no AudioEncoder, an unsupported config or a failed offline render leaves the
  // video intact as a silent MP4 rather than losing the whole export.
  let audioTrack = null;
  if (offlineAudio) {
    onProgress?.(0.88);
    try {
      const buffer = await audio.endOffline();
      audioTrack = await encodeAac(buffer, seconds);
    } catch (e) {
      console.warn('Audio export unavailable, writing a silent clip:', e?.message || e);
      audioTrack = null;
      // endOffline restores on failure; this is a harmless no-op if the live graph is already back.
      audio.restoreLive?.();
    }
  }
  onProgress?.(1);
  return muxMp4({ width, height, timescale, samples, avcC }, audioTrack);
}

// Even out loudness between clips: aim for a steady average level, never let peaks clip.
function normalize(buffer, seconds, targetRms = 0.075) {
  const len = Math.min(buffer.length, Math.round(seconds * buffer.sampleRate));
  const chans = [...Array(buffer.numberOfChannels)].map((_, c) => buffer.getChannelData(c));
  let sum = 0, peak = 0;
  for (const d of chans) for (let i = 0; i < len; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
  const rms = Math.sqrt(sum / (len * chans.length));
  if (rms < 1e-5) return;
  const gain = Math.min(4, targetRms / rms, 0.95 / Math.max(peak, 1e-5));
  for (const d of chans) for (let i = 0; i < len; i++) d[i] *= gain;
}

async function encodeAac(buffer, seconds) {
  normalize(buffer, seconds);
  const sampleRate = buffer.sampleRate, channels = 2;
  const cfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 192000 };
  // No AudioEncoder at all, or this browser cannot do AAC: the caller muxes a silent video.
  if (typeof AudioEncoder === 'undefined') return null;
  let supported = false;
  try {
    supported = (await AudioEncoder.isConfigSupported(cfg)).supported;
  } catch (e) { /* fall through to the silent path */ }
  if (!supported) return null;
  const chunks = [];
  let asc = null;
  let failure = null;
  const aenc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !asc) asc = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, dur: 1024 });
    },
    error: (e) => { failure = e; },
  });
  try {
    aenc.configure(cfg);
    const len = Math.min(buffer.length, Math.round(seconds * sampleRate));
    const l = buffer.getChannelData(0), r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    for (let i = 0; i < len; i += 1024) {
      const n = Math.min(1024, len - i);
      const planar = new Float32Array(n * 2);
      planar.set(l.subarray(i, i + n), 0);
      planar.set(r.subarray(i, i + n), n);
      aenc.encode(new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((i / sampleRate) * 1e6), data: planar }));
    }
    await aenc.flush();
    if (failure || !chunks.length) {
      console.warn('AAC encoding produced no audio, writing a silent clip:', failure?.message || 'no chunks');
      return null;
    }
  } catch (e) {
    console.warn('AAC encoding failed, writing a silent clip:', e?.message || e);
    return null;
  } finally {
    try { aenc.close(); } catch (e) { /* already closed */ }
  }
  // AAC LC, 48 kHz, stereo, if the encoder did not hand over its AudioSpecificConfig
  if (!asc) {
    const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sampleRate);
    const v = (2 << 11) | (Math.max(0, idx) << 7) | (channels << 3);
    asc = new Uint8Array([(v >> 8) & 255, v & 255]);
  }
  return { timescale: sampleRate, samples: chunks, asc, channels, sampleRate };
}

/** Write tracks whose sample entries are already encoded (raw stsd/tkhd/hdlr/vmhd|smhd/dinf boxes). */
export function muxRaw(tracks) {
  const movieTs = 1000;
  const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso2avc1mp41'));
  const sizes = tracks.map((t) => t.samples.reduce((a, s) => a + s.data.length, 0));
  const build = (mdatStart) => {
    let offset = mdatStart, dur = 0;
    const traks = tracks.map((t, i) => {
      const mediaDur = t.samples.reduce((a, s) => a + s.dur, 0);
      const trackDur = Math.round((mediaDur * movieTs) / t.timescale);
      dur = Math.max(dur, trackDur);
      const tk = t.tkhd.slice();
      const tdv = new DataView(tk.buffer);
      tk[9] = 0; tk[10] = 0; tk[11] = 3;
      if (tk[8] === 0) tdv.setUint32(28, trackDur); else tdv.setBigUint64(36, BigInt(trackDur));
      const stts = runLength(t.samples.map((s) => s.dur));
      const parts = [t.stsd, full('stts', 0, 0, u32(stts.length), ...stts.map(([n, d]) => cat(u32(n), u32(d))))];
      if (t.samples.some((s) => s.cto)) {
        const ctts = runLength(t.samples.map((s) => s.cto || 0));
        parts.push(full('ctts', 1, 0, u32(ctts.length), ...ctts.map(([n, o]) => cat(u32(n), i32(o)))));
      }
      if (t.handler === 'vide' && !t.samples.every((s) => s.key)) {
        const sync = t.samples.map((s, k) => (s.key ? k + 1 : 0)).filter(Boolean);
        parts.push(full('stss', 0, 0, u32(sync.length), ...sync.map((k) => u32(k))));
      }
      parts.push(full('stsc', 0, 0, u32(1), u32(1), u32(t.samples.length), u32(1)));
      parts.push(full('stsz', 0, 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.data.length))));
      parts.push(full('co64', 0, 0, u32(1), u64(offset)));
      offset += sizes[i];
      const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(mediaDur), u16(0x55c4), u16(0));
      return box('trak', tk, box('mdia', mdhd, t.hdlr, box('minf', t.mh, t.dinf, box('stbl', ...parts))));
    });
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(dur), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(Math.max(...tracks.map((t) => t.id)) + 1));
    return box('moov', mvhd, ...traks);
  };
  const total = sizes.reduce((a, b) => a + b, 0);
  const moov = build(ftyp.length + build(0).length + 16);
  return new Blob([ftyp, moov, cat(u32(1), enc.encode('mdat'), u64(16 + total)), ...tracks.flatMap((t) => t.samples.map((s) => s.data))], { type: 'video/mp4' });
}
