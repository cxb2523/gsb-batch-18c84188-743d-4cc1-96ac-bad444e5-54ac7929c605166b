"use strict";

const fs = require( "node:fs" );
const path = require( "node:path" );
const vm = require( "node:vm" );

const ROOT = path.resolve( __dirname, "..", ".." );
const ORIGIN = "https://daw.test";

// ---------------------------------------------------------------------------
// Service worker harness
// ---------------------------------------------------------------------------

class FakeCache {
	constructor( store, failing ) {
		this.store = store;
		this.failing = failing;
	}

	#key( url ) {
		return new URL( url, ORIGIN ).href;
	}

	async add( url ) {
		if ( this.failing.has( new URL( url, ORIGIN ).pathname ) ) {
			throw new TypeError( `Failed to fetch ${ url }` );
		}
		this.store.set( this.#key( url ), new Response( `body of ${ url }`, { status: 200 } ) );
	}

	async addAll( urls ) {
		// Mirror the real Cache#addAll atomicity: nothing is stored on failure.
		const failing = urls.filter( u => this.failing.has( new URL( u, ORIGIN ).pathname ) );

		if ( failing.length ) {
			throw new TypeError( `Failed to fetch ${ failing[ 0 ] }` );
		}
		for ( const u of urls ) {
			this.store.set( this.#key( u ), new Response( `body of ${ u }`, { status: 200 } ) );
		}
	}

	async match( req ) {
		const url = typeof req === "string" ? req : req.url;

		return this.store.get( this.#key( url ) ) || undefined;
	}
}

function createServiceWorkerEnv( {
	network = async () => new Response( "network", { status: 200 } ),
	failing = new Set(),
	cacheStore = new Map(),
} = {} ) {
	const caches = new Map();
	const listeners = new Map();

	const cachesApi = {
		async open( name ) {
			if ( !caches.has( name ) ) {
				caches.set( name, new FakeCache( cacheStore, failing ) );
			}
			return caches.get( name );
		},
		async keys() {
			return [ ...caches.keys() ];
		},
		async delete( name ) {
			return caches.delete( name );
		},
		async match( req ) {
			for ( const cache of caches.values() ) {
				const res = await cache.match( req );

				if ( res ) {
					return res;
				}
			}
			// Allow tests to pre-populate the cache without running install.
			const url = typeof req === "string" ? req : req.url;

			return cacheStore.get( new URL( url, ORIGIN ).href ) || undefined;
		},
	};
	const self = {
		addEventListener( type, fn ) {
			const arr = listeners.get( type );

			arr ? arr.push( fn ) : listeners.set( type, [ fn ] );
		},
	};

	const ctx = vm.createContext( {
		self,
		caches: cachesApi,
		fetch: network,
		Response,
		URL,
		console: { warn() {}, log() {}, error() {} },
	} );

	vm.runInContext(
		fs.readFileSync( path.join( ROOT, "serviceWorker.js" ), "utf8" ),
		ctx,
		{ filename: "serviceWorker.js" }
	);

	function dispatch( type, event ) {
		const e = { ...event };
		let promises = [];

		e.waitUntil = p => promises.push( p );
		e.respondWith = p => { e._respondWith = p; };
		for ( const fn of listeners.get( type ) || [] ) {
			fn( e );
		}
		return { event: e, responsePromise: e._respondWith, promises };
	}

	return {
		caches: cachesApi,
		cacheStore,
		install() {
			return dispatch( "install", {} );
		},
		activate() {
			return dispatch( "activate", {} );
		},
		fetch( request ) {
			return dispatch( "fetch", { request } );
		},
	};
}

// ---------------------------------------------------------------------------
// run.js harness
// ---------------------------------------------------------------------------

function createWindow() {
	const listeners = new Map();

	return {
		addEventListener( type, fn ) {
			const arr = listeners.get( type );

			arr ? arr.push( fn ) : listeners.set( type, [ fn ] );
		},
		removeEventListener( type, fn ) {
			const arr = listeners.get( type ) || [];
			const i = arr.indexOf( fn );

			if ( i !== -1 ) {
				arr.splice( i, 1 );
			}
		},
		dispatchEvent( ev ) {
			for ( const fn of [ ...( listeners.get( ev.type ) || [] ) ] ) {
				fn( ev );
			}
		},
		listenerCount( type ) {
			return ( listeners.get( type ) || [] ).length;
		},
	};
}

const { createDocument, createJQueryShim, FakeElement } = require( "./dom" );

function createRunEnv( {
	failScripts = [],
	errorEventScripts = [],
	hangScripts = [],
	failResume = false,
	failInit = false,
	onFirefox = false,
} = {} ) {
	const { document, splash, firefoxAlert, errorAlert, button } = createDocument();
	const window = createWindow();
	const state = {
		resumeCalls: 0,
		loadedScripts: [],
		dawInstances: 0,
		initCalls: 0,
		dawRefs: [],
	};
	const opts = {
		failScripts: new Set( failScripts ),
		errorEventScripts: new Set( errorEventScripts ),
		hangScripts: new Set( hangScripts ),
		failInit,
		failResume,
	};

	// GSUsetTimeout is scaled down (and capped) so tests stay fast while keeping
	// the real setTimeout semantics used by the production helper.
	const GSUsetTimeout = ( fn, sec ) => {
		const ms = Math.min( Math.max( 0, sec * 1000 | 0 ), 30 );

		return ms > 0 ? setTimeout( fn, ms ) : ( fn(), null );
	};
	const GSUclearTimeout = id => clearTimeout( id );

	function GSUloadJSFile( src ) {
		state.loadedScripts.push( src );
		// Mirror $.$loadJS: a <script> tag is appended to <head> and settles on
		// its "load" event. Tests inspect/remove these tags through the DOM.
		const el = new FakeElement( "script" );

		el.src = new URL( src, document.location.href ).href;
		document.head.appendChild( el );
		if ( opts.hangScripts.has( src ) ) {
			return new Promise( () => {} );
		}
		if ( opts.errorEventScripts.has( src ) ) {
			// Simulate a <script> tag failing to fetch: no promise settlement,
			// the browser fires an "error" event on the element instead.
			setTimeout( () => {
				window.dispatchEvent( { type: "error", target: el, message: "Script error." } );
			}, 0 );
			return new Promise( () => {} );
		}
		if ( opts.failScripts.has( src ) ) {
			return Promise.reject( new Error( `Network error loading ${ src }` ) );
		}
		return Promise.resolve();
	}

	class GSDAW {
		constructor() {
			state.dawInstances++;
			state.dawRefs.push( this );
		}

		$init() {
			state.initCalls++;
			if ( opts.failInit ) {
				throw new Error( "init exploded" );
			}
		}

		getDAWCore() { return {}; }
	}

	const gswaContext = {
		$resume() {
			state.resumeCalls++;
			return opts.failResume
				? Promise.reject( new Error( "audio context refused" ) )
				: Promise.resolve();
		},
	};

	const sandbox = {
		document,
		window,
		location: { href: `${ ORIGIN }/` },
		$: createJQueryShim( document ),
		GSUonFirefox: onFirefox,
		GSUsetTimeout,
		GSUclearTimeout,
		GSUloadJSFile,
		gswaContext,
		GSDAW,
		URL,
		console: { warn() {}, log() {}, error() {} },
	};

	document.location = sandbox.location;
	vm.runInContext(
		fs.readFileSync( path.join( ROOT, "src", "run.js" ), "utf8" ),
		vm.createContext( sandbox ),
		{ filename: "src/run.js" }
	);

	return {
		document,
		window,
		splash,
		firefoxAlert,
		errorAlert,
		button,
		state,
		click: () => button.click(),
		setFailScripts: list => {
			opts.failScripts = new Set( list );
		},
		setHangScripts: list => {
			opts.hangScripts = new Set( list );
		},
		settle: ( ms = 80 ) => new Promise( r => setTimeout( r, ms ) ),
	};
}

module.exports = {
	ORIGIN,
	ROOT,
	FakeCache,
	createServiceWorkerEnv,
	createRunEnv,
};
