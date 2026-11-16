# VoxelWeave Studio — local verification samples

These samples run entirely on this machine with no network access and no
package installation. They exercise the same generation/export code paths the
production page uses — there is no separate command-line tool, only test
harnesses around the shared engine in `../voxelweave.js`.

## What is covered

| Requirement | Core test (`core.test.js`) | Browser smoke (`smoke.html` via `browser.smoke.js`) |
|---|---|---|
| Over-limit rejection (per-field rows/columns/cell-size caps) | ✓ | ✓ |
| Combined cell-count safety cap | ✓ | ✓ |
| Combined total-pixel safety threshold, message names the item | ✓ | ✓ |
| Illegal input (0, negative, blank, fractional, non-numeric) rejected | ✓ | ✓ |
| Failed generation keeps the previous canvas untouched (no half-written output) | ✓ (canvas double) | ✓ (real canvas, pixel-for-pixel comparison) |
| Cell count = rows × columns, cells exactly `cellSize` px, flush tiling | ✓ | ✓ (pixel-level) |
| Manifest records last successful snapshot, not edited input values | ✓ | ✓ (real export path) |
| Offline, no external resources | — | ✓ (asserts only local scripts/subresources) |

## Running

### 1. Core engine — Node only

```sh
node test/core.test.js
```

Exits non-zero if any check fails. A minimal in-file canvas double records
every `fillRect`, so no browser is needed for these 32 checks.

### 2. Real-browser smoke test — headless Chrome/Edge

```sh
node test/browser.smoke.js
# or point at a specific browser:
CHROME_BIN="C:/path/to/chrome.exe" node test/browser.smoke.js
```

The runner launches the system Chrome/Edge headlessly against
`test/smoke.html`, which loads the production `index.html` in an iframe and
drives its real buttons and inputs (the exact human code path). It then
prints each check and exits non-zero on any failure.

The browser is given a throwaway profile under the OS temp directory and the
flags `--disable-background-networking` etc.; everything is loaded from local
`file://` URLs, so the run also proves the page works offline.

## Limits under test (defined in `voxelweave.js`)

- Rows: positive integer, ≤ 512
- Columns: positive integer, ≤ 512
- Cell size: positive integer, ≤ 256 px
- Cell count (rows × columns): ≤ 65,536
- Total output pixels (rows × cellSize) × (columns × cellSize): ≤ 16,777,216
