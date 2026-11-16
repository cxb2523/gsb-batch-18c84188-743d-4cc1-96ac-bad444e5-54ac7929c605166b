// @vitest-environment node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

import { describe, expect, it } from 'vitest'
import {
  encodeWav,
  validateWavParams,
  MAX_CHANNELS,
  MIN_CHANNELS,
} from './wav-encoder'

/** Read every int16 sample out of an encoded WAV buffer. */
function readSamples(wav: Buffer): number[] {
  const out: number[] = []
  for (let offset = 44; offset < wav.length; offset += 2) {
    out.push(wav.readInt16LE(offset))
  }
  return out
}

function encode(samples: number[], sampleRate = 48_000, channels = 2): Buffer {
  return encodeWav(new Float32Array(samples).buffer, sampleRate, channels)
}

describe('encodeWav — header fields', () => {
  it('writes a valid stereo header with byte rate and block align matching the channel count', () => {
    const frames = 100
    const wav = encode(new Array(frames * 2).fill(0), 48_000, 2)

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8) // RIFF size
    expect(wav.readUInt16LE(22)).toBe(2) // channels
    expect(wav.readUInt32LE(24)).toBe(48_000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(48_000 * 2 * 2) // byte rate
    expect(wav.readUInt16LE(32)).toBe(2 * 2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(frames * 2 * 2) // data length
    expect(wav.length).toBe(44 + frames * 2 * 2)
  })

  it('writes a valid mono header — byte rate and block align halve with the channel count', () => {
    const frames = 64
    const wav = encode(new Array(frames).fill(0.5), 44_100, 1)

    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(28)).toBe(44_100 * 1 * 2)
    expect(wav.readUInt16LE(32)).toBe(1 * 2)
    expect(wav.readUInt32LE(40)).toBe(frames * 2)
    expect(wav.length).toBe(44 + frames * 2)
    // Mono samples still land where expected.
    expect(wav.readInt16LE(44)).toBe(Math.round(0.5 * 32767))
  })

  it('encodes a three-channel take with header fields scaled to three channels', () => {
    const frames = 10
    const samples: number[] = []
    for (let i = 0; i < frames; i++) samples.push(0.1, 0.2, 0.3)
    const wav = encode(samples, 48_000, 3)

    expect(wav.readUInt16LE(22)).toBe(3)
    expect(wav.readUInt32LE(28)).toBe(48_000 * 3 * 2)
    expect(wav.readUInt16LE(32)).toBe(3 * 2)
    expect(wav.readUInt32LE(40)).toBe(frames * 3 * 2)
    expect(wav.length).toBe(44 + frames * 3 * 2)
    // Interleaved order is preserved: frame 0 = ch0, ch1, ch2.
    expect(readSamples(wav).slice(0, 3)).toEqual([
      Math.round(0.1 * 32767),
      Math.round(0.2 * 32767),
      Math.round(0.3 * 32767),
    ])
  })

  it('encodes silence as a valid WAV full of zero samples', () => {
    const wav = encode(new Array(200).fill(0), 48_000, 2)
    expect(wav.length).toBe(44 + 400)
    expect(readSamples(wav).every((s) => s === 0)).toBe(true)
  })
})

describe('encodeWav — over-range peaks', () => {
  it('normalises the whole take by one gain instead of clipping per sample', () => {
    // Peak of 2.0 → gain 0.5: 2.0 → 1.0, 1.0 → 0.5, -2.0 → -1.0.
    const wav = encode([1.0, 2.0, -2.0, 0.25], 48_000, 1)
    const samples = readSamples(wav)

    expect(samples[0]).toBe(Math.round(0.5 * 32767))
    expect(samples[1]).toBe(32767)
    expect(samples[2]).toBe(-32768)
    expect(samples[3]).toBe(Math.round(0.125 * 32767))
  })

  it('keeps every sample in bounds for a hot multi-channel take', () => {
    const samples: number[] = []
    for (let i = 0; i < 500; i++) samples.push(3.7, -3.7)
    const wav = encode(samples, 48_000, 2)
    for (const s of readSamples(wav)) {
      expect(s).toBeGreaterThanOrEqual(-32768)
      expect(s).toBeLessThanOrEqual(32767)
    }
    // The loudest point lands exactly at full scale.
    const magnitudes = readSamples(wav).map(Math.abs)
    expect(Math.max(...magnitudes)).toBe(32768)
  })

  it('leaves in-range takes unscaled', () => {
    const wav = encode([0.5, -0.5], 48_000, 1)
    expect(readSamples(wav)).toEqual([
      Math.round(0.5 * 32767),
      Math.round(-0.5 * 32768),
    ])
  })

  it('writes non-finite samples as silence instead of throwing', () => {
    const wav = encode([Number.NaN, Number.POSITIVE_INFINITY, 0.5], 48_000, 1)
    const samples = readSamples(wav)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBe(0)
    expect(samples[2]).toBe(Math.round(0.5 * 32767))
  })
})

describe('encodeWav — invalid input', () => {
  it('throws on zero channels', () => {
    expect(() => encode([0.5], 48_000, 0)).toThrow(RangeError)
  })

  it('throws on a channel count above the shared maximum', () => {
    expect(() => encode([0.5], 48_000, MAX_CHANNELS + 1)).toThrow(RangeError)
  })

  it('throws when the buffer is not aligned to whole frames', () => {
    // 3 float32 samples cannot make whole stereo frames.
    expect(() => encode([0.1, 0.2, 0.3], 48_000, 2)).toThrow(RangeError)
  })
})

describe('validateWavParams — the renderer/main contract', () => {
  it('accepts mono, stereo, and wider takes up to the shared maximum', () => {
    expect(validateWavParams(48_000, MIN_CHANNELS)).toBeNull()
    expect(validateWavParams(48_000, 2)).toBeNull()
    expect(validateWavParams(48_000, 3)).toBeNull()
    expect(validateWavParams(48_000, MAX_CHANNELS)).toBeNull()
  })

  it('rejects zero channels with an explicit message', () => {
    expect(validateWavParams(48_000, 0)).toMatch(/channel/i)
  })

  it('rejects non-integer and out-of-range channel counts', () => {
    expect(validateWavParams(48_000, 1.5)).toMatch(/channel/i)
    expect(validateWavParams(48_000, MAX_CHANNELS + 1)).toMatch(/channel/i)
  })

  it('rejects non-finite and out-of-range sample rates', () => {
    expect(validateWavParams(Number.NaN, 2)).toMatch(/sample rate/i)
    expect(validateWavParams(1, 2)).toMatch(/sample rate/i)
    expect(validateWavParams(1_000_000, 2)).toMatch(/sample rate/i)
  })
})
