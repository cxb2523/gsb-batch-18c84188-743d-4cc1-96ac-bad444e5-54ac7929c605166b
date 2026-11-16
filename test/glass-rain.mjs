// Drives the glass rain with a fixed time step and checks what the acceptance
// asks for: beads that sit at low speed, streams that grow as the airflow
// builds, drying that follows the airspeed after the rain stops, and a pause
// that freezes everything without a reset or a catch-up on resume.
//   node test/glass-rain.mjs
import * as THREE from '../vendor/three.module.js';
import { GlassRain } from '../js/glass-rain.js';

const DT = 1 / 60;
const sky = new THREE.Color(0.5, 0.55, 0.6), glint = new THREE.Color(1, 1, 1);
const rows = [];
const check = (name, pass, note = '') => rows.push({ name, ok: !!pass, note });
const make = () => new GlassRain(new THREE.BufferGeometry());
const cover = (g) => { const d = g.uniforms.uDens.value; return d.x + d.y + d.z + d.w; };
const streak = (g) => Math.max(...g.uniforms.uTail.value.map((t) => Math.max(t.x, t.y, t.z)));
const run = (g, sec, rain, ias, each) => { const n = Math.round(sec / DT); for (let i = 0; i < n; i++) { g.update(DT, rain, ias, sky, glint); if (each && each(i) === false) return; } };
const log = [];
const note = (tag, g) => `${tag}: cover ${cover(g).toFixed(3)}, streak ${streak(g).toFixed(2)}, wet ${g.wet.toFixed(3)}, push ${g.push.toFixed(2)}`;

// ---- low speed: rain wets the glass, the water sits in beads
{
  const g = make();
  let mono = true, prev = 0;
  run(g, 25, 0.8, 2, () => { if (g.wet < prev - 1e-12) mono = false; prev = g.wet; });
  log.push(note('low speed, raining', g));
  check('Low speed: wetness rises monotonically toward the rain rate', mono && g.wet > 0.75 && g.wet <= 0.8 + 1e-9, `wet ${g.wet.toFixed(3)}`);
  const d = g.uniforms.uDens.value;
  check('Low speed: beads dominate, no streaks dragged out yet', d.x > d.y + d.z + d.w && streak(g) < 0.5,
    `beads ${d.x.toFixed(2)} vs streams ${(d.y + d.z + d.w).toFixed(2)}, tail ${streak(g).toFixed(2)}`);

  // ---- accelerate: the airflow takes a grip over a second or two, never in one frame
  let maxStep = 0, prevCover = cover(g), beadsMono = true, prevBeads = g.uniforms.uDens.value.x, tPush = null;
  run(g, 20, 0.8, 55, (i) => {
    maxStep = Math.max(maxStep, Math.abs(cover(g) - prevCover)); prevCover = cover(g);
    const b = g.uniforms.uDens.value.x; if (b > prevBeads + 1e-9) beadsMono = false; prevBeads = b;
    if (tPush === null && g.push > 0.95) tPush = i * DT;
  });
  log.push(note('fast, raining     ', g));
  check('Acceleration: coverage moves in small steps, no jump', maxStep < 0.02, `max ${maxStep.toFixed(4)}/frame`);
  check('Acceleration: the airflow grips within a couple of seconds', tPush !== null && tPush < 6, tPush === null ? 'never' : `${tPush.toFixed(1)} s`);
  check('Acceleration: beads thin out monotonically as the streams take over', beadsMono && g.uniforms.uDens.value.x < 0.1, `beads ${g.uniforms.uDens.value.x.toFixed(3)}`);
  check('Acceleration: streaks run to full length on windscreen and side windows', streak(g) > 0.99 && g.uniforms.uTail.value[1].z > 0.9,
    `windscreen ${g.uniforms.uTail.value[0].z.toFixed(2)}, side ${g.uniforms.uTail.value[1].z.toFixed(2)}`);

  // ---- out of the rain: the glass dries gradually, faster in the fast airflow
  const wet0 = g.wet;
  let dryMono = true, prevWet = wet0;
  run(g, 2, 0, 55, () => { if (g.wet > prevWet + 1e-12) dryMono = false; prevWet = g.wet; });
  const wet2 = g.wet;
  check('Leaving rain: drying is gradual, not an instant clear', dryMono && wet2 < wet0 && wet2 > 0.6 * wet0, `${wet0.toFixed(3)} -> ${wet2.toFixed(3)} in 2 s`);
  run(g, 150, 0, 55);
  log.push(note('dried out         ', g));
  check('Leaving rain: the glass does dry in the end, and hides itself', g.wet < 0.002 && !g.mesh.visible, `wet ${g.wet.toFixed(4)}`);
  const still = make(); still.setState({ wet: wet0, push: 1 }); run(still, 10, 0, 0);
  const fast = make(); fast.setState({ wet: wet0, push: 1 }); run(fast, 10, 0, 55);
  check('Drying follows the airspeed', fast.wet < still.wet * 0.8, `10 s: ${fast.wet.toFixed(3)} fast vs ${still.wet.toFixed(3)} still`);
}

// ---- pause: everything freezes; resume picks up exactly where it froze
{
  const snap = (g) => JSON.stringify({
    wet: g.wet, push: g.push,
    dens: g.uniforms.uDens.value.toArray(),
    off: g.uniforms.uOff.value.map((v) => v.toArray()),
    tail: g.uniforms.uTail.value.map((v) => v.toArray()),
  });
  const g = make(), ctrl = make();
  run(g, 10, 1, 30); run(ctrl, 10, 1, 30);
  // the steady per-frame step, measured before the pause
  const w0 = g.wet;
  g.update(DT, 1, 30, sky, glint); ctrl.update(DT, 1, 30, sky, glint);
  const dWet = g.wet - w0, before = snap(g), wetBefore = g.wet;
  for (let i = 0; i < 300; i++) g.update(0, 1, 30, sky, glint);          // paused frames pass dt 0
  check('Pause: five seconds of dt 0 changes nothing', snap(g) === before);
  g.update(DT, 1, 30, sky, glint); ctrl.update(DT, 1, 30, sky, glint);
  check('Resume: the first frame steps by the usual amount, no catch-up', g.wet - wetBefore <= dWet + 1e-12 && g.wet - wetBefore > dWet * 0.9,
    `step ${(g.wet - wetBefore).toExponential(2)} vs ${dWet.toExponential(2)} before the pause`);
  run(g, 5, 1, 30); run(ctrl, 5, 1, 30);
  check('Resume: the trajectory is the one it would have had unpaused', snap(g) === snap(ctrl));
  log.push(note('after pause/resume', g));
}

// ---- rebuild (switching aircraft): wetness carries over, the streaks do not
{
  const g = make();
  run(g, 20, 0.9, 40);
  const fresh = make();
  check('A new aircraft starts dry, no residue from the last one', fresh.wet === 0 && cover(fresh) === 0 && !fresh.mesh.visible);
  check('A new aircraft has a fresh streak pattern', fresh.uniforms.uOff.value.every((v) => v.x === 0 && v.y === 0));
  fresh.setState(g.getState());
  fresh.update(DT, 0.9, 40, sky, glint);
  check('Rebuilt glass continues from the same wetness, no full-screen jump',
    Math.abs(fresh.uniforms.uWet.value - g.wet) < 0.01 && fresh.mesh.visible,
    `wet ${fresh.uniforms.uWet.value.toFixed(3)} vs ${g.wet.toFixed(3)}`);
}

// ---- no rain, dry glass: nothing new appears
{
  const g = make();
  run(g, 5, 0, 50);
  check('No rain on a dry glass: no new beads, stays hidden', g.wet === 0 && cover(g) === 0 && !g.mesh.visible);
}

// ---- a wild clock never gets to move the water
{
  const g = make();
  run(g, 5, 1, 20);
  const wet = g.wet, push = g.push;
  g.update(NaN, 1, 20, sky, glint); g.update(-0.5, 1, 20, sky, glint);
  check('NaN or negative dt leaves the state untouched', g.wet === wet && g.push === push);
  g.update(10, 1, 20, sky, glint);
  check('A huge dt is taken in a small bite, not as one leap', g.wet - wet <= 0.35 * 0.1 * (1 - wet) + 1e-12, `dwet ${(g.wet - wet).toFixed(4)}`);
}

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log(`${r.ok ? '  ok  ' : ' MISS '}${pad(r.name, 66)}${r.note}`); }
console.log(`\n${log.join('\n')}`);
console.log(`\n${rows.length - bad}/${rows.length}\n`);
if (bad) process.exitCode = 1;
