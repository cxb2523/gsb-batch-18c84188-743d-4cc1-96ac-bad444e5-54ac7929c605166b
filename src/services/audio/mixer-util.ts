/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2023 - https://www.igorski.nl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the 'Software'), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import type { Instrument } from "@/model/types/instrument";

/**
 * whether one or more instruments in given list have solo mode activated
 */
export const hasSoloInstrument = ( instruments: Instrument[] ): boolean =>
    instruments.some( instrument => !!instrument.solo );

/**
 * Calculate the output gain for given instrument by combining its individual
 * volume with the mute/solo state across all instruments in the song:
 *
 * - a muted instrument is never audible
 * - when one or more instruments have solo activated, only those are audible
 * - otherwise each instrument is audible at its own volume
 *
 * This single rule is used both when applying a songs module configuration
 * and when toggling mute/solo at runtime, so both paths always agree.
 */
export const calculateOutputGain = ( instrument: Instrument, songHasSolo: boolean ): number =>
    ( instrument.muted || ( songHasSolo && !instrument.solo )) ? 0 : instrument.volume;
