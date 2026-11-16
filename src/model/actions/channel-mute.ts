/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2020-2023 - https://www.igorski.nl
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
import type { Store } from "vuex";
import type { IUndoRedoState } from "@/model/factories/history-state-factory";
import AudioService from "@/services/audio-service";
import type { EffluxState } from "@/store";

export default function( store: Store<EffluxState>, instrumentIndex: number, mute: boolean ): IUndoRedoState {
    const instrument = store.getters.activeSong.instruments[ instrumentIndex ];

    const wasMuted = !!instrument.muted;
    const wasSolod = instrument.solo;

    // recalculate the output gain of all instruments so the new mute/solo
    // state is immediately reflected in the audible (and recorded) output
    const updateOutputGains = (): void => {
        AudioService.applyMuteSoloStates( store.getters.activeSong.instruments );
    };

    // update function

    const commit = () => {
        store.commit( "updateInstrument", { instrumentIndex, prop: "muted", value: mute });
        if ( mute && wasSolod ) {
            // activating mute always unsolos instrument
            store.commit( "updateInstrument", { instrumentIndex, prop: "solo", value: false });
        }
        updateOutputGains();
    };
    commit();

    return {
        undo(): void {
            store.commit( "updateInstrument", { instrumentIndex, prop: "muted", value: wasMuted });
            updateOutputGains();
        },
        redo: commit
    };
}
