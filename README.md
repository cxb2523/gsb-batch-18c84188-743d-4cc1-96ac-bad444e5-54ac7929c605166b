# 🎨 VoxelWeave Studio — Palette-Grid Texture Forge

A small, fully offline browser tool that weaves a color palette into a
tileable low-poly texture grid and exports a PNG atlas together with a
machine-readable palette manifest. No build step, no dependencies, no network
requests — open the page and it works.

## Run it

Open `index.html` directly in any current browser (double-click is enough;
the page uses only local, same-directory resources).

1. Set **Rows**, **Columns**, and **Cell size (px)**.
2. Enter a palette of hex colors (comma/space/newline separated).
3. Press **Weave** to generate the grid.
4. Press **Export atlas + manifest** to download `voxelweave-atlas.png` and
   `voxelweave-manifest.json`.

## Parameter validation and safety limits

The Weave entry point performs linked validation before touching the canvas.
Every numeric parameter must be a positive integer, and the combination is
checked against safety thresholds so a request can never pin the page or
produce an untilable sheet.

| Parameter | Rule |
|---|---|
| Rows | positive integer, 1–512 |
| Columns | positive integer, 1–512 |
| Cell size | positive integer, 1–256 px |
| Cell count (rows × columns) | ≤ 65,536 cells |
| Total output pixels `(rows × cellSize) × (columns × cellSize)` | ≤ 16,777,216 px |

When a check fails:

- a visible error banner appears **and** the offending input is highlighted
  with an inline message naming the exact item and limit that was exceeded;
- the previous canvas is preserved byte-for-byte — nothing is cleared and no
  half-written grid is ever painted;
- the export button stays bound to the last successful generation.

## Generated grid guarantees

For a validated request with parameters `(rows, columns, cellSize)`:

- the grid contains exactly `rows × columns` cells;
- every cell is a solid `cellSize × cellSize` square;
- cells are laid flush with no padding or gutter, so the sheet tiles
  edge-to-edge seamlessly (the first cell starts at pixel `0,0` and the last
  cell ends exactly at the sheet border);
- every palette color is used, deterministically — the same inputs always
  produce the same grid.

## Success snapshot shared by generation and export

Editing an input does **not** change what gets exported. Each successful
Weave writes one immutable snapshot (parameters, palette, derived dimensions,
timestamp) and both the canvas and the manifest are derived from that single
snapshot. If you change a field without pressing Weave again, the exported
manifest still records the parameters of the last successful generation.
Exporting before any successful generation is disabled in the UI and throws in
the engine rather than inventing data.

## Project layout

```
index.html          UI: inputs, validation display, canvas, export
voxelweave.js       Pure engine: validation, grid model, rendering, snapshot/manifest
test/core.test.js   Node verification (32 checks, no browser needed)
test/smoke.html     Browser harness driving the real production page
test/browser.smoke.js  Headless Chrome/Edge runner for smoke.html
test/README.md      How to run the verification samples
```

## Running the verification samples

```sh
node test/core.test.js          # pure engine: limits, fallback, manifest consistency
node test/browser.smoke.js      # real DOM/canvas/export in headless Chrome
```

See [`test/README.md`](test/README.md) for details, including how to point the
runner at a specific browser binary.

## Security note

An earlier revision of this repository shipped an obfuscated `index.html`
loader that decoded a redirect to an external third-party domain, plus a
scheduled GitHub Actions workflow that fabricated commit activity. Both have
been removed. The current application is plain, readable HTML/JavaScript with
no obfuscation and no external resources; the only network-capable surface is
the browser's local file download for your own exports.

## License

MIT
