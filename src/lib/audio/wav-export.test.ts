// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

import { describe, expect, it } from 'vitest'
import {
  interleaveDecodedAudio,
  MAX_EXPORT_CHANNELS,
  type DecodedAudioLike,
} from './wav-export'

/** Build a fake decoded buffer from per-channel sample arrays. */
function fakeDecoded(channelData: number[][], sampleRate = 48_000): DecodedAudioLike {
  const channels = channelData.map((data) => new Float32Array(data))
  return {
    numberOfChannels: channelData.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (c: number) => channels[c],
  }
}

describe('interleaveDecodedAudio', () => {
  it('interleaves stereo frames in channel order', () => {
    const result = interleaveDecodedAudio(
      fakeDecoded([
        [0.1, 0.2],
        [0.9, 0.8],
      ])
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.channels).toBe(2)
    expect(result.sampleRate).toBe(48_000)
    expect(Array.from(result.interleaved)).toEqual([0.1, 0.9, 0.2, 0.8].map((v) => expect.closeTo(v, 5)))
  })

  it('keeps a three-channel take at three channels instead of truncating to stereo', () => {
    const result = interleaveDecodedAudio(
      fakeDecoded([
        [1, 4],
        [2, 5],
        [3, 6],
      ])
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.channels).toBe(3)
    expect(Array.from(result.interleaved)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('passes mono through untouched', () => {
    const result = interleaveDecodedAudio(fakeDecoded([[0.5, -0.5]]))
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.channels).toBe(1)
    expect(Array.from(result.interleaved)).toEqual([0.5, -0.5].map((v) => expect.closeTo(v, 5)))
  })

  it('returns a readable error for a take with no channels', () => {
    const result = interleaveDecodedAudio(fakeDecoded([]))
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/channel/i)
  })

  it('returns a readable error for a take wider than the export contract', () => {
    const tooWide = Array.from({ length: MAX_EXPORT_CHANNELS + 1 }, () => [0])
    const result = interleaveDecodedAudio(fakeDecoded(tooWide))
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/channel/i)
  })

  it('returns a readable error for an empty take', () => {
    const result = interleaveDecodedAudio(fakeDecoded([[]]))
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/empty/i)
  })
})
