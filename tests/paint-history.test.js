import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/register.mjs';

import { PaintStrokeCommand } from '../js/commands/PaintStrokeCommand.js';
import { ProjectionPainter } from '../js/texture/ProjectionPainter.js';
import {
  syncPainterPixels,
  syncProjectionCache,
  refreshPreviewMaterial,
} from '../js/texture/PaintHistorySync.js';
import {
  FakeCanvas,
  FakeTexture,
  FakeMaterial,
  canvasImageData,
  cloneImageData,
  solidImageData,
  imageDataWithFirstPixel,
  pixelsEqual,
  pixelAt,
  makeTexturePainterStub,
  makeEditor,
} from './helpers/fakes.js';

const W = 4;
const H = 4;

// Distinct solid colours so every state is visually distinguishable.
const BASE = [220, 220, 220, 255]; // default base colour canvas
const BEFORE = [10, 20, 30, 255]; // pixels before the stroke
const AFTER = [200, 100, 50, 255]; // pixels after the stroke
const STALE = [0, 255, 0, 255]; // marker for an out-of-date painter cache
const OTHER = [7, 7, 7, 255]; // pixels belonging to a different paint map

/**
 * Build a full active paint-session fixture for one paint map:
 * object + original/preview materials + map entry + projection painter whose
 * cache deliberately starts out stale.
 */
async function buildActiveFixture(paintMap = 'map', { size = { w: W, h: H } } = {}) {
  const { w, h } = size;
  const before = solidImageData(w, h, BEFORE);
  const canvas = new FakeCanvas(before);
  const texture = new FakeTexture(canvas);

  const originalMaterial = new FakeMaterial({ [paintMap]: texture });
  const previewMaterial = new FakeMaterial({ map: texture });
  const object = {
    uuid: 'mesh-1',
    material: previewMaterial, // preview material is what is displayed
  };

  // Projection painter bound to this map's canvas, holding a stale cache.
  const projectionPainter = new ProjectionPainter();
  projectionPainter.canvas = canvas;
  projectionPainter.ctx = canvas.ctx;
  projectionPainter.imageData = solidImageData(w, h, STALE);

  const maps = {
    [paintMap]: { paintCanvas: canvas, paintCtx: canvas.ctx, texture },
  };

  const texturePainter = await makeTexturePainterStub({
    object,
    maps,
    projectionPainter,
    isActive: true,
    originalMaterial,
  });

  const editor = makeEditor(object, texturePainter);

  return {
    editor,
    object,
    texturePainter,
    projectionPainter,
    canvas,
    texture,
    originalMaterial,
    previewMaterial,
    before,
    after: solidImageData(w, h, AFTER),
  };
}

describe('PaintStrokeCommand undo/redo during an active paint session', () => {
  let fx;

  beforeEach(async () => {
    fx = await buildActiveFixture('map');
  });

  test('undo restores canvas, projection cache and preview material together', () => {
    const { editor, object, canvas, texture, projectionPainter, previewMaterial, before, after } = fx;
    const cmd = new PaintStrokeCommand(editor, object, 'map', before, after);

    // Redo / first application: "after" pixels land everywhere.
    cmd.execute();
    assert.ok(pixelsEqual(canvasImageData(canvas), after), 'canvas shows after-state');
    assert.ok(
      pixelsEqual(projectionPainter.imageData, after),
      'projection cache follows the after-state so the next dab blends correctly'
    );
    assert.equal(texture.needsUpdate, true);
    assert.equal(previewMaterial.needsUpdate, true);

    // Undo: every layer must return to the "before" pixels.
    texture.needsUpdate = false;
    previewMaterial.needsUpdate = false;
    projectionPainter.imageData = solidImageData(W, H, STALE); // simulate stale cache again

    cmd.undo();
    assert.ok(pixelsEqual(canvasImageData(canvas), before), 'canvas is rolled back');
    assert.ok(
      pixelsEqual(projectionPainter.imageData, before),
      'projection cache is rolled back, not left on old pixels'
    );
    assert.equal(texture.needsUpdate, true, 'texture is marked for GPU re-upload');
    assert.equal(previewMaterial.needsUpdate, true, 'displayed preview material is refreshed');
    assert.equal(editor.signals.objectChanged.dispatched, 2);
  });

  test('cache holds an independent copy, so later strokes never mutate history pixels', () => {
    const { editor, object, projectionPainter, before, after } = fx;
    const cmd = new PaintStrokeCommand(editor, object, 'map', before, after);

    cmd.execute();

    // Mutate the live cache the way a brush dab would.
    projectionPainter.imageData.data[0] = 99;

    assert.equal(
      after.data[0],
      AFTER[0],
      'the stored after-ImageData must not alias the projection cache'
    );
    assert.equal(before.data[0], BEFORE[0]);
  });

  test('a subsequent brush dab blends against the undone (restored) pixels', () => {
    const { editor, object, projectionPainter, before, after } = fx;
    const cmd = new PaintStrokeCommand(editor, object, 'map', before, after);

    cmd.execute();
    cmd.undo();

    // PaintTool.applyTexel reads dst colour straight from the projection cache.
    const dst = pixelAt(projectionPainter.imageData, 0);
    assert.deepEqual(dst, BEFORE, 'the dab samples the restored pre-stroke pixel');
  });

  test('undo followed by redo round-trips both canvas and cache', () => {
    const { editor, object, canvas, projectionPainter, before, after } = fx;
    const cmd = new PaintStrokeCommand(editor, object, 'map', before, after);

    cmd.execute();
    cmd.undo();
    cmd.execute();

    assert.ok(pixelsEqual(canvasImageData(canvas), after));
    assert.ok(pixelsEqual(projectionPainter.imageData, after));

    cmd.undo();
    assert.ok(pixelsEqual(canvasImageData(canvas), before));
    assert.ok(pixelsEqual(projectionPainter.imageData, before));
  });
});

describe('paint-map switching isolates undo/redo to the affected map', () => {
  test('undo of a base-color stroke never touches the metalness map canvas or cache', async () => {
    const mapFx = await buildActiveFixture('map');

    // Add a second paint map (metalness) with its own canvas, texture and a
    // projection cache that will be bound once the user switches to it.
    const metalBefore = solidImageData(W, H, [0, 0, 0, 255]);
    const metalCanvas = new FakeCanvas(metalBefore);
    const metalTexture = new FakeTexture(metalCanvas);
    const metalCache = solidImageData(W, H, OTHER);

    mapFx.texturePainter._maps.metalnessMap = {
      paintCanvas: metalCanvas,
      paintCtx: metalCanvas.ctx,
      texture: metalTexture,
    };

    // Projection painter is currently bound to the metalness canvas, i.e. the
    // user switched maps after painting the base-color stroke.
    mapFx.projectionPainter.canvas = metalCanvas;
    mapFx.projectionPainter.ctx = metalCanvas.ctx;
    mapFx.projectionPainter.imageData = cloneImageData(metalCache);

    const cmd = new PaintStrokeCommand(
      mapFx.editor,
      mapFx.object,
      'map',
      mapFx.before,
      mapFx.after
    );
    cmd.undo();

    // Base color map is restored on its own canvas...
    assert.ok(pixelsEqual(canvasImageData(mapFx.canvas), mapFx.before));
    // ...while the metalness canvas and the cache bound to it are untouched.
    assert.ok(pixelsEqual(canvasImageData(metalCanvas), metalBefore));
    assert.ok(
      pixelsEqual(mapFx.projectionPainter.imageData, metalCache),
      'the active (metalness) cache must not be overwritten by a base-color undo'
    );
    assert.equal(metalTexture.needsUpdate, false);
  });

  test('after switching back to the undone map, its cache is reloaded from the restored canvas', () => {
    // setPaintCanvas mirrors TexturePainter._switchPaintMap rebinding the
    // projection painter to the selected map's canvas.
    const painter = new ProjectionPainter();
    const canvas = new FakeCanvas(solidImageData(W, H, BEFORE));
    painter.setPaintCanvas(canvas);
    assert.deepEqual(pixelAt(painter.imageData, 0), BEFORE);

    // Undo rewrites the canvas pixels directly; the same-canvas cache is then
    // refreshed through the history sync hook.
    const restored = solidImageData(W, H, [9, 8, 7, 255]);
    canvas.ctx.putImageData(restored);
    assert.equal(painter.syncImageData(canvas, restored), true);
    assert.ok(pixelsEqual(painter.imageData, restored));
    assert.ok(pixelsEqual(canvasImageData(canvas), restored));
  });

  test('each map keeps independent history commands and caches', async () => {
    const mapFx = await buildActiveFixture('map');
    const roughBefore = solidImageData(W, H, [128, 128, 128, 255]);
    const roughAfter = imageDataWithFirstPixel(W, H, [255, 255, 255, 255], [128, 128, 128, 255]);
    const roughCanvas = new FakeCanvas(roughBefore);
    const roughTexture = new FakeTexture(roughCanvas);

    // The command resolves the active session's original material, so the
    // roughness texture must live there as well as in the painter map table.
    mapFx.originalMaterial.roughnessMap = roughTexture;
    mapFx.texturePainter._maps.roughnessMap = {
      paintCanvas: roughCanvas,
      paintCtx: roughCanvas.ctx,
      texture: roughTexture,
    };

    const roughnessCmd = new PaintStrokeCommand(
      mapFx.editor,
      mapFx.object,
      'roughnessMap',
      roughBefore,
      roughAfter
    );
    roughnessCmd.execute();
    // Painter is still bound to the base-color canvas: roughness canvas changes,
    // but the base-color projection cache must not be touched.
    assert.ok(pixelsEqual(canvasImageData(roughCanvas), roughAfter));
    assert.deepEqual(
      pixelAt(mapFx.projectionPainter.imageData, 0),
      STALE,
      'base-color cache stays stale: a roughness stroke never writes another map cache'
    );
    assert.equal(
      mapFx.projectionPainter.canvas,
      mapFx.canvas,
      'projection painter remains bound to the base-color canvas'
    );

    roughnessCmd.undo();
    assert.ok(pixelsEqual(canvasImageData(roughCanvas), roughBefore));
    assert.deepEqual(pixelAt(canvasImageData(roughCanvas), 0), [128, 128, 128, 255]);
  });
});

describe('negative paths skip safely without throwing', () => {
  test('dimension mismatch: canvas is left untouched, no cache write, no throw', async () => {
    const fx = await buildActiveFixture('map');
    const originalCanvas = canvasImageData(fx.canvas);
    const cacheBeforeMismatch = cloneImageData(fx.projectionPainter.imageData);
    // Both history snapshots differ from the live canvas dimensions.
    const wrongBefore = solidImageData(W * 2, H, BEFORE);
    const wrongAfter = solidImageData(W * 2, H, AFTER);

    const cmd = new PaintStrokeCommand(fx.editor, fx.object, 'map', wrongBefore, wrongAfter);

    assert.doesNotThrow(() => cmd.execute());
    assert.doesNotThrow(() => cmd.undo());
    assert.ok(pixelsEqual(canvasImageData(fx.canvas), originalCanvas));
    assert.ok(
      pixelsEqual(fx.projectionPainter.imageData, cacheBeforeMismatch),
      'mismatched history pixels must never replace the projection cache'
    );
    assert.equal(fx.texture.needsUpdate, false);
  });

  test('object no longer exists: command resolves nothing and returns quietly', () => {
    const editor = makeEditor(null, null);
    const before = solidImageData(W, H, BEFORE);
    const after = solidImageData(W, H, AFTER);
    const cmd = new PaintStrokeCommand(editor, { uuid: 'gone' }, 'map', before, after);

    assert.doesNotThrow(() => cmd.undo());
    assert.doesNotThrow(() => cmd.execute());
    assert.equal(editor.signals.objectChanged.dispatched, 0);
  });

  test('paint session inactive: canvas still updates but painter caches are not touched', async () => {
    const before = solidImageData(W, H, BEFORE);
    const canvas = new FakeCanvas(before);
    const texture = new FakeTexture(canvas);
    const material = new FakeMaterial({ map: texture });
    const object = { uuid: 'mesh-2', material };

    // Inactive painter: the command falls back to object.material.
    const texturePainter = await makeTexturePainterStub({
      object,
      maps: { map: { paintCanvas: canvas, texture } },
      projectionPainter: { canvas, imageData: solidImageData(W, H, STALE) },
      isActive: false,
    });
    const editor = makeEditor(object, texturePainter);

    const cmd = new PaintStrokeCommand(editor, object, 'map', before, solidImageData(W, H, AFTER));
    assert.doesNotThrow(() => cmd.undo());
    assert.ok(pixelsEqual(canvasImageData(canvas), before), 'inactive path still restores pixels');
    assert.deepEqual(
      pixelAt(texturePainter.projectionPainter.imageData, 0),
      STALE,
      'inactive session must not reach into painter caches'
    );
  });

  test('painter bound to a different object: no cache or preview mutation', async () => {
    const fx = await buildActiveFixture('map');
    fx.texturePainter.object = { uuid: 'some-other-mesh' };

    const cmd = new PaintStrokeCommand(fx.editor, fx.object, 'map', fx.before, fx.after);
    assert.doesNotThrow(() => cmd.undo());

    // Canvas/texture still updated via the object's own material fallback...
    assert.ok(pixelsEqual(canvasImageData(fx.canvas), fx.before));
    // ...but the painter (bound elsewhere) is untouched.
    assert.deepEqual(pixelAt(fx.projectionPainter.imageData, 0), STALE);
    assert.equal(fx.previewMaterial.needsUpdate, false);
  });

  test('missing map entry and missing projection painter are tolerated', async () => {
    const before = solidImageData(W, H, BEFORE);
    const canvas = new FakeCanvas(before);
    const texture = new FakeTexture(canvas);
    const originalMaterial = new FakeMaterial({ map: texture });
    const previewMaterial = new FakeMaterial({ map: texture });
    const object = { uuid: 'mesh-3', material: previewMaterial };

    const texturePainter = await makeTexturePainterStub({
      object,
      maps: {}, // no entry for 'map'
      projectionPainter: null,
      isActive: true,
    });
    texturePainter.originalMaterial = originalMaterial;
    const editor = makeEditor(object, texturePainter);

    const cmd = new PaintStrokeCommand(editor, object, 'map', before, solidImageData(W, H, AFTER));
    assert.doesNotThrow(() => cmd.execute());
    // Canvas update happened through the material lookup; the sync hook simply
    // had nothing of its own to update.
    assert.ok(pixelsEqual(canvasImageData(canvas), solidImageData(W, H, AFTER)));
  });

  test('null history ImageData is a safe no-op', async () => {
    const fx = await buildActiveFixture('map');
    const cmd = new PaintStrokeCommand(fx.editor, fx.object, 'map', null, null);
    assert.doesNotThrow(() => cmd.undo());
    assert.doesNotThrow(() => cmd.execute());
    assert.equal(fx.editor.signals.objectChanged.dispatched, 0);
  });
});

describe('fill tool keeps the projection cache live (no undo needed)', () => {
  test('syncImageData after a fill makes subsequent dabs read filled pixels', () => {
    // Mirrors TexturePainter._runFill: fill writes a fresh ImageData straight
    // to the paint canvas, then the projection cache must be re-synced.
    const canvas = new FakeCanvas(solidImageData(W, H, BEFORE));
    const painter = new ProjectionPainter();
    painter.setPaintCanvas(canvas);

    const filled = solidImageData(W, H, AFTER);
    canvas.ctx.putImageData(filled);

    // Before the fix this call did not exist: the cache still held BEFORE.
    assert.equal(painter.syncImageData(canvas, filled), true);
    assert.ok(
      pixelsEqual(painter.imageData, filled),
      'the cache used for colour picking/blending now matches the filled canvas'
    );

    // A brush dab's PaintTool.applyTexel reads dst from this cache: prove it
    // samples the new fill colour rather than the pre-fill pixel.
    assert.deepEqual(pixelAt(painter.imageData, 0), AFTER);
  });
});

describe('PaintHistorySync helpers', () => {
  test('syncProjectionCache ignores a foreign canvas (other paint map)', () => {
    const canvasA = new FakeCanvas(solidImageData(W, H, BEFORE));
    const canvasB = new FakeCanvas(solidImageData(W, H, OTHER));
    const painter = new ProjectionPainter();
    painter.setPaintCanvas(canvasA);
    const before = cloneImageData(painter.imageData);

    const result = syncProjectionCache(painter, canvasB, solidImageData(W, H, AFTER));
    assert.equal(result, false);
    assert.ok(pixelsEqual(painter.imageData, before));
  });

  test('syncProjectionCache rejects mismatched dimensions', () => {
    const canvas = new FakeCanvas(solidImageData(W, H, BEFORE));
    const painter = new ProjectionPainter();
    painter.setPaintCanvas(canvas);

    assert.equal(
      syncProjectionCache(painter, canvas, solidImageData(W * 2, H, AFTER)),
      false
    );
    assert.deepEqual(pixelAt(painter.imageData, 0), BEFORE);
  });

  test('syncPainterPixels refreshes the preview material only when it shows the texture', async () => {
    const canvas = new FakeCanvas(solidImageData(W, H, BEFORE));
    const texture = new FakeTexture(canvas);
    const preview = new FakeMaterial({ map: texture });
    const object = { uuid: 'm', material: preview };
    const painter = await makeTexturePainterStub({
      object,
      maps: { map: { paintCanvas: canvas, texture } },
      projectionPainter: null,
      isActive: true,
    });

    const image = solidImageData(W, H, AFTER);
    assert.equal(syncPainterPixels(painter, object, 'map', image), true);
    assert.equal(preview.needsUpdate, true);

    // Preview is showing a different texture now => no refresh, still safe.
    preview.map = new FakeTexture(new FakeCanvas(solidImageData(W, H, OTHER)));
    preview.needsUpdate = false;
    assert.equal(syncPainterPixels(painter, object, 'map', image), false);
    assert.equal(preview.needsUpdate, false);
  });

  test('refreshPreviewMaterial tolerates null inputs', () => {
    assert.equal(refreshPreviewMaterial(null, {}), false);
    assert.equal(refreshPreviewMaterial({}, null), false);
  });
});
