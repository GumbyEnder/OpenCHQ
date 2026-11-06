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

// The one line the board note carries while a destination is hovered.
export function previewLine(preview) {
  if (!preview) return "";
  if (preview.error) return refusalText({ error: preview.error });
  const rounds = Math.max(0, Math.trunc(Number(preview.rounds) || 0));
  if (rounds === 0) return "Already on that cell.";
  return "Route: " + roundsText(rounds) + ". Click to send the order.";
}
