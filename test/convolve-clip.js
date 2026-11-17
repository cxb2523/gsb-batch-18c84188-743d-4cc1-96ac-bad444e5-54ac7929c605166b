// canvas-plus - Convolve Clip Verification Tests
// Verifies that convolve() samples neighborhoods from the full canvas,
// writes back only inside the clip rect, and validates clip in indexed mode.

var CanvasPlus = require('../main.js');

var failures = 0;
function assert(cond, msg) {
	if (cond) {
		console.log("PASS: " + msg);
	}
	else {
		failures++;
		console.error("FAIL: " + msg);
	}
}

// build a small canvas with a deterministic, non-symmetric pixel pattern
function makePattern(w, h) {
	var c = new CanvasPlus();
	c.create({ width: w, height: h });
	var img = c.context.getImageData(0, 0, w, h);
	for (var y = 0; y < h; y++) {
		for (var x = 0; x < w; x++) {
			var o = (y * w + x) * 4;
			img.data[o + 0] = (x * 37 + y * 11 + 5) % 256;
			img.data[o + 1] = (x * 13 + y * 53 + 90) % 256;
			img.data[o + 2] = (x * 71 + y * 29 + 160) % 256;
			// keep alpha fully opaque: canvas 2D stores pixels premultiplied,
			// so get/putImageData round-trips are only lossless at alpha 255
			img.data[o + 3] = 255;
		}
	}
	c.context.putImageData(img, 0, 0);
	return c;
}

function getData(c) {
	return c.context.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
}

// compare two RGBA buffers over a rect; returns first mismatch description or null
function compareRegion(d1, d2, imgW, rect, label) {
	for (var y = rect.y; y < rect.y + rect.height; y++) {
		for (var x = rect.x; x < rect.x + rect.width; x++) {
			var o = (y * imgW + x) * 4;
			for (var k = 0; k < 4; k++) {
				if (d1[o + k] !== d2[o + k]) {
					return label + " mismatch at (" + x + "," + y + ") ch" + k + ": " + d1[o + k] + " vs " + d2[o + k];
				}
			}
		}
	}
	return null;
}

function outsideRect(w, h, rect) {
	// returns array of 1-4 rects covering everything outside `rect`
	var rects = [];
	if (rect.y > 0) rects.push({ x: 0, y: 0, width: w, height: rect.y });
	if (rect.y + rect.height < h) rects.push({ x: 0, y: rect.y + rect.height, width: w, height: h - rect.y - rect.height });
	if (rect.x > 0) rects.push({ x: 0, y: rect.y, width: rect.x, height: rect.height });
	if (rect.x + rect.width < w) rects.push({ x: rect.x + rect.width, y: rect.y, width: w - rect.x - rect.width, height: rect.height });
	return rects;
}

var W = 8, H = 6;
var CLIP = { x: 2, y: 1, width: 4, height: 3 };
var kernels = {
	sharpen: [0, -1, 0, -1, 5, -1, 0, -1, 0],
	box3: [1/9, 1/9, 1/9, 1/9, 1/9, 1/9, 1/9, 1/9, 1/9],
	asym: [1, 0, -1, 2, 0, -2, 1, 0, -1]
};

// --- Test 1: full-image convolve vs clip convolve, all edge modes ---
['repeat', 'wrap', 'mirror'].forEach(function(edges) {
	Object.keys(kernels).forEach(function(kname) {
		var matrix = kernels[kname];

		var full = makePattern(W, H);
		full.convolve({ matrix: matrix, edges: edges });

		var clipped = makePattern(W, H);
		var origData = getData( makePattern(W, H) );
		clipped.convolve({ matrix: matrix, edges: edges, clip: CLIP });

		var fullData = getData(full);
		var clipData = getData(clipped);

		var err = compareRegion(fullData, clipData, W, CLIP, "inside");
		assert(!err, "edges=" + edges + " kernel=" + kname + ": clip interior matches full-image convolve" + (err ? " -- " + err : ""));

		var outsideOK = true;
		outsideRect(W, H, CLIP).forEach(function(r) {
			var oerr = compareRegion(origData, clipData, W, r, "outside");
			if (oerr) { outsideOK = false; console.error("   " + oerr); }
		});
		assert(outsideOK, "edges=" + edges + " kernel=" + kname + ": pixels outside clip are byte-identical to original");
	});
});

// --- Test 2: channels selection leaves unselected channels untouched inside clip ---
(function() {
	var matrix = kernels.sharpen;
	var full = makePattern(W, H);
	full.convolve({ matrix: matrix, channels: 'g' });

	var clipped = makePattern(W, H);
	var origData = getData( makePattern(W, H) );
	clipped.convolve({ matrix: matrix, channels: 'g', clip: CLIP });

	var fullData = getData(full);
	var clipData = getData(clipped);

	var ok = true;
	for (var y = CLIP.y; y < CLIP.y + CLIP.height && ok; y++) {
		for (var x = CLIP.x; x < CLIP.x + CLIP.width && ok; x++) {
			var o = (y * W + x) * 4;
			// green convolved like full-image
			if (clipData[o + 1] !== fullData[o + 1]) ok = false;
			// r, b, a untouched
			if (clipData[o + 0] !== origData[o + 0]) ok = false;
			if (clipData[o + 2] !== origData[o + 2]) ok = false;
			if (clipData[o + 3] !== origData[o + 3]) ok = false;
		}
	}
	assert(ok, "channels='g': only green convolved inside clip, r/b/a preserved");
})();

// --- Test 3: shortcuts (blur/sharpen/gaussianBlur) respect clip consistently ---
(function() {
	var full = makePattern(W, H);
	full.sharpen();
	var clipped = makePattern(W, H);
	clipped.sharpen({ clip: CLIP });
	var err = compareRegion(getData(full), getData(clipped), W, CLIP, "sharpen");
	assert(!err, "sharpen(): clip interior matches full sharpen" + (err ? " -- " + err : ""));

	full = makePattern(W, H);
	full.blur({ amount: 3 });
	clipped = makePattern(W, H);
	clipped.blur({ amount: 3, clip: CLIP });
	err = compareRegion(getData(full), getData(clipped), W, CLIP, "blur");
	assert(!err, "blur(): clip interior matches full blur" + (err ? " -- " + err : ""));

	full = makePattern(W, H);
	full.gaussianBlur({ amount: 3 });
	clipped = makePattern(W, H);
	clipped.gaussianBlur({ amount: 3, clip: CLIP });
	err = compareRegion(getData(full), getData(clipped), W, CLIP, "gaussianBlur");
	assert(!err, "gaussianBlur(): clip interior matches full gaussianBlur" + (err ? " -- " + err : ""));
})();

// --- Test 4: blur with tiny amount is a no-op returning this ---
(function() {
	var c = makePattern(W, H);
	var before = Buffer.from(getData(c));
	var ret = c.blur({ amount: 1 });
	assert(ret === c, "blur(amount=1) returns this");
	assert(Buffer.compare(Buffer.from(getData(c)), before) === 0, "blur(amount=1) leaves pixels untouched");
	assert(!c.getLastError(), "blur(amount=1) produces no error");
})();

// --- Test 5: indexed mode ---
(function() {
	var matrix = kernels.sharpen;

	// quantize into indexed mode
	var indexed = makePattern(W, H);
	indexed.quantizeFast({ colors: 16 });
	assert(indexed.get('mode') == 'indexed', "quantizeFast puts canvas into indexed mode");

	// reference: clone the indexed image, render to RGBA, convolve as RGBA
	var ref = indexed.clone();
	ref.requireRGBA();
	assert(ref.get('mode') == 'rgba', "reference clone rendered to RGBA");

	// convolve both with the same clip (indexed one converts internally)
	indexed.convolve({ matrix: matrix, clip: CLIP });
	ref.convolve({ matrix: matrix, clip: CLIP });

	var err = compareRegion(getData(indexed), getData(ref), W, { x: 0, y: 0, width: W, height: H }, "indexed");
	assert(!err, "indexed-mode convolve(clip) matches RGBA convolve(clip) of rendered image" + (err ? " -- " + err : ""));

	// invalid clip rects in indexed mode must produce explicit errors
	var badClips = [
		{ x: 6, y: 0, width: 10, height: 6 },   // extends past right edge
		{ x: 0, y: 4, width: 8, height: 10 },   // extends past bottom edge
		{ x: -1, y: 0, width: 4, height: 4 },   // negative origin
		{ x: 0, y: 0, width: 0, height: 4 },    // zero width
		{ x: 1.5, y: 0, width: 4, height: 4 },  // non-integer
		{ x: 8, y: 0, width: 1, height: 1 }     // origin outside canvas
	];
	badClips.forEach(function(bad, idx) {
		var c = makePattern(W, H);
		c.quantizeFast({ colors: 16 });
		var res = c.convolve({ matrix: matrix, clip: bad });
		assert(!!(res && res.isError) && !!c.getLastError(),
			"indexed mode: invalid clip #" + idx + " (" + JSON.stringify(bad) + ") returns explicit error: " +
			(c.getLastError() ? c.getLastError().message : "(none)"));
	});

	// also invalid in plain RGBA mode
	var c2 = makePattern(W, H);
	var res2 = c2.convolve({ matrix: matrix, clip: { x: 5, y: 0, width: 10, height: 6 } });
	assert(!!(res2 && res2.isError), "rgba mode: out-of-bounds clip returns explicit error");
})();

// --- Test 6: valid clip exactly matching canvas bounds still works ---
(function() {
	var c = makePattern(W, H);
	var res = c.convolve({ matrix: kernels.sharpen, clip: { x: 0, y: 0, width: W, height: H } });
	assert(res === c && !c.getLastError(), "full-canvas clip rect is accepted");
})();

console.log("");
if (failures) {
	console.error(failures + " test(s) FAILED");
	process.exit(1);
}
else {
	console.log("All tests passed.");
}
