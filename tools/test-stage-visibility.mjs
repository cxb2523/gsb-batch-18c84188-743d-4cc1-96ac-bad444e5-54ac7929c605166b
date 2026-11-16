// Visibility handling for the stage, runnable under plain Node: node tools/test-stage-visibility.mjs
//
// The real stages paint with canvas/WebGL, which Node has none of, so the tests drive the
// DOM-free parts of the contract:
//   1. missedLoops(): the pure re-alignment math (transport cycles that elapsed while hidden,
//      including the device-suspended-audio case where the phase freezes but wall time runs on).
//   2. startVisibleFrame(): the frame loop freezes while hidden (no frame, no getFrame()) and the
//      first frame after returning is marked resumed — driven by a fake performance.now/RAF clock
//      and synthetic visibilitychange events, exactly as the task's acceptance check describes.
//
// The canvas-backed resync itself (resyncShow: bounded dt, cue/camera snap, nod re-alignment) is
// thin glue over these two tested units; exercise it end-to-end in a browser via
// tools/stage-lab.html (switch tabs away and back, or throttle and dispatch visibilitychange).

import assert from 'node:assert/strict';

// ---- minimal DOM/clock stubs, installed before importing the stage module ----
const listeners = new Map();
let hidden = false;
let nowMs = 1000;
const rafQueue = [];

globalThis.document = {
  get hidden() { return hidden; },
  addEventListener(type, cb) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(cb);
  },
  removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
};
globalThis.performance = { now: () => nowMs };
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.devicePixelRatio = 1;

const { missedLoops, startVisibleFrame } = await import('../js/stage.js');

const setHidden = (value) => {
  hidden = value;
  for (const cb of listeners.get('visibilitychange') ?? []) cb({ type: 'visibilitychange' });
};
// Pump the RAF queue once per fake frame, stamping each callback with the current fake clock.
const pumpFrames = (n = 1) => {
  for (let i = 0; i < n; i++) {
    const jobs = rafQueue.splice(0);
    for (const cb of jobs) cb(nowMs);
  }
};

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
};

// ---------------- missedLoops: re-alignment math ----------------
// missedLoops counts loop-boundary crossings during the hide (what the running show's `loops`
// counter increments on every wrap), at 120 BPM = 0.5 s per beat, loop = 128 beats.
const LOOP = 128; // engine BEATS
await test('no wrap while hidden: phases move forward within one cycle', () => {
  // Hidden 4 s = 8 beats; phase 10 -> 18, no boundary crossed.
  const n = missedLoops({ hiddenMs: 4000, bpm: 120, phaseHide: 10, phaseNow: 18, loopBeats: LOOP });
  assert.equal(n, 0);
});

await test('one full transport cycle elapsed while hidden', () => {
  // Hidden 70 s = 140 beats = 1 cycle (128) + 12. phase 10 -> 22; one boundary crossed.
  const n = missedLoops({ hiddenMs: 70000, bpm: 120, phaseHide: 10, phaseNow: 22, loopBeats: LOOP });
  assert.equal(n, 1);
});

await test('three cycles elapsed while hidden, landing on a lower in-loop phase', () => {
  // Hidden 200 s = 400 beats = 3*128 + 16. phase 100 -> 116 (no in-loop phase wrap).
  const n = missedLoops({ hiddenMs: 200000, bpm: 120, phaseHide: 100, phaseNow: 116, loopBeats: LOOP });
  assert.equal(n, 3);
});

await test('in-loop phase wrapped backwards; wall time still gives the cycle count', () => {
  // 140 beats hidden: phase 120 -> (120+140)%128 = 4; floor((120+140)/128) = 2 crossings.
  const n = missedLoops({ hiddenMs: 70000, bpm: 120, phaseHide: 120, phaseNow: 4, loopBeats: LOOP });
  assert.equal(n, 2);
});

await test('device suspended audio: phase frozen, no phantom wrap despite the mod jump', () => {
  // Nothing advanced audibly: phase stays at 4 even after 90 s hidden, and 180 wall beats are not a
  // whole number of loops, so the suspended clock reads zero crossings.
  const n = missedLoops({ hiddenMs: 90000, bpm: 120, phaseHide: 4, phaseNow: 4, loopBeats: LOOP });
  assert.equal(n, 0);
});

await test('exactly one full cycle returns to the same phase and still counts', () => {
  // 64 s at 120 BPM = 128 beats; phase 125 -> 125 (the cycle wrapped cleanly onto itself).
  const n = missedLoops({ hiddenMs: 64000, bpm: 120, phaseHide: 125, phaseNow: 125, loopBeats: LOOP });
  assert.equal(n, 1);
});

await test('two clean cycles with a tiny phase dither are both counted', () => {
  const n = missedLoops({ hiddenMs: 128000, bpm: 120, phaseHide: 30, phaseNow: 30.1, loopBeats: LOOP });
  assert.equal(n, 2);
});

await test('crossing the loop boundary inside one short hide is counted as a crossing', () => {
  // 120 BPM; hide at beat 125, return at beat 3 next cycle: 6 beats = 3 s, one boundary crossed.
  const n = missedLoops({ hiddenMs: 3000, bpm: 120, phaseHide: 125, phaseNow: 3, loopBeats: LOOP });
  assert.equal(n, 1);
});

await test('wall-time jitter of a few tenths of a beat does not change the count', () => {
  assert.equal(missedLoops({ hiddenMs: 70150, bpm: 120, phaseHide: 10, phaseNow: 22.1, loopBeats: LOOP }), 1);
  assert.equal(missedLoops({ hiddenMs: 69800, bpm: 120, phaseHide: 10, phaseNow: 22, loopBeats: LOOP }), 1);
});

await test('a short freeze (less than a loop) reports zero, not a phantom crossing', () => {
  const n = missedLoops({ hiddenMs: 800, bpm: 120, phaseHide: 50, phaseNow: 50, loopBeats: LOOP });
  assert.equal(n, 0);
});

// ---------------- startVisibleFrame: freeze while hidden ----------------
// Every loop is cancelled at the end of its test so RAF callbacks and listeners never leak across
// tests; hidden is always restored to visible afterwards.
await test('visible frames run and are not marked resumed after the first', () => {
  const calls = [];
  const cancel = startVisibleFrame((now, resumed) => calls.push({ now, resumed }));
  nowMs = 2000; pumpFrames(1);
  nowMs = 2016; pumpFrames(1);
  nowMs = 2032; pumpFrames(1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].resumed, false, 'the very first frame is not a resume');
  assert.equal(calls[1].resumed, false);
  assert.equal(calls[2].resumed, false);
  cancel();
});

await test('hiding freezes the loop: no frame callbacks and therefore no getFrame()', () => {
  let frameCount = 0;
  let getFrameCount = 0;
  const getFrame = () => { getFrameCount++; return { paused: false }; };
  const cancel = startVisibleFrame(() => { getFrame(); frameCount++; });
  pumpFrames(2);
  assert.equal(frameCount, 2);
  assert.equal(getFrameCount, 2);

  setHidden(true);
  // Fake RAF keeps firing (as an injected test clock would); the loop must ignore every tick.
  nowMs += 1000; pumpFrames(1);
  nowMs += 1000; pumpFrames(1);
  nowMs += 5000; pumpFrames(1);
  assert.equal(frameCount, 2, 'no frames while hidden');
  assert.equal(getFrameCount, 2, 'getFrame is not called while hidden');

  setHidden(false);
  nowMs += 10000; // the hidden duration lands inside one timestamp gap
  pumpFrames(1);
  assert.equal(frameCount, 3, 'frames resume');
  assert.equal(getFrameCount, 3);
  cancel();
});

await test('the first frame after returning is marked resumed; later frames are not', () => {
  const marks = [];
  const cancel = startVisibleFrame((_now, resumed) => marks.push(resumed));
  pumpFrames(1);
  setHidden(true);
  nowMs += 8000; pumpFrames(1); // ignored
  setHidden(false);
  nowMs += 8000; pumpFrames(1); // resumed frame
  nowMs += 16; pumpFrames(1);   // ordinary frame
  assert.deepEqual(marks, [false, true, false]);
  cancel();
});

await test('cancel stops the loop for good', () => {
  let n = 0;
  const cancel = startVisibleFrame(() => { n++; });
  pumpFrames(1);
  cancel();
  pumpFrames(3);
  assert.equal(n, 1);
});

await test('hiding before the first frame means the first visible frame is a resume', () => {
  const marks = [];
  const cancel = startVisibleFrame((_now, resumed) => marks.push(resumed));
  setHidden(true);
  pumpFrames(1); // frozen
  setHidden(false);
  pumpFrames(1);
  assert.deepEqual(marks, [true]);
  cancel();
});

await test('the resume marker is held until a frame actually draws', () => {
  // First two visible frames bail (simulating a canvas not laid out yet) and return false, so the
  // marker must survive and the frame that finally draws still knows it is the resumed one.
  let drawsLeft = 2;
  const marks = [];
  const cancel = startVisibleFrame((_now, resumed) => {
    if (drawsLeft-- > 0) return false; // stage bails before drawing and holds the marker
    marks.push(resumed);
  });
  setHidden(true);
  nowMs += 5000;
  setHidden(false);
  nowMs += 5000;
  pumpFrames(1); // bails, marker held
  nowMs += 16; pumpFrames(1);   // bails, marker held
  nowMs += 16; pumpFrames(1);   // draws: must be resumed
  nowMs += 16; pumpFrames(1);   // ordinary frame
  assert.deepEqual(marks, [true, false]);
  cancel();
});

assert.equal(hidden, false, 'visibility restored by the end of the suite');
console.log(`\n${passed} stage-visibility tests passed`);
