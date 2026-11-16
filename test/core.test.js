/*
 * VoxelWeave Studio — local verification, part 1: core engine.
 *
 * Runs with the Node runtime only (no npm install, no network):
 *   node test/core.test.js
 *
 * Covers:
 *   1. Over-limit rejection — per-field caps, cell-count cap, total-pixel cap,
 *      and that the reported field identifies exactly which item is over.
 *   2. Illegal input fallback — non-positive / non-integer values never
 *      produce a canvas; the previous render stays untouched.
 *   3. Manifest parameter consistency — after editing inputs without
 *      regenerating, the manifest still records the last successful snapshot.
 *   4. Grid geometry — cell count = rows × columns, square cells, flush
 *      tiling with no padding.
 */
'use strict';

var assert = require('assert');
var VW = require('../voxelweave.js');

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (e) {
    console.error('  FAIL - ' + name);
    console.error('        ' + (e && e.stack ? e.stack.split('\n').join('\n        ') : e));
    process.exitCode = 1;
  }
}
function group(title) { console.log('\n' + title); }

/* Minimal canvas double recording every fillRect call. */
function makeCanvasDouble() {
  var calls = [];
  return {
    width: 0,
    height: 0,
    calls: calls,
    getContext: function () {
      return {
        fillStyle: null,
        fillRect: function (x, y, w, h) { calls.push({ x: x, y: y, w: w, h: h }); }
      };
    },
    toDataURL: function () { return 'data:image/png;base64,AAAA'; }
  };
}

var PALETTE = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'];

/* ------------------------------------------------------------------ */
group('1. Positive-integer validation and per-field upper limits');

test('accepts valid positive integers (including numeric strings)', function () {
  var r = VW.validateParams({ rows: '4', columns: 8, cellSize: 16 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.params, { rows: 4, columns: 8, cellSize: 16 });
});

[0, -1, 1.5, '0', '-3', '2.0', 'abc', '', ' ', null, undefined, NaN, Infinity, true].forEach(function (bad) {
  test('rejects illegal row value: ' + JSON.stringify(bad), function () {
    var r = VW.validateParams({ rows: bad, columns: 4, cellSize: 8 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.field, 'rows');
  });
});

test('cell size of 0 is rejected (the original hang bug)', function () {
  var r = VW.validateParams({ rows: 8, columns: 8, cellSize: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CELL_SIZE_NOT_POSITIVE_INTEGER');
  assert.strictEqual(r.error.field, 'cellSize');
});

test('rows over the per-field cap name the rows field', function () {
  var r = VW.validateParams({ rows: VW.LIMITS.MAX_ROWS + 1, columns: 4, cellSize: 8 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'ROWS_TOO_LARGE');
  assert.strictEqual(r.error.field, 'rows');
  assert.strictEqual(r.error.value, VW.LIMITS.MAX_ROWS + 1);
  assert.strictEqual(r.error.limit, VW.LIMITS.MAX_ROWS);
});

test('columns over the per-field cap name the columns field', function () {
  var r = VW.validateParams({ rows: 4, columns: 100000, cellSize: 8 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.field, 'columns');
  assert.strictEqual(r.error.code, 'COLUMNS_TOO_LARGE');
});

test('cell size over the per-field cap name the cellSize field', function () {
  var r = VW.validateParams({ rows: 4, columns: 4, cellSize: 1024 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.field, 'cellSize');
  assert.strictEqual(r.error.code, 'CELL_SIZE_TOO_LARGE');
});

/* ------------------------------------------------------------------ */
group('2. Combined safety thresholds (linked validation)');

test('cell-count cap rejects huge rows×columns even when each field is in range', function () {
  // 300 × 300 = 90,000 cells > 65,536; every individual field is ≤ 512.
  var r = VW.validateParams({ rows: 300, columns: 300, cellSize: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CELL_COUNT_TOO_LARGE');
  assert.strictEqual(r.error.field, 'cellCount');
  assert.strictEqual(r.error.value, 90000);
});

test('total-pixel cap rejects rows×columns×cellSize^2 over the safety threshold', function () {
  // 200×200 cells of 32px => 40,000 cells (under cell cap) but
  // 6400×6400 = 40,960,000 px > 16,777,216.
  var r = VW.validateParams({ rows: 200, columns: 200, cellSize: 32 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'TOTAL_PIXELS_TOO_LARGE');
  assert.strictEqual(r.error.field, 'totalPixels');
  assert.strictEqual(r.error.widthPx, 6400);
  assert.strictEqual(r.error.heightPx, 6400);
  assert.ok(/pixels/.test(r.error.message), 'message states which item is over: ' + r.error.message);
});

test('boundary: exactly the pixel limit is accepted, one pixel over is rejected', function () {
  // 4096×4096 = 16,777,216 == limit, cells 256×256 = 65,536 == cell cap.
  var atLimit = VW.validateParams({ rows: 256, columns: 256, cellSize: 16 });
  assert.strictEqual(atLimit.ok, true);
  var over = VW.validateParams({ rows: 256, columns: 256, cellSize: 17 });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.error.code, 'TOTAL_PIXELS_TOO_LARGE');
});

test('error message always identifies the offending item plainly', function () {
  var r = VW.validateParams({ rows: 200, columns: 200, cellSize: 32 });
  assert.ok(r.error.message.indexOf('40,960,000') !== -1);
  assert.ok(r.error.message.indexOf(String(VW.LIMITS.SAFE_TOTAL_PIXELS.toLocaleString())) !== -1);
});

/* ------------------------------------------------------------------ */
group('3. Failed validation leaves the previous canvas untouched');

test('rejected generation never reaches rendering; prior render is preserved', function () {
  var canvas = makeCanvasDouble();

  // First, a successful generation.
  var good = VW.validateParams({ rows: 4, columns: 6, cellSize: 8 });
  assert.strictEqual(good.ok, true);
  var goodModel = VW.buildGridModel(good.params, PALETTE);
  VW.renderGrid(canvas, goodModel);
  var callsAfterGood = canvas.calls.length;
  assert.strictEqual(canvas.width, 48);
  assert.strictEqual(canvas.height, 32);

  // Then an illegal attempt (cellSize 0) — validation fails first.
  var bad = VW.validateParams({ rows: 4, columns: 6, cellSize: 0 });
  assert.strictEqual(bad.ok, false);
  // Simulating the UI contract: renderGrid is simply not called on failure,
  // so no new fillRect calls and no dimension changes occurred.
  assert.strictEqual(canvas.calls.length, callsAfterGood);
  assert.strictEqual(canvas.width, 48);
  assert.strictEqual(canvas.height, 32);

  // And an over-limit attempt likewise changes nothing.
  var huge = VW.validateParams({ rows: 9999, columns: 9999, cellSize: 9999 });
  assert.strictEqual(huge.ok, false);
  assert.strictEqual(canvas.calls.length, callsAfterGood);
});

/* ------------------------------------------------------------------ */
group('4. Grid geometry matches validated parameters');

test('cell count equals rows × columns and each cell is cellSize × cellSize', function () {
  var params = { rows: 5, columns: 7, cellSize: 12 };
  var model = VW.buildGridModel(params, PALETTE);
  assert.strictEqual(model.cellCount, 35);
  assert.strictEqual(model.cells.length, 35);
  assert.strictEqual(model.widthPx, 84);
  assert.strictEqual(model.heightPx, 60);
  model.cells.forEach(function (cell) {
    assert.strictEqual(cell.size, 12);
  });
});

test('cells tile flush: contiguous offsets, no padding/gutter on any edge', function () {
  var params = { rows: 3, columns: 4, cellSize: 10 };
  var model = VW.buildGridModel(params, PALETTE);
  model.cells.forEach(function (cell) {
    assert.strictEqual(cell.x, cell.column * 10);
    assert.strictEqual(cell.y, cell.row * 10);
  });
  // First cell starts at the origin and last cell ends exactly at the edge —
  // nothing sticks out, no margin is reserved, so the sheet repeats cleanly.
  assert.strictEqual(model.cells[0].x, 0);
  assert.strictEqual(model.cells[0].y, 0);
  var last = model.cells[model.cells.length - 1];
  assert.strictEqual(last.x + last.size, model.widthPx);
  assert.strictEqual(last.y + last.size, model.heightPx);
});

test('every palette color is used deterministically (Rule of Return)', function () {
  var model = VW.buildGridModel({ rows: 2, columns: 3, cellSize: 4 }, PALETTE);
  var used = model.cells.map(function (c) { return c.color; });
  PALETTE.forEach(function (color) {
    assert.ok(used.indexOf(color) !== -1, color + ' should appear');
  });
  // Deterministic: same inputs yield the same assignment.
  var again = VW.buildGridModel({ rows: 2, columns: 3, cellSize: 4 }, PALETTE);
  assert.deepStrictEqual(again.cells.map(function (c) { return c.color; }), used);
});

/* ------------------------------------------------------------------ */
group('5. Manifest parameter consistency via the shared success snapshot');

test('manifest records the snapshotted params, not later input edits', function () {
  var canvas = makeCanvasDouble();

  // Successful generation A.
  var paramsA = VW.validateParams({ rows: 4, columns: 4, cellSize: 8 }).params;
  var modelA = VW.buildGridModel(paramsA, PALETTE);
  VW.renderGrid(canvas, modelA);
  var snapshot = VW.createSnapshot(paramsA, PALETTE, '2026-11-17T10:00:00.000Z');

  // User now edits the input boxes but does NOT regenerate.
  var edited = VW.validateParams({ rows: 64, columns: 64, cellSize: 32 });
  assert.strictEqual(edited.ok, true); // the new inputs would be legal...
  // ...but export still reads the one shared snapshot.
  var manifest = VW.buildManifest(snapshot);
  assert.strictEqual(manifest.rows, 4);
  assert.strictEqual(manifest.columns, 4);
  assert.strictEqual(manifest.cellSize, 8);
  assert.strictEqual(manifest.cellCount, 16);
  assert.strictEqual(manifest.widthPx, 32);
  assert.strictEqual(manifest.heightPx, 32);
  assert.deepStrictEqual(manifest.palette, PALETTE);
  assert.strictEqual(manifest.tileable, true);
});

test('export with no successful snapshot fails loudly instead of inventing data', function () {
  assert.throws(function () { VW.buildManifest(null); }, /No successful generation/);
});

test('manifest is a detached copy: mutating it cannot corrupt the snapshot', function () {
  var params = VW.validateParams({ rows: 2, columns: 2, cellSize: 4 }).params;
  var snapshot = VW.createSnapshot(params, PALETTE, '2026-11-17T10:00:00.000Z');
  var manifest = VW.buildManifest(snapshot);
  manifest.rows = 999;
  manifest.palette.push('#000000');
  assert.strictEqual(snapshot.rows, 2);
  assert.strictEqual(snapshot.palette.length, PALETTE.length);
});

/* ------------------------------------------------------------------ */
group('6. Palette parsing');

test('accepts 3- and 6-digit hex, comma/space/newline separated, deduped', function () {
  var r = VW.parsePalette('#abc, #2a9d8f\n#abc  #E76F51;');
  assert.deepStrictEqual(r.colors, ['#aabbcc', '#2a9d8f', '#e76f51']);
  assert.deepStrictEqual(r.invalid, []);
});

test('flags invalid tokens without throwing', function () {
  var r = VW.parsePalette('#fff, blue, 123, #gggggg');
  assert.deepStrictEqual(r.colors, ['#ffffff']);
  assert.deepStrictEqual(r.invalid, ['blue', '123', '#gggggg']);
});

console.log('\n' + passed + ' core checks passed' + (process.exitCode ? ' (with failures)' : ''));
