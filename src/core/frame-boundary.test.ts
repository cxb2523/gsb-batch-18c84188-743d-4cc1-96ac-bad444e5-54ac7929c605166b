// Boundary-behaviour pins for framing, overlap-add, and ISTFT normalisation.
//
// Short pulses and truncated recordings live or die by what happens at the
// first and last frame: invalid geometry must be rejected before any caller
// array is touched, and valid round trips must reconstruct the observable
// interval within a tight tolerance for every frame/hop/window combination.

import { describe, it, expect } from 'vitest';
import { frameSignal, overlapAdd, stft, istft } from './frame.js';
import {
  applyWindow,
  bartlett,
  hann,
  hamming,
  makeWindow,
  rectangular,
  triangular,
} from './window.js';
import type { ComplexArray } from './fft.js';

const signal = (length: number) =>
  Float32Array.from({ length }, (_, i) => 0.3 * Math.sin(i * 0.71) + 0.2 * Math.cos(i * 0.23));

function maxError(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  let error = 0;
  for (let i = 0; i < expected.length; i++)
    error = Math.max(error, Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)));
  return error;
}

function snapshotSpectra(spectra: ArrayLike<ComplexArray>): { re: number[]; im: number[] }[] {
  return Array.from({ length: spectra.length }, (_, i) => ({
    re: Array.from(spectra[i]!.re),
    im: Array.from(spectra[i]!.im),
  }));
}

function expectSpectraEqual(
  spectra: ArrayLike<ComplexArray>,
  snapshot: { re: number[]; im: number[] }[],
): void {
  expect(spectra.length).toBe(snapshot.length);
  for (let i = 0; i < snapshot.length; i++) {
    expect(Array.from(spectra[i]!.re)).toEqual(snapshot[i]!.re);
    expect(Array.from(spectra[i]!.im)).toEqual(snapshot[i]!.im);
  }
}

describe('invalid geometry is rejected before any array is modified', () => {
  const input = signal(64);
  const spectra = stft(input, 16, 8, 'hann');

  it('istft rejects non-power-of-two frame sizes and leaves spectra untouched', () => {
    for (const frameSize of [0, 3, 6, 12, -4, 1.5, 2 ** 21]) {
      const before = snapshotSpectra(spectra);
      expect(() => istft(spectra, frameSize, 8, 'hann')).toThrow();
      expectSpectraEqual(spectra, before);
    }
  });

  it('istft rejects zero, negative, and non-integer hop sizes before touching spectra', () => {
    for (const hopSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const before = snapshotSpectra(spectra);
      expect(() => istft(spectra, 16, hopSize, 'hann')).toThrow();
      expectSpectraEqual(spectra, before);
    }
  });

  it('istft rejects mismatched spectrum shapes without modifying earlier spectra', () => {
    const mixed = [...spectra, { re: new Float32Array(32), im: new Float32Array(32) }];
    const before = snapshotSpectra(mixed);
    expect(() => istft(mixed, 16, 8, 'hann')).toThrow();
    expectSpectraEqual(mixed, before);
  });

  it('stft rejects invalid geometry and leaves the input samples unchanged', () => {
    for (const args of [
      [3, 1],
      [6, 2],
      [16, 0],
      [16, -2],
      [16, 1.5],
    ] as const) {
      const before = Array.from(input);
      expect(() => stft(input, args[0], args[1])).toThrow();
      expect(Array.from(input)).toEqual(before);
    }
  });

  it('frameSignal rejects invalid geometry before reading samples into frames', () => {
    const before = Array.from(input);
    expect(() => frameSignal(input, 0, { hopSize: 1 })).toThrow();
    expect(() => frameSignal(input, 1.5, { hopSize: 1 })).toThrow();
    expect(() => frameSignal(input, 16, { hopSize: 0 })).toThrow();
    expect(() => frameSignal(input, 16, { hopSize: -1 })).toThrow();
    expect(() => frameSignal(input, 16, { hopSize: 2.5 })).toThrow();
    expect(Array.from(input)).toEqual(before);
  });

  it('overlapAdd rejects invalid geometry without modifying the frame arrays', () => {
    const frames = frameSignal(input, 16, { hopSize: 8 });
    const before = frames.map((f) => Array.from(f));
    expect(() => overlapAdd(frames, 16, 0)).toThrow();
    expect(() => overlapAdd(frames, 16, -3)).toThrow();
    expect(() => overlapAdd(frames, 16, 1.5)).toThrow();
    expect(() => overlapAdd(frames, 0, 8)).toThrow();
    expect(frames.map((f) => Array.from(f))).toEqual(before);
  });
});

describe('frame counts and output lengths are deterministic across geometry', () => {
  it('frameSignal yields exactly one full frame per hop that fits', () => {
    expect(frameSignal(signal(1024), 256, { hopSize: 128 }).length).toBe(7);
    expect(frameSignal(signal(1000), 256, { hopSize: 128 }).length).toBe(6);
    expect(frameSignal(signal(5), 4, { hopSize: 2 }).length).toBe(1);
    expect(frameSignal(signal(4), 4, { hopSize: 1 }).length).toBe(1);
  });

  it('frameSignal returns no frames when the signal is shorter than one frame', () => {
    expect(frameSignal(signal(3), 4, { hopSize: 1 })).toEqual([]);
    expect(frameSignal([], 4, { hopSize: 1 })).toEqual([]);
  });

  it('every frame has exactly frameSize samples and is an independent copy', () => {
    const input = signal(32);
    const frames = frameSignal(input, 8, { hopSize: 4, window: 'hann' });
    for (const frame of frames) expect(frame.length).toBe(8);
    const first = Array.from(frames[0]!);
    frames[0]![0] = 99;
    expect(input[0]).not.toBe(99);
    expect(Array.from(frameSignal(input, 8, { hopSize: 4, window: 'hann' })[0]!)).toEqual(first);
  });

  it('overlapAdd length defaults to the covered span and honours totalLength', () => {
    const frames = frameSignal(signal(32), 8, { hopSize: 4 });
    expect(overlapAdd(frames, 8, 4).length).toBe((frames.length - 1) * 4 + 8);
    expect(overlapAdd(frames, 8, 4, 100).length).toBe(100);
    expect(overlapAdd(frames, 8, 4, 5).length).toBe(5);
  });

  it('istft of no spectra is a zero signal of the requested length', () => {
    expect(istft([], 4, 2, 'hann', 5)).toEqual(new Float32Array(5));
    expect(istft([], 4, 2, 'hann')).toEqual(new Float32Array(0));
    expect(stft([], 4, 2)).toEqual([]);
  });

  it('gaps from hop sizes larger than the frame reconstruct as silence', () => {
    const input = signal(16);
    const out = istft(stft(input, 4, 8, 'rectangular'), 4, 8, 'rectangular', 16);
    expect(maxError(out.subarray(0, 4), input.subarray(0, 4))).toBeLessThan(1e-6);
    expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 0, 0]);
    expect(maxError(out.subarray(8, 12), input.subarray(8, 12))).toBeLessThan(1e-6);
    expect(Array.from(out.subarray(12, 16))).toEqual([0, 0, 0, 0]);
  });
});

describe('round-trip reconstruction stays within tolerance', () => {
  it('rectangular windows reconstruct every sample across hop combinations', () => {
    for (const size of [4, 8, 16])
      for (const hop of [1, size / 4, size / 2, size]) {
        const input = signal(size + 5 * hop);
        const out = istft(stft(input, size, hop, 'rectangular'), size, hop, 'rectangular');
        expect(out.length).toBe((stft(input, size, hop).length - 1) * hop + size);
        const trimmed = istft(
          stft(input, size, hop, 'rectangular'),
          size,
          hop,
          'rectangular',
          input.length,
        );
        expect(maxError(trimmed, input)).toBeLessThan(1e-5);
      }
  });

  it('unwindowed (null) round trips match rectangular behaviour', () => {
    const input = signal(40);
    const out = istft(stft(input, 8, 4, null), 8, 4, null, input.length);
    expect(maxError(out, input)).toBeLessThan(1e-5);
  });

  it('hann windows reconstruct the observable interior and zero the edges', () => {
    for (const size of [8, 16, 32])
      for (const hop of [size / 4, size / 2]) {
        const input = signal(size + 4 * hop);
        const out = istft(stft(input, size, hop, 'hann'), size, hop, 'hann', input.length);
        expect(maxError(out.subarray(1, -1), input.subarray(1, -1))).toBeLessThan(1e-4);
        expect(out[0]).toBe(0);
        expect(out[out.length - 1]).toBe(0);
      }
  });

  it('hamming and triangular windows reconstruct edge samples their endpoints keep alive', () => {
    for (const window of ['hamming', 'triangular'] as const) {
      const input = signal(32);
      const out = istft(stft(input, 8, 4, window), 8, 4, window, input.length);
      expect(maxError(out, input)).toBeLessThan(1e-4);
    }
  });

  it('bartlett zeroes exactly the endpoint samples its window kills', () => {
    const input = signal(32);
    const out = istft(stft(input, 8, 4, 'bartlett'), 8, 4, 'bartlett', input.length);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
    expect(maxError(out.subarray(1, -1), input.subarray(1, -1))).toBeLessThan(1e-4);
  });

  it('a short pulse in silence keeps its shape and energy in the observable region', () => {
    const input = new Float32Array(64);
    input[30] = 0.9;
    input[31] = -0.7;
    input[32] = 0.5;
    const out = istft(stft(input, 16, 4, 'hann'), 16, 4, 'hann', input.length);
    expect(maxError(out.subarray(8, 56), input.subarray(8, 56))).toBeLessThan(1e-5);
    let energyIn = 0;
    let energyOut = 0;
    for (let i = 8; i < 56; i++) {
      energyIn += input[i]! ** 2;
      energyOut += out[i]! ** 2;
    }
    expect(energyOut).toBeCloseTo(energyIn, 5);
  });

  it('round trips do not mutate the spectra produced by stft', () => {
    const input = signal(48);
    const spectra = stft(input, 16, 8, 'hann');
    const before = snapshotSpectra(spectra);
    istft(spectra, 16, 8, 'hann', input.length);
    expectSpectraEqual(spectra, before);
    expect(
      maxError(istft(spectra, 16, 8, 'hann', 48).subarray(1, -1), input.subarray(1, -1)),
    ).toBeLessThan(1e-4);
  });
});

describe('window length and endpoint contracts', () => {
  it('window length must match the frame length exactly', () => {
    const samples = new Float32Array([1, 2, 3, 4]);
    expect(() => applyWindow(samples, hann(3))).toThrow();
    expect(() => applyWindow(samples, hann(5))).toThrow();
    expect(Array.from(samples)).toEqual([1, 2, 3, 4]);
    for (const type of [
      'hann',
      'hamming',
      'blackman',
      'rectangular',
      'triangular',
      'bartlett',
    ] as const)
      expect(makeWindow(type, 16).length).toBe(16);
  });

  it('every window is exactly [1] at length 1', () => {
    expect(Array.from(hann(1))).toEqual([1]);
    expect(Array.from(hamming(1))).toEqual([1]);
    expect(Array.from(rectangular(1))).toEqual([1]);
    expect(Array.from(triangular(1))).toEqual([1]);
    expect(Array.from(bartlett(1))).toEqual([1]);
  });

  it('pins even and odd endpoint coefficients', () => {
    expect(Array.from(triangular(4))).toEqual([0.25, 0.75, 0.75, 0.25]);
    expect(Array.from(bartlett(3))).toEqual([0, 1, 0]);
    expect(Array.from(rectangular(4))).toEqual([1, 1, 1, 1]);
    const h = hann(8);
    expect(h[0]).toBeCloseTo(0, 6);
    expect(h[7]).toBeCloseTo(0, 6);
    // Even lengths have no exact centre sample; the peak straddles it.
    expect(h[3]).toBeCloseTo(h[4]!, 10);
    expect(h[4]!).toBeGreaterThan(0.94);
  });

  it('hann squared weights cover the interior but vanish at the edge samples', () => {
    const size = 16;
    const hop = size / 2;
    const length = 4 * size;
    const w = hann(size);
    const weights = new Float64Array(length);
    for (let f = 0; f * hop + size <= length; f++)
      for (let i = 0; i < size; i++) weights[f * hop + i]! += w[i]! ** 2;
    expect(weights[0]).toBe(0);
    expect(weights[length - 1]).toBe(0);
    for (let i = 1; i < length - 1; i++) expect(weights[i]!).toBeGreaterThan(0);
    // Fully overlapped interior keeps a comfortable normalisation margin:
    // the ideal 50%-overlap Hann squared-weight floor is 3/8.
    for (let i = size; i < length - size; i++) expect(weights[i]!).toBeGreaterThan(0.25);
  });

  it('rectangular squared weights cover every sample including both edges', () => {
    const size = 16;
    const hop = size / 2;
    const length = 4 * size;
    const w = rectangular(size);
    const weights = new Float64Array(length);
    for (let f = 0; f * hop + size <= length; f++)
      for (let i = 0; i < size; i++) weights[f * hop + i]! += w[i]! ** 2;
    for (let i = 0; i < length; i++) expect(weights[i]!).toBeGreaterThan(0);
    expect(weights[0]).toBe(1);
    expect(weights[size]).toBe(2);
  });
});
