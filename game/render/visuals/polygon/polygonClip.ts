/**
 * Pure screen-space clipping helpers for terrain surface detail (contour bands
 * and fold strokes).
 *
 * A tile's shading triangles exactly tile its (possibly concave) projected
 * diamond — the shading plan always picks the diagonal through the concave
 * vertex — so intersecting a quad-level contour polygon/segment with each of
 * the two shading triangles yields exactly the part that lies inside the tile.
 * This is what guarantees contour bands and fold strokes can never paint past
 * the tile boundary into a neighbour, even when the projected quad is concave
 * and a straight chord between two edge crossings would otherwise cut across
 * the reflex notch.
 *
 * Pure math — zero Pixi dependencies.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type Tri2 = readonly [Vec2, Vec2, Vec2];

// Tolerance for half-plane tests: points within EPS of a clip edge count as
// inside, so contour chords computed to lie exactly ON a triangle edge (e.g.
// along the shared shading diagonal) survive clipping without jitter loss.
const EPS = 1e-9;

/** Signed area×2 of the triangle, normalised to ±1 (degenerate → +1). */
function windingSign(tri: Tri2): number {
  const [a, b, c] = tri;
  const s = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return s < 0 ? -1 : 1;
}

/** Signed distance numerator of p to the directed edge A→B, flipped so inside ≥ 0. */
function edgeDist(A: Vec2, B: Vec2, p: Vec2, sign: number): number {
  return sign * ((B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x));
}

/**
 * Sutherland–Hodgman clip of an arbitrary simple polygon against a triangle
 * (any winding). Vertex attributes are interpolated linearly at new crossing
 * points via `lerp(a, b, t)` (t = 0 at a, 1 at b), so texture UVs stay glued to
 * their screen positions. Returns [] when the intersection is empty.
 */
export function clipPolygonToTriangle<T>(
  poly: readonly T[],
  tri: Tri2,
  pos: (p: T) => Vec2,
  lerp: (a: T, b: T, t: number) => T,
): T[] {
  let out = poly.slice();
  const sign = windingSign(tri);
  for (let e = 0; e < 3; e++) {
    const A = tri[e];
    const B = tri[(e + 1) % 3];
    const next: T[] = [];
    for (let i = 0; i < out.length; i++) {
      const P = out[i];
      const Q = out[(i + 1) % out.length];
      const dP = edgeDist(A, B, pos(P), sign);
      const dQ = edgeDist(A, B, pos(Q), sign);
      const pIn = dP >= -EPS;
      const qIn = dQ >= -EPS;
      if (pIn) next.push(P);
      if (pIn !== qIn) {
        next.push(lerp(P, Q, dP / (dP - dQ)));
      }
    }
    out = next;
    if (out.length === 0) break;
  }
  return out;
}

/**
 * Clip the segment a→b to a triangle (Cyrus–Beck, any winding), returning the
 * inside sub-segment or null. A triangle is convex, so the intersection is
 * always a single contiguous piece. Zero-length results (segment merely
 * touching an edge/corner) report null.
 */
export function clipSegmentToTriangle(a: Vec2, b: Vec2, tri: Tri2): [Vec2, Vec2] | null {
  const sign = windingSign(tri);
  let t0 = 0;
  let t1 = 1;
  for (let e = 0; e < 3; e++) {
    const A = tri[e];
    const B = tri[(e + 1) % 3];
    const da = edgeDist(A, B, a, sign);
    const db = edgeDist(A, B, b, sign);
    if (da < -EPS && db < -EPS) return null; // fully outside this half-plane
    const dd = db - da;
    if (Math.abs(dd) < EPS) continue; // parallel to the edge — no new constraint
    const t = -da / dd;
    if (da < -EPS) {
      if (t > t0) t0 = t; // entering
    } else if (db < -EPS) {
      if (t < t1) t1 = t; // leaving
    }
  }
  if (t1 - t0 < EPS) return null;
  return [
    { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
    { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
  ];
}
