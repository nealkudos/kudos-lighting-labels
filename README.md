# Kudos Lighting Labels

Turns a Vectorworks lighting patch PDF into fixture labels on Avery 16-per-sheet stickers (99 × 34 mm), downloaded as a Word file.

Each label has three centred lines:

1. Fixture name with mode — `Robe LEDBeam 350 (Mode 1)` (14 pt)
2. Channel number — `501` (28 pt bold)
3. DMX address, dotted — `5.1` (14 pt)

Labels print in channel order.

## Using it

1. Open `index.html` (or the GitHub Pages / CRM link).
2. Drop in the patch PDF. The whole lighting pack is fine; every page is read and repeated patches are merged.
3. Read the **Checks** panel: missing channels, duplicates, gaps and any fixture names filled in automatically.
4. Fix anything in the table. Setting a fixture on one row fills the blank rows with the same address spacing in that universe.
5. Pick the border style and **Download Word labels**.

Always check flagged rows against the plan before printing.

## How it reads the PDF

- Finds every `universe/address` callout (`2/177`) and pairs it with the nearest 3–4 digit number, which is the channel. Rotated callouts and numbers split into several text runs are handled.
- `0/0` (unpatched) is ignored.
- Fixture type is not written next to each fixture on the drawing, so it is worked out from the channel count (the gap to the next address in the same universe) using the fixture modes library. When two fixtures share a count (LEDBeam 150 and 350 are both 22) the name is left blank to choose. The last fixture in each universe has nothing to measure against, so its type is a guess and is flagged.
- Fixture names from the drawing's Symbol Key are shown for reference and offered in the fixture picker.

The PDF must contain real text. If Vectorworks exported text as outlines, or the PDF is a scan, nothing will be found.

## Word layout

Matches the Kudos Avery template: A4, 8 rows × 3 columns (column 2 is a 3 mm gutter), cells 9.906 × 3.387 cm, style `Avery Style 1`, vertically centred, Arial. One table per sheet with a 1 pt page-break paragraph between, so sheet 2 onwards lines up with the die-cut stickers. Top margin ≈ 13 mm, sides ≈ 4.4 mm.

## Files

| File | What it is |
|---|---|
| `index.html` | The built, self-contained tool. This is what gets hosted. |
| `core.js` | PDF parsing, pairing, checks and the .docx builder. No DOM, so it can be reused or tested in Node. |
| `src/index.src.html` | Page source; `/*@@CORE@@*/` is replaced by `core.js`. |
| `build.mjs` | `node build.mjs` rebuilds `index.html`. |

Libraries load from cdnjs: pdf.js 3.11.174 and JSZip 3.10.1. Nothing is uploaded anywhere; the PDF is read in the browser.

## Adding fixture modes

Edit `FIXTURE_LIBRARY` at the top of `core.js` (name, mode, channel count), then run `node build.mjs`. Users can also add modes from the page; those stay in their browser only.

## Putting it in Current RMS

The tool is a static page, so it can be:

- hosted on GitHub Pages and linked from Current RMS, or
- loaded as a tab in the Kudos RMS extension (an iframe of the hosted page, or `core.js` plus the page markup dropped into the extension).

If it should later pull fixtures from a Current RMS opportunity instead of the PDF, `buildDocx(JSZip, labels, {border, title})` in `core.js` takes a plain list of `{fixture, channel, universe, address}` and can be called directly.
