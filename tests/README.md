# Startup reliability tests

These tests run **fully offline** on Node's built-in test runner: no
`npm install`, no network, no browser.

```sh
node --test
```

(Node ≥ 18.  On Windows, if `node` is not on `PATH`:
`"/c/Program Files/nodejs/node" --test`.)

## What is covered

| File | Path exercised |
| --- | --- |
| `precache-list.test.js` | The `CACHE_URLS` list in `serviceWorker.js` stays aligned with the startup resources in `src/run.js`, the splash screen CSS, `manifest.json` and `fonts.css`; entries are unique and absolute; the splash markup exposes the error-state hooks. |
| `service-worker.test.js` | Install precaches the manifest; a missing asset does not abort the rest of the install; `fetch` serves from cache when the network fails; **`fetch` resolves with an explicit 503 when offline and uncached** instead of rejecting `respondWith()`; non-GET and non-http requests are not intercepted; activation removes old caches. |
| `startup-chain.test.js` | Happy path ordering (resume → samples → waves → one `GSDAW` → `$init`); the Firefox notice; a rejected load, a `<script>` error event, a hung load and a throwing `$init` each put the splash screen into `data-error`; retry reuses the DAW instance and the single click handler; a failed `<script>` tag is removed before retry. |

`helpers/dom.js` is a minimal fake DOM; `helpers/harness.js` loads the real
`serviceWorker.js` and `src/run.js` inside `node:vm` sandboxes and stubs only
the globals those files consume (`GSUloadJSFile`, `GSDAW`, `gswaContext`,
`caches`, `fetch`, …). The service worker and the startup script under test are
the real files — only their environment is simulated.

## Manual offline check

`tests/offline-sample/` exercises the same three paths in a real browser. It
loads the **real** `serviceWorker.js` and `src/run.js` over HTTP and drives them
with stubs (no DAW, no assets needed):

```sh
node tests/offline-sample/serve.js . 8123
# open http://127.0.0.1:8123/tests/offline-sample/sample.html
# or, headless, add ?auto and inspect the report blocks
```

The page is a diagnostic harness, not part of the shipped app. It was verified
headless with Chrome 157 (`--headless=new --virtual-time-budget=8000
--dump-dom "...?auto"`): all three checks report `PASS`.
