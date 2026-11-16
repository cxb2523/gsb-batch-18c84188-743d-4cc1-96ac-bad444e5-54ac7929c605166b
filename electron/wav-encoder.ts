// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

/**
 * Channel-count contract shared with the renderer (src/lib/audio/wav-export.ts
 * mirrors MAX_CHANNELS — the renderer cannot import from electron/ without
 * pulling Node APIs into the web bundle, so keep the two in sync manually).
 */
export const MIN_CHANNELS = 1
export const MAX_CHANNELS = 8

export const MIN_SAMPLE_RATE = 8_000
export const MAX_SAMPLE_RATE = 384_000

/**
 * Validate the numeric parameters of a WAV export. Returns an error message
 * when invalid, null when acceptable. Used by the IPC handler so a bad
 * channel count is an explicit error, never a silent downgrade.
 */
export function validateWavParams(
  sampleRate: number,
  channels: number
): string | null {
  if (
    !Number.isFinite(sampleRate) ||
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    return `Invalid sample rate: expected an integer between ${MIN_SAMPLE_RATE} and ${MAX_SAMPLE_RATE}`
  }
  if (
    !Number.isInteger(channels) ||
    channels < MIN_CHANNELS ||
    channels > MAX_CHANNELS
  ) {
    return `Invalid channel count: expected an integer between ${MIN_CHANNELS} and ${MAX_CHANNELS}`
  }
  return null
}

/**
 * Encode interleaved float32 PCM samples into a standard 16-bit PCM WAV file.
 * Returns a Node.js Buffer containing the complete WAV file.
 *
 * Over-range material is normalised, not hard-clipped: the whole take is
 * scanned for its peak first, and when the peak exceeds full scale every
 * sample is scaled by the SAME gain so the loudest point lands exactly at
 * full scale. Per-sample clipping would flatten every peak into distortion;
 * one global gain preserves the take's dynamics. Samples at or below full
 * scale are written unscaled. Non-finite samples (NaN/Infinity) become
 * silence rather than throwing inside writeInt16LE.
 *
 * Throws on an invalid channel count or a sample buffer that is not aligned
 * to whole frames — callers crossing the IPC boundary are expected to have
 * validated already, so a throw here means a programming error, not user input.
 */
export function encodeWav(
  samples: ArrayBuffer,
  sampleRate: number,
  channels: number
): Buffer {
  const invalid = validateWavParams(sampleRate, channels)
  if (invalid) throw new RangeError(invalid)
  if (samples.byteLength % (channels * 4) !== 0) {
    throw new RangeError(
      'Sample buffer is not aligned to whole frames (byteLength must be a multiple of channels * 4)'
    )
  }

  const float32 = new Float32Array(samples)
  const numSamples = float32.length
  const bytesPerSample = 2 // 16-bit PCM
  const dataLength = numSamples * bytesPerSample
  const headerLength = 44
  const totalLength = headerLength + dataLength

  const buffer = Buffer.alloc(totalLength)

  // --- RIFF header (12 bytes) ---
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(totalLength - 8, 4) // File size minus RIFF header
  buffer.write('WAVE', 8, 'ascii')

  // --- fmt sub-chunk (24 bytes) ---
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // Sub-chunk size (PCM = 16)
  buffer.writeUInt16LE(1, 20) // Audio format (1 = PCM)
  buffer.writeUInt16LE(channels, 22) // Number of channels
  buffer.writeUInt32LE(sampleRate, 24) // Sample rate
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28) // Byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, 32) // Block align
  buffer.writeUInt16LE(16, 34) // Bits per sample

  // --- data sub-chunk header (8 bytes) ---
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataLength, 40)

  /* Peak detection pass: find the loudest |sample| so over-range takes can be
     normalised with one global gain instead of clipped per sample. Non-finite
     values are excluded here and written as silence below. */
  let peak = 0
  for (let i = 0; i < numSamples; i++) {
    const magnitude = Math.abs(float32[i])
    if (Number.isFinite(magnitude) && magnitude > peak) peak = magnitude
  }
  const gain = peak > 1 ? 1 / peak : 1

  // --- Convert float32 to int16 [-32768, 32767] ---
  let offset = headerLength
  for (let i = 0; i < numSamples; i++) {
    const sample = float32[i]
    const scaled = Number.isFinite(sample) ? sample * gain : 0
    /* Final clamp is a safety net for floating-point overshoot (a peak of
       exactly 1 scaled by gain 1 needs no clamp; peak * (1/peak) can land a
       hair above 1), not the primary over-range strategy. */
    const clamped = Math.max(-1, Math.min(1, scaled))
    const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767
    buffer.writeInt16LE(Math.round(int16), offset)
    offset += bytesPerSample
  }

  return buffer
}
