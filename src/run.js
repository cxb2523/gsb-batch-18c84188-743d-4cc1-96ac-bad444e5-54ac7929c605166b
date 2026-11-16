"use strict";

document.addEventListener( "gsui", ( { detail: d } ) => console.warn( `uncatched event: "${ d.$event }"`, d.$args, d.$target ) );

( () => {
	const elSplash = $( "#splashScreen" );
	const elFirefox = elSplash.$query( "[data-alert=firefox]" );
	const elError = elSplash.$query( "[data-alert=error]" );
	const elErrorMsg = elError.$query( "[data-error-message]" );
	const elButton = elSplash.$query( "button" );
	const LOAD_TIMEOUT = 20;

	// All the mutable startup state lives here so that a retry never creates
	// a second DAW instance nor registers the click handler twice.
	let daw = null;
	let starting = false;
	let samplesLoaded = false;
	let wavesLoaded = false;

	GSUonFirefox
		? elFirefox.$css( "display", "block" )
		: elFirefox.$remove();

	// GSUloadJSFile appends a <script> tag and only settles on its "load" event.
	// On failure the tag is left behind, and a retry would append a second one:
	// if the first eventually loads, the file would be executed twice. Removing
	// it keeps a retry clean for resources that already failed.
	function removeScript( url ) {
		for ( const el of document.querySelectorAll( "script" ) ) {
			if ( el.src === url ) {
				el.remove();
			}
		}
	}

	// GSUloadJSFile resolves on the script "load" event but has no rejection
	// path: a network error leaves its promise pending forever. This wrapper
	// rejects on the script error event (captured from window), on a rejected
	// GSUloadJSFile promise, on a synchronous throw, and as a last resort on a
	// timeout, so the splash screen can leave its "starting..." state.
	function loadResource( src ) {
		return new Promise( ( resolve, reject ) => {
			const url = new URL( src, location.href ).href;
			let settled = false;
			let timerId = null;

			const settle = ( fn, val ) => {
				if ( !settled ) {
					settled = true;
					GSUclearTimeout( timerId );
					window.removeEventListener( "error", onError, true );
					fn( val );
				}
			};
			const fail = err => {
				settle( reject, err );
				removeScript( url );
			};
			const onError = e => {
				const el = e?.target;

				if ( el?.tagName === "SCRIPT" && el.src === url ) {
					fail( new Error( `Unable to load "${ src }"` ) );
				}
			};

			window.addEventListener( "error", onError, true );
			timerId = GSUsetTimeout(
				() => fail( new Error( `Timeout while loading "${ src }"` ) ),
				LOAD_TIMEOUT
			);
			Promise.resolve()
				.then( () => GSUloadJSFile( src ) )
				.then(
					() => settle( resolve ),
					err => fail( err && err.message ? err : new Error( `Unable to load "${ src }"` ) )
				);
		} );
	}

	function loadSamples() {
		return samplesLoaded
			? Promise.resolve()
			: loadResource( "assets/gsuiLibrarySamples-v1.js" ).then( () => samplesLoaded = true );
	}

	function loadWaves() {
		return wavesLoaded
			? Promise.resolve()
			: loadResource( "assets/gsuiWaveletList-v1.js" ).then( () => wavesLoaded = true );
	}

	function onFail( err ) {
		const msg = err?.message || String( err || "unknown error" );

		starting = false;
		console.error( "DAW startup failed:", err );
		elSplash
			.$rmAttr( "data-starting" )
			.$addAttr( "data-error" );
		elErrorMsg.$text( `Startup failed: ${ msg }` );
		elButton.$disabled( false );
	}

	function onStart() {
		if ( starting ) {
			return;
		}
		starting = true;
		elSplash
			.$rmAttr( "data-error" )
			.$addAttr( "data-starting" );
		elErrorMsg.$text( "" );
		elButton.$disabled( true );
		GSUsetTimeout( () => {
			Promise.resolve()
				.then( () => gswaContext.$resume() )
				.then( loadSamples )
				.then( loadWaves )
				.then( () => {
					if ( !daw ) {
						daw = new GSDAW();
					}
					daw.$init();
					elSplash.$addAttr( "data-started" );
					GSUsetTimeout( () => elSplash.$remove(), .8 );
					// window.$daw = daw.getDAWCore();
				} )
				.catch( onFail );
		}, .1 );
	}

	elSplash.$addAttr( "data-loaded" );
	elButton.$onclick( onStart ).$disabled( false );
} )();
