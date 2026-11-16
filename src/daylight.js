// 日光推进：随里程把黄金时刻一路压到蓝调霓虹
// 纯视觉层——只改天空/雾/灯光/曝光/泛光，不参与任何物理与判定
import * as THREE from 'three';

const C = (hex) => new THREE.Color(hex);
const V = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

// 关键帧：每 400m 一档，档与档之间做平滑插值
const KEYS = [
  {
    d: 0, // 黄昏 · 黄金时刻
    zenith: C(0x16233f), horizon: C(0xe8874f), ground: C(0x241a20), sunCol: C(0xffd9a0),
    sunDir: V(0.24, 0.58, 1), sunGain: 0.62,
    fog: C(0xc07a52), fogNear: 45, fogFar: 330,
    groundPlane: C(0x0d0f14),
    lightCol: C(0xffc08a), lightInt: 2.6,
    hemiSky: C(0x93b8ff), hemiGround: C(0x3a3230), hemiInt: 0.68,
    ambCol: C(0x46527a), ambInt: 0.4,
    exposure: 1.12,
    bloomS: 0.4, bloomR: 0.6, bloomT: 0.9,
    env: 1.0, emissive: 0.8, rainA: 0.3,
  },
  {
    d: 400, // 落日贴地 · 橙红更浓，影子拉长
    zenith: C(0x1c1c3c), horizon: C(0xec6a3c), ground: C(0x2b1a1b), sunCol: C(0xffb272),
    sunDir: V(0.22, 0.4, 1), sunGain: 0.5,
    fog: C(0xb35c3c), fogNear: 42, fogFar: 300,
    groundPlane: C(0x181012),
    lightCol: C(0xff9d63), lightInt: 2.15,
    hemiSky: C(0x9a92d8), hemiGround: C(0x3c2b2b), hemiInt: 0.6,
    ambCol: C(0x4a4a7c), ambInt: 0.38,
    exposure: 1.07,
    bloomS: 0.42, bloomR: 0.6, bloomT: 0.89,
    env: 0.95, emissive: 0.9, rainA: 0.31,
  },
  {
    d: 800, // 日落后 · 紫红余晖，城市开始亮灯
    zenith: C(0x171a38), horizon: C(0xbb4a64), ground: C(0x221522), sunCol: C(0xff8f6e),
    sunDir: V(0.2, 0.26, 1), sunGain: 0.28,
    fog: C(0x7d4358), fogNear: 40, fogFar: 285,
    groundPlane: C(0x241321),
    lightCol: C(0xff8c72), lightInt: 1.55,
    hemiSky: C(0x8580c8), hemiGround: C(0x30263c), hemiInt: 0.52,
    ambCol: C(0x43406f), ambInt: 0.35,
    exposure: 1.01,
    bloomS: 0.46, bloomR: 0.6, bloomT: 0.87,
    env: 0.8, emissive: 1.0, rainA: 0.33,
  },
  {
    d: 1200, // 蓝调时刻 · 霓虹亮起
    zenith: C(0x070d1e), horizon: C(0x2f5f8f), ground: C(0x0a1220), sunCol: C(0xa9c8ff),
    sunDir: V(0.18, 0.16, 1), sunGain: 0.1,
    fog: C(0x1d2f4a), fogNear: 36, fogFar: 270,
    groundPlane: C(0x16263c),
    lightCol: C(0x9db8ea), lightInt: 1.2,
    hemiSky: C(0x5b74b8), hemiGround: C(0x161c2e), hemiInt: 0.58,
    ambCol: C(0x34406e), ambInt: 0.34,
    exposure: 0.96,
    bloomS: 0.52, bloomR: 0.6, bloomT: 0.84,
    env: 0.6, emissive: 1.15, rainA: 0.36,
  },
];

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// 缓降余量时长，与 player.js 中 glideT = 2.0 保持一致
const GLIDE_DUR = 2.0;

export class Daylight {
  constructor(stage, city) {
    this.stage = stage;
    this.city = city;
    this.phase = 0;
    this._d = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._lightDir = new THREE.Vector3();
    // 复用同一批颜色对象，避免每帧分配
    this._c = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), ground: new THREE.Color(),
      sunCol: new THREE.Color(), fog: new THREE.Color(), lightCol: new THREE.Color(),
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), ambCol: new THREE.Color(),
      groundPlane: new THREE.Color(),
    };
    this._n = {};
    // 缓降偏移：叠加在里程基线之上的临时量，不回写里程/档位
    this._glideW = 0; // 当前偏移权重 0..1（已平滑）
    this._next = null; // 当前档位的下一档关键帧（最后一档为 null）
    this.update(0);
  }

  // 主循环每帧告知缓降状态：remain 为缓降剩余秒数（<=0 表示不在缓降）。
  // 权重随剩余时间连续衰减；落地/主动收伞/超时结束时 remain 归零，
  // 这里只做平滑释放，几帧内回到基线，不跳变、不残留。
  setGlide(remain, dt) {
    const target = remain > 0 ? Math.min(1, remain / GLIDE_DUR) : 0;
    // 进入快、退出柔：被打断时也能看得到"回到当前天色"的过程
    const rate = target > this._glideW ? 12 : 6;
    this._glideW = lerp(this._glideW, target, 1 - Math.exp(-rate * dt));
    if (target === 0 && this._glideW < 0.002) this._glideW = 0; // 收敛归零，杜绝残留
  }

  // dist 为累计里程；超过最后一档就固定在蓝调时刻
  update(dist) {
    const K = KEYS;
    let i = 0;
    while (i < K.length - 1 && dist >= K[i + 1].d) i++;
    this.phase = i;
    const a = K[i];
    const b = K[Math.min(i + 1, K.length - 1)];
    const span = b.d - a.d;
    const t = span > 0 ? smooth(Math.min(1, Math.max(0, (dist - a.d) / span))) : 0;

    for (const k in this._c) this._c[k].copy(a[k]).lerp(b[k], t);
    this._sunDir.copy(a.sunDir).lerp(b.sunDir, t).normalize();
    // 投影光保持最低仰角，只压低不翻转
    this._lightDir.copy(a.sunDir).lerp(b.sunDir, t);
    this._lightDir.y = Math.max(this._lightDir.y, 0.24);
    this._lightDir.normalize();

    const n = this._n;
    for (const k of ['sunGain', 'fogNear', 'fogFar', 'lightInt', 'hemiInt', 'ambInt',
      'exposure', 'bloomS', 'bloomR', 'bloomT', 'env', 'emissive', 'rainA']) {
      n[k] = lerp(a[k], b[k], t);
    }
    // 缓降偏移的目标档：当前档位的下一档；最后一档（1200m+）没有下一档，不偏移
    this._next = i < K.length - 1 ? K[i + 1] : null;
    this._apply();
  }

  _apply() {
    const s = this.stage;
    const c = this._c;
    const n = this._n;
    const u = s.sky.uniforms;
    u.uZenith.value.copy(c.zenith);
    u.uHorizon.value.copy(c.horizon);
    u.uGround.value.copy(c.ground);
    u.uSunColor.value.copy(c.sunCol);
    u.uSunDir.value.copy(this._sunDir);
    u.uSunGain.value = n.sunGain;
    s.setLightDir(this._lightDir.x, this._lightDir.y, this._lightDir.z);

    // 缓降临时偏移：把泛光/雨丝/雾色朝下一档推 w 比例。
    // 只写数值通道——bloom.enabled 由自适应画质独占，这里绝不触碰，
    // 降档关闭泛光后偏移不会把它重新打开；w 归零时各项精确回到里程基线。
    const w = this._glideW;
    const nx = w > 0 ? this._next : null;

    s.scene.fog.color.copy(c.fog);
    if (nx) s.scene.fog.color.lerp(nx.fog, w);
    s.scene.fog.near = n.fogNear;
    s.scene.fog.far = n.fogFar;
    // 远景地面跟着天色走，避免夜里地面比雾还黑、地平线出现生硬的缝
    if (s.ground) s.ground.color.copy(c.groundPlane);

    s.sun.color.copy(c.lightCol);
    s.sun.intensity = n.lightInt;
    s.hemi.color.copy(c.hemiSky);
    s.hemi.groundColor.copy(c.hemiGround);
    s.hemi.intensity = n.hemiInt;
    s.ambient.color.copy(c.ambCol);
    s.ambient.intensity = n.ambInt;

    s.renderer.toneMappingExposure = n.exposure;
    s.bloom.strength = nx ? lerp(n.bloomS, nx.bloomS, w) : n.bloomS;
    s.bloom.radius = n.bloomR;
    s.bloom.threshold = n.bloomT;
    if ('environmentIntensity' in s.scene) s.scene.environmentIntensity = n.env;
    if (s.rainMat) s.rainMat.uniforms.uAlpha.value = nx ? lerp(n.rainA, nx.rainA, w) : n.rainA;
    if (this.city && this.city.setEmissive) this.city.setEmissive(n.emissive);
  }
}
