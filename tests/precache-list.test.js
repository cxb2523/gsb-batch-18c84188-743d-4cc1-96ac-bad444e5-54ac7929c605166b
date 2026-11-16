"use strict";

const test = require( "node:test" );
const assert = require( "node:assert/strict" );
const fs = require( "node:fs" );
const path = require( "node:path" );

const { ROOT } = require( "./helpers/harness" );

const read = rel => fs.readFileSync( path.join( ROOT, rel ), "utf8" );

// Pull the CACHE_URLS literal out of serviceWorker.js without executing it.
function readPrecacheList() {
	const src = read( "serviceWorker.js" );
	const m = src.match( /const CACHE_URLS = \[([\s\S]*?)\];/u );

	assert.ok( m, "serviceWorker.js must declare a CACHE_URLS array" );
	return [ ...m[ 1 ].matchAll( /"([^"]+)"/gu ) ].map( x => x[ 1 ] );
}

// Pull the resources loaded during the startup chain out of src/run.js.
// run.js funnels every startup resource through loadResource( "..." ), which
// itself calls GSUloadJSFile, so both forms are accepted.
function readStartupResources() {
	const src = read( "src/run.js" );
	const found = [
		...src.matchAll( /(?:loadResource|GSUloadJSFile)\(\s*"(assets\/[^"]+)"/gu ),
	].map( m => m[ 1 ] );

	return [ ...new Set( found ) ];
}

// Resources referenced by src/splashScreen.css, resolved relative to src/.
function readSplashResources() {
	return [ ...read( "src/splashScreen.css" ).matchAll( /url\(\s*"([^"]+)"/gu ) ]
		.map( m => m[ 1 ] )
		.filter( u => !/^(?:data|https?):/iu.test( u ) )
		.map( u => new URL( u, "https://daw.test/src/" ).pathname );
}

function readManifestIcons() {
	const manifest = JSON.parse( read( "manifest.json" ) );

	return manifest.icons.map( i => new URL( i.src, "https://daw.test/" ).pathname );
}

test( "precache list covers every resource requested by the startup chain", () => {
	const cache = readPrecacheList();
	const startup = readStartupResources();

	assert.ok( startup.length >= 2, "the startup chain should still load two resource files" );
	for ( const src of startup ) {
		assert.ok(
			cache.includes( `/${ src }` ),
			`"${ src }" is loaded at startup but missing from CACHE_URLS`
		);
	}
} );

test( "the startup chain loads the wavelet list that is actually precached", () => {
	// Guards against the historical typo `gsuiWaveletList` vs `gswaPeriodicWavesList`.
	const startup = readStartupResources();
	const cache = readPrecacheList();

	assert.ok(
		startup.includes( "assets/gsuiWaveletList-v1.js" ),
		"run.js should load assets/gsuiWaveletList-v1.js"
	);
	assert.ok(
		!cache.some( u => /PeriodicWaves/iu.test( u ) && !startup.some( s => u.endsWith( s ) ) ),
		"CACHE_URLS contains a wave list that the startup chain never requests"
	);
	assert.ok(
		cache.some( u => u.startsWith( "/assets/" ) && u.endsWith( ".js" ) ),
		"CACHE_URLS should precache the startup .js resources"
	);
} );

test( "precache list entries are unique and absolute", () => {
	const cache = readPrecacheList();

	assert.equal( new Set( cache ).size, cache.length, "CACHE_URLS contains a duplicate entry" );
	for ( const url of cache ) {
		assert.match( url, /^\/(?!\/)/u, `"${ url }" should be an absolute same-origin path` );
	}
	for ( const required of [ "/", "/index.html", "/manifest.json" ] ) {
		assert.ok( cache.includes( required ), `CACHE_URLS is missing "${ required }"` );
	}
} );

test( "precache list covers the splash screen and manifest resources", () => {
	const cache = readPrecacheList();
	const referenced = [ ...readSplashResources(), ...readManifestIcons() ];

	assert.ok( referenced.length > 0 );
	for ( const url of referenced ) {
		assert.ok( cache.includes( url ), `"${ url }" is referenced but not precached` );
	}
} );

test( "precache list covers the fonts imported by the splash screen stylesheet", () => {
	// build-conf.json lists assets/fonts/fonts.css alongside splashScreen.css.
	const fontsCssPath = path.join( ROOT, "assets", "fonts", "fonts.css" );

	if ( !fs.existsSync( fontsCssPath ) ) {
		// assets/ is a git submodule and is not checked out in this workspace.
		return;
	}
	const cache = readPrecacheList();
	const urls = [ ...fs.readFileSync( fontsCssPath, "utf8" ).matchAll( /url\(\s*"([^"]+)"/gu ) ]
		.map( m => m[ 1 ] )
		.filter( u => /^fa-(?:brands-400-filtered|duotone-900|custom)\.woff2/u.test( u ) )
		.map( u => `/assets/fonts/${ u }` );

	for ( const url of urls ) {
		assert.ok( cache.includes( url ), `"${ url }" is used by the splash screen but not precached` );
	}
} );

test( "splash screen markup exposes the failure state hooks used by run.js", () => {
	const html = read( "src/splashScreen.html" );

	assert.match( html, /data-alert="error"/u, "splash screen needs an error alert block" );
	assert.match( html, /data-error-message/u, "splash screen needs a container for the error message" );
	assert.match( html, /data-alert="firefox"/u, "the Firefox notice must be preserved" );
	assert.match( html, /<button[^>]*disabled/u, "the start button must start disabled" );
} );
