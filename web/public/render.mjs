// Match drawing. Pure helpers over the /api/board payload and the room view the
// socket sends; no DOM at import time, so the node harness can drive every
// function with a recording 2d context.
//
// Everything drawn here is derived from cell ids and piece positions: no image
// bytes, no original art, no fetch. Colors come from paint.mjs where they exist
// so the grid and the schematic keep one palette.

import { colorForTerrain, paintBoard, PALETTE, SCHEMATIC, EXTRACT_MISSING } from "./paint.mjs";

export const BOARD_W = 320;
export const BOARD_H = 136;

// Outlines only: a piece's fill is its side color.
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

const LEGEND_TERRAIN = Object.freeze(["ocean", "shallows", "city", "capital"]);

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

const FOG_REMEMBERED = "rgba(6, 12, 22, 0.45)";
const FOG_UNKNOWN = "rgba(4, 8, 15, 0.82)";

export function paintFog(ctx, view, lit, seen) {
  if (!lit || lit.length === 0) return 0;
  const cols = visibleColumns(view);
  const rows = visibleRows(view);
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
export const MIN_ZOOM = 2;
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

export function paintCells(ctx, board, view) {
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  if (!cells) return 0;
  const terrain = Array.isArray(board.terrain) ? board.terrain : [];
  const v = view;
  const cols = visibleColumns(v);
  const rows = visibleRows(v);
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
  return { mode, painted, fogged, pieces, capitals, preview, message: "", view };
}

// Re-exported so the page and the test read one name for the live table.
export { PALETTE, SCHEMATIC };
