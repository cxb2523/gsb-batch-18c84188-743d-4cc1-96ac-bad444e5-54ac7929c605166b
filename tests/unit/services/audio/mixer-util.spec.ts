import { describe, it, expect } from "vitest";
import InstrumentFactory from "@/model/factories/instrument-factory";
import type { Instrument } from "@/model/types/instrument";
import { calculateOutputGain, hasSoloInstrument } from "@/services/audio/mixer-util";

const createInstruments = ( amount: number ): Instrument[] =>
    new Array( amount ).fill( null ).map(( _, index ) => ({
        ...InstrumentFactory.create( index ),
        volume: ( index + 1 ) * 0.2, // give each instrument a distinct volume
    }));

// the Instrument type declares muted/solo as literal "false", cast to allow flagging in tests
const setFlags = ( instrument: Instrument, muted: boolean, solo: boolean ): void => {
    ( instrument as Record<string, unknown> ).muted = muted;
    ( instrument as Record<string, unknown> ).solo  = solo;
};

describe( "mixer-util", () => {
    describe( "hasSoloInstrument", () => {
        it( "should return false when no instrument has solo enabled", () => {
            const instruments = createInstruments( 4 );

            expect( hasSoloInstrument( instruments )).toBe( false );
        });

        it( "should return true when one or more instruments have solo enabled", () => {
            const instruments = createInstruments( 4 );
            setFlags( instruments[ 2 ], false, true );

            expect( hasSoloInstrument( instruments )).toBe( true );
        });
    });

    describe( "calculateOutputGain", () => {
        it( "should return the instrument volume when the instrument is neither muted nor affected by solo", () => {
            const instrument = createInstruments( 1 )[ 0 ];

            expect( calculateOutputGain( instrument, false )).toBe( instrument.volume );
        });

        it( "should return 0 for a muted instrument, regardless of solo state", () => {
            const instrument = createInstruments( 1 )[ 0 ];
            setFlags( instrument, true, false );

            expect( calculateOutputGain( instrument, false )).toBe( 0 );
            expect( calculateOutputGain( instrument, true )).toBe( 0 );
        });

        it( "should return 0 for a non-solod instrument when the song has a solo instrument", () => {
            const instrument = createInstruments( 1 )[ 0 ];

            expect( calculateOutputGain( instrument, true )).toBe( 0 );
        });

        it( "should return the instrument volume for a solod instrument when the song has a solo instrument", () => {
            const instrument = createInstruments( 1 )[ 0 ];
            setFlags( instrument, false, true );

            expect( calculateOutputGain( instrument, true )).toBe( instrument.volume );
        });

        it( "should return 0 for an instrument that is both muted and solod (mute takes precedence)", () => {
            const instrument = createInstruments( 1 )[ 0 ];
            setFlags( instrument, true, true );

            expect( calculateOutputGain( instrument, true )).toBe( 0 );
        });
    });
});
