/* Does the gearchange bark happen when it should, and only then?
 *
 *   node tools/shiftbark.mjs
 *
 * The bark is the one sound in the engine that is an EVENT rather than a
 * layer, which means it is the one sound whose correctness is a question about
 * timing rather than about level. Two things go wrong with it and neither is
 * audible in the mixed output of a scripted scenario that shifts on a
 * metronome:
 *
 *   PAUSED. The pause menu suspends the AudioContext and stops feeding the
 *   engine, so the world does not step. But the gear is read from the car on
 *   every frame, and a car can be moved while the menu is up — a respawn, a
 *   tool setting the world somewhere, a future feature that steps a frozen
 *   sim. The stock implementation compared the gear it was handed with the
 *   gear it remembered, so the first frame after a resume barked for a shift
 *   the player never heard happen. There must be zero barks across a pause,
 *   whatever the gear does inside it, and a genuine shift afterwards must
 *   still bark.
 *
 *   OVERLAPPING. One shared bandpass filter and one shared gain for every
 *   bark means the second shift's automation retargets the first shift's
 *   still-running sweep: the new sweep starts from wherever the old one got
 *   to, and the old burst's tail changes timbre under itself. Two shifts
 *   50 ms apart is an ordinary downshift-then-upshift. Each bark must start
 *   its own sweep from its own f0 on a filter nothing else is writing.
 *
 * The instrument is an OfflineAudioContext and a recording wrapper around
 * `EngineVoice.bark` and around the band frequency's automation methods. It
 * renders nothing that needs a sound card, and — because every random number
 * in src/audio is seeded and the voice runs off a virtual clock — the same
 * script gives the same samples every run.
 *
 * FAILURE IS THE DEFAULT. Every check is a pre-failed row and only a clean
 * path clears its own row; a scenario that throws leaves the rows it did not
 * reach standing, and a run that rendered nothing reports that rather than
 * exiting before the table. The tool has been shown capable of failing: with
 * the shared-filter implementation restored it reports "not every rapid shift
 * started its own sweep" and "the flood reused a band that was still
 * sounding", and with the pause comparison restored it reports a bark across
 * each of the three pause paths.
 *
 * A NOTE ON WHAT THIS DOES NOT REPLACE. tools/audio.mjs owns "does the bark
 * sound right" — level, brightness up versus down, and the throttle-cut dip
 * under it. This one owns "does it fire", which is a different question and is
 * answered without a single spectral measurement.
 */
import { chromium } from 'playwright';
import { serve } from './harness.mjs';
import { finish, guard } from './tame.mjs';

const SR = 44100;
const H = 1 / 60;

/* The ten scenarios this asks about, all rendered in one page. */
const RENDER = async () => {
  const { Audio } = await import('/src/audio/index.js');
  /* Written here as well as at module scope because this function is
     stringified and evaluated in the page, where this module's bindings do
     not exist. */
  const SR = 44100;
  const H = 1 / 60;

  const base = {
    speed: 40, rpm: 0.8, gear: 2, throttle: 1, brake: 0, handbrake: 0,
    slipAngle: 0, wheelSlip: 0, offRoad: 0, airborne: false,
    shoreDistance: 70, shoreDrop: 40, oceanSide: -1,
  };
  const at = o => Object.assign({}, base, o);

  /* One render. `steps` is one descriptor per 60 Hz frame:
   *   { gear }                update() with that gear
   *   { gear, paused: true }  update() told the simulation is frozen
   *   { hold: true }          no update call at all
   *   { viaStop: 'stop' }     Audio.stop() instead of a frame (host path)
   *   { viaStop: 'start' }    Audio.start() instead of a frame
   *
   * A held frame ADVANCES the offline clock by hand, and that is not a
   * convenience: the audio clock is the caller's clock, and the failure being
   * tested is specifically that time passed while the engine was not fed.
   * Offline, `now` only moves when update() moves it, so a hold that left the
   * clock still would model a suspended context — which is the *other*
   * scenario, covered by viaStop — and would make the skipped-frame path look
   * safe when it is not. */
  async function run(dur, steps, soloShift = true) {
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
    const audio = new Audio({ context: ctx });
    await audio.start();
    if (soloShift) {
      /* Solo the bark layer. On the mixed bus a 90 ms broadband event under a
         full-throttle engine is invisible — see the note in engine.js — so
         every render here listens to `shift` alone. The exception is the mixed
         scenario, which exists to check the sum for a click. */
      for (const [name, node] of Object.entries(audio.buses())) {
        node.disconnect();
        if (name === 'shift') node.connect(audio.bus);
      }
    }

    const barks = [];
    const original = audio.engine.bark.bind(audio.engine);
    audio.engine.bark = (t, rpm, throttle, dir, ...rest) => {
      barks.push({ t: +t.toFixed(4), dir });
      return original(t, rpm, throttle, dir, ...rest);
    };

    /* Landing thumps, counted rather than measured. Offline, the continuous
       layers run through the whole render whether or not the simulation is
       being fed — an OfflineAudioContext renders a graph, it does not respect
       "nothing was called" — so RMS over the paused window measures the engine
       bed and not the one-shot. The one-shot is the question: a pause that
       tells the audio the world is frozen must not let the landing edge fire
       into the suspended menu. */
    const thumps = [];
    const origFire = audio.impacts.fire.bind(audio.impacts);
    audio.impacts.fire = (t, s, tone) => {
      thumps.push({ t: +t.toFixed(4), s: +(+s).toFixed(3), tone });
      return origFire(t, s, tone);
    };

    /* Every automation call, tagged with the band it landed on. On a pooled
       filter this is how "the second sweep started from its own f0" is asked;
       on a shared one the same trace shows the first sweep being retargeted. */
    const auto = [];
    const watch = (param, tag) => {
      for (const m of ['setValueAtTime', 'linearRampToValueAtTime',
        'exponentialRampToValueAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) {
        const fn = param[m] && param[m].bind(param);
        if (!fn) continue;
        param[m] = (...a) => {
          auto.push({ band: tag, m, v: +(+a[0]).toFixed(2), t: +(+a[1]).toFixed(4) });
          return fn(...a);
        };
      }
    };
    const bands = audio.engine.barkBands || [audio.engine.barkBand];
    bands.forEach((b, i) => watch(b.frequency, i));
    /* Any band built beyond the pool, if the implementation has one. */
    const freeVoice = audio.engine._freeBarkVoice && audio.engine._freeBarkVoice.bind(audio.engine);
    let extra = 0;
    if (freeVoice) {
      audio.engine._freeBarkVoice = (t) => {
        const before = audio.engine._transientBands ? audio.engine._transientBands.size : 0;
        const v = freeVoice(t);
        const after = audio.engine._transientBands ? audio.engine._transientBands.size : 0;
        if (after > before) watch(v.band.frequency, 'extra' + extra++);
        return v;
      };
    }

    const n = Math.round(dur / H);
    for (let i = 0; i < n; i++) {
      const s = steps[Math.min(i, steps.length - 1)];
      if (s.viaStop === 'stop') { audio.stop(); audio.now += H; continue; }
      if (s.viaStop === 'start') { await audio.start(); continue; }
      /* A placement: the car was set down here, not driven here. Modelled the
         way main.js does it — the caller says so, then the frame arrives in a
         different gear. */
      if (s.place != null) { audio.resync(); continue; }
      if (s.placeSkip) continue;
      if (s.paused) { audio.update(H, at({ gear: s.gear, paused: true })); continue; }
      if (s.hold) { audio.now += H; continue; }
      const extra = s.air ? { airborne: true } : null;
      audio.update(H, at(Object.assign(
        { gear: s.gear, rpm: s.rpm ?? base.rpm, throttle: s.throttle ?? base.throttle },
        extra)));
    }
    const buf = await ctx.startRendering();
    audio.dispose();
    const L = buf.getChannelData(0);

    const rms = (t0, t1) => {
      const a = Math.max(0, Math.floor(t0 * SR)), b = Math.min(L.length, Math.floor(t1 * SR));
      let q = 0;
      for (let i = a; i < b; i++) q += L[i] * L[i];
      return Math.sqrt(q / Math.max(1, b - a));
    };
    let peak = 0, step = 0;
    for (let i = 0; i < L.length; i++) {
      const m = Math.abs(L[i]);
      if (m > peak) peak = m;
      if (i) step = Math.max(step, Math.abs(L[i] - L[i - 1]));
    }
    return { barks, thumps, auto, rms, peak: +peak.toFixed(4), step: +step.toFixed(4) };
  }

  const count = dur => Math.round(dur / H);
  const script = (dur, fn) => Array.from({ length: count(dur) }, (_, i) => fn(i * H));

  const out = {};

  /* A — three upshifts 50 ms apart. Each must get its own band and its own
     sweep from its own f0, and the previous burst must still be audible. */
  out.rapid = await run(2.2, script(2.2, t => ({
    gear: t < 1.0 ? 2 : t < 1.05 ? 3 : t < 1.1 ? 4 : 5,
  })));

  /* B — a pause during which the gear does NOT change. The ordinary case:
     zero barks, and a shift after the resume still barks. */
  out.hold = await run(3.0, script(3.0, t => (
    t < 1.0 ? { gear: 3 } : t < 2.0 ? { hold: true } : { gear: 3 }
  )));
  out.holdThenShift = await run(3.0, script(3.0, t => (
    t < 1.0 ? { gear: 3 } : t < 2.0 ? { hold: true } : t < 2.4 ? { gear: 3 } : { gear: 4 }
  )));

  /* C — a pause across which the gear DID change (something moved the car
     while the menu was up, or a tool placed it). Zero barks, ever. */
  out.moved = await run(3.0, script(3.0, t => (
    t < 1.0 ? { gear: 3 } : t < 2.0 ? { hold: true } : { gear: 2 }
  )));

  /* D — the same, expressed as the host expresses it: Audio.stop() and
     Audio.start(), with updates still arriving for the frozen world. */
  out.hostPause = await run(3.0, script(3.0, t => {
    if (t < 1.0) return { gear: 3 };
    if (t < 1.02) return { viaStop: 'stop' };
    if (t < 2.0) return { gear: t < 1.5 ? 1 : 2 };
    if (t < 2.02) return { viaStop: 'start' };
    return { gear: 2 };
  }));

  /* E — the paused flag passed per frame, which is what a render-loop caller
     that keeps feeding state does. */
  out.inbandPause = await run(3.0, script(3.0, t => (
    t < 1.0 ? { gear: 3 } : t < 2.0 ? { paused: true, gear: t < 1.5 ? 1 : 2 } : { gear: 2 }
  )));

  /* F — no pause at all, an ordinary lap of shifts in both directions. The
     control: every real change barks, and up and down are not the same sound. */
  out.driving = await run(3.0, script(3.0, t => ({
    gear: t < 0.9 ? 2 : t < 1.7 ? 3 : t < 2.5 ? 2 : 1,
  })));

  /* G — five shifts 20 ms apart, which is more simultaneous barks than any
     drivetrain can produce. The pool must not hand out a band that is still
     sounding; a transient beyond the pool is allowed, a shared sweep is not. */
  out.flood = await run(1.8, script(1.8, t => ({
    gear: t < 1.0 ? 2 : t < 1.02 ? 3 : t < 1.04 ? 4 : t < 1.06 ? 5 : t < 1.08 ? 4 : 3,
  })));

  /* H — the same rapid pair on the mixed bus, to prove the fix did not buy
     correctness with a click. The pool is four filters instead of one, so
     four bursts can sum where there used to be one. */
  out.mixed = await run(2.0, script(2.0, t => ({
    gear: t < 1.0 ? 2 : t < 1.05 ? 3 : t < 1.1 ? 4 : 5,
  })), false);

  /* I — paused MID-AIR, and fed a state that omits `airborne`. This is the
     case that makes "handle the pause by forwarding a fabricated state" wrong
     rather than merely unnecessary: the struct says the car is on the ground,
     and the landing edge in Audio.update fires a suspension thump into a
     paused menu that plays the moment it closes. Two variants, because the two
     ways a caller freezes the world fail differently: `hold` is a caller that
     stops calling (Game.step), `paused` is one that keeps calling (a render
     loop, a capture tool). Neither may produce a thump inside the window. */
  out.pausedAir = await run(3.0, script(3.0, t => {
    if (t < 0.8) return { gear: 3, air: true };
    if (t < 2.0) return { hold: true };
    return { gear: 3, air: false };
  }), false);
  out.pausedAirFed = await run(3.0, script(3.0, t => {
    if (t < 0.8) return { gear: 3, air: true };
    if (t < 2.0) return { paused: true, gear: 3 };
    return { gear: 3, air: false };
  }), false);
  /* The control for the check below: after the menu, airborne false is a real
     landing and exactly one thump is owed. A pause that swallowed it as well
     would pass "no thump while paused" for the wrong reason. */
  const paused = out.pausedAir;
  out.pausedAirThumps = paused.thumps.filter(x => x.t > 0.8 && x.t < 2.0);
  out.landedAfterPause = paused.thumps.length - out.pausedAirThumps.length;
  delete paused.thumps;
  out.pausedAirFedThumps = out.pausedAirFed.thumps.filter(x => x.t > 0.8 && x.t < 2.0);
  delete out.pausedAirFed.thumps;

  /* J — a placement: the car is set down in a different gear. main.js calls
     Audio.resync() from restart, respawn and goTo for exactly this; the frame
     after the placement must not bark, and the next real one must. */
  out.placed = await run(3.0, script(3.0, t => {
    if (t < 1.0) return { gear: 4 };
    if (t < 1.02) return { place: true };
    if (t < 2.0) return { gear: 0 };
    return { gear: 1 };
  }));

  /* Primitive arrays: everything above is plain data. */
  return out;
};

/* Every verdict is a separate row, and every row starts failed. The messages
   are per-check rather than per-question on purpose: four scenarios ask "does
   a gear change across a pause bark" and a shared message would let three of
   them fail invisibly behind one passing entry. */
const FAILS = () => [
  'rapid shifts produced no bark at all',
  'not every rapid shift started its own sweep',
  'a pause with no gear change was not silent',
  'a gear change across a hold barked',
  'a gear change across stop/start barked',
  'a gear change across the paused flag barked',
  'a genuine shift after a resume did not bark',
  'an ordinary change stopped barking',
  'upshift and downshift are no longer distinguishable',
  'the flood reused a band that was still sounding',
  'a rapid pair drives the output past ±1',
  'a pause in mid-air fired a landing thump',
  'a placement barked like a gearchange',
];
const results = FAILS().map(msg => ({ msg, ok: false }));

const check = (ok, msg) => {
  const row = results.find(r => r.msg === msg);
  if (!row) { console.log('  ! unlisted check: ' + msg); return; }
  if (ok) row.ok = true;
};

let out = null;
try {
  const srv = serve();
  await new Promise(r => srv.listen(0, r));
  const origin = `http://localhost:${srv.address().port}`;
  const browser = guard(await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
      '--disable-background-timer-throttling', '--renderer-process-limit=1'],
  }));
  /* No game boot: src/audio has no dependency on the renderer and a syntax
     error in a mesh builder must not take the sound suite down with it. The
     page is fulfilled at the server's own origin so the real modules import. */
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  page.on('pageerror', e => { console.log('  [pageerror] ' + (e.message || e)); });
  await page.route(origin + '/__shiftbark', route => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta charset=utf-8><title>shiftbark</title>',
  }));
  await page.goto(origin + '/__shiftbark', { waitUntil: 'domcontentloaded' });
  out = await page.evaluate(`(${RENDER.toString()})()`);
} catch (e) {
  console.log('  ✗ render failed: ' + ((e && e.stack) || e));
  results[0].ok = false;
}

/* ---- verdicts ----------------------------------------------------------- */

if (!out) {
  console.log('  ✗ nothing rendered — see the error above');
  finish(1);
}

/* A bark's own sweep is a setValueAtTime and a ramp on ONE band, with no other
   bark's automation between them. `sweeps` returns, per bark timestamp, the
   band it landed on and whether its starting value is a fresh f0 rather than a
   continuation of a curve already running on that band. */
const sweeps = (r) => {
  const byBand = new Map();
  for (const a of r.auto) {
    if (!byBand.has(a.band)) byBand.set(a.band, []);
    byBand.get(a.band).push(a);
  }
  const out = [];
  for (const [band, list] of byBand) {
    const starts = list.filter(a => a.m === 'setValueAtTime');
    for (const st of starts) {
      const ramp = list.find(a => a.t > st.t && a.m === 'exponentialRampToValueAtTime');
      out.push({ band, t: st.t, f0: st.v, to: ramp ? ramp.v : null, dur: ramp ? +(ramp.t - st.t).toFixed(4) : null });
    }
  }
  return out.sort((a, b) => a.t - b.t);
};

/* Bands are handed to shifts in order of when they were last used, so two
   consecutive barks must be on different bands unless one has ended. The
   question "did the second sweep start from its own f0" is therefore two
   questions: were the two shifts on different bands, and does the second one's
   setValueAtTime come before the first one's ramp ends without any cancel in
   between. */
const rapid = out.rapid;
const rs = sweeps(rapid);
const upBarks = rapid.barks.filter(b => b.dir > 0);
check(upBarks.length === 3, 'rapid shifts produced no bark at all');

/* Every bark must have a sweep. On a shared filter there is exactly one band
   and three pairs of start/ramp — which is why the band count is the part that
   can tell the implementations apart, not the bark count. */
const distinctBands = new Set(rs.map(s => s.band)).size;
const sw = rs.filter(s => s.to != null);
check(sw.length >= 3 && distinctBands >= 3,
  'not every rapid shift started its own sweep');

/* The sweep shape itself survives: upshifts fall, downshifts rise, and the
   down is longer than the up. Asserted on the ordinary driving scenario. */
const ds = sweeps(out.driving);
const rise = ds.filter(s => s.to > s.f0);
const fall = ds.filter(s => s.to < s.f0);
check(rise.length >= 1 && fall.length >= 1 &&
  Math.min(...rise.map(s => s.dur)) > Math.max(...fall.map(s => s.dur)),
  'upshift and downshift are no longer distinguishable');

/* Pause. The gear did not change: no bark, and nothing audible. */
check(out.hold.barks.length === 0 && out.hold.peak === 0,
  'a pause with no gear change was not silent');

/* The gear did change across the pause: still no bark. This is the defect. */
check(out.moved.barks.length === 0 && out.moved.peak === 0,
  'a gear change across a hold barked');
check(out.hostPause.barks.length === 0 && out.hostPause.peak === 0,
  'a gear change across stop/start barked');
check(out.inbandPause.barks.length === 0 && out.inbandPause.peak === 0,
  'a gear change across the paused flag barked');

/* And the fix must not have been "stop barking". A genuine change after the
   resume barks once, and ordinary driving barks on every change. */
check(out.holdThenShift.barks.length === 1,
  'a genuine shift after a resume did not bark');
check(out.driving.barks.length === 3, 'an ordinary change stopped barking');

/* The flood: no band may be reused while its burst is still sounding. */
const floodBands = sweeps(out.flood).map(s => s.band);
check(new Set(floodBands).size === floodBands.length,
  'the flood reused a band that was still sounding');

check(out.mixed.peak <= 1.0, 'a rapid pair drives the output past ±1');

/* Mid-air pause. The airborne window ends at 0.8 s, the menu is up until
   2.0 s, and the car is on the ground from then on. The landing edge fires on
   the FIRST frame after `airborne` goes false, which is a frame inside the
   pause — so the count inside the window must be zero. The control is the
   same render's tail: once the menu is down, the edge is genuine and exactly
   one thump is owed. */
const pauseThumps = out.pausedAirThumps ?? [];
check(pauseThumps.length === 0 && out.pausedAir.barks.length === 0 &&
  out.landedAfterPause === 1 && out.pausedAirFedThumps.length === 0,
  'a pause in mid-air fired a landing thump');

/* A placement. Five gear steps from fourth to first across a set-down is not a
   sequence of gearchanges; exactly the one real change afterwards barks. */
check(out.placed.barks.length === 1, 'a placement barked like a gearchange');

console.log('\n  scenario         barks  bands  peak    maxstep');
console.log('  ' + '─'.repeat(50));
for (const [name, r] of Object.entries(out)) {
  if (!r.auto) continue;
  const bands = new Set(sweeps(r).map(s => s.band)).size;
  console.log('  ' + String(name).padEnd(16) + String(r.barks.length).padStart(3) +
    '    ' + String(bands).padStart(3) + '   ' +
    String(r.peak).padEnd(7) + ' ' + r.step);
}
console.log(`\n  landing thumps inside a mid-air pause: hold ${(out.pausedAirThumps || []).length}, ` +
  `fed ${(out.pausedAirFedThumps || []).length}; after the menu, ${out.landedAfterPause} owed and fired`);

let failed = 0;
for (const r of results) {
  if (!r.ok) { failed++; console.log('  ✗ ' + r.msg); }
}
if (!failed) {
  console.log('\n  ✓ three rapid shifts get three independent sweeps; no bark across any\n' +
    '    pause, by hold, by stop/start or by the paused flag, and a real shift\n' +
    '    after one still barks; up and down keep their own sweep direction and\n' +
    '    length; five shifts in 80 ms never share a filter; a mid-air pause\n' +
    '    fires no landing thump and does not swallow the real one afterwards;\n' +
    '    the mixed bus stays inside ±1');
}
finish(failed ? 1 : 0);
