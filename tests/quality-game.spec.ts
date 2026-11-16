import { test, expect } from '@playwright/test';

// Nitro boost visuals must follow the live quality tier: fewer flame particles and a
// gentler camera pull-back on 流畅, unchanged density on 精细, clean tier switches.
test('boost flames and chase camera scale with the quality tier', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await page.getByRole('button', { name: '开始比赛' }).click();
  await page.keyboard.down('w');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');

  // Count rendered frames and pin a controlled player-only boost so both tiers are
  // measured under the same conditions. Rivals are kept item-less and far away so
  // their flames and collisions cannot pollute the counters.
  await page.evaluate(() => {
    const w = window as any;
    const R = w.__RALLY__;
    w.__frames = 0;
    const update = R.renderer.update.bind(R.renderer);
    R.renderer.update = (state: any, dt: number) => { w.__frames += 1; return update(state, dt); };
    w.__boostOn = false;
    const state = R.simulation.state;
    state.racers.slice(1).forEach((rival: any, i: number) => {
      rival.distance = state.racers[0].distance + 220 + i * 40;
    });
    w.__pin = setInterval(() => {
      const s = R.simulation.state;
      const player = s.racers[0];
      if (w.__boostOn && s.phase === 'racing') {
        player.boostTime = Math.max(player.boostTime, 0.6);
        player.speed = 50;
      }
      for (const rival of s.racers.slice(1)) {
        rival.boostTime = 0; rival.energy = 0; rival.item = null;
      }
    }, 16);
  });

  const measureBoost = async (durationMs: number) => {
    await page.evaluate(() => {
      const w = window as any;
      w.__frames = 0;
      w.__RALLY__.renderer.boostFlamesEmitted = 0;
      w.__boostOn = true;
    });
    await page.waitForTimeout(durationMs);
    return page.evaluate(() => {
      const w = window as any;
      const R = w.__RALLY__;
      const player = R.simulation.state.racers[0];
      const car = R.renderer.cars.get(player.id);
      return {
        flames: R.renderer.boostFlamesEmitted,
        frames: w.__frames,
        fov: R.renderer.camera.fov,
        cameraDistance: R.renderer.camera.position.distanceTo(car.position),
        boostTime: player.boostTime,
      };
    });
  };
  const readFlames = () => page.evaluate(() => (window as any).__RALLY__.renderer.boostFlamesEmitted);
  const resetFlames = () => page.evaluate(() => { (window as any).__RALLY__.renderer.boostFlamesEmitted = 0; });

  // 精细 (default): three flame particles per frame, full pull-back and FOV kick.
  const high = await measureBoost(1500);
  expect(high.boostTime).toBeGreaterThan(0);
  expect(high.frames).toBeGreaterThan(10);
  expect(high.flames).toBeGreaterThanOrEqual(high.frames * 2.5);

  // 流畅: throttled emission, smaller pull-back and FOV kick.
  await page.locator('#quality-button').click();
  await expect(page.locator('#quality-button')).toHaveAttribute('title', '画质：流畅');
  const low = await measureBoost(1500);
  expect(low.boostTime).toBeGreaterThan(0);
  expect(low.flames).toBeLessThanOrEqual(40 * 1.5 + 15); // ~30/s cap, no per-frame burst
  if (high.frames / 1.5 >= 20) expect(low.flames).toBeLessThanOrEqual(high.flames * 0.55);
  expect(low.fov).toBeLessThan(high.fov - 1.5);
  expect(low.cameraDistance).toBeLessThan(high.cameraDistance - 0.3);

  // Back to 精细: original per-frame density returns.
  await page.locator('#quality-button').click();
  await expect(page.locator('#quality-button')).toHaveAttribute('title', '画质：精细');
  const restored = await measureBoost(1500);
  expect(restored.flames).toBeGreaterThanOrEqual(restored.frames * 2.5);

  // Switching to 流畅 mid-boost must not release a batch of stale particles.
  await page.locator('#quality-button').click();
  await resetFlames();
  await page.waitForTimeout(300);
  expect(await readFlames()).toBeLessThanOrEqual(15);
  await page.locator('#quality-button').click();

  // No nitro: neither tier emits flame particles.
  await page.evaluate(() => { (window as any).__boostOn = false; });
  await page.waitForTimeout(900); // let the pinned boostTime fully decay
  await resetFlames();
  await page.waitForTimeout(500);
  expect(await readFlames()).toBe(0);
  await page.locator('#quality-button').click(); // now 流畅
  await resetFlames();
  await page.waitForTimeout(500);
  expect(await readFlames()).toBe(0);

  // Pausing stops emission; resuming continues on the current tier.
  await page.evaluate(() => { (window as any).__boostOn = true; });
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'paused');
  await resetFlames();
  await page.waitForTimeout(400);
  expect(await readFlames()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await page.waitForTimeout(400);
  expect(await readFlames()).toBeGreaterThan(0);

  await page.evaluate(() => {
    const w = window as any;
    w.__boostOn = false;
    clearInterval(w.__pin);
  });
  await page.keyboard.up('w');
  expect(errors).toEqual([]);
});
