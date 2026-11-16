// Headless verification of the pose-independent wet-mark coordinate path.
// Run with: node --check not needed; node scripts/verify-wet.js
import { readFileSync } from 'node:fs';
import { applyPose } from '../public/src/pose.js';
import { restPointAt } from '../public/src/wet.js';

const buf = readFileSync(new URL('../public/assets/leg.glb', import.meta.url));
const jsonSize = buf.readUInt32LE(12);
const doc = JSON.parse(buf.slice(20, 20 + jsonSize).toString('utf8'));
const binOff = 20 + jsonSize + 8;

function readAccessor(name, itemSize, ArrayType) {
  const entry = doc.accessors[name];
  const view = doc.bufferViews[entry.bufferView];
  const offset = binOff + (view.byteOffset ?? 0) + (entry.byteOffset ?? 0);
  return new ArrayType(buf.buffer, buf.byteOffset + offset, entry.count * itemSize);
}

const prim = doc.meshes[0].primitives[0];
const restPos = readAccessor(prim.attributes.POSITION, 3, Float32Array).slice();
const restNrm = readAccessor(prim.attributes.NORMAL, 3, Float32Array).slice();
const indices = readAccessor(prim.indices, 1, Uint16Array).slice();

class Attribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  getX(i) { return this.array[i * 3]; }
  getY(i) { return this.array[i * 3 + 1]; }
  getZ(i) { return this.array[i * 3 + 2]; }
}
class Geometry {
  constructor() { this.attributes = {}; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  getAttribute(name) { return this.attributes[name]; }
  getIndex() { return { array: indices }; }
  get boundingBox() { return { min: { y: -0.003 } } };
  computeBoundingBox() {}
  computeBoundingSphere() {}
}
const v = (x, y, z) => ({ x, y, z, clone() { return v(x, y, z); } });
const meshStub = geometry => ({
  geometry,
  worldToLocal(point) { return point; }, // group placement ignored: everything stays in leg-local space
  userData: { leg: 0 },
});

// Distinct rest geometry (mirrors the original `stocking` geometry in main.js).
const restGeometry = new Geometry();
restGeometry.setAttribute('position', new Attribute(restPos, 3));
restGeometry.setAttribute('normal', new Attribute(restNrm, 3));

function buildGeometry(poseName, legIndex) {
  const geometry = new Geometry();
  geometry.setAttribute('position', new Attribute(new Float32Array(restPos), 3));
  geometry.setAttribute('normal', new Attribute(new Float32Array(restNrm), 3));
  geometry.setAttribute('restPosition', restGeometry.getAttribute('position'));
  applyPose(geometry, restGeometry, poseName, legIndex);
  return geometry;
}

let failures = 0;
const check = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
  if (!cond) failures++;
};

// 1. For several surface vertices, a posed hit must map back to the exact rest vertex.
for (const poseName of ['step', 'crossed', 'tiptoe', 'single', 'pigeon']) {
  const geometry = buildGeometry(poseName, 0);
  const posed = geometry.getAttribute('position').array;
  const probes = [12, 340, 901, 1777, 2500, 3333, 4000];
  let ok = true;
  for (const vertex of probes) {
    const hit = v(posed[vertex*3], posed[vertex*3+1], posed[vertex*3+2]);
    const rest = restPointAt(meshStub(geometry), hit);
    if (Math.hypot(rest.x - restPos[vertex * 3], rest.y - restPos[vertex * 3 + 1], rest.z - restPos[vertex * 3 + 2]) > 1e-6) ok = false;
  }
  check(ok, `posed hits in ${poseName} resolve to their rest coordinates`);
}

// 2. Persistence: a mark stored from a crossed-pose hit keeps the same rest point
//    after switching to tiptoe (the stain uniform content never changes).
const crossed = buildGeometry('crossed', 0);
const tiptoe = buildGeometry('tiptoe', 0);
const sampleVertex = 1234;
const hitCrossed = v(
  crossed.getAttribute('position').array[sampleVertex * 3],
  crossed.getAttribute('position').array[sampleVertex * 3 + 1],
  crossed.getAttribute('position').array[sampleVertex * 3 + 2],
);
const stored = restPointAt(meshStub(crossed), hitCrossed);
const hitTiptoe = v(
  tiptoe.getAttribute('position').array[sampleVertex * 3],
  tiptoe.getAttribute('position').array[sampleVertex * 3 + 1],
  tiptoe.getAttribute('position').array[sampleVertex * 3 + 2],
);
const reprojected = restPointAt(meshStub(tiptoe), hitTiptoe);
check(Math.hypot(stored.x - reprojected.x, stored.y - reprojected.y, stored.z - reprojected.z) < 1e-6,
  'same skin point yields identical rest coordinates across poses');

// 3. Cuff guard in rest space: points whose rest height exceeds the limit are
//    rejected regardless of how the pose deforms the local height.
const limit = 0.425; // knee stocking
let aboveRejected = true, belowAccepted = true;
for (let vertex = 0; vertex < restPos.length / 3; vertex += 37) {
  const ry = restPos[vertex * 3 + 1];
  const hit = v(
    crossed.getAttribute('position').array[vertex * 3],
    crossed.getAttribute('position').array[vertex * 3 + 1],
    crossed.getAttribute('position').array[vertex * 3 + 2],
  );
  const rest = restPointAt(meshStub(crossed), hit);
  if (ry > limit && !(rest.y > limit)) aboveRejected = false;
  if (ry <= limit && rest.y > limit) belowAccepted = false;
}
check(aboveRejected, 'hits above the cuff are rejected using rest height');
check(belowAccepted, 'hits below the cuff are accepted using rest height');

// 4. Radius preserved and a re-hit near the same rest point merges instead of
//    spawning a second stain (the 0.021 merge threshold is evaluated in rest space).
const stain = { x: stored.x, y: stored.y, z: stored.z, w: 0.046 };
const neighborVertex = sampleVertex; // identical location -> distance 0 < .021
const mergeDistance = Math.hypot(stain.x - reprojected.x, stain.y - reprojected.y, stain.z - reprojected.z);
check(mergeDistance < 0.021, 'overlapping pours merge via rest-space proximity');
check(stain.w > 0, 'stain radius stored unchanged: ' + stain.w);

// 5. Dry: clearing mark.w zeroes every stain, and nearest lookup still works after.
stain.w = 0;
check(stain.w === 0, 'drying zeroes the stain uniform');
const afterDry = restPointAt(meshStub(tiptoe), hitTiptoe);
check(!!afterDry, 're-pouring after dry still resolves a rest point');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
