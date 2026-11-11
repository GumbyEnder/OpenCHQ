// Click-to-command, the page's half. Pure helpers only: the canvas never guesses a route,
// it asks the server (`op: "route"`) and draws what comes back. Everything here is
// testable without a DOM by passing a stub canvas.
//
// What this node exists for: a player must be able to select one of their own pieces, see
// what an order would cost, send it, and be told plainly when the server refuses it.

import { pixelToCell, wrapX } from "./render.mjs";
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
export function purchaseText(kind, at, cash) {
  const noun = unitPhrase(kind);
  const cellAt = cell(at);
  const where = cellAt ? " at " + cellAt.x + "," + cellAt.y : "";
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
