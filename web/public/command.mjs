// Click-to-command, the page's half. Pure helpers only: the canvas never guesses a route,
// it asks the server (`op: "route"`) and draws what comes back. Everything here is
// testable without a DOM by passing a stub canvas.
//
// What this node exists for: a player must be able to select one of their own pieces, see
// what an order would cost, send it, and be told plainly when the server refuses it.

import { pixelToCell, wrapX } from "./render.mjs";

export const PICK_HINT = "Select one of your pieces.";
export const REFUSED = "The order was refused.";

function cell(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: wrapX(x), y: Math.trunc(y) };
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

export function orderMessage(piece, target) {
  const to = cell(target);
  if (!piece || !to) return null;
  return { op: "order", piece: piece.id, to };
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
  if (Number.isFinite(seat.cash)) parts.push("pool " + seat.cash);
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
  if (entry.refused) return entry.kind + " - " + entry.refused;
  return Number.isFinite(entry.price) ? entry.kind + " " + entry.price : entry.kind;
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
