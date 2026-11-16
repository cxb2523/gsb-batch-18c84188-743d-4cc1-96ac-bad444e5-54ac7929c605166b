import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Прогоняет сгенерированный исходник процессора так, как это сделал бы AudioWorklet
const { modules, blobs } = vi.hoisted(() => ({
  modules: [] as string[],
  blobs: new Map<string, Blob>(),
}));

vi.mock('../ctx', () => ({
  ctx: {
    sampleRate: 1000,
    audioWorklet: {
      addModule: async (url: string) => {
        modules.push(await blobs.get(url)!.text());
      }
    }
  },
}));

vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
  const url = `blob:test/${blobs.size}`;
  blobs.set(url, blob as Blob);
  return url;
});
vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => { });
vi.stubGlobal('AudioWorkletNode', class { });

type Processor = {
  context: any;
  props: any;
  port: { onmessage: (e: { data: any; }) => void; };
  process(inputs: any[], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
};

const load = async (module: () => Promise<unknown>) => {
  modules.length = 0;
  await module();

  var Processor: (new () => Processor) & { parameterDescriptors: { name: string, defaultValue: number; }[]; } = null!;

  new Function('registerProcessor', 'AudioWorkletProcessor', modules[0])(
    (_name: string, cls: typeof Processor) => Processor = cls,
    class { port = { onmessage: null }; }
  );

  return () => {
    const processor = new Processor();

    // Обрабатывает блок: значения параметров по сэмплам, неуказанные — по умолчанию
    const run = (frames: number, params: Record<string, number[] | number> = {}) => {
      const out = new Float32Array(frames);
      const parameters: Record<string, Float32Array> = {};

      // Как в браузере: каждый параметр есть, по умолчанию — defaultValue
      for (const { name, defaultValue } of Processor.parameterDescriptors)
        parameters[name] = new Float32Array([defaultValue]);

      for (const [key, value] of Object.entries(params))
        parameters[key] = typeof value === 'number' ? new Float32Array([value]) : new Float32Array(value);

      processor.process([], [[out]], parameters);
      return [...out];
    };

    return { processor, run };
  };
};

const lfo = await load(() => import('./LfoProcessor'));
const adsr = await load(() => import('./AdsrProcessor'));
const random = await load(() => import('./RandomProcessor'));
const counter = await load(() => import('./CounterProcessor'));

const round = (values: number[]) => values.map(v => +v.toFixed(5));

const pulses = (length: number, at: number[]) => Array.from({ length }, (_, i) => at.includes(i) ? 1 : 0);

describe('LFO worklet', () => {
  it('outputs offset + depth * shape', () => {
    const { run } = lfo();
    const out = run(4, { rate: 250, depth: 2, offset: 1 });

    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(3);
    expect(out[2]).toBeCloseTo(1);
    expect(out[3]).toBeCloseTo(-1);
  });

  it('applies shape prop and phase offset', () => {
    const { run, processor } = lfo();
    processor.props.shape = 'saw';
    const out = run(3, { rate: 250, phase: 0.5 });

    expect(out).toEqual([0, 0.5, -1]);
  });

  it('resets phase on the sync rising edge sample', () => {
    const { run, processor } = lfo();
    processor.props.shape = 'saw';
    const out = run(6, { rate: 100, sync: [0, 0, 0, 1, 1, 0] });

    expect(round(out)).toEqual([-1, -0.8, -0.6, -1, -0.8, -0.6]);
  });

  it('holds a random value per cycle', () => {
    const { run, processor } = lfo();
    processor.props.shape = 'random';
    const out = run(8, { rate: 250 });

    expect(new Set(out.slice(0, 4)).size).toBe(1);
    expect(new Set(out.slice(4, 8)).size).toBe(1);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('reproduces the same S&H stairs with a fixed seed across separate runs', () => {
    const params = { rate: 250, depth: 1, offset: 0, phase: 0, seed: 1234 };
    const first = lfo();
    first.processor.props.shape = 'random';
    const outA = [
      ...first.run(8, params),
      ...first.run(8, { ...params, sync: pulses(8, [2]) }),
    ];

    const second = lfo();
    second.processor.props.shape = 'random';
    const outB = [
      ...second.run(8, params),
      ...second.run(8, { ...params, sync: pulses(8, [2]) }),
    ];

    expect(outB).toEqual(outA);

    // Ступень держится до границы периода, где draw срабатывает на этом же сэмпле:
    // 0–3, 4–7, затем sync-фронт разбивает третий период на 8–9 и 10–13, хвост 14–15
    const stairStarts = [0, 4, 8, 10, 14];

    for (let k = 0; k < stairStarts.length - 1; k++) {
      const segment = outA.slice(stairStarts[k], stairStarts[k + 1]);
      expect(new Set(segment).size, `segment ${k}`).toBe(1);
    }

    // Sync-фронт на сэмпле 10 сразу берёт новую ступень
    expect(outA[10]).not.toEqual(outA[9]);
    expect(outA[10]).toEqual(outA[11]);

    // Не вырожденная последовательность: за прогон встречается несколько ступеней
    expect(new Set(outA).size).toBeGreaterThan(1);
  });

  it('keeps using Math.random when seed is 0', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    const { run, processor } = lfo();
    processor.props.shape = 'random';

    const out = run(8, { rate: 250, seed: 0 });

    expect(spy).toHaveBeenCalled();
    // Выходной буфер — Float32Array, значение округляется до float32
    expect(new Set(out)).toEqual(new Set([Math.fround(0.6 * 2 - 1)]));

    spy.mockRestore();
  });

  it('changes the stairs when the seed changes', () => {
    const shape = { shape: 'random' };
    const a = lfo();
    a.processor.props.shape = shape.shape;
    const outA = a.run(16, { rate: 250, seed: 111 });

    const b = lfo();
    b.processor.props.shape = shape.shape;
    const outB = b.run(16, { rate: 250, seed: 222 });

    expect(outB).not.toEqual(outA);
  });

  it('restarts the seeded sequence on [RESET]', () => {
    const { run, processor } = lfo();
    processor.props.shape = 'random';

    const head = run(8, { rate: 250, seed: 777 });
    run(8, { rate: 250, seed: 777 });
    processor.port.onmessage({ data: '[RESET]' });

    expect(processor.context.phase).toBe(0);
    const replayed = run(8, { rate: 250, seed: 777 });

    expect(replayed).toEqual(head);
  });

  it('restarts the seeded sequence when the seed changes mid-stream', () => {
    const { run, processor } = lfo();
    processor.props.shape = 'random';

    run(8, { rate: 250, seed: 1 });
    const switched = run(8, { rate: 250, seed: 2 });

    const fresh = lfo();
    fresh.processor.props.shape = 'random';
    const expected = fresh.run(8, { rate: 250, seed: 2 });

    expect(switched).toEqual(expected);
    expect(processor.context.curSeed).toBe(2);
  });

  it('resets context on [RESET]', () => {
    const { run, processor } = lfo();
    run(3, { rate: 100 });
    processor.port.onmessage({ data: '[RESET]' });
    expect(processor.context.phase).toBe(0);
  });
});

describe('ADSR worklet', () => {
  it('runs the envelope sample by sample', () => {
    const { run } = adsr();
    const params = { attack: 0.004, decay: 0.004, sustain: 0.5, release: 0.004, peak: 1 };
    const out = run(14, { ...params, gate: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0] });

    expect(round(out)).toEqual([0.25, 0.5, 0.75, 1, 0.875, 0.75, 0.625, 0.5, 0.5, 0.5, 0.375, 0.25, 0.125, 0]);
  });

  it('keeps state between blocks', () => {
    const { run } = adsr();
    const params = { attack: 0.004, decay: 0, sustain: 1, release: 0.004, peak: 1 };

    expect(round(run(2, { ...params, gate: 1 }))).toEqual([0.25, 0.5]);
    expect(round(run(2, { ...params, gate: 1 }))).toEqual([0.75, 1]);
  });
});

describe('Random worklet', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.6);
  });

  afterEach(() => {
    vi.mocked(Math.random).mockRestore();
  });

  it('outputs from until the first trigger, then a new value per edge', () => {
    const { run } = random();
    const out = run(5, { from: 2, to: 4, trigger: [0, 1, 1, 0, 0] });

    expect(round(out)).toEqual([2, 3.2, 3.2, 3.2, 3.2]);
  });

  it('quantizes with step', () => {
    const { run } = random();
    expect(run(1, { from: 0, to: 1, step: 0.25, trigger: 1 })).toEqual([0.5]);
  });
});

describe('Counter worklet', () => {
  it('counts rising edges only', () => {
    const { run } = counter();
    expect(run(6, { trigger: [1, 1, 0, 1, 0, 1] })).toEqual([1, 1, 1, 2, 2, 3]);
  });

  it('uses step, modulo and reset', () => {
    const { run } = counter();
    const out = run(8, {
      step: 2,
      modulo: 5,
      trigger: pulses(8, [0, 2, 4, 6]),
      reset: pulses(8, [5]),
    });

    expect(out).toEqual([2, 2, 4, 4, 1, 0, 2, 2]);
  });

  it('gives reset priority over trigger on the same sample', () => {
    const { run } = counter();
    expect(run(3, { trigger: [1, 0, 1], reset: [0, 0, 1] })).toEqual([1, 1, 0]);
  });
});
