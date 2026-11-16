import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DURATION,
  generateTimeline,
  stateAt,
  type Mode,
  type Timeline,
  type TimelineOptions,
} from '../timeline';
import { breakAt, breakPose, breakTiming } from './breaks';
import { handPoseAt } from './hands';
import { pressFlash } from './keyboard';
import { renderFrame } from './renderFrame';

/**
 * Breaks are choreographed inside their own interval, and the generator scales that interval together
 * with the events when the video has to be squeezed to `maxDuration`. These tests make sure the gesture
 * stays in sync with the typing after that scaling: nothing is pressed (or looks pressed) during a
 * break, the prop is raised and lowered strictly inside the interval, and the drawn hand is already
 * back at its typing position before the break ends — so the next press never starts from mid-air.
 */

const TEXT = 'Привет! Как дела? Давай встретимся завтра в пять у метро, ок? Напиши мне, пожалуйста, когда будешь свободен.';

const tl = (o: Partial<TimelineOptions> & { text: string; mode: Mode }) =>
  generateTimeline({ lang: 'ru', seed: 7, ...o });

/** Default length plus caps that force the events and breaks to shrink together. */
const CASES: { name: string; tl: Timeline }[] = [
  { name: 'default', tl: tl({ text: TEXT, mode: 'breaks' }) },
  { name: 'maxDuration=default', tl: tl({ text: TEXT, mode: 'breaks', maxDuration: DEFAULT_MAX_DURATION }) },
  { name: 'maxDuration=30', tl: tl({ text: TEXT, mode: 'breaks', maxDuration: 30 }) },
  { name: 'maxDuration=20', tl: tl({ text: TEXT, mode: 'breaks', maxDuration: 20 }) },
  { name: 'maxDuration=12', tl: tl({ text: TEXT, mode: 'breaks', maxDuration: 12 }) },
  // Heavy squeeze: the fixed press-flash window (0.12 s) is longer than the gap before a break.
  { name: 'maxDuration=8', tl: tl({ text: TEXT, mode: 'breaks', maxDuration: 8 }) },
];

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('break choreography under compression', () => {
  it('breaks mode keeps non-degenerate breaks; normal mode has none', () => {
    for (const { name, tl: t } of CASES) {
      expect(t.breaks.length, name).toBeGreaterThanOrEqual(1);
      for (const b of t.breaks) {
        expect(b.t1, name).toBeGreaterThan(b.t0);
        expect(b.t0, name).toBeGreaterThanOrEqual(0);
        expect(b.t1, name).toBeLessThanOrEqual(t.duration + 1e-9);
        expect(Number.isFinite(breakPose(b, b.t0).offset.x), name).toBe(true);
      }
    }
    expect(tl({ text: TEXT, mode: 'normal' }).breaks).toEqual([]);
    expect(tl({ text: TEXT, mode: 'grandpa' }).breaks).toEqual([]);
    expect(tl({ text: TEXT, mode: 'typos' }).breaks).toEqual([]);
    expect(tl({ text: TEXT, mode: 'manicure' }).breaks).toEqual([]);
  });

  it('no event — and no press flash — falls inside a break', () => {
    for (const { name, tl: t } of CASES) {
      for (const b of t.breaks) {
        for (const e of t.events) {
          expect(e.t >= b.t0 && e.t <= b.t1, `${name}: ${e.type} at ${e.t} inside ${b.t0}..${b.t1}`).toBe(false);
        }
        // The highlight/popup of the last press before the break must not spill into it.
        const before = stateAt(t, b.t0);
        expect(pressFlash(before, b.t0, true), `${name}: flash at break start`).toBeNull();
        for (let k = 0; k <= 20; k++) {
          const at = b.t0 + ((b.t1 - b.t0) * k) / 20;
          expect(handPoseAt(t, at).press, `${name}: pressing at ${at}`).toBe(0);
        }
      }
    }
  });

  it('the prop is raised and lowered strictly inside the interval', () => {
    for (const { name, tl: t } of CASES) {
      for (const b of t.breaks) {
        const tm = breakTiming(b);
        expect(tm.propFrom, name).toBeGreaterThan(b.t0);
        expect(tm.propUntil, name).toBeLessThan(b.t1);
        expect(tm.raise.start, name).toBeGreaterThanOrEqual(tm.propFrom);
        expect(tm.raise.end, name).toBeLessThanOrEqual(tm.propUntil);
        expect(tm.lower.start, name).toBeGreaterThanOrEqual(tm.raise.end);
        expect(tm.lower.end, name).toBeLessThanOrEqual(tm.propUntil);

        for (let k = 0; k <= 400; k++) {
          const at = b.t0 + ((b.t1 - b.t0) * k) / 400;
          const p = breakPose(b, at);
          if (p.prop) {
            expect(at, `${name}: prop at ${at}`).toBeGreaterThanOrEqual(tm.propFrom - 1e-9);
            expect(at, `${name}: prop at ${at}`).toBeLessThanOrEqual(tm.propUntil + 1e-9);
          }
          if (p.raise > 0) {
            expect(at, `${name}: raised at ${at}`).toBeGreaterThanOrEqual(tm.raise.start - 1e-9);
            expect(at, `${name}: raised at ${at}`).toBeLessThanOrEqual(tm.lower.end + 1e-9);
          }
          // A prop that is not in the hand can never be raised.
          if (!p.prop) expect(p.raise, `${name}: raised without prop at ${at}`).toBe(0);
        }
      }
    }
  });

  it('the hand is back at its typing position before the break ends', () => {
    for (const { name, tl: t } of CASES) {
      for (const b of t.breaks) {
        const span = b.t1 - b.t0;
        // Independent of breakTiming: in the last 5% of the interval — still inside the break — the
        // drawn right hand must already be at its typing position, not on its way back. (The original
        // fraction-based choreography only reached home exactly at t1, so the next key press could
        // start from mid-air once the interval was compressed.)
        const home = handPoseAt(t, b.t1).homes[1]!;
        for (let k = 0; k <= 5; k++) {
          const at = b.t1 - span * (0.05 * (1 - k / 5)); // t1-5% … t1
          const pose = handPoseAt(t, at);
          expect(pose.typing, `${name}: not typing at ${at} (span ${span})`).toBe(true);
          expect(dist(pose.tips[1]!, home), `${name}: hand away from home at ${at}`).toBeLessThan(0.5);
        }

        const tm = breakTiming(b);
        // A real settle window: the return finishes strictly before t1.
        expect(tm.settled, `${name}: settled=${tm.settled} t1=${b.t1}`).toBeLessThan(b.t1);
        expect(tm.settled, `${name}: settled before t0`).toBeGreaterThan(b.t0);

        // And it does not start reaching for the next key before the break is over.
        const next = t.events.find((e) => e.t > b.t1);
        if (next) {
          for (let k = 0; k <= 10; k++) {
            const at = tm.settled + ((b.t1 - tm.settled) * k) / 10;
            expect(dist(handPoseAt(t, at).tips[1]!, home), `${name}: reaching at ${at}`).toBeLessThan(0.5);
          }
        }
      }
    }
  });

  it('the other fingers rest instead of typing during a break', () => {
    for (const { name, tl: t } of CASES) {
      for (const b of t.breaks) {
        const tm = breakTiming(b);
        const mid = (tm.enter.start + tm.propUntil) / 2; // the middle of the break, prop in hand
        const pose = handPoseAt(t, mid);
        // Non-break fingers are at their homes (not travelling to a key) in the middle of a break.
        for (let i = 0; i < pose.tips.length; i++) {
          if (i === 1) continue;
          expect(dist(pose.tips[i]!, pose.homes[i]!), `${name}: finger ${i} away at ${mid}`).toBeLessThan(0.5);
        }
      }
    }
  });

  it('holds for many seeds and compression levels', () => {
    for (let seed = 0; seed < 12; seed++) {
      for (const maxDuration of [undefined, 60, 30, 20, 15, 12, 10]) {
        const t = tl({ text: TEXT, mode: 'breaks', seed, maxDuration });
        for (const b of t.breaks) {
          // Nothing pressed inside, both hands back in the typing pose in the last 5% of the break.
          const home = handPoseAt(t, b.t1).homes;
          for (let k = 0; k <= 10; k++) {
            const at = b.t0 + ((b.t1 - b.t0) * k) / 10;
            expect(handPoseAt(t, at).press, `seed ${seed} max ${maxDuration}: press at ${at}`).toBe(0);
          }
          for (let k = 0; k <= 4; k++) {
            const at = b.t1 - (b.t1 - b.t0) * (0.05 * (1 - k / 4));
            const pose = handPoseAt(t, at);
            expect(pose.typing, `seed ${seed} max ${maxDuration}: typing at ${at}`).toBe(true);
            pose.tips.forEach((tip, i) => {
              expect(dist(tip, home[i]!), `seed ${seed} max ${maxDuration}: finger ${i} at ${at}`).toBeLessThan(0.5);
            });
          }
          const tm = breakTiming(b);
          expect(tm.propFrom, `seed ${seed}`).toBeGreaterThan(b.t0);
          expect(tm.propUntil, `seed ${seed}`).toBeLessThan(b.t1);
          expect(tm.settled, `seed ${seed}`).toBeLessThan(b.t1);
        }
      }
    }
  });

  it('the same seed gives an identical timeline, breaks included', () => {
    for (const maxDuration of [undefined, 60, 20, 12]) {
      const a = tl({ text: TEXT, mode: 'breaks', maxDuration });
      const b = tl({ text: TEXT, mode: 'breaks', maxDuration });
      expect(a).toEqual(b);
      expect(a.breaks).toEqual(b.breaks);
    }
    // And a different seed is still allowed to differ.
    expect(tl({ text: TEXT, mode: 'breaks', seed: 1 }).breaks).not.toEqual(
      tl({ text: TEXT, mode: 'breaks', seed: 2 }).breaks,
    );
  });
});

describe('renderFrame with breaks under compression', () => {
  const canvas = createCanvas(240, 240);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;

  for (const { name, tl: t } of CASES) {
    it(`renders every frame of ${name} without errors`, () => {
      expect(t.breaks.length).toBeGreaterThan(0);
      for (let at = 0; at <= t.duration; at += 0.1) {
        expect(
          () => renderFrame(ctx, t, Math.min(at, t.duration), { width: 240, height: 240, watermark: 'test' }),
          `${name}: frame at ${at}`,
        ).not.toThrow();
      }
      // The break is actually visible: the frame in the middle of it is not just the table colour.
      for (const b of t.breaks) {
        renderFrame(ctx, t, (b.t0 + b.t1) / 2, { width: 240, height: 240, watermark: 'test' });
        const px = ctx.getImageData(120, 120, 1, 1).data;
        expect([px[0], px[1], px[2]], name).not.toEqual([0x3a, 0x2f, 0x27]);
      }
    });
  }

  it('the frame right after a compressed break shows the hand back at the keyboard', () => {
    const t = tl({ text: TEXT, mode: 'breaks', maxDuration: 8 });
    for (const b of t.breaks) {
      const next = t.events.find((e) => e.t > b.t1);
      if (!next) continue;
      // At the break's end the hand is already in the typing pose, at its home position.
      const end = handPoseAt(t, b.t1);
      expect(end.typing, 'typing pose at break end').toBe(true);
      expect(dist(end.tips[1]!, end.homes[1]!), 'hand home at break end').toBeLessThan(0.5);
      // And the first frame of the following press renders with no leftover break transform.
      renderFrame(ctx, t, next.t, { width: 240, height: 240, watermark: 'test' });
      expect(handPoseAt(t, next.t).typing).toBe(true);
    }
  });

  it('normal mode never enters a break pose', () => {
    const normal = tl({ text: TEXT, mode: 'normal' });
    expect(normal.breaks).toEqual([]);
    for (let at = 0; at <= normal.duration; at += 0.25) {
      expect(breakAt(normal, at)).toBeNull();
      const pose = handPoseAt(normal, at);
      expect(pose.breakOffset).toEqual({ x: 0, y: 0 });
      expect(pose.prop).toBeNull();
      expect(() => renderFrame(ctx, normal, at, { width: 240, height: 240, watermark: 'test' })).not.toThrow();
    }
  });
});
