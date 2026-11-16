import {
  Camera,
  DOT_GRID_MIN_SCREEN_SPACING,
  DOT_GRID_SPACING,
  dotGridPositions,
  dotGridWorldSpacing,
} from "./geometry";

/** Default color of the dots. */
export const DOT_GRID_COLOR = "#d7dbe3";

/** Default radius of each dot, in canvas pixels. */
export const DOT_GRID_RADIUS = 1;

/**
 * Options for the dotted background.
 */
export interface DottedBackgroundOptions {
  /** Color of the dots. */
  color?: string;
  /** Radius of each dot, in pixels. */
  radius?: number;
  /** Spacing between two dots, in world units. */
  spacing?: number;
  /** Minimum on-screen spacing before the grid gets sparser (see geometry). */
  minScreenSpacing?: number;
}

/**
 * Draw a dotted grid background on the canvas.
 *
 * Only the dots that are actually visible are drawn, and they are batched into
 * a single `Path2D` so the whole grid is painted with one `fill()` call. This
 * keeps the cost low and bounded even during pan/zoom interactions.
 *
 * The lattice is anchored on world coordinates (multiples of the resolved world
 * spacing), never on the canvas' top-left corner: the dots therefore pan and
 * zoom with the content, and an off-screen render of a region shows the exact
 * same dots, at the same world positions, as the on-screen one.
 *
 * @param ctx The 2D canvas rendering context to draw on.
 * @param camera The current camera (pan/offset/zoom).
 * @param width The canvas width, in pixels.
 * @param height The canvas height, in pixels.
 * @param options The dotted background options.
 */
export const drawDottedBackground = (
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  options: DottedBackgroundOptions = {}
): void => {
  const color = options.color ?? DOT_GRID_COLOR;
  const radius = options.radius ?? DOT_GRID_RADIUS;
  const spacing = options.spacing ?? DOT_GRID_SPACING;
  const minScreenSpacing =
    options.minScreenSpacing ?? DOT_GRID_MIN_SCREEN_SPACING;

  const points = dotGridPositions(camera, {
    width,
    height,
    spacing,
    minScreenSpacing,
  });
  if (points.length === 0) {
    return;
  }

  // Batch every dot into a single path so we only issue one fill call.
  const TWO_PI = Math.PI * 2;
  const path = new Path2D();
  for (const { x, y } of points) {
    // `moveTo` before each arc prevents connecting lines between the dots.
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, TWO_PI);
  }

  ctx.save();
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
};

/**
 * Paint the dotted background of a whole scene onto an export canvas.
 *
 * Unlike {@link drawDottedBackground}, which paints the screen's own viewport,
 * this draws the grid with the world spacing that is in effect for the
 * on-screen camera (`sourceCamera`) while using the export canvas' own camera
 * to position it. The dots therefore land on the same world lattice as the ones
 * next to the exported content on screen, even though the export is rendered at
 * a different scale and with a different origin.
 *
 * @param ctx The export canvas' rendering context.
 * @param exportCamera The camera mapping world coordinates to export pixels.
 * @param sourceCamera The on-screen camera the content was picked from.
 * @param width The export canvas width, in pixels.
 * @param height The export canvas height, in pixels.
 * @param options The dotted background options.
 */
export const drawDottedBackgroundForExport = (
  ctx: CanvasRenderingContext2D,
  exportCamera: Camera,
  sourceCamera: Camera,
  width: number,
  height: number,
  options: DottedBackgroundOptions = {}
): void => {
  const spacing = options.spacing ?? DOT_GRID_SPACING;
  const minScreenSpacing =
    options.minScreenSpacing ?? DOT_GRID_MIN_SCREEN_SPACING;

  // Resolve the world spacing as seen on screen, then keep that exact world
  // spacing for the export: it is a property of the scene, not of the canvas.
  const worldSpacing = dotGridWorldSpacing(
    spacing,
    sourceCamera.zoom,
    minScreenSpacing
  );
  if (worldSpacing <= 0) {
    return;
  }

  drawDottedBackground(ctx, exportCamera, width, height, {
    ...options,
    spacing: worldSpacing,
    // The spacing is already resolved for the on-screen zoom; do not let the
    // export zoom adapt it again.
    minScreenSpacing: 0,
  });
};
