// Unit badges: what a piece looks like on the board, at every zoom (T-014).
//
// The original drew a 3x3 block for every unit on the map and told them apart in its panels
// (docs/chq-reference/chq_0021.png). This page has no monitor strip, so the identity has to live on
// the board. Each kind gets one original silhouette inside a badge, and the badge is drawn by the
// canvas painter in render.mjs from the primitives below - one description, two renderers (canvas
// for the board, SVG for the legend), so the legend cannot drift from the map.
//
// HARD RULE: none of this is UNITS.PIC or UNITS.png, and none of it is a trace or a crop of either.
// The borrow is the idea - a silhouette inside a side-coloured badge, as the original's zoom window
// drew it - never the pixels.
//
// Readability rules (PM pass on the mockup sheet, room 3946):
//   * one badge is one shape at every pixel size: 14 px and 96 px are the same drawing;
//   * side is carried by colour AND frame geometry - blue is a square, red has chamfered corners -
//     so the two sides still differ in a grayscale or colour-blind view;
//   * the interior says the domain (land near-white, sea pale blue, air pale blue-white) and the
//     silhouette is the side's dark colour, which flips its contrast against that interior;
//   * state (selected / moving / in combat / damaged / entrenched / stacked) is drawn AROUND the
//     silhouette, never over it, so the type never disappears;
//   * the badge is never drawn smaller than BADGE_MIN_PX on screen, at any zoom, including the
//     whole-world fit. The 3x3 block is not a fallback - dotted clusters at full-map zoom are
//     exactly what the task exists to remove.
//
// Every kind here is one a player can see on the board: the eleven the manual names (p.19-20) plus
// the transport state. The manual's list is air, infantry, tank, cruiser, carrier, submarine,
// Satellite, Satellite Killer, Nuke, Foreign Aid and Intel Scan; transport is a land unit at sea and
// entrenched is a state of infantry, not a twelfth kind.

// The drawing box. Every coordinate below is in these units, whatever pixel size the badge is drawn
// at.
export const BADGE_UNIT = 24;

// The floor the PM set: a badge never renders below this many CSS pixels, at any zoom. Below it the
// type stops being tellable apart and the dots come back.
export const BADGE_MIN_PX = 14;

// The footprint at a close zoom, in cells. The original's zoom badge was 12x12 game pixels; three
// cells is the same idea at this board's scale, and it is the footprint the old 3x3 marker used, so
// a badge sits where the block used to.
export const BADGE_CELLS = 3;

// The sides. `frame` is the badge body, `dark` the silhouette, `ink` the hairline that keeps a dark
// hull legible on dark water.
export const BADGE_SIDE = Object.freeze({
  blue: Object.freeze({ frame: "#1b3f8f", dark: "#0000aa", ink: "#08122b", frameShape: "square" }),
  red: Object.freeze({ frame: "#8f1b1b", dark: "#aa0000", ink: "#2b0808", frameShape: "chamfered" }),
});

export const BADGE_INTERIOR = Object.freeze({
  land: "#f2f5fb",
  sea: "#cfe3f6",
  air: "#e4eefc",
});

// The eleven kinds plus the transport state, in the manual's order (p.19-20).
export const BADGE_KINDS = Object.freeze([
  "infantry", "tank", "submarine", "cruiser", "carrier", "aircraft",
  "reconSat", "killerSat", "nuke", "foreignAid", "intelScan",
]);

export const BADGE_LABEL = Object.freeze({
  infantry: "Infantry",
  tank: "Tank",
  submarine: "Submarine",
  cruiser: "Cruiser",
  carrier: "Carrier",
  aircraft: "Air",
  reconSat: "Satellite (recon)",
  killerSat: "Satellite killer",
  nuke: "Nuke",
  foreignAid: "Foreign aid",
  intelScan: "Intel scan",
  transport: "Transport (land unit at sea)",
});

export const BADGE_DOMAIN = Object.freeze({
  infantry: "land", tank: "land", nuke: "land", foreignAid: "land",
  cruiser: "sea", carrier: "sea", submarine: "sea", transport: "sea",
  aircraft: "air", reconSat: "air", killerSat: "air", intelScan: "air",
});

// Kinds the runtime can actually entrench. combat.mjs and move.mjs both refuse anything but
// infantry, and the original's entrench is a kind change 1 -> 3 (Q4, COMBAT.md). The dug-in bar is
// therefore an infantry mark; a tank never shows it.
export const ENTRENCH_KINDS = Object.freeze(["infantry"]);

// ---- silhouettes ---------------------------------------------------------------------------
//
// Primitives, not pixels: the canvas painter and the SVG writer both walk this list, so a shape is
// written once. `t` is the shape, `invert` means "fill with the interior colour instead of the
// side's dark", which is how the carrier's deck line and the aid crate's cross stay visible against
// a dark fill. Coordinates are BADGE_UNIT units.
const P = Object.freeze({
  rect: (x, y, w, h, r = 0) => ({ t: "rect", x, y, w, h, r }),
  circle: (cx, cy, r) => ({ t: "circle", cx, cy, r }),
  ellipse: (cx, cy, rx, ry) => ({ t: "ellipse", cx, cy, rx, ry }),
  poly: (...pts) => ({ t: "poly", pts }),
  line: (x1, y1, x2, y2, w = 1.4, dash = null) => ({ t: "line", x1, y1, x2, y2, w, dash }),
});

export const BADGE_SILHOUETTE = Object.freeze({
  // A figure: head, shoulders, torso, two legs, a rifle held across the body.
  infantry: Object.freeze([
    P.circle(10.6, 7.7, 2.2),
    P.poly([9.0, 10.2], [12.2, 10.2], [13.1, 14.9], [8.1, 14.9]),
    P.rect(8.6, 14.6, 2.0, 4.3, 0.5),
    P.rect(11.0, 14.6, 2.0, 4.3, 0.5),
    Object.freeze({ ...P.line(15.1, 6.9, 17.4, 16.8, 1.5), invert: false }),
  ]),
  // A hull, a turret, a barrel over the nose.
  tank: Object.freeze([
    P.rect(4.9, 12.6, 14.2, 4.4, 1.0),
    P.rect(6.6, 10.4, 10.6, 2.6, 0.6),
    P.rect(9.3, 7.6, 5.4, 3.2, 0.6),
    P.rect(14.4, 8.5, 4.8, 1.5, 0.7),
  ]),
  // A long hull, a sail, a periscope. No bow point: that is what tells it from a cruiser at a glance.
  submarine: Object.freeze([
    P.ellipse(12, 15.2, 7.6, 2.6),
    P.rect(9.9, 9.4, 4.0, 4.6, 0.6),
    P.rect(11.6, 6.8, 1.0, 2.8, 0.2),
  ]),
  // A pointed bow, a superstructure, two guns.
  cruiser: Object.freeze([
    P.poly([5.2, 12.4], [18.8, 12.4], [16.4, 17.6], [7.6, 17.6]),
    P.rect(9.6, 8.6, 4.4, 4.2, 0.6),
    P.rect(10.6, 6.2, 2.0, 2.6, 0.3),
    P.line(14.8, 9.4, 16.4, 11.4, 1.2),
  ]),
  // A full-beam flight deck with the island to one side and the deck line down the middle.
  carrier: Object.freeze([
    P.rect(4.6, 10.8, 14.8, 6.2, 0.7),
    P.rect(15.6, 7.4, 3.0, 3.4, 0.5),
    Object.freeze({ ...P.rect(6.2, 13.2, 13.0, 1.2, 0.5), invert: true }),
  ]),
  // Top view: nose, swept wings, tail.
  aircraft: Object.freeze([
    P.poly([12, 5.2], [13.4, 11.0], [19.4, 15.0], [19.4, 16.6], [12.9, 14.4],
      [12.9, 17.2], [14.6, 18.8], [14.6, 19.8], [9.4, 19.8], [9.4, 18.8], [11.1, 17.2],
      [11.1, 14.4], [4.6, 16.6], [4.6, 15.0], [10.6, 11.0]),
  ]),
  // A bus with two solar panels and a dish.
  reconSat: Object.freeze([
    P.rect(9.7, 9.6, 4.6, 6.0, 0.7),
    P.rect(4.6, 10.8, 4.4, 1.6, 0.3),
    P.rect(15.0, 10.8, 4.4, 1.6, 0.3),
    P.rect(11.5, 6.6, 1.0, 3.0, 0.2),
    P.circle(12, 5.4, 1.4),
  ]),
  // The same bus, with a strike crossed through it: the one silhouette a player must not confuse
  // with the recon bird.
  killerSat: Object.freeze([
    P.rect(9.7, 10.4, 4.6, 6.0, 0.7),
    P.rect(4.6, 11.6, 4.4, 1.6, 0.3),
    P.rect(15.0, 11.6, 4.4, 1.6, 0.3),
    Object.freeze({ ...P.line(5.6, 5.8, 18.4, 18.6, 2.6), invert: true }),
    P.line(5.6, 5.8, 18.4, 18.6, 1.2, [2.2, 1.6]),
  ]),
  // A mushroom: cap, stem, base.
  nuke: Object.freeze([
    P.ellipse(12, 10.0, 6.2, 3.6),
    P.poly([10.4, 12.8], [13.6, 12.8], [13.2, 17.2], [10.8, 17.2]),
    P.rect(7.4, 17.4, 9.2, 1.8, 0.6),
  ]),
  // A sealed crate with a cross: aid, not a weapon.
  foreignAid: Object.freeze([
    P.rect(5.8, 9.4, 12.4, 9.0, 0.8),
    Object.freeze({ ...P.rect(10.7, 9.4, 2.6, 9.0), invert: true }),
    Object.freeze({ ...P.rect(5.8, 12.6, 12.4, 2.6), invert: true }),
  ]),
  // An eye over a pupil, with a scan tick above and below.
  intelScan: Object.freeze([
    P.poly([5.0, 13.0], [8.4, 9.6], [15.6, 9.6], [19.0, 13.0], [15.6, 16.4], [8.4, 16.4]),
    Object.freeze({ ...P.circle(12, 13.0, 2.9), invert: true }),
    P.circle(12, 13.0, 1.4),
    P.line(12, 4.6, 12, 7.6, 1.3),
    P.line(12, 18.4, 12, 21.0, 1.3),
  ]),
  // Transport is a state, not a kind: the sea badge with a hull OUTLINE and the land cargo shown
  // inside it, which is the manual's "the badge background changes when a land unit boards
  // transports" (p.20) done the other way round - the hull is empty because the cargo is the point.
  transport: Object.freeze([
    Object.freeze({ t: "ellipse", cx: 12, cy: 15.2, rx: 7.6, ry: 2.6, strokeOnly: true }),
    P.rect(9.0, 7.0, 6.0, 4.6, 0.6),
    P.rect(10.2, 5.2, 3.6, 1.8, 0.4),
    P.line(5.6, 19.6, 8.6, 19.6, 1.2),
    P.line(10.8, 19.6, 13.8, 19.6, 1.2),
    P.line(16.0, 19.6, 19.0, 19.6, 1.2),
  ]),
});

// ---- frame geometry -------------------------------------------------------------------------

// The badge body, as a polygon. Blue is a square; red has its corners cut, and that cut is the whole
// point: it is the cue that survives a grayscale screen or a player who cannot separate the hues.
export function framePolygon(side) {
  const loop = side === "red"
    ? [[7, 3], [17, 3], [21, 7], [21, 17], [17, 21], [7, 21], [3, 17], [3, 7]]
    : [[3, 3], [21, 3], [21, 21], [3, 21]];
  return loop.map(([x, y]) => [x, y]);
}

// The same polygon shrunk by `inset`, for the interior. Scaling about the centre keeps the chamfer
// angle, so the interior is the frame's own shape and not a circle pretending to be one.
export function insetPolygon(points, inset = 0.9) {
  const cx = 12;
  const cy = 12;
  const out = points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x - (dx / len) * inset, y - (dy / len) * inset];
  });
  return out;
}

// The ring that says "selected". It follows the frame it surrounds - square on blue, chamfered on
// red - so selection does not erase the side cue the frame is carrying.
export function selectedRing(side) {
  const cx = 12;
  const cy = 12;
  return framePolygon(side).map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * 2.2, y + (dy / len) * 2.2];
  });
}

// ---- the badge a piece gets ----------------------------------------------------------------

// Whether a piece is a transport, and therefore draws the transport state rather than its kind's
// silhouette. A land unit at sea is cargo: the manual changes the badge when it boards.
export function isTransportBadge(piece) {
  return Boolean(piece && (piece.transport === true ||
    (piece.kind === "transport" && piece.domain !== "sea") ||
    (piece.domain === "land" && piece.atSea === true)));
}

// The badge descriptor for a piece. An untyped piece still gets a badge - the board has to show
// *something* a player can read - and the shape is a plain square inside the frame, which is the
// one silhouette no kind uses, so it reads as "unknown" rather than as a wrong type.
export function badgeForPiece(piece) {
  const transport = isTransportBadge(piece);
  const kind = transport ? "transport" : String((piece && piece.kind) || "");
  const known = Object.hasOwn(BADGE_SILHOUETTE, kind) && kind !== "transport";
  const shapeKind = transport ? "transport" : known ? kind : null;
  return {
    kind: transport ? "transport" : known ? kind : "unit",
    shapeKind,
    domain: transport ? "sea" : (BADGE_DOMAIN[kind] || (piece && piece.domain) || "land"),
    silhouette: shapeKind ? BADGE_SILHOUETTE[shapeKind] : UNKNOWN_SILHOUETTE,
    frame: (piece && piece.side) === "red" ? "red" : "blue",
  };
}

// The shape an untyped piece gets. Deliberately not a kind's silhouette: a bare square says "a unit
// somebody has not identified", and after T-013b an untyped opening piece is a loader bug, not a
// shape the player should learn.
const UNKNOWN_SILHOUETTE = Object.freeze([
  P.rect(8.0, 8.0, 8.0, 8.0, 1.0),
  Object.freeze({ ...P.rect(10.4, 10.4, 3.2, 3.2, 0.4), invert: true }),
]);

export function badgeSilhouette(kind, transport = false) {
  const key = transport ? "transport" : String(kind || "");
  return Object.hasOwn(BADGE_SILHOUETTE, key) ? BADGE_SILHOUETTE[key] : null;
}

// ---- size ----------------------------------------------------------------------------------

// The badge's pixel size. `scale` is device pixels per cell (the view's own unit); `minPx` is the
// floor in the same unit. At a close zoom the badge is BADGE_CELLS cells across, so it keeps the
// footprint the 3x3 block had; at the whole-world fit the floor takes over, which is what keeps the
// type readable instead of falling back to dots.
export function badgePx(scale, minPx = BADGE_MIN_PX) {
  const cell = Math.max(1, Number(scale) || 1);
  const floor = Math.max(1, Number(minPx) || BADGE_MIN_PX);
  return Math.max(floor, cell * BADGE_CELLS);
}

// How many cells a badge covers, rounded up: the size a hit test and the overlap rule need.
export function badgeCells(scale, minPx = BADGE_MIN_PX) {
  return badgePx(scale, minPx) / Math.max(1, Number(scale) || 1);
}

// ---- stacking ------------------------------------------------------------------------------

// One badge per footprint (PM ruling, room 3946): where two friendly badges would overlap, draw one
// for the group, with the stack disc, and let hover name the whole stack. The group's face is the
// piece with the highest strength, so the strongest unit on a contested dot is the one a player sees.
//
// Opposing sides never join: two sides in one cell is a fight, and the board has to show both.
export function badgeGroups(pieces, scale, minPx = BADGE_MIN_PX) {
  const list = (Array.isArray(pieces) ? pieces : []).filter((piece) =>
    piece && Number.isFinite(Number(piece.x)) && Number.isFinite(Number(piece.y)));
  const size = badgePx(scale, minPx);
  const half = size / 2;
  const cell = Math.max(1, Number(scale) || 1);
  const groups = [];
  for (const piece of list) {
    const px = Number(piece.x) * cell;
    const py = Number(piece.y) * cell;
    let home = null;
    for (const group of groups) {
      if (group.side !== piece.side) continue;
      // Boxes overlap when both centres are closer than one badge width on each axis. `half` twice
      // is one badge width, which is exactly the point where the two bodies touch.
      if (Math.abs(group.px - px) < size && Math.abs(group.py - py) < size) { home = group; break; }
    }
    const strength = Number.isFinite(Number(piece.strength)) ? Number(piece.strength) : 0;
    if (home) {
      home.pieces.push(piece);
      home.px = (home.px * (home.pieces.length - 1) + px) / home.pieces.length;
      home.py = (home.py * (home.pieces.length - 1) + py) / home.pieces.length;
      if (strength > home.strength) {
        home.top = piece;
        home.strength = strength;
      }
    } else {
      groups.push({ side: piece.side === "red" ? "red" : "blue", top: piece, strength,
        pieces: [piece], px, py, half });
    }
  }
  for (const group of groups) {
    group.count = group.pieces.length;
    // The anchor stays on a real cell when the group has one piece, and the group's mean cell when
    // it does not: a badge drifting off the units it stands for is worse than a crowded board.
    group.x = group.count === 1 ? Number(group.top.x) : group.px / cell;
    group.y = group.count === 1 ? Number(group.top.y) : group.py / cell;
    group.kind = group.top.kind;
    group.transport = isTransportBadge(group.top);
  }
  return groups;
}

// The ids of the pieces that own a badge's face. Everything else in a group is behind the disc, and
// its own bar/entrench/pin chrome would be drawn under the badge it belongs to.
export function badgeTops(groups) {
  const tops = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group && group.top && group.top.id !== undefined) tops.add(group.top.id);
  }
  return tops;
}

// ---- state ---------------------------------------------------------------------------------

// The state a badge paints. Selection wins over combat, which wins over moving: a selected unit is
// the one the player is about to order, and that is the strongest thing the frame can say.
export function badgeState(piece, opts = {}) {
  if (!piece) return "idle";
  const selectedId = opts.selectedId;
  if (selectedId !== undefined && selectedId !== null && String(piece.id) === String(selectedId)) return "selected";
  if (piece.fighting !== null && piece.fighting !== undefined && piece.fighting !== false) return "combat";
  if (Array.isArray(piece.path) && piece.path.length > 0) return "moving";
  if (piece.moving === true) return "moving";
  return "idle";
}

// The strength band, for the bar under the badge. A bar with no green in it is near destruction,
// which is what the original's strength bar did by receding.
export function strengthBand(strength, maxStrength) {
  const max = Number(maxStrength);
  const value = Number(strength);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value)) return null;
  const fraction = Math.max(0, Math.min(1, value / max));
  const colour = fraction >= 0.5 ? "#2f9e44" : fraction >= 0.25 ? "#d98410" : "#c92a2a";
  return { fraction, colour };
}

// Only infantry digs in, so only infantry carries the dug-in bar (PM ruling, room 3946; the runtime
// agrees - combat.mjs and move.mjs refuse any other kind).
export function showsEntrench(piece) {
  return Boolean(piece && piece.entrenched === true && ENTRENCH_KINDS.includes(String(piece.kind)));
}

// ---- SVG (legend, and the mockup sheet) ----------------------------------------------------

function svgPoly(points, attrs) {
  return `<polygon points="${points.map(([x, y]) => `${round(x)},${round(y)}`).join(" ")}" ${attrs}/>`;
}
function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

function svgShape(shape, side, interior) {
  const fill = shape.invert ? interior : BADGE_SIDE[side].dark;
  const stroke = shape.strokeOnly ? BADGE_SIDE[side].dark : "none";
  const common = `fill="${shape.strokeOnly ? "none" : fill}" stroke="${stroke}"`;
  if (shape.t === "rect") {
    return `<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" rx="${round(shape.r)}" ${common}${shape.strokeOnly ? ' stroke-width="1.5"' : ""}/>`;
  }
  if (shape.t === "circle") {
    return `<circle cx="${round(shape.cx)}" cy="${round(shape.cy)}" r="${round(shape.r)}" ${common}/>`;
  }
  if (shape.t === "ellipse") {
    return `<ellipse cx="${round(shape.cx)}" cy="${round(shape.cy)}" rx="${round(shape.rx)}" ry="${round(shape.ry)}" ${common}${shape.strokeOnly ? ' stroke-width="1.6"' : ""}/>`;
  }
  if (shape.t === "poly") {
    return svgPoly(shape.pts, common);
  }
  const dash = shape.dash ? ` stroke-dasharray="${shape.dash.join(",")}"` : "";
  return `<line x1="${round(shape.x1)}" y1="${round(shape.y1)}" x2="${round(shape.x2)}" y2="${round(shape.y2)}" stroke="${BADGE_SIDE[side].dark}" stroke-width="${round(shape.w)}" stroke-linecap="round"${dash}/>`;
}

/**
 * One badge as a standalone SVG. The legend and the mockup sheet use this; the board uses the canvas
 * painter in render.mjs, walking the same primitives.
 *
 * opts: { kind, side, state, entrenched, stack, px, transport, title }
 */
export function badgeSvg({
  kind = "infantry", side = "blue", state = "idle", entrenched = false,
  stack = 0, px = 24, transport = false, title = "",
} = {}) {
  const s = BADGE_SIDE[side] || BADGE_SIDE.blue;
  const domain = transport ? "sea" : (BADGE_DOMAIN[kind] || "land");
  const interior = BADGE_INTERIOR[domain] || BADGE_INTERIOR.land;
  const shapes = badgeSilhouette(kind, transport) || UNKNOWN_SILHOUETTE;
  const frame = framePolygon(side);
  const inner = insetPolygon(frame, 0.9);

  const marks = [];
  const band = strengthBand(state === "damaged" ? 55 : state === "hurt" ? 30 : state === "critical" ? 10 : 100, 100);
  const bar = state === "damaged" || state === "hurt" || state === "critical"
    ? `<rect x="5" y="${entrenched ? 24.4 : 22.4}" width="14" height="2.2" rx="0.6" fill="#2a2f3a"/>
       <rect x="5" y="${entrenched ? 24.4 : 22.4}" width="${round(14 * band.fraction)}" height="2.2" rx="0.6" fill="${band.colour}"/>`
    : "";
  if (entrenched && ENTRENCH_KINDS.includes(String(kind))) {
    marks.push(`<rect x="5" y="0.4" width="14" height="2.0" rx="0.6" fill="#1f7a3a"/>`);
  }
  if (state === "moving") {
    marks.push(`<g stroke="#8fd3ff" stroke-width="1.6" stroke-linecap="round" fill="none">
      <path d="M20.6,4.6 L23.2,2.0"/><path d="M20.6,9.2 L23.8,6.0"/><path d="M15.8,1.8 L18.8,1.8"/></g>`);
  }
  if (state === "combat") {
    marks.push(`<path d="M18.4,1.0 L20.2,4.6 L23.8,6.4 L20.2,8.2 L18.4,11.8 L16.6,8.2 L13.0,6.4 L16.6,4.6 Z" fill="#ffd43b" stroke="#7a4d00" stroke-width="0.7"/>`);
  }
  if (state === "selected") {
    marks.push(svgPoly(selectedRing(side), `fill="none" stroke="#ffffff" stroke-width="1.7"`));
  }
  if (Number(stack) > 1) {
    marks.push(`<circle cx="19.4" cy="19.4" r="4.3" fill="#101623" stroke="#ffffff" stroke-width="1"/>
      <text x="19.4" y="21.7" text-anchor="middle" font-family="ui-monospace,monospace" font-size="5.6" font-weight="700" fill="#ffffff">${Number(stack) > 9 ? "9+" : Number(stack)}</text>`);
  }

  const height = entrenched || bar ? 28 : 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 ${height}" width="${px}" height="${round(px * height / 24)}" shape-rendering="geometricPrecision" role="img"${title ? ` aria-label="${title.replace(/"/g, "'")}"` : ""}>
    ${svgPoly(frame, `fill="${s.frame}" stroke="${s.ink}" stroke-width="1"`)}
    ${svgPoly(inner, `fill="${interior}"`)}
    <g>${shapes.map((shape) => svgShape(shape, side, interior)).join("")}</g>
    ${bar}
    ${marks.join("\n    ")}
  </svg>`;
}

// The legend's rows: every kind, both sides, as one list the page and the test can walk. The
// transport state is a row of its own because it is a state a player meets, not a shop kind.
export function badgeLegendRows() {
  const rows = [];
  for (const kind of [...BADGE_KINDS, "transport"]) {
    for (const side of ["blue", "red"]) {
      rows.push({ kind, side, label: BADGE_LABEL[kind], transport: kind === "transport" });
    }
  }
  return rows;
}

// ---- hover ---------------------------------------------------------------------------------

// What the tooltip says for the badge under the pointer: the type and the strength, which is the
// pair the spec asks for (AC6). A stacked footprint names every piece in it, strongest first, so the
// disc's number is never all a player can get.
export function badgeHoverText(group) {
  if (!group || !group.top) return "";
  const name = (piece) => (isTransportBadge(piece)
    ? BADGE_LABEL.transport
    : BADGE_LABEL[String(piece && piece.kind || "")] || "Unidentified unit");
  const strengthOf = (piece) => {
    const max = Number(piece && piece.maxStrength);
    const now = Number(piece && piece.strength);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(now)) return "";
    return "strength " + Math.round(now) + "/" + Math.round(max);
  };
  const topStrength = strengthOf(group.top);
  if (Number(group.count) > 1) {
    const parts = [...group.pieces]
      .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))
      .map((piece) => {
        const strength = strengthOf(piece);
        return name(piece) + (strength ? " " + strength.replace("strength ", "") : "");
      });
    return group.count + " units: " + parts.join(", ");
  }
  const state = [];
  if (group.top && group.top.pinned === true) state.push("pinned");
  if (group.top && showsEntrench(group.top)) state.push("dug in");
  if (group.top && group.top.repairing === true) state.push("repairing");
  const tail = state.length ? " · " + state.join(", ") : "";
  return name(group.top) + (topStrength ? " · " + topStrength : "") + tail;
}
