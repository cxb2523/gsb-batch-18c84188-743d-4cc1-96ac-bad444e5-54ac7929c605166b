import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Store } from "vuex";
import muteChannel from "@/model/actions/channel-mute";
import soloChannel from "@/model/actions/channel-solo";
import SongFactory from "@/model/factories/song-factory";
import type { Instrument } from "@/model/types/instrument";
import type { EffluxSong } from "@/model/types/song";
import { calculateOutputGain, hasSoloInstrument } from "@/services/audio/mixer-util";
import type { EffluxState } from "@/store";
import { createMockStore } from "../../mocks";

// mock the AudioService, but calculate the gains it would apply using the
// actual shared mute/solo rule so we can assert the resulting output gains
let appliedGains: number[] = [];
const mockApplyMuteSoloStates = vi.fn(( instruments: Instrument[] ) => {
    const songHasSolo = hasSoloInstrument( instruments );
    appliedGains = instruments.map( instrument => calculateOutputGain( instrument, songHasSolo ));
});
vi.mock( "@/services/audio-service", () => ({
    default: {
        applyMuteSoloStates: vi.fn(( ...args ) => mockApplyMuteSoloStates( ...args )),
    },
}));

describe( "Channel solo action", () => {
    const AMOUNT_OF_INSTRUMENTS = 4;

    let song: EffluxSong;
    let store: Store<EffluxState>;

    beforeEach(() => {
        song = SongFactory.create( AMOUNT_OF_INSTRUMENTS );
        song.instruments.forEach(( instrument, index ) => {
            instrument.volume = ( index + 1 ) * 0.2; // distinct volume per instrument
        });

        store = createMockStore();
        store.state.song.activeSong = song;
        store.getters.activeSong    = song;
        ( store.commit as Mock ).mockImplementation(( type: string, payload: any ) => {
            if ( type === "updateInstrument" ) {
                const { instrumentIndex, prop, value } = payload;
                ( song.instruments[ instrumentIndex ] as Record<string, unknown> )[ prop ] = value;
            }
        });

        appliedGains = song.instruments.map( instrument => instrument.volume );
        mockApplyMuteSoloStates.mockClear();
    });

    it( "should store the solo state in the song model and immediately recalculate all output gains", () => {
        soloChannel( store, 1, true );

        expect( song.instruments[ 1 ].solo ).toBe( true );
        expect( mockApplyMuteSoloStates ).toHaveBeenCalledWith( song.instruments );
        expect( appliedGains ).toEqual([ 0, 0.4, 0, 0 ]);
    });

    it( "should allow multiple instruments to activate solo, keeping all solod channels audible", () => {
        soloChannel( store, 1, true );
        soloChannel( store, 2, true );

        expect( song.instruments[ 1 ].solo ).toBe( true );
        expect( song.instruments[ 2 ].solo ).toBe( true );
        expect( appliedGains ).toEqual([ 0, 0.4, 0.6, 0 ]);
    });

    it( "should restore all instrument volumes when the last solo is deactivated", () => {
        soloChannel( store, 1, true );
        soloChannel( store, 2, true );

        soloChannel( store, 1, false );
        expect( appliedGains ).toEqual([ 0, 0, 0.6, 0 ]);

        soloChannel( store, 2, false );
        expect( appliedGains ).toEqual([ 0.2, 0.4, 0.6, 0.8 ]);
    });

    it( "should unmute the instrument when activating solo on a muted instrument", () => {
        muteChannel( store, 1, true );
        expect( song.instruments[ 1 ].muted ).toBe( true );

        soloChannel( store, 1, true );

        expect( song.instruments[ 1 ].muted ).toBe( false );
        expect( song.instruments[ 1 ].solo ).toBe( true );
        expect( appliedGains ).toEqual([ 0, 0.4, 0, 0 ]);
    });

    it( "should keep muted channels silenced while solo is active on another instrument", () => {
        muteChannel( store, 0, true );
        soloChannel( store, 1, true );

        expect( appliedGains ).toEqual([ 0, 0.4, 0, 0 ]);

        // unmuting the channel should not make it audible as the solo is still active
        muteChannel( store, 0, false );

        expect( appliedGains ).toEqual([ 0, 0.4, 0, 0 ]);

        // deactivating the solo restores all non-muted channels to their own volume
        soloChannel( store, 1, false );

        expect( appliedGains ).toEqual([ 0.2, 0.4, 0.6, 0.8 ]);
    });

    it( "should restore the original state and output gains on undo and reapply them on redo", () => {
        const { undo, redo } = soloChannel( store, 1, true );

        expect( appliedGains ).toEqual([ 0, 0.4, 0, 0 ]);

        undo();

        expect( song.instruments[ 1 ].solo ).toBe( false );
        expect( appliedGains ).toEqual([ 0.2, 0.4, 0.6, 0.8 ]);

        redo();

        expect( song.instruments[ 1 ].solo ).toBe( true );
        expect( appliedGains ).toEqual([ 0, 0.4, 0, 0 ]);
    });

    it( "should restore the muted state on undo when activating solo had unmuted the instrument", () => {
        muteChannel( store, 1, true );

        const { undo } = soloChannel( store, 1, true );

        expect( song.instruments[ 1 ].muted ).toBe( false );

        undo();

        expect( song.instruments[ 1 ].solo ).toBe( false );
        expect( song.instruments[ 1 ].muted ).toBe( true );
        expect( appliedGains ).toEqual([ 0.2, 0, 0.6, 0.8 ]);
    });
});
