// The original's lettering, drawn from the decoded FONTS.CHQ atlas.
//
// The file is 564 bytes: a 12-byte header (first char 0x20, last 0x7b, so 92 glyphs) and a mono
// bitmap strip of 6 rows, each 92 bytes wide, one glyph per 8-pixel column. Decoded by
// Command HQ/modern/tools/font_decode.py into extracted/data/font_atlas.json; served only where
// that extract exists, because the atlas is the game's own art.
//
// Everything here is pure so the page and the test agree on what a string looks like.

export const CELL_W = 8;
export const CELL_H = 6;

// A glyph is 6 rows of one byte, bit 7 leftmost. Anything else is not this atlas.
export function validateAtlas(atlas) {
  if (!atlas || atlas.source !== "extract") return { ok: false, reason: "no atlas" };
  const glyphs = Array.isArray(atlas.glyphs) ? atlas.glyphs : [];
  const meta = atlas._meta || {};
  if (glyphs.length < 1) return { ok: false, reason: "atlas has no glyphs" };
  if (Number(meta.count) !== glyphs.length) {
    return { ok: false, reason: "atlas says " + meta.count + " glyphs and holds " + glyphs.length };
  }
  for (const glyph of glyphs) {
    if (!Array.isArray(glyph.rows) || glyph.rows.length !== CELL_H) {
      return { ok: false, reason: "glyph " + glyph.code + " is not " + CELL_H + " rows" };
    }
    for (const row of glyph.rows) {
      if (!Number.isInteger(row) || row < 0 || row > 255) {
        return { ok: false, reason: "glyph " + glyph.code + " has a row that is not a byte" };
      }
    }
  }
  return { ok: true, count: glyphs.length, first: Number(meta.first), last: Number(meta.last) };
}

export function glyphFor(atlas, code) {
  const list = (atlas && atlas.glyphs) || [];
  const wanted = Number(code);
  for (const glyph of list) if (glyph.code === wanted) return glyph;
  // The original had caps only; an unmapped character falls back to the uppercase, then to space.
  const upper = String.fromCharCode(wanted).toUpperCase().charCodeAt(0);
  if (Number.isFinite(upper) && upper !== wanted) {
    for (const glyph of list) if (glyph.code === upper) return glyph;
  }
  return list.find((glyph) => glyph.code === 32) || null;
}

// A string as rows of "0"/"1", one character per glyph cell, CELL_H rows tall. Advancing by the
// whole cell is the original's monospace layout, not a guess at kerning.
export function textBitmap(atlas, text, scale = 1) {
  // Whole pixels only: a fractional scale would produce a bitmap with half a row in it.
  const step = Math.max(1, Math.floor(Number(scale) || 1));
  const glyphs = [...String(text)].map((char) => glyphFor(atlas, char.codePointAt(0)));
  const width = Math.max(0, glyphs.length) * CELL_W * step;
  const height = CELL_H * step;
  const rows = Array.from({ length: height }, () => new Array(width).fill("0"));
  glyphs.forEach((glyph, index) => {
    if (!glyph) return;
    for (let y = 0; y < CELL_H; y++) {
      const byte = glyph.rows[y];
      for (let x = 0; x < CELL_W; x++) {
        if (!((byte >> (CELL_W - 1 - x)) & 1)) continue;
        for (let sy = 0; sy < step; sy++) {
          for (let sx = 0; sx < step; sx++) {
            rows[y * step + sy][index * CELL_W * step + x * step + sx] = "1";
          }
        }
      }
    }
  });
  return { width, height, rows: rows.map((row) => row.join("")) };
}

// Whole-pixel sizes only: the CELL is scaled by an integer so a 1-pixel stem never smears. Returns
// the largest integer scale that fits `maxWidth`, and never less than 1.
export function fitScale(atlas, text, maxWidth) {
  const cells = [...String(text)].length;
  if (!cells) return 1;
  const fit = Math.floor((Number(maxWidth) || 0) / (cells * CELL_W));
  return Math.max(1, Math.min(6, fit));
}
