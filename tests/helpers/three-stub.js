/**
 * Minimal three.js surface used by the modules under test. The full library
 * is loaded from a CDN import map in the browser; for plain Node unit tests we
 * only need the handful of classes referenced by ProjectionPainter / PaintStrokeCommand.
 */
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }

  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  applyMatrix4() {
    return this;
  }

  applyMatrix3() {
    return this;
  }

  project() {
    return this;
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  getWorldDirection(target) {
    return target.set(0, 0, -1);
  }

  negate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }
}

export class Matrix3 {
  getNormalMatrix() {
    return this;
  }
}

export class Triangle {
  constructor(a, b, c) {
    this.a = a;
    this.b = b;
    this.c = c;
  }

  getNormal(target) {
    return target.set(0, 0, 1);
  }
}

export class Plane {
  setFromNormalAndCoplanarPoint() {
    return this;
  }
}

export class Raycaster {
  setFromCamera() {}

  intersectObject() {
    return [];
  }
}

export const MathUtils = {
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },
};

export function CanvasTexture() {}
