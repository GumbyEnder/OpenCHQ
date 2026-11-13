// Match drawing. Pure helpers over the /api/board payload and the room view the
// socket sends; no DOM at import time, so the node harness can drive every
// function with a recording 2d context.
//
// Everything drawn here is derived from cell ids and piece positions: no image
// bytes, no original art, no fetch. Colors come from paint.mjs where they exist
// so the grid and the schematic keep one palette.

import { colorForTerrain, paintBoard, PALETTE, SCHEMATIC, EXTRACT_MISSING } from "./paint.mjs";
import { textBitmap } from "./font.mjs";
import {
  BADGE_INTERIOR, BADGE_MIN_PX, BADGE_SIDE, BADGE_UNIT, badgeForPiece, badgeGroups,
  badgePx, badgeState, framePolygon, insetPolygon, selectedRing, showsEntrench, strengthBand,
} from "./badges.mjs";

export const BOARD_W = 320;
export const BOARD_H = 136;

// Outlines only: a piece's fill is its side color.
//
// What the original drew for a unit on the map, and what this page draws now, are two different
// answers (T-014):
//
// The original (docs/chq-reference/chq_0021.png, a 640x400 capture of the 320x200 screen) drew every
// unit as the same 6x6 screen-pixel / 3x3 cell block in the side's dark colour with one light centre
// pixel. Types were told apart in its panels, never on the map. That measurement is kept here as the
// record of the fidelity target, not as a fallback: the block is exactly the "dotted clusters at
// full-map zoom" that T-014 exists to remove.
export const PIECE_MARKER = Object.freeze({
  size: 3,
  body: Object.freeze({ blue: "#0000aa", red: "#aa0000" }),
  centre: "#ffffff",
});

// The nine cells of a marker, with the centre one carrying the light pixel. X wraps, so a unit in
// the seam column draws three cells, not two. Nothing paints this any more; it stays because it is
// the measured description of the original's board and the seam rule it proves is still the rule.
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

// A capital nobody holds draws in ink, not in a side's colour: the original lets a neutral capital
// block both sides, and painting it blue or red would claim a holder that does not exist.
export const CAPITAL_NEUTRAL = "#cfcfcf";

// The capitals the page must label. The room is the authority: the match's site records carry the
// era's own capital rows (type 1/2, with the owner the win check reads), so 1918 labels London,
// Berlin and Paris - never the two fixed seats. The board payload's capitals are fixed seats with
// no era in them, so they are the fallback for a page with no room yet (PB-022).
export function capitalMarkers(board, room) {
  const sites = Array.isArray(room && room.sites) ? room.sites : [];
  const era = sites.filter((site) => site && (Number(site.type) === 1 || Number(site.type) === 2));
  if (era.length) {
    return era.map((site) => ({
      side: site.owner === "red" ? "red" : site.owner === "blue" ? "blue" : null,
      name: String(site.name),
      x: Number(site.x),
      y: Number(site.y),
      color: site.owner === "red" || site.owner === "blue" ? sideColor(site.owner) : CAPITAL_NEUTRAL,
    }));
  }
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
export function paintPlacement(ctx, placement, view, color = "rgba(120, 235, 255, 0.62)", unreadyColor = "rgba(255, 186, 92, 0.62)") {
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
  let painted = 0;
  for (let y = rows.first; y <= rows.last; y++) {
    if (y < 0 || y >= bh) continue;
    for (let sx = cols.first; sx <= cols.last; sx++) {
      const x = wrapX(sx, view.boardW);
      const value = placement.mask[y * bw + x];
      if (!value) continue;
      // 1 is a ready city or base; 2 is the same site while it is unready. Two colours, because
      // "where may I place" and "where may I place right now" are different questions (T-011 AC3).
      ctx.fillStyle = value === 2 ? unreadyColor : color;
      // At the whole-world fit a cell is one pixel. Draw it at least one full pixel and at a
      // strength a player can see; a 30%-alpha single pixel read as "no highlights at all".
      const size = Math.max(1, Math.round(view.scale));
      ctx.fillRect(view.left + sx * view.scale, view.top + y * view.scale, size, size);
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

// ---- unit badges (T-014) --------------------------------------------------------------------
//
// One badge per footprint, drawn from the primitives in badges.mjs. The painter is written against
// the six canvas calls the node harness can record (beginPath, moveTo, lineTo, closePath, rect, arc,
// fill, stroke, fillRect, fillText), so the shape a test sees is the shape the browser draws.

// A polygon in badge units, mapped onto the canvas.
function polygonPath(ctx, points, x0, y0, k) {
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x0 + x * k, y0 + y * k);
    else ctx.lineTo(x0 + x * k, y0 + y * k);
  });
  ctx.closePath();
}

// An ellipse as a sixteen-sided polygon: the recording context has no ellipse(), and at 14 px a
// chorded ellipse and a smooth one are the same six pixels.
function ellipsePath(ctx, cx, cy, rx, ry, x0, y0, k) {
  ctx.beginPath();
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = x0 + (cx + Math.cos(angle) * rx) * k;
    const y = y0 + (cy + Math.sin(angle) * ry) * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function shapePath(ctx, shape, x0, y0, k) {
  if (shape.t === "rect") {
    ctx.beginPath();
    ctx.rect(x0 + shape.x * k, y0 + shape.y * k, shape.w * k, shape.h * k);
    return;
  }
  if (shape.t === "circle") {
    ctx.beginPath();
    ctx.arc(x0 + shape.cx * k, y0 + shape.cy * k, shape.r * k, 0, Math.PI * 2);
    return;
  }
  if (shape.t === "ellipse") {
    ellipsePath(ctx, shape.cx, shape.cy, shape.rx, shape.ry, x0, y0, k);
    return;
  }
  if (shape.t === "poly") {
    polygonPath(ctx, shape.pts, x0, y0, k);
    return;
  }
  // A line: its own path, stroked by the caller's style.
  ctx.beginPath();
  ctx.moveTo(x0 + shape.x1 * k, y0 + shape.y1 * k);
  ctx.lineTo(x0 + shape.x2 * k, y0 + shape.y2 * k);
}

// The static part of a badge: frame, interior, silhouette. This is the expensive half (a polygon
// fill, an inset fill and four to six silhouette marks), and it is the same drawing for every piece
// of a kind at a given pixel size - so the page paints it once per (kind, side, size) into an
// offscreen canvas and blits it. The chrome below (bars, ring, dashes, burst, disc) changes per
// piece and stays per-frame. A caller with no offscreen canvas - the node harness - passes no cache
// and gets this path painter, which is the same geometry the sprite was made from.
function paintBadgeBody(ctx, x0, y0, k, side, spec, interior) {
  const palette = BADGE_SIDE[side];
  const frame = framePolygon(side);
  polygonPath(ctx, frame, x0, y0, k);
  ctx.fillStyle = palette.frame;
  ctx.fill();
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = Math.max(1, k * 0.9);
  ctx.stroke();

  polygonPath(ctx, insetPolygon(frame, 0.9), x0, y0, k);
  ctx.fillStyle = interior;
  ctx.fill();

  for (const shape of spec.silhouette) {
    if (shape.t === "line") {
      ctx.beginPath();
      ctx.moveTo(x0 + shape.x1 * k, y0 + shape.y1 * k);
      ctx.lineTo(x0 + shape.x2 * k, y0 + shape.y2 * k);
      ctx.strokeStyle = palette.dark;
      ctx.lineWidth = Math.max(1, shape.w * k);
      ctx.stroke();
      continue;
    }
    shapePath(ctx, shape, x0, y0, k);
    ctx.fillStyle = shape.invert ? interior : palette.dark;
    if (shape.strokeOnly) {
      ctx.strokeStyle = palette.dark;
      ctx.lineWidth = Math.max(1, k * 1.5);
      ctx.stroke();
    } else {
      ctx.fill();
    }
  }
}

/**
 * Paint one badge's static half into its own canvas, for the sprite cache. `size` is the badge's
 * width in the destination's pixels; the sprite is square and the geometry is the badge's own.
 */
export function renderBadgeSprite(ctx, { kind = "infantry", side = "blue", transport = false, size = 14 } = {}) {
  const px = Math.max(1, Number(size) || 14);
  const k = px / BADGE_UNIT;
  const spec = badgeForPiece({ kind, side: side === "red" ? "red" : "blue",
    transport, domain: transport ? "sea" : undefined,
    atSea: transport === true });
  paintBadgeBody(ctx, 0, 0, k, side === "red" ? "red" : "blue", spec,
    BADGE_INTERIOR[spec.domain] || BADGE_INTERIOR.land);
  return px;
}

// One badge on the board. `group` is what badgeGroups() returned: a footprint with a face piece and
// however many friendly pieces sit inside it.
//
// The strength bar, the dug-in bar, the selected ring, the movement dashes, the combat burst and the
// stack disc all live here, because they are the badge's chrome: drawing them anywhere else is how
// two parts of the page end up disagreeing about where a unit's bar sits.
export function paintBadge(ctx, group, view, opts = {}) {
  if (!group || !group.top || !view) return null;
  const piece = group.top;
  const scale = Math.max(1, Number(view.scale) || 1);
  const floor = Number(opts.badgeMinPx) || BADGE_MIN_PX;
  const size = badgePx(scale, floor);
  const k = size / BADGE_UNIT;
  const at = cellToPixel(wrapX(group.x, view.boardW || BOARD_W), group.y, view);
  const x0 = at.x - size / 2;
  const y0 = at.y - size / 2;

  const side = group.side === "red" ? "red" : "blue";
  const spec = badgeForPiece(piece);
  const interior = BADGE_INTERIOR[spec.domain] || BADGE_INTERIOR.land;

  // The static half: one blit when the page handed us a sprite cache, the same geometry drawn as
  // paths when it did not (the node harness, and the mockup sheet's own large renders).
  const sprites = opts.badgeSprites;
  const sprite = sprites && typeof sprites.get === "function"
    ? sprites.get(spec.kind, side, size, spec.shapeKind === "transport")
    : null;
  if (sprite) {
    ctx.drawImage(sprite, x0, y0, size, size);
  } else {
    paintBadgeBody(ctx, x0, y0, k, side, spec, interior);
  }

  // Dug in: a green bar above the badge, and only on the kinds the runtime can entrench.
  if (showsEntrench(piece)) {
    ctx.fillStyle = "#1f7a3a";
    ctx.fillRect(x0 + 5 * k, y0 + 0.4 * k, 14 * k, 2 * k);
  }

  // The strength bar below: green, amber, red as it recedes, exactly the fraction the server sent.
  const band = strengthBand(piece.strength, piece.maxStrength);
  if (band) {
    const barY = y0 + (showsEntrench(piece) ? 24.4 : 22.4) * k;
    ctx.fillStyle = "#2a2f3a";
    ctx.fillRect(x0 + 5 * k, barY, 14 * k, 2.2 * k);
    ctx.fillStyle = band.colour;
    ctx.fillRect(x0 + 5 * k, barY, 14 * k * band.fraction, 2.2 * k);
  }

  // The states, drawn around the silhouette and never over it.
  const state = badgeState(piece, opts);
  if (state === "moving") {
    ctx.strokeStyle = "#8fd3ff";
    ctx.lineWidth = Math.max(1, k * 1.4);
    const dash = [[20.6, 4.6, 23.2, 2.0], [20.6, 9.2, 23.8, 6.0], [15.8, 1.8, 18.8, 1.8]];
    for (const [x1, y1, x2, y2] of dash) {
      ctx.beginPath();
      ctx.moveTo(x0 + x1 * k, y0 + y1 * k);
      ctx.lineTo(x0 + x2 * k, y0 + y2 * k);
      ctx.stroke();
    }
  }
  if (state === "combat") {
    polygonPath(ctx, [[18.4, 1.0], [20.2, 4.6], [23.8, 6.4], [20.2, 8.2], [18.4, 11.8],
      [16.6, 8.2], [13.0, 6.4], [16.6, 4.6]], x0, y0, k);
    ctx.fillStyle = "#ffd43b";
    ctx.fill();
    ctx.strokeStyle = "#7a4d00";
    ctx.lineWidth = Math.max(1, k * 0.6);
    ctx.stroke();
  }
  if (state === "selected") {
    polygonPath(ctx, selectedRing(side), x0, y0, k);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, k * 1.6);
    ctx.stroke();
  }

  // Pinned and repairing (T-003's states, kept): an orange tick and a pale cross beside the bar.
  const barY = y0 + (showsEntrench(piece) ? 24.4 : 22.4) * k;
  if (piece.pinned === true) {
    ctx.fillStyle = "#ff9d4c";
    ctx.fillRect(x0 + 19.4 * k, barY - 1.4 * k, Math.max(2, 3 * k), Math.max(1, 1.6 * k));
  }
  if (piece.repairing === true) {
    ctx.strokeStyle = "#e8f0d0";
    ctx.lineWidth = Math.max(1, k * 0.8);
    ctx.beginPath();
    ctx.moveTo(x0 + 20.4 * k, barY - k);
    ctx.lineTo(x0 + 20.4 * k, barY + 3.2 * k);
    ctx.moveTo(x0 + 19.2 * k, barY + 1.1 * k);
    ctx.lineTo(x0 + 21.6 * k, barY + 1.1 * k);
    ctx.stroke();
  }
  // Facing: a one-unit notch on the side the piece last stepped.
  if (piece.facing) {
    const nx = piece.facing === "e" ? 21.6 : piece.facing === "w" ? 2.4 : 12;
    const ny = piece.facing === "s" ? 21.6 : piece.facing === "n" ? 2.4 : 12;
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fillRect(x0 + nx * k, y0 + ny * k, Math.max(1, 1.6 * k), Math.max(1, 1.6 * k));
  }

  // A stack: one disc, bottom-right, with the count. Above nine it says 9+, because a legible number
  // matters more than the exact one, and the whole stack is named on hover.
  if (Number(group.count) > 1) {
    const cx = x0 + 19.4 * k;
    const cy = y0 + 19.4 * k;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.3 * k, 0, Math.PI * 2);
    ctx.fillStyle = "#101623";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, k * 0.8);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = Math.max(7, Math.round(6.2 * k)) + "px ui-monospace,monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(Number(group.count) > 9 ? "9+" : String(Number(group.count)), cx, cy + 0.3 * k);
  }

  return { x: x0, y: y0, size, side, kind: spec.kind, count: Number(group.count) || 1 };
}

// One piece's badge, for callers that have a single piece and no grouping to do.
export function paintPiece(ctx, piece, view, opts = {}) {
  if (!piece || !Number.isFinite(Number(piece.x)) || !Number.isFinite(Number(piece.y))) return null;
  const groups = badgeGroups([piece], Math.max(1, Number(view && view.scale) || 1),
    Number(opts.badgeMinPx) || BADGE_MIN_PX);
  return paintBadge(ctx, groups[0], view, opts);
}

// Every piece the view sent, one badge per footprint. Returns the groups, so the caller can report
// how many pieces it drew without re-grouping.
export function paintPieces(ctx, pieces, view, opts = {}) {
  if (!Array.isArray(pieces) || !view) return [];
  // One size floor, from the page's device pixel ratio: the PM's 14 px is a screen size, and the
  // canvas draws in device pixels.
  const floor = Number(opts.badgeMinPx) || BADGE_MIN_PX;
  const groups = opts.groups || badgeGroups(pieces, Math.max(1, Number(view.scale) || 1), floor);
  for (const group of groups) paintBadge(ctx, group, view, opts);
  return groups;
}

// The cell a badge covers, as a footprint: the badge's own width in cells, centred.
export function badgeFootprint(group, view, opts = {}) {
  if (!group) return null;
  const scale = Math.max(1, Number(view.scale) || 1);
  const cells = badgePx(scale, Number(opts.badgeMinPx) || BADGE_MIN_PX) / scale;
  const half = cells / 2;
  return {
    x0: Number(group.x) - half, x1: Number(group.x) + half,
    y0: Number(group.y) - half, y1: Number(group.y) + half,
  };
}

// The site a player can still see under a badge. A badge is at least 14 px, so a garrison standing
// on a city paints over the city's cell; the city has to stay visible on the board anyway (PB-029,
// T-014 AC7). Only the sites a badge actually covers are re-stamped, and only at the one cell the
// terrain gave them, so nothing is added to a city nobody is standing on.
//
// A filled cell in the city's own ink does not do that job: the ink is #000000 and the badge face is
// a dark silhouette on a light interior, so a full-cell black square reads as part of the icon and the
// city disappears into the badge it was supposed to stay visible under (measured: 59 black pixels in
// a 14x14 box on a garrisoned city against 28 on open ground, centre pixel black vs the strength
// bar's green). The site is therefore a corner notch with a light rim: the city keeps its ink at the
// badge's lower-left, where the stack disc (lower-right) and the strength bar (below the silhouette)
// never sit, and the silhouette keeps the centre.
export function paintSiteTicks(ctx, sites, groups, view) {
  const list = Array.isArray(sites) ? sites : [];
  const covered = Array.isArray(groups) ? groups.map((group) => badgeFootprint(group, view)) : [];
  if (!covered.length) return 0;
  let drawn = 0;
  for (const site of list) {
    const x = Number(site && site.x);
    const y = Number(site && site.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const box = covered.find((b) => x >= b.x0 - 0.5 && x <= b.x1 + 0.5 && y >= b.y0 - 0.5 && y <= b.y1 + 0.5);
    if (!box) continue;
    // A capital keeps the capital ink, a city the city ink: the same two colours the terrain uses.
    const ink = (Number(site.type) === 1 || Number(site.type) === 2) ? PALETTE.capital : PALETTE.city;
    if (!ink) continue;
    const topLeft = cellToPixel(wrapX(box.x0, view.boardW || BOARD_W), box.y0, view);
    const bottomRight = cellToPixel(wrapX(box.x1, view.boardW || BOARD_W), box.y1, view);
    const span = Math.max(3, Math.round(bottomRight.x - topLeft.x));
    const side = Math.max(2, Math.round(span * 0.34));
    const nx = Math.round(topLeft.x) + 1;
    const ny = Math.round(bottomRight.y) - side - 1;
    ctx.fillStyle = BADGE_INTERIOR.land;
    ctx.fillRect(nx - 1, ny - 1, side + 2, side + 2);
    ctx.fillStyle = ink;
    ctx.fillRect(nx, ny, side, side);
    drawn++;
  }
  return drawn;
}

// Which badge is under a pointer, for hover: type and strength have to be readable without a click.
// The groups are the same ones the frame drew, so what the tooltip names is what the player sees.
export function badgeAt(pieces, view, px, py, opts = {}) {
  const groups = opts.groups || badgeGroups(pieces, Math.max(1, Number(view.scale) || 1),
    Number(opts.badgeMinPx) || BADGE_MIN_PX);
  let hit = null;
  let best = Infinity;
  for (const group of groups) {
    const at = cellToPixel(wrapX(group.x, view.boardW || BOARD_W), group.y, view);
    const half = badgePx(Math.max(1, Number(view.scale) || 1), Number(opts.badgeMinPx) || BADGE_MIN_PX) / 2;
    const dx = Math.abs(Number(px) - at.x);
    const dy = Math.abs(Number(py) - at.y);
    if (dx > half || dy > half) continue;
    const distance = dx + dy;
    if (distance < best) {
      best = distance;
      hit = group;
    }
  }
  return hit;
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
  // Two passes: a dark casing under a bright line. At the whole-world fit a one-pixel hairline in
  // gold over pale terrain read as nothing at all (T-007 AC10), and the route a player is about to
  // send is the one thing on the map that must be legible.
  const width = Math.max(2, v.scale * 1.1);

  let started = false;
  const trace = () => {
    started = false;
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
  };

  // The casing first, then the bright line over it.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
  ctx.lineWidth = width + 2;
  trace();
  ctx.strokeStyle = ink;
  ctx.lineWidth = width;
  trace();

  if (to && Number.isFinite(Number(to.x)) && Number.isFinite(Number(to.y))) {
    // The end marker: a filled diamond on a dark ring, so "this is where the order lands" is not a
    // hairline square nobody can see.
    const at = cellToPixel(wrapX(to.x, v.boardW), Number(to.y), v);
    const r = Math.max(3, v.scale * 1.6);
    ctx.beginPath();
    ctx.moveTo(at.x, at.y - r);
    ctx.lineTo(at.x + r, at.y);
    ctx.lineTo(at.x, at.y + r);
    ctx.lineTo(at.x - r, at.y);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.lineWidth = Math.max(1, width * 0.5);
    ctx.strokeStyle = "#0b0f14";
    ctx.stroke();
  }
  return path.length;
}

// One line under the canvas. Says plainly when the extract is absent.
//
// The count is what the seat can see, split into its own and the other side's (PM, room 3946: the
// footer used to say "43 pieces" on a board holding 60, because the view sends the seat's own units
// plus the enemy units in sight and nothing else). A "60 on board" figure is not in the payload on
// purpose - the server does not send a count of pieces a seat cannot see - so the line names the
// two numbers it honestly has instead of inventing the third.
export function pieceCounts(room) {
  const pieces = Array.isArray(room && room.pieces) ? room.pieces : [];
  const you = room && room.you ? String(room.you) : "";
  let own = 0;
  for (const piece of pieces) if (you && String(piece && piece.side) === you) own += 1;
  return { inSight: pieces.length, own, enemy: pieces.length - own };
}

export function statusLine(board, room, result = {}) {
  if (result.mode === "schematic" || !result.mode) return EXTRACT_MISSING;
  const counts = pieceCounts(room);
  const round = Number(room && room.round);
  const clock = room && room.clock ? String(room.clock) : "held";
  const era = room && room.era ? String(room.era) : "";
  const tail = Number.isFinite(round) ? `round ${round} · clock ${clock}` : `clock ${clock}`;
  const seen = counts.inSight === 1 ? "1 piece in sight" : `${counts.inSight} pieces in sight`;
  return `Cell grid from the map extract · ${seen} · ${counts.own} yours · ${counts.enemy} the other side · ${era ? era + " · " : ""}${tail}`;
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
    const groups = paintPieces(ctx, room && room.pieces, flat, opts);
    const pieces = Array.isArray(room && room.pieces) ? room.pieces.length : 0;
    const capitals = paintCapitals(ctx, capitalMarkers(board, room), flat);
    return { mode, painted: 0, pieces, groups: groups.length, capitals, preview, message: EXTRACT_MISSING, view: flat };
  }

  if (opts.sightAt && Number(opts.sight) > 0) {
    paintSightRing(ctx, opts.sightAt, view, opts.sight, opts.ringColor);
  }
  const preview = paintPreview(ctx, opts.preview, view, opts);
  const groups = paintPieces(ctx, room && room.pieces, view, opts);
  const pieces = Array.isArray(room && room.pieces) ? room.pieces.length : 0;
  // A badge is never smaller than its floor, so one can cover the city square it stands on. The
  // sites under badges get their own cell tick back after the pieces are painted: the city has to
  // stay visible on the board even when a garrison is standing on it (PB-029, T-014 AC7).
  const siteTicks = paintSiteTicks(ctx, room && room.sites, groups, view);
  const capitals = paintCapitals(ctx, capitalMarkers(board, room), view);
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
  return { mode, painted, fogged, pieces, groups: groups.length, siteTicks, capitals, labels: labelled,
    political, tally, preview, message: "", view };
}

// Re-exported so the page and the test read one name for the live table.
export { PALETTE, SCHEMATIC };
