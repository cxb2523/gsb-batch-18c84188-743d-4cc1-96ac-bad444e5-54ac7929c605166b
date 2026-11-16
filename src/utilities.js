/**
 * Check if the given value is a positive number.
 * @param {*} value - The value to check.
 * @returns {boolean} Returns `true` if the given value is a positive number, else `false`.
 */
export const isPositiveNumber = (value) => value > 0 && value < Infinity;

const REGEXP_IMAGE_TYPE = /^image\/.+$/;

/**
 * Check if the given value is a mime type of image.
 * @param {*} value - The value to check.
 * @returns {boolean} Returns `true` if the given is a mime type of image, else `false`.
 */
export function isImageType(value) {
  return REGEXP_IMAGE_TYPE.test(value);
}

/**
 * Convert image type to extension.
 * @param {string} value - The image type to convert.
 * @returns {boolean} Returns the image extension.
 */
export function imageTypeToExtension(value) {
  let extension = isImageType(value) ? value.slice(6) : '';

  if (extension === 'jpeg') {
    extension = 'jpg';
  }

  return `.${extension}`;
}

const { fromCharCode } = String;

/**
 * Get string from char code in data view.
 * @param {DataView} dataView - The data view for read.
 * @param {number} start - The start index.
 * @param {number} length - The read length.
 * @returns {string} The read result.
 */
function getStringFromCharCode(dataView, start, length) {
  let str = '';
  let i;

  length += start;

  for (i = start; i < length; i += 1) {
    str += fromCharCode(dataView.getUint8(i));
  }

  return str;
}

/**
 * Check if the given data view starts with a JPEG SOI marker.
 * @param {DataView} dataView - The data to check.
 * @returns {boolean} Returns `true` for JPEG data, else `false`.
 */
function isJPEG(dataView) {
  return dataView.byteLength >= 4
    && dataView.getUint8(0) === 0xFF
    && dataView.getUint8(1) === 0xD8;
}

/**
 * Walk the marker segments of a JPEG, from the SOI marker to the scan data.
 * Segments must be walked by their declared length rather than scanned for
 * byte-wise, as marker bytes also occur inside segment payloads and scan data.
 * @param {DataView} dataView - The JPEG data to walk.
 * @param {Function} callback - Called with `(type, start, end)` per segment,
 *   where `end` is exclusive; return `false` to stop the walk.
 */
function forEachSegment(dataView, callback) {
  if (!isJPEG(dataView)) {
    return;
  }

  const { byteLength } = dataView;
  let start = 2;

  while (start + 3 < byteLength) {
    if (dataView.getUint8(start) !== 0xFF) {
      break;
    }

    // Any marker may be preceded by any number of 0xFF fill bytes
    let marker = start;

    while (marker + 1 < byteLength && dataView.getUint8(marker + 1) === 0xFF) {
      marker += 1;
    }

    // Trailing fill bytes leave no marker to read
    if (marker + 1 >= byteLength) {
      break;
    }

    const type = dataView.getUint8(marker + 1);

    // SOS (Start of Scan)—the rest is image data
    if (type === 0xDA) {
      callback(type, marker, byteLength);
      break;
    }

    // TEM and RST0–RST7, SOI, and EOI stand alone, carrying no segment length
    if (type === 0x01 || (type >= 0xD0 && type <= 0xD9)) {
      start = marker + 2;
      continue;
    }

    if (marker + 3 >= byteLength) {
      break;
    }

    const segmentLength = dataView.getUint16(marker + 2);

    if (segmentLength < 2) {
      break;
    }

    const end = marker + 2 + segmentLength;

    if (end > byteLength || callback(type, marker, end) === false) {
      break;
    }

    start = end;
  }
}

/**
 * Reset the Exif orientation tag of the given array buffer to its default
 * value (1), mutating the buffer in place.
 * @param {ArrayBuffer} arrayBuffer - The array buffer to update.
 * @returns {number|undefined} The original orientation value, or `undefined`
 *   when no Exif orientation tag is present.
 */
export function resetOrientation(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);
  let orientation;

  // Ignores range error when the image does not have correct Exif information
  try {
    let littleEndian;
    let app1Start;
    let ifdStart;

    // A JPEG may carry several APP1 segments (an XMP packet alongside the Exif
    // one, say), so match on the Exif identifier rather than the first APP1
    forEachSegment(dataView, (type, start, end) => {
      if (type === 0xE1 && end - start >= 18
        && getStringFromCharCode(dataView, start + 4, 4) === 'Exif') {
        app1Start = start;
        return false;
      }

      return true;
    });

    if (app1Start !== undefined) {
      const tiffOffset = app1Start + 10;
      const endianness = dataView.getUint16(tiffOffset);

      littleEndian = endianness === 0x4949;

      if (littleEndian || endianness === 0x4D4D /* bigEndian */) {
        if (dataView.getUint16(tiffOffset + 2, littleEndian) === 0x002A) {
          const firstIFDOffset = dataView.getUint32(tiffOffset + 4, littleEndian);

          if (firstIFDOffset >= 0x00000008) {
            ifdStart = tiffOffset + firstIFDOffset;
          }
        }
      }
    }

    if (ifdStart) {
      const length = dataView.getUint16(ifdStart, littleEndian);
      let offset;
      let i;

      for (i = 0; i < length; i += 1) {
        offset = ifdStart + (i * 12) + 2;

        if (dataView.getUint16(offset, littleEndian) === 0x0112 /* Orientation */) {
          // 8 is the offset of the current tag's value
          offset += 8;

          // Get the original orientation value
          orientation = dataView.getUint16(offset, littleEndian);

          // Override the orientation with its default value
          dataView.setUint16(offset, 1, littleEndian);
          break;
        }
      }
    }
  } catch {
    orientation = 1;
  }

  return orientation;
}


let cachedCanvasReliable;

/**
 * Check if the browser’s canvas produces reliable pixel data.
 * Returns `false` when anti-fingerprinting measures (e.g., Firefox’s
 * `privacy.resistFingerprinting`) add noise to canvas output.
 * The result is cached after the first call.
 * @returns {boolean} Returns `true` if canvas data is reliable.
 */
export function isCanvasReliable() {
  if (cachedCanvasReliable !== undefined) return cachedCanvasReliable;

  try {
    const canvas = document.createElement('canvas');

    canvas.width = 4;
    canvas.height = 4;

    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(canvas.width, canvas.height);

    for (let i = 0; i < imageData.data.length; i += 4) {
      imageData.data[i] = i;
      imageData.data[i + 1] = 1;
      imageData.data[i + 2] = 2;
      imageData.data[i + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);

    const result = ctx.getImageData(0, 0, canvas.width, canvas.height);

    cachedCanvasReliable = result.data.every((value, index) => {
      const channel = index % 4;

      if (channel === 0) return value === (index & 0xFF);
      if (channel === 1) return value === 1;
      if (channel === 2) return value === 2;
      return value === 255;
    });
  } catch {
    cachedCanvasReliable = false;
  }

  return cachedCanvasReliable;
}

/**
 * Reset the cached canvas reliability result.
 * Intended for testing only.
 */
export function resetCanvasReliableCache() {
  cachedCanvasReliable = undefined;
}

/**
 * Strip all APP1 (EXIF) segments from a JPEG array buffer.
 * @param {ArrayBuffer} arrayBuffer - The JPEG data to strip.
 * @returns {Uint8Array} The JPEG data without EXIF segments.
 */
export function stripExif(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);

  if (!isJPEG(dataView)) {
    return new Uint8Array(arrayBuffer);
  }

  // Keep SOI marker
  const pieces = [new Uint8Array(arrayBuffer, 0, 2)];

  forEachSegment(dataView, (type, start, end) => {
    // Skip APP1 (EXIF) segments, keep everything else
    if (type !== 0xE1) {
      pieces.push(new Uint8Array(arrayBuffer, start, end - start));
    }
  });

  const totalLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.length;
  }

  return result;
}

const REGEXP_DECIMALS = /\.\d*(?:0|9){12}\d*$/;

/**
 * Normalize decimal number.
 * Check out {@link https://0.30000000000000004.com/}
 * @param {number} value - The value to normalize.
 * @param {number} [times=100000000000] - The times for normalizing.
 * @returns {number} Returns the normalized number.
 */
export function normalizeDecimalNumber(value, times = 100000000000) {
  return REGEXP_DECIMALS.test(value) ? (Math.round(value * times) / times) : value;
}

/**
 * Get the max sizes in a rectangle under the given aspect ratio.
 * @param {Object} data - The original sizes.
 * @param {string} [type='contain'] - The adjust type.
 * @returns {Object} The result sizes.
 */
export function getAdjustedSizes(
  {
    aspectRatio,
    height,
    width,
  },

  // `none` | `contain` | `cover`
  type = 'none',
) {
  const isValidWidth = isPositiveNumber(width);
  const isValidHeight = isPositiveNumber(height);

  if (isValidWidth && isValidHeight) {
    const adjustedWidth = height * aspectRatio;

    if (((type === 'contain' || type === 'none') && adjustedWidth > width) || (type === 'cover' && adjustedWidth < width)) {
      height = width / aspectRatio;
    } else {
      width = height * aspectRatio;
    }
  } else if (isValidWidth) {
    height = width / aspectRatio;
  } else if (isValidHeight) {
    width = height * aspectRatio;
  }

  return {
    width,
    height,
  };
}

/**
 * Get Exif information from the given array buffer.
 * @param {ArrayBuffer} arrayBuffer - The array buffer to read.
 * @returns {Array} The read Exif information.
 */
export function getExif(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);
  const exifArray = [];

  forEachSegment(dataView, (type, start, end) => {
    // APP1 marker (EXIF)
    if (type === 0xE1) {
      for (let i = start; i < end; i += 1) {
        exifArray.push(dataView.getUint8(i));
      }
    }
  });

  return exifArray;
}

/**
 * Override the Orientation tag (0x0112) inside an Exif APP1 segment copy with
 * its default value (1). Leaves every other Exif field untouched.
 * @param {DataView} dataView - The data view containing the segment.
 * @param {number} start - The segment start (the APP1 marker byte).
 * @param {number} end - The segment end, exclusive.
 */
function normalizeExifOrientation(dataView, start, end) {
  try {
    if (end - start < 18 || getStringFromCharCode(dataView, start + 4, 4) !== 'Exif') {
      return;
    }

    const tiffOffset = start + 10;
    const endianness = dataView.getUint16(tiffOffset);
    const littleEndian = endianness === 0x4949;

    if (!littleEndian && endianness !== 0x4D4D /* bigEndian */) {
      return;
    }

    if (dataView.getUint16(tiffOffset + 2, littleEndian) !== 0x002A) {
      return;
    }

    const firstIFDOffset = dataView.getUint32(tiffOffset + 4, littleEndian);

    if (firstIFDOffset < 0x00000008) {
      return;
    }

    const ifdStart = tiffOffset + firstIFDOffset;
    const length = dataView.getUint16(ifdStart, littleEndian);

    for (let i = 0; i < length; i += 1) {
      const entry = ifdStart + (i * 12) + 2;

      if (dataView.getUint16(entry, littleEndian) === 0x0112 /* Orientation */) {
        // 8 is the offset of the current tag’s value
        dataView.setUint16(entry + 8, 1, littleEndian);
        return;
      }
    }
  } catch {
    // Ignore malformed Exif data; the segment is retained as-is
  }
}

/**
 * Extract the Exif segments from a JPEG with the Orientation tag reset to 1.
 * The browser already straightens the pixels when decoding an oriented image
 * (via `image-orientation: from-image`), so the retained metadata must claim
 * orientation 1 to match the re-encoded pixels. Only the returned copy is
 * modified; the source array buffer is left untouched.
 * @param {ArrayBuffer} arrayBuffer - The array buffer to read.
 * @returns {Array} The Exif information with orientation normalized to 1.
 */
export function getNormalizedExif(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);
  const exifSegments = [];

  forEachSegment(dataView, (type, start, end) => {
    // APP1 marker (EXIF, XMP, and other APP1 payloads)
    if (type === 0xE1) {
      exifSegments.push({ start, end });
    }
  });

  if (exifSegments.length === 0) {
    return [];
  }

  const totalLength = exifSegments.reduce((sum, { start, end }) => sum + (end - start), 0);
  const exifBuffer = new ArrayBuffer(totalLength);
  const exifView = new DataView(exifBuffer);
  const source = new Uint8Array(arrayBuffer);
  const target = new Uint8Array(exifBuffer);
  let offset = 0;

  for (const { start, end } of exifSegments) {
    target.set(source.subarray(start, end), offset);
    offset += end - start;
  }

  // Reset orientation within the copied Exif segment(s), not the source data
  let copyOffset = 0;

  for (const { start, end } of exifSegments) {
    const segmentLength = end - start;

    normalizeExifOrientation(exifView, copyOffset, copyOffset + segmentLength);
    copyOffset += segmentLength;
  }

  return Array.from(target);
}

/**
 * Insert Exif information into the given array buffer.
 *
 * The Exif segment is placed right after the SOI marker and before every
 * other segment, whether or not an APP0 (JFIF) segment is present. This is
 * the position the JPEG specification prescribes for APP1 and keeps the
 * output a well-formed, decodable JPEG.
 * @param {ArrayBuffer} arrayBuffer - The array buffer to transform.
 * @param {Array} exifArray - The Exif information to insert.
 * @returns {Uint8Array} The transformed array as Uint8Array.
 */
export function insertExif(arrayBuffer, exifArray) {
  const dataView = new DataView(arrayBuffer);
  const uint8 = new Uint8Array(arrayBuffer);

  if (!isJPEG(dataView) || exifArray.length === 0) {
    return uint8;
  }

  // Create new buffer: SOI (2) + EXIF + the rest of the image, unchanged
  const result = new Uint8Array(2 + exifArray.length + uint8.byteLength - 2);

  // SOI marker
  result[0] = 0xFF;
  result[1] = 0xD8;

  // EXIF data, directly after SOI and before any other segment
  result.set(Uint8Array.from(exifArray), 2);

  // Everything that followed SOI (APP0, other APP segments, scan data, …)
  result.set(uint8.subarray(2), 2 + exifArray.length);

  return result;
}

/**
 * Convert a Uint8Array to a Blob.
 * @param {Uint8Array} uint8Array - The Uint8Array to convert.
 * @param {string} mimeType - The mime type of the Blob.
 * @returns {Blob} The resulting Blob.
 */
export function uint8ArrayToBlob(uint8Array, mimeType) {
  return new Blob([uint8Array], { type: mimeType });
}
