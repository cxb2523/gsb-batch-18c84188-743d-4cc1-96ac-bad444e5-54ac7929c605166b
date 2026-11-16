// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { encodeWav, validateWavParams, MAX_CHANNELS } from '../wav-encoder'

/** 30 minutes of float32 at 48 kHz per channel — far beyond any plausible take. */
const MAX_PCM_BYTES = 48_000 * 4 * 60 * 30 * MAX_CHANNELS

/**
 * Register audio export IPC handlers.
 * Encodes float32 PCM data to WAV and saves to disk.
 *
 * Everything crossing this boundary is renderer-supplied and therefore
 * attacker-supplied: this app evaluates shared patterns through Function() by
 * design. Validate before allocating, not after — encodeWav does
 * `Buffer.alloc(44 + n * 2)` in the MAIN process, so an oversized buffer stalls
 * the whole app, and a NaN or negative sampleRate throws ERR_OUT_OF_RANGE
 * inside writeUInt32LE.
 *
 * The channel contract matches the renderer (src/lib/audio/wav-export.ts):
 * 1..MAX_CHANNELS interleaved channels are accepted as-is — no silent
 * downmix to stereo — and anything outside that range is an explicit error.
 */
export function registerAudioHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(
    'audio:export-wav',
    async (
      _event,
      buffer: ArrayBuffer,
      sampleRate: number,
      channels: number
    ) => {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        return { error: 'Invalid audio buffer' }
      }
      if (buffer.byteLength > MAX_PCM_BYTES) {
        return { error: 'Recording too large to export' }
      }
      const invalidParams = validateWavParams(sampleRate, channels)
      if (invalidParams) {
        return { error: invalidParams }
      }
      if (buffer.byteLength % (channels * 4) !== 0) {
        return { error: 'Audio data is not aligned to whole frames' }
      }

      /* The dialog is also the rate limit: it is modal on the parent window, so
         a loop calling exportWav() cannot queue an unbounded stack of sheets. */
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Audio',
        defaultPath: 'recording.wav',
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
      })

      if (result.canceled || !result.filePath) return null

      try {
        const wavBuffer = encodeWav(buffer, sampleRate, channels)
        await writeFile(result.filePath, wavBuffer)
        return { path: result.filePath }
      } catch {
        return { error: 'Failed to encode or write the WAV file' }
      }
    }
  )
}
