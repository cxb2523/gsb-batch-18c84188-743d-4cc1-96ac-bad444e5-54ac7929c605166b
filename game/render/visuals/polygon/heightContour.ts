import { SEA_LEVEL } from '@/game/core/Terrain';

/**
 * Terrain at or below the waterline (SEA_LEVEL) is water; from there UP TO this
 * height renders as beach SAND. Keying the beach on a HEIGHT contour makes the
 * sand/grass boundary a constant-height line, which on a slope runs PARALLEL to
 * the coast. Tunable: "roughly half a step above the water".
 */
export const SAND_MAX_HEIGHT = SEA_LEVEL + 0.5;

/**
 * Land ABOVE this height renders as rocky highland ROCK (the high-elevation
 * counterpart to SAND). Same contour idea, mirrored: the rock/grass boundary is a
 * constant-height line parallel to the slope.
 *
 * Tunable. NOTE the procedural generator is gamma-biased LOW: although
 * MAX_ELEVATION is 8, a typical map only PEAKS around 5–6 and most land sits at
 * 1–3. So `4.5` (rock on height ≥ 5) keeps rock to the genuine PEAK CAPS rather
 * than whole rocky hillsides — sparser, only the tallest ground. Lower it toward
 * 3.5 (height ≥ 4) for broader rocky highlands; tying it to MAX_ELEVATION
 * (e.g. 5.5+) would make rock all but disappear since terrain rarely reaches there.
 */
export const ROCK_MIN_HEIGHT = 4.5;

/** Which side of a height contour to keep. */
export type ContourSide = 'below' | 'above';

/**
 * Quad corner indices in diamond boundary order: 0=top, 1=right, 2=bottom,
 * 3=left. Edge k runs from corner k to corner (k+1) mod 4.
 */
export type QuadCorner = 0 | 1 | 2 | 3;

/**
 * One vertex of a clipped sub-polygon (or one endpoint of a contour segment):
 * either an original quad CORNER `i`, or a point on the EDGE between corners
 * `a` and `b` at parameter `t` (0 at a, 1 at b) where the height contour crosses.
 *
 * Heights vary linearly along each quad edge (both endpoints are shared grid
 * vertices), so an edge crossing depends ONLY on that edge's two corner heights
 * — the neighbouring tile computes the SAME crossing on the shared edge, which
 * keeps the band boundary seamless across tiles. Crucially the crossing set is
 * derived from the four CORNER heights alone, never from the shading diagonal,
 * so the contour does not kink at the triangle split.
 */
export type QuadContourVertex =
  | { readonly kind: 'corner'; readonly i: QuadCorner }
  | { readonly kind: 'edge'; readonly a: QuadCorner; readonly b: QuadCorner; readonly t: number };

/** One straight segment of a height-contour LINE across the quad. */
export interface QuadContourSegment {
  readonly a: QuadContourVertex;
  readonly b: QuadContourVertex;
}

const next = (k: QuadCorner): QuadCorner => ((k + 1) % 4) as QuadCorner;
const prev = (k: QuadCorner): QuadCorner => ((k + 3) % 4) as QuadCorner;

/**
 * Clip the WHOLE tile quad at the height contour `threshold`, returning the
 * sub-region(s) on the `keep` side ('below' for beaches, 'above' for highland
 * rock) as a list of polygons in boundary order (marching squares on the four
 * corner heights).
 *
 * This replaces the old per-shading-triangle clip: the cut edge of each
 * returned polygon is a SINGLE straight chord between two quad-edge crossings,
 * so the band boundary is one continuous line across the tile instead of two
 * triangle-local segments kinking at the (arbitrary) shading diagonal. The
 * diagonal is still used downstream to CLIP these polygons to the two fill
 * triangles (which exactly tile the quad, even for concave projections), but
 * the boundary shape no longer depends on it.
 *
 * Returns `[]` when no corner is on the kept side; one 4-vertex polygon when
 * all are; otherwise 1–6 vertex polygons — TWO polygons in the saddle case
 * (two opposite corners kept) when the quad centre falls on the un-kept side.
 * The centre height is the bilinear centre value (mean of the four corners),
 * the standard asymptotic decider for the saddle ambiguity.
 *
 * `cross(a,b)` is only ever called with corners `a` and `b` on OPPOSITE sides
 * of `threshold`, so the sign of `(threshold - h[a])` and `(h[b] - h[a])`
 * always agree, giving `t` in (0, 1) with no divide-by-zero, for BOTH sides.
 * A corner exactly AT the threshold counts as not-kept (strict comparison),
 * matching the waterline convention.
 */
export function contourQuadPolygons(
  hTop: number,
  hRight: number,
  hBottom: number,
  hLeft: number,
  threshold: number,
  keep: ContourSide,
): QuadContourVertex[][] {
  const h = [hTop, hRight, hBottom, hLeft] as const;
  const inSide = h.map((v) => (keep === 'below' ? v < threshold : v > threshold));
  const count = inSide.filter(Boolean).length;

  const corner = (i: QuadCorner): QuadContourVertex => ({ kind: 'corner', i });

  if (count === 0) return [];
  if (count === 4) return [[corner(0), corner(1), corner(2), corner(3)]];

  const cross = (a: QuadCorner, b: QuadCorner): QuadContourVertex => ({
    kind: 'edge',
    a,
    b,
    t: (threshold - h[a]) / (h[b] - h[a]),
  });

  if (count === 1) {
    // A single kept corner → a wedge at that corner. On a point-contact tile
    // (the contour dips past one corner only) the wedge fills what would
    // otherwise be a gap in the band at that corner.
    const k = inSide.indexOf(true) as QuadCorner;
    return [[corner(k), cross(k, next(k)), cross(k, prev(k))]];
  }

  if (count === 3) {
    // One corner outside (m) → pentagon: the three kept corners in boundary
    // order plus the two crossings on the edges incident to m.
    const m = inSide.indexOf(false) as QuadCorner;
    const n1 = next(m);
    const n2 = next(n1);
    const n3 = prev(m);
    return [[corner(n1), corner(n2), corner(n3), cross(n3, m), cross(m, n1)]];
  }

  // count === 2.
  const kept = ([0, 1, 2, 3] as QuadCorner[]).filter((i) => inSide[i]);
  const [i, j] = kept;

  if (next(i) === j) {
    // Adjacent kept corners i → j → quad with two crossings.
    return [[corner(i), corner(j), cross(j, next(j)), cross(prev(i), i)]];
  }
  if (next(j) === i) {
    // Adjacent across the index wrap (corners 3 and 0).
    return [[corner(j), corner(i), cross(i, next(i)), cross(prev(j), j)]];
  }

  // Opposite kept corners (saddle). The contour either splits the kept region
  // into two corner wedges or leaves one connected band through the middle;
  // decide by which side the quad CENTRE (bilinear centre height = mean) is on.
  const center = (h[0] + h[1] + h[2] + h[3]) / 4;
  const centerIn = keep === 'below' ? center < threshold : center > threshold;
  if (centerIn) {
    const n1 = next(i); // == prev(j)
    const n3 = prev(i); // == next(j)
    return [[corner(i), cross(i, n1), cross(n1, j), corner(j), cross(j, n3), cross(n3, i)]];
  }
  return [
    [corner(i), cross(i, next(i)), cross(i, prev(i))],
    [corner(j), cross(j, next(j)), cross(j, prev(j))],
  ];
}

/**
 * The tile's FOLD line as a height contour: the segment(s) along which the
 * bilinear surface crosses its own mean height — the "waterline" of the tile's
 * mid-elevation. For a non-planar quad (the only case the renderer strokes,
 * gated by `planDiamondShading(...).strokeFold`) this is where the surface
 * visibly twists: a tent (one corner raised) gets a short contour hugging the
 * bump, a diagonal drop gets one hugging the dipped corner, and a saddle gets
 * two segments around the two high corners. Because the line is a LEVEL SET of
 * the surface it reads as a slope-following contour, not a hard crease — and
 * it is computed from the four corner heights alone, independent of which
 * diagonal the shading split chose.
 *
 * Returns 0, 1, or 2 segments. Flat tiles (all corners equal) return [] — no
 * crossing exists. Planar slopes also have a mid-height contour, but the
 * renderer only calls this for non-planar quads (strokeFold), so planar tiles
 * keep their no-stroke look.
 *
 * Degenerate rules (measure-zero, deterministic): a corner exactly AT the mean
 * counts as not-below; a crossing landing exactly on a corner is emitted once
 * as a 'corner' vertex; an isolated tangent touch (a lone corner point among
 * three crossings) is dropped so the remaining two crossings still connect.
 */
export function foldContourSegments(
  hTop: number,
  hRight: number,
  hBottom: number,
  hLeft: number,
): QuadContourSegment[] {
  const h = [hTop, hRight, hBottom, hLeft] as const;
  const level = (h[0] + h[1] + h[2] + h[3]) / 4;
  const below = h.map((v) => v < level);

  // Collect contour crossings on the four edges. Edge k runs corner k → k+1;
  // it crosses iff exactly one endpoint is strictly below the level. A crossing
  // with t === 0/1 sits exactly ON a corner and is canonicalised to a 'corner'
  // vertex so the same point produced by two adjacent edges dedupes to one.
  const crossings: { edge: QuadCorner; vertex: QuadContourVertex }[] = [];
  for (let k = 0 as QuadCorner; k < 4; k = (k + 1) as QuadCorner) {
    const j = next(k);
    if (below[k] === below[j]) continue;
    const t = (level - h[k]) / (h[j] - h[k]);
    if (t === 0) {
      crossings.push({ edge: k, vertex: { kind: 'corner', i: k } });
    } else if (t === 1) {
      crossings.push({ edge: k, vertex: { kind: 'corner', i: j } });
    } else {
      crossings.push({ edge: k, vertex: { kind: 'edge', a: k, b: j, t } });
    }
  }

  const points: QuadContourVertex[] = [];
  const cornerSeen = new Set<QuadCorner>();
  for (const c of crossings) {
    if (c.vertex.kind === 'corner') {
      if (cornerSeen.has(c.vertex.i)) continue;
      cornerSeen.add(c.vertex.i);
    }
    points.push(c.vertex);
  }

  if (points.length === 2) {
    return [{ a: points[0], b: points[1] }];
  }

  if (points.length === 4) {
    // Saddle: below/above alternate around the quad, so all four crossings are
    // edge-interior points. Pair the two crossings incident to each strictly
    // ABOVE-level corner — each pair is the contour arc around that corner's
    // lobe of the surface.
    const segments: QuadContourSegment[] = [];
    for (let k = 0 as QuadCorner; k < 4; k = (k + 1) as QuadCorner) {
      if (h[k] <= level) continue;
      const incoming = crossings.find((c) => c.edge === prev(k));
      const outgoing = crossings.find((c) => c.edge === k);
      if (incoming && outgoing) {
        segments.push({ a: incoming.vertex, b: outgoing.vertex });
      }
    }
    return segments;
  }

  if (points.length === 3) {
    // A corner exactly at the level contributed an isolated tangent touch;
    // drop corner points and connect the two genuine edge crossings.
    const edgePoints = points.filter((p) => p.kind === 'edge');
    if (edgePoints.length === 2) return [{ a: edgePoints[0], b: edgePoints[1] }];
  }

  return [];
}
