"use strict";

const test = require( "node:test" );
const assert = require( "node:assert/strict" );

const { createRunEnv } = require( "./helpers/harness" );

const SAMPLES = "assets/gsuiLibrarySamples-v1.js";
const WAVES = "assets/gsuiWaveletList-v1.js";

const errorAlertText = env => env.errorAlert.querySelectorText();

test( "happy path: resume, load both files, create the DAW once and init it", async () => {
	const env = createRunEnv();
	const { state, splash, button } = env;

	assert.ok( splash.hasAttribute( "data-loaded" ), "the screen should be marked loaded" );
	assert.ok( !button.hasAttribute( "disabled" ), "the start button should be enabled" );

	env.click();
	await env.settle();

	assert.equal( state.resumeCalls, 1 );
	assert.deepEqual( state.loadedScripts, [ SAMPLES, WAVES ] );
	assert.equal( state.dawInstances, 1 );
	assert.equal( state.initCalls, 1 );
	assert.ok( splash.hasAttribute( "data-started" ) );
	assert.ok( !splash.hasAttribute( "data-error" ) );
	assert.equal( errorAlertText( env ), "", "no error message should be shown" );
} );

test( "the Firefox notice is shown on Firefox and removed elsewhere", () => {
	const ff = createRunEnv( { onFirefox: true } );
	const other = createRunEnv( { onFirefox: false } );

	assert.equal( ff.firefoxAlert.style.display, "block" );
	assert.equal( other.firefoxAlert.removed, true );
	assert.equal( other.document.queryAll( "[data-alert=firefox]" ).length, 0 );
} );

test( "a rejected resource load puts the splash screen into the error state", async () => {
	const env = createRunEnv( { failScripts: [ WAVES ] } );

	env.click();
	await env.settle();

	assert.ok( env.splash.hasAttribute( "data-error" ), "data-error must be set" );
	assert.ok( !env.splash.hasAttribute( "data-starting" ) );
	assert.ok( !env.splash.hasAttribute( "data-started" ) );
	assert.match( env.errorAlert.querySelectorText(), /Startup failed/u );
	assert.equal( env.state.dawInstances, 0, "the DAW must not be created on failure" );
	assert.equal( env.button.hasAttribute( "disabled" ), false, "retry must be possible" );
} );

test( "a script that fires an error event (no promise rejection) also fails visibly", async () => {
	const env = createRunEnv( { errorEventScripts: [ SAMPLES ] } );

	env.click();
	await env.settle();

	assert.ok( env.splash.hasAttribute( "data-error" ) );
	assert.equal( env.state.dawInstances, 0 );
} );

test( "a hung script load times out into the error state instead of starting forever", async () => {
	const env = createRunEnv( { hangScripts: [ SAMPLES ] } );

	env.click();
	// The harness caps GSUsetTimeout, so the 20s load timeout fires quickly.
	await env.settle( 150 );

	assert.ok( env.splash.hasAttribute( "data-error" ) );
	assert.equal( env.state.dawInstances, 0 );
} );

test( "a throwing daw.$init puts the splash screen into the error state", async () => {
	const env = createRunEnv( { failInit: true } );

	env.click();
	await env.settle();

	assert.ok( env.splash.hasAttribute( "data-error" ) );
	assert.ok( !env.splash.hasAttribute( "data-started" ) );
	assert.match( env.errorAlert.querySelectorText(), /init exploded/u );
	assert.equal( env.state.dawInstances, 1 );
} );

test( "a rejected audio context resume is surfaced as a failure", async () => {
	const env = createRunEnv( { failResume: true } );

	env.click();
	await env.settle();

	assert.ok( env.splash.hasAttribute( "data-error" ) );
	assert.deepEqual( env.state.loadedScripts, [], "resources must not load after resume fails" );
} );

test( "retry after a failure reuses the DAW instance and the click handler", async () => {
	const env = createRunEnv( { failScripts: [ WAVES ] } );
	const { state, window } = env;

	env.click();
	await env.settle();
	assert.ok( env.splash.hasAttribute( "data-error" ) );
	assert.equal( window.listenerCount( "error" ), 0, "the error listener must be cleaned up" );

	// The retry goes through the same click listener (registered only once).
	assert.equal( env.button.listeners.get( "click" ).length, 1 );

	env.click();
	await env.settle();
	assert.equal( state.resumeCalls, 2 );
	assert.equal( state.dawInstances, 0, "the DAW is never created while resources keep failing" );
} );

test( "a failed script tag is removed so a retry cannot execute it twice", async () => {
	const env = createRunEnv( { hangScripts: [ SAMPLES ] } );

	env.click();
	await env.settle( 150 );
	assert.equal( env.document.querySelectorAll( "script" ).length, 0 );

	// The retry starts a fresh load rather than reusing a half-dead tag.
	env.setHangScripts( [] );
	env.click();
	await env.settle();

	assert.equal( env.state.dawInstances, 1 );
	assert.ok( env.splash.hasAttribute( "data-started" ) );
} );

test( "retry after a failing $init does not create a second DAW instance", async () => {
	const env = createRunEnv( { failInit: true } );

	env.click();
	await env.settle();
	assert.equal( env.state.dawInstances, 1 );

	env.click();
	await env.settle();
	assert.equal( env.state.dawInstances, 1, "retry must reuse the existing DAW instance" );
	assert.equal( env.state.initCalls, 2, "$init is retried on the existing instance" );
} );

test( "retry after a resource failure eventually starts without duplicating work", async () => {
	const env = createRunEnv( { failScripts: [ WAVES ] } );
	const { state } = env;

	env.click();
	await env.settle();
	assert.equal( state.loadedScripts.filter( s => s === SAMPLES ).length, 1 );

	// Turn the failure off for the retry by making the waves file loadable.
	env.setFailScripts( [] );
	env.click();
	await env.settle();

	assert.equal( state.loadedScripts.filter( s => s === SAMPLES ).length, 1, "samples are not reloaded" );
	assert.equal( state.dawInstances, 1 );
	assert.equal( state.initCalls, 1 );
	assert.ok( env.splash.hasAttribute( "data-started" ) );
	assert.ok( !env.splash.hasAttribute( "data-error" ) );
} );

test( "a double click while starting is ignored", async () => {
	const env = createRunEnv();

	env.click();
	env.click();
	await env.settle();

	assert.equal( env.state.resumeCalls, 1 );
	assert.equal( env.state.dawInstances, 1 );
} );
