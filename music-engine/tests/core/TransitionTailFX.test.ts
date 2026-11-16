import { describe, expect, it } from 'vitest';
import { MusicEngine } from '../../src/core/MusicEngine';
import { FXRegistry, TAIL_FX_IDS } from '../../src/fx/FXRegistry';
import { MockAudioContext } from '../helpers/MockAudioContext';
import type {
  FXInstance,
  FXPlugin,
  GenerationContext,
  InstrumentPlugin,
  MusicalEvent,
  ParamValue,
  StyleContext,
  StyleInstance,
  StylePlugin,
} from '../../src/core/types';

/**
 * Transition tail hygiene:
 *  - when a style/seed switch starts, reverb + shimmer wet must converge to
 *    near zero *before* the boundary (old tail cannot ring into the new style);
 *  - at the boundary the long-tail FX are not reset, and the incoming style's
 *    own reverb/shimmer parameters are the last ones written, so they survive;
 *  - ordinary playback / pause / resume never triggers that convergence, and a
 *    full stop keeps resetting everything (unchanged behaviour).
 */

interface WetCall {
  fx: string;
  value: number;
  at: number;
}

interface ResetCounts {
  reverb: number;
  shimmer: number;
  eq: number;
}

function tailFXPlugin(
  id: string,
  mock: MockAudioContext,
  wetLog: WetCall[],
  resets: ResetCounts,
): FXPlugin {
  return {
    id,
    name: id,
    create: () => {
      const node = mock.createGain() as unknown as AudioNode;
      const inst: FXInstance = {
        input: node,
        output: node,
        setParameter(name, value) {
          if (name === 'wet') wetLog.push({ fx: id, value, at: mock.currentTime });
        },
        reset() {
          if (id === 'reverb' || id === 'shimmer' || id === 'eq') {
            resets[id as keyof ResetCounts]++;
          }
        },
        dispose() {},
      };
      return inst;
    },
  };
}

/** Minimal style that arms reverb/shimmer wet in start() like the real ones. */
function tailStyle(
  id: string,
  wet: { reverb: number; shimmer: number },
): StylePlugin {
  class TailStyleInstance implements StyleInstance {
    start(context: StyleContext): void {
      context.fx.get('reverb')?.setParameter('wet', wet.reverb);
      context.fx.get('shimmer')?.setParameter('wet', wet.shimmer);
    }
    stop(): void {}
    generateEvents(_context: GenerationContext): MusicalEvent[] {
      return [];
    }
    setParameter(_name: string, _value: ParamValue): void {}
    nextBoundary(currentPosition: number): number {
      return currentPosition + 1.2; // deterministic, short transition window
    }
  }
  return {
    id,
    name: id,
    version: '1.0.0',
    description: id,
    timeMode: 'beat',
    tags: [],
    color: '#000000',
    parameters: [],
    presets: [],
    requiredFX: ['reverb'],
    optionalFX: ['shimmer', 'eq'],
    create: () => new TailStyleInstance(),
  };
}

const pluckInstrument: InstrumentPlugin = {
  id: 'pluck',
  name: 'pluck',
  create: () => ({
    trigger() {},
    stopAll() {},
    setParameter() {},
  }),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function play(engine: MusicEngine, mock: MockAudioContext, seconds: number, step = 0.1): void {
  for (let t = 0; t < seconds; t += step) {
    mock.advance(step);
    (engine as any).scheduler.tick();
  }
}

function makeEngine(mock: MockAudioContext, wetLog: WetCall[], resets: ResetCounts): MusicEngine {
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: 'tail-a',
    seed: '777',
    lookAhead: 0.16,
  });
  engine.registerInstrument(pluckInstrument);
  engine.registerFX(tailFXPlugin('reverb', mock, wetLog, resets));
  engine.registerFX(tailFXPlugin('shimmer', mock, wetLog, resets));
  engine.registerFX(tailFXPlugin('eq', mock, wetLog, resets));
  engine.registerStyle(tailStyle('tail-a', { reverb: 0.4, shimmer: 0.3 }));
  engine.registerStyle(tailStyle('tail-b', { reverb: 0.7, shimmer: 0.55 }));
  return engine;
}

const NEAR_ZERO = 0.001;
const wetOf = (log: WetCall[], fx: string): number[] => log.filter((c) => c.fx === fx).map((c) => c.value);
const lastWet = (log: WetCall[], fx: string): number => {
  const values = wetOf(log, fx);
  return values[values.length - 1];
};

describe('MusicEngine transition tail hygiene (mock AudioContext + stub FX)', () => {
  it('converges reverb/shimmer wet to near zero when a style transition begins', async () => {
    const mock = new MockAudioContext();
    const wetLog: WetCall[] = [];
    const resets: ResetCounts = { reverb: 0, shimmer: 0, eq: 0 };
    const engine = makeEngine(mock, wetLog, resets);

    await engine.start();
    expect(lastWet(wetLog, 'reverb')).toBe(0.4);
    expect(lastWet(wetLog, 'shimmer')).toBe(0.3);
    const beginAt = mock.currentTime;

    // The transition starts at the next boundary (1.2 s of transport time
    // later); convergence must already be scheduled synchronously, before any
    // clock advance — i.e. strictly before the boundary.
    engine.useStyle('tail-b');
    expect((engine as any).transitioning).toBe(true);

    const converged = wetLog.filter((c) => c.value <= NEAR_ZERO);
    expect(converged.map((c) => c.fx).sort()).toEqual([...TAIL_FX_IDS].sort());
    for (const call of converged) expect(call.at).toBeLessThanOrEqual(beginAt);

    // Reach the boundary and let the transition timer fire.
    mock.advance(1.3);
    await sleep(1500);
    (engine as any).scheduler.tick();

    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('tail-b');
    await engine.dispose();
  });

  it('keeps the new style reverb/shimmer parameters after the boundary and never resets the tail FX', async () => {
    const mock = new MockAudioContext();
    const wetLog: WetCall[] = [];
    const resets: ResetCounts = { reverb: 0, shimmer: 0, eq: 0 };
    const engine = makeEngine(mock, wetLog, resets);

    await engine.start();
    engine.useStyle('tail-b');

    // The near-zero convergence write must precede the new style's arming.
    const reverbSequence = wetOf(wetLog, 'reverb');
    const convergeIdx = reverbSequence.findIndex((v) => v <= NEAR_ZERO);
    expect(convergeIdx).toBeGreaterThanOrEqual(0);

    mock.advance(1.3);
    await sleep(1500);
    (engine as any).scheduler.tick();

    expect(engine.getState().styleId).toBe('tail-b');

    // Tail FX were never reset: reset() would restore default audible wet and
    // would have clobbered the parameters the new style set in start().
    expect(resets.reverb).toBe(0);
    expect(resets.shimmer).toBe(0);
    // The serial FX still get their neutral reset at the boundary.
    expect(resets.eq).toBe(1);

    // The final word on wet belongs to the incoming style.
    expect(lastWet(wetLog, 'reverb')).toBe(0.7);
    expect(lastWet(wetLog, 'shimmer')).toBe(0.55);
    const finalSequence = wetOf(wetLog, 'reverb');
    expect(finalSequence.indexOf(0.7)).toBeGreaterThan(convergeIdx);

    // Nothing resets the tails on later scheduler ticks either.
    play(engine, mock, 0.5);
    expect(resets.reverb).toBe(0);
    expect(resets.shimmer).toBe(0);
    expect(lastWet(wetLog, 'reverb')).toBe(0.7);
    expect(lastWet(wetLog, 'shimmer')).toBe(0.55);

    await engine.dispose();
  });

  it('converges the tail wet on a seed-only transition as well', async () => {
    const mock = new MockAudioContext();
    const wetLog: WetCall[] = [];
    const resets: ResetCounts = { reverb: 0, shimmer: 0, eq: 0 };
    const engine = makeEngine(mock, wetLog, resets);

    await engine.start();
    engine.setSeed('4242');
    expect((engine as any).transitioning).toBe(true);

    const converged = wetLog.filter((c) => c.value <= NEAR_ZERO);
    expect(converged.map((c) => c.fx).sort()).toEqual([...TAIL_FX_IDS].sort());

    mock.advance(1.3);
    await sleep(1500);
    (engine as any).scheduler.tick();

    expect(engine.getState().seed).toBe('4242');
    expect(engine.getState().status).toBe('playing');
    expect(resets.reverb).toBe(0);
    expect(resets.shimmer).toBe(0);
    // Same style re-armed itself with its own wet — the near-zero value is not
    // left in place.
    expect(lastWet(wetLog, 'reverb')).toBe(0.4);
    expect(lastWet(wetLog, 'shimmer')).toBe(0.3);

    await engine.dispose();
  });

  it('never converges tail wet during normal playback, pause or resume', async () => {
    const mock = new MockAudioContext();
    const wetLog: WetCall[] = [];
    const resets: ResetCounts = { reverb: 0, shimmer: 0, eq: 0 };
    const engine = makeEngine(mock, wetLog, resets);

    await engine.start();
    play(engine, mock, 2.0);
    expect(wetLog.some((c) => c.value <= NEAR_ZERO)).toBe(false);

    engine.pause();
    await sleep(180); // suspend wind-down
    expect(mock.state).toBe('suspended');
    await engine.resume();
    play(engine, mock, 1.0);
    expect(wetLog.some((c) => c.value <= NEAR_ZERO)).toBe(false);

    // Master volume path is independent of the tail convergence.
    const volumeBefore = engine.getMasterVolume();
    engine.setMasterVolume(0.42);
    expect(engine.getMasterVolume()).toBe(0.42);
    expect(volumeBefore).not.toBe(0.42);
    expect(wetLog.some((c) => c.value <= NEAR_ZERO)).toBe(false);

    // A full stop keeps the old, non-transition behaviour: every FX resets,
    // reverb and shimmer included.
    engine.stop();
    await sleep(260);
    expect(engine.getState().status).toBe('idle');
    expect(resets.reverb).toBe(1);
    expect(resets.shimmer).toBe(1);
    expect(resets.eq).toBe(1);

    await engine.dispose();
  });
});

describe('FXRegistry transition primitives', () => {
  function stubPlugin(id: string, state: { wet: number[]; resets: number }): FXPlugin {
    return {
      id,
      name: id,
      create: () => ({
        input: {} as AudioNode,
        output: {} as AudioNode,
        setParameter(name, value) {
          if (name === 'wet') state.wet.push(value);
        },
        reset() {
          state.resets++;
        },
        dispose() {},
      }),
    };
  }

  it('convergeTailWet only touches the long-tail FX and drives wet to near zero', () => {
    const registry = new FXRegistry();
    const reverb = { wet: [0.35], resets: 0 };
    const shimmer = { wet: [0.2], resets: 0 };
    const delay = { wet: [0.5], resets: 0 };
    registry.register(stubPlugin('reverb', reverb));
    registry.register(stubPlugin('shimmer', shimmer));
    registry.register(stubPlugin('delay', delay));
    registry.instantiateAll(() => ({ audioContext: {} as AudioContext, noiseBuffer: {} as AudioBuffer }));

    registry.convergeTailWet();

    expect(reverb.wet[reverb.wet.length - 1]).toBeLessThanOrEqual(NEAR_ZERO);
    expect(shimmer.wet[shimmer.wet.length - 1]).toBeLessThanOrEqual(NEAR_ZERO);
    // Untouched serial FX.
    expect(delay.wet).toEqual([0.5]);
    expect(reverb.resets).toBe(0);
    expect(shimmer.resets).toBe(0);
  });

  it('resetAllExceptTailFX neutralises serial FX while preserving tail state', () => {
    const registry = new FXRegistry();
    const reverb = { wet: [0.0001], resets: 0 };
    const shimmer = { wet: [0.0001], resets: 0 };
    const eq = { wet: [] as number[], resets: 0 };
    registry.register(stubPlugin('reverb', reverb));
    registry.register(stubPlugin('shimmer', shimmer));
    registry.register(stubPlugin('eq', eq));
    registry.instantiateAll(() => ({ audioContext: {} as AudioContext, noiseBuffer: {} as AudioBuffer }));

    registry.resetAllExceptTailFX();

    expect(eq.resets).toBe(1);
    expect(reverb.resets).toBe(0);
    expect(shimmer.resets).toBe(0);
    expect(reverb.wet).toEqual([0.0001]);
    expect(shimmer.wet).toEqual([0.0001]);

    // The ordinary full reset still covers everything (non-transition paths).
    registry.resetAll();
    expect(eq.resets).toBe(2);
    expect(reverb.resets).toBe(1);
    expect(shimmer.resets).toBe(1);
  });
});
