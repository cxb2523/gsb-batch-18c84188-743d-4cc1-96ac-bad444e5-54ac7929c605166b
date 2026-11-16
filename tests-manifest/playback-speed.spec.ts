import { test, expect, type Page } from '@playwright/test';
import {
  effectivePlaybackSpeed,
  formatPlaybackSpeed,
  nextPlaybackSpeed,
  parsePlaybackSpeed,
  PLAYBACK_SPEEDS,
} from '../src/playback/playbackSpeed';
import {
  addSecondTour,
  draftOf,
  openFullscreenPlayer,
  startDraft,
  switchTour,
  waitForAudio,
  waitForTour,
} from './visitor-helpers';

/** Speed: the control in both players, the audio element, Media Session, persistence and the tour setting. */

test.use({ serviceWorkers: 'block', viewport: { width: 430, height: 900 } });

const KEY = 'agk-playback-speed';
const speedButton = (page: Page) => page.locator('[data-testid="mini-player"] [data-testid="playback-speed"]');
const rate = (page: Page) => page.evaluate(() => document.querySelector('audio')!.playbackRate);
const defaultRate = (page: Page) => page.evaluate(() => document.querySelector('audio')!.defaultPlaybackRate);

/** Record every setPositionState call (with its time and rate) from before the app boots. */
const recordPositionStates = (page: Page) =>
  page.addInitScript(() => {
    const calls: { t: number; playbackRate: number }[] = [];
    (window as unknown as { __positionStates: typeof calls }).__positionStates = calls;
    const original = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
    navigator.mediaSession.setPositionState = (state) => {
      if (state) calls.push({ t: performance.now(), playbackRate: state.playbackRate ?? 1 });
      return original(state);
    };
  });

const lastReportedRate = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __positionStates: { playbackRate: number }[] }).__positionStates.at(-1)?.playbackRate,
  );

/** Each audio stop gets its own URL, and no transition sound, so a stop change really reloads the source. */
function distinctStops(draft: ReturnType<typeof draftOf>) {
  delete draft.metadata.transitionAudio;
  let n = 0;
  for (const tour of draft.manifest.tours) {
    for (const file of Object.values(tour.languages)) {
      for (const stop of file.stops) {
        if (stop.type !== 'audio' || !stop.audioFile) continue;
        stop.audioFile = `${stop.audioFile}${stop.audioFile.includes('?') ? '&' : '?'}stop=${++n}`;
      }
    }
  }
  return draft;
}

test.describe('speed choices', () => {
  test('offers 0.75, 1, 1.25, 1.5 and 2, and steps through them in a loop', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.75, 1, 1.25, 1.5, 2]);
    expect(nextPlaybackSpeed(0.75)).toBe(1);
    expect(nextPlaybackSpeed(1.5)).toBe(2);
    expect(nextPlaybackSpeed(2)).toBe(0.75);
    expect(formatPlaybackSpeed(1.25)).toBe('1.25×');
    expect(formatPlaybackSpeed(1)).toBe('1×');
  });

  test('a stored value that is not one of the choices means normal speed', () => {
    expect(parsePlaybackSpeed('1.5')).toBe(1.5);
    for (const bad of [null, undefined, '', 'fast', '3', '0', '-1', 'NaN', '1.2']) expect(parsePlaybackSpeed(bad), String(bad)).toBe(1);
  });

  test('the tour setting decides the rate: hidden means 1×, shown means the saved choice', () => {
    expect(effectivePlaybackSpeed(true, 1.5)).toBe(1.5);
    expect(effectivePlaybackSpeed(false, 1.5)).toBe(1);
    expect(effectivePlaybackSpeed(false, 2)).toBe(1);
    expect(effectivePlaybackSpeed(true, 1)).toBe(1);
  });
});

test.describe('in the player', () => {
  test('the mini player steps through every speed and the audio element follows', async ({ page }) => {
    await startDraft(page, draftOf());
    await waitForAudio(page);
    await expect(speedButton(page)).toHaveAccessibleName('Speed: 1×');
    expect(await rate(page)).toBe(1);

    for (const speed of [1.25, 1.5, 2, 0.75, 1]) {
      await speedButton(page).click();
      await expect(speedButton(page)).toHaveAccessibleName(`Speed: ${speed}×`);
      expect(await rate(page)).toBe(speed);
    }
  });

  test('a screen reader hears the new speed through a polite status region', async ({ page }) => {
    await startDraft(page, draftOf());
    await speedButton(page).click();
    await expect(page.locator('[data-testid="mini-player"] [role="status"]')).toHaveText('Speed: 1.25×');
    await expect(page.locator('[data-testid="mini-player"] [role="status"]')).toHaveAttribute('aria-live', 'polite');
  });

  test('the speed is remembered on the device and kept for the next stop', async ({ page }) => {
    await startDraft(page, draftOf());
    await waitForAudio(page);
    await speedButton(page).click(); // 1.25
    await speedButton(page).click(); // 1.5
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('1.5');

    // Let the first stop end: load() on the next one resets the rate unless the default rate is set too.
    const firstSrc = await page.evaluate(() => document.querySelector('audio')!.src);
    await page.evaluate(() => { const a = document.querySelector('audio')!; a.currentTime = Math.max(a.duration - 1.5, 0); });
    await expect.poll(() => page.evaluate(() => document.querySelector('audio')!.src), { timeout: 20000 }).not.toBe(firstSrc);
    expect(await rate(page)).toBe(1.5);

    await page.reload();
    await startDraft(page, draftOf());
    await expect(speedButton(page)).toHaveAccessibleName('Speed: 1.5×');
    expect(await rate(page)).toBe(1.5);
  });

  test('going back to normal speed clears the stored value', async ({ page }) => {
    await startDraft(page, draftOf());
    await speedButton(page).click();
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('1.25');
    for (let i = 0; i < 4; i++) await speedButton(page).click(); // 1.5, 2, 0.75, 1
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  });

  test('Media Session is told the speed, so the lock screen scrubber keeps pace', async ({ page }) => {
    await page.addInitScript(() => {
      const calls: { playbackRate: number }[] = [];
      (window as unknown as { __positionStates: typeof calls }).__positionStates = calls;
      const original = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
      navigator.mediaSession.setPositionState = (state) => {
        if (state) calls.push({ playbackRate: state.playbackRate ?? 1 });
        return original(state);
      };
    });
    await startDraft(page, draftOf());
    await waitForAudio(page);
    await speedButton(page).click();
    await speedButton(page).click(); // 1.5
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __positionStates: { playbackRate: number }[] }).__positionStates.at(-1)?.playbackRate))
      .toBe(1.5);
  });

  test('the full player has the same control, in step with the mini player', async ({ page }) => {
    const draft = draftOf();
    draft.metadata.fullscreenPlayer = true;
    await startDraft(page, draft);
    await waitForAudio(page);
    await openFullscreenPlayer(page);
    const full = page.locator('[data-testid="fullscreen-player"]');

    await full.locator('[data-testid="playback-speed"]').click();
    await expect(full.locator('[data-testid="playback-speed"]')).toHaveAccessibleName('Speed: 1.25×');
    await expect(speedButton(page)).toHaveAccessibleName('Speed: 1.25×');
    expect(await rate(page)).toBe(1.25);
  });
});

test.describe('the tour setting', () => {
  test('showPlaybackSpeed: false removes the control from both players', async ({ page }) => {
    const draft = draftOf();
    draft.metadata.showPlaybackSpeed = false;
    draft.metadata.fullscreenPlayer = true;
    await startDraft(page, draft);
    await waitForAudio(page);
    await expect(page.locator('[data-testid="playback-speed"]')).toHaveCount(0);
    await openFullscreenPlayer(page);
    await expect(page.locator('[data-testid="playback-speed"]')).toHaveCount(0);
  });

  test('a speed chosen on this device is ignored while the control is hidden', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '2'), KEY);
    const draft = draftOf();
    draft.metadata.showPlaybackSpeed = false;
    await startDraft(page, draft);
    await waitForAudio(page);
    expect(await rate(page)).toBe(1);
  });

  test('hidden plays at 1× everywhere and never overwrites the saved choice', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '1.5'), KEY);
    await recordPositionStates(page);
    const draft = distinctStops(draftOf());
    draft.metadata.showPlaybackSpeed = false;
    await startDraft(page, draft);
    await waitForAudio(page);

    // The audio element (both properties, so a later load() cannot restore the stored 1.5×)…
    expect(await rate(page)).toBe(1);
    expect(await defaultRate(page)).toBe(1);
    expect(await page.locator('[data-testid="playback-speed"]').count()).toBe(0);
    // …the lock screen…
    await expect.poll(() => lastReportedRate(page), { timeout: 10000 }).toBe(1);
    // …and the device: the choice is ignored, not erased.
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('1.5');
  });

  test('re-enabling the control returns to the saved speed, also after a stop change', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '1.5'), KEY);
    await recordPositionStates(page);
    const draft = addSecondTour(distinctStops(draftOf()), 'quiet-tour', { showPlaybackSpeed: false }, 'Quiet tour');
    await startDraft(page, draft, 'quiet-tour'); // the tour whose control is hidden
    await waitForAudio(page);
    expect(await rate(page)).toBe(1);
    expect(await defaultRate(page)).toBe(1);

    // The visitor opens a tour that shows the control: the saved 1.5× applies again.
    await switchTour(page, 'barcelona-evening');
    await waitForTour(page, 'barcelona-evening');
    await expect(speedButton(page)).toHaveAccessibleName('Speed: 1.5×');
    await expect.poll(() => rate(page), { timeout: 10000 }).toBe(1.5);
    expect(await defaultRate(page)).toBe(1.5);
    await expect.poll(() => lastReportedRate(page), { timeout: 10000 }).toBe(1.5);

    // A new stop is a load(): the rate must not fall back to 1×.
    const firstSrc = await page.evaluate(() => document.querySelector('audio')!.src);
    await page.evaluate(() => { const a = document.querySelector('audio')!; a.currentTime = Math.max(a.duration - 0.6, 0); });
    await expect.poll(() => page.evaluate(() => document.querySelector('audio')!.src), { timeout: 20000 }).not.toBe(firstSrc);
    expect(await rate(page)).toBe(1.5);
    expect(await defaultRate(page)).toBe(1.5);
  });

  test('a new speed is reported to the lock screen at once, not at the next whole second', async ({ page }) => {
    await recordPositionStates(page);
    await startDraft(page, distinctStops(draftOf()));
    await waitForAudio(page);

    // Change the speed in the same tick as a periodic report, i.e. at the very start of the
    // one-second throttle window. Only an immediate report can reach the OS inside it; a
    // reporter that waits for the next tick of the throttle cannot answer for ~1 s.
    const measured = await page.evaluate(async () => {
      type Call = { t: number; playbackRate: number };
      const calls = (window as unknown as { __positionStates: Call[] }).__positionStates;
      const button = document.querySelector<HTMLButtonElement>('[data-testid="mini-player"] [data-testid="playback-speed"]')!;
      const deadline = performance.now() + 10000;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const reportedRate = () => calls.at(-1)?.playbackRate ?? 1;
      const click = () => button.click();

      while (performance.now() < deadline) {
        // A previous round may have left the speed elsewhere; cycle back to 1× first
        // (1 → 1.25 → 1.5 → 2 → 0.75 → 1 is at most five clicks).
        for (let i = 0; i < 5 && reportedRate() !== 1; i++) {
          click();
          await wait(100);
        }
        if (reportedRate() !== 1) break;

        // Wait for a periodic report of the current rate, then click straight away.
        const startedWith = calls.length;
        let report: Call | undefined;
        while (!report && performance.now() < deadline) {
          report = calls.slice(startedWith).find((call) => call.playbackRate === 1);
          if (!report) await wait(5);
        }
        if (!report) break;

        const clickedAt = performance.now();
        click();
        if (clickedAt - report.t > 100) {
          // The click landed too late to be inside the window; let playback settle and retry.
          await wait(1000);
          continue;
        }

        // The first report after that click that carries the new speed.
        let changed: Call | undefined;
        while (!changed && performance.now() < deadline) {
          changed = calls.find((call) => call.t >= clickedAt && call.playbackRate === 1.25);
          if (!changed) await wait(5);
        }
        if (!changed) throw new Error('the new speed was never reported');
        return { sinceReport: clickedAt - report.t, delay: changed.t - clickedAt };
      }
      throw new Error('could not click inside the throttle window');
    });

    expect(measured.sinceReport).toBeLessThan(100); // really inside the window
    expect(measured.delay).toBeLessThan(300); // …and the change did not wait for it to end
  });

  test('on by default', async ({ page }) => {
    await startDraft(page, draftOf());
    await expect(speedButton(page)).toBeVisible();
  });
});
