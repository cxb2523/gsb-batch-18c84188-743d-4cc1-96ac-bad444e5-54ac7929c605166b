/*
 * VoxelWeave Studio — core engine.
 *
 * Pure, dependency-free logic shared by the browser UI (index.html) and the
 * local verification samples (test/). Nothing in this file touches the network
 * or the DOM, so generation works fully offline and is trivially testable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VoxelWeave = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Limits
   * ------------------------------------------------------------------ */

  // Per-parameter hard caps. Chosen so a single dimension can never pin the
  // page, yet generous enough for real texture atlases.
  var LIMITS = Object.freeze({
    MAX_ROWS: 512,
    MAX_COLUMNS: 512,
    MAX_CELL_SIZE: 256,
    // rows * columns may not exceed this many cells.
    MAX_CELL_COUNT: 65536,
    // (rows * cellSize) * (columns * cellSize) may not exceed this many
    // output pixels. 16 Mi-pixels keeps a 4-bytes-per-pixel ImageData under
    // 64 MiB and leaves headroom on low-end devices.
    SAFE_TOTAL_PIXELS: 16777216
  });

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function isPositiveInteger(value) {
    // Rejects 0, negatives, fractional values, NaN, Infinity, blank strings
    // and non-numeric junk. Numeric strings like "4" are accepted because
    // number inputs report strings.
    if (typeof value === 'boolean') return false;
    if (typeof value === 'string') {
    if (value.trim() === '' || !/^[+-]?\d+$/.test(value.trim())) return false;
      value = Number(value);
    }
    if (typeof value !== 'number' || !isFinite(value)) return false;
    return Math.floor(value) === value && value > 0;
  }

  function toInt(value) {
    return typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
  }

  /* ------------------------------------------------------------------ *
   * Palette
   * ------------------------------------------------------------------ */

  var HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  function normalizeHex(color) {
    var c = String(color).trim().toLowerCase();
    if (!HEX_COLOR_RE.test(c)) return null;
    if (c.length === 4) {
      c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    }
    return c;
  }

  // Accepts comma / whitespace / newline separated hex colors.
  function parsePalette(text) {
    var tokens = String(text == null ? '' : text)
      .split(/[\s,;]+/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
    var colors = [];
    var invalid = [];
    tokens.forEach(function (token) {
      var normalized = normalizeHex(token);
      if (normalized) {
        if (colors.indexOf(normalized) === -1) colors.push(normalized);
      } else {
        invalid.push(token);
      }
    });
    return { colors: colors, invalid: invalid };
  }

  /* ------------------------------------------------------------------ *
   * Validation
   * ------------------------------------------------------------------ */

  // Returns { ok: true, params: {...} } or
  // { ok: false, error: { code, field, message, ...context } }.
  // `field` names the exact input that is over the limit so the UI can point
  // at it ("rows" | "columns" | "cellSize" | "cellCount" | "totalPixels").
  function validateParams(input) {
    var rows = input && input.rows;
    var columns = input && input.columns;
    var cellSize = input && input.cellSize;

    if (!isPositiveInteger(rows)) {
      return fail('ROWS_NOT_POSITIVE_INTEGER', 'rows',
        'Rows must be a positive whole number (1 or greater).');
    }
    rows = toInt(rows);
    if (rows > LIMITS.MAX_ROWS) {
      return fail('ROWS_TOO_LARGE', 'rows',
        'Rows (' + rows + ') exceed the maximum of ' + LIMITS.MAX_ROWS + '.',
        { limit: LIMITS.MAX_ROWS, value: rows });
    }

    if (!isPositiveInteger(columns)) {
      return fail('COLUMNS_NOT_POSITIVE_INTEGER', 'columns',
        'Columns must be a positive whole number (1 or greater).');
    }
    columns = toInt(columns);
    if (columns > LIMITS.MAX_COLUMNS) {
      return fail('COLUMNS_TOO_LARGE', 'columns',
        'Columns (' + columns + ') exceed the maximum of ' + LIMITS.MAX_COLUMNS + '.',
        { limit: LIMITS.MAX_COLUMNS, value: columns });
    }

    if (!isPositiveInteger(cellSize)) {
      return fail('CELL_SIZE_NOT_POSITIVE_INTEGER', 'cellSize',
        'Cell size must be a positive whole number of pixels (1 or greater).');
    }
    cellSize = toInt(cellSize);
    if (cellSize > LIMITS.MAX_CELL_SIZE) {
      return fail('CELL_SIZE_TOO_LARGE', 'cellSize',
        'Cell size (' + cellSize + 'px) exceeds the maximum of ' +
        LIMITS.MAX_CELL_SIZE + 'px.',
        { limit: LIMITS.MAX_CELL_SIZE, value: cellSize });
    }

    var cellCount = rows * columns;
    if (cellCount > LIMITS.MAX_CELL_COUNT) {
      return fail('CELL_COUNT_TOO_LARGE', 'cellCount',
        'Grid would contain ' + cellCount.toLocaleString() +
        ' cells; the safety limit is ' + LIMITS.MAX_CELL_COUNT.toLocaleString() +
        ' (' + rows + ' rows × ' + columns + ' columns). Reduce rows or columns.',
        { limit: LIMITS.MAX_CELL_COUNT, value: cellCount });
    }

    var widthPx = columns * cellSize;
    var heightPx = rows * cellSize;
    var totalPixels = widthPx * heightPx;
    if (totalPixels > LIMITS.SAFE_TOTAL_PIXELS) {
      return fail('TOTAL_PIXELS_TOO_LARGE', 'totalPixels',
        'Output would be ' + widthPx + '×' + heightPx + ' = ' +
        totalPixels.toLocaleString() + ' pixels; the safety limit is ' +
        LIMITS.SAFE_TOTAL_PIXELS.toLocaleString() +
        ' pixels. Lower rows, columns, or cell size.',
        { limit: LIMITS.SAFE_TOTAL_PIXELS, value: totalPixels,
          widthPx: widthPx, heightPx: heightPx });
    }

    return {
      ok: true,
      params: { rows: rows, columns: columns, cellSize: cellSize }
    };
  }

  function fail(code, field, message, extra) {
    var error = { code: code, field: field, message: message };
    if (extra) Object.keys(extra).forEach(function (k) { error[k] = extra[k]; });
    return { ok: false, error: error };
  }

  /* ------------------------------------------------------------------ *
   * Grid model — the deterministic weave
   * ------------------------------------------------------------------ */

  // Pure description of the grid. Cell (r, c) is a cellSize × cellSize square
  // whose top-left pixel is (c * cellSize, r * cellSize). Cells tile flush
  // with one another: there is no padding/gutter, so opposite edges match and
  // the sheet repeats seamlessly.
  function buildGridModel(params, palette) {
    var rows = params.rows;
    var columns = params.columns;
    var cellSize = params.cellSize;
    var cells = new Array(rows * columns);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < columns; c++) {
        var index = r * columns + c;
        cells[index] = {
          row: r,
          column: c,
          x: c * cellSize,
          y: r * cellSize,
          size: cellSize,
          color: palette[index % palette.length]
        };
      }
    }
    return {
      rows: rows,
      columns: columns,
      cellSize: cellSize,
      cellCount: rows * columns,
      widthPx: columns * cellSize,
      heightPx: rows * cellSize,
      cells: cells
    };
  }

  // Paints a grid model onto a canvas-like 2D surface. The surface only needs
  // getContext / width / height, which both HTMLCanvasElement and the test
  // double provide.
  function renderGrid(canvas, model) {
    canvas.width = model.widthPx;
    canvas.height = model.heightPx;
    var ctx = canvas.getContext('2d');
    for (var i = 0; i < model.cells.length; i++) {
      var cell = model.cells[i];
      ctx.fillStyle = cell.color;
      ctx.fillRect(cell.x, cell.y, cell.size, cell.size);
    }
    return canvas;
  }

  /* ------------------------------------------------------------------ *
   * Snapshot & manifest
   * ------------------------------------------------------------------ */

  // The ONE object that both generation and export read from. It is only
  // written after a fully successful generation, so exporting after editing
  // inputs still reports the last successfully generated parameters.
  function createSnapshot(params, palette, nowIso) {
    var model = buildGridModel(params, palette);
    return {
      schemaVersion: 1,
      generatedAt: nowIso || new Date().toISOString(),
      rows: params.rows,
      columns: params.columns,
      cellSize: params.cellSize,
      cellCount: model.cellCount,
      widthPx: model.widthPx,
      heightPx: model.heightPx,
      palette: palette.slice(),
      tileable: true
    };
  }

  // Manifest is derived purely from the success snapshot — never from live
  // input fields.
  function buildManifest(snapshot) {
    if (!snapshot) {
      throw new Error('No successful generation yet; nothing to export.');
    }
    // Deep-ish copy so callers cannot mutate the shared snapshot.
    return JSON.parse(JSON.stringify(snapshot));
  }

  return {
    LIMITS: LIMITS,
    isPositiveInteger: isPositiveInteger,
    normalizeHex: normalizeHex,
    parsePalette: parsePalette,
    validateParams: validateParams,
    buildGridModel: buildGridModel,
    renderGrid: renderGrid,
    createSnapshot: createSnapshot,
    buildManifest: buildManifest
  };
});
