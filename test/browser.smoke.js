/*
 * VoxelWeave Studio — local verification, part 2: real browser smoke test.
 *
 * Drives the production index.html inside headless Chrome (real DOM, real
 * canvas, real click/export code paths). No npm packages, no network access:
 * everything is loaded from local file:// URLs with a throwaway profile.
 *
 * Why not plain spawnSync + --dump-dom? On Windows, headless Chrome often
 * prints the DOM and then keeps utility processes (crashpad etc.) alive with
 * the stdout pipe open, which makes a synchronous spawn wait until its timeout
 * even though the page finished long ago. This runner therefore:
 *   1. redirects --dump-dom output to a temp file,
 *   2. polls until the harness marker appears,
 *   3. terminates only the exact browser PID it launched (never by name),
 *   4. parses the structured results from the saved DOM.
 *
 * Usage:
 *   node test/browser.smoke.js
 * or with an explicit browser binary:
 *   CHROME_BIN="C:/path/to/chrome.exe" node test/browser.smoke.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var SMOKE_URL = 'file://' + path.join(ROOT, 'test', 'smoke.html').replace(/\\/g, '/');
var STAMP = Date.now() + '-' + process.pid;
var OUT = path.join(os.tmpdir(), 'voxelweave-smoke-' + STAMP + '.html');
var PROFILE = path.join(os.tmpdir(), 'voxelweave-profile-' + STAMP);

var CANDIDATES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function findBrowser() {
  for (var i = 0; i < CANDIDATES.length; i++) {
    try { if (fs.existsSync(CANDIDATES[i])) return CANDIDATES[i]; } catch (e) {}
  }
  return null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows may briefly hold file handles inside a just-killed browser tree;
// retry the removal instead of littering the temp directory.
function rmRetry(target, retries) {
  for (var i = 0; i < retries; i++) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) {}
    try {
      if (!fs.existsSync(target)) return true;
    } catch (e) { return true; }
    sleep(250);
  }
  return false;
}

function launch(bin, profileDir, outFile) {
  var args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    // file:// pages are treated as unique origins; allow the local harness to
    // inspect the same-directory production page (no network involved).
    '--allow-file-access-from-files',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    // Minimize on-disk state so the throwaway profile is small and releases
    // quickly; the harness only needs a local canvas, no HTTP cache at all.
    '--disk-cache-dir=/dev/null',
    '--disk-cache-size=1',
    '--disable-features=OptimizationHints,MediaRouter,OptimizationGuideModelDownloading',
    '--user-data-dir=' + profileDir,
    '--timeout=20000',
    '--virtual-time-budget=8000',
    '--dump-dom',
    SMOKE_URL
  ];
  var outFd;
  try { outFd = fs.openSync(outFile, 'w'); } catch (e) { outFd = 'ignore'; }
  var child = childProcess.spawn(bin, args, {
    stdio: ['ignore', outFd, 'ignore'],
    windowsHide: true
  });
  return child;
}

// Terminates only the specific process tree rooted at the PID we started.
// Uses /T to take down the browser's own child utility processes; it never
// matches browsers by image name, so unrelated Chrome instances are safe.
function terminateTree(child) {
  try {
    if (process.platform === 'win32') {
      childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) { /* already gone */ }
}

function runOnce(bin, attempt) {
  var profileDir = PROFILE + '-try' + attempt;
  var outFile = OUT + '.try' + attempt;
  rmRetry(profileDir, 2);
  try { fs.rmSync(outFile, { force: true }); } catch (e) {}

  var child = launch(bin, profileDir, outFile);
  var deadline = Date.now() + 40000;
  var dom = null;

  while (Date.now() < deadline) {
    sleep(300);
    try {
      var text = fs.readFileSync(outFile, 'utf8');
      if (text.indexOf('data-smoke-results') !== -1) { dom = text; break; }
    } catch (e) { /* file not written yet */ }
    if (child.exitCode !== null) {
      // Process exited: give the file a moment to flush, then read whatever
      // completed.
      sleep(200);
      try { dom = fs.readFileSync(outFile, 'utf8'); } catch (e2) {}
      break;
    }
  }

  // The harness result (if present) is already on disk; the browser may still
  // be lingering with helper processes, so stop exactly our own process tree.
  terminateTree(child);
  // Give the OS a moment to release the profile's file handles, then remove
  // the throwaway profile with retries.
  sleep(400);
  rmRetry(profileDir, 8);
  return dom;
}

function run() {
  var bin = findBrowser();
  if (!bin) {
    console.error('No Chrome/Edge binary found. Set CHROME_BIN to a browser path.');
    process.exit(2);
  }
  console.log('Browser:', bin);

  // Sweep throwaway profiles/outputs from previous runs first. Their handles
  // are long released by now, unlike the profile the current browser is still
  // releasing. This keeps the temp directory from growing across runs.
  try {
    fs.readdirSync(os.tmpdir()).forEach(function (entry) {
      if (/^voxelweave-(profile|smoke)-/.test(entry)) {
        rmRetry(path.join(os.tmpdir(), entry), 2);
      }
    });
  } catch (e) {}

  var dom = null;
  for (var attempt = 1; attempt <= 3 && !dom; attempt++) {
    dom = runOnce(bin, attempt);
    if (!dom || dom.indexOf('data-smoke-results') === -1) {
      console.warn('Attempt ' + attempt + ' produced no harness result — retrying…');
      dom = null;
    }
  }

  if (!dom) {
    console.error('Browser could not complete the smoke harness after retries.');
    process.exit(2);
  }

  fs.writeFileSync(OUT, dom);
  var m = dom.match(/data-smoke-results="([^"]*)"/);
  if (!m) {
    console.error('Smoke harness marker missing. Dumped DOM saved at:', OUT);
    process.exit(1);
  }
  var results = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

  var failed = 0;
  results.forEach(function (r) {
    if (r.ok) {
      console.log('  ok - ' + r.name);
    } else {
      failed++;
      console.log('  FAIL - ' + r.name + '\n         ' + r.error);
    }
  });
  console.log('\n' + (results.length - failed) + '/' + results.length + ' browser checks passed');
  for (var d = 1; d <= 3; d++) {
    try { fs.rmSync(OUT + '.try' + d, { force: true }); } catch (e) {}
  }
  try { fs.rmSync(OUT, { force: true }); } catch (e) {}
  // Sweep any atlas/manifest downloads the harness triggered (headless
  // Chrome writes them next to its working/temp directory).
  ['voxelweave-atlas.png', 'voxelweave-manifest.json'].forEach(function (name) {
    try { fs.rmSync(path.join(os.tmpdir(), name), { force: true }); } catch (e) {}
    try {
      fs.readdirSync(process.cwd()).filter(function (f) {
        return /^voxelweave-(atlas(?: \(\d+\))?\.png|manifest\.json)$/.test(f);
      }).forEach(function (f) { fs.rmSync(path.join(process.cwd(), f), { force: true }); });
    } catch (e) {}
  });
  process.exit(failed ? 1 : 0);
}

run();
