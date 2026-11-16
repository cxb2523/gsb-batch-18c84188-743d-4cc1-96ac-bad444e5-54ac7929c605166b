/**
 * EQ bypass tests for the Player audio engine.
 *
 * WebAudio and the DOM don't exist in the node test environment, so the
 * graph is mocked: every created node records its outgoing connections,
 * letting the tests assert the actual ROUTING (the whole point of a true
 * bypass) plus the gain values on the preamp and each BiquadFilter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EQ_FREQS, Player } from '../src/player';
import type { Track } from '@shared';

const dbToGain = (db: number): number => Math.pow(10, db / 20);

// ------------------------------------------------------------------- mocks
class MockParam {
  constructor(public value: number) {}
}

class MockNode {
  outgoing: MockNode[] = [];
  connect(dest: MockNode): void {
    this.outgoing.push(dest);
  }
  disconnect(): void {
    this.outgoing = [];
  }
}

class MockGainNode extends MockNode {
  gain = new MockParam(1);
}

class MockBiquadFilterNode extends MockNode {
  type = '';
  frequency = new MockParam(0);
  Q = new MockParam(1);
  gain = new MockParam(0);
}

class MockAnalyserNode extends MockNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getByteFrequencyData(): void {}
  getByteTimeDomainData(): void {}
}

class MockStereoPannerNode extends MockNode {
  pan = new MockParam(0);
}

class MockAudioContext {
  state = 'running';
  sampleRate = 48000;
  destination = new MockNode();
  gains: MockGainNode[] = [];
  biquads: MockBiquadFilterNode[] = [];
  analysers: MockAnalyserNode[] = [];
  panners: MockStereoPannerNode[] = [];
  sources: MockNode[] = [];
  createGain(): MockGainNode {
    const n = new MockGainNode();
    this.gains.push(n);
    return n;
  }
  createBiquadFilter(): MockBiquadFilterNode {
    const n = new MockBiquadFilterNode();
    this.biquads.push(n);
    return n;
  }
  createAnalyser(): MockAnalyserNode {
    const n = new MockAnalyserNode();
    this.analysers.push(n);
    return n;
  }
  createStereoPanner(): MockStereoPannerNode {
    const n = new MockStereoPannerNode();
    this.panners.push(n);
    return n;
  }
  createMediaElementSource(): MockNode {
    const n = new MockNode();
    this.sources.push(n);
    return n;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class MockAudioElement {
  preload = '';
  volume = 1;
  src = '';
  currentTime = 0;
  ended = false;
  duration = NaN;
  error = null;
  private handlers = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

/** Every AudioContext constructed by the code under test, in order. */
const contexts: MockAudioContext[] = [];

vi.stubGlobal(
  'AudioContext',
  class extends MockAudioContext {
    constructor() {
      super();
      contexts.push(this);
    }
  },
);
vi.stubGlobal('Audio', MockAudioElement);
vi.stubGlobal('document', { addEventListener: () => {} });

const TRACK: Track = {
  id: 't1',
  artist: 'a',
  title: 't',
  album: '',
  durationMs: 60_000,
} as Track;

function makePlayer(): Player {
  const player = new Player();
  player.setPlaylist([TRACK]);
  player.on('error', () => {}); // swallow; assertions below cover behaviour
  return player;
}

function graphOf(): MockAudioContext {
  const ctx = contexts[contexts.length - 1];
  if (!ctx) throw new Error('expected the WebAudio graph to exist');
  return ctx;
}

beforeEach(() => {
  contexts.length = 0;
});

// ------------------------------------------------------------------- tests
describe('EQ true bypass', () => {
  it('routes source → preamp → 10 bands → analyser → panner → destination when enabled', () => {
    const player = makePlayer();
    player.playIndex(0);
    const ctx = graphOf();
    const [preamp] = ctx.gains;
    const [analyser] = ctx.analysers;
    const [source] = ctx.sources;
    const [panner] = ctx.panners;
    expect(ctx.biquads).toHaveLength(EQ_FREQS.length);
    expect(source.outgoing).toEqual([preamp]);
    expect(preamp.outgoing).toEqual([ctx.biquads[0]]);
    for (let i = 0; i < ctx.biquads.length - 1; i++) {
      expect(ctx.biquads[i].outgoing).toEqual([ctx.biquads[i + 1]]);
    }
    expect(ctx.biquads[ctx.biquads.length - 1].outgoing).toEqual([analyser]);
    expect(analyser.outgoing).toEqual([panner]);
    expect(panner.outgoing).toEqual([ctx.destination]);
  });

  it('off→on round-trip keeps every band and the preamp at their set values', () => {
    const player = makePlayer();
    player.playIndex(0);
    const ctx = graphOf();
    const [preamp] = ctx.gains;
    const [analyser] = ctx.analysers;
    const [source] = ctx.sources;

    player.setEqBand(0, 6);
    player.setEqBand(4, -5);
    player.setEqBand(9, 12);
    player.setPreamp(-3);

    player.setEqEnabled(false);
    // True bypass: source goes straight to the analyser, chain tail detached.
    expect(player.eqOn).toBe(false);
    expect(source.outgoing).toEqual([analyser]);
    expect(ctx.biquads[ctx.biquads.length - 1].outgoing).toEqual([]);

    player.setEqEnabled(true);
    expect(player.eqOn).toBe(true);
    expect(source.outgoing).toEqual([preamp]);
    expect(ctx.biquads[ctx.biquads.length - 1].outgoing).toEqual([analyser]);
    // Values survived the round-trip exactly — no flattening, no drift.
    expect(ctx.biquads[0].gain.value).toBe(6);
    expect(ctx.biquads[4].gain.value).toBe(-5);
    expect(ctx.biquads[9].gain.value).toBe(12);
    expect(preamp.gain.value).toBeCloseTo(dbToGain(-3), 10);
  });

  it('edits made while bypassed touch memory only, then apply in one shot on re-enable', () => {
    const player = makePlayer();
    player.playIndex(0);
    const ctx = graphOf();
    const [preamp] = ctx.gains;
    const [analyser] = ctx.analysers;
    const [source] = ctx.sources;

    player.setEqEnabled(false);
    player.setEqBand(3, 9);
    player.setPreamp(5);

    // While bypassed the live nodes are untouched (chain is disconnected
    // anyway) and the signal still goes straight to the analyser.
    expect(ctx.biquads[3].gain.value).toBe(0);
    expect(preamp.gain.value).toBe(1);
    expect(source.outgoing).toEqual([analyser]);

    player.setEqEnabled(true);
    expect(ctx.biquads[3].gain.value).toBe(9);
    expect(preamp.gain.value).toBeCloseTo(dbToGain(5), 10);
    expect(source.outgoing).toEqual([preamp]);
  });

  it('clamps band and preamp values to ±12 dB', () => {
    const player = makePlayer();
    player.playIndex(0);
    const ctx = graphOf();
    player.setEqBand(2, 99);
    player.setPreamp(-99);
    expect(ctx.biquads[2].gain.value).toBe(12);
    expect(ctx.gains[0].gain.value).toBeCloseTo(dbToGain(-12), 10);
  });

  it('toggle before the graph exists: first play reflects the latest state', () => {
    const player = makePlayer();
    // Everything happens BEFORE the lazy graph is created.
    player.setEqEnabled(false);
    player.setEqBand(1, -6);
    player.setPreamp(4);

    player.playIndex(0); // graph is born here — already bypassed
    const ctx = graphOf();
    const [preamp] = ctx.gains;
    const [analyser] = ctx.analysers;
    const [source] = ctx.sources;
    expect(source.outgoing).toEqual([analyser]); // bypassed from the start
    expect(ctx.biquads[ctx.biquads.length - 1].outgoing).toEqual([]);

    player.setEqEnabled(true); // remembered values land on the fresh nodes
    expect(source.outgoing).toEqual([preamp]);
    expect(ctx.biquads[1].gain.value).toBe(-6);
    expect(preamp.gain.value).toBeCloseTo(dbToGain(4), 10);
  });

  it('off→on before the graph exists ends up enabled on first play', () => {
    const player = makePlayer();
    player.setEqEnabled(false);
    player.setEqEnabled(true);
    player.setEqBand(7, 8);
    player.playIndex(0);
    const ctx = graphOf();
    expect(ctx.sources[0].outgoing).toEqual([ctx.gains[0]]);
    expect(ctx.biquads[7].gain.value).toBe(8);
  });

  it('toggling with no graph and no track never throws', () => {
    const player = makePlayer();
    expect(() => {
      player.setEqEnabled(false);
      player.setEqBand(0, 3);
      player.setPreamp(-2);
      player.setEqEnabled(true);
    }).not.toThrow();
    expect(contexts).toHaveLength(0); // still no graph — nothing to rewire
  });
});
