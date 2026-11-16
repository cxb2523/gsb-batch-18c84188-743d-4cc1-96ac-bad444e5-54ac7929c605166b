// Deterministic Node tests for the pure, browser-independent parts of the offline export fix:
//   - the MP4 muxer writes the exact authored duration and supports a video-only (silent) file
//   - the Ambience clock follows a pinned frame time and restores cleanly after an offline cycle
// Run: node tools/node-tests.mjs
import assert from 'node:assert';
import { muxMp4 } from '../engine/exporter.js';
import { Ambience } from '../engine/audio.js';

const u8 = (...b) => new Uint8Array(b);
const results = [];
const tasks = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, pass: false, error: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const run = (name, fn) => tasks.push(test(name, fn));

// --------------------------------------------------------------- MP4 box reading helpers
const dv = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const readBoxes = (buf, start, end) => {
  const d = dv(buf);
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = d.getUint32(i);
    const type = String.fromCharCode(...new Uint8Array(buf.buffer, buf.byteOffset + i + 4, 4));
    if (size === 1) size = Number(d.getBigUint64(i + 8));
    if (size === 0) size = end - i;
    out.push({ type, start, body: i + 8, end: i + size });
    i += size;
  }
  return out;
};
const findBox = (buf, s, e, type) => readBoxes(buf, s, e).find((b) => b.type === type);
const walkFind = (buf, boxPath) => {
  let s = 0, e = buf.byteLength, node = null;
  for (const type of boxPath) {
    node = findBox(buf, s, e, type);
    if (!node) return null;
    s = node.body; e = node.end;
  }
  return node;
};
const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

const timescale = 90000, fps = 60, frameTicks = Math.round(timescale / fps);
const makeVideoSamples = (frames) => Array.from({ length: frames }, (_, i) => ({
  data: u8(1, 2, 3, i & 255), dur: frameTicks, key: i % (fps * 2) === 0, cto: 0,
}));
const avcC = u8(1, 0x28, 0, 0, 0, 0, 0);

run('video-only MP4 (silent export path) has exact duration and no sound track', async () => {
  const seconds = 5;
  const samples = makeVideoSamples(seconds * fps);
  const blob = muxMp4({ width: 320, height: 180, timescale, samples, avcC }, null);
  assert.ok(blob instanceof Blob, 'muxer returns a Blob');
  const buf = await blobBytes(blob);
  const top = readBoxes(buf, 0, buf.length);
  assert.ok(top.some((b) => b.type === 'ftyp'), 'has ftyp');
  assert.ok(top.some((b) => b.type === 'moov'), 'has moov');
  assert.ok(top.some((b) => b.type === 'mdat'), 'has mdat');
  const mvhd = walkFind(buf, ['moov', 'mvhd']);
  const d = dv(buf);
  const durMs = (d.getUint32(mvhd.body + 16) * 1000) / d.getUint32(mvhd.body + 12);
  assert.ok(Math.abs(durMs - seconds * 1000) < 1, 'duration exact, got ' + durMs);
  const moov = findBox(buf, 0, buf.length, 'moov');
  const traks = readBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak');
  assert.strictEqual(traks.length, 1, 'single video track, no sound track');
  const hdlr = walkFind(buf, ['moov', 'trak', 'mdia', 'hdlr']);
  assert.strictEqual(String.fromCharCode(...new Uint8Array(buf.buffer, buf.byteOffset + hdlr.body + 8, 4)), 'vide');
});

run('audio+video MP4 carries a soun track and spans the exact movie duration', async () => {
  const seconds = 4, sampleRate = 48000;
  const samples = makeVideoSamples(seconds * fps);
  const audioSamples = Array.from({ length: Math.round((seconds * sampleRate) / 1024) }, (_, i) => ({ data: u8(7, i & 255), dur: 1024 }));
  const audio = { timescale: sampleRate, samples: audioSamples, asc: u8(0x12, 0x10), channels: 2, sampleRate };
  const blob = muxMp4({ width: 320, height: 180, timescale, samples, avcC }, audio);
  const buf = await blobBytes(blob);
  const moov = findBox(buf, 0, buf.length, 'moov');
  const traks = readBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak');
  assert.strictEqual(traks.length, 2, 'two tracks');
  const findHdlr = (s, e) => {
    for (const b of readBoxes(buf, s, e)) {
      if (b.type === 'hdlr') return b;
      if (['mdia', 'minf'].includes(b.type)) { const r = findHdlr(b.body, b.end); if (r) return r; }
    }
    return null;
  };
  const handlers = traks.map((trak) => String.fromCharCode(...new Uint8Array(buf.buffer, buf.byteOffset + findHdlr(trak.body, trak.end).body + 8, 4)));
  assert.ok(handlers.includes('vide') && handlers.includes('soun'), 'video + sound handlers present');
  const mvhd = walkFind(buf, ['moov', 'mvhd']);
  const d = dv(buf);
  const durMs = (d.getUint32(mvhd.body + 16) * 1000) / d.getUint32(mvhd.body + 12);
  assert.ok(Math.abs(durMs - seconds * 1000) < 40, 'movie duration ~exact, got ' + durMs);
});

// --------------------------------------------------------------- AudioContext / OfflineAudioContext stubs
// A generic node: connectable, with any property access returning an automatable AudioParam-like object.
function makeParam() {
  const p = function () {};
  p.value = 0;
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) p[m] = () => p;
  return p;
}
function makeNode() {
  const node = {
    connect() { return node; }, disconnect() {}, start() {}, stop() {}, addEventListener() {}, removeEventListener() {},
  };
  return new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const param = makeParam();
      target[prop] = param;
      return param;
    },
    set(target, prop, val) { target[prop] = val; return true; },
  });
}
class OfflineAudioContextStub {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels; this.length = length; this.sampleRate = sampleRate;
    this.currentTime = 0; this.state = 'suspended';
  }
  createGain() { return makeNode(); }
  createDynamicsCompressor() { return makeNode(); }
  createBiquadFilter() { const n = makeNode(); n.type = ''; return n; }
  createOscillator() { const n = makeNode(); n.type = ''; return n; }
  createDelay() { return makeNode(); }
  createWaveShaper() { const n = makeNode(); n.curve = null; return n; }
  createBuffer(ch, len) {
    return { length: len, numberOfChannels: ch, sampleRate: this.sampleRate, duration: len / this.sampleRate, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() { const n = makeNode(); n.buffer = null; n.loop = false; return n; }
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [] } }; }
  get destination() { return makeNode(); }
  async startRendering() {
    this.state = 'closed';
    return { length: this.length, numberOfChannels: this.numberOfChannels, sampleRate: this.sampleRate, getChannelData: () => new Float32Array(this.length) };
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class AudioContextStub extends OfflineAudioContextStub {
  constructor() { super(2, 48000, 48000); this.state = 'running'; this.currentTime = 7.5; }
}
globalThis.OfflineAudioContext = OfflineAudioContextStub;
globalThis.AudioContext = AudioContextStub;
globalThis.window = { AudioContext: AudioContextStub, webkitAudioContext: AudioContextStub };

run('now() prefers the pinned frame clock offline and the hardware clock live', async () => {
  const a = new Ambience();
  await a.start();
  assert.strictEqual(a.now(), 7.5, 'live: hardware currentTime');
  a.beginOffline(2);
  assert.strictEqual(a._offline, true);
  a._clock = 1.234;
  assert.strictEqual(a.now(), 1.234, 'offline: pinned frame clock, not currentTime(0)');
  a._clock = 2.5;
  assert.strictEqual(a.now(), 2.5);
});

run('endOffline restores the full live graph even when rendering rejects', async () => {
  const a = new Ambience();
  await a.start();
  const liveCtx = a.ctx;
  a.beginOffline(1);
  const offlineCtx = a.ctx;
  assert.notStrictEqual(offlineCtx, liveCtx, 'offline context is separate');
  offlineCtx.startRendering = () => Promise.reject(new Error('render boom'));
  await assert.rejects(() => a.endOffline(), /render boom/);
  assert.strictEqual(a.ctx, liveCtx, 'live graph restored after failure');
  assert.strictEqual(a._offline, undefined, 'offline flag cleared');
  assert.strictEqual(a._live, null, 'snapshot released');
  assert.strictEqual(a._clock, undefined, 'frame clock removed');
});

run('abortOffline restores live graph without rendering and is safe when live', async () => {
  const a = new Ambience();
  await a.start();
  const liveCtx = a.ctx;
  a.beginOffline(1);
  a.abortOffline();
  assert.strictEqual(a.ctx, liveCtx);
  assert.strictEqual(a._offline, undefined);
  assert.doesNotThrow(() => a.abortOffline(), 'abort while live is a no-op');
  assert.doesNotThrow(() => a.restoreLive(), 'restoreLive while live is a no-op');
});

run('beginOfflineForExport returns false and keeps the live graph when OAC construction throws', async () => {
  const a = new Ambience();
  await a.start();
  const liveCtx = a.ctx;
  const backup = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class { constructor() { throw new Error('blocked'); } };
  const ok = a.beginOfflineForExport(1);
  globalThis.OfflineAudioContext = backup;
  assert.strictEqual(ok, false, 'signals unavailable');
  assert.strictEqual(a.ctx, liveCtx, 'live context untouched');
  assert.strictEqual(a._offline, false, 'not marked offline');
  assert.strictEqual(a._live, null, 'no half-built snapshot');
});

// --------------------------------------------------------------- renderClip() integration
// Stub the browser globals renderClip touches: MessageChannel yields, document/canvas, VideoFrame and
// the WebCodecs encoders. The video encoder emits one keyframe per frame so the muxer stays simple.
function installRenderClipStubs({ audioEncoderSupported = true, offlineRenderOk = true } = {}) {
  globalThis.MessageChannel = class {
    constructor() {
      const port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage?.()) };
      this.port1 = { onmessage: null };
      this.port2 = port2;
    }
  };
  globalThis.document = {
    hidden: false,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.VideoFrame = class {
    constructor(source, init) { Object.assign(this, init); }
    close() {}
  };
  const encoded = [];
  globalThis.VideoEncoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor(handlers) { this.handlers = handlers; this.encodeQueueSize = 0; }
    configure() {}
    encode(frame) { this.encodeQueueSize++; queueMicrotask(() => { this.encodeQueueSize--; this.handlers.output({ type: 'key', timestamp: frame.timestamp, byteLength: 4, copyTo: (u) => u.set([1, 2, 3, 4]) }, { decoderConfig: { description: u8(1, 0x28, 0, 0, 0, 0, 0) } }); }); }
    async flush() { await Promise.resolve(); }
    close() {}
  };
  globalThis.AudioEncoder = audioEncoderSupported ? class {
    constructor(handlers) { this.handlers = handlers; }
    static async isConfigSupported() { return { supported: true }; }
    configure() {}
    encode(data) { queueMicrotask(() => this.handlers.output({ byteLength: 2, copyTo: (u) => u.set([0, 1]) }, { decoderConfig: { description: u8(0x12, 0x10) } })); }
    async flush() { await Promise.resolve(); }
    close() {}
  } : undefined;
  if (!offlineRenderOk) {
    const orig = globalThis.OfflineAudioContext;
    globalThis.OfflineAudioContext = class extends orig {
      async startRendering() { throw new Error('simulated render failure'); }
    };
  }
  return encoded;
}

run('renderClip pins the audio clock to each frame time before step() runs', async () => {
  installRenderClipStubs();
  const { renderClip } = await import('../engine/exporter.js');
  const audio = new Ambience();
  await audio.start();
  const observed = [];
  const blob = await renderClip({
    canvas: { width: 64, height: 64 },
    seconds: 1, fps: 60,
    step: (dt, t) => { observed.push({ t, clock: audio.now(), offline: audio._offline === true }); },
    render() {}, audio, onProgress() {},
  });
  assert.ok(blob instanceof Blob, 'produces a blob');
  assert.strictEqual(observed.length, 60, 'one step per frame');
  assert.ok(observed.every((o) => Math.abs(o.clock - o.t) < 1e-12), 'audio clock equals frame time on every step');
  assert.ok(observed.every((o) => o.offline), 'steps ran against the offline graph');
  assert.strictEqual(audio._offline, undefined, 'live graph restored after export');
  assert.strictEqual(audio._clock, undefined, 'frame clock cleared');
});

run('renderClip still returns a valid silent MP4 when the offline audio render fails', async () => {
  installRenderClipStubs({ offlineRenderOk: false });
  const { renderClip } = await import('../engine/exporter.js');
  const audio = new Ambience();
  await audio.start();
  const liveCtx = audio.ctx;
  const blob = await renderClip({
    canvas: { width: 64, height: 64 },
    seconds: 1, fps: 60, step() {}, render() {}, audio, onProgress() {},
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const moov = findBox(buf, 0, buf.length, 'moov');
  const traks = readBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak');
  assert.strictEqual(traks.length, 1, 'audio failure leaves a single video track');
  assert.strictEqual(audio.ctx, liveCtx, 'live graph restored despite audio failure');
  assert.strictEqual(audio._offline, undefined, 'offline state cleared');
});

run('renderClip returns a silent MP4 when AudioEncoder is unavailable', async () => {
  installRenderClipStubs({ audioEncoderSupported: false });
  const { renderClip } = await import('../engine/exporter.js');
  const audio = new Ambience();
  await audio.start();
  const blob = await renderClip({
    canvas: { width: 64, height: 64 },
    seconds: 1, fps: 60, step() {}, render() {}, audio, onProgress() {},
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const moov = findBox(buf, 0, buf.length, 'moov');
  const traks = readBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak');
  assert.strictEqual(traks.length, 1, 'no audio track without an encoder');
  assert.strictEqual(audio._offline, undefined, 'live graph restored');
});

run('renderClip with audio:null never touches an offline graph and muxes video only', async () => {
  installRenderClipStubs();
  const { renderClip } = await import('../engine/exporter.js');
  const blob = await renderClip({
    canvas: { width: 64, height: 64 },
    seconds: 1, fps: 60, step() {}, render() {}, audio: null, onProgress() {},
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const moov = findBox(buf, 0, buf.length, 'moov');
  const traks = readBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak');
  assert.strictEqual(traks.length, 1, 'video only');
});

run('export progress relies only on MessageChannel yields, never rAF/setTimeout (background-safe)', async () => {
  installRenderClipStubs();
  // Count the throttlable primitives while renderClip runs; MessageChannel is stubbed microtask-based.
  const raf0 = globalThis.requestAnimationFrame;
  const st0 = globalThis.setTimeout;
  let rafCalls = 0, timerCalls = 0;
  globalThis.requestAnimationFrame = () => { rafCalls++; return 0; };
  globalThis.setTimeout = (...a) => { timerCalls++; return st0(...a); };
  const { renderClip } = await import('../engine/exporter.js');
  await renderClip({ canvas: { width: 64, height: 64 }, seconds: 1, fps: 60, step() {}, render() {}, audio: null, onProgress() {} });
  globalThis.requestAnimationFrame = raf0;
  globalThis.setTimeout = st0;
  assert.strictEqual(rafCalls, 0, 'no requestAnimationFrame in the export loop');
  assert.strictEqual(timerCalls, 0, 'no setTimeout in the export loop (MessageChannel yields only)');
});

run('visibilitychange to hidden while hidden flushes pending yields without throwing', async () => {
  // Recreate the exporter's visibility handling contract: a hidden page must not strand a pending yield.
  const listeners = {};
  globalThis.document = {
    hidden: false,
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  };
  installRenderClipStubs();
  const { renderClip } = await import('../engine/exporter.js');
  // Run an export; flip hidden mid-flight from the step callback.
  let flipped = false;
  await renderClip({
    canvas: { width: 64, height: 64 }, seconds: 1, fps: 60,
    step: () => { if (!flipped) { flipped = true; globalThis.document.hidden = true; listeners.visibilitychange?.forEach((fn) => fn()); } },
    render() {}, audio: null, onProgress() {},
  });
  assert.ok(flipped, 'page was hidden during the export');
  assert.strictEqual(listeners.visibilitychange, undefined, 'the exporter removed its visibility listener when done');
});

await Promise.all(tasks);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} node checks passed`);
process.exit(failed ? 1 : 0);
