/* SPDX-License-Identifier: MIT
   Copyright (c) 2026 Arnold Wender / Wender Media
   ──────────────────────────────────────────────────────────
   wav-export — turns a decoded AudioBuffer into the interleaved
   float32 PCM shape the main-process WAV encoder expects.
   Pure and DOM-free so the channel contract is unit-testable.
   ────────────────────────────────────────────────────────── */

/**
 * Channel-count contract shared with the main process. Mirrors
 * MAX_CHANNELS in electron/wav-encoder.ts — the renderer cannot import
 * from electron/ without pulling Node APIs into the web bundle, so keep
 * the two in sync manually.
 */
export const MAX_EXPORT_CHANNELS = 8

/** The subset of AudioBuffer the exporter needs — structural, so tests can fake it. */
export interface DecodedAudioLike {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  getChannelData(channel: number): Float32Array
}

export type InterleavedPcm =
  | { interleaved: Float32Array; channels: number; sampleRate: number }
  | { error: string }

/**
 * Interleave a decoded recording into planar-agnostic float32 PCM, keeping
 * the decoded channel count as-is — no silent downmix to stereo, which used
 * to drop every channel above the second.
 *
 * Returns a readable { error } instead of half-prepared data when the take
 * cannot be exported: no channels, more channels than the main process
 * accepts, or zero frames.
 */
export function interleaveDecodedAudio(decoded: DecodedAudioLike): InterleavedPcm {
  const channels = decoded.numberOfChannels
  if (!Number.isInteger(channels) || channels < 1) {
    return { error: 'Recording has no audio channels to export' }
  }
  if (channels > MAX_EXPORT_CHANNELS) {
    return {
      error: `Recording has ${channels} channels — WAV export supports at most ${MAX_EXPORT_CHANNELS}`,
    }
  }
  const frames = decoded.length
  if (!Number.isInteger(frames) || frames < 1) {
    return { error: 'Recording is empty — nothing to export' }
  }

  const interleaved = new Float32Array(frames * channels)
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c)
    for (let i = 0; i < frames; i++) interleaved[i * channels + c] = data[i]
  }

  return { interleaved, channels, sampleRate: decoded.sampleRate }
}
