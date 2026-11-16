// Acceptance check for GameSound pause / menu-cover behaviour, run in a real browser against the
// Vite dev server (DEV builds expose window.__unspoolDebug.sound).
//   node scripts/check-audio-pause.mjs http://127.0.0.1:5183/
// Exits non-zero on any failed assertion.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5183/';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });

const start = page.locator('.begin-button').first();
await start.waitFor({ state: 'visible', timeout: 90_000 });
await page.waitForFunction(() => { const b = document.querySelector('.begin-button'); return b && !b.disabled; }, null, { timeout: 90_000 });
await start.click();
await page.waitForFunction(() => window.__unspoolDebug?.sound?.started === true, null, { timeout: 60_000 });

const state = () => page.evaluate(() => JSON.parse(document.querySelector('#world').getAttribute('data-game-state') ?? 'null'));
// The arrival intro dialogue opens by itself; advance it with Enter until play is unblocked.
for (let i = 0; i < 30; i++) {
  const s = await state();
  if (s && s.phase === 'playing' && !s.blocked && !s.dialogueOpen) break;
  if (s?.dialogueOpen) await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}
const freed = await state();
check('game reaches unblocked play', !!freed && freed.phase === 'playing' && !freed.blocked && !freed.dialogueOpen, JSON.stringify({ phase: freed?.phase, blocked: freed?.blocked }));

// Count every node the audio layer creates from here on.
await page.evaluate(() => {
  const ctx = window.__unspoolDebug.sound.engine.ctx;
  const counts = { osc: 0, source: 0, biquad: 0, gain: 0 };
  window.__audioCounts = counts;
  const map = { createOscillator: 'osc', createBufferSource: 'source', createBiquadFilter: 'biquad', createGain: 'gain' };
  for (const [name, key] of Object.entries(map)) {
    const original = ctx[name];
    ctx[name] = function (...args) { counts[key]++; return original.apply(ctx, args); };
  }
});
const counts = () => page.evaluate(() => ({ ...window.__audioCounts }));
const reset = () => page.evaluate(() => { for (const key of Object.keys(window.__audioCounts)) window.__audioCounts[key] = 0; });
const signal = () => page.evaluate(() => {
  const sound = window.__unspoolDebug.sound;
  return {
    live: sound.live, paused: sound.paused, ducked: sound.ducked,
    ambientLevel: sound.ambientLevel, ambientGain: sound.ambientGain.gain.value,
    masterGain: sound.masterGain.gain.value, contextState: sound.engine.ctx.state,
  };
});

const open = await signal();
check('ambience plays at full level in the world', open.ducked === false && open.ambientLevel === 1, JSON.stringify(open));
check('master output is live, not muted', open.masterGain > 0.7, `master=${open.masterGain}`);

// ---------------------------------------------------------------- pause while update() keeps running
const frame = { dt: 0.25, moving: 1.3, grounded: true, sprinting: true, water: true, verticalSpeed: 0, active: true, life: 0.8 };
await page.evaluate(frame => {
  const sound = window.__unspoolDebug.sound;
  sound.setPaused(true);
  for (let i = 0; i < 30; i++) {
    sound.update({ ...frame, verticalSpeed: i % 2 ? 6 : -6, grounded: i % 3 !== 0 });
    sound.update({ ...frame, active: false });
    sound.ui('click');
    sound.threadStep(i, 'water');
    sound.dialogue('mid');
  }
}, frame);
await reset(); // ignore anything the last frames raced in
await page.waitForTimeout(900);
const pausedCounts = await counts();
const paused = await signal();
check('paused: engine reports not live and the context is suspended', paused.live === false && paused.contextState === 'suspended', JSON.stringify(paused));
check('paused: update()/ui()/threadStep()/dialogue() create no oscillators', pausedCounts.osc === 0, `osc=${pausedCounts.osc}`);
check('paused: no noise buffer sources are created', pausedCounts.source === 0, `source=${pausedCounts.source}`);
check('paused: the ambient bed is ducked, not muted', paused.ambientLevel === 0.4 && paused.masterGain > 0.7, `level=${paused.ambientLevel} master=${paused.masterGain}`);

// ---------------------------------------------------------------- resume: a normal walk makes footsteps again
await page.evaluate(() => window.__unspoolDebug.sound.setPaused(false));
await page.waitForTimeout(400);
const beforeWalk = await state();
await reset();
await page.keyboard.down('w');
// Poll instead of a fixed wait: a footstep lands on the gait's own beat, and the first frames
// after resume re-accelerate the retained velocity.
let walkedCounts = { osc: 0, source: 0 };
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(350);
  walkedCounts = await counts();
  if (walkedCounts.osc > 0 && walkedCounts.source > 0) break;
}
await page.keyboard.up('w');
await page.waitForTimeout(300);
walkedCounts = await counts();
const afterWalk = await state();
const moved = beforeWalk && afterWalk && Math.hypot(...afterWalk.position.map((v, i) => v - beforeWalk.position[i]));
const resumed = await signal();
check('resume: sound is live again', resumed.live === true, JSON.stringify({ live: resumed.live, state: resumed.contextState }));
check('resume: the walk actually moved the player', moved > 0.2, `moved=${moved?.toFixed(2)}`);
check('resume: one normal walk produces footsteps (oscillators + noise)', walkedCounts.osc > 0 && walkedCounts.source > 0, JSON.stringify(walkedCounts));

// ---------------------------------------------------------------- menu cover through the real UI
await page.keyboard.press('j'); // journal
await page.waitForTimeout(900);
const menuOpen = await signal();
const menuState = await state();
check('menu open: the world is blocked and the ambient bus ducked', menuState.blocked === true && menuOpen.ducked === true && menuOpen.ambientLevel === 0.4, JSON.stringify({ blocked: menuState.blocked, ...menuOpen }));
check('menu open: the ambient bus gain actually falls', menuOpen.ambientGain < 0.6, `gain=${menuOpen.ambientGain}`);
check('menu open: the master output stays up', menuOpen.masterGain > 0.7, `master=${menuOpen.masterGain}`);

await page.keyboard.press('Escape');
await page.waitForTimeout(1400);
const menuClosed = await signal();
const menuClosedState = await state();
check('menu closed: the world unblocks and the duck clears', menuClosedState.blocked === false && menuClosed.ducked === false && menuClosed.ambientLevel === 1, JSON.stringify({ blocked: menuClosedState.blocked, ...menuClosed }));
check('menu closed: the ambient bus gain returns to its original level', menuClosed.ambientGain > 0.9, `gain=${menuClosed.ambientGain}`);
check('the graph was not rebuilt by ducking/restoring', menuClosed.masterGain > 0.7 && menuClosed.ambientGain > 0.9, `master=${menuClosed.masterGain}`);

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
