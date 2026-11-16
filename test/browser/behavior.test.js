import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Compressor,
  loadImageAsBlob,
  compress,
  getImageDimensions,
  utilities,
  TEST_IMAGE,
  TEST_IMAGE_PNG,
  jpegSegment,
  exifPayload,
  readOrientation,
  walkJpegSegments,
  removeApp0,
  buildDecodableJpegBlob,
} from './helpers.js';

const { getExif, getNormalizedExif, resetCanvasReliableCache } = utilities;

function blobToArrayBuffer(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = ({ target }) => {
      resolve(target.result);
    };
    reader.readAsArrayBuffer(blob);
  });
}

describe('behavior options', () => {
  describe('strict', () => {
    it('should be `true` by default', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE_PNG);
      const compressor = new Compressor(image);

      expect(compressor.options.strict).toBe(true);
    });

    it('should output the original image as the result', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { quality: 1 });

      // `strict` returns a file no larger than the original; since `retainExif`
      // defaults to `false`, the strict fallback strips EXIF from the original
      // rather than returning the identical object
      expect(result.size).toBeLessThanOrEqual(image.size);
    });

    it('should be ignored when the `mimeType` option is set and its value is different from the MIME type of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { mimeType: 'image/png' });

      expect(result).not.toBe(image);
    });

    it('should be ignored when the `width` option is set and its value is greater than the natural width of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { width: 501 });

      expect(result).not.toBe(image);
    });

    it('should be ignored when the `height` option is set and its value is greater than the natural height of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { height: 601 });

      expect(result).not.toBe(image);
    });

    it('should be ignored when the `minWidth` option is set and its value is greater than the natural width of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { minWidth: 501 });

      expect(result).not.toBe(image);
    });

    it('should be ignored when the `minHeight` option is set and its value is greater than the natural height of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { minHeight: 601 });

      expect(result).not.toBe(image);
    });

    it('should be ignored when the `maxWidth` option is set and its value is less than the natural width of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { maxWidth: 499 });

      expect(result).not.toBe(image);
    });

    it('should be ignored when the `maxHeight` option is set and its value is less than the natural height of the image', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { maxHeight: 599 });

      expect(result).not.toBe(image);
    });
  });

  describe('orientation', () => {
    it('should output correct orientation using browser-native EXIF handling', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { strict: false });
      const { width, height } = await getImageDimensions(result);

      expect(width).toBeLessThan(height);
    });
  });

  describe('retainExif', () => {
    it('should not retain the Exif information', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image);
      const arrayBuffer = await blobToArrayBuffer(result);

      expect(getExif(arrayBuffer)).toHaveLength(0);
    });

    it('should retain the Exif information', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image, { retainExif: true });
      const arrayBuffer = await blobToArrayBuffer(result);

      expect(getExif(arrayBuffer).length).toBeGreaterThan(0);
    });

    it('should output orientation 1 with pixels matching the source’s visual orientation', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const sourceExif = getExif(await blobToArrayBuffer(image));

      // The fixture is a phone photo carrying a non-identity orientation
      expect(readOrientation(sourceExif)).not.toBe(1);

      const { result } = await compress(image, { retainExif: true, strict: false });
      const arrayBuffer = await blobToArrayBuffer(result);
      const retainedExif = getExif(arrayBuffer);

      // Metadata claims orientation 1 …
      expect(retainedExif.length).toBeGreaterThan(0);
      expect(readOrientation(retainedExif)).toBe(1);

      // … and the pixels are already straight: decoding must not rotate again
      const { width, height } = await getImageDimensions(result);
      const sourceDimensions = await getImageDimensions(image);

      expect(width).toBeLessThan(height);
      expect(sourceDimensions.width).toBeLessThan(sourceDimensions.height);
    });

    it('should leave other EXIF fields in place while normalizing orientation', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const sourceExif = getNormalizedExif(await blobToArrayBuffer(image));
      const { result } = await compress(image, { retainExif: true, strict: false });
      const retainedExif = getExif(await blobToArrayBuffer(result));

      // The full APP1 payload (other tags included) is carried over, with
      // only the orientation byte changed
      expect(retainedExif).toEqual(sourceExif);
    });

    it('should insert EXIF after SOI even when the encoded JPEG has no APP0 segment', async () => {
      // A real, decodable JPEG whose first segment is APP1 rather than APP0
      const source = await loadImageAsBlob(TEST_IMAGE);
      const withoutApp0 = removeApp0(await blobToArrayBuffer(source));
      const image = new File([withoutApp0], 'no-app0.jpg', { type: 'image/jpeg' });
      const segmentsBefore = walkJpegSegments(await blobToArrayBuffer(image));

      expect(segmentsBefore[0].type).not.toBe(0xE0);

      const { result } = await compress(image, { retainExif: true, strict: false });
      const arrayBuffer = await blobToArrayBuffer(result);
      const bytes = new Uint8Array(arrayBuffer);
      const segmentsAfter = walkJpegSegments(arrayBuffer);

      // Still a JPEG, EXIF first and decodable in an <img>
      expect(bytes[0]).toBe(0xFF);
      expect(bytes[1]).toBe(0xD8);
      expect(segmentsAfter[0].type).toBe(0xE1);
      expect(readOrientation(getExif(arrayBuffer))).toBe(1);

      const { width, height } = await getImageDimensions(result);

      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    });

    it('should retain EXIF for a JPEG with no APP0 and a synthetic orientation tag', async () => {
      const exif = jpegSegment(0xE1, exifPayload(6));
      const image = await buildDecodableJpegBlob([exif]);
      const file = new File([image], 'synthetic.jpg', { type: 'image/jpeg' });

      const { result } = await compress(file, { retainExif: true, strict: false });
      const arrayBuffer = await blobToArrayBuffer(result);
      const segments = walkJpegSegments(arrayBuffer);

      expect(new Uint8Array(arrayBuffer).subarray(0, 2)).toEqual(Uint8Array.from([0xFF, 0xD8]));
      expect(segments[0].type).toBe(0xE1);
      expect(readOrientation(getExif(arrayBuffer))).toBe(1);

      // The output remains a decodable JPEG
      const dimensions = await getImageDimensions(result);

      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.height).toBeGreaterThan(0);
    });

    it('should produce no EXIF when retainExif is false even if the source is oriented', async () => {
      const source = await loadImageAsBlob(TEST_IMAGE);

      expect(readOrientation(getExif(await blobToArrayBuffer(source)))).not.toBe(1);

      const { result } = await compress(source, { retainExif: false, strict: false });
      const arrayBuffer = await blobToArrayBuffer(result);

      expect(getExif(arrayBuffer)).toHaveLength(0);
    });

    it('should not mutate the source file while normalizing orientation', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const sourceBytesBefore = new Uint8Array(await blobToArrayBuffer(image));

      await compress(image, { retainExif: true, strict: false });

      const sourceBytesAfter = new Uint8Array(await blobToArrayBuffer(image));

      expect(sourceBytesAfter).toEqual(sourceBytesBefore);
      expect(readOrientation(getExif(sourceBytesAfter.buffer))).not.toBe(1);
    });
  });

  describe('canvas fallback', () => {
    let originalGetImageData;

    beforeEach(() => {
      originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      resetCanvasReliableCache();

      // Simulate fingerprinting resistance by corrupting canvas reads
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        const imageData = originalGetImageData.apply(this, args);

        imageData.data[0] = 255;
        return imageData;
      };
    });

    afterEach(() => {
      CanvasRenderingContext2D.prototype.getImageData = originalGetImageData;
      resetCanvasReliableCache();
    });

    it('should strip EXIF and return result for JPEG when canvas is unreliable', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE);
      const { result } = await compress(image);

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');

      const arrayBuffer = await blobToArrayBuffer(result);

      // EXIF should be stripped
      expect(getExif(arrayBuffer)).toHaveLength(0);

      // Should still be a valid JPEG
      const dataView = new DataView(arrayBuffer);

      expect(dataView.getUint8(0)).toBe(0xFF);
      expect(dataView.getUint8(1)).toBe(0xD8);
    });

    it('should return original file for PNG when canvas is unreliable', async () => {
      const image = await loadImageAsBlob(TEST_IMAGE_PNG);
      const { result } = await compress(image);

      expect(result).toBe(image);
    });
  });
});
