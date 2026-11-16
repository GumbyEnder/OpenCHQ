// Match drawing. Pure helpers over the /api/board payload and the room view the
// socket sends; no DOM at import time, so the node harness can drive every
// function with a recording 2d context.
//
// Everything drawn here is derived from cell ids and piece positions: no image
// bytes, no original art, no fetch. Colors come from paint.mjs where they exist
// so the grid and the schematic keep one palette.

import { colorForTerrain, paintBoard, PALETTE, SCHEMATIC, EXTRACT_MISSING } from "./paint.mjs";
import { DEFAULT_THEME, terrainInk, themeById } from "./themes.mjs";
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

// ---- the sight gate (PB-082) -----------------------------------------------------------------
//
// Every marker layer is painted AFTER paintFog: the wash is already on the canvas, so a capital
// ring, a city tick or a name drawn on top of it reads at full brightness over ground the seat has
// never seen. Era 9999 is the era that promises the opposite, so those three layers ask this table
// first. Remembered ground still gets its marker, at the remembered level, which is the same rule
// the ground under it follows.
//
// Coordinates follow paintFog's own convention, not a second one: X wraps at the seam via wrapX,
// Y does not wrap, and a row outside 0..boardH-1 is not on the board and reads as unknown. The
// gate and the wash therefore index the same cell for the same pixel; PB-074 (the sighted block
// wrapping at the map edge) is a question about the sight table itself and is not re-encoded here.
export const SIGHT_LIT = 2;
export const SIGHT_REMEMBERED = 1;
export const SIGHT_UNKNOWN = 0;

// 0 = unknown, 1 = remembered, 2 = in sight. `null` when the frame carries no fog at all (every era
// but 9999), so the callers stay exactly as they were: a null gate draws everything.
export function sightGate(fog, view) {
  if (!fog || !fog.lit || fog.lit.length === 0) return null;
  const width = Math.max(1, Math.floor(Number(view && view.boardW) || BOARD_W));
  const height = Math.max(0, Math.floor(Number(view && view.boardH) || BOARD_H));
  const lit = fog.lit;
  const seen = fog.seen && fog.seen.length === lit.length ? fog.seen : null;
  return (x, y) => {
    const fx = Number(x);
    const fy = Number(y);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return SIGHT_LIT;
    const py = Math.round(fy);
    if (py < 0 || (height && py >= height)) return SIGHT_UNKNOWN;
    const index = py * width + wrapX(Math.round(fx), width);
    if (lit[index]) return SIGHT_LIT;
    return seen && seen[index] ? SIGHT_REMEMBERED : SIGHT_UNKNOWN;
  };
}

// How much of a remembered marker survives the fog. The ground under it is drawn at FOG_REMEMBERED
// (0.28), so a marker that is a memory sits behind the same haze rather than in front of it.
export const REMEMBERED_MARKER_ALPHA = 0.45;

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

// `floor` is the lowest zoom this camera may take. The page passes the whole-world fit, because a
// camera that will not go below what fits cannot leave the map small in a field of black (PB-067)
// and cannot strand the '+' key at a floor it is already on (PB-066). Without a floor the camera
// keeps the old one-pixel minimum, which is what the tests of the fit itself measure.
export function clampZoom(scale, floor = MIN_ZOOM) {
  const low = Math.max(MIN_ZOOM, Math.round(Number(floor) || MIN_ZOOM));
  const zoom = Math.round(Number(scale) || low);
  return Math.max(low, Math.min(MAX_ZOOM, zoom));
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

// Re-anchor a camera at a new scale so the world point under (screenX, screenY) stays there.
function reanchor(view, next, screenX, screenY) {
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

// A discrete key press is ONE whole cell of zoom, not a factor that may round back onto the scale
// it started from. A 1.4x factor off a one-pixel cell rounds to one pixel, which is how '+' became a
// dead key at the fit (PB-066); a fallback that only fires when the factor happens to round the same
// is still a clamp, not a step. `direction` is +1 for '+' and -1 for '-'; a press at the floor or
// the ceiling is a hold, never a jump. The factor path (zoomAt) stays for the wheel, where a
// proportional step is what the player asked for.
export function zoomStepBy(view, direction, screenX, screenY) {
  const dir = Math.sign(Number(direction) || 0);
  if (!dir) return view;
  const next = clampZoom(view.scale + dir, view.minScale);
  if (next === view.scale) return view;
  return reanchor(view, next, screenX, screenY);
}

// Zoom about a screen point, so the cell under the cursor stays under the cursor.
export function zoomAt(view, factor, screenX, screenY) {
  const f = Number(factor || 1);
  let next = clampZoom(view.scale * f, view.minScale);
  // A 1.4x step off a one-pixel cell rounds back to the same pixel, which is how '+' became a dead
  // key at the minimum zoom (PB-066). A step that would not move the zoom moves it one whole pixel
  // in the direction asked for, or stays put at the floor.
  if (next === view.scale && f !== 1) {
    const floor = Math.max(MIN_ZOOM, Math.round(Number(view.minScale) || MIN_ZOOM));
    // Only the zoom-IN step can round back onto the current scale: a 0.7 step from 2 px already
    // rounds to 1, so a symmetric "minus one pixel" arm would be dead code (measured: mutating it
    // changed no result). A step out at or below the fit falls through to `clampZoom`, which holds
    // the floor.
    if (f > 1) next = clampZoom(view.scale + 1, floor);
  }
  if (next === view.scale) return view;
  return reanchor(view, next, screenX, screenY);
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
  // Rolled and concealed eras carry no type-1/2 capital rows, so the set falls through to a
  // capitals map. Which map matters: `room.capitals` is what forSeat sent, and it OMITS a
  // capital the seat may not see (era 9999 hides the enemy's until it has been found), while
  // `board.capitals` is the unfiltered board payload every seat gets. Reading the board here
  // drew the enemy capital's ring and name outside sight (PB-073). A view that carries a
  // capitals map is therefore authoritative - an absent side is withheld, not missing - and the
  // board (then the fixed seats) is only for a page that has no view yet.
  const seated = Boolean(room && room.capitals && typeof room.capitals === "object");
  const source = seated ? room.capitals : ((board && board.capitals) || {});
  const out = [];
  for (const side of ["blue", "red"]) {
    const seat = CAPITAL_SEATS[side];
    const found = source[side] || {};
    const x = Number(found.x);
    const y = Number(found.y);
    const known = Number.isFinite(x) && Number.isFinite(y);
    // A seat view that does not name this capital has withheld it. Do not invent one.
    if (seated && !known) continue;
    out.push({
      side,
      name: String(found.name || seat.name),
      x: known ? x : seat.x,
      y: known ? y : seat.y,
      color: sideColor(side),
    });
  }
  return out;
}

// The map's key, in the inks that are actually on the board.
//
// PB-063: in Show Ownership the legend went on naming terrain and never said what blue, red and
// white meant, so the one view whose whole subject is ownership had no key for it. The ownership
// rows are appended in that view, from the theme's own fills (no second copy of the colours), and
// the terrain rows stay because terrain is still what the cities sit on.
export function legendEntries(theme, opts = {}) {
  const t = theme || themeById("D");
  const inks = t.schematic || SCHEMATIC;
  const entries = LEGEND_TERRAIN.map((name) => ({ label: name, color: terrainInk(t, name) }))
    .filter((entry) => entry.color);
  if (opts.viewMode === "political") {
    const palette = t.ownership || themeById("D").ownership;
    entries.push({ label: "blue held", color: palette.blue });
    entries.push({ label: "red held", color: palette.red });
    entries.push({ label: "neutral ground", color: palette.neutral });
    entries.push({ label: "national border", color: palette.edge.blue });
  }
  entries.push({ label: "blue piece", color: inks.blue });
  entries.push({ label: "red piece", color: inks.red });
  entries.push({ label: "transport (cargo)", color: inks.blue });
  return entries;
}

// ---- painting --------------------------------------------------------------

// The coloured box the original draws around a city (manual printed p.14: green = ready, yellow =
// soon, red = a long wait). At a 1-pixel-per-cell fit a single tinted cell is not a target a hand
// can hit or an eye can find, so every legal site gets a box of at least PLACEMENT_BOX_PX screen
// pixels around its cell, at every zoom, in both readiness colours. The casing is drawn first and
// wider, so the box reads over a black city square as well as over water (PB-029).
export const PLACEMENT_BOX_PX = 10;
export const PLACEMENT_BOX = {
  ready: "rgba(140, 245, 255, 0.95)",
  unready: "rgba(255, 196, 96, 0.95)",
  casing: "rgba(6, 10, 18, 0.9)",
};

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
  const boxes = [];
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
      boxes.push({
        cx: view.left + (sx + 0.5) * view.scale,
        cy: view.top + (y + 0.5) * view.scale,
        value,
      });
      painted += 1;
    }
  }
  // The box, in two passes: one dark casing under every box, then one bright outline. Painting
  // casing+bright per site would let a neighbour's casing eat this site's outline where two
  // friendly sites are adjacent.
  // PB-045: the box used to be a fixed 10 px whatever the cell was, so zoomed in it was a small
  // square lost inside a big city cell instead of an outline around the whole site. It is now the
  // larger of the floor, the server's configured size and one whole cell, so the target the player
  // sees is the cell the server will accept.
  const boxPx = Number(placement.box && placement.box.px);
  const side = Math.max(PLACEMENT_BOX_PX, Number.isFinite(boxPx) ? boxPx : 0, Math.round(view.scale));
  if (boxes.length && typeof ctx.strokeRect === "function") {
    ctx.lineWidth = 3;
    ctx.strokeStyle = PLACEMENT_BOX.casing;
    for (const box of boxes) ctx.strokeRect(box.cx - side / 2, box.cy - side / 2, side, side);
    ctx.lineWidth = 1.5;
    for (const box of boxes) {
      ctx.strokeStyle = box.value === 2 ? PLACEMENT_BOX.unready : PLACEMENT_BOX.ready;
      ctx.strokeRect(box.cx - side / 2, box.cy - side / 2, side, side);
    }
  }
  return painted;
}

// The terrain layer of one theme. `opts.theme` is a table from themes.mjs; without it the painter
// keeps the original's measured hues, which is also what the Classic theme ships.
//
// A theme that sets `coast` gets a bright edge on the land side of every land/water boundary. It is
// drawn per visible cell, after that cell's fill, so it costs nothing on an ocean row and cannot
// move a cell: the edge is painted inside a cell that was already being painted.
export function paintCells(ctx, board, view, opts = {}) {
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  if (!cells) return 0;
  const terrain = Array.isArray(board.terrain) ? board.terrain : [];
  // The painter's own default is the Classic table: a caller that never mentions a theme keeps the
  // measured original hues, which is what every pin written before T-019 reads. The page always
  // passes its theme, and the page's first-load default is the dark one.
  const theme = opts.theme || themeById("D");
  const table = (theme && theme.terrain) || PALETTE;
  const coast = theme && theme.coast ? theme.coast : null;
  const water = WATER_TERRAIN;
  const v = view;
  const cols = visibleColumns(v);
  const rows = visibleRows(v);
  // The board wraps in X, so a view wider than the board used to tile the whole world two or
  // three times across the screen. When the board fits, draw it once and leave the margins empty.
  if (v.boardW * v.scale <= v.viewW) {
    cols.first = 0;
    cols.last = v.boardW - 1;
  }
  const nameAt = (x, y) => {
    if (y < 0 || y >= v.boardH) return null;
    return terrain[cells[y * v.boardW + wrapX(x, v.boardW)]] || null;
  };
  const edge = Math.max(1, Math.round(v.scale * 0.34));
  let painted = 0;
  for (let y = rows.first; y <= rows.last; y++) {
    const row = y * v.boardW;
    for (let sx = cols.first; sx <= cols.last; sx++) {
      const name = terrain[cells[row + wrapX(sx, v.boardW)]];
      const color = terrainInk(theme, name);
      if (!color) continue;
      const px = v.left + sx * v.scale;
      const py = v.top + y * v.scale;
      ctx.fillStyle = color;
      ctx.fillRect(px, py, v.scale, v.scale);
      painted++;
      if (!coast || !name || water.has(String(name).toLowerCase())) continue;
      // One strip per water neighbour, on the cell's own side of the boundary.
      ctx.fillStyle = coast;
      if (water.has(String(nameAt(sx, y - 1)).toLowerCase())) ctx.fillRect(px, py, v.scale, edge);
      if (water.has(String(nameAt(sx, y + 1)).toLowerCase())) ctx.fillRect(px, py + v.scale - edge, v.scale, edge);
      if (water.has(String(nameAt(sx - 1, y)).toLowerCase())) ctx.fillRect(px, py, edge, v.scale);
      if (water.has(String(nameAt(sx + 1, y)).toLowerCase())) ctx.fillRect(px + v.scale - edge, py, edge, v.scale);
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
    // T-021: the movement dashes are a state tick, not a frame. At 1.4 units of badge geometry
    // they read as a second outline and, at big tiles, swallowed the silhouette they annotate.
    ctx.strokeStyle = "#8fd3ff";
    ctx.lineWidth = Math.max(1, k * 0.8);
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
export function paintSiteTicks(ctx, sites, groups, view, opts = {}) {
  const list = Array.isArray(sites) ? sites : [];
  const gate = opts.sight || null;
  const covered = Array.isArray(groups) ? groups.map((group) => badgeFootprint(group, view)) : [];
  const scale = Math.max(1, Number(view.scale) || 1);
  const everyVisible = opts.everyVisible === true;
  if (!covered.length && !everyVisible) return 0;
  let drawn = 0;
  for (const site of list) {
    const x = Number(site && site.x);
    const y = Number(site && site.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // The city tick is painted after the fog, so it has to respect it (PB-082).
    const level = gate ? gate(x, y) : SIGHT_LIT;
    if (level === SIGHT_UNKNOWN) continue;
    // A capital keeps the capital ink, a city the city ink: the same two colours the terrain uses.
    const ink = (Number(site.type) === 1 || Number(site.type) === 2) ? PALETTE.capital : PALETTE.city;
    if (!ink) continue;
    const box = covered.find((b) => x >= b.x0 - 0.5 && x <= b.x1 + 0.5 && y >= b.y0 - 0.5 && y <= b.y1 + 0.5);
    if (box) {
      const topLeft = cellToPixel(wrapX(box.x0, view.boardW || BOARD_W), box.y0, view);
      const bottomRight = cellToPixel(wrapX(box.x1, view.boardW || BOARD_W), box.y1, view);
      // The span is measured before wrapping. A badge straddling the x seam has x0 near the right edge
      // and x1 past it, so wrapping both ends made the subtraction negative and the notch collapsed to
      // its 3 px floor (PB-035). Only the anchor column wraps.
      const span = Math.max(3, Math.round((box.x1 - box.x0) * scale));
      const side = Math.max(2, Math.round(span * 0.34));
      const nx = Math.round(topLeft.x) + 1;
      const ny = Math.round(bottomRight.y) - side - 1;
      ctx.globalAlpha = level === SIGHT_REMEMBERED ? REMEMBERED_MARKER_ALPHA : 1;
      ctx.fillStyle = BADGE_INTERIOR.land;
      ctx.fillRect(nx - 1, ny - 1, side + 2, side + 2);
      ctx.fillStyle = ink;
      ctx.fillRect(nx, ny, side, side);
      ctx.globalAlpha = 1;
      drawn++;
      continue;
    }
    if (!everyVisible) continue;
    // Show Ownership fills the ground the terrain view drew cities on, so a city was only findable
    // through the small tick a badge happened to leave (PB-068). Every site still on the board gets
    // its own square over the fill: one cell at the fit, and a dot with a dark casing once a cell is
    // wider than a pixel, so it reads on any owner's colour.
    const at = cellToPixel(wrapX(x, view.boardW || BOARD_W), y, view);
    if (at.x < -scale || at.x > view.viewW + scale || at.y < -scale || at.y > view.viewH + scale) continue;
    const size = Math.max(2, Math.round(scale * 0.8));
    ctx.globalAlpha = level === SIGHT_REMEMBERED ? REMEMBERED_MARKER_ALPHA : 1;
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(Math.round(at.x - size / 2) - 1, Math.round(at.y - size / 2) - 1, size + 2, size + 2);
    ctx.fillStyle = ink;
    ctx.fillRect(Math.round(at.x - size / 2), Math.round(at.y - size / 2), size, size);
    ctx.globalAlpha = 1;
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
    // Euclidean, the same metric piecesAtPoint ranks by: a Manhattan sum can name one piece in a
    // tooltip while the click under it selects another (T-028 nit).
    const distance = Math.hypot(dx, dy);
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

// Two boxes collide when they share a pixel. Labels are drawn as text, not as cells, so a shared
// pixel is unreadable overlap and the only honest answer is to move the label or drop it.
function collides(a, b) {
  return a.x < b.x + b.width + 1 && b.x < a.x + a.width + 1
    && a.y < b.y + b.height + 1 && b.y < a.y + a.height + 1;
}

// Where a label may sit, tried in a fixed order: right of the cell (the original's own habit),
// left, above, below. The first free one wins; with none free the label is dropped rather than
// drawn over a name, a badge or a capital ring (PB-026: London, Berlin and Paris).
export function placeLabel(text, labelScale, at, view, occupied = []) {
  const width = String(text).length * 8 * labelScale;
  const height = 6 * labelScale;
  if (width + 4 > view.viewW) return null;
  const gap = Math.max(2, Math.round(view.scale * 0.5));
  const candidates = [
    { x: at.x + gap, y: at.y - height / 2 },
    { x: at.x - width - gap, y: at.y - height / 2 },
    { x: at.x - width / 2, y: at.y - height - gap },
    { x: at.x - width / 2, y: at.y + gap },
  ];
  for (const spot of candidates) {
    const box = { x: Math.round(spot.x), y: Math.round(spot.y), width, height };
    if (box.x < 2) box.x = 2;
    if (box.y < 2) box.y = 2;
    if (box.x + box.width > view.viewW - 2) box.x = view.viewW - box.width - 2;
    if (box.y + box.height > view.viewH - 2) box.y = view.viewH - box.height - 2;
    if (box.x < 2 || box.y < 2) continue;
    if (occupied.some((other) => collides(box, other))) continue;
    return box;
  }
  return null;
}

export function visibleLabels(sites, view, opts = {}) {
  const list = Array.isArray(sites) ? sites : [];
  const out = [];
  if (!view || Number(view.scale) < LABEL_ZOOM) return out;
  const labelScale = Math.max(1, Math.floor(Number(view.scale) / LABEL_ZOOM));
  // Boxes that are already spoken for: the badges on the board (a name over a unit's face is the
  // PB-069 report, and it is just as bad over somebody else's city) and the capital rings.
  const occupied = Array.isArray(opts.occupied) ? opts.occupied.slice() : [];
  if (Array.isArray(opts.groups)) {
    for (const group of opts.groups) {
      const box = badgeFootprint(group, view, opts);
      if (!box) continue;
      const a = cellToPixel(wrapX(box.x0, view.boardW || BOARD_W), box.y0, view);
      const b = cellToPixel(wrapX(box.x1, view.boardW || BOARD_W), box.y1, view);
      occupied.push({ x: a.x, y: a.y, width: Math.max(2, b.x - a.x), height: Math.max(2, b.y - a.y) });
    }
  }
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
    const box = placeLabel(site.name, labelScale, at, view, occupied);
    if (!box) continue;
    occupied.push(box);
    out.push({ text: String(site.name), x: box.x, y: box.y, width: box.width, height: box.height,
      scale: labelScale, cell: { x, y }, owner: site.owner || null });
  }
  return out;
}

// Draw the labels from the decoded FONTS.CHQ atlas. Nothing is drawn without an atlas: the page
// keeps the text in its board note instead of inventing a font.
//
// Each name sits on a plate. Without one, white lettering over pale desert, white polar ground or
// the Classic ownership view's white neutral land vanished; the plate is the theme's own dark ink,
// so the lettering belongs to the picture in both themes.
export function paintLabels(ctx, atlas, labels, opts = {}) {
  if (!atlas || !Array.isArray(labels) || !labels.length) return 0;
  const ink = opts.ink || "#ffffff";
  const shadow = opts.shadow || "#000000";
  const plate = opts.plate || null;
  const gate = opts.sight || null;
  let drawn = 0;
  for (const label of labels) {
    // A name is ink over the fog like any other marker: a city the seat cannot see has no name
    // until it is remembered (PB-082).
    const level = gate && label.cell ? gate(label.cell.x, label.cell.y) : SIGHT_LIT;
    if (level === SIGHT_UNKNOWN) continue;
    const bitmap = textBitmap(atlas, label.text, label.scale);
    if (!bitmap.width || !bitmap.height) continue;
    ctx.globalAlpha = level === SIGHT_REMEMBERED ? REMEMBERED_MARKER_ALPHA : 1;
    if (plate) {
      ctx.fillStyle = plate;
      ctx.fillRect(label.x - 1, label.y - 1, bitmap.width + 2, bitmap.height + 2);
    }
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
    ctx.globalAlpha = 1;
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

// ---- Show Ownership (T-018) -----------------------------------------------------------------
//
// The original's second view (manual printed p.32): countries filled in the owner's colour, units
// still shown, friendly national borders outlined, toggled on and off. The geometry comes from the
// 184 region quads in web/data/territory.json (docs/re/REGIONS.md); the owner per region comes from
// the server, which reads it off the live site records. Nothing is coloured by guess.
//
// Colours measured off docs/captures/era-1942-blue-ownership.png (1942, blue side), counted over
// the map viewport: fills #5555ff and #ff5555, sea #55ffff, and the outlined edge a dark shade of
// the owner (#0000aa inside blue, #aa0000 inside red). The two unheld regions in that capture -
// Spain and Greenland - are painted WHITE, not the #aaaaaa OMAP.PIC uses on the briefing picture.
// A capture is a measurement of the live view, so white is what this palette carries.
//
// These are the Classic theme's fills now (T-019). The table lives in themes.mjs with the rest of
// the theme data and is re-exported here, where the painter and its pins already look for it: one
// copy of the measured colours, and the dark theme cannot drift from them by accident.
export const OWNERSHIP = themeById("D").ownership;

const WATER_TERRAIN = new Set(["ocean", "lake"]);

// cell -> region id, built once from the run-encoded grid the bake wrote. Cached on the geometry
// object itself so a redraw does not rebuild 43520 entries.
export function ownershipGrid(geometry) {
  if (!geometry || !Array.isArray(geometry.regionRuns)) return null;
  if (geometry.ownershipGrid && geometry.ownershipGrid.length === geometry.width * geometry.height) {
    return geometry.ownershipGrid;
  }
  const grid = new Uint8Array(geometry.width * geometry.height).fill(geometry.noRegion ?? 255);
  let at = 0;
  for (const [id, count] of geometry.regionRuns) {
    grid.fill(id, at, at + count);
    at += count;
  }
  if (at !== grid.length) return null;
  geometry.ownershipGrid = grid;
  return grid;
}

export function ownershipInk(owner, palette = OWNERSHIP) {
  if (owner === "blue") return palette.blue;
  if (owner === "red") return palette.red;
  return palette.neutral;
}

// The per-cell ink for a whole board: sea and ice from the terrain, land from the region's owner,
// and the region's own edge shade on the cells that touch a different owner. Pure, so a node test
// reads exactly what the page draws.
export function ownershipRaster(geometry, owners, board, palette = OWNERSHIP) {
  const grid = ownershipGrid(geometry);
  if (!grid || !Array.isArray(owners) || !geometry) return null;
  const width = geometry.width;
  const height = geometry.height;
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  const terrain = board && Array.isArray(board.terrain) ? board.terrain : [];
  const ink = new Array(width * height).fill(null);
  const terrainOf = (x, y) => {
    if (y < 0 || y >= height) return null;
    const cx = ((x % width) + width) % width;
    if (!cells) return null;
    return terrain[cells[y * width + cx]] || null;
  };
  // A coast is not a national border. Counting water, no-region and off-board neighbours as a
  // "different owner" shaded every cell that touched a lake, an inlet or the map edge, and the
  // interior of a big country came out speckled with dark single cells (PB-064: Canada, Russia).
  // A border cell is one whose LAND neighbour belongs to somebody else.
  const landOwnerAt = (x, y, owner) => {
    const name = terrainOf(x, y);
    if (name && WATER_TERRAIN.has(String(name).toLowerCase())) return owner;
    return at(x, y);
  };
  const at = (x, y) => {
    if (y < 0 || y >= height) return null;
    const cx = ((x % width) + width) % width;
    const rid = grid[y * width + cx];
    if (rid === (geometry.noRegion ?? 255)) return null;
    return owners[rid] || null;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const name = cells ? terrain[cells[index]] : null;
      if (name && WATER_TERRAIN.has(name)) {
        ink[index] = palette.sea;
        continue;
      }
      const owner = at(x, y);
      if (owner === null) {
        ink[index] = name ? palette.neutral : null;
        continue;
      }
      const friendly = owner === "blue" || owner === "red";
      const border = landOwnerAt(x - 1, y, owner) !== owner || landOwnerAt(x + 1, y, owner) !== owner
        || landOwnerAt(x, y - 1, owner) !== owner || landOwnerAt(x, y + 1, owner) !== owner;
      ink[index] = border ? (friendly ? palette.edge[owner] : palette.neutral) : ownershipInk(owner, palette);
    }
  }
  return { width, height, ink };
}

// Draw it. Cells, not polygons: the board is a cell grid and a border follows the cells, which is
// what the original's outline does too. Only the visible window is walked.
export function paintOwnership(ctx, geometry, owners, board, view, opts = {}) {
  const palette = opts.palette || OWNERSHIP;
  const raster = ownershipRaster(geometry, owners, board, palette);
  if (!raster) return 0;
  const cols = visibleColumns(view);
  const rows = visibleRows(view);
  if (view.boardW * view.scale <= view.viewW) {
    cols.first = 0;
    cols.last = view.boardW - 1;
  }
  let painted = 0;
  for (let y = rows.first; y <= rows.last; y++) {
    const row = y * view.boardW;
    for (let sx = cols.first; sx <= cols.last; sx++) {
      const color = raster.ink[row + wrapX(sx, view.boardW)];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(view.left + sx * view.scale, view.top + y * view.scale, view.scale, view.scale);
      painted += 1;
    }
  }
  return painted;
}

// Region counts for the legend. Regions, not cells: a zoom must not change the tally.
export function ownershipTally(owners) {
  const tally = { blue: 0, red: 0, neutral: 0 };
  for (const owner of Array.isArray(owners) ? owners : []) {
    if (owner === "blue") tally.blue += 1;
    else if (owner === "red") tally.red += 1;
    else tally.neutral += 1;
  }
  return tally;
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

// The capital ring, and the capital's name once the camera is close enough to read a name.
//
// The name used to be drawn at every zoom with the system font, anchored just off the ring: at the
// whole-world fit that put "Washington" and "Moscow" straight across the opening pieces, the route
// lines and the site markers (PB-069), and at label zoom the two words were wider than the ground
// they named (PB-026). A capital is found by its ring; its name is a label like every other place
// name, so it starts at LABEL_ZOOM, is placed by the same collision test, and sits on a plate in the
// theme's ink.
export function capitalLabels(markers, view, opts = {}) {
  const out = [];
  if (!view) return out;
  const list = Array.isArray(markers) ? markers : [];
  const occupied = Array.isArray(opts.occupied) ? opts.occupied.slice() : [];
  const fontPx = Math.max(9, Math.round(view.scale * 0.75));
  // A badge standing on the capital covers its ring and several cells around it, so the name is
  // tried close to the ring first and then further out, past the badge (PB-069). Without this the
  // only free spot on an opening capital - the one with a garrison on it - is nowhere near the city.
  const badge = Number(opts.badgePx) || BADGE_MIN_PX;
  const perChar = Math.max(6, Math.round(fontPx * 0.62));
  for (const marker of list) {
    const name = String(marker.name || "");
    if (!name) continue;
    const at = cellToPixel(marker.x, marker.y, view);
    if (at.x < -8 || at.x > view.viewW + 8 || at.y < -8 || at.y > view.viewH + 8) continue;
    const r = Math.max(3, view.scale * 2.4);
    const spread = [r + 3, r + 3 + badge * 0.7, r + 3 + badge * 1.4];
    const box = placeTextLabel(name, perChar, fontPx, { x: at.x, y: at.y, r, spread }, view, occupied);
    if (!box) continue;
    occupied.push(box);
    out.push({ ...box, name, x: box.x, y: box.y, fontPx, at, ring: r, marker });
  }
  return out;
}

// Same four candidate spots as the atlas labels, measured in text pixels instead of atlas cells.
function placeTextLabel(text, perChar, height, { x, y, r, spread = [] }, view, occupied) {
  const width = String(text).length * perChar;
  const boxH = Math.round(height * 1.15);
  if (width + 4 > view.viewW) return null;
  // Each distance is tried right, left, above, below, in that order, before the next one: the
  // nearest free spot wins, so a name only travels as far from its city as it has to.
  const candidates = [];
  for (const d of (spread.length ? spread : [r + 3])) {
    candidates.push(
      { x: x + d, y: y - boxH / 2 },
      { x: x - d - width, y: y - boxH / 2 },
      { x: x - width / 2, y: y - d - boxH },
      { x: x - width / 2, y: y + d },
    );
  }
  for (const spot of candidates) {
    const box = { x: Math.round(spot.x), y: Math.round(spot.y), width, height: boxH };
    if (box.x < 2 || box.y < 2) continue;
    if (box.x + box.width > view.viewW - 2 || box.y + box.height > view.viewH - 2) continue;
    if (occupied.some((other) => collides(box, other))) continue;
    return box;
  }
  return null;
}

export function paintCapitals(ctx, markers, view, opts = {}) {
  const list = Array.isArray(markers) ? markers : [];
  const gate = opts.sight || null;
  const level = (marker) => (gate ? gate(marker.x, marker.y) : SIGHT_LIT);
  // A capital outside sight is not a capital the seat may see: the ring and the name are drawn
  // after the fog, so they are the only ink on the board the wash cannot dim (PB-082).
  const seen = list.filter((marker) => level(marker) !== SIGHT_UNKNOWN);
  const r = Math.max(3, view.scale * 2.4);
  const labels = Array.isArray(opts.labels) ? opts.labels : capitalLabels(seen, view, opts);
  // No plate unless the caller asks for one: the schematic fallback is pinned to the palette's own
  // colours, and a plate would be a colour the palette never emits.
  const plate = opts.plate || null;
  const ink = opts.ink || PIECE_INK.own;
  let drawn = 0;
  for (const marker of seen) {
    const at = cellToPixel(marker.x, marker.y, view);
    ctx.globalAlpha = level(marker) === SIGHT_REMEMBERED ? REMEMBERED_MARKER_ALPHA : 1;
    ctx.strokeStyle = marker.color;
    ctx.lineWidth = Math.max(1, view.scale);
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    drawn += 1;
  }
  if (!labels.length) return drawn;
  for (const label of labels) {
    const marker = label.marker;
    const labelLevel = marker ? level(marker) : SIGHT_LIT;
    if (labelLevel === SIGHT_UNKNOWN) continue;
    ctx.globalAlpha = labelLevel === SIGHT_REMEMBERED ? REMEMBERED_MARKER_ALPHA : 1;
    ctx.font = label.fontPx + "px Palatino, Georgia, serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (plate && typeof ctx.fillRect === "function") {
      ctx.fillStyle = plate;
      ctx.fillRect(label.x - 2, label.y - 1, label.width + 4, label.height + 2);
    }
    ctx.fillStyle = ink;
    if (typeof ctx.fillText === "function") ctx.fillText(label.name, label.x, label.y);
    ctx.globalAlpha = 1;
  }
  return drawn;
}

// The route a hovered order would take, drawn from the server's plan. `preview` is
// {from:{x,y}, to:{x,y}, path:[{x,y,pace}], rounds, error?}. A refusal draws the marker in
// the dark ink and no line; the sentence itself goes on the board note.
export const ROUTE_INK = "#ffd166";

// The route's cells with x UNWRAPPED across the seam. The server plans in wrapped columns (319 ->
// 0 is one step east); drawing each point at its own wrapped pixel made that step a line from one
// edge of the map to the other, so a 94-round sea route zig-zagged the whole board (PB-053, T-030).
// Unwrapping keeps the path one continuous line: `x` runs past 0 or past boardW and the painter
// blits the run at -boardW, 0 and +boardW so both edges of the seam show the part that belongs to
// them. Pure, so a test measures the drawn span without a canvas.
export function routePolyline(preview, view) {
  if (!preview) return [];
  const boardW = Math.max(1, Math.floor(Number(view && view.boardW) || BOARD_W));
  const cells = [];
  const from = preview.from;
  if (from && Number.isFinite(Number(from.x)) && Number.isFinite(Number(from.y))) {
    cells.push({ x: Number(from.x), y: Number(from.y) });
  }
  for (const step of Array.isArray(preview.path) ? preview.path : []) {
    if (!step || !Number.isFinite(Number(step.x)) || !Number.isFinite(Number(step.y))) continue;
    cells.push({ x: Number(step.x), y: Number(step.y) });
  }
  const to = preview.to;
  if (to && Number.isFinite(Number(to.x)) && Number.isFinite(Number(to.y))) {
    const last = cells[cells.length - 1];
    if (!last || wrapX(last.x, boardW) !== wrapX(Number(to.x), boardW) || last.y !== Number(to.y)) {
      cells.push({ x: Number(to.x), y: Number(to.y) });
    }
  }
  const points = [];
  let raw = null;
  let x = 0;
  for (const cell of cells) {
    if (raw === null) x = wrapX(cell.x, boardW);
    else x += wrapDelta(raw, cell.x, boardW);
    raw = cell.x;
    points.push({ x, y: cell.y, cellX: wrapX(cell.x, boardW), cellY: cell.y });
  }
  return points;
}

// The longest hop a route draws, in cells. A seam crossing is one cell (319 -> 0 is +1); before the
// unwrap it measured the whole board width. AC5 of T-030 asserts this stays under half the map.
export function routeSpan(preview, view) {
  const points = routePolyline(preview, view);
  let maxCells = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len > maxCells) maxCells = len;
  }
  return { points: points.length, maxCells };
}

export const SELECT_MARK_INK = "#ffe066";

// Where the selected piece's mark goes, and how big. Exported so a test can assert the mark exists
// at the world fit and both zooms WITHOUT reading pixels back off a canvas.
export function selectionMarkFor(groups, view, opts = {}) {
  const selectedId = opts.selectedId;
  if (selectedId === undefined || selectedId === null) return null;
  const id = String(selectedId);
  const group = (Array.isArray(groups) ? groups : []).find((entry) => {
    if (!entry) return false;
    if (Array.isArray(entry.pieces) && entry.pieces.some((piece) => piece && String(piece.id) === id)) return true;
    return entry.top && String(entry.top.id) === id;
  });
  if (!group || !view) return null;
  const scale = Math.max(1, Number(view.scale) || 1);
  const badge = badgePx(scale, Number(opts.badgeMinPx) || BADGE_MIN_PX);
  const at = cellToPixel(wrapX(group.x, view.boardW || BOARD_W), group.y, view);
  // The mark's floor is a SCREEN size that scales with the cell: about three cells across, or the
  // badge plus a 4 px margin, whichever is bigger (T-030 AC8 item 3). A fixed few pixels read as a
  // flicker at the world fit and vanished beside a zoomed badge.
  const size = Math.max(scale * 3, badge + 8);
  // The pulse phase grows the ring by up to 3 px; the ring itself is always drawn, so the mark is
  // visible in a still screenshot at any phase and only breathes on screen.
  const pulse = Math.max(0, Math.min(1, Number(opts.pulse ?? opts.selectedPulse) || 0));
  return {
    x: at.x, y: at.y, size, half: size / 2 + 2 + 3 * pulse, pulse,
    ink: opts.ink || SELECT_MARK_INK, casing: "#0b0f14",
  };
}

// The selected piece's mark: a dark casing under a bright ring, plus a faint ring that expands with
// the pulse. The old white-only ring sat on the badge's own pale face and read as nothing (PB-051);
// casing + accent is legible on both map themes and at the world fit, where the badge is smallest.
export function paintSelectionMark(ctx, groups, view, opts = {}) {
  const mark = selectionMarkFor(groups, view, opts);
  if (!mark) return null;
  const { x, y, half } = mark;
  const ring = () => {
    ctx.beginPath();
    ctx.rect(Math.round(x - half) + 0.5, Math.round(y - half) + 0.5,
      Math.round(half * 2), Math.round(half * 2));
  };
  // PB-060: in a dense stack the old 1.8 px accent over a 4 px casing still read as a thin
  // flicker against the badges. Both strokes are wider now, and the casing stays under the accent
  // so the mark holds on light terrain and on the dark theme's ground alike.
  ring();
  ctx.strokeStyle = mark.casing;
  ctx.lineWidth = 5;
  ctx.stroke();
  ring();
  ctx.strokeStyle = mark.ink;
  ctx.lineWidth = 2.6;
  ctx.stroke();
  // The breathing half: a wider ring fading out as it grows, so the mark moves without the still
  // frame depending on where the pulse happens to be.
  const outer = half + 5 + 5 * mark.pulse;
  ctx.beginPath();
  ctx.rect(Math.round(x - outer) + 0.5, Math.round(y - outer) + 0.5,
    Math.round(outer * 2), Math.round(outer * 2));
  ctx.globalAlpha = 0.45 * (1 - mark.pulse);
  ctx.strokeStyle = mark.ink;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  return mark;
}

// An order that is on the wire but has not arrived yet stays on the map (T-030 AC8 item 2). The
// room frame carries the plan as `piece.path` (move.mjs writes it when the order lands), so the page
// draws the same path the server will walk: a thin line from the piece through every step, and a
// small hollow square on the destination. Without it an accepted order left the board unchanged and
// the player sent the same order again believing nothing had happened.
export function paintPendingOrders(ctx, room, view, opts = {}) {
  if (!room || !view) return 0;
  const you = room.you ? String(room.you) : "";
  const pieces = Array.isArray(room.pieces) ? room.pieces : [];
  const scale = Math.max(1, Number(view.scale) || 1);
  const widthCells = Math.max(1, Math.floor(Number(view.boardW) || BOARD_W));
  // The seam copies exist to put a run that leaves one edge back on the other. When the whole board
  // is on screen they are pure margin: they were the route lines drawn in the empty space beside a
  // zoomed-out map (PB-067), so they are skipped entirely.
  const offsets = widthCells * scale <= view.viewW ? [0] : [-widthCells * scale, 0, widthCells * scale];
  // PB-042 / PB-060: an order already on the wire is a reminder, not the news. Its line is thinner
  // than a hovered route's and is stroked under a half-opaque casing, so a fresh preview reads as
  // the bright line and the old paths stay legible without covering it.
  const width = Math.max(1.2, scale * 0.34);
  let drawn = 0;
  for (const piece of pieces) {
    if (!you || !piece || String(piece.side) !== you) continue;
    const path = Array.isArray(piece.path) ? piece.path : [];
    if (!path.length) continue;
    const points = [{ x: piece.x, y: piece.y }, ...path];
    // Only paths that reach the visible board are traced; the seam offsets put a wrapped run back
    // on screen instead of streaking it across the middle.
    for (const shift of offsets) {
      ctx.beginPath();
      points.forEach((step, i) => {
        const at = cellToPixel(wrapX(step.x, widthCells), Number(step.y), view);
        if (i === 0) ctx.moveTo(at.x + shift, at.y);
        else ctx.lineTo(at.x + shift, at.y);
      });
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.lineWidth = width + 1;
      ctx.stroke();
      ctx.globalAlpha = 0.72;
      ctx.strokeStyle = opts.ink || ROUTE_INK;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const last = points[points.length - 1];
    const end = cellToPixel(wrapX(last.x, widthCells), Number(last.y), view);
    const half = Math.max(1.5, scale * 0.55);
    for (const shift of offsets) {
      const at = { x: end.x + shift, y: end.y };
      if (at.x < -half - 4 || at.x > view.viewW + half + 4) continue;
      ctx.beginPath();
      ctx.rect(Math.round(at.x - half) + 0.5, Math.round(at.y - half) + 0.5,
        Math.round(half * 2), Math.round(half * 2));
      ctx.fillStyle = opts.ink || ROUTE_INK;
      ctx.fill();
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = Math.max(1, scale * 0.28);
      ctx.stroke();
    }
    drawn += 1;
  }
  return drawn;
}

export function paintPreview(ctx, preview, view, opts = {}) {
  if (!preview) return 0;
  const v = view;
  const points = routePolyline(preview, v);
  const path = Array.isArray(preview.path) ? preview.path : [];
  const to = preview.to || (path.length ? path[path.length - 1] : null);
  const ink = preview.error ? PIECE_INK.enemy : (opts.ink || ROUTE_INK);
  const casing = opts.casing || "rgba(0, 0, 0, 0.65)";
  // Two passes: a dark casing under a bright line. At the whole-world fit a one-pixel hairline in
  // gold over pale terrain read as nothing at all (T-007 AC10), and the route a player is about to
  // send is the one thing on the map that must be legible. T-021 thinned it: the old 2 px floor
  // plus a 2 px casing read as a rope at fit and as a slab when zoomed in. The floor is still above
  // one pixel and the casing still carries it, at every zoom.
  const width = Math.max(1.25, v.scale * 0.5);

  // The unwrapped run is drawn at three offsets: the one the camera shows, and one map-width to
  // either side, so a route that leaves the east edge reappears at the west edge instead of
  // streaking across the board. The canvas clips the rest.
  const widthCells = Math.max(1, Math.floor(Number(v.boardW) || BOARD_W));
  // Same rule as the pending paths: with the whole board visible there is no seam to wrap, and a
  // shifted copy would only paint in the margins (PB-067).
  const offsets = widthCells * v.scale <= v.viewW ? [0] : [-widthCells * v.scale, 0, widthCells * v.scale];
  const trace = (shift) => {
    if (!points.length) return false;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const at = cellToPixel(points[i].x, points[i].y, v);
      if (i === 0) ctx.moveTo(at.x + shift, at.y);
      else ctx.lineTo(at.x + shift, at.y);
    }
    return true;
  };

  for (const shift of offsets) {
    if (!trace(shift)) break;
    ctx.strokeStyle = casing;
    ctx.lineWidth = width + 1.5;
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  if (to && Number.isFinite(Number(to.x)) && Number.isFinite(Number(to.y))) {
    // The end marker: a filled diamond on a dark ring, so "this is where the order lands" is not a
    // hairline square nobody can see. T-021 thinned it with the line it ends. Drawn at every copy of
    // the seam the run occupies, so the marker is on screen when the route crosses.
    const base = cellToPixel(wrapX(to.x, v.boardW || BOARD_W), Number(to.y), v);
    const r = Math.max(2.5, v.scale * 1.2);
    for (const shift of offsets) {
      const at = { x: base.x + shift, y: base.y };
      if (at.x < -r || at.x > v.viewW + r) continue;
      ctx.beginPath();
      ctx.moveTo(at.x, at.y - r);
      ctx.lineTo(at.x + r, at.y);
      ctx.lineTo(at.x, at.y + r);
      ctx.lineTo(at.x - r, at.y);
      ctx.closePath();
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.lineWidth = Math.max(0.75, width * 0.45);
      ctx.strokeStyle = "#0b0f14";
      ctx.stroke();
    }
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

  // The theme is a table of inks, never a rule: the grid, the cell ids, the sites, the pieces and
  // the camera are the caller's, so switching theme cannot move anything (T-019 AC1).
  const theme = opts.theme || themeById(opts.themeId || "D");
  const schematic = !board || board.source === "missing" || !Array.isArray(board.cells);
  let mode = "cells";
  let painted = 0;

  let fogged = 0;
  let political = 0;
  let tally = null;
  // The layer list records the painter's own order, so a pin can hold the order rather than the
  // presence of a call. `cells` and `fog` are in it: terrain and fog are layers a player can see,
  // and leaving them out let a re-order of the fill pass every pin (see the T-018 AC4 follow-up).
  const layers = [];
  // One sight table for every marker layer painted after the fog: null in every era but the
  // concealed one (9999), so the painter's behaviour elsewhere is untouched (PB-082).
  const gate = sightGate(opts.fog, view);
  if (!schematic) {
    painted = paintCells(ctx, board, view, { theme });
    if (painted === 0) mode = "schematic";
    else {
      layers.push("cells");
      // Show Ownership goes down on the ground and UNDER the fog: the fill is a base layer, but a
      // cell the seat cannot see has to stay unreadable. Painted after the fog, the fill covered
      // every unknown cell and the ownership view showed a fully lit world.
      if (opts.viewMode === "political") {
        const ownership = room && room.ownership;
        if (ownership && ownership.ready && board && board.territory && Array.isArray(ownership.owners)) {
          political = paintOwnership(ctx, board.territory, ownership.owners, board, view,
            { ...opts, palette: theme.ownership });
          tally = ownershipTally(ownership.owners);
        } else {
          const patches = politicalSites(room && room.sites, view);
          political = paintPolitical(ctx, patches, view);
          tally = politicalTally(patches);
        }
        layers.push("ownership");
      }
      if (opts.fog) {
        fogged = paintFog(ctx, view, opts.fog.lit, opts.fog.seen);
        layers.push("fog");
      }
    }
  } else {
    mode = "schematic";
  }

  if (mode === "schematic") {
    // The schematic painter draws at the origin, so this path stays unpanned.
    const flat = { ...view, left: 0, top: 0 };
    paintBoard(ctx, board || { width: view.boardW, height: view.boardH }, { scale: view.scale, theme });
    const preview = paintPreview(ctx, opts.preview, flat, opts);
    const groups = paintPieces(ctx, room && room.pieces, flat, opts);
    const pending = paintPendingOrders(ctx, room, flat, opts);
    const selection = paintSelectionMark(ctx, groups, flat, opts);
    const pieces = Array.isArray(room && room.pieces) ? room.pieces.length : 0;
    const capitals = paintCapitals(ctx, capitalMarkers(board, room), flat, capitalOpts(flat, theme, opts));
    return { mode, painted: 0, pieces, groups: groups.length, capitals, preview, pending, selection,
      theme: theme.id,
      layers: ["board", "preview", "pieces", "pending", "selection", "capitals"],
      message: EXTRACT_MISSING, view: flat };
  }

  if (opts.sightAt && Number(opts.sight) > 0) {
    paintSightRing(ctx, opts.sightAt, view, opts.sight, opts.ringColor || theme.selectionInk);
  }
  // Old orders first and on the ground (PB-060): a path already on the wire belongs under the
  // pieces and under the route the player is hovering now, or the newest line is the one that
  // disappears into the clutter.
  const pending = paintPendingOrders(ctx, room, view, { ...opts, ink: theme.routeInk });
  layers.push("pending");
  const preview = paintPreview(ctx, opts.preview, view, { ...opts, ink: theme.routeInk, casing: theme.routeCasing });
  layers.push("preview");
  const groups = paintPieces(ctx, room && room.pieces, view, opts);
  const pieces = Array.isArray(room && room.pieces) ? room.pieces.length : 0;
  // A badge is never smaller than its floor, so one can cover the city square it stands on. The
  // sites under badges get their own cell tick back after the pieces are painted: the city has to
  // stay visible on the board even when a garrison is standing on it (PB-029, T-014 AC7).
  layers.push("pieces");
  // In Show Ownership the fill has taken the ground the terrain view drew its cities on, so every
  // site gets a mark of its own and not only the ones a badge happens to sit on (PB-068).
  const siteTicks = paintSiteTicks(ctx, room && room.sites, groups, view,
    { everyVisible: opts.viewMode === "political", sight: gate });
  layers.push("siteTicks");
  // Names are placed, not stamped: a capital's name starts at the readable zoom and takes a free
  // spot around its ring (PB-026, PB-069), and city names then avoid both the badges and the
  // capital names.
  const occupied = badgeBoxes(groups, view, opts);
  const capLabels = capitalLabels(capitalMarkers(board, room), view, { occupied });
  const capitals = paintCapitals(ctx, capitalMarkers(board, room), view,
    { labels: capLabels, plate: theme.labelPlate, ink: theme.labelInk, sight: gate });
  layers.push("capitals");
  const labels = visibleLabels(room && room.sites, view, {
    groups, occupied: [...occupied, ...capLabels.map((label) => ({ x: label.x, y: label.y, width: label.width, height: label.height }))],
  });
  const labelled = paintLabels(ctx, opts.atlas, labels,
    { ink: theme.labelInk, plate: theme.labelPlate, sight: gate });
  layers.push("labels");
  const selection = paintSelectionMark(ctx, groups, view, { ...opts, ink: theme.selectionInk });
  layers.push("selection");
  return { mode, painted, fogged, pieces, groups: groups.length, siteTicks, capitals, labels: labelled,
    political, tally, preview, pending, selection, layers, theme: theme.id, message: "", view };
}

// The badge boxes as screen rects: what a name must not be drawn over.
function badgeBoxes(groups, view, opts = {}) {
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const box = badgeFootprint(group, view, opts);
    if (!box) continue;
    const a = cellToPixel(wrapX(box.x0, view.boardW || BOARD_W), box.y0, view);
    const b = cellToPixel(wrapX(box.x1, view.boardW || BOARD_W), box.y1, view);
    out.push({ x: a.x, y: a.y, width: Math.max(2, b.x - a.x), height: Math.max(2, b.y - a.y) });
  }
  return out;
}

// The schematic fallback keeps the palette's own colours only (its pin refuses an invented one), so
// it takes the names but no plate and no theme label ink.
function capitalOpts(view, theme, opts = {}) {
  return { ...opts, plate: null, ink: PIECE_INK.own };
}

// Re-exported so the page and the test read one name for the live table.
export { PALETTE, SCHEMATIC };
