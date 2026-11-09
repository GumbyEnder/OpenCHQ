// Node fonts: the original's lettering, decoded from FONTS.CHQ.
//
// The file is 564 bytes: a 12-byte header and a mono strip of 6 rows, each 92 bytes wide, one glyph
// per 8-pixel column. Header bytes 4..5 are 0x20 and 0x7b, so 92 glyphs — and 12 + 92*6 = 564
// exactly, which is the arithmetic that pins the reading. Decoded by
// Command HQ/modern/tools/font_decode.py; asserted here against the atlas it writes.
//
// When the extract is absent (the public host) the atlas is absent too and the page keeps a system
// font. That path is asserted first so it holds even on a machine with no reference tree.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CELL_H, CELL_W, fitScale, glyphFor, textBitmap, validateAtlas } from "../../public/font.mjs";
import { extractRoot, referenceRoot } from "../env.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}

export const name = "fonts";

export async function run(ctx) {
  const root = extractRoot();
  const ref = referenceRoot();
  const atlasPath = root ? path.join(root, "data", "font_atlas.json") : "";
  const fontPath = ref ? path.join(ref, "..", "COMMAND", "FONTS.CHQ") : "";

  // --- the absent case is the public host, and it must be quiet -----------------------------
  const absent = validateAtlas({ source: "missing" });
  if (absent.ok) fail("a missing atlas validated");
  eq("the fallback has a reason", typeof absent.reason, "string");
  const empty = textBitmap({ glyphs: [] }, "", 1);
  eq("an empty string is zero wide", empty.width, 0);

  // --- the file's own arithmetic ------------------------------------------------------------
  if (!fontPath || !existsSync(fontPath)) {
    ctx.skip("no COMMAND/FONTS.CHQ beside the reference tree; only the fallback path was checked");
    return;
  }
  {
    const bytes = readFileSync(fontPath);
    eq("FONTS.CHQ is the size the header implies", bytes.length, 564);
    eq("header names the first character", bytes[4], 0x20);
    eq("header names the last character", bytes[5], 0x7b);
    const count = bytes[5] - bytes[4] + 1;
    eq("the count is 92 glyphs", count, 92);
    eq("12 header bytes plus 92 six-byte rows is the whole file", 12 + count * CELL_H, bytes.length);
  }

  // --- the atlas the decoder wrote ----------------------------------------------------------
  if (!atlasPath || !existsSync(atlasPath)) {
    ctx.skip("no decoded font_atlas.json in the extract; only FONTS.CHQ was checked");
    return;
  }
  const atlas = JSON.parse(readFileSync(atlasPath, "utf8"));
  const check = validateAtlas({ ...atlas, source: "extract" });
  if (!check.ok) fail("the decoded atlas does not validate: " + check.reason);
  eq("the atlas holds the glyph count the file implies", check.count, 92);
  eq("the atlas starts at space", check.first, 32);
  eq("the atlas ends at the last header character", check.last, 123);

  for (const code of atlas.glyphs.map((g) => g.code)) {
    if (code < 32 || code > 123) fail("glyph code out of the header range: " + code);
  }
  const distinct = new Set(atlas.glyphs.map((g) => g.rows.join(",")));
  if (distinct.size < 60) fail("only " + distinct.size + " distinct glyph bitmaps, which is not a font");

  // A glyph is a byte per row: nothing may be wider than the 8-pixel cell.
  for (const glyph of atlas.glyphs) {
    for (const row of glyph.rows) if (row > 255) fail("glyph " + glyph.code + " row exceeds a byte");
  }

  // --- a known string renders, and letters are distinct ------------------------------------
  const ink = (bitmap) => bitmap.rows.join("").split("").filter((c) => c === "1").length;
  const a = textBitmap(atlas, "A", 1);
  const b = textBitmap(atlas, "B", 1);
  eq("one glyph is one cell wide", a.width, CELL_W);
  eq("one glyph is the cell tall", a.height, CELL_H);
  if (ink(a) === 0) fail("'A' rendered empty");
  if (a.rows.join("") === b.rows.join("")) fail("'A' and 'B' render identically");
  if (ink(textBitmap(atlas, " ", 1)) !== 0) fail("space has ink in it");

  const word = textBitmap(atlas, "TIME LEFT", 1);
  eq("a nine-character string is nine cells wide", word.width, 9 * CELL_W);
  if (ink(word) === 0) fail("the label rendered empty");
  // Every letter of the label must contribute: a broken mapping shows up as a blank cell.
  for (let i = 0; i < 9; i++) {
    const cell = word.rows.map((row) => row.slice(i * CELL_W, (i + 1) * CELL_W)).join("");
    if (i === 4) continue; // the space
    if (!cell.includes("1")) fail("cell " + i + " of 'TIME LEFT' is blank");
  }

  // --- whole-pixel scaling only -------------------------------------------------------------
  const doubled = textBitmap(atlas, "A", 2);
  eq("scale 2 doubles the width", doubled.width, CELL_W * 2);
  eq("scale 2 doubles the height", doubled.height, CELL_H * 2);
  eq("scale 2 is four times the ink", ink(doubled), ink(a) * 4);
  eq("a fractional scale is treated as 1", textBitmap(atlas, "A", 1.7).width, CELL_W);
  eq("fitScale never returns 0", fitScale(atlas, "TIME LEFT", 4) >= 1, true);
  eq("fitScale uses the whole width it has", fitScale(atlas, "AB", 32), 2);

  // The atlas covers 32..123, so lowercase is its own glyph; anything outside that range has to
  // land on something printable rather than throwing.
  eq("a lowercase letter is its own glyph", glyphFor(atlas, "a".charCodeAt(0)).code, "a".charCodeAt(0));
  eq("a character past the atlas falls back to space", glyphFor(atlas, 0x2500).code, 32);
}
