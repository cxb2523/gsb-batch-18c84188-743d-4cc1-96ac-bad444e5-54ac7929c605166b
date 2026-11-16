// TRAX skin text layout.
//
// Turns one skin.json area plus the current track into a list of visible
// lines, each with its final text, pixel size and drawing position.
//
// The rules here mirror the "lines and fields", "How text is fitted",
// "Colors" and "areas" sections of SKINS.html. Everything is pure data:
// the platform layer supplies a text measurer (and, for automatic colors,
// the decoded picture) and draws whatever this module returns.
//
// Screen pixels are integers, matching skin.json, so every position and
// size returned here is rounded to a whole pixel.

export const DEFAULT_SCREEN_WIDTH = 480;
export const DEFAULT_SCREEN_HEIGHT = 272;
export const DEFAULT_SIZE = 14;
export const LINE_GAP = 2;

// Text fitting: up to three shrink steps, each 12% smaller.
export const FIT_STEPS = 3;
export const FIT_FACTOR = 0.88;
export const ELLIPSIS = '...';

// The two automatic colors chosen to suit the picture.
export const DARK_TEXT = '#202020';
export const LIGHT_TEXT = '#F0F0F0';

// Field names are lowercase and must match exactly.
const FIELDS = ['title', 'artist', 'album', 'track', 'playlist'];
const FIELD_SET = new Set(FIELDS);

const COLOR_RE = /^#([0-9a-fA-F]{6})$/;

// A field with nothing for us to print counts as missing. Whitespace-only
// tags are real content, so they are kept.
function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizePieces(line) {
  // A single-piece line may be written as a plain string.
  return typeof line === 'string' ? [line] : Array.isArray(line) ? line : [];
}

/**
 * Build the final text of one line.
 *
 * Field pieces are replaced by their track values; every other piece is
 * printed as written. A literal between two fields survives only when the
 * fields on both sides have values; a literal at the start or end survives
 * only when the field beside it has a value. A line made entirely of
 * literals has no fields to gate on, so it is printed as written.
 *
 * Returns '' when nothing is left; the caller skips such a line.
 */
export function composeLine(line, track) {
  const pieces = normalizePieces(line);
  const values = track || {};
  const present = new Array(pieces.length).fill(false);
  let fieldCount = 0;

  pieces.forEach((piece, i) => {
    if (FIELD_SET.has(piece)) {
      present[i] = hasValue(values[piece]);
      fieldCount += 1;
    }
  });

  // No fields at all: fixed text with nothing to depend on stays as written.
  if (fieldCount === 0) {
    return pieces.filter((piece) => typeof piece === 'string').join('');
  }

  let out = '';
  pieces.forEach((piece, i) => {
    if (FIELD_SET.has(piece)) {
      if (present[i]) out += String(values[piece]);
      return;
    }
    if (typeof piece !== 'string') return;

    // Nearest field on each side decides whether this literal was only
    // there to separate or introduce a field.
    let left = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (FIELD_SET.has(pieces[j])) { left = j; break; }
    }
    let right = null;
    for (let j = i + 1; j < pieces.length; j += 1) {
      if (FIELD_SET.has(pieces[j])) { right = j; break; }
    }

    if (left !== null && right !== null) {
      if (present[left] && present[right]) out += piece;
    } else if (left !== null) {
      if (present[left]) out += piece;
    } else if (right !== null && present[right]) {
      out += piece;
    }
  });
  return out;
}

// Default measurer: the PSP system font metrics are supplied by the
// platform layer. Tests and offline tooling use this deterministic
// approximation, which assumes a monospace font at 0.6 * size per glyph.
export function defaultMeasure(text, size) {
  return Math.round(Array.from(String(text)).length * size * 0.6);
}

/**
 * Fit text into maxWidth pixels.
 *
 * First shrink up to three times, each step 12% smaller (roughly two
 * thirds of size after three). If it still does not fit, cut it short and
 * add "...". Returns the text to draw, the size used and whether it was
 * truncated.
 */
export function fitText(text, size, maxWidth, measure = defaultMeasure) {
  const sizes = [size];
  for (let step = 1; step <= FIT_STEPS; step += 1) {
    sizes.push(Math.round(size * FIT_FACTOR ** step));
  }

  for (const candidate of sizes) {
    if (measure(text, candidate) <= maxWidth) {
      return { text, size: candidate, truncated: false };
    }
  }

  const minSize = sizes[sizes.length - 1];
  const chars = Array.from(String(text));
  let cut = chars.length;
  while (cut > 0 && measure(chars.slice(0, cut).join('') + ELLIPSIS, minSize) > maxWidth) {
    cut -= 1;
  }
  return { text: chars.slice(0, cut).join('') + ELLIPSIS, size: minSize, truncated: true };
}

/**
 * Validate an explicit "#RRGGBB" color. Anything else (short form, color
 * names, missing value) is invalid and falls back to automatic choice.
 * Returns the canonical upper-case color or null.
 */
export function parseColor(color) {
  if (typeof color !== 'string') return null;
  const match = COLOR_RE.exec(color);
  return match ? `#${match[1].toUpperCase()}` : null;
}

/**
 * Choose dark or light text from the opaque pixels of the picture inside
 * an area. Light pictures get #202020, dark pictures get #F0F0F0.
 *
 * image is an RGBA matrix-like object: { width, height, data } with four
 * bytes per pixel, as produced by canvas getImageData. Pixels with little
 * or no alpha do not count; if nothing is opaque enough, light text is
 * used so the label stays readable on a transparent shell.
 */
export function autoTextColor(image, rect) {
  if (!image || !image.data || image.width <= 0 || image.height <= 0) {
    return LIGHT_TEXT;
  }

  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(image.width, rect.x + rect.width);
  const y1 = Math.min(image.height, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return LIGHT_TEXT;

  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = (y * image.width + x) * 4;
      const alpha = image.data[p + 3];
      if (alpha < 128) continue;
      const r = image.data[p];
      const g = image.data[p + 1];
      const b = image.data[p + 2];
      // Rec. 601 luma.
      sum += (0.299 * r) + (0.587 * g) + (0.114 * b);
      count += 1;
    }
  }

  if (count === 0) return LIGHT_TEXT;
  return sum / count >= 128 ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * Cut an area rect back to the screen edges. Returns a clamped rect, or
 * null when the area has no width or height left (it is skipped).
 */
export function clampRect(rect, screenWidth = DEFAULT_SCREEN_WIDTH, screenHeight = DEFAULT_SCREEN_HEIGHT) {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const [rawX, rawY, rawW, rawH] = rect;
  const x0 = Math.max(0, Math.min(rawX, screenWidth));
  const y0 = Math.max(0, Math.min(rawY, screenHeight));
  const x1 = Math.max(0, Math.min(rawX + rawW, screenWidth));
  const y1 = Math.max(0, Math.min(rawY + rawH, screenHeight));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  return { x: x0, y: y0, width, height };
}

/**
 * Lay out one area.
 *
 * area: { rect, size?, align?, color?, lines? }
 * track: { title?, artist?, album?, track?, playlist? }
 * options:
 *   - image: decoded RGBA picture for automatic color choice
 *   - measure(text, size): text width in pixels
 *   - screenWidth/screenHeight: screen size in pixels
 *
 * Returns { rect, align, color, lines } where lines are the visible ones,
 * each { text, size, x, y, width, truncated }, stacked size+2 pixels
 * apart and centered as a block within rect. Returns null when the area
 * has no width or height on screen.
 */
export function layoutArea(area, track, options = {}) {
  const screenWidth = options.screenWidth ?? DEFAULT_SCREEN_WIDTH;
  const screenHeight = options.screenHeight ?? DEFAULT_SCREEN_HEIGHT;
  const measure = options.measure || defaultMeasure;

  const clamped = clampRect(area && area.rect, screenWidth, screenHeight);
  if (!clamped) return null;

  const size = Math.max(1, Math.round(area.size || DEFAULT_SIZE));
  const align = area.align === 'center' || area.align === 'right' ? area.align : 'left';
  const color = parseColor(area.color)
    || autoTextColor(options.image, clamped);

  const inputLines = Array.isArray(area.lines) ? area.lines : [];
  const visible = [];
  for (const line of inputLines) {
    const text = composeLine(line, track);
    if (text === '') continue; // whole empty lines are skipped

    const fit = fitText(text, size, clamped.width, measure);
    const width = measure(fit.text, fit.size);
    visible.push({ text, fit, width });
  }

  const pitch = size + LINE_GAP;
  const blockHeight = visible.length === 0 ? 0
    : visible.length * size + (visible.length - 1) * LINE_GAP;
  const top = clamped.y + Math.round((clamped.height - blockHeight) / 2);

  const lines = visible.map((entry, i) => {
    const y = top + i * pitch;
    let x;
    if (align === 'center') {
      x = clamped.x + Math.round((clamped.width - entry.width) / 2);
    } else if (align === 'right') {
      x = clamped.x + clamped.width - entry.width;
    } else {
      x = clamped.x;
    }
    return {
      text: entry.fit.text,
      size: entry.fit.size,
      x,
      y,
      width: entry.width,
      truncated: entry.fit.truncated,
    };
  });

  return { rect: clamped, align, color, lines };
}

/**
 * Lay out every area of a parsed skin.json, applying the top-level
 * defaults and the documented limits (at most 8 areas, 4 lines each,
 * 6 pieces per line). Returns one entry per area, with null entries for
 * areas that end up with no width or height on screen.
 */
export function layoutSkin(skin, track, options = {}) {
  const defaults = (skin && skin.defaults) || {};
  const areas = Array.isArray(skin && skin.areas) ? skin.areas.slice(0, 8) : [];

  return areas.map((rawArea) => {
    const rawLines = Array.isArray(rawArea.lines) ? rawArea.lines : [];
    const lines = rawLines.slice(0, 4).map((line) => (
      typeof line === 'string' ? line : Array.isArray(line) ? line.slice(0, 6) : line
    ));
    const area = {
      rect: rawArea.rect,
      size: rawArea.size ?? defaults.size ?? DEFAULT_SIZE,
      align: rawArea.align ?? defaults.align ?? 'left',
      color: rawArea.color ?? defaults.color,
      lines,
    };
    return layoutArea(area, track, options);
  });
}
