// Automated tests for the pause/visibility behaviour of the procedural audio
// engine (src/audio.js). Runs in plain Node with a mock Web Audio API:
//
//   node --test test/
//
// Covers:
//   1. Pause ducks loops to the same level as music (not a full mute) and
//      both return to their pre-pause level together on resume.
//   2. Loops created while paused stay under the same duck constraint and
//      do not pop in at full volume on resume.
//   3. Hide -> show re-applies each loop's latest parameters (bypassing the
//      unchanged-key no-op), so automation never sits on pre-hidden values.
//   4. The music scheduler still skips overdue steps after a long hidden
//      gap instead of bursting them out late.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Mock Web Audio API
// ---------------------------------------------------------------------------
class MockParam {
  constructor(v = 0) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); }
  setTargetAtTime(v, t, tc) { this.value = v; this.events.push(['target', v, t, tc]); }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];
    this.onended = null;
  }
  connect(dest) { this.connections.push(dest); return dest; }
  disconnect() { this.connections.length = 0; }
}

class MockSource extends MockNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.stopped = false;
    this.loop = false;
  }
  start(t, off) { this.started = true; this.startAt = t; this.offset = off; }
  stop(t) { this.stopped = true; this.stopAt = t; }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 8000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new MockNode(this, 'destination');
    this.resumeCalls = 0;
  }
  createGain() { const n = new MockNode(this, 'gain'); n.gain = new MockParam(1); return n; }
  createBiquadFilter() {
    const n = new MockNode(this, 'filter');
    n.type = 'lowpass';
    n.frequency = new MockParam(350);
    n.Q = new MockParam(1);
    n.gain = new MockParam(0);
    return n;
  }
  createWaveShaper() { const n = new MockNode(this, 'shaper'); n.curve = null; n.oversample = 'none'; return n; }
  createDynamicsCompressor() {
    const n = new MockNode(this, 'comp');
    n.threshold = new MockParam(-24); n.knee = new MockParam(30); n.ratio = new MockParam(12);
    n.attack = new MockParam(0.003); n.release = new MockParam(0.25);
    return n;
  }
  createConvolver() { const n = new MockNode(this, 'convolver'); n.buffer = null; return n; }
  createStereoPanner() { const n = new MockNode(this, 'panner'); n.pan = new MockParam(0); return n; }
  createChannelMerger() { return new MockNode(this, 'merger'); }
  createDelay() { const n = new MockNode(this, 'delay'); n.delayTime = new MockParam(0); return n; }
  createBuffer(ch, len, sr) {
    const chans = Array.from({ length: ch }, () => new Float32Array(len));
    return { duration: len / sr, getChannelData: (c) => chans[c] };
  }
  createBufferSource() {
    const n = new MockSource(this, 'bufferSource');
    n.buffer = null;
    n.playbackRate = new MockParam(1);
    return n;
  }
  createOscillator() {
    const n = new MockSource(this, 'oscillator');
    n.type = 'sine';
    n.frequency = new MockParam(440);
    n.detune = new MockParam(0);
    n.setPeriodicWave = () => {};
    return n;
  }
  resume() { this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

// ---------------------------------------------------------------------------
// Environment setup (must happen before importing src/audio.js)
// ---------------------------------------------------------------------------
const listeners = Object.create(null);
globalThis.document = {
  hidden: false,
  addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
};
function fireVisibility(hidden) {
  globalThis.document.hidden = hidden;
  for (const fn of listeners.visibilitychange || []) fn();
}

let moduleSeq = 0;
async function freshAudio() {
  const ctx = new MockAudioContext();
  globalThis.AudioContext = function () { return ctx; };
  const mod = await import(`../src/audio.js?test=${++moduleSeq}`);
  return { mod, ctx, internals: mod.__audioInternals };
}

function activeLoopArray(internals) {
  return [...internals.loops.active];
}

// ---------------------------------------------------------------------------
// 1. Pause ducks loops together with music; resume restores both together.
// ---------------------------------------------------------------------------
test('pause ducks loops to PAUSE_LEVEL (not mute), resume restores both buses', async () => {
  const { mod, internals } = await freshAudio();
  mod.AudioSys.init();
  const G = internals.graph;

  assert.equal(G.loopBus.gain.value, 1);
  assert.equal(G.mPause[0].gain.value, 1);
  assert.equal(G.mPause[1].gain.value, 1);

  mod.AudioSys.setPaused(true);
  assert.equal(internals.paused, true);
  assert.equal(G.loopBus.gain.value, internals.PAUSE_LEVEL, 'loops duck, not mute');
  assert.ok(G.loopBus.gain.value > 0, 'loops must not be fully muted');
  assert.equal(G.mPause[0].gain.value, internals.PAUSE_LEVEL);
  assert.equal(G.mPause[1].gain.value, internals.PAUSE_LEVEL);

  // Same time constant on both chains -> they move together.
  const loopEvt = G.loopBus.gain.events.filter((e) => e[0] === 'target').at(-1);
  const musicEvt = G.mPause[0].gain.events.filter((e) => e[0] === 'target').at(-1);
  assert.equal(loopEvt[3], musicEvt[3]);

  mod.AudioSys.setPaused(false);
  assert.equal(G.loopBus.gain.value, 1, 'loops restored to pre-pause level');
  assert.equal(G.mPause[0].gain.value, 1, 'music restored to pre-pause level');
  assert.equal(G.mPause[1].gain.value, 1);
});

// ---------------------------------------------------------------------------
// 2. A loop created while paused is ducked too and cannot pop in at full
//    volume on resume.
// ---------------------------------------------------------------------------
test('loop created while paused stays ducked until resume', async () => {
  const { mod, internals } = await freshAudio();
  mod.AudioSys.init();
  const G = internals.graph;

  mod.AudioSys.setPaused(true);
  assert.equal(G.loopBus.gain.value, internals.PAUSE_LEVEL);

  const handle = mod.AudioSys.loop('engine');
  const loops = activeLoopArray(internals);
  assert.equal(loops.length, 1, 'engine loop is live');
  assert.equal(G.loopBus.gain.value, internals.PAUSE_LEVEL, 'bus still ducked after loop creation');
  assert.ok(loops[0].out.connections.includes(G.loopBus), 'loop feeds the ducked bus');
  // The bus must never have been set back to full while paused.
  assert.ok(!G.loopBus.gain.events.some((e) => e[0] !== 'cancel' && e[1] === 1),
    'loop bus never returns to full level while paused');

  mod.AudioSys.setPaused(false);
  assert.equal(G.loopBus.gain.value, 1, 'bus restores only on resume');
  handle.stop(0.1);
});

// ---------------------------------------------------------------------------
// 3. Hide -> show re-applies the loop's latest parameters.
// ---------------------------------------------------------------------------
test('visibility restore refreshes loop parameters (key cache bypassed)', async () => {
  const { mod, internals } = await freshAudio();
  mod.AudioSys.init();

  const handle = mod.AudioSys.loop('engine', { speed: 1.5, boost: true });
  const lp = activeLoopArray(internals)[0];
  const s1 = lp.nodes.find((n) => n.kind === 'oscillator' && n.type === 'sawtooth');
  assert.ok(s1, 'engine drone oscillator exists');

  // Expected target for speed 1.5 + boost: k = 1.5 * 1.3 = 1.95 -> 44 + 26k.
  const expected = 44 + 26 * 1.5 * 1.3;
  assert.ok(Math.abs(s1.frequency.value - expected) < 1e-6, 'params applied on set()');

  // Simulate the tab hiding and any record of the scheduled automation being
  // lost/stale: no new set() calls happen while hidden (rAF is stopped).
  s1.frequency.events.length = 0;
  fireVisibility(true);
  assert.equal(s1.frequency.events.length, 0, 'no loop automation while hidden');

  fireVisibility(false);
  const targets = s1.frequency.events.filter((e) => e[0] === 'target');
  assert.ok(targets.length > 0, 'showing the tab re-applies loop parameters');
  assert.ok(Math.abs(targets.at(-1)[1] - expected) < 1e-6,
    're-applied value matches the latest state, not a stale one');

  handle.stop(0.1);
});

test('resume from pause also refreshes loop parameters', async () => {
  const { mod, internals } = await freshAudio();
  mod.AudioSys.init();

  mod.AudioSys.loop('engine', { speed: 2, brake: true });
  const lp = activeLoopArray(internals)[0];
  const s1 = lp.nodes.find((n) => n.kind === 'oscillator' && n.type === 'sawtooth');
  const expected = 44 + 26 * 2 * 0.72;

  mod.AudioSys.setPaused(true);
  s1.frequency.events.length = 0;
  mod.AudioSys.setPaused(false);
  const targets = s1.frequency.events.filter((e) => e[0] === 'target');
  assert.ok(targets.length > 0, 'resume re-applies loop parameters');
  assert.ok(Math.abs(targets.at(-1)[1] - expected) < 1e-6);
});

// ---------------------------------------------------------------------------
// 4. Music scheduler still skips overdue steps (no catch-up burst).
// ---------------------------------------------------------------------------
test('music scheduler skips overdue steps after a long hidden gap', async () => {
  const { mod, ctx, internals } = await freshAudio();
  mod.AudioSys.init();
  mod.AudioSys.playMusic('stage1', { fade: 0 });
  assert.ok(internals.current, 'song started');

  // Simulate a long background gap: the context clock jumps far ahead of the
  // scheduler's next step.
  ctx.currentTime += 30;
  internals.tick();

  const now = ctx.currentTime;
  const cur = internals.current;
  assert.ok(cur, 'song still playing');
  assert.ok(cur.next >= now, 'scheduler resynced to the grid instead of bursting');

  // Only the steps inside one lookahead window may have been voiced; a
  // catch-up burst would schedule ~30 s of music (hundreds of voices).
  const voices = internals.pools.music.list.length;
  assert.ok(voices < 40, `expected a handful of scheduled voices, got ${voices}`);
});
