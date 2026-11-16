// Minimal static file server for the browser smoke check of
// tests/offline-sample/index.html. Run from anywhere:
//   node tests/offline-sample/serve.js <repoRoot> [port]
"use strict";

const http = require( "node:http" );
const fs = require( "node:fs" );
const path = require( "node:path" );

const root = path.resolve( process.argv[ 2 ] || "." );
const port = Number( process.argv[ 3 ] || 8123 );
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

http.createServer( ( req, res ) => {
	const url = decodeURIComponent( ( req.url || "/" ).split( "?" )[ 0 ] );
	const file = path.join( root, url );

	// Keep the server inside the repo root.
	if ( !file.startsWith( root ) ) {
		res.writeHead( 403 ).end( "forbidden" );
		return;
	}
	fs.readFile( file, ( err, data ) => {
		if ( err ) {
			res.writeHead( 404, { "Content-Type": "text/plain" } ).end( "not found" );
			return;
		}
		res.writeHead( 200, {
			"Content-Type": TYPES[ path.extname( file ) ] || "application/octet-stream",
			"Cache-Control": "no-store",
		} );
		res.end( data );
	} );
} ).listen( port, "127.0.0.1", () => {
	console.log( `serving ${ root } on http://127.0.0.1:${ port }/` );
} );
