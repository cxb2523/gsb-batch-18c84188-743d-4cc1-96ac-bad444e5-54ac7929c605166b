import { describe, it, expect } from 'vitest';
import { clipPolygonToTriangle, clipSegmentToTriangle, type Tri2, type Vec2 } from './polygonClip';

const tri: Tri2 = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 0, y: 10 },
];

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

const clipPoly = (poly: Vec2[], t: Tri2 = tri): Vec2[] =>
  clipPolygonToTriangle(poly, t, (p) => p, lerp);

describe('clipPolygonToTriangle', () => {
  it('keeps a fully-inside polygon unchanged', () => {
    const poly: Vec2[] = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ];
    expect(clipPoly(poly)).toEqual(poly);
  });

  it('returns [] for a fully-outside polygon', () => {
    const poly: Vec2[] = [
      { x: 20, y: 20 },
      { x: 30, y: 20 },
      { x: 20, y: 30 },
    ];
    expect(clipPoly(poly)).toEqual([]);
  });

  it('clips a square crossing the hypotenuse to a triangle', () => {
    const poly: Vec2[] = [
      { x: 4, y: 4 },
      { x: 12, y: 4 },
      { x: 12, y: 12 },
      { x: 4, y: 12 },
    ];
    // Hypotenuse x + y = 10 cuts the square into a triangle (4,4),(6,4),(4,6).
    const out = clipPoly(poly);
    expect(out).toHaveLength(3);
    expect(out).toContainEqual({ x: 4, y: 4 });
    expect(out).toContainEqual({ x: 6, y: 4 });
    expect(out).toContainEqual({ x: 4, y: 6 });
  });

  it('works with the opposite triangle winding', () => {
    const flipped: Tri2 = [tri[0], tri[2], tri[1]];
    const poly: Vec2[] = [
      { x: 4, y: 4 },
      { x: 12, y: 4 },
      { x: 12, y: 12 },
      { x: 4, y: 12 },
    ];
    const out = clipPoly(poly, flipped);
    expect(out).toHaveLength(3);
  });

  it('interpolates carried attributes at crossing points', () => {
    interface P { x: number; y: number; w: number }
    const poly: P[] = [
      { x: 0, y: 0, w: 0 },
      { x: 20, y: 0, w: 20 },
      { x: 0, y: 20, w: 40 },
    ];
    const out = clipPolygonToTriangle(
      poly,
      tri,
      (p) => p,
      (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t }),
    );
    // The crossing on edge (0,0)→(20,0) with the hypotenuse is (10,0), w = 10.
    const crossing = out.find((p) => p.x === 10 && p.y === 0);
    if (!crossing) throw new Error('expected a crossing vertex at (10,0)');
    expect(crossing.w).toBe(10);
  });
});

describe('clipSegmentToTriangle', () => {
  it('returns the whole segment when both endpoints are inside', () => {
    const out = clipSegmentToTriangle({ x: 1, y: 1 }, { x: 2, y: 2 }, tri);
    expect(out).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it('returns null when the segment is fully outside', () => {
    expect(clipSegmentToTriangle({ x: 20, y: 0 }, { x: 30, y: 5 }, tri)).toBeNull();
  });

  it('trims a segment crossing the hypotenuse', () => {
    const out = clipSegmentToTriangle({ x: 0, y: 0 }, { x: 20, y: 20 }, tri);
    if (!out) throw new Error('expected a clipped sub-segment');
    const [p0, p1] = out;
    expect(p0).toEqual({ x: 0, y: 0 });
    expect(p1.x).toBeCloseTo(5, 9);
    expect(p1.y).toBeCloseTo(5, 9);
  });

  it('returns null for a segment merely touching the triangle at one point', () => {
    // Leaves the triangle corner (10,0) heading outside — intersection is a
    // single point, which reports null (nothing to stroke).
    expect(clipSegmentToTriangle({ x: 10, y: 0 }, { x: 20, y: 5 }, tri)).toBeNull();
  });

  it('clips against a concave-quad shading triangle pair (dart case)', () => {
    // Dart quad: top (0,0), right (32,-80), bottom (0,-64) reflex, left (-32,-80).
    // A horizontal chord at y = -70 passes BELOW the reflex vertex, straight
    // through the notch: only the two side pieces inside the shading triangles
    // may survive, leaving a gap over the notch (x between -12 and 12).
    const west: Tri2 = [
      { x: 0, y: -64 },
      { x: -32, y: -80 },
      { x: 0, y: 0 },
    ];
    const east: Tri2 = [
      { x: 0, y: -64 },
      { x: 32, y: -80 },
      { x: 0, y: 0 },
    ];
    const a = { x: -28, y: -70 };
    const b = { x: 28, y: -70 };
    const w = clipSegmentToTriangle(a, b, west);
    const e = clipSegmentToTriangle(a, b, east);
    if (!w || !e) throw new Error('expected both side pieces to survive clipping');
    expect(w[0].x).toBeCloseTo(-28, 6);
    expect(w[1].x).toBeCloseTo(-12, 6);
    expect(w[1].y).toBeCloseTo(-70, 6);
    expect(e[0].x).toBeCloseTo(12, 6);
    expect(e[0].y).toBeCloseTo(-70, 6);
    expect(e[1].x).toBeCloseTo(28, 6);
  });
});
