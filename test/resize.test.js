/**
 * Standalone tests for the resize / relayout behavior of `Attractors`.
 *
 * Runs in plain Node, with no browser and no dependency on the `node --check`
 * npm script:
 *
 *   node --test "test/*.test.js"
 *
 * The DOM surface used by the class (canvas, 2D context, requestAnimationFrame)
 * is stubbed below.
 */
import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

// Stub the browser globals before importing the module. DEFAULT_CONFIG reads
// `devicePixelRatio` once, at module load time.
globalThis.devicePixelRatio = 1;
// The render loop reschedules itself every frame: keep the most recently scheduled
// callback, so calling renderFrame() twice really renders two distinct frames.
let frameCallback = null;
globalThis.requestAnimationFrame = (callback) => {
  frameCallback = callback;
  return 1;
};
globalThis.cancelAnimationFrame = () => {};

const noop = () => {};
const ctxStub = {
  beginPath: noop,
  moveTo: noop,
  lineTo: noop,
  stroke: noop,
  arc: noop,
  fill: noop,
  fillRect: noop,
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0,
  globalAlpha: 1,
};

let currentCanvas = null;
globalThis.document = {
  getElementById: () => currentCanvas,
};

const { Attractors } = await import('../attractors.js');

function makeCanvas(screenWidth, screenHeight) {
  return {
    clientWidth: screenWidth,
    clientHeight: screenHeight,
    width: 0,
    height: 0,
    getContext: () => ctxStub,
  };
}

/**
 * Renders one frame by driving the stored requestAnimationFrame callback.
 * Timestamps advance by a reference frame (~16.67ms) on every call, as real
 * requestAnimationFrame timestamps do, so each call is a distinct frame.
 */
let frameTimestamp = 0;
function renderFrame() {
  assert.ok(frameCallback, 'start() must schedule a frame');
  frameTimestamp += 1000 / 60;
  frameCallback(frameTimestamp);
}

/** Extracts every `(x, y)` coordinate from an SVG document. */
function svgCoordinates(svg) {
  const coordinates = [];
  for (const match of svg.matchAll(/L(-?[\d.e+-]+) (-?[\d.e+-]+)/g)) {
    coordinates.push([parseFloat(match[1]), parseFloat(match[2])]);
  }
  return coordinates;
}

function makeAttractors(overrides = {}, screen = { width: 1000, height: 800 }) {
  currentCanvas = makeCanvas(screen.width, screen.height);
  const attractors = new Attractors({
    id: 'paint-canvas',
    svg: true,
    text: '',
    particule_density: 100,
    nb_attractors: 5,
    ...overrides,
  });
  return { attractors, canvas: currentCanvas };
}

beforeEach(() => {
  frameCallback = null;
  frameTimestamp = 0;
});

describe('Attractors resize', () => {
  test('first start() seeds particles from the density, unchanged behavior', async () => {
    // density 100 on a 1000 * 800 screen: floor(100 * 800000 / 1e6) = 80 particles.
    const { attractors } = makeAttractors();
    await attractors.start();
    renderFrame();

    // toSVG emits one path per particle except the last one (pre-existing behavior).
    const svg = attractors.toSVG();
    const pathCount = (svg.match(/<path/g) || []).length;
    assert.equal(pathCount, 80 - 1);
  });

  test('resize() with unchanged dimensions is a no-op', async () => {
    const { attractors } = makeAttractors();
    await attractors.start();
    renderFrame();
    renderFrame();
    const before = attractors.toSVG();

    attractors.resize();

    assert.equal(attractors.toSVG(), before);
  });

  test('resize() maps particle coordinates proportionally to the new size', async () => {
    // speed 0 keeps the particles still, so the mapping can be checked exactly.
    const { attractors, canvas } = makeAttractors({ speed: 0 });
    await attractors.start();
    renderFrame();
    renderFrame();
    const before = svgCoordinates(attractors.toSVG());
    assert.ok(before.length > 0);

    canvas.clientWidth = 500;
    canvas.clientHeight = 400;
    attractors.resize();

    const svg = attractors.toSVG();
    assert.match(svg, /viewBox='0 0 500 400'/);
    assert.match(svg, /width='500' height='400'/);
    assert.equal(canvas.width, 500);
    assert.equal(canvas.height, 400);

    // The density follows the new size (80 particles on 1000*800, 20 on 500*400).
    // toSVG emits one path per particle except the last one.
    const after = svgCoordinates(svg);
    assert.equal(after.length, 20 - 1);
    for (let i = 0; i < after.length; i++) {
      assert.ok(after[i][0] >= 0 && after[i][0] <= 500, `x in bounds: ${after[i][0]}`);
      assert.ok(after[i][1] >= 0 && after[i][1] <= 400, `y in bounds: ${after[i][1]}`);
      // Each surviving particle keeps its relative position, mapped by the 0.5 ratios.
      assert.ok(Math.abs(after[i][0] - before[i][0] * 0.5) < 1e-9);
      assert.ok(Math.abs(after[i][1] - before[i][1] * 0.5) < 1e-9);
    }
  });

  test('pixel ratio changes go through the same relayout path', async () => {
    const { attractors, canvas } = makeAttractors({ speed: 0 });
    await attractors.start();
    renderFrame();
    renderFrame();
    const before = svgCoordinates(attractors.toSVG());

    // Same CSS size, twice the pixel ratio: the device-pixel canvas doubles, but the
    // CSS size is unchanged, so the particle count (density) stays the same. resize()
    // preserves and transforms every particle entry, so all 80 carry a coordinate.
    attractors.config.pixelratio = 2;
    attractors.resize();

    const svg = attractors.toSVG();
    assert.match(svg, /viewBox='0 0 2000 1600'/);
    assert.equal(canvas.width, 2000);
    assert.equal(canvas.height, 1600);

    const after = svgCoordinates(svg);
    assert.equal(after.length, 80);
    for (let i = 0; i < before.length; i++) {
      assert.ok(after[i][0] >= 0 && after[i][0] <= 2000);
      assert.ok(after[i][1] >= 0 && after[i][1] <= 1600);
      assert.ok(Math.abs(after[i][0] - before[i][0] * 2) < 1e-9);
      assert.ok(Math.abs(after[i][1] - before[i][1] * 2) < 1e-9);
    }
  });

  test('a relayout does not write any frame, and the next frame is written once', async () => {
    const { attractors, canvas } = makeAttractors({ speed: 0 });
    await attractors.start();
    renderFrame();
    renderFrame();
    const countL = (svg) => (svg.match(/L/g) || []).length;
    // Shrinking to 500 * 400 yields 20 particles, i.e. 19 emitted paths, each holding
    // the single segment recorded so far.
    const expectedEmittedPaths = 20 - 1;
    assert.equal(countL(attractors.toSVG()), 79);

    canvas.clientWidth = 500;
    canvas.clientHeight = 400;
    attractors.resize();

    // The relayout only transforms existing coordinates: no new segment is recorded.
    const recordedAtRelayout = countL(attractors.toSVG());
    assert.equal(recordedAtRelayout, expectedEmittedPaths);

    renderFrame();

    // Exactly one more segment per emitted particle path, not two.
    assert.equal(
      countL(attractors.toSVG()),
      recordedAtRelayout + expectedEmittedPaths,
    );
  });

  test('particles re-spread after a resize stay outside the no go zone', async () => {
    const { attractors, canvas } = makeAttractors({
      speed: 0,
      nogo_zone: true,
      // Left half of the 1000 * 800 canvas, in CSS pixels.
      nogoParam: { x: 0, y: 0, width: 500, height: 800 },
    });
    await attractors.start();
    renderFrame();
    renderFrame();

    // Shrink the canvas: the no go box becomes 0..250 x 0..200 in device pixels.
    canvas.clientWidth = 500;
    canvas.clientHeight = 400;
    attractors.resize();
    renderFrame();
    renderFrame();

    // The stored box is slightly inset from the nominal rectangle (bezier
    // subdivision), so check with a margin that stays inside it.
    for (const [x, y] of svgCoordinates(attractors.toSVG())) {
      const insideBox = x > 2 && x < 248 && y > 2 && y < 198;
      assert.ok(!insideBox, `particle (${x}, ${y}) landed in the no go zone`);
      assert.ok(x >= 0 && x <= 500 && y >= 0 && y <= 400);
    }
  });

  test('resize() works when SVG recording is disabled', async () => {
    const { attractors, canvas } = makeAttractors({ svg: false });
    await attractors.start();
    renderFrame();

    canvas.clientWidth = 500;
    canvas.clientHeight = 400;
    assert.doesNotThrow(() => attractors.resize());
    assert.equal(canvas.width, 500);
    assert.equal(canvas.height, 400);

    // The animation keeps running and rendering frames without throwing.
    assert.doesNotThrow(() => renderFrame());
  });

  test('growing the canvas adds particles seeded for the new size', async () => {
    const { attractors, canvas } = makeAttractors({ speed: 0 });
    await attractors.start();
    renderFrame();
    renderFrame();
    assert.equal(svgCoordinates(attractors.toSVG()).length, 79);

    // 2000 * 1600 at density 100: floor(100 * 3.2e6 / 1e6) = 320 particles.
    canvas.clientWidth = 2000;
    canvas.clientHeight = 1600;
    attractors.resize();

    // All 80 previous particles are preserved with transformed coordinates; the extra
    // particles needed for the new size are seeded empty and only gain a coordinate
    // once a frame records their position.
    assert.equal(svgCoordinates(attractors.toSVG()).length, 80);
    renderFrame();
    renderFrame();

    // toSVG emits one <path> per particle except the last one: 320 - 1 = 319.
    const svg = attractors.toSVG();
    assert.equal((svg.match(/<path/g) || []).length, 319);
    // Every recorded coordinate, across old (multi-segment) and new particles,
    // stays within the new width and height.
    for (const [x, y] of svgCoordinates(svg)) {
      assert.ok(x >= 0 && x <= 2000 && y >= 0 && y <= 1600);
    }
  });
});
