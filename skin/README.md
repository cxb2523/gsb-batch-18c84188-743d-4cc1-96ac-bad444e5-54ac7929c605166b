# TRAX skin text layout

Reference implementation of the text typesetting rules described in
[`../SKINS.html`](../SKINS.html) (sections *lines and fields*, *How text is
fitted*, *Colors* and *areas*). Pure JavaScript, no dependencies.

## What it does

`layoutArea(area, track, options)` takes one `skin.json` area and the current
track and returns the visible lines with everything a renderer needs:

```js
import { layoutArea } from './text-layout.js';

const result = layoutArea(
  {
    rect: [91, 31, 263, 22],
    size: 11,
    align: 'center',
    lines: [['album', ': ', 'artist']],
  },
  { album: 'Technique' }, // no artist
  { measure: (text, size) => measureWithPspFont(text, size) },
);
// -> { rect: {x: 91, y: 31, width: 263, height: 22},
//      align: 'center', color: '#202020',
//      lines: [{ text: 'Technique', size: 11, x: …, y: …, width: …, truncated: false }] }
```

Rules implemented, matching the doc:

- Field names match exactly and case-sensitively (`title`, `artist`, `album`,
  `track`, `playlist`); every other piece is printed as written.
- Fixed text between two fields survives only when both fields have values;
  fixed text at the start/end survives only when its neighboring field has a
  value. A line composed entirely of fixed text always prints.
- A line that composes to an empty string is skipped (no blank row).
- Visible lines stack `size + 2` pixels apart and the whole block is
  vertically centered in the (screen-clipped) `rect`; `align` handles the
  horizontal placement (`left`/`center`/`right`, anything else is `left`).
- Over-wide lines shrink in three 12% steps (to about two-thirds of `size`);
  if they still don't fit, the end is cut and `"..."` is appended.
- Explicit colors must be exactly `#RRGGBB`; anything else falls back to the
  automatic choice from the opaque pixels inside the rect (`#202020` on light
  pictures, `#F0F0F0` on dark or transparent ones).
- `rect` is clamped to the screen; an area with no width or height left is
  skipped.

`layoutSkin(skin, track, options)` applies the top-level `defaults` and the
documented limits (8 areas, 4 lines, 6 pieces per line) across a whole parsed
`skin.json`.

The platform layer supplies `measure(text, size)` (PSP system-font metrics)
and, for automatic colors, the decoded picture as an RGBA
`{ width, height, data }` object. `defaultMeasure` is a deterministic
stand-in used by the tests and offline tooling.

## Tests

Requires Node.js 18+ (built-in test runner, nothing to install):

```sh
node --test
```

The suite in `test/text-layout.test.js` uses the fixture
`test/fixtures/skin.json` plus inline track data and covers, among other
cases:

- missing artist on `["album", ": ", "artist"]` prints only the album;
- missing title on `["Side A · ", "title"]` removes the whole line;
- an over-long title shrinks three times and is then truncated with `...`;
- all-empty lines are skipped;
- an invalid explicit color falls back to the automatic choice.
