// The decision around the sink rule.
//
// combat.mjs already decides what happens when a warship catches a transport: the transport goes
// down in the first exchange, because cargo does not shoot back. What the player could not do was
// anything about it — a crossing was a gamble with no way to hedge it. This module is the hedge: a
// warship ordered to travel with a transport, and the seat told when one is crossing unscreened.
//
// No number is invented here. Screening reuses the sight radius the game already uses (rules.mjs
// sightCells, 8 cells Chebyshev with X wrap) — a transport is screened when a friendly warship can
// see it or has been told to travel with it. The follower moves one cell a round like every other
// piece: it takes the transport's own next step, so an escort never finds a route of its own.
import { sightCells } from "./rules.mjs";

const SIDES = ["blue", "red"];

function pieceById(match, id) {
  const key = String(id ?? "");
  return (match && Array.isArray(match.pieces) ? match.pieces : []).find((unit) => String(unit.id) === key) || null;
}

// Chebyshev with the board's X wrap. Local because CELL_W lives with the board and this module
// should not pull the whole board in for one subtraction.
const CELL_W = 320;

function gap(a, b) {
  const rawX = Math.abs(Number(a.x) - Number(b.x));
  const dx = Math.min(rawX, CELL_W - rawX);
  return Math.max(dx, Math.abs(Number(a.y) - Number(b.y)));
}

// A warship: at sea, and not itself cargo.
export function isWarship(unit) {
  return Boolean(unit) && unit.domain === "sea" && unit.transport !== true;
}

// A transport: the flag move.mjs sets when a land piece is in the water.
export function isTransport(unit) {
  return Boolean(unit) && unit.transport === true;
}

// Order a warship to travel with a transport. Passing no transport releases the ship.
export function orderEscort(match, side, shipId, transportId) {
  if (!match) return { error: "There is no match to order." };
  if (!SIDES.includes(side)) return { error: "An escort needs a side." };

  const ship = pieceById(match, shipId);
  if (!ship) return { error: "No such ship." };
  if (ship.side !== side) return { error: "That ship is not yours." };
  if (!isWarship(ship)) return { error: "Only a warship can escort. That piece is cargo or ashore." };

  const released = transportId === null || transportId === undefined || transportId === "";
  if (released) {
    const was = ship.escorting ? pieceById(match, ship.escorting) : null;
    if (was && was.escortedBy === ship.id) delete was.escortedBy;
    delete ship.escorting;
    ship.path = [];
    return { ok: true, released: true, ship: ship.id };
  }

  const transport = pieceById(match, transportId);
  if (!transport) return { error: "No such transport." };
  if (transport.side !== side) return { error: "That transport is not yours." };
  if (!isTransport(transport)) return { error: "That piece is not a transport. An escort travels with cargo." };
  if (transport.id === ship.id) return { error: "A ship cannot escort itself." };

  // One escort per transport: a second warship replaces the first, and the first is told so.
  const previous = transport.escortedBy ? pieceById(match, transport.escortedBy) : null;
  if (previous && previous.id !== ship.id) delete previous.escorting;

  ship.escorting = transport.id;
  transport.escortedBy = ship.id;

  const event = {
    type: "escort",
    side,
    shipId: ship.id,
    transportId: transport.id,
    at: { x: Number(transport.x), y: Number(transport.y) },
    note: "An escort is travelling with the transport.",
  };
  // The order happens between rounds, so the round log collects it on the next tick.
  if (!Array.isArray(match.pendingEvents)) match.pendingEvents = [];
  match.pendingEvents.push(event);

  return { ok: true, ship: ship.id, transport: transport.id };
}

// Every round, before pieces advance: an escort holds station beside its transport, and steps where
// the transport steps. A transport that stopped being cargo (it landed) releases its escort.
export function followEscorts(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces)) return events;
  for (const ship of match.pieces) {
    if (!ship || !ship.escorting) continue;
    const transport = pieceById(match, ship.escorting);
    if (!transport || transport.side !== ship.side || !isTransport(transport)) {
      delete ship.escorting;
      continue;
    }
    if (transport.escortedBy !== ship.id) transport.escortedBy = ship.id;
    // Alongside: no path to take. Otherwise take the transport's own next step, so the escort
    // trails it by one cell instead of planning a route of its own.
    if (gap(ship, transport) <= 1) {
      ship.path = [];
      continue;
    }
    const step = Array.isArray(transport.path) && transport.path[0] ? transport.path[0] : { x: transport.x, y: transport.y };
    ship.path = [{ x: Number(step.x), y: Number(step.y), pace: 1 }];
    ship.pace = 1;
  }
  return events;
}

// Transports of this side crossing with no friendly warship able to see them and none escorting.
// These are the ones the seat is told about, because these are the ones a warship ends.
export function unscreenedTransports(match, side) {
  if (!match || !Array.isArray(match.pieces) || !SIDES.includes(side)) return [];
  const radius = Number(sightCells()) || 0;
  const mine = match.pieces.filter((unit) => unit && unit.side === side);
  const ships = mine.filter(isWarship);
  return mine
    .filter(isTransport)
    .filter((transport) => !ships.some((ship) => transport.escortedBy === ship.id || gap(ship, transport) <= radius))
    .map((transport) => transport.id);
}
