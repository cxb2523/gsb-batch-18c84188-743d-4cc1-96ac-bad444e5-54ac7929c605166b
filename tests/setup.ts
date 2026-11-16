/**
 * Vitest setup file
 */

import "vitest-webgl-canvas-mock";

// Mock requestAnimationFrame
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
  return setTimeout(() => callback(performance.now()), 16) as unknown as number;
};

globalThis.cancelAnimationFrame = (id: number) => {
  clearTimeout(id);
};

// Mock performance.now if not available
if (typeof performance === "undefined") {
  (globalThis as unknown as { performance: { now: () => number } }).performance = {
    now: () => Date.now(),
  };
}

// Mock createImageBitmap.
// happy-dom may ship a partial implementation that throws for the image
// sources used by the loader, so always replace it with a deterministic mock.
(globalThis as unknown as { createImageBitmap: typeof createImageBitmap }).createImageBitmap =
  async (_source: ImageBitmapSource) => {
    return {
      width: 64,
      height: 64,
      close: () => {},
    } as ImageBitmap;
  };

// Mock HTMLCanvasElement.transferToImageBitmap
(
  HTMLCanvasElement.prototype as HTMLCanvasElement & { transferToImageBitmap: () => ImageBitmap }
).transferToImageBitmap = function (this: HTMLCanvasElement) {
  return {
    width: this.width,
    height: this.height,
    close: () => {},
  } as ImageBitmap;
};
