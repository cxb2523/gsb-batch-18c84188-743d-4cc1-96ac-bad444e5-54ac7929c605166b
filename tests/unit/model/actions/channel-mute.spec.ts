import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Store } from "vuex";
import muteChannel from "@/model/actions/channel-mute";
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

const setSolo = ( instrument: Instrument, value: boolean ): void => {
    ( instrument as Record<string, unknown> ).solo = value;
};

describe( "Channel mute action", () => {
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

    it( "should store the muted state in the song model and immediately recalculate all output gains", () => {
        muteChannel( store, 1, true );

        expect( song.instruments[ 1 ].muted ).toBe( true );
        expect( mockApplyMuteSoloStates ).toHaveBeenCalledWith( song.instruments );
        expect( appliedGains ).toEqual([ 0.2, 0, 0.6, 0.8 ]);
    });

    it( "should restore the instruments own volume when unmuting while no instrument is solod", () => {
        muteChannel( store, 1, true );
        muteChannel( store, 1, false );

        expect( song.instruments[ 1 ].muted ).toBe( false );
        expect( appliedGains ).toEqual([ 0.2, 0.4, 0.6, 0.8 ]);
    });

    it( "should not affect the stored volume of the instruments when toggling mute", () => {
        const volumes = song.instruments.map( instrument => instrument.volume );

        muteChannel( store, 1, true );
        muteChannel( store, 1, false );

        expect( song.instruments.map( instrument => instrument.volume )).toEqual( volumes );
    });

    it( "should unsolo the instrument when activating mute on a solod instrument", () => {
        setSolo( song.instruments[ 1 ], true );

        muteChannel( store, 1, true );

        expect( song.instruments[ 1 ].muted ).toBe( true );
        expect( song.instruments[ 1 ].solo ).toBe( false );
        // no instrument is solod anymore so all non-muted channels are audible again
        expect( appliedGains ).toEqual([ 0.2, 0, 0.6, 0.8 ]);
    });

    it( "should keep non-solod channels silenced when muting while another instrument is solod", () => {
        setSolo( song.instruments[ 0 ], true );

        muteChannel( store, 2, true );

        expect( appliedGains ).toEqual([ 0.2, 0, 0, 0 ]);

        // unmuting again should not make the channel audible as the solo is still active
        muteChannel( store, 2, false );

        expect( appliedGains ).toEqual([ 0.2, 0, 0, 0 ]);
    });

    it( "should restore the original state and output gains on undo and reapply them on redo", () => {
        const { undo, redo } = muteChannel( store, 1, true );

        expect( appliedGains ).toEqual([ 0.2, 0, 0.6, 0.8 ]);

        undo();

        expect( song.instruments[ 1 ].muted ).toBe( false );
        expect( appliedGains ).toEqual([ 0.2, 0.4, 0.6, 0.8 ]);

        redo();

        expect( song.instruments[ 1 ].muted ).toBe( true );
        expect( appliedGains ).toEqual([ 0.2, 0, 0.6, 0.8 ]);
    });
});
