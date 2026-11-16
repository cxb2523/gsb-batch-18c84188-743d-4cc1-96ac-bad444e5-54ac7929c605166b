/*
 * A tiny, dependency-free stand-in for the browser pieces the page touches:
 * a DOM with string-valued inputs, a canvas whose 2D context only needs to
 * exist, and an AudioContext whose parameters evaluate their automation the
 * way the real ones do (including the cancelScheduledValues gotcha: cancelling
 * a glide makes the parameter fall back to the previous event). It lets the
 * app be driven frame by frame from Node, which is how the wake/settle and
 * tone tests are written.
 */

const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
// CYM_APP_FILE lets the same tests run against another revision of the app,
// which is how the regression suite was checked to fail on the old code.
const APP_FILE = process.env.CYM_APP_FILE || "js/app.js";

const FRAME_MS = 1000 / 60;

// The value a Web Audio parameter has at `t`, given its automation events.
// setValueAtTime holds; linearRampToValueAtTime ramps from the previous event.
const valueAt = (events, base, t) => {
  let value = base;
  let previousTime = 0;
  for (const event of events) {
    if (event.type === "set") {
      if (t < event.time) return value;
      value = event.value;
      previousTime = event.time;
    } else if (t >= event.time) {
      value = event.value;
      previousTime = event.time;
    } else {
      const span = event.time - previousTime;
      if (span <= 0) return event.value;
      return value + (event.value - value) * ((t - previousTime) / span);
    }
  }
  return value;
};

let clock;

class FakeParam {
  constructor(value) {
    this.base = value;
    this.events = [];
  }
  get value() {
    return valueAt(this.events, this.base, clock.audioTime);
  }
  set value(v) {
    this.base = v;
  }
  setValueAtTime(v, time) {
    this.events.push({ type: "set", value: v, time });
    return this;
  }
  linearRampToValueAtTime(v, time) {
    this.events.push({ type: "ramp", value: v, time });
    return this;
  }
  // Chrome (and the spec's [[current value]]) keeps whatever the parameter is
  // sounding at the cancel time; it does not snap back to an earlier event.
  // Verified against Chrome 157 with a real AudioContext. After cancelling,
  // the parameter holds that value until the next event, so the history is
  // collapsed into the held value.
  cancelScheduledValues(time) {
    this.base = this.value;
    this.events = [];
    return this;
  }
  cancelAndHoldAtTime(time) {
    return this.cancelScheduledValues(time);
  }
}

const makeCanvas = () => {
  const context = {
    createImageData: (w, h) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData() {},
    drawImage() {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    arc() {},
    clip() {},
    fillRect() {},
    stroke() {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingEnabled: true,
  };
  return {
    width: 300,
    height: 300,
    getContext: () => context,
    toDataURL: () => "data:image/png;base64,",
    parentElement: {
      getBoundingClientRect: () => ({ width: 700, height: 700, left: 0, top: 0 }),
    },
  };
};

// Elements behave like their HTML counterparts where the app can tell:
// `value` is always a string, as it is on a real input.
const makeElement = (id) => {
  let value = "";
  return {
    id,
    get value() {
      return value;
    },
    set value(v) {
      value = String(v);
    },
    textContent: "",
    innerHTML: "",
    hidden: false,
    style: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    click() {
      this.clicked = true; // the PNG export builds a link and clicks it
    },
    parentElement: null,
    getBoundingClientRect: () => ({ width: 700, height: 700, left: 0, top: 0 }),
  };
};

const makeSandbox = ({ search = "" } = {}) => {
  const frames = [];
  const timers = [];
  let timerId = 0;

  clock = { frame: 0, audioTime: 0 };

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const plate = makeCanvas();
  plate.parentElement = {
    getBoundingClientRect: () => ({ width: 700, height: 700, left: 0, top: 0 }),
  };
  elements.set("plate", plate);

  const audioContexts = [];

  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
      this.oscillators = [];
      this.gains = [];
      this.resumeCalls = 0;
      audioContexts.push(this);
    }
    get currentTime() {
      return clock.audioTime;
    }
    createOscillator() {
      const oscillator = {
        type: "sine",
        frequency: new FakeParam(440),
        startCalls: 0,
        stopCalls: 0,
        startedAt: null,
        stoppedAt: null,
        onended: null,
        connect: (node) => node,
        disconnect() {},
        start(when = clock.audioTime) {
          this.startCalls++;
          this.startedAt = when;
        },
        stop(when = clock.audioTime) {
          this.stopCalls++;
          this.stoppedAt = when;
        },
      };
      this.oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      const gain = {
        gain: new FakeParam(1),
        connect: (node) => node,
        disconnect() {},
      };
      this.gains.push(gain);
      return gain;
    }
    resume() {
      this.resumeCalls++;
      this.state = "running";
      return Promise.resolve();
    }
  }

  const sandbox = {
    console,
    Math,
    Date,
    Intl,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    TypeError,
    RangeError,
    Float32Array,
    Uint8Array,
    Uint32Array,
    Uint8ClampedArray,
    ArrayBuffer,
    Promise,
    URLSearchParams,
    isNaN,
    parseInt,
    parseFloat,
    window: null,
    document: {
      getElementById: (id) => element(id),
      createElement: (tag) => (tag === "canvas" ? makeCanvas() : makeElement(tag)),
    },
    location: { pathname: "/index.html", search },
    history: { replaceState() {}, pushState() {} },
    requestAnimationFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
    setTimeout: (callback, ms) => {
      const id = ++timerId;
      timers.push({ id, callback, ms });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.devicePixelRatio = 1;
  sandbox.window.AudioContext = FakeAudioContext;
  element("play").textContent = "Play";

  const context = vm.createContext(sandbox);

  const advance = (ms = FRAME_MS) => {
    clock.audioTime += ms / 1000;
  };

  const frame = () => {
    const due = frames.splice(0, frames.length);
    clock.frame++;
    advance();
    for (const callback of due) callback(clock.frame * FRAME_MS);
    return due.length;
  };

  return {
    sandbox,
    context,
    element,
    plate,
    frames,
    frame,
    advance,
    audioContexts,
  };
};

const createHarness = ({ search = "", grains = null } = {}) => {
  const page = makeSandbox({ search });
  const { sandbox, context, element, frames, frame } = page;

  vm.runInContext(read("js/cymatics.js"), context, { filename: "js/cymatics.js" });

  const bridge = `
    globalThis.__app = {
      state,
      init, loop, wake, start, scatter, settle, buildField, shake, toNode, draw, resize,
      onFrequency, onSize, onMix, onShape, onRender, onGrains, onStep, savePNG,
      playTone, stopTone, toggleTone, retune, playing,
      getGrains: () => grains,
      getField: () => field,
      isRunning: () => running,
      getStill: () => still,
      // Older revisions tracked no explicit counters; derive them from the
      // grains so the same assertions can run against both.
      getUnsettled: () =>
        typeof unsettled === "number"
          ? unsettled
          : grains.reduce((n, g) => n + (g.settled ? 0 : 1), 0),
      getAwake: () => (typeof awake === "number" ? awake : 0),
      getAudio: () => audio,
      getOscillator: () => oscillator,
      getGain: () => gain,
      spectrum, nearestMode, amplitudeAt,
    };
  `;
  vm.runInContext(read(APP_FILE) + bridge, context, { filename: APP_FILE });

  const app = sandbox.__app;
  if (grains !== null) {
    app.state.grains = grains; // init()'s scatter() picks the count up
    element("grains").value = String(grains);
  }

  const pendingFrames = () => frames.length;

  const runUntilSleep = (limit = 5000) => {
    let ran = 0;
    while (app.isRunning() && ran < limit) {
      if (frame() === 0) break; // nothing queued: the loop has stopped
      ran++;
    }
    return ran;
  };

  const runFrames = (count) => {
    for (let i = 0; i < count; i++) frame();
  };

  // The real page fires `oninput`/`onchange` with the element itself.
  const slider = (id, value) => {
    const input = element(id);
    input.value = value;
    return input;
  };

  // A plain array in the test realm, so deepEqual does not trip over the
  // prototype of an array created inside the VM.
  const snapshot = () => Array.from(app.getGrains(), (g) => [g.x, g.y, g.settled]);

  return {
    app,
    sandbox,
    context,
    element,
    plate: page.plate,
    frame,
    advance: page.advance,
    pendingFrames,
    runUntilSleep,
    runFrames,
    slider,
    snapshot,
    audioContexts: page.audioContexts,
    clock,
  };
};

// The modes gallery is a second page: cymatics.js and modes.js, no app.js.
// (Both scripts declare `$`, so they cannot share a context with app.js.)
const createGalleryHarness = () => {
  const page = makeSandbox();
  const { sandbox, context, element, frame } = page;
  vm.runInContext(read("js/cymatics.js"), context, { filename: "js/cymatics.js" });
  vm.runInContext(read("js/modes.js") + "\n;globalThis.__gallery = { setupModesPage, SQUARE_MODES, CIRCLE_MODES };", context, {
    filename: "js/modes.js",
  });
  return {
    sandbox,
    element,
    frame,
    setup: () => sandbox.__gallery.setupModesPage(),
    counts: () => ({
      squares: sandbox.__gallery.SQUARE_MODES.length,
      circles: sandbox.__gallery.CIRCLE_MODES.length,
    }),
  };
};
module.exports = { createHarness, createGalleryHarness, FRAME_MS };
