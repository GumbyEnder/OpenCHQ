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
  return { op: "mission", piece: piece.id, mode: String(mode), to };
}

export function routeRequest(piece, target) {
  const to = cell(target);
  if (!piece || !to) return null;
  return { op: "route", piece: piece.id, to };
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

export function purseText(seat) {
  if (!seat || (seat.cash === null && seat.fuel === null && seat.payIn === null)) return "";
  const parts = [];
  if (Number.isFinite(seat.cash)) parts.push("pool " + formatBillions(seat.cash) + "b");
  if (Number.isFinite(seat.fuel)) parts.push("fuel " + seat.fuel);
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

// A piece at sea is cargo: it cannot fight back, and the first enemy ship that catches it sinks
// it. That is the whole reason an escort matters, and the page should say it out loud.
export function cargoNote(piece) {
  if (!piece || piece.transport !== true) return "";
  return "At sea as a transport: it cannot fight back, and an enemy ship that catches it sinks it.";
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
