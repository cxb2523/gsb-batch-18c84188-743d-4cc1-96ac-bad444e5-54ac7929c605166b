// js/sky.js: a nicer sky for high graphics quality (quality.js): a gradient dome (the horizon in the map's sky
// colour, which is also the fog colour, so the land still fades into it, and a deeper colour overhead), low-poly
// clouds drifting with the wind, and the sun where the light comes from. Low quality keeps the plain sky colour.
// Built once and only recoloured when the map or weather changes; the clouds are one instanced mesh.
//
// The sky follows the graphics level by itself (quality.js): Auto dropping to Low, the manual cycle in the hangar and
// picking Auto again to retry High all take effect immediately, and the fog / clear rules hold at either level. A
// recolour made while the sky is hidden is kept, so switching back to High shows the current map and weather, not the
// colours from before. When the clouds are not on screen nothing drifts and no per-frame instance matrix is written.

import * as THREE from 'three';
import { Quality } from './quality.js';

const CLOUDS = 70, PUFFS = 5;                    // cloud clusters, puffs per cluster
const SPREAD = 6500, ALT = [700, 1300];          // around the middle of the map, height range
const DRIFT = 8, DRIFT_STORM = 18;               // cloud drift speed (world units/s)
const R = Math.random;                           // only looks: never part of the simulation (rand.js)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();

export class Sky {
  constructor(scene, sunLight) {
    this.scene = scene;
    this.sunLight = sunLight;
    this.on = false;               // high graphics: the sky is drawn at all (quality.js)
    this.weather = 'clear';        // the weather this sky is coloured for (setLook)
    this.sunVisible = false;       // no sun before the first setLook, which is what decides it from the weather
    // the dome: a sphere seen from inside, coloured by height
    const geo = new THREE.SphereGeometry(9000, 32, 16);
    this.domeGeo = geo;
    const n = geo.attributes.position.count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
    this.dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.dome.renderOrder = -1;
    // the sun and its glow
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(160, 16, 8), new THREE.MeshBasicMaterial({ color: 0xfff4d6, fog: false }));
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(520, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffe9b8, transparent: true, opacity: 0.22, fog: false, depthWrite: false }));
    // clouds: flattened puffs in clusters
    // a little light of their own, so the undersides (lit by the dark ground colour of the sky light) are light grey, not black
    this.cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x8d97a3 });
    this.clouds = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 2), this.cloudMat, CLOUDS * PUFFS);
    this.clouds.frustumCulled = false;
    this.puffs = [];
    for (let c = 0; c < CLOUDS; c++) {
      const cx = (R() * 2 - 1) * SPREAD, cz = (R() * 2 - 1) * SPREAD, cy = ALT[0] + R() * (ALT[1] - ALT[0]), size = 60 + R() * 90;
      for (let k = 0; k < PUFFS; k++) {
        this.puffs.push({ x: cx + (R() - 0.5) * size * 2.2, y: cy + (R() - 0.5) * size * 0.3, z: cz + (R() - 0.5) * size * 1.2,
          s: size * (0.55 + R() * 0.6) });
      }
    }
    this.drift = 0;
    for (const o of [this.dome, this.sun, this.glow, this.clouds]) { o.visible = false; scene.add(o); }
    // follow the graphics setting itself, so the sky is right whoever changes it: Auto measuring this device too slow,
    // the manual Auto -> High -> Low cycle, or Auto chosen again to try High
    this.unfollow = Quality.onChange(() => this.setEnabled(Quality.high));
    this.setEnabled(Quality.high);
  }

  // stop following the graphics setting (a sky that is thrown away; tests use it to leave the shared listener list clean)
  dispose() { if (this.unfollow) { this.unfollow(); this.unfollow = null; } }

  // the map's sky colour (also the fog colour) and its weather -> recolour the dome and the clouds.
  // This always records the look and applies the visibility rules, even on Low, so the next High is already correct.
  setLook(skyHex, weather = 'clear') {
    const horizon = new THREE.Color(skyHex);
    const dark = { rain: 0.25, thunderstorm: 0.5, fog: 0, sandstorm: 0.1 }[weather] || 0;
    const zenith = new THREE.Color(skyHex).lerp(new THREE.Color(weather === 'clear' ? 0x2f6fc0 : 0x56657a), weather === 'clear' ? 0.55 : 0.35);
    const pos = this.domeGeo.attributes.position, col = this.domeGeo.attributes.color;
    if (pos && col && col.array) {
      for (let i = 0; i < pos.count; i++) {
        const h = Math.max(0, pos.getY ? pos.getY(i) / 9000 : 0);       // 0 at the horizon, 1 straight up
        _c.copy(horizon).lerp(zenith, Math.pow(h, 0.6));
        col.array[i * 3] = _c.r; col.array[i * 3 + 1] = _c.g; col.array[i * 3 + 2] = _c.b;
      }
      col.needsUpdate = true;
    }
    // clouds: white on a clear day, greyer in rain, dark in a storm; the sun only on clear days
    if (this.cloudMat.color && this.cloudMat.color.setHex) this.cloudMat.color.setHex(dark > 0.4 ? 0x6c7480 : dark > 0 ? 0xb4bcc6 : 0xffffff);
    if (this.cloudMat.emissive && this.cloudMat.emissive.setHex) this.cloudMat.emissive.setHex(dark > 0.4 ? 0x3a4048 : dark > 0 ? 0x6c747e : 0x8d97a3);
    this.sunVisible = weather === 'clear';
    this.weather = weather;
    this.apply();
  }
  setEnabled(on) { this.on = !!on; this.apply(); }
  // the one place that decides what is on screen, from the graphics level and the current weather
  apply() {
    this.dome.visible = this.on;
    this.clouds.visible = this.on && this.weather !== 'fog';
    this.sun.visible = this.glow.visible = this.on && this.sunVisible;
  }

  // every frame: the dome and the sun stay around the camera; the clouds drift slowly
  update(dt, camera) {
    if (!this.on) return;                         // low graphics: nothing of the sky is drawn, so nothing to update
    this.dome.position.copy(camera.position);
    const dir = _p.copy(this.sunLight.position).normalize();
    this.sun.position.copy(camera.position).addScaledVector(dir, 8000);
    this.glow.position.copy(this.sun.position);
    // clouds hidden (fog, or the sky turned off since the last frame) neither drift nor get new matrices: the time
    // they were away is not banked up, so they carry on from where they stopped instead of jumping into place
    if (!this.clouds.visible) return;
    this.drift += dt * (this.weather === 'thunderstorm' ? DRIFT_STORM : DRIFT);
    for (let i = 0; i < this.puffs.length; i++) {
      const p = this.puffs[i];
      let x = p.x + this.drift;
      x = ((x + SPREAD) % (2 * SPREAD) + 2 * SPREAD) % (2 * SPREAD) - SPREAD;     // wrap around the map
      _m.compose(_p.set(x, p.y, p.z), _q, _s.set(p.s, p.s * 0.45, p.s * 0.7));
      this.clouds.setMatrixAt(i, _m);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }
}
