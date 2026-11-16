import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  composeLine,
  fitText,
  parseColor,
  autoTextColor,
  clampRect,
  layoutArea,
  layoutSkin,
  defaultMeasure,
  DARK_TEXT,
  LIGHT_TEXT,
} from '../text-layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureSkin = JSON.parse(readFileSync(join(here, 'fixtures', 'skin.json'), 'utf8'));

// Deterministic offline measurer: half a pixel per glyph per pixel of size.
// The real build injects PSP system-font metrics in its place.
const measure = (text, size) => Math.round(Array.from(String(text)).length * size * 0.5);

// Build an RGBA image filled with one color.
function solidImage(width, height, [r, g, b], alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

test('composeLine: missing artist drops the ": " separator, album still prints', () => {
  const track = { album: 'Technique' };
  assert.equal(composeLine(['album', ': ', 'artist'], track), 'Technique');
});

test('composeLine: separator is kept when both fields have values', () => {
  const track = { album: 'Technique', artist: 'New Order' };
  assert.equal(composeLine(['album', ': ', 'artist'], track), 'Technique: New Order');
});

test('composeLine: missing album drops the leading separator', () => {
  const track = { artist: 'New Order' };
  assert.equal(composeLine(['album', ': ', 'artist'], track), 'New Order');
});

test('composeLine: missing title makes ["Side A · ", "title"] an empty line', () => {
  assert.equal(composeLine(['Side A · ', 'title'], {}), '');
  assert.equal(composeLine(['Side A · ', 'title'], { title: '' }), '');
});

test('composeLine: field names match exactly and case-sensitively', () => {
  // "Title" is not a field, so it is printed as written even with no track.
  assert.equal(composeLine(['Title'], {}), 'Title');
  assert.equal(composeLine('title', { title: 'Fine Time' }), 'Fine Time');
});

test('composeLine: each separator is gated by its own two neighboring fields', () => {
  // Spec rule, applied piece by piece: text between two fields is kept only
  // when BOTH have values. With album missing, both surrounding separators
  // drop, leaving the two surviving fields joined directly.
  const line = ['artist', ' - ', 'album', ' · ', 'title'];
  const track = { artist: 'New Order', title: 'Fine Time' }; // no album
  assert.equal(composeLine(line, track), 'New OrderFine Time');
});

test('composeLine: a line made only of fixed text always prints', () => {
  assert.equal(composeLine(['hello', ' ', 'world'], {}), 'hello world');
  assert.equal(composeLine('SIDE A', {}), 'SIDE A');
});

test('composeLine: whitespace-only values are still values', () => {
  assert.equal(composeLine(['album', ': ', 'artist'], { album: ' ', artist: 'x' }), ' : x');
});

test('fitText: text that fits keeps its size', () => {
  const result = fitText('hello', 14, 1000, measure);
  assert.deepEqual(result, { text: 'hello', size: 14, truncated: false });
});

test('fitText: shrinks through 12% steps until it fits, without truncating', () => {
  // Five glyphs: 35px at size 14, 30px at size 12. A 30px box fits at step 1.
  const result = fitText('hello', 14, 30, measure);
  assert.equal(result.truncated, false);
  assert.equal(result.size, 12); // round(14 * 0.88)
  assert.equal(result.text, 'hello');
});

test('fitText: three shrink steps reach about two thirds of the size', () => {
  const steps = [14, Math.round(14 * 0.88), Math.round(14 * 0.88 ** 2), Math.round(14 * 0.88 ** 3)];
  assert.deepEqual(steps, [14, 12, 11, 10]); // smallest is ~0.71 of size
});

test('fitText: after three shrinks it still overflows, so it is cut with "..."', () => {
  const longTitle = 'a'.repeat(60);
  const result = fitText(longTitle, 14, 40, measure);
  assert.equal(result.truncated, true);
  assert.equal(result.size, 10); // smallest step
  assert.ok(result.text.endsWith('...'));
  assert.ok(result.text.length < longTitle.length);
  assert.ok(measure(result.text, result.size) <= 40);
});

test('fitText: a box narrower than the ellipsis still yields "..."', () => {
  const result = fitText('abcdef', 14, 4, measure);
  assert.equal(result.truncated, true);
  assert.equal(result.text, '...');
});

test('parseColor: only exact #RRGGBB is accepted', () => {
  assert.equal(parseColor('#112233'), '#112233');
  assert.equal(parseColor('#aabbcc'), '#AABBCC');
  assert.equal(parseColor('#FFF'), null);
  assert.equal(parseColor('white'), null);
  assert.equal(parseColor('#12345'), null);
  assert.equal(parseColor('#gggggg'), null);
  assert.equal(parseColor(undefined), null);
  assert.equal(parseColor(null), null);
});

test('autoTextColor: light opaque picture gives dark text', () => {
  const image = solidImage(8, 8, [240, 240, 240]);
  assert.equal(autoTextColor(image, { x: 0, y: 0, width: 8, height: 8 }), DARK_TEXT);
});

test('autoTextColor: dark opaque picture gives light text', () => {
  const image = solidImage(8, 8, [16, 16, 32]);
  assert.equal(autoTextColor(image, { x: 0, y: 0, width: 8, height: 8 }), LIGHT_TEXT);
});

test('autoTextColor: transparent pixels are ignored; all-transparent gives light text', () => {
  const image = solidImage(8, 8, [255, 255, 255], 0);
  assert.equal(autoTextColor(image, { x: 0, y: 0, width: 8, height: 8 }), LIGHT_TEXT);
});

test('autoTextColor: missing image gives light text', () => {
  assert.equal(autoTextColor(null, { x: 0, y: 0, width: 8, height: 8 }), LIGHT_TEXT);
});

test('clampRect: rect running off-screen is cut back to the edge', () => {
  assert.deepEqual(clampRect([400, 260, 200, 40]), { x: 400, y: 260, width: 80, height: 12 });
  assert.deepEqual(clampRect([-10, -5, 100, 20]), { x: 0, y: 0, width: 90, height: 15 });
});

test('clampRect: zero or negative remaining size means the area is skipped', () => {
  assert.equal(clampRect([0, 0, 0, 20]), null);
  assert.equal(clampRect([0, 0, 20, 0]), null);
  assert.equal(clampRect([480, 0, 10, 10]), null);
  assert.equal(clampRect([0, 272, 10, 10]), null);
});

test('layoutArea: required end-to-end cases from the skin spec', () => {
  const area = {
    rect: [10, 20, 200, 60],
    size: 12,
    align: 'center',
    lines: [
      ['album', ': ', 'artist'],          // artist missing -> album only
      ['Side A · ', 'title'],             // title missing -> whole line gone
      ['artist'],                         // all empty -> skipped
      ['playlist'],                       // present -> kept
      ['track', ' / ', 'playlist'],       // both present -> joined
    ],
  };
  const track = { album: 'Technique', playlist: 'Factory Years', track: '3/12' };
  const result = layoutArea(area, track, { measure });

  assert.ok(result);
  assert.equal(result.lines.length, 3);
  assert.deepEqual(result.lines.map((l) => l.text), [
    'Technique',
    'Factory Years',
    '3/12 / Factory Years',
  ]);

  // Lines stack size+2 px apart and the block is vertically centered.
  const size = 12;
  const pitch = size + 2;
  const blockHeight = 3 * size + 2 * 2; // 40
  const expectedTop = 20 + Math.round((60 - blockHeight) / 2); // 30
  assert.deepEqual(result.lines.map((l) => l.y), [
    expectedTop,
    expectedTop + pitch,
    expectedTop + pitch * 2,
  ]);

  // Center alignment: each line is centered on the area.
  for (const line of result.lines) {
    assert.equal(line.x, 10 + Math.round((200 - line.width) / 2));
  }
});

test('layoutArea: long title is shrunk and then truncated with "..."', () => {
  const area = { rect: [0, 0, 40, 20], size: 14, lines: [['title']] };
  const result = layoutArea(area, { title: 'a'.repeat(60) }, { measure });
  assert.equal(result.lines.length, 1);
  const line = result.lines[0];
  assert.equal(line.truncated, true);
  assert.equal(line.size, 10);
  assert.ok(line.text.endsWith('...'));
  assert.ok(line.width <= 40);
});

test('layoutArea: invalid color is ignored and automatic choice is used', () => {
  const lightImage = solidImage(480, 272, [250, 250, 250]);
  const darkImage = solidImage(480, 272, [5, 5, 10]);
  const area = { rect: [10, 230, 100, 16], size: 14, color: 'not-a-color', lines: [['artist']] };

  const onLight = layoutArea(area, { artist: 'New Order' }, { measure, image: lightImage });
  assert.equal(onLight.color, DARK_TEXT);

  const onDark = layoutArea(area, { artist: 'New Order' }, { measure, image: darkImage });
  assert.equal(onDark.color, LIGHT_TEXT);

  // Short hex form is invalid too.
  const shortHex = layoutArea({ ...area, color: '#fff' }, { artist: 'x' }, { measure, image: darkImage });
  assert.equal(shortHex.color, LIGHT_TEXT);
});

test('layoutArea: valid explicit color is kept and canonicalized', () => {
  const area = { rect: [0, 0, 100, 16], color: '#aabbcc', lines: [['title']] };
  const result = layoutArea(area, { title: 'x' }, { measure, image: solidImage(4, 4, [0, 0, 0]) });
  assert.equal(result.color, '#AABBCC');
});

test('layoutArea: align left/center/right position lines correctly; bad align is left', () => {
  const base = { rect: [10, 0, 100, 16], size: 14, lines: [['title']] };
  const track = { title: 'hi' }; // measured width: round(2 * 14 * 0.5) = 14

  const left = layoutArea({ ...base, align: 'left' }, track, { measure });
  assert.equal(left.lines[0].x, 10);

  const center = layoutArea({ ...base, align: 'center' }, track, { measure });
  assert.equal(center.lines[0].x, 10 + Math.round((100 - 14) / 2));

  const right = layoutArea({ ...base, align: 'right' }, track, { measure });
  assert.equal(right.lines[0].x, 10 + 100 - 14);

  const bogus = layoutArea({ ...base, align: 'middle' }, track, { measure });
  assert.equal(bogus.align, 'left');
  assert.equal(bogus.lines[0].x, 10);
});

test('layoutArea: zero-width area is skipped and rect is clamped', () => {
  const skipped = layoutArea({ rect: [0, 0, 0, 20], lines: [['title']] }, { title: 'x' }, { measure });
  assert.equal(skipped, null);

  const clamped = layoutArea({ rect: [400, 260, 200, 40], lines: [['title']] }, { title: 'x' }, { measure });
  assert.deepEqual(clamped.rect, { x: 400, y: 260, width: 80, height: 12 });
});

test('layoutArea: area with no visible lines still returns an empty line list', () => {
  const result = layoutArea({ rect: [0, 0, 100, 16], lines: [['artist']] }, {}, { measure });
  assert.deepEqual(result.lines, []);
});

test('layoutSkin: applies defaults, limits, and lays the fixture skin out', () => {
  const track = {
    album: 'Technique',
    // artist intentionally missing
    // title intentionally missing
    track: '3/12',
    playlist: 'Factory Years',
  };
  const image = solidImage(480, 272, [245, 245, 245]);
  const result = layoutSkin(fixtureSkin, track, { measure, image });

  assert.equal(result.length, 5);

  // Area 0: three surviving lines, centered, size from the area.
  const main = result[0];
  assert.equal(main.align, 'center');
  assert.deepEqual(main.lines.map((l) => l.text), [
    'Technique',
    'Factory Years',
    '3/12 / Factory Years',
  ]);
  assert.ok(main.lines.every((l) => l.truncated === false));

  // Area 1: explicit valid color, right aligned.
  assert.equal(result[1].color, '#112233');
  assert.equal(result[1].align, 'right');

  // Area 2: invalid color fell back to automatic (light image -> dark text).
  assert.equal(result[2].color, DARK_TEXT);

  // Area 3: clamped to the screen edge, still rendered.
  assert.deepEqual(result[3].rect, { x: 400, y: 260, width: 80, height: 12 });

  // Area 4: zero width -> skipped.
  assert.equal(result[4], null);
});

test('layoutSkin: defaults fill size and align the areas do not set', () => {
  const skin = {
    defaults: { size: 18, align: 'right', color: '#010203' },
    areas: [{ rect: [0, 0, 50, 20], lines: [['title']] }],
  };
  const [result] = layoutSkin(skin, { title: 'x' }, { measure });
  assert.equal(result.lines[0].size, 18);
  assert.equal(result.align, 'right');
  assert.equal(result.color, '#010203');
});

test('layoutSkin: stops at eight areas and four lines per area', () => {
  const skin = {
    areas: Array.from({ length: 10 }, () => ({
      rect: [0, 0, 100, 100],
      lines: Array.from({ length: 6 }, (_, i) => [`title${i}`]),
    })),
  };
  const result = layoutSkin(skin, {}, { measure });
  assert.equal(result.length, 8);
  // Every literal-only line prints; the fifth and sixth are cut by the limit.
  assert.equal(result[0].lines.length, 4);
});

test('layoutSkin: stops at six pieces within a line', () => {
  const skin = {
    areas: [{
      rect: [0, 0, 200, 16],
      lines: [['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    }],
  };
  const [result] = layoutSkin(skin, {}, { measure });
  assert.equal(result.lines[0].text, 'abcdef');
});

test('defaultMeasure is deterministic and scales with the size', () => {
  assert.equal(defaultMeasure('abcd', 10), 24); // round(4 * 10 * 0.6)
  assert.ok(defaultMeasure('abcd', 20) > defaultMeasure('abcd', 10));
});
