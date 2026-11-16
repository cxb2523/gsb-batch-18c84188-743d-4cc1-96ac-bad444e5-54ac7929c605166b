/*
 * Regression tests for the sand loop and the tone, driven frame by frame
 * through test/harness.js. Run with:  node --test test/
 *
 * No dependencies: node:test and node:assert only. The harness runs the real
 * js/app.js in a VM with just enough of the browser to execute it, so these
 * assertions are about the app's own behaviour, not a reimplementation.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, createGalleryHarness } = require("./harness");

const MODE_FAR = 0.004; // farther than this from a node: still visibly loose

const boot = (search, grains) => {
  const h = createHarness({ search, grains: grains === undefined ? 5000 : grains });
  h.app.init();
  h.runUntilSleep(30000);
  return h;
};

const farGrains = (h) => {
  const app = h.app;
  let far = 0;
  for (const g of app.getGrains()) {
    const d = app.toNode(g.x, g.y).distance;
    if (!Number.isFinite(d) || d > MODE_FAR) far++;
  }
  return far;
};

const assertFormed = (h, label) => {
  assert.equal(h.app.isRunning(), false, `${label}: loop should be asleep once formed`);
  assert.equal(h.app.getUnsettled(), 0, `${label}: every grain should have reached a node`);
  assert.equal(farGrains(h), 0, `${label}: no grain should be far from a node`);
};

const settleFrames = (h, limit = 5000) => {
  let frames = 0;
  while (h.app.isRunning() && frames < limit) {
    h.frame();
    frames++;
  }
  return frames;
};

// --- waking after each kind of change ---------------------------------

test("a settled figure re-forms after every frequency in a sweep", () => {
  // Each position starts from a sleeping loop, so every one is a wake-up.
  for (let mark = 0; mark <= 1000; mark += 100) {
    const h = boot();
    assertFormed(h, `pre ${mark}`);
    const before = h.snapshot();
    h.app.onFrequency(h.slider("freq", mark));
    assert.equal(h.app.isRunning(), true, `slider ${mark}: a change must wake the loop`);
    assert.ok(h.pendingFrames() > 0, `slider ${mark}: a frame must be queued`);
    const frames = settleFrames(h);
    assert.ok(frames > 0, `slider ${mark}: the loop must actually run`);
    assertFormed(h, `slider ${mark}`);
    // the sand only has to move when the new frequency picks a different mode
    const changed = before.some(([x, y], i) => {
      const g = h.app.getGrains()[i];
      return g.x !== x || g.y !== y;
    });
    if (mark === 0 || changed) assert.ok(changed, `slider ${mark}: the sand must have moved`);
    assert.equal(
      h.app.state.mode.name,
      h.app.nearestMode(h.app.state.modes, h.app.state.frequency).name,
      `slider ${mark}: the figure must match the parameters on screen`
    );
  }
});

test("a size change wakes the loop and the sand re-forms", () => {
  for (const cm of [10, 22, 37, 60]) {
    const h = boot();
    assertFormed(h, "pre size");
    h.app.onSize(h.slider("size", cm));
    assert.equal(h.app.state.size, cm / 100);
    assert.equal(h.app.isRunning(), true, `size ${cm}: a change must wake the loop`);
    settleFrames(h);
    assertFormed(h, `size ${cm}`);
  }
});
test("a superposition change wakes the loop and the sand re-forms", () => {
  for (const mix of [-1, -0.6, 0, 0.4, 1]) {
    const h = boot();
    assertFormed(h, "pre mix");
    h.app.onMix(h.slider("mix", mix));
    assert.equal(h.app.state.mix, mix);
    assert.equal(h.app.isRunning(), true, `mix ${mix}: a change must wake the loop`);
    settleFrames(h);
    assertFormed(h, `mix ${mix}`);
  }
});

test("a shape change wakes the loop, rebuilds the sand, and re-forms", () => {
  const h = boot();
  assertFormed(h, "square");
  h.app.onShape(h.slider("shape", "circle"));
  assert.equal(h.app.state.shape, "circle");
  assert.equal(h.app.getGrains().length, h.app.state.grains);
  assert.equal(h.app.isRunning(), true, "circle: a change must wake the loop");
  settleFrames(h);
  assertFormed(h, "circle");

  h.app.onShape(h.slider("shape", "square"));
  assert.equal(h.app.isRunning(), true, "square: a change must wake the loop");
  settleFrames(h);
  assertFormed(h, "back to square");
});

test("switching shape and back while asleep leaves the right figure", () => {
  const h = boot();
  h.app.onShape(h.slider("shape", "circle"));
  settleFrames(h);
  h.app.onShape(h.slider("shape", "square"));
  settleFrames(h);
  assertFormed(h, "square again");
  // a circle must still be possible afterwards
  h.app.onShape(h.slider("shape", "circle"));
  settleFrames(h);
  assertFormed(h, "circle again");
  assert.equal(h.app.state.shape, "circle");
});

// --- drags and bursts --------------------------------------------------

test("the last parameter wins when a drag rebuilds many times", () => {
  const h = boot();
  // emulate a drag: dozens of inputs, with a frame occasionally slipping in
  for (let v = 0; v <= 1000; v += 20) {
    h.app.onFrequency(h.slider("freq", v));
    if (v % 120 === 0) h.frame();
  }
  h.app.onFrequency(h.slider("freq", 431)); // the final resting position
  const expected = h.app.state.frequency;
  const expectedMode = h.app.state.mode.name;
  settleFrames(h);
  assert.equal(h.app.state.frequency, expected, "the frequency must be the last one set");
  assert.equal(h.app.state.mode.name, expectedMode, "the mode must match the last frequency");
  assert.equal(
    h.app.state.mode.name,
    h.app.nearestMode(h.app.state.modes, expected).name,
    "the formed figure must be the one the last parameters ask for"
  );
  assertFormed(h, "after drag");
});

test("a grains change wakes the loop and the new sand re-forms", () => {
  for (const count of [2000, 8000, 16000]) {
    const h = boot(null, 4000);
    assertFormed(h, "pre grains");
    h.app.onGrains(h.slider("grains", count));
    assert.equal(h.app.getGrains().length, count);
    assert.equal(h.app.isRunning(), true, `grains ${count}: a change must wake the loop`);
    settleFrames(h);
    assertFormed(h, `grains ${count}`);
  }
});

test("a resize redraw does not disturb a settled figure", () => {
  const h = boot();
  assertFormed(h, "settled");
  const before = h.snapshot();
  h.app.resize();
  assert.deepEqual(h.snapshot(), before, "resizing must not move the sand");
});

test("many changes inside one frame still converge to the final parameters", () => {
  const h = boot();
  h.app.onFrequency(h.slider("freq", 960));
  h.app.onSize(h.slider("size", 17));
  h.app.onShape(h.slider("shape", "circle"));
  h.app.onMix(h.slider("mix", 0.8));
  h.app.onFrequency(h.slider("freq", 402));
  const expected = {
    shape: "circle",
    size: 0.17,
    mix: 0.8,
    frequency: h.app.state.frequency,
    mode: h.app.state.mode.name,
  };
  settleFrames(h);
  assert.deepEqual(
    {
      shape: h.app.state.shape,
      size: h.app.state.size,
      mix: h.app.state.mix,
      frequency: h.app.state.frequency,
      mode: h.app.state.mode.name,
    },
    expected
  );
  assertFormed(h, "after burst");
});

test("a drag that ends where it started still leaves the right figure", () => {
  const h = boot();
  const home = h.app.state.frequency;
  for (let v = 1000; v >= 0; v -= 25) h.app.onFrequency(h.slider("freq", v));
  h.app.onFrequency(h.slider("freq", 500));
  settleFrames(h);
  const first = h.app.state.mode.name;
  h.app.onFrequency(h.slider("freq", 500));
  settleFrames(h);
  assert.equal(h.app.state.mode.name, first);
  void home;
  assertFormed(h, "stable target");
});

// --- render modes ------------------------------------------------------

test("Standing wave does not advance the sand; Sand resumes convergence", () => {
  const h = boot();
  assertFormed(h, "settled");

  h.app.onRender(h.slider("render", "field"));
  settleFrames(h);
  assert.equal(h.app.isRunning(), false, "the field view may rest");

  // change parameters while the field alone is shown: the sand is stale
  h.app.onFrequency(h.slider("freq", 780));
  settleFrames(h);
  assert.ok(h.app.getUnsettled() > 0, "the sand should still be looking for its nodes");
  const frozen = h.snapshot();

  // a few frames in field mode must leave the grains untouched
  h.app.wake();
  h.runFrames(10);
  assert.deepEqual(h.snapshot(), frozen, "the field view must not move the sand");

  h.app.onRender(h.slider("render", "sand"));
  assert.equal(h.app.isRunning(), true, "switching back to Sand must wake the loop");
  settleFrames(h);
  assertFormed(h, "sand after field");
});

test("Both resumes a frozen sand and settles", () => {
  const h = boot();
  h.app.onRender(h.slider("render", "field"));
  settleFrames(h);
  h.app.onShape(h.slider("shape", "circle"));
  settleFrames(h);
  assert.ok(h.app.getUnsettled() > 0, "the circle's sand has not been simulated yet");
  h.app.onRender(h.slider("render", "both"));
  assert.equal(h.app.isRunning(), true);
  settleFrames(h);
  assertFormed(h, "both");
});

test("switching to Standing wave mid-motion does not leave the loop awake", () => {
  const h = boot();
  h.app.onFrequency(h.slider("freq", 900));
  h.frame();
  h.frame();
  assert.equal(h.app.isRunning(), true);
  h.app.onRender(h.slider("render", "field"));
  settleFrames(h);
  assert.equal(h.app.isRunning(), false, "the field view settles and sleeps");
  const frozen = h.snapshot();
  h.app.wake();
  h.runFrames(5);
  assert.deepEqual(h.snapshot(), frozen);
});

// --- convergence bound -------------------------------------------------

test("every wake settles inside a bounded number of frames", () => {
  const h = boot();
  const changes = [
    ["freq high", () => h.app.onFrequency(h.slider("freq", 1000))],
    ["freq low", () => h.app.onFrequency(h.slider("freq", 0))],
    ["size small", () => h.app.onSize(h.slider("size", 12))],
    ["size large", () => h.app.onSize(h.slider("size", 58))],
    ["circle", () => h.app.onShape(h.slider("shape", "circle"))],
    ["square", () => h.app.onShape(h.slider("shape", "square"))],
    ["mix", () => h.app.onMix(h.slider("mix", -0.35))],
  ];
  for (const [label, change] of changes) {
    change();
    const frames = settleFrames(h);
    assert.equal(h.app.isRunning(), false, `${label}: must come to rest`);
    assert.ok(frames < 900, `${label}: must settle inside the frame budget (ran ${frames})`);
    assertFormed(h, label);
  }
});

test("a wake whose sand was scattered anew also settles", () => {
  const h = boot();
  for (let i = 0; i < 5; i++) {
    h.app.scatter();
    h.frame();
    assert.ok(h.app.getUnsettled() > 0);
    h.runUntilSleep(30000);
    assertFormed(h, `scatter ${i}`);
  }
});

// --- the tone ----------------------------------------------------------

test("switching mode while playing glides and never restarts the oscillator", () => {
  const h = boot();
  const app = h.app;
  app.playTone();
  const oscillator = app.getOscillator();
  const startPitch = oscillator.frequency.value;
  assert.equal(oscillator.startCalls, 1);
  assert.equal(oscillator.stopCalls, 0);

  app.onFrequency(h.slider("freq", 870));
  const target = app.state.mode.frequency;
  assert.notEqual(target, startPitch);
  assert.equal(app.getOscillator(), oscillator, "the same oscillator keeps sounding");
  assert.equal(oscillator.startCalls, 1, "no restart");
  assert.equal(oscillator.stopCalls, 0, "no stop, so no silent gap");

  const now = h.clock.audioTime;
  h.clock.audioTime = now + 0.02; // part-way through the glide
  const midGlide = oscillator.frequency.value;
  assert.ok(
    midGlide > Math.min(startPitch, target) && midGlide < Math.max(startPitch, target),
    "the pitch should be on its way, not jumped"
  );
  h.clock.audioTime = now + 0.2;
  assert.ok(Math.abs(oscillator.frequency.value - target) < 1e-6, "the glide lands on the new mode");
  assert.ok(app.playing());
  assert.ok(app.getGain().gain.value > 0, "the tone stayed audible through the switch");
});

test("a fast drag glides from what is sounding instead of chirping", () => {
  const h = boot();
  const app = h.app;
  app.playTone();
  const oscillator = app.getOscillator();
  const first = app.state.mode.frequency;

  app.onFrequency(h.slider("freq", 700));
  h.clock.audioTime += 0.02; // part-way through the first glide
  const inFlight = oscillator.frequency.value;
  assert.notEqual(inFlight, first);

  app.onFrequency(h.slider("freq", 250)); // a new target mid-glide
  const pinned = oscillator.frequency.value;
  assert.ok(
    Math.abs(pinned - inFlight) < 1e-6,
    "the new glide must start from the sounding pitch, not snap back"
  );
  const target = app.state.mode.frequency;
  assert.ok(
    Math.abs(target - pinned) < Math.abs(target - inFlight) + Math.abs(inFlight - first),
    "the glide goes on toward the new mode"
  );
  h.clock.audioTime += 0.2;
  assert.ok(Math.abs(oscillator.frequency.value - target) < 1e-6);
  assert.equal(oscillator.startCalls, 1);
});

test("a drag to one mode and back does not leave the pitch behind", () => {
  const h = boot();
  const app = h.app;
  app.playTone();
  const oscillator = app.getOscillator();
  const home = app.state.mode.frequency;
  app.onFrequency(h.slider("freq", 900));
  app.onFrequency(h.slider("freq", app.state.frequency === home ? 900 : app.state.frequency));
  const target = app.state.mode.frequency;
  h.clock.audioTime += 0.3;
  assert.ok(Math.abs(oscillator.frequency.value - target) < 1e-6);
});

test("stop fades out, and a later play starts at the current mode", () => {
  const h = boot();
  const app = h.app;
  app.playTone();
  const first = app.getOscillator();
  h.clock.audioTime += 0.3; // the fade-in completes and the tone is at full level
  app.onFrequency(h.slider("freq", 620));
  h.clock.audioTime += 0.2;
  const playingMode = app.state.mode.frequency;
  const gain = app.getGain();
  assert.ok(Math.abs(gain.gain.value - 0.12) < 1e-6, "the tone is at full level before stopping");

  app.stopTone();
  assert.equal(app.playing(), false);
  assert.equal(first.stopCalls, 1);
  const now = h.clock.audioTime;
  h.clock.audioTime = now + 0.05;
  assert.ok(gain.gain.value > 0 && gain.gain.value < 0.12, "stop fades rather than cuts");
  h.clock.audioTime = now + 0.2;
  assert.ok(Math.abs(gain.gain.value) < 1e-9, "silent once the fade ends");

  // play again at the frequency of the mode on screen
  app.playTone();
  const second = app.getOscillator();
  assert.notEqual(second, first);
  assert.equal(second.startCalls, 1);
  assert.ok(
    Math.abs(second.frequency.value - playingMode) < 1e-6,
    "a fresh tone starts at the current mode's frequency"
  );
  assert.ok(second.frequency.value !== first.frequency.value || playingMode === first.frequency.value);
});

test("change mode while stopped, then play", () => {
  const h = boot();
  const app = h.app;
  app.onFrequency(h.slider("freq", 260));
  app.playTone();
  assert.ok(Math.abs(app.getOscillator().frequency.value - app.state.mode.frequency) < 1e-6);
  app.stopTone();
  app.onFrequency(h.slider("freq", 830));
  app.playTone();
  assert.ok(Math.abs(app.getOscillator().frequency.value - app.state.mode.frequency) < 1e-6);
});

test("stopping mid-fade dips from the sounding level instead of cutting", () => {
  const h = boot();
  const app = h.app;
  app.playTone();
  const gain = app.getGain();
  h.clock.audioTime += 0.05; // part-way up the 0.15 s fade-in
  const sounding = gain.gain.value;
  assert.ok(sounding > 0 && sounding < 0.12, "the tone is only part-way up");
  app.stopTone();
  // a click would show up here as a drop straight to zero
  h.clock.audioTime += 0.005;
  assert.ok(gain.gain.value > sounding * 0.5, "the level must not collapse on stop");
  assert.ok(gain.gain.value < sounding, "but it must start falling");
  h.clock.audioTime += 0.2;
  assert.ok(Math.abs(gain.gain.value) < 1e-9, "and reach silence");
});

test("play, stop, play, stop leaves no tone running", () => {
  const h = boot();
  const app = h.app;
  for (let i = 0; i < 3; i++) {
    app.playTone();
    assert.ok(app.playing());
    app.stopTone();
    assert.equal(app.playing(), false);
  }
});

// --- preserved behaviour ----------------------------------------------

test("URL parameters still choose the plate and the mode", () => {
  const h = boot("?shape=circle&mode=3%2C%201&size=40&mix=0.3");
  assert.equal(h.app.state.shape, "circle");
  assert.equal(h.app.state.size, 0.4);
  assert.equal(h.app.state.mode.name, "3, 1");
  const frequencies = [...h.app.state.modes].map((m) => m.frequency);
  assert.deepEqual(frequencies, [...frequencies].sort((a, b) => a - b));
});

test("mode stepping moves one place through the spectrum and keeps the name", () => {
  const h = boot();
  const names = [...h.app.state.modes].map((m) => m.name);
  const index = names.indexOf(h.app.state.mode.name);
  h.app.onStep(1);
  assert.equal(h.app.state.mode.name, names[Math.min(index + 1, names.length - 1)]);
  // settle() rebuilds the spectrum, so ask the rebuilt list for the position
  const moved = [...h.app.state.modes].findIndex((m) => m.name === h.app.state.mode.name);
  assert.equal(moved, Math.min(index + 1, names.length - 1));
  h.app.onStep(-1);
  assert.equal(h.app.state.mode.name, names[index]);
  h.runUntilSleep(30000);
  assertFormed(h, "stepped");
});

test("the panel and the PNG export keep working", () => {
  const h = boot("?shape=circle&mode=3%2C%201&size=40&mix=0.3");
  const doc = h.sandbox.document;
  assert.equal(doc.getElementById("shape").value, "circle");
  assert.equal(doc.getElementById("size").value, "40");
  assert.equal(doc.getElementById("mixRow").style.display, "none", "square-only control hidden");
  assert.equal(doc.getElementById("modeName").textContent, "3, 1");
  assert.match(doc.getElementById("pname").innerHTML, /Drumhead/);
  assert.match(doc.getElementById("tagline").textContent, /\d+ Hz/);
  assert.equal(doc.getElementById("sizeVal").textContent, "40 cm");
  assert.equal(doc.getElementById("freqVal").textContent, `${Math.round(h.app.state.frequency)} Hz`);
  assert.equal(typeof h.app.savePNG, "function");
  h.app.savePNG();
});

test("the mode gallery page still draws both families", () => {
  const gallery = createGalleryHarness();
  gallery.setup();
  gallery.frame(); // setupModesPage defers its work by one frame
  const { squares, circles } = gallery.counts();
  assert.equal(gallery.element("squares").children.length, squares);
  assert.equal(gallery.element("circles").children.length, circles);
  assert.ok(squares > 0 && circles > 0);
  assert.equal(gallery.element("loading").hidden, true);
  assert.equal(gallery.element("gallery").hidden, false);
});
