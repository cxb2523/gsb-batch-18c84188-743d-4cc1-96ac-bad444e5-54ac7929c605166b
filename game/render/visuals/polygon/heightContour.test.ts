import { describe, it, expect } from 'vitest';
import {
  contourQuadPolygons,
  foldContourSegments,
  SAND_MAX_HEIGHT,
  ROCK_MIN_HEIGHT,
  type ContourSide,
  type QuadContourVertex,
} from './heightContour';
import { clipPolygonToTriangle, clipSegmentToTriangle, type Tri2, type Vec2 } from './polygonClip';
import { planDiamondShading } from './diamondShading';
import { projectTileCornerScreen, polygonContains } from '../../IsoTransform';
import type { CornerHeights } from '../../terrain/tileCornerHeights';
import type { ScreenCoord } from '@/game/types/coordinates';

const LOW = SAND_MAX_HEIGHT; // sand threshold (0.5)
const HIGH = ROCK_MIN_HEIGHT; // rock threshold (4.5) — fixtures straddle it with 5/3

const ch = (topH: number, rightH: number, bottomH: number, leftH: number): CornerHeights => ({
  topH, rightH, bottomH, leftH,
});

const hs = (c: CornerHeights): [number, number, number, number] =>
  [c.topH, c.rightH, c.bottomH, c.leftH];

describe('thresholds', () => {
  it('SAND_MAX_HEIGHT is half a step above the waterline', () => {
    expect(SAND_MAX_HEIGHT).toBe(0.5);
  });
  it('ROCK_MIN_HEIGHT catches the higher ground', () => {
    expect(ROCK_MIN_HEIGHT).toBe(4.5);
  });
});

describe('contourQuadPolygons — below (sand beach)', () => {
  it('returns nothing when every corner is above (all grass)', () => {
    expect(contourQuadPolygons(1, 1, 1, 1, LOW, 'below')).toEqual([]);
  });
  it('returns the whole quad when every corner is below', () => {
    expect(contourQuadPolygons(0, 0, 0, 0, LOW, 'below')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'corner', i: 1 },
      { kind: 'corner', i: 2 },
      { kind: 'corner', i: 3 },
    ]]);
  });
  it('clips to a wedge at the only below corner', () => {
    expect(contourQuadPolygons(0, 1, 1, 1, LOW, 'below')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'edge', a: 0, b: 1, t: 0.5 },
      { kind: 'edge', a: 0, b: 3, t: 0.5 },
    ]]);
    expect(contourQuadPolygons(1, 1, 0, 1, LOW, 'below')).toEqual([[
      { kind: 'corner', i: 2 },
      { kind: 'edge', a: 2, b: 3, t: 0.5 },
      { kind: 'edge', a: 2, b: 1, t: 0.5 },
    ]]);
  });
  it('clips to a quad for two adjacent below corners', () => {
    expect(contourQuadPolygons(0, 0, 1, 1, LOW, 'below')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'corner', i: 1 },
      { kind: 'edge', a: 1, b: 2, t: 0.5 },
      { kind: 'edge', a: 3, b: 0, t: 0.5 },
    ]]);
  });
  it('clips to a quad for two adjacent below corners across the index wrap', () => {
    expect(contourQuadPolygons(0, 1, 1, 0, LOW, 'below')).toEqual([[
      { kind: 'corner', i: 3 },
      { kind: 'corner', i: 0 },
      { kind: 'edge', a: 0, b: 1, t: 0.5 },
      { kind: 'edge', a: 2, b: 3, t: 0.5 },
    ]]);
  });
  it('clips to a pentagon when only one corner is above', () => {
    expect(contourQuadPolygons(1, 0, 0, 0, LOW, 'below')).toEqual([[
      { kind: 'corner', i: 1 },
      { kind: 'corner', i: 2 },
      { kind: 'corner', i: 3 },
      { kind: 'edge', a: 3, b: 0, t: 0.5 },
      { kind: 'edge', a: 0, b: 1, t: 0.5 },
    ]]);
  });
  it('splits into two wedges for a saddle whose centre is above the threshold', () => {
    // Kept corners 0 and 2 (opposite); centre mean = 1 → not below 0.5.
    expect(contourQuadPolygons(0, 2, 0, 2, LOW, 'below')).toEqual([
      [
        { kind: 'corner', i: 0 },
        { kind: 'edge', a: 0, b: 1, t: 0.25 },
        { kind: 'edge', a: 0, b: 3, t: 0.25 },
      ],
      [
        { kind: 'corner', i: 2 },
        { kind: 'edge', a: 2, b: 3, t: 0.25 },
        { kind: 'edge', a: 2, b: 1, t: 0.25 },
      ],
    ]);
  });
  it('connects the saddle into one hexagon when the centre is below the threshold', () => {
    // Kept corners 0 and 2; centre mean = 0.875 < 1 → one connected band.
    expect(contourQuadPolygons(0, 2, 0, 1.5, 1, 'below')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'edge', a: 0, b: 1, t: 0.5 },
      { kind: 'edge', a: 1, b: 2, t: 0.5 },
      { kind: 'corner', i: 2 },
      { kind: 'edge', a: 2, b: 3, t: 2 / 3 },
      { kind: 'edge', a: 3, b: 0, t: 1 / 3 },
    ]]);
  });
  it('treats a corner exactly at the threshold as not-kept', () => {
    expect(contourQuadPolygons(0.5, 1, 1, 1, LOW, 'below')).toEqual([]);
  });
});

describe('contourQuadPolygons — above (highland rock)', () => {
  it('returns nothing when every corner is below the rock line', () => {
    expect(contourQuadPolygons(1, 1, 1, 1, HIGH, 'above')).toEqual([]);
  });
  it('clips to a wedge at the peak corner, interpolating by height', () => {
    // cross t = (4.5 - 5) / (3 - 5) = 0.25 along each edge leaving the peak.
    expect(contourQuadPolygons(5, 3, 3, 3, HIGH, 'above')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'edge', a: 0, b: 1, t: 0.25 },
      { kind: 'edge', a: 0, b: 3, t: 0.25 },
    ]]);
  });
  it('clips to a quad for two adjacent above corners', () => {
    expect(contourQuadPolygons(5, 5, 3, 3, HIGH, 'above')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'corner', i: 1 },
      { kind: 'edge', a: 1, b: 2, t: 0.25 },
      { kind: 'edge', a: 3, b: 0, t: 0.75 }, // (4.5-3)/(5-3), measured from corner 3
    ]]);
  });
  it('splits into two wedges for a saddle whose centre is below the threshold', () => {
    expect(contourQuadPolygons(5, 3, 5, 3, HIGH, 'above')).toEqual([
      [
        { kind: 'corner', i: 0 },
        { kind: 'edge', a: 0, b: 1, t: 0.25 },
        { kind: 'edge', a: 0, b: 3, t: 0.25 },
      ],
      [
        { kind: 'corner', i: 2 },
        { kind: 'edge', a: 2, b: 3, t: 0.25 },
        { kind: 'edge', a: 2, b: 1, t: 0.25 },
      ],
    ]);
  });
  it('connects the saddle into one hexagon when the centre is above the threshold', () => {
    // Kept corners 0 and 2 (h=6); centre mean = 4.75 > 4.5.
    expect(contourQuadPolygons(6, 3, 6, 4, HIGH, 'above')).toEqual([[
      { kind: 'corner', i: 0 },
      { kind: 'edge', a: 0, b: 1, t: 0.5 },
      { kind: 'edge', a: 1, b: 2, t: 0.5 },
      { kind: 'corner', i: 2 },
      { kind: 'edge', a: 2, b: 3, t: 0.75 },
      { kind: 'edge', a: 3, b: 0, t: 0.25 },
    ]]);
  });
});

describe('foldContourSegments — mid-height contour of the surface', () => {
  it('flat tile → no crossings, no segments', () => {
    expect(foldContourSegments(2, 2, 2, 2)).toEqual([]);
    expect(foldContourSegments(0, 0, 0, 0)).toEqual([]);
  });
  it('tent (one corner high) → one segment hugging the peak at the mean level', () => {
    // level = 1.25; crossings on edges 0 (top→right) and 3 (left→top).
    expect(foldContourSegments(2, 1, 1, 1)).toEqual([
      { a: { kind: 'edge', a: 0, b: 1, t: 0.75 }, b: { kind: 'edge', a: 3, b: 0, t: 0.25 } },
    ]);
  });
  it('diagonal drop (one corner low) → one segment hugging the dipped corner', () => {
    // level = 1.75; crossings on edges 2 (bottom→left) and 3 (left→top).
    expect(foldContourSegments(2, 2, 2, 1)).toEqual([
      { a: { kind: 'edge', a: 2, b: 3, t: 0.25 }, b: { kind: 'edge', a: 3, b: 0, t: 0.75 } },
    ]);
  });
  it('saddle (opposite corners differ) → two segments around the high corners', () => {
    // level = 1.5; all four edges cross at t = 0.5; high corners are 0 and 2.
    expect(foldContourSegments(2, 1, 2, 1)).toEqual([
      { a: { kind: 'edge', a: 3, b: 0, t: 0.5 }, b: { kind: 'edge', a: 0, b: 1, t: 0.5 } },
      { a: { kind: 'edge', a: 1, b: 2, t: 0.5 }, b: { kind: 'edge', a: 2, b: 3, t: 0.5 } },
    ]);
  });
  it('corner exactly at the mean → tangent touch dropped, genuine crossings connect', () => {
    // level = 1; corner 3 (h=1) sits exactly at the level — an isolated
    // tangent touch of the contour, dropped so edges 0 and 1 still connect.
    expect(foldContourSegments(0, 3, 0, 1)).toEqual([
      { a: { kind: 'edge', a: 0, b: 1, t: 1 / 3 }, b: { kind: 'edge', a: 1, b: 2, t: 2 / 3 } },
    ]);
  });
  it('two corners exactly at the mean → segment between those corners', () => {
    // level = 1; corners 1 and 3 sit exactly at the level.
    expect(foldContourSegments(0, 1, 2, 1)).toEqual([
      { a: { kind: 'corner', i: 1 }, b: { kind: 'corner', i: 3 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance fixtures — locally constructed corner heights, projected to
// screen space and clipped exactly like DiamondTileVisual does.
// ---------------------------------------------------------------------------

function projectQuad(c: CornerHeights, x = 0, y = 0): ScreenCoord[] {
  const tile = { x, y };
  return [
    projectTileCornerScreen(tile, 'top', c.topH),
    projectTileCornerScreen(tile, 'right', c.rightH),
    projectTileCornerScreen(tile, 'bottom', c.bottomH),
    projectTileCornerScreen(tile, 'left', c.leftH),
  ];
}

/** The two shading triangles the renderer uses (safe diagonal from the plan). */
function shadeTrisOf(c: CornerHeights): Tri2[] {
  const [top, right, bottom, left] = projectQuad(c);
  const plan = planDiamondShading(c);
  return plan.diagonal === 'tb'
    ? [[bottom, left, top], [bottom, right, top]]
    : [[left, top, right], [left, bottom, right]];
}

const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

function resolveVertex(v: QuadContourVertex, pts: ScreenCoord[]): Vec2 {
  if (v.kind === 'corner') return pts[v.i];
  return lerpVec(pts[v.a], pts[v.b], v.t);
}

/** Band pieces exactly as rendered: quad contour polygons clipped per shading triangle. */
function bandPieces(c: CornerHeights, threshold: number, keep: ContourSide): Vec2[][] {
  const pts = projectQuad(c);
  const polys = contourQuadPolygons(...hs(c), threshold, keep);
  const pieces: Vec2[][] = [];
  for (const poly of polys) {
    const screenPoly = poly.map((v) => resolveVertex(v, pts));
    for (const tri of shadeTrisOf(c)) {
      const clipped = clipPolygonToTriangle(screenPoly, tri, (p) => p, lerpVec);
      if (clipped.length >= 3) pieces.push(clipped);
    }
  }
  return pieces;
}

/** Fold-stroke pieces exactly as rendered: mid-height contour segments clipped per triangle. */
function foldPieces(c: CornerHeights): [Vec2, Vec2][] {
  const pts = projectQuad(c);
  const pieces: [Vec2, Vec2][] = [];
  for (const seg of foldContourSegments(...hs(c))) {
    const a = resolveVertex(seg.a, pts);
    const b = resolveVertex(seg.b, pts);
    for (const tri of shadeTrisOf(c)) {
      const piece = clipSegmentToTriangle(a, b, tri);
      if (piece) pieces.push(piece);
    }
  }
  return pieces;
}

/** Parameter of point p along segment a→b (for interval-coverage assertions). */
function paramAlong(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

describe('acceptance — concave projection (ch(0,8,8,8), concave at bottom)', () => {
  const fixture = ch(0, 8, 8, 8);

  it('rock band stays inside the deformed diamond', () => {
    const quad = projectQuad(fixture);
    const pieces = bandPieces(fixture, HIGH, 'above');
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      for (const v of piece) {
        expect(polygonContains(quad, v)).toBe(true);
      }
    }
  });

  it('fold stroke stays inside the deformed diamond and covers the whole segment', () => {
    const quad = projectQuad(fixture);
    const [seg] = foldContourSegments(...hs(fixture));
    const pts = projectQuad(fixture);
    const a = resolveVertex(seg.a, pts);
    const b = resolveVertex(seg.b, pts);
    const pieces = foldPieces(fixture);
    expect(pieces.length).toBeGreaterThan(0);
    const intervals: [number, number][] = [];
    for (const [p0, p1] of pieces) {
      expect(polygonContains(quad, p0)).toBe(true);
      expect(polygonContains(quad, p1)).toBe(true);
      intervals.push([paramAlong(p0, a, b), paramAlong(p1, a, b)]);
    }
    // Convex-hull chord here → the clipped pieces tile the full [0,1] segment.
    intervals.sort((x, y) => x[0] - y[0]);
    expect(intervals[0][0]).toBeCloseTo(0, 6);
    expect(intervals[intervals.length - 1][1]).toBeCloseTo(1, 6);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i][0]).toBeCloseTo(intervals[i - 1][1], 6);
    }
  });
});

describe('acceptance — concave notch crossing (ch(8,0,8,0), sand band crosses the reflex notch)', () => {
  const fixture = ch(8, 0, 8, 0);

  it('unclipped band polygon would cross the notch; clipped pieces never leave the diamond', () => {
    const quad = projectQuad(fixture);
    const bottom = quad[2];
    // Probe a point inside the reflex notch: halfway between the reflex
    // (bottom) vertex and the chord midpoint of the saddle hexagon. It lies
    // OUTSIDE the quad but INSIDE the unclipped band polygon.
    const rawPoly = contourQuadPolygons(...hs(fixture), 7, 'below')[0]
      .map((v) => resolveVertex(v, quad));
    const chordMid = { x: (rawPoly[1].x + rawPoly[2].x) / 2, y: (rawPoly[1].y + rawPoly[2].y) / 2 };
    const notch = { x: (bottom.x + chordMid.x) / 2, y: (bottom.y + chordMid.y) / 2 };
    expect(polygonContains(quad, notch)).toBe(false);
    expect(polygonContains(rawPoly, notch)).toBe(true); // unclipped WOULD bleed

    const pieces = bandPieces(fixture, 7, 'below');
    expect(pieces.length).toBeGreaterThan(0); // band still renders its in-tile parts
    for (const piece of pieces) {
      for (const v of piece) {
        expect(polygonContains(quad, v)).toBe(true);
      }
      expect(polygonContains(piece, notch)).toBe(false);
    }
  });

  it('fold stroke pieces stay inside the diamond and skip the notch', () => {
    const quad = projectQuad(fixture);
    const pieces = foldPieces(fixture);
    expect(pieces.length).toBeGreaterThan(0);
    for (const [p0, p1] of pieces) {
      expect(polygonContains(quad, p0)).toBe(true);
      expect(polygonContains(quad, p1)).toBe(true);
    }
    // The saddle segment around corner 0 runs straight across the notch at
    // y = -40; its midpoint must be clipped AWAY, not stroked.
    const segments = foldContourSegments(...hs(fixture));
    const pts = projectQuad(fixture);
    const across = segments.find((s) => {
      const a = resolveVertex(s.a, pts);
      const b = resolveVertex(s.b, pts);
      return Math.abs((a.y + b.y) / 2 + 40) < 1e-6;
    });
    if (!across) throw new Error('expected a fold segment across the notch');
    const a = resolveVertex(across.a, pts);
    const b = resolveVertex(across.b, pts);
    for (const [p0, p1] of pieces) {
      const t0 = paramAlong(p0, a, b);
      const t1 = paramAlong(p1, a, b);
      const lo = Math.min(t0, t1);
      const hi = Math.max(t0, t1);
      // No piece may cover the segment midpoint (t = 0.5, the notch interior).
      expect(lo < 0.5 && hi > 0.5).toBe(false);
    }
  });
});

describe('acceptance — tent (ch(2,1,1,1), single raised corner)', () => {
  const fixture = ch(2, 1, 1, 1);

  it('fold stroke is one segment on the mean-height contour, fully inside the diamond', () => {
    const quad = projectQuad(fixture);
    const segments = foldContourSegments(...hs(fixture));
    expect(segments).toHaveLength(1);
    const pieces = foldPieces(fixture);
    expect(pieces.length).toBeGreaterThan(0);
    for (const [p0, p1] of pieces) {
      expect(polygonContains(quad, p0)).toBe(true);
      expect(polygonContains(quad, p1)).toBe(true);
    }
  });
});

describe('acceptance — band boundary continuity across the shading diagonal', () => {
  it('sand chord is one straight line; clipped pieces meet at the diagonal with no gap', () => {
    // Coastal tile: two adjacent corners below the sand line. The cut chord
    // runs across the whole quad and crosses the TB shading diagonal.
    const fixture = ch(0, 0, 1, 1);
    const polys = contourQuadPolygons(...hs(fixture), LOW, 'below');
    expect(polys).toHaveLength(1);
    const edgeVerts = polys[0].filter((v) => v.kind === 'edge');
    expect(edgeVerts).toHaveLength(2); // single straight chord, no diagonal kink

    // Sample the chord; every sample must land inside some rendered piece —
    // including the samples that fall on the OTHER shading triangle.
    const pts = projectQuad(fixture);
    const [e0, e1] = edgeVerts.map((v) => resolveVertex(v, pts));
    const pieces = bandPieces(fixture, LOW, 'below');
    expect(pieces.length).toBeGreaterThan(1); // chord spans both shading triangles
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const p = lerpVec(e0, e1, t);
      expect(pieces.some((piece) => polygonContains(piece, p))).toBe(true);
    }
  });

  it('adjacent tiles compute the identical crossing point on their shared edge', () => {
    // Shared vertex grid: tile A at (0,0), east neighbour B at (1,0).
    // A's right/bottom corners are B's top/left corners (shared grid vertices).
    const a = ch(2, 0, 1, 2); // A: top=v00, right=v10, bottom=v11, left=v01
    const b = ch(0, 2, 2, 1); // B: top=v10, right=v20, bottom=v21, left=v11
    const ptsA = projectQuad(a, 0, 0);
    const ptsB = projectQuad(b, 1, 0);

    const polyA = contourQuadPolygons(...hs(a), LOW, 'below');
    const polyB = contourQuadPolygons(...hs(b), LOW, 'below');
    // A crosses its edge 1 (right→bottom); B crosses its edge 3 (left→top) —
    // the SAME shared edge, at the SAME height ratio → identical screen point.
    const crossA = polyA.flat().filter((v) => v.kind === 'edge' && v.a === 1 && v.b === 2);
    const crossB = polyB.flat().filter((v) => v.kind === 'edge' && v.a === 0 && v.b === 3);
    expect(crossA).toHaveLength(1);
    expect(crossB).toHaveLength(1);
    expect(resolveVertex(crossA[0], ptsA)).toEqual(resolveVertex(crossB[0], ptsB));
  });
});

describe('acceptance — flat and planar tiles produce no stroke', () => {
  it('flat tile: no fold segments and the shading plan requests no stroke', () => {
    const fixture = ch(3, 3, 3, 3);
    expect(foldContourSegments(...hs(fixture))).toEqual([]);
    expect(planDiamondShading(fixture).strokeFold).toBe(false);
    expect(foldPieces(fixture)).toEqual([]);
  });
  it('planar slope: the plan requests no stroke (renderer never calls the fold pass)', () => {
    expect(planDiamondShading(ch(2, 1, 1, 2)).strokeFold).toBe(false);
  });
  it('flat tile: no sand or rock band polygons', () => {
    expect(contourQuadPolygons(3, 3, 3, 3, LOW, 'below')).toEqual([]);
    expect(contourQuadPolygons(3, 3, 3, 3, HIGH, 'above')).toEqual([]);
  });
});
