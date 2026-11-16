/**
 * Acceptance harness for the reel-recording fixes. Runs the REAL renderer
 * modules (video/reel.ts, controller.ts, state/store.ts) and the REAL main-
 * process saveReel against controllable fakes — no Electron needed:
 *
 *   1. screen-share track "ended" finalizes the take, keeps the chunks, and
 *      stop() returns a non-empty webm Blob (not an empty one)
 *   2. repeated start() does not stack recorders; stop() with no recorder
 *      still returns an empty Blob (back-compat)
 *   3. a normal full take produces the same Blob shape as before
 *   4. the store/controller chain reflects recording -> saving -> lastSaved,
 *      so ReelControls can show the actual format + path
 *   5. saveReel reports { path, format } for mp4 success, transcode-failure
 *      fallback, and missing-ffmpeg fallback
 *
 * Run: node scripts/verify-reel.cjs
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const ts = require('typescript')

const REPO = path.resolve(__dirname, '..')
let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------- Fake DOM media primitives ----------

class FakeTrack {
  constructor(kind) {
    this.kind = kind
    this.readyState = 'live'
    this.stopped = false
    this._listeners = {}
  }
  addEventListener(type, fn) {
    ;(this._listeners[type] ??= []).push(fn)
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== fn)
  }
  stop() {
    this.stopped = true
    this.readyState = 'ended'
    // Per spec, stop() does NOT fire "ended" — only an external end does.
  }
  fireEnded() {
    this.readyState = 'ended'
    for (const fn of this._listeners.ended ?? []) fn()
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this._tracks = tracks
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio')
  }
  getTracks() {
    return [...this._tracks]
  }
}

class FakeMediaRecorder {
  static instances = []
  static isTypeSupported() {
    return true
  }
  constructor(stream, options) {
    this.stream = stream
    this.options = options
    this.state = 'inactive'
    this.ondataavailable = null
    this.onstop = null
    FakeMediaRecorder.instances.push(this)
  }
  start(timeslice) {
    this.state = 'recording'
    this.timeslice = timeslice
  }
  /** Test hook: the encoder produced a chunk. */
  emitChunk(bytes) {
    if (this.state !== 'recording') return
    this.ondataavailable?.({ data: new Blob([bytes]) })
  }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    queueMicrotask(() => {
      this.emitFinal()
      this.onstop?.()
    })
  }
  emitFinal() {
    this.ondataavailable?.({ data: new Blob([`final-${FakeMediaRecorder.instances.length}`]) })
  }
}

function makeFakeCanvas() {
  const ctx = {
    fillStyle: '',
    fillRect() {},
    drawImage() {}
  }
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    captureStream: () => new FakeMediaStream([new FakeTrack('video')])
  }
}

function installRendererGlobals() {
  const displayStreams = []
  let displayMediaCalls = 0
  let userMediaCalls = 0

  const fakeDocument = {
    createElement(tag) {
      if (tag === 'canvas') return makeFakeCanvas()
      if (tag === 'video') {
        return {
          srcObject: null,
          muted: false,
          playsInline: false,
          play: () => Promise.resolve()
        }
      }
      throw new Error(`unexpected element: ${tag}`)
    }
  }

  const fakeNavigator = {
    mediaDevices: {
      getUserMedia: async () => {
        userMediaCalls++
        return new FakeMediaStream([new FakeTrack('video')])
      },
      getDisplayMedia: async () => {
        displayMediaCalls++
        const stream = new FakeMediaStream([new FakeTrack('video')])
        displayStreams.push(stream)
        return stream
      }
    }
  }

  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('navigator', fakeNavigator)
  define('window', globalThis)
  define('document', fakeDocument)
  define('MediaStream', FakeMediaStream)
  define('MediaRecorder', FakeMediaRecorder)
  define('requestAnimationFrame', () => 0)
  define('cancelAnimationFrame', () => {})

  return {
    displayStreams,
    stats: () => ({ displayMediaCalls, userMediaCalls })
  }
}

// ---------- TS module loader with stubbed imports ----------

function compileTs(file) {
  const src = fs.readFileSync(file, 'utf8')
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: file
  }).outputText
}

/** Load real repo modules, substituting stubs by resolved absolute path. */
function makeLoader(stubsByPath) {
  const cache = new Map()
  function load(absPath) {
    if (stubsByPath.has(absPath)) return stubsByPath.get(absPath)
    if (cache.has(absPath)) return cache.get(absPath).exports
    const module = { exports: {} }
    cache.set(absPath, module)
    const dir = path.dirname(absPath)
    const localRequire = (spec) => {
      if (!spec.startsWith('.')) return require(spec)
      const base = path.resolve(dir, spec)
      const resolved = fs.existsSync(base) ? base : `${base}.ts`
      return load(resolved)
    }
    const fn = new Function('require', 'module', 'exports', compileTs(absPath))
    fn(localRequire, module, module.exports)
    return module.exports
  }
  return load
}

const R = (...p) => path.join(REPO, 'src', ...p)

// ---------- Renderer: reel.ts + controller.ts + store.ts ----------

async function testRenderer() {
  console.log('\n[renderer] ReelRecorder + controller + store')

  const env = installRendererGlobals()

  const engineStub = {
    reelAudioStream: new FakeMediaStream([new FakeTrack('audio')]),
    attachMic() {},
    detachMic() {},
    setMicLevel() {}
  }
  const analysisStub = {
    analyzeBpm: async () => ({}),
    computeHiPeaks: () => null,
    computePeaks: () => null
  }

  const savedBuffers = []
  const stemdeckStub = {
    mediaAccess: async () => ({ camera: 'granted', microphone: 'granted', screen: 'granted' }),
    requestMediaAccess: async () => true,
    openPrivacySettings: async () => {},
    saveReel: async (data) => {
      savedBuffers.push(data)
      // Simulate the transcode-failure fallback: what landed is WebM.
      return { path: 'C:\\Music\\StemDeck Recordings\\stemdeck-reel-test.webm', format: 'webm' }
    },
    revealPath: async () => {},
    listRecordings: async () => []
  }
  globalThis.window.stemdeck = stemdeckStub

  const load = makeLoader(
    new Map([
      [R('renderer', 'src', 'audio', 'engine.ts'), { engine: engineStub }],
      [R('renderer', 'src', 'audio', 'analysis.ts'), analysisStub],
      [R('renderer', 'src', 'types.ts'), {}]
    ])
  )
  const { ReelRecorder } = load(R('renderer', 'src', 'video', 'reel.ts'))
  const controller = load(R('renderer', 'src', 'controller.ts'))
  const { useStore } = load(R('renderer', 'src', 'state', 'store.ts'))

  // -- 1. repeated start() must not stack recorders -------------------------
  {
    const before = env.stats()
    const rec = new ReelRecorder()
    await rec.start()
    await rec.start()
    const after = env.stats()
    check(
      'second start() is a no-op (one display capture, one recorder)',
      after.displayMediaCalls - before.displayMediaCalls === 1 &&
        FakeMediaRecorder.instances.length === 1,
      `displayMedia=${after.displayMediaCalls - before.displayMediaCalls}, recorders=${FakeMediaRecorder.instances.length}`
    )
    const blob = await rec.stop()
    check('stop() after start resolves a non-empty webm Blob', blob.size > 0 && blob.type === 'video/webm')
  }

  // -- 2. stop() with no recorder stays back-compatible ---------------------
  {
    const blob = await new ReelRecorder().stop()
    check('stop() without a recorder returns an empty webm Blob', blob.size === 0 && blob.type === 'video/webm')
  }

  // -- 3. normal full take: Blob content matches pre-change behavior --------
  {
    const rec = new ReelRecorder()
    await rec.start()
    const mr = FakeMediaRecorder.instances.at(-1)
    mr.emitChunk('chunk-a')
    mr.emitChunk('chunk-b')
    const blob = await rec.stop()
    const text = await blob.text()
    check(
      'full take blob = collected chunks + final flush, typed video/webm',
      blob.type === 'video/webm' && text.includes('chunk-a') && text.includes('chunk-b') && text.includes('final-'),
      `got "${text}"`
    )
  }

  // -- 4. OS-level share end finalizes the take and saves through the store --
  {
    await controller.toggleReelRecording()
    check('store shows recording after start', useStore.getState().reel.recording === true)

    const mr = FakeMediaRecorder.instances.at(-1)
    mr.emitChunk('before-end-1')
    mr.emitChunk('before-end-2')

    // User ends the window share from the system indicator.
    env.displayStreams.at(-1).getVideoTracks()[0].fireEnded()

    // Wait for the controller's stop+save chain to settle.
    const deadline = Date.now() + 2000
    while (useStore.getState().reel.saving && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const reelState = useStore.getState().reel
    check('recorder stopped itself on share end', mr.state === 'inactive')
    check('store no longer shows recording (button cannot lie)', reelState.recording === false)
    check('store no longer saving', reelState.saving === false)
    check(
      'saveReel received the recorded bytes (chunks preserved)',
      savedBuffers.length === 1 && savedBuffers[0].byteLength > 0,
      `calls=${savedBuffers.length} bytes=${savedBuffers[0]?.byteLength}`
    )
    const savedText = Buffer.from(savedBuffers[0]).toString()
    check(
      'saved bytes contain the pre-end chunks',
      savedText.includes('before-end-1') && savedText.includes('before-end-2'),
      `got "${savedText}"`
    )
    check(
      'store.lastSaved carries the actual format + path for the UI',
      reelState.lastSaved?.format === 'webm' &&
        reelState.lastSaved?.path.endsWith('stemdeck-reel-test.webm'),
      JSON.stringify(reelState.lastSaved)
    )

    // Next take clears the previous save note.
    await controller.toggleReelRecording()
    check('starting a new take clears lastSaved', useStore.getState().reel.lastSaved === null)
    await controller.toggleReelRecording()
    const t2 = Date.now() + 2000
    while (useStore.getState().reel.saving && Date.now() < t2) {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

// ---------- Main process: saveReel format/path result ----------

async function testSaveReel() {
  console.log('\n[main] saveReel result reporting')

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-save-'))

  const loadWith = (youtubeStub, execFileImpl) => {
    const childProcessStub = { execFile: execFileImpl }
    return makeLoader(
      new Map([
        [R('main', 'env.ts'), { subprocessEnv: () => ({}) }],
        [R('main', 'youtube.ts'), youtubeStub],
        [path.resolve(REPO, 'node_modules', 'electron'), {}] // never hit; electron is a builtin-style require below
      ])
    )
  }

  // electron and child_process are non-relative requires, so stub them via a
  // require hook instead of the path map.
  const Module = require('module')
  const originalResolve = Module._resolveFilename
  const originalLoad = Module._load

  const electronStub = { app: { getPath: () => outDir } }
  let execFileImpl = null
  let youtubeStub = { findFfmpeg: async () => 'C:/fake/ffmpeg.exe' }

  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return 'electron'
    if (request === 'child_process') return 'child_process'
    return originalResolve.call(this, request, ...args)
  }
  Module._load = function (request, ...args) {
    if (request === 'electron') return electronStub
    if (request === 'child_process') return { execFile: (...a) => execFileImpl(...a) }
    return originalLoad.call(this, request, ...args)
  }

  try {
    const data = new TextEncoder().encode('fake-webm-bytes').buffer

    // 1. transcode succeeds -> mp4
    execFileImpl = (cmd, args, opts, cb) => {
      const out = args[args.length - 1]
      fs.writeFileSync(out, 'mp4-bytes')
      cb(null)
    }
    let { saveReel } = loadWith(youtubeStub)(R('main', 'video.ts'))
    let result = await saveReel(data)
    check(
      'mp4 success reports { format: mp4, path: *.mp4 }',
      result?.format === 'mp4' && result.path.endsWith('.mp4') && fs.existsSync(result.path),
      JSON.stringify(result)
    )

    // 2. transcode fails -> webm fallback, reported as such
    execFileImpl = (cmd, args, opts, cb) => cb(new Error('ffmpeg exploded'))
    ;({ saveReel } = loadWith(youtubeStub)(R('main', 'video.ts')))
    result = await saveReel(data)
    check(
      'transcode failure falls back to webm and says so',
      result?.format === 'webm' && result.path.endsWith('.webm') && fs.existsSync(result.path),
      JSON.stringify(result)
    )
    check(
      'webm fallback keeps the original bytes',
      fs.readFileSync(result.path, 'utf8') === 'fake-webm-bytes'
    )

    // 3. no ffmpeg at all -> webm fallback
    execFileImpl = () => {
      throw new Error('should not be called')
    }
    ;({ saveReel } = loadWith({ findFfmpeg: async () => null })(R('main', 'video.ts')))
    result = await saveReel(data)
    check(
      'missing ffmpeg saves webm and reports it',
      result?.format === 'webm' && result.path.endsWith('.webm') && fs.existsSync(result.path),
      JSON.stringify(result)
    )
  } finally {
    Module._resolveFilename = originalResolve
    Module._load = originalLoad
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}

// Note: makeLoader caches per call site, so each loadWith(...) gets a fresh
// loader and re-evaluates video.ts with its own stubs — that's what we want.

async function main() {
  await testRenderer()
  await testSaveReel()
  console.log(failures === 0 ? '\nAll reel checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
