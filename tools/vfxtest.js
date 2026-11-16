// vfxtest.js: drive G.vfx.move against a locally built battle-scene object and check that every transient visual
// field returns to its baseline when the animation ends -- normally, through an early return, and when the
// generator is closed/aborted mid-animation -- plus the flash/shake merge rule for repeated triggers.
//
//   node tools/vfxtest.js            # all checks, one line per failure
//   node tools/vfxtest.js --verbose  # per-move frame counts
//
// Exits non-zero on failure so it can be wired into CI.
const H = require('./headless.js');
const G = H.loadGame({ search: '?map=Route1&x=10&y=20' }).G;
G.boot();

const verbose = process.argv.includes('--verbose');
let failures = 0, checks = 0;
function check(ok, msg) { checks++; if (!ok) { failures++; console.log('FAIL ' + msg); } }

// A battle scene with only the fields vfx touches, plus the scene's per-frame decay (mirrors BattleScene.draw).
function makeScene() {
  const sc = {
    offs: { p: { x: 0, y: 0 }, e: { x: 0, y: 0 } },
    tint: { p: null, e: null },
    vis: { p: 1, e: 1 },
    scale: { p: 1, e: 1 },
    clip: { p: 1, e: 1 },
    fx: [], flash: 0, flashColor: 0xffffffff, shake: 0, screenFx: null,
    frames: 0,
    // what BattleScene.draw does with flash/shake: spend a little each frame, never below 0
    decay() {
      if (this.shake > 0) { this.shake -= 0.5; if (this.shake < 0) this.shake = 0; }
      if (this.flash > 0) { this.flash -= 0.12; if (this.flash < 0) this.flash = 0; }
      this.frames++;
    },
  };
  sc.fx.push({ name: 'independent', age: 0, draw() { return true; } }); // a long-lived unrelated effect
  return sc;
}
// teleport deliberately leaves the sprite hidden: the caller then plays the scene's own flee(), which relies on it.
const VIS_EXEMPT = new Set(['TELEPORT']);
const BASELINE = (sc, id) => sc.offs.p.x === 0 && sc.offs.p.y === 0 && sc.offs.e.x === 0 && sc.offs.e.y === 0 &&
  sc.tint.p === null && sc.tint.e === null && sc.scale.p === 1 && sc.scale.e === 1 && sc.clip.p === 1 && sc.clip.e === 1 &&
  (VIS_EXEMPT.has(id) || (sc.vis.p === 1 && sc.vis.e === 1)) &&
  sc.flash === 0 && sc.shake === 0 && sc.screenFx === null;
const snapshot = sc => JSON.stringify({ p: sc.offs.p, e: sc.offs.e, tp: sc.tint.p, te: sc.tint.e, sc: sc.scale, cl: sc.clip, vis: sc.vis, flash: sc.flash, shake: sc.shake, sfx: typeof sc.screenFx });

// Run one animation to completion (or `cap` frames). `abort` closes the generator with .return() instead.
function run(sc, id, k, { cap = 6000, abort = 0 } = {}) {
  const gen = G.vfx.move(sc, id, k, 0);
  let n = 0, done = false;
  const stop = abort > 0 ? abort : cap;
  while (n < stop) {
    sc.decay();
    const r = gen.next();
    n++;
    if (r.done) { done = true; break; }
  }
  if (!done) gen.return(); // same as a driver abandoning the animation mid-flight
  return { frames: n, done };
}

const MOVES = Object.keys(G.vfx.MOVES).sort();
const sideOf = () => (Math.random() < 0.5 ? 'p' : 'e');

// --- 1. normal completion: every recipe must leave the transient state at baseline ---
let longest = 0;
for (const mv of MOVES) {
  const sc = makeScene();
  const k = sideOf();
  const r = run(sc, mv, k);
  longest = Math.max(longest, r.frames);
  check(r.done, `[normal] ${mv}: animation did not finish within cap (${r.frames} frames)`);
  if (r.done) check(BASELINE(sc, mv), `[normal] ${mv} (${k}) left residue: ${snapshot(sc)}`);
  check(sc.fx.some(f => f.name === 'independent'), `[normal] ${mv}: unrelated fx entry was dropped`);
  if (verbose) console.log(`  normal ${mv.padEnd(18)} ${r.frames} frames`);
}

// --- 2. early end: abort the generator part-way through, at several points ---
// ABORT_AT is a fraction of the move's own measured length, so each move is cut at a point where it has had time
// to set flash/shake/offs/tint; 0.05..0.95 covers both legs of a lunge and every other write.
for (const mv of MOVES) {
  const probe = makeScene();
  const total = run(probe, mv, 'p').frames;
  for (const frac of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
    const sc = makeScene();
    const r = run(sc, mv, 'p', { abort: Math.max(1, Math.round(total * frac)) });
    check(!r.done, `[abort ${frac}] ${mv}: unexpectedly finished before the cut`);
    check(BASELINE(sc, mv), `[abort ${frac}] ${mv} left residue: ${snapshot(sc)}`);
    check(sc.fx.some(f => f.name === 'independent'), `[abort ${frac}] ${mv}: unrelated fx entry was dropped`);
  }
}

// --- 3. early *return* inside the recipe (hit > 0 short-circuits most recipes through impact) ---
for (const mv of ['TACKLE', 'THUNDERBOLT', 'EXPLOSION', 'EMBER', 'SURF', 'PSYCHIC_M']) {
  const sc = makeScene();
  const gen = G.vfx.move(sc, mv, 'p', 1);
  let n = 0, r;
  do { sc.decay(); r = gen.next(); n++; } while (!r.done && n < 400);
  check(r.done && BASELINE(sc, mv), `[early return] ${mv} left residue: ${snapshot(sc)}`);
}

// --- 4. flash/shake merge: repeated triggers take the max, never sum, and are capped ---
{
  const sc = makeScene();
  const gen = G.vfx.move(sc, 'THUNDER', 'p', 0); // darken + flash 1 + lightning + shake 6
  let maxFlash = 0, maxShake = 0, n = 0, r;
  do { sc.decay(); r = gen.next(); n++; maxFlash = Math.max(maxFlash, sc.flash); maxShake = Math.max(maxShake, sc.shake); } while (!r.done && n < 400);
  check(maxFlash <= 1 + 1e-9, `merge: flash exceeded 1 (${maxFlash})`);
  check(maxShake <= 10 + 1e-9, `merge: shake exceeded 10 (${maxShake})`);
  check(maxFlash >= 1 - 1e-9, `merge: flash never reached its 1.0 trigger (${maxFlash})`);
  check(maxShake >= 6 - 1e-9, `merge: shake never reached its 6 trigger (${maxShake})`);

  // Two shakes in one move never exceed the larger one -- compare against a single trigger of the same value.
  const a = makeScene(); run(a, 'EARTHQUAKE', 'p'); // shake 9 x4
  const peaks = [];
  for (const mv of ['EARTHQUAKE', 'EXPLOSION', 'SURF', 'HYDRO_PUMP', 'DRAGON_RAGE', 'ROCK_SLIDE', 'SOLARBEAM', 'THUNDER']) {
    const s = makeScene(); const g = G.vfx.move(s, mv, 'p', 0);
    let p = 0, i = 0, rr;
    do { s.decay(); rr = g.next(); i++; p = Math.max(p, s.shake); } while (!rr.done && i < 400);
    peaks.push([mv, p]);
  }
  for (const [mv, p] of peaks) check(p <= 10, `merge: ${mv} shake peaked at ${p} > 10`);
  // no peak is the sum of two triggers: EXPLOSION sets 10 once, EARTHQUAKE 9; sum would be 19
  check(peaks.every(([, p]) => p < 19), 'merge: shake looks additive across triggers');
}

// --- 5. repeatability: the same move twice in a row from a clean scene each time ---
{
  const sc = makeScene();
  for (let i = 0; i < 3; i++) {
    const r = run(sc, 'THUNDERBOLT', 'p');
    check(r.done && BASELINE(sc, "THUNDERBOLT"), `repeat: THUNDERBOLT #${i + 1} left residue: ${snapshot(sc)}`);
  }
}

// --- 6. an overlapping independent effect on another target is not wiped when the move ends ---
{
  // A move aimed at 'p' only owns p's offsets/tint; e's must survive untouched (an independent effect could be
  // animating the other side), and an independent screen effect that was already running must be restored, not
  // nulled, so the move doesn't cut it off.
  const sc = makeScene();
  sc.offs.e = { x: 3, y: -2 };
  sc.tint.e = [0x11223344, 0.5];
  const otherFx = () => {};
  sc.screenFx = otherFx;
  const r = run(sc, 'SWORDS_DANCE', 'p');
  check(r.done, 'overlap: SWORDS_DANCE did not finish');
  check(sc.offs.e.x === 3 && sc.offs.e.y === -2, `overlap: the other side's offsets were clobbered (${JSON.stringify(sc.offs.e)})`);
  check(sc.tint.e === sc.tint.e && sc.tint.e && sc.tint.e[1] === 0.5, 'overlap: another effect\'s tint was clobbered');
  check(sc.screenFx === otherFx, 'overlap: an independent screen effect was cleared by an unrelated move');
  // and a move that does not touch flash must leave an in-flight flash exactly where the scene's own decay left it
  const a = makeScene(); a.flash = 0.7; a.flashColor = 0x11223344;
  const b = makeScene(); b.flash = 0.7; b.flashColor = 0x11223344;
  const ra = run(a, 'TACKLE', 'p');
  let n = 0; while (n < ra.frames) { b.decay(); n++; }
  check(a.flash === b.flash && a.flashColor === b.flashColor, `overlap: TACKLE altered an in-flight flash (${a.flash} vs ${b.flash})`);
}

// --- 7. two animations advanced alternately in the same frame each clean up only what they own ---
{
  const sc = makeScene();
  const g1 = G.vfx.move(sc, 'THUNDER', 'p', 0); // flash 1 + shake 6 on p
  const g2 = G.vfx.move(sc, 'SURF', 'e', 0);    // shake 3, no flash
  let n = 0, d1 = false, d2 = false;
  while ((!d1 || !d2) && n < 400) {
    sc.decay();
    if (!d1) d1 = g1.next().done;
    if (!d2) d2 = g2.next().done;
    n++;
  }
  check(d1 && d2, 'concurrent: animations did not both finish');
  check(BASELINE(sc), `concurrent: residue after interleaved animations: ${snapshot(sc)}`);
  check(sc.fx.some(f => f.name === 'independent'), 'concurrent: unrelated fx entry was dropped');
}

// --- 8. a mid-move abort of one animation does not disturb the other, still running ---
{
  const sc = makeScene();
  const g2 = G.vfx.move(sc, 'THUNDERBOLT', 'e', 0);
  for (let i = 0; i < 12; i++) { sc.decay(); g2.next(); } // let it start flashing
  const g1 = G.vfx.move(sc, 'EMBER', 'p', 0);
  for (let i = 0; i < 8; i++) { sc.decay(); g1.next(); }
  g1.return(); // abort EMBER
  check(sc.fx.some(f => f.name === 'independent'), 'concurrent abort: unrelated fx entry was dropped');
  let done = false;
  for (let i = 0; i < 400 && !done; i++) { sc.decay(); done = g2.next().done; }
  check(done && BASELINE(sc), `concurrent abort: THUNDERBOLT left residue: ${snapshot(sc)}`);
}

// --- 9. resetVisuals is the safety net for a dropped generator (a battle torn down mid-animation) ---
{
  const sc = makeScene();
  const before = snapshot(sc); // clean scene; the pre-animation baseline
  const g = G.vfx.move(sc, 'THUNDER', 'p', 0);
  for (let i = 0; i < 20; i++) sc.decay(), g.next(); // leave it mid-flight (flash is up), never close it
  check(snapshot(sc) !== before, 'resetVisuals: the animation never changed any field (test is not exercising it)');
  G.vfx.resetVisuals(sc);
  check(snapshot(sc) === before, `resetVisuals: residue after a dropped animation: ${snapshot(sc)}`);
  check(sc.fx.some(f => f.name === 'independent'), 'resetVisuals: unrelated fx entry was dropped');
}

console.log(`vfxtest: ${checks} checks, ${failures} failure(s); moves=${MOVES.length}, longest=${longest} frames`);
process.exit(failures ? 1 : 0);
