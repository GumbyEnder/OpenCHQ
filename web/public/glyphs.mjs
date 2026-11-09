// Per-type glyphs: what a unit looks like once the board is zoomed in.
//
// The original drew the same 3x3 block for every unit on the map and told them apart in its panels,
// where the selected piece had a large picture (docs/chq-reference/chq_0021.png, the unit monitor).
// A browser has no monitor strip, so the identity has to live on the board: below MARKER_ZOOM this
// module draws nothing and the page still uses the original's measured block; at and above it, each
// kind gets a five-cell silhouette.
//
// These shapes are ours, not the archive's art: the shipped sheet (UNITS.PIC) is a 320x200 picture
// sheet and no part of it may reach a browser. What is borrowed is the idea — one glance, one shape.

export const GLYPH_SIZE = 5;
// Below this many pixels per cell a five-cell silhouette is mush, so the block takes over. Above it a
// typed unit is its own icon at every zoom — including the whole-world fit, which is where a player
// spends most of a game looking.
export const GLYPH_MIN_ZOOM = 2;

// '1' is the hull/body, '.' is empty. Five rows of five.
export const GLYPHS = Object.freeze({
  // A figure: head, shoulders, torso, two legs.
  infantry: Object.freeze([
    "..1..",
    ".111.",
    "..1..",
    ".111.",
    ".1.1.",
  ]),
  // A hull with a turret and a barrel over the nose.
  tank: Object.freeze([
    "..1..",
    "11111",
    ".111.",
    "11111",
    ".....",
  ]),
  // Top view: nose, wings, tail.
  aircraft: Object.freeze([
    "..1..",
    "..1..",
    "11111",
    "..1..",
    ".1.1.",
  ]),
  // Pointed bow, full beam, wide stern.
  ship: Object.freeze([
    "..1..",
    ".111.",
    ".111.",
    "11111",
    ".111.",
  ]),
  // A long hull with a sail: no bow point, which is what tells it from a ship at a glance.
  submarine: Object.freeze([
    ".....",
    "..1..",
    ".111.",
    "11111",
    ".....",
  ]),
});

export const GLYPH_KINDS = Object.freeze(Object.keys(GLYPHS));

export function glyphFor(kind) {
  const key = String(kind ?? "");
  return Object.hasOwn(GLYPHS, key) ? GLYPHS[key] : null;
}

// The glyph's cells on the board, with the same X wrap the marker uses. A glyph is centred on the
// piece, so a piece on the seam column still draws every cell.
export function glyphCells(x, y, kind, boardW = 320) {
  const rows = glyphFor(kind);
  if (!rows) return [];
  const w = Math.max(1, Math.floor(Number(boardW) || 320));
  const half = (GLYPH_SIZE - 1) / 2;
  const cells = [];
  for (let row = 0; row < GLYPH_SIZE; row++) {
    for (let col = 0; col < GLYPH_SIZE; col++) {
      if (rows[row][col] !== "1") continue;
      const dx = col - half;
      const dy = row - half;
      cells.push({
        dx,
        dy,
        x: ((((Number(x) + dx) % w) + w) % w),
        y: Number(y) + dy,
      });
    }
  }
  return cells;
}

// A 5x5 glyph as a data URL, for the buy table and anywhere else that wants a still icon. Pure: no
// canvas, no DOM, so the node suite can call it.
export function glyphDataUrl(kind, color = "#e8f1ff") {
  const rows = glyphFor(kind);
  const rects = [];
  for (let r = 0; r < GLYPH_SIZE; r++) {
    for (let c = 0; c < GLYPH_SIZE; c++) {
      if (!rows || rows[r][c] !== "1") continue;
      rects.push(`<rect x="${c}" y="${r}" width="1" height="1"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="5" height="5" fill="${color}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
