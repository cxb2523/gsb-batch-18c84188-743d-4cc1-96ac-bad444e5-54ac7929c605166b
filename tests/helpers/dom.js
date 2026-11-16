"use strict";

// A very small fake DOM implementing only what src/run.js and
// src/splashScreen.html need. Keeping it dependency-free makes the tests
// runnable offline with Node's built-in test runner (no npm install).

function matchesSelector( el, sel ) {
	const attrMatch = sel.match( /^(?:([a-zA-Z0-9_-]+))?\[([a-zA-Z0-9_-]+)(?:=("?)([^\]]*)\3)?\]$/u );

	if ( attrMatch ) {
		const [ , tag, name, , value ] = attrMatch;

		if ( tag && el.tagName !== tag.toUpperCase() ) {
			return false;
		}
		if ( value === undefined ) {
			return el.hasAttribute( name );
		}
		return el.getAttribute( name ) === value;
	}
	return el.tagName === sel.toUpperCase();
}

class FakeElement {
	constructor( tag ) {
		this.tagName = tag.toUpperCase();
		this.attributes = new Map();
		this.children = [];
		this.parentNode = null;
		this.listeners = new Map();
		this.textContent = "";
		this.style = {};
		this.removed = false;
	}

	appendChild( el ) {
		el.parentNode = this;
		this.children.push( el );
		return el;
	}

	remove() {
		this.removed = true;
		if ( this.parentNode ) {
			const i = this.parentNode.children.indexOf( this );

			if ( i !== -1 ) {
				this.parentNode.children.splice( i, 1 );
			}
			this.parentNode = null;
		}
	}

	setAttribute( k, v ) { this.attributes.set( k, String( v ) ); }
	getAttribute( k ) { return this.attributes.has( k ) ? this.attributes.get( k ) : null; }
	hasAttribute( k ) { return this.attributes.has( k ); }
	removeAttribute( k ) { this.attributes.delete( k ); }

	addEventListener( type, fn ) {
		const arr = this.listeners.get( type );

		arr ? arr.push( fn ) : this.listeners.set( type, [ fn ] );
	}

	removeEventListener( type, fn ) {
		const arr = this.listeners.get( type ) || [];
		const i = arr.indexOf( fn );

		if ( i !== -1 ) {
			arr.splice( i, 1 );
		}
	}

	dispatchEvent( ev ) {
		const e = { target: this, currentTarget: this, type: ev?.type, ...ev };

		if ( !e.preventDefault ) {
			e.preventDefault = () => {};
		}
		for ( const fn of [ ...( this.listeners.get( e.type ) || [] ) ] ) {
			fn( e );
		}
		return true;
	}

	click() { this.dispatchEvent( { type: "click" } ); }

	querySelectorText() {
		let s = this.textContent || "";

		for ( const child of this.children ) {
			s += child.querySelectorText();
		}
		return s;
	}

	queryAll( sel ) {
		const res = [];

		for ( const child of this.children ) {
			if ( matchesSelector( child, sel ) ) {
				res.push( child );
			}
			res.push( ...child.queryAll( sel ) );
		}
		return res;
	}
}

class FakeQuery {
	constructor( elems ) {
		this.$_elems = elems || [];
	}

	get length() { return this.$_elems.length; }
	get element() { return this.$_elems[ 0 ] || null; }

	$query( sel ) {
		return new FakeQuery( this.$_elems.flatMap( el => el.queryAll( sel ) ) );
	}

	$addAttr( ...k ) {
		for ( const el of this.$_elems ) {
			for ( const a of k ) {
				el.setAttribute( a, "" );
			}
		}
		return this;
	}

	$rmAttr( ...k ) {
		for ( const el of this.$_elems ) {
			for ( const a of k ) {
				el.removeAttribute( a );
			}
		}
		return this;
	}

	$css( prop, val ) {
		for ( const el of this.$_elems ) {
			el.style[ prop ] = val;
		}
		return this;
	}

	$remove() {
		for ( const el of this.$_elems ) {
			el.remove();
		}
		return this;
	}

	$text( v ) {
		for ( const el of this.$_elems ) {
			el.textContent = v;
		}
		return this;
	}

	$disabled( b ) {
		for ( const el of this.$_elems ) {
			b === false || b === null || b === undefined
				? el.removeAttribute( "disabled" )
				: el.setAttribute( "disabled", "" );
		}
		return this;
	}

	$onclick( fn ) {
		for ( const el of this.$_elems ) {
			el.addEventListener( "click", fn );
		}
		return this;
	}
}

function buildTree( parent, descriptor ) {
	for ( const [ tag, children ] of descriptor ) {
		const el = parent.appendChild( new FakeElement( tag ) );

		if ( Array.isArray( children ) ) {
			buildTree( el, children );
		}
	}
}

function createDocument() {
	const document = {
		listeners: new Map(),
		addEventListener( type, fn ) {
			const arr = document.listeners.get( type );

			arr ? arr.push( fn ) : document.listeners.set( type, [ fn ] );
		},
		getElementById( id ) {
			return document._byId.get( id ) || null;
		},
		querySelectorAll( sel ) {
			return document.root.queryAll( sel );
		},
		queryAll( sel ) {
			return document.root.queryAll( sel );
		},
	};
	const root = new FakeElement( "body" );

	// Mirror src/splashScreen.html.
	buildTree( root, [
		[ "div#splashScreen", [
			[ "div", [
				[ "div", [] ],
				[ "b", [] ],
				[ "span", [] ],
				[ "button", [] ],
				[ "a", [] ],
			] ],
		] ],
	] );

	const splash = root.children[ 0 ];
	const [ logo, version, firefoxAlert, button, link ] = splash.children[ 0 ].children;

	splash.setAttribute( "id", "splashScreen" );
	firefoxAlert.setAttribute( "data-alert", "firefox" );
	button.setAttribute( "disabled", "" );

	const errorAlert = splash.children[ 0 ].appendChild( new FakeElement( "span" ) );

	errorAlert.setAttribute( "data-alert", "error" );
	errorAlert.appendChild( new FakeElement( "span" ) ).setAttribute( "data-error-message", "" );
	errorAlert.appendChild( new FakeElement( "span" ) );

	document.root = root;
	document.body = root;
	document.head = new FakeElement( "head" );
	document._byId = new Map( [ [ "splashScreen", splash ] ] );

	return { document, splash, firefoxAlert, errorAlert, button, logo, version, link };
}

function createJQueryShim( document ) {
	const $ = sel => {
		if ( typeof sel !== "string" ) {
			return new FakeQuery( [] );
		}
		if ( sel.startsWith( "#" ) ) {
			const el = document.getElementById( sel.slice( 1 ) );

			return new FakeQuery( el ? [ el ] : [] );
		}
		return new FakeQuery( document.queryAll( sel ) );
	};

	return $;
}

module.exports = {
	FakeElement,
	FakeQuery,
	createDocument,
	createJQueryShim,
	matchesSelector,
};
