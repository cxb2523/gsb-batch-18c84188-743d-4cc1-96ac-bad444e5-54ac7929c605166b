/**
 * Minimal browser-environment fakes (canvas / 2d context / textures / editor)
 * sufficient to drive PaintStrokeCommand and the paint history sync helpers
 * under plain Node, using the platform's real global ImageData.
 */

/** Canvas 2D context backed by an ImageData buffer. */
export class Fake2DContext {
  constructor(imageData) {
    this.imageData = cloneImageData(imageData);
  }

  putImageData(imageData) {
    this.imageData = cloneImageData(imageData);
  }

  getImageData() {
    return cloneImageData(this.imageData);
  }
}

export class FakeCanvas {
  constructor(imageData) {
    this.width = imageData.width;
    this.height = imageData.height;
    this.ctx = new Fake2DContext(imageData);
  }

  getContext() {
    return this.ctx;
  }
}

export class FakeTexture {
  constructor(canvas) {
    this.image = canvas;
    this.needsUpdate = false;
  }
}

export class FakeMaterial {
  constructor(maps = {}) {
    Object.assign(this, maps);
    this.needsUpdate = false;
  }
}

/**
 * Canvas-side snapshot after the last putImageData/getImageData.
 * @param {FakeCanvas} canvas
 */
export function canvasImageData(canvas) {
  return cloneImageData(canvas.ctx.imageData);
}

export function cloneImageData(imageData) {
  return new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );
}

/** Flat RGBA ImageData filled with one colour. */
export function solidImageData(width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return new ImageData(data, width, height);
}

/** ImageData whose first pixel is `color`, every other pixel is `bg`. */
export function imageDataWithFirstPixel(width, height, color, bg) {
  const image = solidImageData(width, height, bg);
  const [r, g, b, a = 255] = color;
  image.data[0] = r;
  image.data[1] = g;
  image.data[2] = b;
  image.data[3] = a;
  return image;
}

/** True when two ImageData buffers are byte-identical. */
export function pixelsEqual(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) return false;
  }
  return true;
}

/** RGBA of a single pixel. */
export function pixelAt(imageData, index) {
  const i = index * 4;
  return [
    imageData.data[i],
    imageData.data[i + 1],
    imageData.data[i + 2],
    imageData.data[i + 3],
  ];
}

/**
 * A stand-in for TexturePainter's history hook that uses the real production
 * helper, so tests exercise the same code path the command calls in the app.
 */
export async function makeTexturePainterStub({
  object,
  maps,
  projectionPainter = null,
  isActive = true,
  originalMaterial = object?.material ?? null,
} = {}) {
  const { syncPainterPixels } = await import(
    '../../js/texture/PaintHistorySync.js'
  );

  return {
    object,
    isActive,
    originalMaterial,
    projectionPainter,
    _maps: maps,
    applyHistoryImageData(targetObject, paintMap, imageData) {
      return syncPainterPixels(this, targetObject, paintMap, imageData);
    },
  };
}

export function makeEditor(object, texturePainter) {
  const objects = object ? [object] : [];
  return {
    modeManager: { texturePainter: texturePainter ?? null },
    objectByUuid(uuid) {
      return objects.find(o => o.uuid === uuid) ?? null;
    },
    signals: {
      objectChanged: {
        dispatched: 0,
        dispatch() {
          this.dispatched++;
        },
      },
    },
  };
}
