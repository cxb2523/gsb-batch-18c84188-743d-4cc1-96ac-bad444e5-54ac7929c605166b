// test/sky.test.mjs: the sky follows the graphics level, the weather and the map colours (js/sky.js, js/quality.js).
//
// Runs in Node with three.js from node_modules (the same r169 the page loads from the CDN), so the real scene
// objects are used and no browser is needed. The real Save and Quality modules are used too: browser storage and
// fetch are the only things stubbed, so Auto's own sample() decides the downgrade instead of a hand-made event.
//
// Run: node --test test/sky.test.mjs      (or, once dependencies are installed: npm test)

import test from 'node:test';
import assert from 'node:assert/strict';

// three.js is the one package these tests need, and only for tests: the game itself loads it from a CDN at runtime.
let THREE;
try { THREE = await import('three'); } catch {
  throw new Error('The tests need three.js: run "npm install" once in the project folder, then "npm test".');
}

// Save.load() reads localStorage and fetch; neither exists in Node. Set both before quality.js is imported.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.fetch ??= async () => { throw new Error('offline test'); };

const { Sky } = await import('../js/sky.js');
const { Quality } = await import('../js/quality.js');
const { Save } = await import('../js/save.js');

const camera = new THREE.PerspectiveCamera(60, 1, 1, 12000);
camera.position.set(120, 540, -300);
// a sky in a scene of its own, built the way main.js builds it
const around = () => {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
  sun.position.set(600, 1200, 400);
  scene.add(sun);
  return { scene, sun, sky: new Sky(scene, sun) };
};

// put the Graphics setting back to a known state between tests (the shared Quality object keeps its listeners)
function setLevel(setting, auto = null) {
  Save.data.quality = setting;
  Save.data.qualityAuto = auto;
  Quality.resetSampling();
  Quality.emit();
  return Quality.level;
}

// the dome's colour at the horizon (its lowest vertex): the map's sky colour, which is also the fog colour
function horizonColor(sky) {
  const pos = sky.domeGeo.attributes.position, col = sky.domeGeo.attributes.color;
  let low = 0;
  for (let i = 1; i < pos.count; i++) if (pos.getY(i) < pos.getY(low)) low = i;
  return Array.from(col.array.slice(low * 3, low * 3 + 3));
}
const hexRgb = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // three.js works in linear-sRGB
const cloudColor = sky => (sky.cloudMat.color.getHexString ? sky.cloudMat.color.getHexString() : String(sky.cloudMat.color));

// count the instance-matrix writes and needsUpdate marks of the cloud mesh, to prove a hidden sky writes nothing
function countCloudWrites(sky) {
  const counts = { matrices: 0, marks: 0 };
  const setMatrixAt = sky.clouds.setMatrixAt.bind(sky.clouds);
  sky.clouds.setMatrixAt = (i, m) => { counts.matrices++; return setMatrixAt(i, m); };
  let flag = sky.clouds.instanceMatrix.needsUpdate;
  Object.defineProperty(sky.clouds.instanceMatrix, 'needsUpdate', {
    configurable: true,
    get: () => flag,
    set: v => { counts.marks++; flag = v; },
  });
  return counts;
}

test('a new sky starts at the current graphics level (not always visible)', () => {
  setLevel('high');
  const a = around();
  assert.equal(a.sky.on, true, 'High draws the sky');
  a.sky.dispose();

  setLevel('low');
  const b = around();
  assert.equal(b.sky.on, false, 'Low starts with the sky off');
  assert.equal(b.sky.dome.visible, false);
  assert.equal(b.sky.clouds.visible, false);
  assert.equal(b.sky.sun.visible, false);
  b.sky.dispose();
});

test('the sky follows the graphics setting by itself: Auto downgrade, manual cycle, Auto again', () => {
  setLevel('auto', null);
  const { sky } = around();
  sky.setLook(0x8fc6e8, 'clear');
  assert.equal(sky.on, true, 'Auto starts at High');

  // Auto measures a slow device and drops to Low (the real sampling path, not a stubbed emit)
  for (let i = 0; i < 4000; i++) Quality.sample(40);           // 25 fps for a whole window
  assert.equal(Quality.level, 'low');
  assert.equal(sky.on, false, 'Auto dropping to Low hides the sky at once');
  assert.equal(sky.clouds.visible, false);
  assert.equal(sky.sun.visible, false);

  // the hangar button: Auto -> High -> Low -> Auto (Auto retries High)
  Quality.cycle();                                             // High
  assert.equal(sky.on, true, 'Auto -> High shows the sky again');
  Quality.cycle();                                             // Low
  assert.equal(sky.on, false, 'High -> Low hides it');
  Quality.cycle();                                             // Auto (High again)
  assert.equal(Quality.level, 'high');
  assert.equal(sky.on, true, 'choosing Auto again retries High and shows the sky');

  sky.dispose();
});

test('fog hides the clouds and every weather but clear hides the sun, at both graphics levels', () => {
  setLevel('high');
  const { sky } = around();

  sky.setLook(0x9fb4c6, 'fog');
  assert.equal(sky.clouds.visible, false, 'fog: no clouds');
  assert.equal(sky.sun.visible, false, 'fog: no sun');

  setLevel('low');
  assert.equal(sky.clouds.visible, false, 'fog at Low: still no clouds');
  setLevel('high');
  assert.equal(sky.clouds.visible, false, 'back at High in fog: clouds stay away');

  sky.setLook(0x7d8a96, 'rain');
  assert.equal(sky.dome.visible, true);
  assert.equal(sky.clouds.visible, true, 'rain: clouds are drawn');
  assert.equal(sky.sun.visible, false, 'rain: no sun');

  setLevel('low');
  setLevel('high');
  assert.equal(sky.sun.visible, false, 'switching levels does not bring the sun back in rain');

  sky.setLook(0x8fc6e8, 'clear');
  assert.equal(sky.clouds.visible, true, 'clear: clouds');
  assert.equal(sky.sun.visible, true, 'clear: the sun');
  sky.dispose();
});

test('a recolour made while Low is kept, so the next High shows the new map and weather (not the old colours)', () => {
  setLevel('high');
  const { sky } = around();
  sky.setLook(0x8fc6e8, 'clear');
  const clearHorizon = horizonColor(sky), clearCloud = cloudColor(sky);

  setLevel('low');
  // a different map and weather while the sky is hidden (rain darkens the clouds; snow would not)
  sky.setLook(0x2f7a3c, 'rain');
  const rainHorizon = horizonColor(sky);
  // the dome's vertex colours are written in linear-sRGB (three.js), so compare against three.js's own conversion
  const want = hexRgb(0x2f7a3c);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(rainHorizon[i] - want[i]) < 0.01,
    `the horizon takes the new map colour even at Low (channel ${i}: ${rainHorizon[i]} vs ${want[i]})`);
  assert.notDeepEqual(rainHorizon, clearHorizon, 'the new map colour replaced the old one');
  assert.notEqual(cloudColor(sky), clearCloud, 'the new weather colour replaced the old one');

  setLevel('high');
  assert.equal(sky.dome.visible, true);
  assert.equal(sky.clouds.visible, true, 'rain is not fog, so the clouds come back');
  assert.equal(sky.sun.visible, false, 'rain is not clear, so no sun');
  assert.deepEqual(horizonColor(sky), rainHorizon, 'switching back to High keeps the new map colour');
  assert.notEqual(cloudColor(sky), clearCloud, 'and the new weather colour');
  sky.dispose();
});

test('cloud drift and per-frame instance matrices stop while the clouds are hidden and pick up where they stopped', () => {
  setLevel('high');
  const { sky } = around();
  sky.setLook(0x8fc6e8, 'clear');
  const counts = countCloudWrites(sky);

  sky.update(0.5, camera);
  assert.equal(counts.matrices, sky.puffs.length, 'visible: one matrix per puff');
  assert.equal(counts.marks, 1, 'visible: the matrix buffer is marked once');
  const before = sky.drift;
  assert.ok(before > 0);

  // Low: hidden for a few seconds
  setLevel('low');
  const m0 = counts.matrices, k0 = counts.marks;
  for (let i = 0; i < 120; i++) sky.update(0.1, camera);
  assert.equal(sky.drift, before, 'hidden at Low: drift does not advance');
  assert.equal(counts.matrices, m0, 'hidden at Low: no instance matrix writes');
  assert.equal(counts.marks, k0, 'hidden at Low: instanceMatrix is not even flagged');

  // back to High: the clouds carry on from the same drift, with no jump
  setLevel('high');
  sky.update(0.25, camera);
  assert.ok(Math.abs(sky.drift - (before + 0.25 * 8)) < 1e-9, 'resumes from the pause point, adding only the new time');
  assert.equal(counts.matrices - m0, sky.puffs.length, 'visible again: matrices are written again');

  // fog is the same story with the sky on: clouds hidden, so nothing drifts or gets written
  sky.setLook(0x9fb4c6, 'fog');
  const f0 = sky.drift, fm = counts.matrices, fk = counts.marks;
  for (let i = 0; i < 100; i++) sky.update(0.1, camera);
  assert.equal(sky.drift, f0, 'fog: drift does not advance');
  assert.equal(counts.matrices, fm, 'fog: no instance matrix writes');
  assert.equal(counts.marks, fk, 'fog: no needsUpdate marks');

  // clear again while High: resumes, still without a jump
  sky.setLook(0x8fc6e8, 'clear');
  sky.update(0.5, camera);
  assert.ok(Math.abs(sky.drift - (f0 + 0.5 * 8)) < 1e-9);

  sky.dispose();
});

test('a sky that is not drawn at all does nothing per frame', () => {
  setLevel('low');
  const { sky } = around();
  sky.setLook(0x8fc6e8, 'clear');
  const counts = countCloudWrites(sky);
  const dome = sky.dome.position.clone();
  for (let i = 0; i < 30; i++) sky.update(0.1, camera);
  assert.equal(counts.matrices, 0);
  assert.equal(counts.marks, 0);
  assert.ok(sky.dome.position.equals(dome), 'the dome is not moved around a camera it is not drawn for');
  sky.dispose();
});

test('dispose stops a thrown-away sky from following the graphics setting', () => {
  setLevel('high');
  const a = around(), b = around();
  a.sky.dispose();
  setLevel('low');
  assert.equal(a.sky.on, true, 'the disposed sky is left alone');
  assert.equal(b.sky.on, false, 'the live sky still follows');
  b.sky.dispose();
  setLevel('high');
});
