/**
 * Frame-rate independence verification: dust ballistics and the chase camera
 * under normal (60 fps) and stuttered (50 ms, the main-loop dt cap) frames.
 *
 *   npx tsx tools/probe-frametime.ts
 *
 * The presentation layer integrates against the frame dt, which main.ts caps
 * at 0.05 s. On a low-end device a frame can therefore be three 60 Hz steps
 * wide. This probe proves that, after the substepping fix:
 *
 *   - dust grains fly the same parabola on long frames as on short ones,
 *     never tunnel through a ridge, and never miss the landing check;
 *   - the chase camera never dips under the terrain, never teleports onto
 *     its target on a long frame, and is no shakier on short frames;
 *   - the race simulation itself (lap times, standings) is bit-identical
 *     between smooth and stuttered frame patterns, because it already runs
 *     on a fixed-step clock;
 *   - paused and attract/results behaviour is untouched.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector } from '../src/sim/race';
import { CarSim } from '../src/sim/car';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import { ChaseCam, CinematicCam } from '../src/render/cameras';

const f = (v: number, d = 3): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(44)} ${detail}`);
}

console.log('\n=== NOCTIS GP - frame-rate independence ===\n');

// ---- shared world ----------------------------------------------------------
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);

const STUTTER = 0.05; // the main-loop dt cap: what a 20 fps frame delivers
const NORMAL = 1 / 60;

const dustArrays = (dust: Dust): { pos: Float32Array; life: Float32Array } => {
  const g = dust.points.geometry;
  return {
    pos: g.attributes.position.array as Float32Array,
    life: g.attributes.aLife.array as Float32Array,
  };
};

// ---- dust: landing is detected on long frames (real terrain) ---------------
{
  const dust = new Dust(new THREE.Scene());
  const x = 100;
  const z = -50;
  const h0 = terrain.sampleHeight(x, z);
  dust.emit(x, h0 + 3, z, 0, 1.0, 0, 1, 5);
  const { pos, life } = dustArrays(dust);
  let buried = false;
  let landedAt = -1;
  for (let frame = 0; frame < 200; frame++) {
    dust.update(STUTTER, terrain);
    if (life[0] > 0 && pos[1] < terrain.sampleHeight(pos[0], pos[2]) - 1e-6) buried = true;
    if (life[0] <= 0 && landedAt < 0) landedAt = frame;
  }
  // Free fall from 3 m with 1 m/s upward at 1/6 g lands in ~1.9 s (~38 frames).
  check('dust: long-frame grain never ends a frame buried', !buried, `dt=${STUTTER}s over real terrain`);
  check('dust: long-frame landing is detected', landedAt > 25 && landedAt < 60, `landed after ${landedAt} stuttered frames`);
}

// ---- dust: no tunnelling through a ridge on long frames --------------------
{
  // A knife-edge ridge, 4 m tall with a 0.35 m sigma, centred at x=9.75. A
  // grain at y=0.5 moving at 30 m/s MUST hit it. A single 50 ms integration
  // step samples x at 9.0 and 10.5 - both just off the ridge - and sails
  // through; 60 Hz substeps sample x=9.5, dead on the slope.
  const ridge = {
    sampleHeight: (x: number): number => 4 * Math.exp(-((x - 9.75) ** 2) / (2 * 0.35 * 0.35)),
  } as unknown as Terrain;
  const dust = new Dust(new THREE.Scene());
  dust.emit(0, 0.5, 0, 30, 0, 0, 1, 5);
  const { pos, life } = dustArrays(dust);
  let frames = 0;
  while (life[0] > 0 && frames < 40) {
    dust.update(STUTTER, ridge);
    frames++;
  }
  check(
    'dust: grain cannot tunnel through a ridge',
    life[0] <= 0 && pos[0] < 10.4,
    life[0] <= 0 ? `stopped at x=${f(pos[0], 2)} (ridge centre 9.75)` : `sailed through to x=${f(pos[0], 2)}`,
  );
}

// ---- dust: short-frame behaviour is bit-identical to the old integrator ----
{
  const floor = { sampleHeight: (): number => -1000 } as unknown as Terrain;
  const dust = new Dust(new THREE.Scene());
  dust.emit(1, 2, 3, 4, 5, 6, 1, 5);
  // The pre-fix integrator, run by hand for comparison. The particle buffers
  // are Float32Array, so the reference must round through float32 the same
  // way the array stores do.
  const fr = Math.fround;
  let vy = 5;
  let px = 1;
  let py = 2;
  let pz = 3;
  for (let i = 0; i < 30; i++) {
    dust.update(NORMAL, floor);
    vy = fr(vy - 2.6 * NORMAL);
    px = fr(px + 4 * NORMAL);
    py = fr(py + vy * NORMAL);
    pz = fr(pz + 6 * NORMAL);
  }
  const { pos } = dustArrays(dust);
  const identical = pos[0] === px && pos[1] === py && pos[2] === pz;
  check('dust: 60 fps path is unchanged', identical, identical ? 'bit-identical to the old step' : `(${f(pos[0])}, ${f(pos[1])}, ${f(pos[2])}) vs (${f(px)}, ${f(py)}, ${f(pz)})`);
}

// ---- dust: a long frame flies the same parabola as five short ones ---------
{
  const floor = { sampleHeight: (): number => -1000 } as unknown as Terrain;
  const a = new Dust(new THREE.Scene());
  const b = new Dust(new THREE.Scene());
  a.emit(0, 10, 0, 12, 3, -7, 1, 60);
  b.emit(0, 10, 0, 12, 3, -7, 1, 60);
  for (let i = 0; i < 20; i++) {
    a.update(STUTTER, floor);
    for (let k = 0; k < 5; k++) b.update(0.01, floor);
  }
  const pa = dustArrays(a).pos;
  const pb = dustArrays(b).pos;
  const err = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
  check('dust: 50 ms frame matches 5x10 ms frames', err < 0.02, `trajectory disagreement ${f(err * 1000, 2)} mm after 1 s`);
}

// ---- chase camera over a steep bank ----------------------------------------
// Flat ground, then a 63-degree bank rising at 2 m per metre beyond x=20.
// The car climbs it at 30 m/s; the damped camera lags vertically more than
// horizontally, which is exactly the case that used to put it underground.
const bank = {
  sampleHeight: (x: number): number => (x > 20 ? 2 * (x - 20) : 0),
} as unknown as Terrain;

function makeCar(): CarSim {
  const car = new CarSim(null, { name: 'T', color: 0, isPlayer: true });
  car.yaw = Math.PI / 2; // forward = +x
  car.vel.set(30, 0, 0);
  car.grounded = true;
  car.pos.set(0, bank.sampleHeight(0) + 1, 0);
  return car;
}

function runChase(dt: number, frames: number): { minClearance: number; maxStep: number; minGap: number; maxGap: number; fovOk: boolean } {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000);
  const chase = new ChaseCam(cam);
  const car = makeCar();
  chase.snap(car, bank);
  let minClearance = Infinity;
  let maxStep = 0;
  let minGap = Infinity;
  let maxGap = 0;
  let fovOk = true;
  const prev = cam.position.clone();
  for (let i = 0; i < frames; i++) {
    car.pos.x += 30 * dt;
    car.pos.y = bank.sampleHeight(car.pos.x) + 1;
    chase.update(dt, car, bank);
    const clearance = cam.position.y - (bank.sampleHeight(cam.position.x) + 1.4);
    minClearance = Math.min(minClearance, clearance);
    maxStep = Math.max(maxStep, cam.position.distanceTo(prev));
    const gap = Math.hypot(cam.position.x - car.pos.x, cam.position.z - car.pos.z);
    minGap = Math.min(minGap, gap);
    maxGap = Math.max(maxGap, gap);
    if (!Number.isFinite(cam.fov) || cam.fov < 40 || cam.fov > 90) fovOk = false;
    prev.copy(cam.position);
  }
  return { minClearance, maxStep, minGap, maxGap, fovOk };
}

{
  const stutter = runChase(STUTTER, 200); // 10 s of 20 fps stutter up the bank
  check('camera: never under the terrain on long frames', stutter.minClearance >= -1e-6, `worst clearance ${f(stutter.minClearance, 3)} m`);
  check(
    'camera: no teleport on long frames',
    stutter.maxStep < 5 && stutter.minGap > 4 && stutter.maxGap < 20,
    `max move ${f(stutter.maxStep, 2)} m/frame, chase gap ${f(stutter.minGap, 1)}..${f(stutter.maxGap, 1)} m`,
  );
  check('camera: fov stays sane on long frames', stutter.fovOk, 'finite and within [40, 90]');

  const normal = runChase(NORMAL, 600);
  check('camera: never under the terrain at 60 fps', normal.minClearance >= -1e-6, `worst clearance ${f(normal.minClearance, 3)} m`);

  // Short frames must not be shakier: per-frame camera travel should scale
  // down with dt, not stay chunky.
  const quick = runChase(1 / 120, 1200);
  check(
    'camera: 120 fps is smoother, never shakier',
    quick.maxStep <= normal.maxStep * 0.75,
    `max move ${f(quick.maxStep, 3)} m vs ${f(normal.maxStep, 3)} m at 60 fps`,
  );
}

// ---- race logic is frame-rate independent ----------------------------------
{
  const runRace = (frameDts: number[]): number[] => {
    const d = new RaceDirector({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
      terrain,
      track,
      audio: new RaceAudio(),
      dust: new Dust(new THREE.Scene()),
      autopilot: true,
      menu: null,
    });
    d.startRace();
    // Power-ups are random and AI can pick one up and fire it within a single
    // frame, so clearing items between frames is not enough - disable AI item
    // use outright and compare physics only.
    d.items.setAiUsePolicy(() => false);
    while (d.state === 'countdown') d.update(NORMAL);
    for (const dt of frameDts) {
      for (const c of d.cars) c.item = null;
      d.update(dt);
    }
    return d.cars.map((c) => c.totalDist);
  };
  const smooth = runRace(new Array(1800).fill(NORMAL)); // 30 s at 60 fps
  const stuttered = runRace(new Array(600).fill(STUTTER)); // 30 s at 20 fps
  let identical = true;
  for (let i = 0; i < smooth.length; i++) if (smooth[i] !== stuttered[i]) identical = false;
  check(
    'race: 20 fps stutter does not change the simulation',
    identical,
    identical ? 'all 8 cars bit-identical after 30 s' : 'car progress diverged',
  );
}

// ---- paused and non-race states --------------------------------------------
{
  const d = new RaceDirector({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000),
    terrain,
    track,
    audio: new RaceAudio(),
    dust: new Dust(new THREE.Scene()),
    autopilot: true,
    menu: null,
  });
  d.startRace();
  while (d.state === 'countdown') d.update(NORMAL);
  for (let i = 0; i < 120; i++) d.update(NORMAL);
  d.pause();
  const before = d.cars.map((c) => c.pos.clone());
  for (let i = 0; i < 20; i++) d.update(STUTTER);
  const frozen = d.cars.every((c, i) => c.pos.equals(before[i]));
  check('paused: stuttered frames change nothing', frozen && d.state === 'paused', 'cars frozen while paused');

  // Attract/results run the cinematic camera; it must still frame a moving
  // pack without going non-finite on stuttered frames.
  d.quitToMenu();
  const cineCam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000);
  const cine = new CinematicCam(cineCam, track, terrain);
  let cineOk = true;
  for (let i = 0; i < 600; i++) {
    d.update(STUTTER);
    let lead = d.cars[0];
    for (const c of d.cars) if (c.totalDist > lead.totalDist) lead = c;
    cine.update(STUTTER, lead);
    if (!Number.isFinite(cineCam.position.x + cineCam.position.y + cineCam.position.z + cineCam.fov)) cineOk = false;
  }
  check('attract: cinematic camera survives stuttered frames', cineOk, '600 frames at 20 fps, all finite');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
