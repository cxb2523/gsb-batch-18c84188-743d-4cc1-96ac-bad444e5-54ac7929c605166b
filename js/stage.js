// Background stage. js/stage-pyramid.js is the show; this file picks it when the device can run
// it, and otherwise (or if it fails to start) falls back to a black night sky with twinkling stars.
//
// The contract for a stage (main.js calls it once):
//   createStage(canvas, getFrame, after)
//   - canvas: the full-screen <canvas id="stage"> behind the interface.
//   - after: optional promise (a shared mix loading); the show isn't downloaded until it settles,
//     or 8 s have passed, so it doesn't compete with the stems.
//   - getFrame(): call it on EVERY animation frame, even ones you skip drawing; it also advances
//     the bar clock. It returns:
//       meters:   { groove, lead, texture: 0..1 levels of each layer's output,
//                   bass, mid, high: 0..1 band energies, spectrum: Uint8Array(256) analyser bins,
//                   beat: 0..1 phase within the beat, bar: 0..32 position in the loop,
//                   beatIndex: beat number in the loop, or -1 when stopped }
//       active:   { groove, lead, texture } true while that layer is audibly playing
//       playing, bpm
//       fx, fxX:  Audio FX held (0 or 1) and which kind (fxX < 0: low-pass or tape stop)
//       zone:     left edge of the song wheel, as a fraction of the screen width
//       open:     [from, to] the open area between the side panels, as fractions of the width
//                 ([0, 1] when the panels are stacked: phones, portrait)
//       paused:   true while the help dialog covers the screen
//       album:    album id of the first filled layer, or null
//   - Respect prefers-reduced-motion, and keep frames cheap: the interface sits on top.
//
// Visibility: the browser pauses requestAnimationFrame while the tab is hidden, and the first frame
// after it comes back is timestamped as if all the hidden time had elapsed in one step. Every stage
// therefore freezes while hidden — no getFrame(), no drawing — and re-aligns on the first visible
// frame instead of replaying the gap. See startVisibleFrame.

const TAU = Math.PI * 2;

// Subscribe to visibility changes; cb(true) runs when the page becomes visible, cb(false) when it
// is hidden. Both stages register their own listener through this.
export function onVisibility(cb) {
  document.addEventListener('visibilitychange', () => cb(!document.hidden));
}

// Drives `frame(now, resumed)` on requestAnimationFrame, but only while the page is visible.
// While hidden the callback is never invoked: no getFrame() advances the clock and nothing renders,
// so a background tab costs no stage work. The first frame after the page returns gets
// resumed=true, which the stage uses to reset its timing anchors — the hidden duration must never
// be fed to an animation as one large dt, and the musical state snaps to the audio's real position
// rather than catching up through it. A frame that bails before it draws (canvas not laid out yet)
// can return false to keep the resume marker for the next frame. Returns a cancel function.
export function startVisibleFrame(frame) {
  let cancelled = false, resumed = false;
  const markResume = () => { if (!document.hidden) resumed = true; };
  document.addEventListener('visibilitychange', markResume);
  function tick(now) {
    if (cancelled) return;
    requestAnimationFrame(tick);
    if (document.hidden) return; // rAF may still fire in tests and some engines; stay frozen
    const isResume = resumed;
    if (frame(now, isResume) !== false) resumed = false; // a false return holds the marker
  }
  requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    document.removeEventListener('visibilitychange', markResume);
  };
}

// How many times the transport crossed its loop boundary while the page was hidden — the same
// count the running show keeps in its `loops` bookkeeping (it increments whenever the bar wraps).
// The frame data only carries the position inside one cycle, so wall time supplies the total
// movement and the observed in-loop phase anchors it: if the phase moved by d beats within the
// loop, total forward movement is d plus a whole number of loops nearest the wall-time span. If
// the device suspended the audio its phase is frozen, so a span that isn't a whole number of loops
// means nothing played and the count is zero. Pure, so it can be unit-tested.
export function missedLoops({ hiddenMs, bpm, phaseHide, phaseNow, loopBeats }) {
  const beatsHidden = Math.max(0, hiddenMs / 1000 * bpm / 60);
  const wrap = (x) => ((x % loopBeats) + loopBeats) % loopBeats;
  const phaseDelta = wrap(phaseNow - phaseHide);
  const shortest = Math.min(phaseDelta, loopBeats - phaseDelta);
  if (shortest < 0.5) {
    // The phase barely moved: either the audio clock suspended, or an exact whole number of loops
    // returned it to the same beat. Wall time distinguishes the two within a beat of jitter.
    const whole = Math.round(beatsHidden / loopBeats);
    if (whole <= 0 || Math.abs(beatsHidden - whole * loopBeats) > 0.5) return 0;
    return whole;
  }
  // Forward playback: total beats moved is phaseDelta + k*loopBeats, with k nearest the wall time.
  const k = Math.max(0, Math.round((beatsHidden - phaseDelta) / loopBeats));
  const totalMoved = phaseDelta + k * loopBeats;
  return Math.floor((phaseHide + totalMoved) / loopBeats);
}

// Small seeded random, so the stars are in the same places on every load.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function createStarfield(canvas, getFrame) {
  const g = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, dpr = 1, t = 0, last = performance.now();
  let sky = null;
  const twinkle = (() => { const r = rng(11); return Array.from({ length: 70 }, () => ({ x: r(), y: r(), ph: r() * TAU, s: 0.5 + r() })); })();

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw === w && ch === h) return;
    canvas.width = w = cw;
    canvas.height = h = ch;
    if (!w || !h) return;
    // black sky with a static star field, painted once per size
    sky = document.createElement('canvas');
    sky.width = w;
    sky.height = h;
    const s = sky.getContext('2d');
    s.fillStyle = '#000';
    s.fillRect(0, 0, w, h);
    const r = rng(3);
    s.fillStyle = '#fff';
    const n = Math.round((w * h) / (2800 * dpr * dpr));
    for (let k = 0; k < n; k++) {
      s.globalAlpha = 0.25 + r() * 0.75;
      const sz = (r() < 0.06 ? 2 : 1) * dpr;
      s.fillRect(r() * w, r() * h, sz, sz);
    }
    s.globalAlpha = 1;
  }

  let lastDraw = 0;
  function frame(now, resumed) {
    const f = getFrame(); // every visible frame: it also advances the clock
    if (!resumed && now - lastDraw < (f.paused ? 100 : 1000 / 30)) return; // stars don't need more than 30 fps
    resize();
    if (!w || !h) return resumed ? false : undefined; // not laid out; hold a resume for next frame
    // Coming back from a hidden tab: don't treat the hidden time as one long step. Restart the
    // twinkle clock from now and paint immediately, so the sky simply continues from this instant.
    if (resumed) { last = now; lastDraw = 0; }
    lastDraw = now;
    t += reduce.matches ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.drawImage(sky, 0, 0);
    g.fillStyle = '#fff';
    for (const s of twinkle) {
      g.globalAlpha = 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.8 * s.s + s.ph));
      const sz = 1.8 * dpr;
      g.fillRect(s.x * w, s.y * h, sz, sz);
    }
    g.globalAlpha = 1;
  }

  startVisibleFrame(frame);
  return {};
}

// WebGL2 on a real GPU. Software renderers would drag the whole page down, so they get the stars.
function canRunShow() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch (_) { return false; }
}

export function createStage(canvas, getFrame, after = null) {
  if (!canRunShow()) return createStarfield(canvas, getFrame);
  // The show is downloaded after the app starts; keep the clock running meanwhile. The idle loop
  // also freezes while hidden (startVisibleFrame), so no getFrame() runs in a background tab.
  let loading = true;
  const stopIdle = startVisibleFrame(() => { if (loading) getFrame(); });
  Promise.race([Promise.resolve(after).catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
    .then(() => import('./stage-pyramid.js'))
    .then((m) => { m.createPyramid(canvas, getFrame); loading = false; stopIdle(); })
    .catch((err) => {
      console.error('stage failed to start', err);
      loading = false;
      stopIdle();
      const fresh = canvas.cloneNode(); // a canvas that tried WebGL can't give a 2D context
      canvas.replaceWith(fresh);
      createStarfield(fresh, getFrame);
    });
  return {};
}
