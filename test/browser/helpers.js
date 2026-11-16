// Shared helpers for the browser suite
import Compressor from '../../src/index.js';
import * as utilities from '../../src/utilities.js';

export { Compressor, utilities };

// Image path for tests (served from project root in Vitest browser mode)
export const TEST_IMAGE = '/docs/media/test.jpg';
export const TEST_IMAGE_PNG = '/docs/media/test.png';

/**
 * Load an image as a Blob for testing.
 * @param {string} url - The image URL
 * @returns {Promise<Blob>} The image as a Blob
 */
export function loadImageAsBlob(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.onload = () => {
      const blob = xhr.response;

      blob.name = url.replace(/^.*?(\w+\.\w+)$/, '$1');
      resolve(blob);
    };
    xhr.onerror = () => reject(new Error(`Failed to load ${url}.`));
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.send();
  });
}

/**
 * Compress an image and return a Promise
 * @param {Blob} image - The image to compress
 * @param {Object} options - Compressor options (without success/error)
 * @returns {Promise<{compressor: Compressor, result: Blob}>}
 */
export function compress(image, options = {}) {
  return new Promise((resolve, reject) => {
    const compressor = new Compressor(image, {
      ...options,
      success(result) {
        if (options.success) options.success.call(this, result);
        resolve({ compressor, result });
      },
      error(err) {
        if (options.error) options.error.call(this, err);
        reject(err);
      },
    });
  });
}

/**
 * Get the dimensions of a blob image
 * @param {Blob} blob - The image blob
 * @returns {Promise<{width: number, height: number}>}
 */
export function getImageDimensions(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image.'));
    };
    img.src = url;
  });
}

const ascii = (value) => [...value].map((character) => character.charCodeAt(0));

/**
 * Build a JPEG segment (marker, big-endian length, payload).
 * @param {number} marker - The second marker byte (e.g. `0xE1` for APP1).
 * @param {number[]} payload - The payload bytes, excluding the length itself.
 * @returns {Uint8Array} The encoded segment.
 */
export function jpegSegment(marker, payload) {
  const length = payload.length + 2;

  return Uint8Array.from([0xFF, marker, (length >> 8) & 0xFF, length & 0xFF, ...payload]);
}

/**
 * Build an APP1 EXIF payload carrying a single Orientation tag.
 * @param {number} orientation - The orientation value to store.
 * @returns {number[]} The payload bytes.
 */
export function exifPayload(orientation) {
  return [
    ...ascii('Exif'), 0x00, 0x00,

    // TIFF header, little-endian, IFD0 at offset 8
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,

    // One entry: Orientation (0x0112), SHORT, count 1
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    orientation & 0xFF, 0x00, 0x00, 0x00,

    // No next IFD
    0x00, 0x00, 0x00, 0x00,
  ];
}

/**
 * Build an APP1 XMP payload, as written by many photo editors.
 * @returns {number[]} The payload bytes.
 */
export function xmpPayload() {
  return [...ascii('http://ns.adobe.com/xap/1.0/'), 0x00, ...ascii('<x:xmpmeta/>')];
}

/**
 * Assemble a minimal but well-formed JPEG around the given segments.
 * @param {Uint8Array[]} [segments] - The segments to place between SOI and SOS.
 * @returns {ArrayBuffer} The assembled JPEG.
 */
export function buildJpeg(segments = []) {
  const parts = [
    Uint8Array.from([0xFF, 0xD8]),
    ...segments,
    Uint8Array.from([0xFF, 0xDA, 0x00, 0x08, 0, 0, 0, 0, 0, 0]),
    Uint8Array.from([0x11, 0x22, 0x33, 0x44]),
    Uint8Array.from([0xFF, 0xD9]),
  ];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result.buffer;
}

/**
 * Read the Orientation tag back out of EXIF bytes returned by `getExif()`.
 * Handles both little- and big-endian TIFF headers and skips non-Exif APP1
 * segments (e.g. XMP) that may be concatenated ahead of the Exif one.
 * @param {number[]} exifArray - The EXIF bytes to search.
 * @returns {number|null} The orientation value, or `null` when absent.
 */
export function readOrientation(exifArray) {
  const bytes = Uint8Array.from(exifArray);
  const view = new DataView(bytes.buffer);
  let index = 0;

  try {
    while (index + 4 <= bytes.length && bytes[index] === 0xFF && bytes[index + 1] === 0xE1) {
      const segmentLength = view.getUint16(index + 2);
      const end = index + 2 + segmentLength;

      if (segmentLength < 2 || end > bytes.length) {
        break;
      }

      // Exif identifier "Exif\0\0" at the start of the APP1 payload
      if (end - index >= 10
        && bytes[index + 4] === 0x45 && bytes[index + 5] === 0x78
        && bytes[index + 6] === 0x69 && bytes[index + 7] === 0x66
        && bytes[index + 8] === 0x00 && bytes[index + 9] === 0x00) {
        const tiffOffset = index + 10;
        const endianness = view.getUint16(tiffOffset);
        const littleEndian = endianness === 0x4949;

        if ((littleEndian || endianness === 0x4D4D)
          && view.getUint16(tiffOffset + 2, littleEndian) === 0x002A) {
          const firstIFDOffset = view.getUint32(tiffOffset + 4, littleEndian);

          if (firstIFDOffset >= 0x08) {
            const ifdStart = tiffOffset + firstIFDOffset;
            const entryCount = view.getUint16(ifdStart, littleEndian);

            for (let i = 0; i < entryCount; i += 1) {
              const entry = ifdStart + 2 + (i * 12);

              if (view.getUint16(entry, littleEndian) === 0x0112 /* Orientation */) {
                return view.getUint16(entry + 8, littleEndian);
              }
            }
          }
        }
      }

      index = end;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Walk the marker segments of a JPEG buffer from SOI up to (and including)
 * the Start-of-Scan segment, mirroring the parser used by the library.
 * @param {ArrayBuffer|Uint8Array} data - The JPEG data.
 * @returns {Array<{type: number, start: number, end: number}>} The segments.
 */
export function walkJpegSegments(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments = [];

  if (bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return segments;
  }

  let start = 2;

  while (start + 3 < bytes.length) {
    if (dataView.getUint8(start) !== 0xFF) {
      break;
    }

    let marker = start;

    while (marker + 1 < bytes.length && dataView.getUint8(marker + 1) === 0xFF) {
      marker += 1;
    }

    if (marker + 1 >= bytes.length) {
      break;
    }

    const type = dataView.getUint8(marker + 1);

    if (type === 0xDA /* SOS */) {
      segments.push({ type, start: marker, end: bytes.length });
      break;
    }

    if (type === 0x01 || (type >= 0xD0 && type <= 0xD9)) {
      start = marker + 2;
      continue;
    }

    if (marker + 3 >= bytes.length) {
      break;
    }

    const segmentLength = dataView.getUint16(marker + 2);

    if (segmentLength < 2) {
      break;
    }

    const end = marker + 2 + segmentLength;

    if (end > bytes.length) {
      break;
    }

    segments.push({ type, start: marker, end });
    start = end;
  }

  return segments;
}

/**
 * Remove the APP0 (JFIF) segment from a JPEG buffer so that APP1 becomes the
 * first segment after SOI, while keeping the image decodable.
 * @param {ArrayBuffer} arrayBuffer - The source JPEG.
 * @returns {ArrayBuffer} A JPEG without an APP0 segment.
 */
export function removeApp0(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const pieces = [bytes.subarray(0, 2)];

  for (const { type, start, end } of walkJpegSegments(bytes)) {
    if (type !== 0xE0) {
      pieces.push(bytes.subarray(start, end));
    }
  }

  const result = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let offset = 0;

  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.length;
  }

  return result.buffer;
}

/**
 * Build a decodable JPEG Blob from an arbitrary segment list by re-encoding
 * a canvas image and replacing its pre-scan segments with the given ones.
 * The encoder’s Start-of-Scan marker and scan data are reused verbatim, so
 * the assembled file remains a valid, decodable JPEG.
 * @param {Uint8Array[]} segments - The segments to place between SOI and SOS.
 * @param {number} [width] - Canvas width.
 * @param {number} [height] - Canvas height.
 * @returns {Promise<Blob>} The assembled, browser-encodable JPEG blob.
 */
export async function buildDecodableJpegBlob(segments, width = 32, height = 24) {
  const canvas = document.createElement('canvas');

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#2563eb';
  context.fillRect(0, 0, Math.ceil(width / 2), height);

  const baseBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8);
  });
  const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());
  const sos = walkJpegSegments(baseBytes).find(({ type }) => type === 0xDA);

  if (!sos) {
    throw new Error('Encoded JPEG has no Start-of-Scan segment.');
  }

  const parts = [
    Uint8Array.from([0xFF, 0xD8]),
    ...segments,
    // The encoder’s frame/table segments, then the SOS marker, entropy-coded
    // scan data and EOI—all reused verbatim so the file stays decodable
    baseBytes.subarray(2),
  ];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return new Blob([result], { type: 'image/jpeg' });
}
