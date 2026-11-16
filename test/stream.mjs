// Streaming selection regression: threshold and budget modes must treat a wanted group whose
// member clusters are not resident the same way -- keep the coarser resident cut as fallback,
// record the finest wanted level in wantLevel, never draw a non-resident cluster, and let the
// next select() refine naturally after updateStreaming fetches the data (no batch/selector rebuild).
// Builds a real asset with the preprocessor and serves it over a local Range-capable HTTP server.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClod } from '../src/build.js';
import { makeSample } from '../examples/make-sample.mjs';
import { loadClod, loadClodStream, updateStreaming, ClodBatch, ClodSelector } from '../src/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));
try {
  const glb = path.join(tmp, 'rock.glb');
  fs.writeFileSync(glb, makeSample('rock', { texture: 32 }));
  await buildClod({ input: glb, outDir: tmp, name: 'rock', maxTriangles: 40000, lods: false, log: () => {} });

  const MIME = { '.json': 'application/json', '.bin': 'application/octet-stream' };
  const server = http.createServer((req, res) => {
    const file = path.join(tmp, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const stat = fs.statSync(file), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const st = +m[1], en = m[2] === '' ? stat.size - 1 : +m[2];
      res.writeHead(206, { 'Content-Range': `bytes ${st}-${en}/${stat.size}`, 'Content-Length': en - st + 1, 'Content-Type': MIME[path.extname(file)] });
      fs.createReadStream(file, { start: st, end: en }).pipe(res);
    } else { res.writeHead(200, { 'Content-Length': stat.size }); fs.createReadStream(file).pipe(res); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const cam = new THREE.PerspectiveCamera(60, 1, 0.05, 3000);
  cam.position.set(0.6 * 0.48, 0.6 * 0.34, 0.6 * 0.81); cam.lookAt(0, 0.3, 0); cam.updateMatrixWorld();
  const mats = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(0.3, 0, 0.2)];

  const ids = (b) => { const o = []; for (let n = 0; n < b._multiDrawCount; n++) o.push(b.indirect[n * 2] * 1000000 + (b.indirect[n * 2 + 1] & 0xffffff)); return o.sort((x, y) => x - y); };
  const drawnTris = (a, b) => { let t = 0; for (let n = 0; n < b._multiDrawCount; n++) t += a.clusterU[(b.indirect[n * 2 + 1] & 0xffffff) * 4 + 1] / 3; return t; };
  const finestDrawn = (a, b) => Math.min(...[...Array(b._multiDrawCount)].map((_, n) => a.clusterU[(b.indirect[n * 2 + 1] & 0xffffff) * 4 + 3]));

  // ---- partial asset: residency boundary inside the DAG, several instances, tight budget ----
  const asset = await loadClodStream(base, 'rock', { rootBytes: 8 * 1024 });
  await asset.loadTo(5);
  assert.ok(asset.loadedLevel > 0, 'fixture should be partially resident');
  const bT = new ClodBatch(asset, new THREE.MeshBasicMaterial(), mats), sT = new ClodSelector([bT]); sT.frustumCull = false;
  const bB = new ClodBatch(asset, new THREE.MeshBasicMaterial(), mats), sB = new ClodSelector([bB]); sB.frustumCull = false;

  for (const budget of [1500, 8000, 60000]) {
    sT.select(cam, 1080, { errorPx: 1, budget: 0 });
    const wantT = asset.wantLevel;
    const stB = sB.select(cam, 1080, { errorPx: 0.5, budget });
    const wantB = asset.wantLevel;
    // 1. both modes request finer data, and agree on the finest level
    assert.ok(wantT < asset.loadedLevel, `threshold did not record a wanted level (budget ${budget})`);
    assert.equal(wantB, wantT, `budget wantLevel ${wantB} != threshold wantLevel ${wantT} at budget ${budget}`);
    // 2. every drawn cluster is resident (no unloaded cluster is drawn as a "final" leaf)
    assert.ok(finestDrawn(asset, bB) >= asset.loadedLevel, 'budget mode drew a non-resident cluster');
    assert.ok(finestDrawn(asset, bT) >= asset.loadedLevel, 'threshold mode drew a non-resident cluster');
    // 3. budget accounting counts only triangles actually drawn and never exceeds budget by > one refine step
    const real = drawnTris(asset, bB);
    assert.equal(Math.round(stB.tris), Math.round(real), 'stats.tris counts phantom (undrawn) triangles');
    assert.ok(real < budget * 2, `drawn ${Math.round(real)} overshot budget ${budget} by more than one step`);
    // 4. no non-resident group was refined into
    for (let r = 0; r < sB.rN; r++) { const g = sB.rList[r * 3 + 2]; assert.ok(asset.minMemberLevel[g] >= asset.loadedLevel, 'refined into a non-resident group'); }
  }

  // ---- after the wanted levels arrive, the next select refines with no rebuild ----
  const batchRef = bB, selectorRef = sB;
  sB.select(cam, 1080, { errorPx: 0.5, budget: 100000 });
  await Promise.all(updateStreaming([asset]));
  assert.ok(asset.loadedLevel < 5, 'streaming did not advance loadedLevel');
  sB.select(cam, 1080, { errorPx: 0.5, budget: 100000 });
  assert.equal(bB, batchRef, 'ClodBatch was rebuilt after a stream load');
  assert.equal(sB, selectorRef, 'ClodSelector was rebuilt after a stream load');
  assert.equal(bB.geometry, asset.geometry, 'batch geometry was not rebound to the loaded geometry');
  assert.ok(finestDrawn(asset, bB) <= asset.loadedLevel, 'cut did not refine into newly resident levels');

  // ---- fully loaded streaming asset: wantLevel stays 255 and its cut equals a loadClod cut ----
  await asset.loadTo(0);
  assert.equal(asset.loadedLevel, 0);
  sB.select(cam, 1080, { errorPx: 0.5, budget: 1e12 });
  assert.equal(asset.wantLevel, 255, 'complete asset should not request more data');
  const full = await loadClod(base, 'rock');
  const bF = new ClodBatch(full, new THREE.MeshBasicMaterial(), mats), sF = new ClodSelector([bF]); sF.frustumCull = false;
  sF.select(cam, 1080, { errorPx: 1, budget: 0 });
  sT.select(cam, 1080, { errorPx: 1, budget: 0 });
  assert.deepEqual(ids(bT), ids(bF), 'fully loaded streaming cut differs from the loadClod cut');
  assert.equal(full.wantLevel, 255, 'non-streaming wantLevel must remain 255');

  server.close();
  console.log('ok: streaming budget/threshold selection consistent, fallback crack-safe, refines after load without rebuild');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
