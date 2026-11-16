/**
 * Minimal spec-shaped ImageData for Node builds that do not expose the global
 * (the CI/runtime Node here is built without canvas globals).  Browser
 * execution keeps using the native ImageData; this only fills the gap under
 * `node --test`.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/ImageData/ImageData
 */
export class TestImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) {
      throw new TypeError('ImageData: data must be a Uint8ClampedArray');
    }
    if (!Number.isInteger(width) || width <= 0) {
      throw new RangeError('ImageData: width must be a positive integer');
    }
    if (height === undefined) {
      if (data.length % (width * 4) !== 0) {
        throw new RangeError('ImageData: data length is not a multiple of width * 4');
      }
      height = data.length / (width * 4);
    }
    if (!Number.isInteger(height) || height <= 0) {
      throw new RangeError('ImageData: height must be a positive integer');
    }
    if (data.length !== width * height * 4) {
      throw new RangeError('ImageData: data length does not match width * height * 4');
    }

    Object.defineProperties(this, {
      data: { value: data, enumerable: true },
      width: { value: width, enumerable: true },
      height: { value: height, enumerable: true },
      colorSpace: { value: 'srgb', enumerable: true },
    });
  }
}

/** Install the polyfill on globalThis when no native ImageData exists. */
export function ensureImageData() {
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = TestImageData;
  }
  return globalThis.ImageData;
}
