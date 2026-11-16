#!/usr/bin/env node
/**
 * Focused AO / contact-shadow acceptance harness.
 *
 * Captures the exact frames the AO task is judged on:
 *   1. low tier, day      — tight dark line under the tyres (contact-only mode)
 *   2. low tier, night    — soft dark blob under the car (ambient cone, no sun)
 *   3. low tier, AO debug — the half-res buffer itself, day + night
 *   4. high tier, day     — full AO restored after a low->high switch (no black frame)
 *   5. low tier, grazing sun — contact march must still reach the ~15 cm floorpan
 *   6. low tier, glass    — no hard-edged rectangles stamped on the greenhouse
 *
 *   node tools/verify-ao.mjs --out shots/ao-check
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/ao-check'));
const PORT = parseInt(arg('port', '5274'), 10);

const t0 = Date.now();
const log = (...a) => console.log(`[ao +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
    s.setTimeout(400, () => {
      s.destroy();
      res(false);
    });
  });
}

let server = null;
let browser = null;
const pageErrors = [];
const consoleErrors = [];

try {
  if (await portOpen(PORT)) {
    log(`reusing dev server on :${PORT}`);
  } else {
    log(`starting vite on :${PORT}`);
    server = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    const deadline = Date.now() + 45000;
    while (!(await portOpen(PORT))) {
      if (Date.now() > deadline) throw new Error('vite failed to start');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => {
    pageErrors.push(String(e.message || e));
    console.error('  [pageerror]', String(e.message || e).slice(0, 400));
  });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text());
      console.error('  [console.error]', m.text().slice(0, 300));
    } else if (/postfx|AO/i.test(m.text())) {
      console.warn('  [console]', m.text().slice(0, 300));
    }
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__NFT && window.__NFT.ready, null, {
    timeout: 90000,
    polling: 200,
  });
  log('booted');
  await mkdir(OUT, { recursive: true });

  const ev = (fn, a) => page.evaluate(fn, a);
  const shot = async (name) => {
    await ev(() => window.__NFT.waitFrames(3));
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    log(`  ✓ ${name}`);
  };

  // Park the car, camera close behind it — the framing that exposes a floating car.
  const setupParked = async (preset) => {
    await ev((p) => {
      const nft = window.__NFT;
      nft.drive(null);
      nft.autoDrive(false);
      nft.setWeather?.({ wetness: 0, rain: 0 });
      nft.setPreset(p);
      nft.setCamera('photo');
      nft.teleport(0.12, 0, 0);
      // Low rear 3/4 — sees the gap between floorpan and tarmac.
      nft.photo({ position: [3.4, 0.75, 4.4], lookAt: [0, 0.35, 0], fov: 40 });
    }, preset);
    await ev(() => window.__NFT.settle(1.2));
  };

  // --- 1. low tier, day -----------------------------------------------------
  await ev(() => window.__NFT.setQuality('low'));
  await setupParked('noon');
  await shot('01-low-day');

  // AO buffer debug view, same frame.
  await ev(() => {
    window.__NFT.ctx.post.debugView = 'ao';
  });
  await shot('02-low-day-aobuffer');
  await ev(() => {
    window.__NFT.ctx.post.debugView = null;
  });

  // --- 2. low tier, night ---------------------------------------------------
  await setupParked('night');
  await shot('03-low-night');
  await ev(() => {
    window.__NFT.ctx.post.debugView = 'ao';
  });
  await shot('04-low-night-aobuffer');
  await ev(() => {
    window.__NFT.ctx.post.debugView = null;
  });

  // --- 3. low tier, grazing sun (sun ~4 deg over the horizon) ----------------
  await ev(() => {
    const nft = window.__NFT;
    nft.setPreset('goldenHour');
    nft.setTimeOfDay(18.6); // sun nearly on the horizon
  });
  await ev(() => window.__NFT.settle(1.0));
  await shot('05-low-grazing-sun');

  // --- 4. switch low -> high mid-run: AO must return, frame must not go black
  await ev(() => {
    window.__NFT.setPreset('noon');
    window.__NFT.setQuality('high');
  });
  await ev(() => window.__NFT.waitFrames(2));
  // The first high-tier frame compiles the SSR/DOF/god-ray/motion-blur programs on the main
  // thread; on a cold cache that can block presentation for over a minute. That hitch is a
  // one-time compile cost, not a rendering failure — give the capture room to wait it out.
  await page.screenshot({
    path: path.join(OUT, '06-high-right-after-switch.png'),
    timeout: 180000,
  });
  log('  ✓ 06-high-right-after-switch');
  await ev(() => window.__NFT.settle(1.0));
  await shot('07-high-day');
  await ev(() => {
    window.__NFT.ctx.post.debugView = 'ao';
  });
  await shot('08-high-day-aobuffer');
  await ev(() => {
    window.__NFT.ctx.post.debugView = null;
  });

  // --- 5. back to low, glass close-up: no blocky rectangles on the greenhouse
  await ev(() => window.__NFT.setQuality('low'));
  await ev(() => {
    const nft = window.__NFT;
    nft.setPreset('noon');
    nft.photo({ position: [2.6, 1.6, -2.8], lookAt: [0, 0.9, 0.3], fov: 34 });
  });
  await ev(() => window.__NFT.settle(1.0));
  await shot('09-low-glass');

  // --- pixel probes: is there actually a dark contact term under the car? ----
  const probes = await ev(() => {
    const nft = window.__NFT;
    const post = nft.ctx.post;
    const ao = post.ao;
    return {
      tier: nft.ctx.settings.tier,
      aoFailed: ao?.failed ?? null,
      maskEnabled: ao?.maskEnabled ?? null,
      maskTagged: ao?._tagged?.length ?? null,
      contactDefine: ao?.compute?.material?.defines?.AO_CONTACT !== undefined,
      contactOnlyDefine: ao?.compute?.material?.defines?.AO_CONTACT_ONLY !== undefined,
      samples: ao?.compute?.material?.defines?.AO_SAMPLES ?? null,
      steps: ao?.compute?.material?.defines?.CONTACT_STEPS ?? null,
      rtSize: ao?.rtA ? [ao.rtA.width, ao.rtA.height] : null,
    };
  });
  log('state @low:', JSON.stringify(probes));

  const probesHigh = await ev(() => {
    window.__NFT.setQuality('high');
    return null;
  });
  void probesHigh;
  await ev(() => window.__NFT.waitFrames(3));
  const probesHigh2 = await ev(() => {
    const ao = window.__NFT.ctx.post.ao;
    return {
      tier: window.__NFT.ctx.settings.tier,
      contactOnlyDefine: ao?.compute?.material?.defines?.AO_CONTACT_ONLY !== undefined,
      samples: ao?.compute?.material?.defines?.AO_SAMPLES ?? null,
      steps: ao?.compute?.material?.defines?.CONTACT_STEPS ?? null,
      rtSize: ao?.rtA ? [ao.rtA.width, ao.rtA.height] : null,
    };
  });
  log('state @high:', JSON.stringify(probesHigh2));

  await writeFile(
    path.join(OUT, 'report.json'),
    JSON.stringify({ probes, probesHigh2, pageErrors, consoleErrors }, null, 2)
  );
  if (pageErrors.length) process.exitCode = 2;
} catch (err) {
  console.error('[ao] FATAL:', err?.stack || err);
  process.exitCode = 3;
} finally {
  await browser?.close().catch(() => {});
  if (server) {
    try {
      server.kill('SIGTERM');
      setTimeout(() => server.kill('SIGKILL'), 2000).unref?.();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 400).unref?.();
}
