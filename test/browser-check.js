/*
 * End-to-end smoke test in real Chrome, driven over the DevTools protocol
 * with nothing but Node's built-in WebSocket. It serves the repo, opens the
 * player, runs a parameter change while the loop is asleep, and reports what
 * the page itself saw: whether the loop woke, whether the sand converged and
 * whether the oscillator kept running. The assertions live in the page.
 *
 *   node test/browser-check.js [--headless]
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");

const ROOT = path.join(__dirname, "..");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};

// Bind to port 0 so a previous run's socket can never block this one, then
// read back whichever port the OS handed out.
const serve = () =>
  new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      let file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (url.pathname === "/" || url.pathname === "") file = path.join(ROOT, "index.html");
      fs.readFile(file, (error, data) => {
        if (error) {
          response.writeHead(404);
          response.end("not found");
          return;
        }
        response.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        response.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

// A free pair of ports for the debugger socket as well.
const freePort = () =>
  new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const launch = (debugPort) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cym-chrome-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "about:blank",
  ];
  const child = spawn(CHROME, args, { stdio: "ignore" });
  return { child, profile };
};

const httpJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });

const waitFor = async (check, timeout = 15000) => {
  const start = Date.now();
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      // not ready yet
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 150));
  }
};

// A minimal DevTools client: one request at a time, keyed by id.
class Client {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "page error");
    }
    return result.result.value;
  }
}

// The page's own state, read from the same global lexical scope its scripts
// declare. Nothing is added to js/app.js for the test.
const PROBE = `
window.__probe = {
  isRunning: () => running,
  isPlaying: () => !!oscillator,
  oscillator: () => oscillator,
  tone: () => (oscillator ? oscillator.frequency.value : null),
  toneTarget: () => (state.mode ? state.mode.frequency : null),
  audioState: () => (audio ? audio.state : "none"),
  snapshot: () => grains.map((g) => g.x.toFixed(5) + "," + g.y.toFixed(5)).join("|"),
  grainsFarFromNode: (limit) => {
    let far = 0;
    for (const g of grains) {
      // toNode writes into a shared object; copy what it saw
      const n = toNode(g.x, g.y);
      if (!Number.isFinite(n.distance) || n.distance > limit) far++;
    }
    return far;
  },
  setFrequencyMark: (mark) => {
    const input = document.getElementById("freq");
    input.value = String(mark);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
  size: () => state.size,
  modeName: () => state.mode.name,
};
"probe ready"
`;

const PAGE_SCRIPT = `
(async () => {
  const frames = (n) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => (++seen >= n ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const settle = async (limit) => {
    let guard = 0;
    while (window.__probe.isRunning() && guard++ < limit) await frames(1);
    await frames(5);
  };
  await frames(30);
  await settle(2000);
  const sleptBefore = !window.__probe.isRunning();

  // Size change after the loop has gone to sleep, exactly as a user does.
  const size = document.getElementById("size");
  size.value = "52";
  size.dispatchEvent(new Event("input", { bubbles: true }));
  const woke = window.__probe.isRunning();
  await settle(2000);
  const formed = window.__probe.grainsFarFromNode(0.004) === 0;
  const asleep = !window.__probe.isRunning();

  // Audio: play, then switch mode with the slider; the oscillator must live on.
  document.getElementById("play").click();
  await frames(2);
  const osc = window.__probe.oscillator();
  window.__probe.setFrequencyMark(880);
  await frames(10);
  const stillPlaying = window.__probe.isPlaying();
  const sameOscillator = window.__probe.oscillator() === osc;
  const pitchTarget = window.__probe.toneTarget();
  await frames(20);
  const pitched = Math.abs(window.__probe.tone() - pitchTarget) < 1;
  const contextState = window.__probe.audioState();

  // "Standing wave" must freeze the sand; "Sand" must let it converge again.
  const render = document.getElementById("render");
  render.value = "field";
  render.dispatchEvent(new Event("change", { bubbles: true }));
  await frames(12);
  const frozenBefore = window.__probe.snapshot();
  window.__probe.setFrequencyMark(120);
  await frames(40);
  const frozen = frozenBefore === window.__probe.snapshot();
  render.value = "sand";
  render.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(2000);
  const resumed = window.__probe.grainsFarFromNode(0.004) === 0;
  const finalAsleep = !window.__probe.isRunning();

  // Stress the wake: a burst of size and frequency changes, including ones
  // that arrive while the loop is still running. The last parameters must win
  // and the figure must still be complete when it finally sleeps.
  const freq = document.getElementById("freq");
  for (let i = 0; i < 40; i++) {
    size.value = String(12 + (i % 45));
    size.dispatchEvent(new Event("input", { bubbles: true }));
    freq.value = String((i * 37) % 1000);
    freq.dispatchEvent(new Event("input", { bubbles: true }));
    if (i % 7 === 0) await frames(1);
  }
  size.value = "44";
  size.dispatchEvent(new Event("input", { bubbles: true }));
  freq.value = "618";
  freq.dispatchEvent(new Event("input", { bubbles: true }));
  const expectedSize = window.__probe.size();
  const expectedMode = window.__probe.modeName();
  await settle(3000);
  const burstFormed = window.__probe.grainsFarFromNode(0.004) === 0;
  const burstAsleep = !window.__probe.isRunning();
  const keptSize = window.__probe.size() === expectedSize && window.__probe.size() === 0.44;
  const keptMode = window.__probe.modeName() === expectedMode;

  return {
    sleptBefore, woke, formed, asleep,
    stillPlaying, sameOscillator, pitched, contextState,
    frozen, resumed, finalAsleep,
    burstFormed, burstAsleep, keptSize, keptMode,
  };
})()
`;

const main = async () => {
  const { server, port } = await serve();
  const debugPort = await freePort();
  const { child, profile } = launch(debugPort);
  let client;
  try {
    const target = await waitFor(async () => {
      const list = await httpJson(`http://127.0.0.1:${debugPort}/json/list`);
      return list.find((t) => t.type === "page");
    });
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    client = new Client(socket);
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
    await waitFor(() =>
      client.evaluate(
        "document.readyState === 'complete' && (() => { try { return typeof init === 'function' && grains.length > 0; } catch (e) { return false; } })()"
      )
    );
    await client.evaluate(PROBE);
    const result = await client.evaluate(PAGE_SCRIPT);
    console.log(JSON.stringify(result, null, 2));

    // Report from the app's own state, not from the test's assumptions.
    const ok =
      result.sleptBefore &&
      result.woke &&
      result.formed &&
      result.asleep &&
      result.stillPlaying &&
      result.sameOscillator &&
      result.pitched &&
      result.frozen &&
      result.resumed &&
      result.finalAsleep &&
      result.burstFormed &&
      result.burstAsleep &&
      result.keptSize &&
      result.keptMode;
    if (!ok) {
      console.error("browser check FAILED");
      process.exitCode = 1;
    } else {
      console.log("browser check passed");
    }
  } finally {
    if (client) client.socket.close();
    server.close();
    child.kill(); // the Chrome process this script started
    // Give Chrome a moment to release the profile, then remove it.
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch (error) {}
    }, 500);
  }
};

if (!CHROME) {
  console.error("no Chrome or Edge found");
  process.exitCode = 1;
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
