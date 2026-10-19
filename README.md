# Kudos Lighting Labels

Turns a Vectorworks lighting patch PDF into fixture labels on Avery 16-per-sheet stickers (99 × 34 mm). Print them straight from the browser, or download them as PDF or Word.

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
5. Pick the border style, then:
   - **Print labels** opens the browser's print dialog with exact A4 sheets. Set scale to 100% / Actual size and margins to None.
   - **Download PDF** gives a print-ready file. Print it at Actual size.
   - **Download Word** gives the editable .docx on the Kudos Avery template.

   All three use the same grid, so they land on the same stickers. Print one plain sheet first and hold it against a sticker sheet.

Always check flagged rows against the plan before printing.

## How it reads the PDF

- Finds every `universe/address` callout (`2/177`) and pairs it with the nearest 3–4 digit number, which is the channel. Rotated callouts and numbers split into several text runs are handled.
- `0/0` (unpatched) is ignored.
- Fixture type is not written next to each fixture on the drawing, so it is worked out from the channel count (the gap to the next address in the same universe) using the fixture modes library. When two fixtures share a count (LEDBeam 150 and 350 are both 22) the name is left blank to choose. The last fixture in each universe has nothing to measure against, so its type is a guess and is flagged.
- Fixture names from the drawing's Symbol Key are shown for reference and offered in the fixture picker.

### Plans exported as a picture

Some Vectorworks exports come out as an image with no text in them (the GH Greatroom plan did). The tool spots this and reads the picture instead:

1. A quick look at the whole page finds where the numbers are.
2. Each callout is rendered at 600, 900 and 1200 dpi, read at 0°, 90° and 270°, and the reads vote. Coloured symbols and labels are blanked first so they don't run into the digits.
3. Anything still unclear gets a tight re-read on its own.
4. The Symbol Key is read with letters. Lines like `x8 (37 channel/Mode 1)` give each fixture's name, mode and channel count, and the counts are checked against the labels.

Rows read this way are marked **From picture** and need confirming. A picture plan takes about 20 seconds on a laptop; a text PDF is instant. Re-exporting with text kept as text is still the most reliable route.

Picture reading uses [tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 (Apache 2.0). Its engine and English data are in `ocr/` and must be served next to `index.html`.

## Word layout

Matches the Kudos Avery template: A4, 8 rows × 3 columns (column 2 is a 3 mm gutter), cells 9.906 × 3.387 cm, style `Avery Style 1`, vertically centred, Arial. One table per sheet with a 1 pt page-break paragraph between, so sheet 2 onwards lines up with the die-cut stickers. Top margin ≈ 13 mm, sides ≈ 4.4 mm.

## Files

| File | What it is |
|---|---|
| `index.html` | The built, self-contained tool. This is what gets hosted. |
| `core.js` | PDF parsing, pairing, checks and the .docx builder. No DOM, so it can be reused or tested in Node. |
| `src/index.src.html` | Page source; `/*@@CORE@@*/` is replaced by `core.js`. |
| `build.mjs` | `node build.mjs` rebuilds `index.html`. |
| `ocr/` | tesseract.js worker, engine (`.wasm.js`) and English data, used only for picture plans. |

Libraries load from cdnjs: pdf.js 3.11.174, JSZip 3.10.1 and jsPDF 2.5.1, plus tesseract.js 5.1.1 from jsDelivr when a picture plan is loaded. Nothing is uploaded anywhere; the PDF is read in the browser.

## Adding fixture modes

Edit `FIXTURE_LIBRARY` at the top of `core.js` (name, mode, channel count), then run `node build.mjs`. Users can also add modes from the page; those stay in their browser only.

## Adding it to the Kudos CRM

This goes into the Kudos CRM alongside the LED configurator. It is a static page with no server side, so any of these work:

- Serve `index.html` and the `ocr/` folder as-is from the CRM (or embed the page in an iframe on a CRM page).
- Lift the markup, styles and two scripts out of `index.html` into a CRM page. It needs these libraries from cdnjs: pdf.js 3.11.174 (`pdf.min.js` and `pdf.worker.min.js`), JSZip 3.10.1 and jsPDF 2.5.1.
- Use `core.js` on its own with the CRM's own UI:
  - `extractTokens(items, page)` turns pdf.js text items into address and channel tokens.
  - `buildRows(pages, library)` pairs them and returns rows plus the checks.
  - `buildPdf(jsPDF, labels, {border, title})` returns the print-ready PDF.
  - `buildDocx(JSZip, labels, {border, title})` returns the Word file from a plain list of `{fixture, channel, universe, address}`. If the CRM already holds a job's fixtures, it can call this directly and skip the PDF.

The fixture modes library is hard-coded in `core.js`, and page additions are kept in the browser's localStorage. If the CRM has a database, that list is the natural thing to move into it so everyone shares the same modes.
