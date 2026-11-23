// Click-to-command, the page's half. Pure helpers only: the canvas never guesses a route,
// it asks the server (`op: "route"`) and draws what comes back. Everything here is
// testable without a DOM by passing a stub canvas.
//
// What this node exists for: a player must be able to select one of their own pieces, see
// what an order would cost, send it, and be told plainly when the server refuses it.

import { cellToPixel, pixelToCell, wrapX } from "./render.mjs";
import { BADGE_MIN_PX, badgePx } from "./badges.mjs";
import { articleFor, unitLabel, unitPhrase } from "./units.mjs";

export const PICK_HINT = "Select one of your pieces.";
export const REFUSED = "The order was refused.";

// Money is carried on the wire as integer millions (a city pays 50, an infantry costs 10000).
// The manual prints billions, so the page divides here and nowhere else: 1000 million = 1
// billion. Formatting trims trailing zeros, which is what makes 10 stay "10" and 150 become
// "0.15".
const MILLIONS_PER_BILLION = 1000;

export function formatBillions(millions) {
  const value = Number(millions);
  if (!Number.isFinite(value)) return "";
  const text = (value / MILLIONS_PER_BILLION).toFixed(3).replace(/\.?0+$/, "");
  return text === "" || text === "-0" ? "0" : text;
}

// Cash in whole billions, as Monitor Four shows it (Manual p.27). The original divides the money
// slot by 40 with an integer divide (`3711:16f3`: BALANCE = DS:0x148e / 0x28), so 400 units prints
// `10` and anything short of a whole billion prints the billion below it. Truncate, never round:
// 1,049 million is `1`, not `1` by luck and not `2`. Amounts under one billion print `0`, which is
// what the divide gives - UNVERIFIED against the original until a capture shows a sub-1b balance.
export function formatWholeBillions(millions) {
  const value = Number(millions);
  if (!Number.isFinite(value)) return "";
  return String(Math.trunc(value / MILLIONS_PER_BILLION));
}

// The article and the noun live in units.mjs, so the page and the server write one sentence with
// one rule (T-007 AC7). This module re-exports the article so a caller that only has command.mjs
// keeps working.
export { articleFor } from "./units.mjs";

// The one line a completed purchase shows. The pool is the server's cash in millions; T-001
// prints money in billions, so a raw 300 read as "300" and looked like 300 billion. F3 fixed the
// unit. F4 corrects the form: the original shows cash in whole billions, truncated (`3711:16f3`),
// so this line reads `Pool 10b`, not `Pool 0.3b`. Under one billion it prints `0b`, which matches
// the divide but is UNVERIFIED against a capture.
// PB-044 (T-021 AC8): the line names the SITE the unit was bought into, not its coordinates.
// The server sends the site's own name (or "a base near Kharkov" for an unnamed berth) as
// `at.site`; the coordinate form survives only as the fallback for a reply that carries no site.
export function purchaseText(kind, at, cash) {
  const noun = unitPhrase(kind);
  const site = at && typeof at === "object" && typeof at.site === "string" ? at.site.trim() : "";
  const cellAt = site ? null : cell(at);
  const where = site ? " at " + site : cellAt ? " at " + cellAt.x + "," + cellAt.y : "";
  const value = Number(cash);
  const pool = cash !== null && cash !== undefined && Number.isFinite(value)
    ? " Pool " + formatWholeBillions(value) + "b."
    : "";
  return "Bought " + noun + where + "." + pool;
}

function cell(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: wrapX(x), y: Math.trunc(y) };
}

// ---- placement click forgiveness (T-017, PB-029) -------------------------------------------
//
// D-019 does not move: land and air go on a friendly city or base cell, ships on a friendly dock
// cell. What moves is the CLICK TARGET. At the whole-world fit a cell is one pixel wide, so a
// player aiming at a city square missed it by one pixel and the server, correctly, refused.
//
// The server sends the mask and the forgiveness it wants in the same placement payload
// (`snap: {px, cells}`, `box: {px}`, from config.placement), so the page carries no copy of those
// numbers. A click inside the radius snaps to the nearest legal cell - ready or unready, in the
// domain the mask was built for, so a hull can still only find a dock and a land unit only a
// city or base. A click outside the radius is NOT swallowed here: it is sent as the cell the
// player actually clicked, and the server refuses it in its own words.

// How far a click may miss and still count, in screen pixels. Two ways to say the same distance:
// a flat pixel budget (what a hand and a mouse actually feel) and a cell count (what survives a
// zoom change), and the wider of the two wins.
export function snapRadiusPx(placement, view, override = null) {
  const snap = override || (placement && placement.snap) || {};
  const px = Number(snap.px);
  const cells = Number(snap.cells);
  const scale = Math.max(1, Number(view && view.scale) || 1);
  const budget = Number.isFinite(px) ? px : 12;
  const byCells = (Number.isFinite(cells) ? cells : 2) * scale;
  return Math.max(budget, byCells);
}

// The nearest legal placement cell to `target`, or null when nothing is in range. Pure: the mask
// comes from the server and the view from the canvas, so the answer is the one the page will use.
export function snapPlacementCell(target, placement, view, override = null) {
  const at = cell(target);
  if (!at || !placement || !placement.mask || !view) return null;
  const width = Number(placement.width) || 0;
  const height = Number(placement.height) || 0;
  if (width <= 0 || height <= 0) return null;
  const scale = Math.max(1, Number(view.scale) || 1);
  const limit = snapRadiusPx(placement, view, override);
  // Only the cells whose centre can be inside the radius need looking at. The radius is in
  // screen pixels, so it is this many cells wide at this zoom, and x wraps across the seam.
  const span = Math.ceil(limit / scale);
  let best = null;
  for (let dy = -span; dy <= span; dy++) {
    const y = at.y + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -span; dx <= span; dx++) {
      const x = wrapX(at.x + dx, width);
      const value = placement.mask[y * width + x];
      if (!value) continue;
      const distance = Math.sqrt(dx * dx + dy * dy) * scale;
      if (distance > limit + 1e-9) continue;
      if (!best || distance < best.distance) {
        best = { x, y, value, ready: value === 1, unready: value === 2, distance };
      }
    }
  }
  return best;
}

export function sameCell(a, b) {
  const one = cell(a);
  const two = cell(b);
  return Boolean(one && two && one.x === two.x && one.y === two.y);
}

// Event -> board cell. The canvas is CSS-scaled, so the pointer offset is mapped back into
// the canvas's own pixel space before the viewport maths.
export function cellAtEvent(event, canvas, view) {
  if (!event || !canvas || !view) return null;
  const rect = typeof canvas.getBoundingClientRect === "function"
    ? canvas.getBoundingClientRect()
    : { left: 0, top: 0, width: canvas.width, height: canvas.height };
  const width = Number(rect.width) || Number(canvas.width) || 1;
  const height = Number(rect.height) || Number(canvas.height) || 1;
  const px = (Number(event.clientX) - Number(rect.left)) * ((Number(canvas.width) || 1) / width);
  const py = (Number(event.clientY) - Number(rect.top)) * ((Number(canvas.height) || 1) / height);
  return pixelToCell(px, py, view);
}

// Only the seat's own pieces can be picked. An enemy piece on the same cell is not this
// player's to order, so selection returns nothing for it.
export function ownPieceAt(pieces, target, side) {
  if (!side) return null;
  const wanted = cell(target);
  if (!wanted) return null;
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || String(piece.side) !== String(side)) continue;
    if (sameCell(piece, wanted)) return piece;
  }
  return null;
}

// ---- selection hit area (T-028, PB-050) ---------------------------------------------------
//
// The click target is the icon the frame DRAWS, not the one map cell under the pointer. At the
// whole-world fit a badge is BADGE_MIN_PX wide - 3.73 cells - so a click squarely on a unit used
// to answer "Select one of your pieces." (PB-050, measured: 184 of 196 positions inside the drawn
// icon). This is the same box the hover uses (render.badgeAt), so the tip and the click agree.
//
// Rules, in this order:
//   * only the seat's own pieces are candidates; an enemy or empty cell selects nothing and the
//     page still says PICK_HINT;
//   * the pointer must be inside the piece's own icon box, half a badge each side of the cell
//     centre, measured in the same device pixels the painter draws in;
//   * of the boxes that contain the pointer, the NEAREST ICON CENTRE wins (Euclidean, in screen
//     pixels), so overlapping badges resolve the way the eye does;
//   * an exact tie means two pieces draw at the same centre: the air/ground stack T-021 made
//     legal. Ties are ordered air, sea, land - the air layer is the one a mission is issued from
//     and the one drawn in front - and a second click on the same footprint selects the NEXT piece
//     in that order, so the ground unit under a plane is still reachable.
const LAYER_ORDER = Object.freeze({ air: 0, sea: 1, land: 2 });

export function layerOfPiece(piece) {
  if (!piece) return "land";
  const domain = String(piece.domain || "").toLowerCase();
  if (domain === "air" || domain === "sea" || domain === "land") return domain;
  if (String(piece.kind) === "aircraft") return "air";
  if (["cruiser", "carrier", "submarine", "transport"].includes(String(piece.kind))) return "sea";
  return "land";
}

function layerRank(piece) {
  const rank = LAYER_ORDER[layerOfPiece(piece)];
  return Number.isFinite(rank) ? rank : LAYER_ORDER.land;
}

function idRank(piece) {
  return piece && piece.id !== undefined && piece.id !== null ? String(piece.id) : "";
}

// Every own piece whose drawn icon box contains the pointer, nearest centre first. Pure: the view
// is the canvas's own camera, so the box is the box the frame painted.
export function piecesAtPoint(pieces, view, px, py, opts = {}) {
  const side = opts.side;
  if (!side || !view) return [];
  const scale = Math.max(1, Number(view.scale) || 1);
  const half = badgePx(scale, Number(opts.badgeMinPx) || BADGE_MIN_PX) / 2;
  const width = Number(view.boardW) || 320;
  const hits = [];
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece || String(piece.side) !== String(side)) continue;
    const x = Number(piece.x);
    const y = Number(piece.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const centre = cellToPixel(wrapX(x, width), y, view);
    const dx = Number(px) - centre.x;
    const dy = Number(py) - centre.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    if (Math.abs(dx) > half || Math.abs(dy) > half) continue;
    hits.push({ piece, distance: Math.sqrt(dx * dx + dy * dy), centre });
  }
  hits.sort((a, b) => (a.distance - b.distance) || (layerRank(a.piece) - layerRank(b.piece))
    || idRank(a.piece).localeCompare(idRank(b.piece)));
  return hits;
}

// The piece a click on the board selects, or null when nothing of the seat's is under it.
export function pickPieceAt(pieces, view, px, py, opts = {}) {
  return pieceFromHits(piecesAtPoint(pieces, view, px, py, opts), opts.selectedId);
}

// Nearest icon centre wins; equal distances cycle, starting after the piece already selected.
// Shared by pickPieceAt and clickIntent so the tie order cannot drift between the two readers.
function pieceFromHits(hits, selectedId) {
  if (!hits.length) return null;
  const nearest = hits[0].distance;
  const tied = hits.filter((hit) => Math.abs(hit.distance - nearest) < 1e-6);
  if (tied.length === 1) return tied[0].piece;
  const at = tied.findIndex((hit) => selectedId !== undefined && selectedId !== null
    && String(hit.piece.id) === String(selectedId));
  return tied[(at + 1) % tied.length].piece;
}

// A board click has two meanings and the order between them is the rule (T-028 + PB-050): a piece
// under the icon is SELECTED, and any other cell under the already-selected piece's icon is a
// DESTINATION. Selecting first is right, but the selected piece's own badge box covers its
// neighbours, so it must not be a candidate for its own cell's neighbours: a selected unit would
// have no one-cell move anywhere (the badge is ~1.5 cells wide at every zoom past the world fit).
// The exception is the pointer's own cell being the selected piece's cell - there the click can
// only mean "this piece again" (or the next piece of a same-cell stack), and an order to a cell the
// unit already stands on is nothing.
//   -> {kind: "piece", piece}   select that piece
//   -> {kind: "cell", piece, cell}  the selected piece is ordered to `cell`
//   -> null                      nothing of the seat's under the pointer and nothing selected
export function clickIntent(pieces, view, px, py, opts = {}) {
  const side = opts.side;
  if (!side || !view) return null;
  const selectedId = opts.selectedId;
  const hasSelection = selectedId !== undefined && selectedId !== null;
  const cell = opts.cell || pixelToCell(px, py, view);
  const boardW = Number(view.boardW) || 320;
  let hits = piecesAtPoint(pieces, view, px, py, opts);
  // The selected piece's own cell is a selection surface, not a destination map (T-030 AC8 item 1).
  // The exception is the pointer's own cell being the selected piece's cell - there the click can
  // only mean "this piece again" (or the next piece of a same-cell stack), and an order to a cell
  // the unit already stands on is nothing.
  //
  // Two rules decide that cell and both are needed:
  //   * the pointer's own cell must be the piece's cell - a pointer on another cell is a
  //     destination, whatever its distance to the icon (PB-146: a surface that crosses the cell
  //     edge leaves a selected unit with no one-cell move anywhere);
  //   * the cell is measured in the pointer's OWN units, with the one whole CSS pixel a mouse event
  //     can lose counted inside the surface (PB-191). `ownCellSlop` is that pixel converted to
  //     canvas pixels by the caller. Measured on c1233c1 at 1280x800, dpr 1, world fit: a click 2
  //     CSS px off the icon centre is 1.78 canvas px off a 3 px cell's centre, the cell edge is at
  //     1.50, and the integer client coordinate the browser reports put the click on the cell
  //     above-left - so the page answered "Order sent. 1 round to walk. Selection cleared." for a
  //     cell the piece was standing on. The reserved radius (0.6 of a cell) never covered the
  //     cell's corner either, so the distance clause cannot be the whole decision.
  //
  // The reach is capped strictly below one whole cell, so absorbing the pointer's own pixel error
  // can never make a neighbouring cell unreachable: at scale 1 the neighbour's centre is still a
  // move. Another own piece's badge still wins - clicking a friend selects that friend (T-030 AC2,
  // PB-052) - because the stack partner is the nearest hit.
  if (hasSelection) {
    const scale = Math.max(1, Number(view.scale) || 1);
    const slop = Math.max(0, Number(opts.ownCellSlop) || 0);
    const own = (Array.isArray(pieces) ? pieces : [])
      .find((piece) => piece && String(piece.id) === String(selectedId));
    if (own) {
      const centre = cellToPixel(wrapX(Number(own.x), boardW), Number(own.y), view);
      const reach = Math.min(scale / 2 + slop, scale - 1e-6);
      const ownCell = wrapX(Number(own.x), boardW) === cell.x && Number(own.y) === Number(cell.y);
      const withinReach = Math.abs(Number(px) - centre.x) <= reach
        && Math.abs(Number(py) - centre.y) <= reach;
      // With no tolerance expressed, the pointer's own cell decides and nothing else: that is the
      // PB-146 pin, and it is what the node suite measures without passing `ownCellSlop`. The page
      // always passes one CSS pixel, and then a click that is inside the own cell's rectangle plus
      // that pixel is the piece even when the floored cell fell over the edge (PB-191).
      if (ownCell || (slop > 0 && withinReach)) {
        return { kind: "piece", piece: pieceFromHits(hits, selectedId) || own };
      }
    }
  }

  if (hasSelection) {
    hits = hits.filter((hit) => String(hit.piece.id) !== String(selectedId)
      || (wrapX(Number(hit.piece.x), boardW) === cell.x && Number(hit.piece.y) === cell.y));
  }
  const picked = pieceFromHits(hits, selectedId);
  if (picked) return { kind: "piece", piece: picked };
  if (!hasSelection) return null;
  const selected = (Array.isArray(pieces) ? pieces : [])
    .find((piece) => piece && String(piece.id) === String(selectedId));
  return selected ? { kind: "cell", piece: selected, cell } : null;
}

export function orderMessage(piece, target) {
  const to = cell(target);
  if (!piece || !to) return null;
  return { op: "order", piece: piece.id, to };
}

// An aircraft does not walk, so a click on a cell is not an order to move there: it is the target
// of the mission (Manual p.25, "an air strike on a land unit"). The plane's own cell is the base it
// flies from, never the cell it hits — a strike aimed at its own base would find nothing.
export function missionMessage(piece, mode, target) {
  const to = cell(target);
  if (!piece || !to || !mode) return null;
  // PB-172: `kind` names the order in the page's own late-answer sentence ("No answer yet for your
  // mission"), and the id is stamped by sendOrder.
  return { op: "mission", kind: "mission", piece: piece.id, mode: String(mode), to };
}

export function routeRequest(piece, target) {
  const to = cell(target);
  if (!piece || !to) return null;
  return { op: "route", piece: piece.id, to };
}

// PB-178: the manual's two air circles (p.25). A mission target must lie inside the RESTRICTED
// radius; only an unloaded transfer may use the MAXIMUM one. This is the page's half of the rule:
// it refuses a far click with a sentence BEFORE anything goes on the wire, so "no order went out"
// is a fact of the click and not a promise about the server. The server refuses it again on its
// own - the page is never the only guard. Both numbers arrive in the plane's briefing, so the page
// cannot disagree with the config the server charged. PB-188 (room 8383 §4): the circle is the air
// layer's rule, so `mode` picks the noun a strike and a bombing run each read in their own words.
export function restrictedTargetRefusal(piece, target, restricted, max, boardW, mode = "bomb") {
  const cells = Math.floor(Number(restricted));
  if (!piece || !target || !Number.isFinite(cells) || cells <= 0) return null;
  const width = Number(boardW) > 0 ? Number(boardW) : 320;
  const dx = Math.abs(Number(piece.x) - Number(target.x));
  const wrap = Math.min(dx, Math.abs(width - dx));
  const away = Math.max(wrap, Math.abs(Number(piece.y) - Number(target.y)));
  if (!Number.isFinite(away) || away <= cells) return null;
  const far = Math.floor(Number(max));
  const what = String(mode) === "strike" ? "an air strike" : "a bombing run";
  return "That target is " + away + " cells from the aircraft; " + what
    + " must be inside the restricted air radius ("
    + cells + " cells). Only a transfer may use the maximum radius ("
    + (Number.isFinite(far) && far > 0 ? far + " cells" : "a longer one") + ").";
}

// PB-193: what a click on the map does to the armed door. A refusal must not spend the intent it
// refused - a bombing run and an air strike are separate orders on the Air panel, so a far bomb
// click leaves the door armed for a bomb, and only the Strike door (or a clear) arms a strike.
// A send and an Escape both return to the everyday meaning of a click on an aircraft's map. This
// lives here as one pure function so the node suite can pin the transition the DOM cannot see.
export function nextDoorMode(pending, outcome) {
  if (outcome === "refused") {
    return pending === "bomb" || pending === "transfer" ? pending : "strike";
  }
  return "strike";
}

export function roundsText(rounds) {
  const value = Math.max(0, Math.trunc(Number(rounds) || 0));
  return value + (value === 1 ? " round" : " rounds");
}

// What the page says when its own order comes back acknowledged.
export function ackText(message) {
  const rounds = Math.max(0, Math.trunc(Number(message && message.rounds) || 0));
  if (rounds === 0) return "Order sent. That piece is already on that cell.";
  return "Order sent. " + roundsText(rounds) + " to walk.";
}

// A refusal is the server's sentence, verbatim. An empty error is never swallowed into
// silence: the page still says the order was refused.
export function refusalText(message) {
  const text = message && typeof message.error === "string" ? message.error.trim() : "";
  return text || REFUSED;
}

// ---- the shop's half ---------------------------------------------------------------------
// The panel draws only what the server sent: prices and the refusal sentence come from the
// shop payload, and the player's own pool comes from the seat. No figure is invented here and
// none is formatted as money - the archive's currency was never recovered.

// The oil budget in the original's own words: "In" is what the wells produce, "Out" what the
// cities and bases consume, and the reserve is what is left (Manual p.27). `foe` labels the row
// the Alternate Function shows, so two rows on screen can never be mistaken for each other.
export function oilText(oil, foe = false) {
  if (!oil || !Number.isFinite(oil.held)) return "";
  const label = foe ? "foe oil" : "oil";
  const parts = [label + " in " + (Number.isFinite(oil.in) ? oil.in : "?") +
    " / out " + (Number.isFinite(oil.out) ? oil.out : "?") +
    " / reserve " + oil.held];
  if (oil.cap !== null && Number.isFinite(oil.cap)) parts.push("of " + oil.cap);
  if (oil.short === true) parts.push("OIL SHORT");
  return parts.join(" ");
}

// The one sentence the red warning is allowed to say. It names the three effects in the order
// the original applies them (income first, then movement, then aircraft).
export const OIL_WARNING = "OIL: consumption is more than the reserve plus production - cities stop paying income and units stop moving.";

export function oilWarning(oil) {
  return oil && oil.short === true ? OIL_WARNING : "";
}

// purseText draws the seat's own budget; when the Alternate Function is on, the same chip draws
// the OPPONENT's numbers instead (Manual p.27), because the original's monitor swaps sides.
export function purseText(seat, showFoe = false) {
  if (!seat || (seat.cash === null && seat.fuel === null && seat.payIn === null)) return "";
  const parts = [];
  if (Number.isFinite(seat.cash)) parts.push("pool " + formatBillions(seat.cash) + "b");
  if (Number.isFinite(seat.fuel)) parts.push("fuel " + seat.fuel);
  const budget = showFoe ? seat.foeOil : seat.oil;
  if (budget) parts.push(oilText(budget, showFoe === true));
  // Every other resource kind the scenario carries, drawn from the same list the server builds.
  // Fuel is above already; a kind with no held number is left out rather than shown as zero.
  for (const meter of Array.isArray(seat.reserves) ? seat.reserves : []) {
    if (!meter || meter.kind === "fuel") continue;
    if (Number.isFinite(meter.held)) parts.push(meter.kind + " " + meter.held);
  }
  if (Number.isFinite(seat.payIn)) {
    parts.push("payment in " + seat.payIn + (seat.payIn === 1 ? " round" : " rounds"));
  }
  return parts.join(" · ");
}

// PB-180 (PM 8316 §1, option (a)): the strip is the original's main display, not its ledger. It
// carries a summary — your cash in whole billions and income per round, e.g. "116b +1.45b/rd" — and
// the long economy string above (oil in/out, reserves, the payday countdown) belongs in the chip's
// title and the Economy dialogue.
//
// Two rules this function exists to keep:
//   - the balance is always the PLAYER's own cash field. There is no code path here that can print
//     the opponent's balance, which is the one number the original keeps secret (Manual p.27).
//   - the Alternate Function swaps the INCOME leg to the other side's payday, because that is
//     public arithmetic off the board the player can already see; it never swaps the balance.
export function purseSummaryParts(seat, foeIncome = null) {
  const cash = seat ? Number(seat.cash) : NaN;
  const own = seat && seat.income ? Number(seat.income.amount) : NaN;
  const foe = foeIncome ? Number(foeIncome.amount) : NaN;
  const useFoe = Number.isFinite(foe) && foe > 0;
  const amount = useFoe ? foe : own;
  const income = Number.isFinite(amount) && amount > 0
    ? (useFoe ? " +foe " : " +") + formatBillions(amount) + "b/rd"
    : "";
  return { cash: Number.isFinite(cash) ? formatWholeBillions(cash) + "b" : "", income };
}

export function purseSummary(seat, foeIncome = null) {
  const parts = purseSummaryParts(seat, foeIncome);
  return (parts.cash + parts.income).trim();
}

// A piece at sea is cargo: it cannot fight back, and the first enemy ship that catches it sinks it.
// That is the whole reason an escort matters, and the page should say it out loud.
export function cargoNote(piece) {
  if (!piece || piece.transport !== true) return "";
  return "At sea as a transport: it cannot fight back, and an enemy ship that catches it sinks it.";
}

// PB-170: the page holds the selected piece as an OBJECT taken from the room frame the click
// landed on. A later frame replaces `room.pieces`, so that object stops moving: the board note went
// on saying "Away on a mission: 8 rounds" after the plane was ready again. Re-point the selection at
// the piece of the CURRENT frame by id; no piece under that id means nothing is selected any more.
export function refreshSelection(pieces, selected) {
  if (!selected || selected.id === undefined || selected.id === null) return null;
  const id = String(selected.id);
  const fresh = (Array.isArray(pieces) ? pieces : []).find((piece) => piece && String(piece.id) === id);
  return fresh || null;
}

// An aircraft on a mission is absent for a known number of rounds. Say the number: "inactive" as a
// word costs the player nothing to read and tells them nothing.
export function airNote(piece) {
  if (!piece || piece.kind !== "aircraft") return "";
  const left = Number(piece.inactive);
  if (Number.isFinite(left) && left > 0) {
    return "Away on a mission: " + left + (left === 1 ? " round" : " rounds") + " until it can fly again.";
  }
  // No number here: the mission lengths live in config/game.json's air block, and a page that
  // prints its own copy of them is a second source of truth for a tunable.
  return "Ready to fly. A mission keeps it away for a while — longer for a strike than a patrol.";
}

// The alarm strip: the one sentence a player needs when the enemy is closing on a capital. The
// server sends {name, distance}; nothing here invents a number.
export function alarmText(alarm) {
  if (!alarm) return "";
  const distance = Number(alarm.distance);
  if (!Number.isFinite(distance)) return "";
  const name = alarm.name || "your capital";
  if (distance === 0) return "Enemy troops are on " + name + ".";
  return "Enemy troops " + distance + (distance === 1 ? " cell" : " cells") + " from " + name + ".";
}

// A shop row names the unit and, when the server priced it, the price. A refused row says
// why instead of pretending it can be bought.
export function shopLabel(entry) {
  if (!entry || !entry.kind) return "";
  const label = unitLabel(entry.kind);
  if (entry.refused) return label + " - " + entry.refused;
  return Number.isFinite(entry.price) ? label + " " + formatBillions(entry.price) + "b" : label;
}

export function shopDisabled(entry, cash) {
  if (!entry) return true;
  if (entry.refused) return true;
  if (!Number.isFinite(cash) || !Number.isFinite(entry.price)) return false;
  return cash < entry.price;
}

// The order the page sends for a purchase. The server re-checks the site and the pool; this
// only carries the player's intent.
export function buyMessage(kind, target) {
  const at = cell(target);
  if (!kind || !at) return null;
  return { op: "buy", kind: String(kind), x: at.x, y: at.y };
}

// The one line the board note carries while a destination is hovered.
export function previewLine(preview) {
  if (!preview) return "";
  if (preview.error) return refusalText({ error: preview.error });
  const rounds = Math.max(0, Math.trunc(Number(preview.rounds) || 0));
  if (rounds === 0) return "Already on that cell.";
  return "Route: " + roundsText(rounds) + ". Click to send the order.";
}

// The two sentences that say a piece is selected. They live here, next to PICK_HINT, because the
// toast and the board note used to disagree: after a selection the toast still read "Select one of
// your pieces" while the note named a route (PB-053). One helper per surface, one phrase naming the
// unit, and a test reads both after select, reselect, clear and order.
export function selectionToast(piece) {
  if (!piece) return "";
  return unitLabel(piece.kind) + " selected. Pick a destination.";
}

export function selectionNote(piece) {
  if (!piece) return "";
  return unitLabel(piece.kind) + " selected — hover a destination to see the route.";
}

// PB-163: clicking a city outside Buy mode names it and says whether it can produce yet. The note
// lives here - beside the other one-line board sentences - so the wording is a pure function the
// suite can read, not a string buried in a click handler.
//
// Readiness is the server's own field: `site.readyRound` is the first round the site may produce
// again (readiness.mjs), so a site with no field, or one whose round has passed, is ready. The page
// never recomputes the pooled arithmetic; it only reads the round the server wrote.
const SITE_KINDS = Object.freeze({
  capital: "capital",
  city: "city",
  base: "base",
  facility: "oil field",
  oilfield: "oil field",
  well: "oil field",
  dock: "dock",
  docks: "dock",
});
// Cities, capitals and bases produce; an oil field and a dock take no readiness timer.
const PRODUCING = new Set(["city", "capital", "base"]);

function siteKindLabel(site) {
  const kind = String((site && site.kind) || "").toLowerCase();
  return SITE_KINDS[kind] || "site";
}

function siteOwnerLabel(site) {
  const owner = String((site && site.owner) || "").toLowerCase();
  if (owner === "blue") return "blue";
  if (owner === "red") return "red";
  return "unheld";
}

// The site whose cell the click landed on. A city is one map cell in the site table; the drawn blob
// around it belongs to the same site, so the record's own (x,y) is the match the page can trust.
export function siteAtCell(sites, cell) {
  if (!Array.isArray(sites) || !cell) return null;
  const x = Number(cell.x);
  const y = Number(cell.y);
  return sites.find((site) => site && Number(site.x) === x && Number(site.y) === y) || null;
}

// PB-175: the site a click on a PIECE's own cell is standing on. At the world fit a badge is wider
// than its cell, so a garrisoned city could never be inspected: every click on it resolved to the
// piece (PB-163's site line only ran when nothing was selected). The page cycles instead - the first
// click selects the unit, a second click on the same cell asks this function what the piece stands
// on. The cell test is the piece's own cell (wrapped, so a world seam is not a miss), never the
// badge box: a click a cell away is still a move order (PB-146).
export function siteUnderPiece(sites, piece, cell, boardW) {
  if (!piece || !cell) return null;
  const width = Number(boardW) || 320;
  if (wrapX(Number(piece.x), width) !== Number(cell.x)) return null;
  if (Number(piece.y) !== Number(cell.y)) return null;
  return siteAtCell(sites, cell);
}

export function siteInspectText(site, round) {
  if (!site) return "";
  const name = String(site.name || "A site");
  const head = name + " — " + siteKindLabel(site) + ", " + siteOwnerLabel(site) + ".";
  const kind = String(site.kind || "").toLowerCase();
  if (!PRODUCING.has(kind)) {
    return head + " No production timer.";
  }
  const now = Number.isFinite(Number(round)) ? Math.floor(Number(round)) : 0;
  const at = Number(site.readyRound);
  if (!(Number.isFinite(at) && at > now)) {
    return head + " Ready.";
  }
  const rounds = Math.floor(at) - now;
  return head + " Unready — ready at round " + Math.floor(at) + " (" + roundsText(rounds) + ").";
}
