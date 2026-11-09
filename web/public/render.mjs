// Match drawing. Pure helpers over the /api/board payload and the room view the
// socket sends; no DOM at import time, so the node harness can drive every
// function with a recording 2d context.
//
// Everything drawn here is derived from cell ids and piece positions: no image
// bytes, no original art, no fetch. Colors come from paint.mjs where they exist
// so the grid and the schematic keep one palette.

import { colorForTerrain, paintBoard, PALETTE, SCHEMATIC, EXTRACT_MISSING } from "./paint.mjs";
import { textBitmap } from "./font.mjs";
import { glyphCells, glyphFor } from "./glyphs.mjs";

export const BOARD_W = 320;
export const BOARD_H = 136;

// Outlines only: a piece's fill is its side color.
// What the original draws for a unit on the map, measured from its own screen.
//
// docs/chq-reference/chq_0021.png is a 640x400 capture of the 320x200 game, so two screen pixels per
// cell. Every unit marker in it is a 6x6 block — three cells at map scale — in the side's dark colour
// (dark blue #0000aa, dark red #aa0000) with one light pixel at the centre. There are no per-type
// sprites on the board: the original told units apart in its panels, not on the map.
export const PIECE_MARKER = Object.freeze({
  size: 3,
  body: Object.freeze({ blue: "#0000aa", red: "#aa0000" }),
  centre: "#ffffff",
});

// Below this zoom the board is the original's board and every unit is the original's marker. Above
// it the shapes take over, because at eight pixels per cell a player should be able to tell a tank
// from an infantry section — an affordance the original did not need and did not have.
export const MARKER_ZOOM = 4;

// The nine cells of a marker, with the centre one carrying the light pixel. X wraps, so a unit in
// the seam column draws three cells, not two.
export function markerCells(x, y, side, boardW = BOARD_W) {
  const half = (PIECE_MARKER.size - 1) / 2;
  const body = PIECE_MARKER.body[side] || PIECE_MARKER.body.blue;
  const cells = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const centre = dx === 0 && dy === 0;
      cells.push({
        dx,
        dy,
        x: ((((Number(x) + dx) % boardW) + boardW) % boardW),
        y: Number(y) + dy,
        colour: centre ? PIECE_MARKER.centre : body,
        centre,
      });
    }
  }
  return cells;
}

export const PIECE_INK = Object.freeze({
  own: "#f2f7ff",
  enemy: "#050b14",
});

// The two seats are fixed in the archive. They are also the schematic fallback,
// so a hosted build with no extract still has capitals to label.
const CAPITAL_SEATS = Object.freeze({
  blue: Object.freeze({ name: "Washington", x: 79, y: 44 }),
  red: Object.freeze({ name: "Moscow", x: 183, y: 25 }),
});

// Every terrain a player actually sees, not only the four that carry a marker: green ground used to
// appear on the board with no legend entry at all, which reads as "somebody's territory" when it is
// just plain.
const LEGEND_TERRAIN = Object.freeze([
  "ocean", "shallows", "plain", "forest", "desert", "mountain", "polar", "city", "capital",
]);

// ---- maths -----------------------------------------------------------------

// X wraps, Y does not.
export function wrapX(x, width = BOARD_W) {
  const w = Math.max(1, Math.floor(Number(width) || BOARD_W));
  const n = Math.trunc(Number(x) || 0);
  return ((n % w) + w) % w;
}

// Shortest signed step from one column to another across the seam. 319 -> 0 is
// +1, not -319.
export function wrapDelta(fromX, toX, width = BOARD_W) {
  const w = Math.max(1, Math.floor(Number(width) || BOARD_W));
  const span = w / 2;
  let d = wrapX(Number(toX) - Number(fromX), w);
  if (d > span) d -= w;
  if (d < -span) d += w;
  return d;
}

// Whole cells only: a 320x136 board drawn at scale 2 is exact. A viewport too
// small for one cell still gets scale 1 and stays readable enough to see.
export function fitViewport(availW, availH, boardW = BOARD_W, boardH = BOARD_H, maxScale = 4) {
  const bw = Math.max(1, Math.floor(Number(boardW) || BOARD_W));
  const bh = Math.max(1, Math.floor(Number(boardH) || BOARD_H));
  const aw = Math.max(1, Math.floor(Number(availW) || bw));
  const ah = Math.max(1, Math.floor(Number(availH) || bh));
  const cap = Math.max(1, Math.floor(Number(maxScale) || 1));
  const raw = Math.min(aw / bw, ah / bh);
  const scale = Math.max(1, Math.min(cap, Math.floor(raw) || 1));
  return {
    scale,
    left: Math.floor((aw - bw * scale) / 2),
    top: Math.floor((ah - bh * scale) / 2),
    viewW: aw,
    viewH: ah,
    boardW: bw,
    boardH: bh,
  };
}

// Normalizes a partially built view. Only the fields the painter reads are kept.
export function makeView(partial = {}, board = null) {
  const boardW = Math.max(1, Math.floor(Number(partial.boardW ?? board?.width) || BOARD_W));
  const boardH = Math.max(1, Math.floor(Number(partial.boardH ?? board?.height) || BOARD_H));
  const scale = Math.max(1, Math.floor(Number(partial.scale) || 1));
  const viewW = Math.max(1, Math.floor(Number(partial.viewW) || boardW * scale));
  const viewH = Math.max(1, Math.floor(Number(partial.viewH) || boardH * scale));
  const left = Number.isFinite(Number(partial.left)) ? Math.trunc(Number(partial.left)) : 0;
  const top = Number.isFinite(Number(partial.top)) ? Math.trunc(Number(partial.top)) : 0;
  return { scale, left, top, viewW, viewH, boardW, boardH };
}

// Cell (column, row) -> pixel at the cell's center. The seam is not special:
// callers pass a wrapped column via wrapX.
export function cellToPixel(x, y, view) {
  const v = view || makeView({ scale: 1 });
  return {
    x: v.left + (Number(x) + 0.5) * v.scale,
    y: v.top + (Number(y) + 0.5) * v.scale,
  };
}

// Pixel -> nearest cell, used for hit testing and for framing a piece.
export function pixelToCell(px, py, view) {
  const v = view || makeView({ scale: 1 });
  return {
    x: wrapX(Math.floor((Number(px) - v.left) / v.scale), v.boardW),
    y: Math.max(0, Math.min(v.boardH - 1, Math.floor((Number(py) - v.top) / v.scale))),
  };
}

// Columns of the world that touch the viewport, in world coordinates (may run
// past either edge of the board; wrapX maps them onto real cells).
export function visibleColumns(view) {
  const v = view;
  return {
    first: Math.floor(-v.left / v.scale),
    last: Math.ceil((v.viewW - v.left) / v.scale) - 1,
  };
}

export function visibleRows(view) {
  const v = view;
  return {
    first: Math.max(0, Math.floor(-v.top / v.scale)),
    last: Math.min(v.boardH - 1, Math.ceil((v.viewH - v.top) / v.scale) - 1),
  };
}

// Left edge that centers focusX, wrapped. Can be negative; the painter repeats
// the board at every multiple of its pixel width, so the seam fills in.
export function focusLeft(focusX, view) {
  const v = view;
  return v.viewW / 2 - (wrapX(focusX, v.boardW) + 0.5) * v.scale;
}

// One left edge per copy of the board that overlaps [0, viewW).
export function tileLefts(left, boardPixelWidth, viewWidth) {
  const step = Math.max(1, Math.floor(Number(boardPixelWidth) || 1));
  const width = Math.max(1, Math.floor(Number(viewWidth) || 1));
  const out = [];
  const kMin = Math.ceil((-left - step) / step) - 1;
  const kMax = Math.ceil((width - left) / step) + 1;
  for (let k = kMin; k <= kMax; k++) {
    const tile = left + k * step;
    if (tile >= width || tile + step <= 0) continue;
    out.push(tile);
  }
  return out.sort((a, b) => a - b);
}


// ---- fog and camera ---------------------------------------------------------------------

// What a seat can see, as a cell table: 1 where one of its own pieces has line of sight.
// Chebyshev with the X wrap, exactly the server's rule (rules.sightCells()), so the client is
// drawing the same rule the server applied - not a guess at where the enemy might be.
export function sightTable(board, pieces, sight) {
  const width = Math.max(1, Number(board && board.width) || BOARD_W);
  const height = Math.max(1, Number(board && board.height) || BOARD_H);
  const table = new Uint8Array(width * height);
  const reach = Math.max(0, Math.floor(Number(sight) || 0));
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || !Number.isFinite(Number(piece.x)) || !Number.isFinite(Number(piece.y))) continue;
    const px = wrapX(piece.x, width);
    const py = Number(piece.y);
    for (let dy = -reach; dy <= reach; dy++) {
      const y = py + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const x = wrapX(px + dx, width);
        table[y * width + x] = 1;
      }
    }
  }
  return table;
}

// Memory: what has ever been in sight. Unknown ground is drawn darker than ground the seat has
// looked at before and since lost, which is the difference the sight rule is supposed to teach.
export function rememberSeen(seen, lit) {
  const into = seen && seen.length === lit.length ? seen : new Uint8Array(lit.length);
  for (let i = 0; i < lit.length; i++) if (lit[i]) into[i] = 1;
  return into;
}

// Fog is memory, not a shutter: unknown ground keeps the world's silhouette so the player can
// plan toward it, and remembered ground keeps more. At 0.82 the map was a black rectangle.
export const FOG_REMEMBERED = "rgba(6, 12, 22, 0.28)";
export const FOG_UNKNOWN = "rgba(6, 12, 22, 0.55)";

export function paintFog(ctx, view, lit, seen) {
  if (!lit || lit.length === 0) return 0;
  const cols = visibleColumns(view);
  const rows = visibleRows(view);
  if (view.boardW * view.scale <= view.viewW) {
    cols.first = 0;
    cols.last = view.boardW - 1;
  }
  let drawn = 0;
  for (let y = rows.first; y <= rows.last; y++) {
    const row = y * view.boardW;
    for (let sx = cols.first; sx <= cols.last; sx++) {
      const index = row + wrapX(sx, view.boardW);
      if (lit[index]) continue;
      const known = seen && seen[index];
      ctx.fillStyle = known ? FOG_REMEMBERED : FOG_UNKNOWN;
      ctx.fillRect(view.left + sx * view.scale, view.top + y * view.scale, view.scale, view.scale);
      drawn++;
    }
  }
  return drawn;
}

// The sight ring of the selected piece: the same Chebyshev box, drawn as an outline so the rule
// is visible rather than implied.
export function paintSightRing(ctx, cell, view, sight, color) {
  if (!cell || !view) return null;
  const reach = Math.max(0, Math.floor(Number(sight) || 0));
  if (reach === 0) return null;
  const scale = view.scale;
  const left = view.left + (wrapX(cell.x, view.boardW) - reach) * scale;
  const top = view.top + (cell.y - reach) * scale;
  const size = (reach * 2 + 1) * scale;
  ctx.strokeStyle = color || "rgba(242, 247, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, size, size);
  return { left, top, size };
}

// ---- camera -----------------------------------------------------------------------------
//
// The board is 320x136; at 2x a piece is four pixels. The camera is whole-cell zoom plus a
// pan, and the pan is unbounded in X because the painter tiles the board across the seam.
// The floor is 1, not 2: the whole earth has to fit on a short canvas, and a 320x136 board in a
// 270-pixel-tall window fits only at 1x. Legibility is what the zoom-in is for.
export const MIN_ZOOM = 1;
// Device pixels, not CSS pixels: the canvas is sized at the device pixel ratio, so a cell is
// crisp only if the zoom is expressed in the same units. 32 device px is 16 CSS px on a retina
// screen and 32 on a plain one.
export const MAX_ZOOM = 32;

export function clampZoom(scale) {
  const zoom = Math.round(Number(scale) || MIN_ZOOM);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

// Centre a cell in the viewport. `left` may be negative: the seam is handled by tiling.
export function centerOn(cell, view) {
  const scale = clampZoom(view.scale);
  const cx = wrapX(cell.x, view.boardW);
  const cy = Math.max(0, Math.min(view.boardH - 1, Number(cell.y)));
  return {
    ...view,
    scale,
    left: Math.round(view.viewW / 2 - (cx + 0.5) * scale),
    top: Math.round(view.viewH / 2 - (cy + 0.5) * scale),
  };
}

export function panBy(view, dx, dy) {
  return { ...view, left: Math.round(Number(view.left || 0) + Number(dx || 0)), top: Math.round(Number(view.top || 0) + Number(dy || 0)) };
}

// Zoom about a screen point, so the cell under the cursor stays under the cursor.
export function zoomAt(view, factor, screenX, screenY) {
  const next = clampZoom(view.scale * Number(factor || 1));
  if (next === view.scale) return view;
  const ax = Number(screenX);
  const ay = Number(screenY);
  const worldX = (ax - view.left) / view.scale;
  const worldY = (ay - view.top) / view.scale;
  return {
    ...view,
    scale: next,
    left: Math.round(ax - worldX * next),
    top: Math.round(ay - worldY * next),
  };
}

// ---- palette ---------------------------------------------------------------

// Terrain name -> color, exactly the painter's table. Unknown names stay null.
export function paletteFor(name) {
  return colorForTerrain(name);
}

export function sideColor(side) {
  return String(side) === "red" ? SCHEMATIC.red : SCHEMATIC.blue;
}

export function pieceColor(piece) {
  return sideColor(piece && piece.side);
}

// Sea is a disc, aircraft a triangle, everything else a square. A land piece in the water is a
// transport, and it draws as a ring: cargo, not a warship.
export function pieceShape(piece) {
  if (piece && piece.kind === "aircraft") return "triangle";
  if (piece && piece.transport === true) return "ring";
  if (piece && piece.domain === "sea") return "circle";
  return "square";
}

// The capitals the page must label, from the payload when it has them.
export function capitalMarkers(board) {
  const source = (board && board.capitals) || {};
  const out = [];
  for (const side of ["blue", "red"]) {
    const seat = CAPITAL_SEATS[side];
    const found = source[side] || {};
    out.push({
      side,
      name: String(found.name || seat.name),
      x: Number.isFinite(Number(found.x)) ? Number(found.x) : seat.x,
      y: Number.isFinite(Number(found.y)) ? Number(found.y) : seat.y,
      color: sideColor(side),
    });
  }
  return out;
}

export function legendEntries() {
  const entries = LEGEND_TERRAIN.map((name) => ({ label: name, color: colorForTerrain(name) }))
    .filter((entry) => entry.color);
  entries.push({ label: "blue piece", color: SCHEMATIC.blue });
  entries.push({ label: "red piece", color: SCHEMATIC.red });
  entries.push({ label: "transport (cargo)", color: SCHEMATIC.blue });
  return entries;
}

// ---- painting --------------------------------------------------------------

// The cells a purchase may stand on, painted over the board. `placement` is exactly what the server
// sent: {width, height, mask} with the mask a byte per cell. The page never re-derives the rule.
export function paintPlacement(ctx, placement, view, color = "rgba(120, 230, 255, 0.30)") {
  if (!placement || !placement.mask || !view) return 0;
  const bw = Number(placement.width) || 0;
  const bh = Number(placement.height) || 0;
  if (!bw || !bh) return 0;
  const cols = visibleColumns(view);
  const rows = visibleRows(view);
  if (view.boardW * view.scale <= view.viewW) {
    cols.first = 0;
    cols.last = view.boardW - 1;
  }
  ctx.fillStyle = color;
  let painted = 0;
  for (let y = rows.first; y <= rows.last; y++) {
    if (y < 0 || y >= bh) continue;
    for (let sx = cols.first; sx <= cols.last; sx++) {
      const x = wrapX(sx, view.boardW);
      if (!placement.mask[y * bw + x]) continue;
      ctx.fillRect(view.left + sx * view.scale, view.top + y * view.scale, view.scale, view.scale);
      painted += 1;
    }
  }
  return painted;
}

export function paintCells(ctx, board, view) {
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  if (!cells) return 0;
  const terrain = Array.isArray(board.terrain) ? board.terrain : [];
  const v = view;
  const cols = visibleColumns(v);
  const rows = visibleRows(v);
  // The board wraps in X, so a view wider than the board used to tile the whole world two or
  // three times across the screen. When the board fits, draw it once and leave the margins empty.
  if (v.boardW * v.scale <= v.viewW) {
    cols.first = 0;
    cols.last = v.boardW - 1;
  }
  let painted = 0;
  for (let y = rows.first; y <= rows.last; y++) {
    const row = y * v.boardW;
    for (let sx = cols.first; sx <= cols.last; sx++) {
      const color = colorForTerrain(terrain[cells[row + wrapX(sx, v.boardW)]]);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(v.left + sx * v.scale, v.top + y * v.scale, v.scale, v.scale);
      painted++;
    }
  }
  return painted;
}

// `opts.own` (a side name) outlines the seat's own pieces in white; enemy
// pieces get a dark outline. Nothing is drawn that the view did not send.
export function paintPiece(ctx, piece, view, opts = {}) {
  const at = cellToPixel(piece.x, piece.y, view);
  const r = Math.max(2, view.scale * 1.8);
  const shape = pieceShape(piece);

  // At map scale the marker is the original's: a three-cell block in the side's dark colour with a
  // light pixel in the middle. A transport keeps the block but loses the light centre, which is this
  // page's one deliberate addition — the original had no cargo concept to draw.
  if (view.scale < MARKER_ZOOM) {
    const size = Math.max(1, Math.ceil(view.scale));
    for (const cell of markerCells(piece.x, piece.y, piece.side, view.boardW || BOARD_W)) {
      const px = cellToPixel(cell.x, cell.y, view);
      ctx.fillStyle = cell.centre && piece.transport === true
        ? PIECE_MARKER.body[piece.side] || PIECE_MARKER.body.blue
        : cell.colour;
      ctx.fillRect(Math.floor(px.x - view.scale / 2), Math.floor(px.y - view.scale / 2), size, size);
    }
    return at;
  }
  // A typed unit gets its own silhouette once the board is zoomed. An untyped opening piece keeps
  // the original's generic block, because the archive never recorded what it was.
  const glyph = piece.transport === true ? null : glyphFor(piece.kind);
  if (glyph) {
    const size = Math.max(1, Math.ceil(view.scale));
    const ink = Boolean(opts.own) && String(piece.side) === String(opts.own) ? PIECE_INK.own : PIECE_INK.enemy;
    ctx.fillStyle = pieceColor(piece);
    for (const cell of glyphCells(piece.x, piece.y, piece.kind, view.boardW || BOARD_W)) {
      const px = cellToPixel(cell.x, cell.y, view);
      ctx.fillRect(Math.floor(px.x - view.scale / 2), Math.floor(px.y - view.scale / 2), size, size);
    }
    // One hairline around the shape so a dark hull on dark water still reads.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    for (const cell of glyphCells(piece.x, piece.y, piece.kind, view.boardW || BOARD_W)) {
      const px = cellToPixel(cell.x, cell.y, view);
      ctx.strokeRect(Math.floor(px.x - view.scale / 2) + 0.5, Math.floor(px.y - view.scale / 2) + 0.5, size - 1, size - 1);
    }
    return at;
  }

  ctx.fillStyle = pieceColor(piece);
  ctx.beginPath();
  if (shape === "ring") {
    // A transport is cargo: the hull is drawn as a ring, not a filled block, so an unescorted
    // crossing reads as the risk it is.
    ctx.lineWidth = Math.max(1.5, view.scale * 0.9);
    ctx.strokeStyle = pieceColor(piece);
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
    const ownRing = Boolean(opts.own) && String(piece.side) === String(opts.own);
    ctx.strokeStyle = ownRing ? PIECE_INK.own : PIECE_INK.enemy;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r + Math.max(1, view.scale * 0.5), 0, Math.PI * 2);
    ctx.stroke();
    return at;
  }
  if (shape === "circle") {
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  } else if (shape === "triangle") {
    ctx.moveTo(at.x, at.y - r);
    ctx.lineTo(at.x + r, at.y + r);
    ctx.lineTo(at.x - r, at.y + r);
    ctx.closePath();
  } else {
    ctx.rect(at.x - r, at.y - r, r * 2, r * 2);
  }
  ctx.fill();
  const own = Boolean(opts.own) && String(piece.side) === String(opts.own);
  ctx.strokeStyle = own ? PIECE_INK.own : PIECE_INK.enemy;
  ctx.lineWidth = own ? Math.max(1, view.scale * 0.8) : 1;
  ctx.stroke();
  return at;
}

export function paintPieces(ctx, pieces, view, opts = {}) {
  if (!Array.isArray(pieces)) return 0;
  let drawn = 0;
  for (const piece of pieces) {
    if (!piece || !Number.isFinite(Number(piece.x)) || !Number.isFinite(Number(piece.y))) continue;
    paintPiece(ctx, piece, view, opts);
    drawn++;
  }
  return drawn;
}

// City names on the board, once the camera is close enough to read them.
//
// The original kept place names in its panels, not on the map. These labels are this page's
// addition, drawn with the game's own lettering (FONTS.CHQ) so they belong to the picture, and only
// past LABEL_ZOOM pixels per cell, where a name is not clutter. A label is dropped when its city is
// off screen and clamped when it would run off an edge.
// Names are clutter at the whole-world fit: at four pixels a cell every city label overlaps its
// neighbour. Eight pixels per cell is the first scale at which a name is readable on its own.
export const LABEL_ZOOM = 8;

function labelBox(text, labelScale, at, view) {
  const width = String(text).length * 8 * labelScale;
  const height = 6 * labelScale;
  let x = at.x + Math.max(2, view.scale * 0.6);
  let y = at.y - height / 2;
  if (x + width > view.viewW - 2) x = at.x - width - 2;
  if (x < 2) x = 2;
  if (y < 2) y = 2;
  if (y + height > view.viewH - 2) y = view.viewH - height - 2;
  return { x, y, width, height };
}

export function visibleLabels(sites, view, opts = {}) {
  const list = Array.isArray(sites) ? sites : [];
  const out = [];
  if (!view || Number(view.scale) < LABEL_ZOOM) return out;
  const labelScale = Math.max(1, Math.floor(Number(view.scale) / LABEL_ZOOM));
  const seen = new Set();
  for (const site of list) {
    if (!site || !site.name) continue;
    const x = Number(site.x);
    const y = Number(site.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = x + ":" + y;
    if (seen.has(key)) continue;
    const at = cellToPixel(x, y, view);
    // Off screen: a label for a city the player cannot see is noise.
    if (at.x < -8 || at.x > view.viewW + 8 || at.y < -8 || at.y > view.viewH + 8) continue;
    seen.add(key);
    const box = labelBox(site.name, labelScale, at, view);
    if (box.width + 4 > view.viewW) continue;
    out.push({ text: String(site.name), x: box.x, y: box.y, width: box.width, height: box.height,
      scale: labelScale, cell: { x, y }, owner: site.owner || null });
  }
  return out;
}

// Draw the labels from the decoded FONTS.CHQ atlas. Nothing is drawn without an atlas: the page
// keeps the text in its board note instead of inventing a font.
export function paintLabels(ctx, atlas, labels, opts = {}) {
  if (!atlas || !Array.isArray(labels) || !labels.length) return 0;
  const ink = opts.ink || "#ffffff";
  const shadow = opts.shadow || "#000000";
  let drawn = 0;
  for (const label of labels) {
    const bitmap = textBitmap(atlas, label.text, label.scale);
    if (!bitmap.width || !bitmap.height) continue;
    for (let y = 0; y < bitmap.height; y++) {
      const row = bitmap.rows[y];
      for (let x = 0; x < bitmap.width; x++) {
        if (row[x] !== "1") continue;
        ctx.fillStyle = shadow;
        ctx.fillRect(label.x + x + 1, label.y + y + 1, 1, 1);
        ctx.fillStyle = ink;
        ctx.fillRect(label.x + x, label.y + y, 1, 1);
      }
    }
    drawn += 1;
  }
  return drawn;
}

// The other way the original showed the same earth: who holds what.
//
// OMAP.PIC is the political picture. Its fills, counted over the whole image: #5555ff (1742 px) and
// #aa0000 (1678 px) over a #55ffff sea, with #aaaaaa for ground nobody holds and black for the
// cities themselves. Those four are the measured colours; nothing here is picked.
//
// The regions the picture is drawn from are the weak link: CBR-REGN.DT0..DT4 are 184 integers per
// era and what a slot means is still undocumented (docs/re/TODO.md), so there is no honest way to
// colour a piece of ground by region. What the game does tell the seat is who owns each city, so the
// political view colours cities, not borders — the node's own fallback.
export const POLITICAL = Object.freeze({
  blue: "#5555ff",
  red: "#aa0000",
  neutral: "#aaaaaa",
  city: "#000000",
});

export function politicalInk(owner) {
  if (owner === "blue" || owner === "Blue") return POLITICAL.blue;
  if (owner === "red" || owner === "Red") return POLITICAL.red;
  return POLITICAL.neutral;
}

// One patch per city, at its own cell, in the colour of whoever holds it, with the city itself as a
// black dot in the middle the way the original drew towns on its map.
export function politicalSites(sites, view) {
  const list = Array.isArray(sites) ? sites : [];
  const out = [];
  for (const site of list) {
    const x = Number(site && site.x);
    const y = Number(site && site.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const at = cellToPixel(x, y, view);
    if (at.x < -view.scale || at.x > view.viewW + view.scale) continue;
    if (at.y < -view.scale || at.y > view.viewH + view.scale) continue;
    out.push({ x, y, ink: politicalInk(site.owner), at, name: site.name || null });
  }
  return out;
}

export function paintPolitical(ctx, patches, view) {
  const list = Array.isArray(patches) ? patches : [];
  const size = Math.max(1, Math.ceil(view.scale));
  for (const patch of list) {
    ctx.fillStyle = patch.ink;
    ctx.fillRect(Math.floor(patch.at.x - view.scale / 2), Math.floor(patch.at.y - view.scale / 2), size, size);
    if (view.scale >= 3) {
      ctx.fillStyle = POLITICAL.city;
      ctx.fillRect(Math.floor(patch.at.x), Math.floor(patch.at.y), Math.max(1, Math.floor(size / 3)),
        Math.max(1, Math.floor(size / 3)));
    }
  }
  return list.length;
}

// What the legend says, counted from the same patches the board draws.
export function politicalTally(patches) {
  const tally = { blue: 0, red: 0, neutral: 0 };
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (patch.ink === POLITICAL.blue) tally.blue += 1;
    else if (patch.ink === POLITICAL.red) tally.red += 1;
    else tally.neutral += 1;
  }
  return tally;
}

export function paintCapitals(ctx, markers, view) {
  const list = Array.isArray(markers) ? markers : [];
  const r = Math.max(3, view.scale * 2.4);
  ctx.font = `${Math.max(10, view.scale * 6)}px Palatino, Georgia, serif`;
  for (const marker of list) {
    const at = cellToPixel(marker.x, marker.y, view);
    ctx.strokeStyle = marker.color;
    ctx.lineWidth = Math.max(1, view.scale);
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = PIECE_INK.own;
    ctx.fillText(marker.name, at.x + r + 3, at.y - r - 2);
  }
  return list.length;
}

// The route a hovered order would take, drawn from the server's plan. `preview` is
// {from:{x,y}, to:{x,y}, path:[{x,y,pace}], rounds, error?}. A refusal draws the marker in
// the dark ink and no line; the sentence itself goes on the board note.
export const ROUTE_INK = "#ffd166";

export function paintPreview(ctx, preview, view, opts = {}) {
  if (!preview) return 0;
  const v = view;
  const path = Array.isArray(preview.path) ? preview.path : [];
  const to = preview.to || (path.length ? path[path.length - 1] : null);
  const ink = preview.error ? PIECE_INK.enemy : ROUTE_INK;
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, v.scale * 0.7);

  let started = false;
  ctx.beginPath();
  const from = preview.from;
  if (from && Number.isFinite(Number(from.x)) && Number.isFinite(Number(from.y))) {
    const at = cellToPixel(wrapX(from.x, v.boardW), Number(from.y), v);
    ctx.moveTo(at.x, at.y);
    started = true;
  }
  for (const step of path) {
    if (!step || !Number.isFinite(Number(step.x)) || !Number.isFinite(Number(step.y))) continue;
    const at = cellToPixel(wrapX(step.x, v.boardW), Number(step.y), v);
    if (!started) {
      ctx.moveTo(at.x, at.y);
      started = true;
    } else {
      ctx.lineTo(at.x, at.y);
    }
  }
  if (started) ctx.stroke();

  if (to && Number.isFinite(Number(to.x)) && Number.isFinite(Number(to.y))) {
    const at = cellToPixel(wrapX(to.x, v.boardW), Number(to.y), v);
    const r = Math.max(2, v.scale * 2);
    ctx.beginPath();
    ctx.rect(at.x - r, at.y - r, r * 2, r * 2);
    ctx.stroke();
  }
  return path.length;
}

// One line under the canvas. Says plainly when the extract is absent.
export function statusLine(board, room, result = {}) {
  if (result.mode === "schematic" || !result.mode) return EXTRACT_MISSING;
  const pieces = Array.isArray(room && room.pieces) ? room.pieces.length : 0;
  const round = Number(room && room.round);
  const clock = room && room.clock ? String(room.clock) : "held";
  const era = room && room.era ? String(room.era) : "";
  const tail = Number.isFinite(round) ? `round ${round} · clock ${clock}` : `clock ${clock}`;
  return `Cell grid from the map extract · ${pieces} piece${pieces === 1 ? "" : "s"} · ${era ? era + " · " : ""}${tail}`;
}

// Draws the whole match onto a 2d context: grid (or schematic), capitals, then
// the pieces the room view sent. Returns what it did so the page and the test
// can tell a real grid from the fallback.
export function paintMatch(ctx, board, room, opts = {}) {
  const view = opts.view || fitViewport(opts.availW, opts.availH, opts.boardW, opts.boardH);
  ctx.clearRect(0, 0, view.viewW, view.viewH);

  const schematic = !board || board.source === "missing" || !Array.isArray(board.cells);
  let mode = "cells";
  let painted = 0;

  let fogged = 0;
  if (!schematic) {
    painted = paintCells(ctx, board, view);
    if (painted === 0) mode = "schematic";
    else if (opts.fog) fogged = paintFog(ctx, view, opts.fog.lit, opts.fog.seen);
  } else {
    mode = "schematic";
  }

  if (mode === "schematic") {
    // The schematic painter draws at the origin, so this path stays unpanned.
    const flat = { ...view, left: 0, top: 0 };
    paintBoard(ctx, board || { width: view.boardW, height: view.boardH }, { scale: view.scale });
    const preview = paintPreview(ctx, opts.preview, flat, opts);
    const pieces = paintPieces(ctx, room && room.pieces, flat, opts);
    const capitals = paintCapitals(ctx, capitalMarkers(board), flat);
    return { mode, painted: 0, pieces, capitals, preview, message: EXTRACT_MISSING, view: flat };
  }

  if (opts.sightAt && Number(opts.sight) > 0) {
    paintSightRing(ctx, opts.sightAt, view, opts.sight, opts.ringColor);
  }
  const preview = paintPreview(ctx, opts.preview, view, opts);
  const pieces = paintPieces(ctx, room && room.pieces, view, opts);
  const capitals = paintCapitals(ctx, capitalMarkers(board), view);
  // Political view: the same board with each city coloured by whoever holds it. The terrain under it
  // is untouched, so switching back is switching back and nothing else.
  let political = 0;
  let tally = null;
  if (opts.viewMode === "political") {
    const patches = politicalSites(room && room.sites, view);
    political = paintPolitical(ctx, patches, view);
    tally = politicalTally(patches);
  }
  const labels = visibleLabels(room && room.sites, view);
  const labelled = paintLabels(ctx, opts.atlas, labels);
  return { mode, painted, fogged, pieces, capitals, labels: labelled, political, tally, preview, message: "", view };
}

// Re-exported so the page and the test read one name for the live table.
export { PALETTE, SCHEMATIC };
