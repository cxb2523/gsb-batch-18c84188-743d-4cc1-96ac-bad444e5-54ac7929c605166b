"use strict";

// Bump the version whenever the precache list or the app shell changes:
// otherwise an already-installed worker keeps serving the previous index.html
// from its old cache, which would lack the splash screen's error state markup.
const CACHE_NAME = "daw-v2";
const CACHE_URLS = [
	"/",
	"/index.html",
	"/manifest.json",
	"/assets/ico.svg",
	"/assets/logo/avatar-circle.svg",
	"/assets/logo/gs-gs-logo.svg",
	"/assets/logo/gs-gridsound-logo-animated.svg",
	"/assets/gsuiLibrarySamples-v1.js",
	"/assets/gsuiWaveletList-v1.js",
	// fonts.css requests the filtered brands face, not fa-brands-400.woff2.
	"/assets/fonts/fa-brands-400-filtered.woff2",
	"/assets/fonts/fa-custom.woff2",
	"/assets/fonts/fa-duotone-900.woff2",
	"/assets/fonts/unica-one-400-latin.woff2",
	"/assets/fonts/montserrat-500-latin.woff2",
	"/assets/fonts/montserrat-700-latin.woff2",
	"/assets/fonts/inconsolata-400-latin.woff2",
];

// A missing asset must not abort the whole installation (that would leave the
// app with no cache at all): try the atomic addAll first, and if one entry is
// unavailable, cache the remaining ones individually.
function cacheAll( cache, urls ) {
	return cache.addAll( urls ).catch( () => {
		const failures = [];

		return urls.reduce( ( prom, url ) => prom.then( () =>
			cache.add( url ).catch( err => {
				failures.push( url );
				console.warn( `Service worker: unable to precache "${ url }"`, err );
			} )
		), Promise.resolve() ).then( () => {
			if ( failures.length ) {
				console.warn( "Service worker: precache incomplete", failures );
			}
		} );
	} );
}

self.addEventListener( "install", e => {
	e.waitUntil(
		caches.open( CACHE_NAME )
			.then( cache => cacheAll( cache, CACHE_URLS ) )
			.catch( err => console.warn( "Service worker: precache failed", err ) )
	);
} );

// Drop the "daw" caches left by previous versions once this version activates.
self.addEventListener( "activate", e => {
	e.waitUntil(
		caches.keys().then( names => Promise.all(
			names
				.filter( name => name.startsWith( "daw" ) && name !== CACHE_NAME )
				.map( name => caches.delete( name ) )
		) )
	);
} );

// Never reject the promise given to respondWith(): the browser turns a
// rejected promise into a network error with no usable body, and the app
// cannot tell a slow/failed network from a 404. An explicit 503 response lets
// the startup chain detect the failure and show its error state.
function offlineResponse( request ) {
	return new Response(
		`Resource unavailable offline: ${ request?.url || "unknown" }`,
		{
			status: 503,
			statusText: "Service Unavailable",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			},
		}
	);
}

self.addEventListener( "fetch", e => {
	const req = e.request;

	// Let the browser handle non-GET requests and non-http(s) schemes.
	if ( req?.method !== "GET" || !/^https?:/iu.test( req.url ) ) {
		return;
	}
	e.respondWith(
		fetch( req )
			.then( res => res.ok || res.type === "opaque"
				? res
				: caches.match( req ).then( cached => cached || res )
			)
			.catch( () => caches.match( req )
				.then(
					cached => cached || offlineResponse( req ),
					() => offlineResponse( req )
				)
			)
	);
} );
