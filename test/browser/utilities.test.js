import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  utilities,
  loadImageAsBlob,
  TEST_IMAGE,
  TEST_IMAGE_PNG,
  buildJpeg,
  jpegSegment,
  exifPayload,
  xmpPayload,
  readOrientation,
  walkJpegSegments,
  removeApp0,
} from './helpers.js';

const {
  isPositiveNumber,
  isImageType,
  imageTypeToExtension,
  isCanvasReliable,
  resetCanvasReliableCache,
  resetOrientation,
  normalizeDecimalNumber,
  getAdjustedSizes,
  getExif,
  getNormalizedExif,
  insertExif,
  stripExif,
  uint8ArrayToBlob,
} = utilities;

describe('utilities', () => {
  describe('isPositiveNumber', () => {
    it('should return true for positive numbers', () => {
      expect(isPositiveNumber(1)).toBe(true);
      expect(isPositiveNumber(0.5)).toBe(true);
      expect(isPositiveNumber(100)).toBe(true);
    });

    it('should return false for zero', () => {
      expect(isPositiveNumber(0)).toBe(false);
    });

    it('should return false for negative numbers', () => {
      expect(isPositiveNumber(-1)).toBe(false);
      expect(isPositiveNumber(-0.5)).toBe(false);
    });

    it('should return false for Infinity', () => {
      expect(isPositiveNumber(Infinity)).toBe(false);
    });

    it('should return false for null and undefined', () => {
      expect(isPositiveNumber(null)).toBe(false);
      expect(isPositiveNumber(undefined)).toBe(false);
      expect(isPositiveNumber(NaN)).toBe(false);
    });
  });

  describe('isImageType', () => {
    it('should return true for valid image MIME types', () => {
      expect(isImageType('image/jpeg')).toBe(true);
      expect(isImageType('image/png')).toBe(true);
      expect(isImageType('image/webp')).toBe(true);
      expect(isImageType('image/gif')).toBe(true);
    });

    it('should return false for non-image MIME types', () => {
      expect(isImageType('text/plain')).toBe(false);
      expect(isImageType('application/json')).toBe(false);
      expect(isImageType('video/mp4')).toBe(false);
    });

    it('should return false for invalid values', () => {
      expect(isImageType('')).toBe(false);
      expect(isImageType('image')).toBe(false);
      expect(isImageType(null)).toBe(false);
    });
  });

  describe('imageTypeToExtension', () => {
    it('should convert image/jpeg to .jpg', () => {
      expect(imageTypeToExtension('image/jpeg')).toBe('.jpg');
    });

    it('should convert image/png to .png', () => {
      expect(imageTypeToExtension('image/png')).toBe('.png');
    });

    it('should convert image/webp to .webp', () => {
      expect(imageTypeToExtension('image/webp')).toBe('.webp');
    });

    it('should return empty extension for invalid types', () => {
      expect(imageTypeToExtension('text/plain')).toBe('.');
      expect(imageTypeToExtension('')).toBe('.');
    });
  });

  describe('resetOrientation', () => {
    it('should return undefined for non-JPEG data', () => {
      const buffer = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer; // PNG signature

      expect(resetOrientation(buffer)).toBeUndefined();
    });

    it('should return the original orientation and reset it to 1', () => {
      const buffer = buildJpeg([jpegSegment(0xE1, exifPayload(6))]);

      expect(resetOrientation(buffer)).toBe(6);
      expect(readOrientation(getExif(buffer))).toBe(1);
    });

    it('should reset the orientation when an XMP APP1 segment comes first', () => {
      const buffer = buildJpeg([
        jpegSegment(0xE1, xmpPayload()),
        jpegSegment(0xE1, exifPayload(6)),
      ]);

      expect(resetOrientation(buffer)).toBe(6);
      expect(readOrientation(getExif(buffer))).toBe(1);
    });

    it('should reset the orientation when an earlier segment’s payload contains FF E1', () => {
      const buffer = buildJpeg([
        jpegSegment(0xE2, [0x49, 0x43, 0x43, 0x00, 0xFF, 0xE1, 0x00, 0x20]),
        jpegSegment(0xE1, exifPayload(6)),
      ]);

      expect(resetOrientation(buffer)).toBe(6);
      expect(readOrientation(getExif(buffer))).toBe(1);
    });

    it('should reset the orientation when `0xFF` fill bytes precede the marker', () => {
      const buffer = buildJpeg([
        Uint8Array.from([0xFF, 0xFF]),
        jpegSegment(0xE1, exifPayload(6)),
      ]);

      expect(resetOrientation(buffer)).toBe(6);
      expect(readOrientation(getExif(buffer))).toBe(1);
    });

    it('should reset the orientation past a standalone marker carrying no length', () => {
      const buffer = buildJpeg([
        Uint8Array.from([0xFF, 0x01]), // TEM
        jpegSegment(0xE1, exifPayload(6)),
      ]);

      expect(resetOrientation(buffer)).toBe(6);
      expect(readOrientation(getExif(buffer))).toBe(1);
    });

    it('should return undefined for a JPEG without EXIF', () => {
      const buffer = buildJpeg([jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00])]);

      expect(resetOrientation(buffer)).toBeUndefined();
    });

    it('should not mistake FF E1 in the scan data for an EXIF segment', () => {
      const buffer = buildJpeg([jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00])]);
      const uint8 = new Uint8Array(buffer);

      uint8[uint8.length - 4] = 0xFF;
      uint8[uint8.length - 3] = 0xE1;

      expect(resetOrientation(buffer)).toBeUndefined();
    });
  });

  describe('normalizeDecimalNumber', () => {
    it('should return the value unchanged for normal numbers', () => {
      expect(normalizeDecimalNumber(1.5)).toBe(1.5);
      expect(normalizeDecimalNumber(100)).toBe(100);
    });

    it('should normalize floating point errors', () => {
      // 0.1 + 0.2 = 0.30000000000000004 in JavaScript
      const value = 0.30000000000000004;
      const result = normalizeDecimalNumber(value);

      expect(result).toBe(0.3);
    });
  });

  describe('getAdjustedSizes', () => {
    it('should return original sizes when type is none and both dimensions valid', () => {
      const result = getAdjustedSizes({ aspectRatio: 2, width: 200, height: 100 }, 'none');

      expect(result.width).toBe(200);
      expect(result.height).toBe(100);
    });

    it('should calculate height from width when only width is provided', () => {
      const result = getAdjustedSizes({ aspectRatio: 2, width: 200, height: undefined });

      expect(result.width).toBe(200);
      expect(result.height).toBe(100);
    });

    it('should calculate width from height when only height is provided', () => {
      const result = getAdjustedSizes({ aspectRatio: 2, width: undefined, height: 100 });

      expect(result.width).toBe(200);
      expect(result.height).toBe(100);
    });

    it('should contain within bounds for contain type', () => {
      const result = getAdjustedSizes({ aspectRatio: 2, width: 100, height: 100 }, 'contain');

      expect(result.width).toBe(100);
      expect(result.height).toBe(50);
    });

    it('should cover bounds for cover type', () => {
      const result = getAdjustedSizes({ aspectRatio: 2, width: 100, height: 100 }, 'cover');

      expect(result.width).toBe(200);
      expect(result.height).toBe(100);
    });
  });

  describe('getExif', () => {
    it('should return empty array for non-JPEG data', () => {
      const buffer = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer; // PNG signature
      const result = getExif(buffer);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should not read past a truncated JPEG ending in fill bytes', () => {
      const buffer = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xFF, 0xFF, 0xFF]).buffer;

      expect(() => getExif(buffer)).not.toThrow();
      expect(getExif(buffer)).toEqual([]);
    });

    it('should return empty array for JPEG without EXIF', async () => {
      const blob = await loadImageAsBlob(TEST_IMAGE_PNG);
      const arrayBuffer = await blob.arrayBuffer();
      const result = getExif(arrayBuffer);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getNormalizedExif', () => {
    it('should return an empty array for non-JPEG data', () => {
      const buffer = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer; // PNG signature

      expect(getNormalizedExif(buffer)).toEqual([]);
    });

    it('should return an empty array for a JPEG without EXIF', () => {
      const buffer = buildJpeg([jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00])]);

      expect(getNormalizedExif(buffer)).toEqual([]);
    });

    it('should reset the orientation tag to 1 while keeping the segment', () => {
      const buffer = buildJpeg([jpegSegment(0xE1, exifPayload(6))]);
      const result = getNormalizedExif(buffer);

      expect(result.length).toBeGreaterThan(0);
      expect(readOrientation(result)).toBe(1);
    });

    it('should normalize orientation across all APP1 segments, including an XMP-first layout', () => {
      const buffer = buildJpeg([
        jpegSegment(0xE1, xmpPayload()),
        jpegSegment(0xE1, exifPayload(8)),
      ]);
      const result = getNormalizedExif(buffer);

      expect(result.length).toBeGreaterThan(0);
      expect(readOrientation(result)).toBe(1);
    });

    it('should leave the source buffer untouched', () => {
      const buffer = buildJpeg([jpegSegment(0xE1, exifPayload(6))]);
      const bytesBefore = new Uint8Array(buffer).slice();

      getNormalizedExif(buffer);

      expect(new Uint8Array(buffer)).toEqual(bytesBefore);
      expect(readOrientation(getExif(buffer))).toBe(6);
    });

    it('should not read past a truncated JPEG ending in fill bytes', () => {
      const buffer = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xFF, 0xFF, 0xFF]).buffer;

      expect(() => getNormalizedExif(buffer)).not.toThrow();
      expect(getNormalizedExif(buffer)).toEqual([]);
    });

    it('should reset any non-identity orientation to 1, including 3', () => {
      const buffer = buildJpeg([jpegSegment(0xE1, exifPayload(3))]);

      expect(readOrientation(getNormalizedExif(buffer))).toBe(1);
    });

    it('should keep a non-Exif APP1 (XMP) segment byte-for-byte', () => {
      const buffer = buildJpeg([
        jpegSegment(0xE1, xmpPayload()),
        jpegSegment(0xE1, exifPayload(6)),
      ]);
      const result = getNormalizedExif(buffer);
      const xmpSegment = jpegSegment(0xE1, xmpPayload());

      // The XMP segment (the first APP1) is copied without modification
      expect(result.slice(0, xmpSegment.length)).toEqual(Array.from(xmpSegment));
      expect(readOrientation(result)).toBe(1);
    });
  });

  describe('insertExif', () => {
    it('should return the original bytes for non-JPEG data', () => {
      const buffer = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer; // PNG signature
      const result = insertExif(buffer, jpegSegment(0xE1, exifPayload(1)));

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(4);
      expect(result[0]).toBe(0x89);
    });

    it('should return the original bytes when there is no EXIF to insert', () => {
      const buffer = buildJpeg([jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00])]);
      const result = insertExif(buffer, []);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(new Uint8Array(buffer));
    });

    it('should insert EXIF after SOI when an APP0 segment follows SOI', () => {
      const app0 = jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00]);
      const exif = jpegSegment(0xE1, exifPayload(1));
      const buffer = buildJpeg([app0]);
      const result = insertExif(buffer, Array.from(exif));
      const segments = walkJpegSegments(result.buffer);

      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xD8);
      expect(segments[0].type).toBe(0xE1);
      expect(segments[1].type).toBe(0xE0);
      expect(result.length).toBe(buffer.byteLength + exif.length);
    });

    it('should insert EXIF after SOI when no APP0 segment is present', () => {
      const exif = jpegSegment(0xE1, exifPayload(6));
      // APP2 first: neither SOI+APP0 nor SOI+APP1 initially
      const app2 = jpegSegment(0xE2, [0x49, 0x43, 0x43, 0x00]);
      const buffer = buildJpeg([app2]);
      const result = insertExif(buffer, Array.from(exif));
      const segments = walkJpegSegments(result.buffer);

      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xD8);
      expect(segments[0].type).toBe(0xE1);
      expect(segments[1].type).toBe(0xE2);
      expect(result.length).toBe(buffer.byteLength + exif.length);
    });

    it('should insert EXIF before an existing APP1-first JPEG and keep the structure valid', () => {
      const existingExif = jpegSegment(0xE1, xmpPayload());
      const newExif = jpegSegment(0xE1, exifPayload(1));
      const buffer = buildJpeg([existingExif]);
      const result = insertExif(buffer, Array.from(newExif));
      const segments = walkJpegSegments(result.buffer);

      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xD8);
      expect(segments[0].type).toBe(0xE1);
      expect(segments[1].type).toBe(0xE1);
      expect(segments[2].type).toBe(0xDA);
    });

    it('should keep every non-EXIF byte of the original JPEG intact', () => {
      const app0 = jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00]);
      const app2 = jpegSegment(0xE2, [0x49, 0x43, 0x43, 0x00, 0x01, 0x02]);
      const exif = jpegSegment(0xE1, exifPayload(1));
      const buffer = buildJpeg([app0, app2]);
      const result = insertExif(buffer, Array.from(exif));
      const original = new Uint8Array(buffer);

      // Everything after SOI must reappear verbatim after the inserted segment
      expect(result.subarray(2 + exif.length)).toEqual(original.subarray(2));
    });

    it('should produce a decodable JPEG when the source has no APP0', async () => {
      const blob = await loadImageAsBlob(TEST_IMAGE);
      const withoutApp0 = removeApp0(await blob.arrayBuffer());
      const segmentsBefore = walkJpegSegments(withoutApp0);

      expect(segmentsBefore[0].type).not.toBe(0xE0);

      const exif = getNormalizedExif(await blob.arrayBuffer());
      const result = insertExif(withoutApp0, exif);
      const resultBlob = new Blob([result], { type: 'image/jpeg' });
      const url = URL.createObjectURL(resultBlob);

      try {
        await new Promise((resolve, reject) => {
          const image = new Image();

          image.onload = resolve;
          image.onerror = () => reject(new Error('Result JPEG failed to decode.'));
          image.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }

      const segmentsAfter = walkJpegSegments(result.buffer);

      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xD8);
      expect(segmentsAfter[0].type).toBe(0xE1);
    });
  });

  describe('uint8ArrayToBlob', () => {
    it('should create a Blob with correct type', () => {
      const array = new Uint8Array([1, 2, 3]);
      const result = uint8ArrayToBlob(array, 'image/jpeg');

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
      expect(result.size).toBe(3);
    });
  });

  describe('isCanvasReliable', () => {
    let originalGetImageData;

    beforeEach(() => {
      originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      resetCanvasReliableCache();
    });

    afterEach(() => {
      CanvasRenderingContext2D.prototype.getImageData = originalGetImageData;
      resetCanvasReliableCache();
    });

    it('should return true in a normal browser environment', () => {
      expect(isCanvasReliable()).toBe(true);
    });

    it('should cache the result after the first call', () => {
      expect(isCanvasReliable()).toBe(true);

      // Corrupt canvas after caching
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        const imageData = originalGetImageData.apply(this, args);

        imageData.data[0] = 255;
        return imageData;
      };

      // Should still return the cached true
      expect(isCanvasReliable()).toBe(true);
    });

    it('should return false when canvas data is corrupted', () => {
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        const imageData = originalGetImageData.apply(this, args);

        // Simulate fingerprinting resistance noise
        imageData.data[0] = 255;
        return imageData;
      };

      expect(isCanvasReliable()).toBe(false);
    });

    it('should return false when canvas throws', () => {
      CanvasRenderingContext2D.prototype.getImageData = function () {
        throw new Error('Security error.');
      };

      expect(isCanvasReliable()).toBe(false);
    });
  });

  describe('stripExif', () => {
    it('should not read past a truncated JPEG ending in fill bytes', () => {
      const buffer = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xFF, 0xFF, 0xFF]).buffer;

      expect(() => stripExif(buffer)).not.toThrow();
    });

    it('should return data unchanged for non-JPEG input', () => {
      const buffer = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer; // PNG signature
      const result = stripExif(buffer);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(4);
      expect(result[0]).toBe(0x89);
    });

    it('should remove EXIF from a real JPEG', async () => {
      const blob = await loadImageAsBlob(TEST_IMAGE);
      const arrayBuffer = await blob.arrayBuffer();
      const exifBefore = getExif(arrayBuffer);

      expect(exifBefore.length).toBeGreaterThan(0);

      const stripped = stripExif(arrayBuffer);
      const exifAfter = getExif(stripped.buffer);

      expect(exifAfter).toHaveLength(0);
      expect(stripped.length).toBeLessThan(arrayBuffer.byteLength);

      // Should still be a valid JPEG (starts with SOI marker)
      expect(stripped[0]).toBe(0xFF);
      expect(stripped[1]).toBe(0xD8);
    });

    it('should keep JPEG data intact when there is no EXIF', () => {
      // Minimal JPEG: SOI + APP0 + SOS + EOI
      const buffer = new Uint8Array([
        0xFF, 0xD8, // SOI
        0xFF, 0xE0, // APP0 marker
        0x00, 0x02, // APP0 length (2 bytes)
        0xFF, 0xDA, // SOS
        0x00, 0x00, // dummy scan data
        0xFF, 0xD9, // EOI
      ]).buffer;
      const result = stripExif(buffer);

      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xD8);
      expect(result.length).toBe(buffer.byteLength);
    });

    it('should handle a malformed JPEG with truncated segment length', () => {
      // APP1 marker with length larger than remaining buffer
      const buffer = new Uint8Array([
        0xFF, 0xD8, // SOI
        0xFF, 0xE1, // APP1 (EXIF) marker
        0x00, 0xFF, // Length = 255 (but only 2 bytes remain)
        0x00, 0x00, // Truncated data
      ]).buffer;
      const result = stripExif(buffer);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBeLessThanOrEqual(buffer.byteLength);
      expect(result[0]).toBe(0xFF);
      expect(result[1]).toBe(0xD8);
    });
  });
});
