"use strict";

const test = require( "node:test" );
const assert = require( "node:assert/strict" );

const { ORIGIN, createServiceWorkerEnv } = require( "./helpers/harness" );

const req = ( url, method = "GET" ) => ( { url: new URL( url, ORIGIN ).href, method } );

test( "install precaches the whole CACHE_URLS list", async () => {
	const env = createServiceWorkerEnv();
	const { promises } = env.install();

	await Promise.all( promises );
	assert.ok( env.cacheStore.size > 0 );
	for ( const url of [ "/", "/index.html", "/manifest.json" ] ) {
		assert.ok( env.cacheStore.has( new URL( url, ORIGIN ).href ), `${ url } should be cached` );
	}
} );

test( "install still caches the remaining entries when one asset is missing", async () => {
	const env = createServiceWorkerEnv( { failing: new Set( [ "/assets/ico.svg" ] ) } );
	const { promises } = env.install();

	await assert.doesNotReject( Promise.all( promises ) );
	assert.ok( !env.cacheStore.has( new URL( "/assets/ico.svg", ORIGIN ).href ) );
	assert.ok( env.cacheStore.has( new URL( "/manifest.json", ORIGIN ).href ) );
	assert.ok( env.cacheStore.has( new URL( "/assets/gsuiWaveletList-v1.js", ORIGIN ).href ) );
} );

test( "activate removes caches left by previous versions", async () => {
	const env = createServiceWorkerEnv();

	await env.caches.open( "daw" );
	await env.caches.open( "daw-v2" );
	await env.caches.open( "unrelated" );
	const { promises } = env.activate();

	await Promise.all( promises );
	const names = ( await env.caches.keys() ).sort();

	assert.deepEqual( names, [ "daw-v2", "unrelated" ] );
} );

test( "fetch serves from the cache when the network request fails", async () => {
	const cacheStore = new Map( [
		[ new URL( "/assets/gsuiLibrarySamples-v1.js", ORIGIN ).href, new Response( "cached", { status: 200 } ) ],
	] );
	const env = createServiceWorkerEnv( {
		cacheStore,
		network: () => Promise.reject( new TypeError( "Failed to fetch" ) ),
	} );

	// The cached entries are pre-populated directly: running install would
	// overwrite them with the harness's synthetic cache bodies.
	const { responsePromise } = env.fetch( req( "/assets/gsuiLibrarySamples-v1.js" ) );
	const res = await responsePromise;

	assert.equal( res.status, 200 );
	assert.equal( await res.text(), "cached" );
} );

test( "fetch resolves with an explicit failure response when offline and uncached", async () => {
	const env = createServiceWorkerEnv( {
		network: () => Promise.reject( new TypeError( "Failed to fetch" ) ),
	} );

	const { responsePromise } = env.fetch( req( "/assets/gsuiLibrarySamples-v1.js" ) );

	// Must not be a rejected promise: respondWith() would turn it into an
	// opaque network error and the app could not display any message.
	await assert.doesNotReject( responsePromise );
	const res = await responsePromise;

	assert.equal( res.status, 503 );
	assert.equal( res.statusText, "Service Unavailable" );
	assert.match( res.headers.get( "content-type" ) || "", /text\/plain/u );
	assert.match( await res.text(), /unavailable offline/iu );
} );

test( "fetch resolves with an explicit failure response when even the cache read fails", async () => {
	const env = createServiceWorkerEnv( {
		network: () => Promise.reject( new TypeError( "Failed to fetch" ) ),
	} );

	// No install ran, so the cache is empty and caches.match returns undefined.
	const { responsePromise } = env.fetch( req( "/assets/gsuiWaveletList-v1.js" ) );
	const res = await responsePromise;

	assert.equal( res.status, 503 );
} );

test( "fetch passes non-GET requests through untouched", async () => {
	const env = createServiceWorkerEnv();
	const { responsePromise } = env.fetch( req( "/api/save", "POST" ) );

	assert.equal( responsePromise, undefined, "POST requests must not be intercepted" );
} );

test( "fetch does not intercept non-http schemes", async () => {
	const env = createServiceWorkerEnv();
	const { responsePromise } = env.fetch( { url: "chrome-extension://abc/x.js", method: "GET" } );

	assert.equal( responsePromise, undefined );
} );

test( "fetch falls back to the cache for a non-ok network response", async () => {
	const cacheStore = new Map( [
		[ new URL( "/assets/ico.svg", ORIGIN ).href, new Response( "cached icon", { status: 200 } ) ],
	] );
	const env = createServiceWorkerEnv( {
		cacheStore,
		network: () => Promise.resolve( new Response( "not found", { status: 404 } ) ),
	} );

	const { responsePromise } = env.fetch( req( "/assets/ico.svg" ) );
	const res = await responsePromise;

	assert.equal( res.status, 200 );
	assert.equal( await res.text(), "cached icon" );
} );
