// Aircraft are a resource, not a piece. Owner: integrator (node `air`, order 275).
//
// A mission costs the aircraft its flying time - it is INACTIVE for a number of rounds and
// cannot be ordered anywhere until that expires. The counts are the booklet's, from
// docs/POLISH_LOOP.md: an air mission is inactive 8 rounds, a scramble 4. Nothing here carries
// a damage number: a strike either catches cargo (which cannot defend itself) or does nothing
// that can be measured, and says so.

import { CELL_W } from "./board.mjs";
import { rules } from "./rules.mjs";

// Booklet counts. A stand-in would be labelled as one; these are stored facts.
const MODES = Object.freeze({
  strike: { rounds: 8, type: "strike" },
  patrol: { rounds: 4, type: "scramble" },
});

export const STRIKE_NOTE = "Stand-in strike. The shot has no damage yet.";
export const REACH_NOTE = "Stand-in reach. The aircraft range was not recovered.";

export function isAircraft(piece) {
  return Boolean(piece) && piece.kind === "aircraft";
}

function airReach() {
  const value = Number((rules().air || {}).reach);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// The counts the badge shows: rounds left before this aircraft can fly again.
export function inactiveRounds(piece, round) {
  if (!piece) return 0;
  const until = Number(piece.inactiveUntil);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.floor(until - (Number(round) || 0)));
}

function chebyshev(a, b) {
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, CELL_W - dx);
  return Math.max(wrap, Math.abs(Number(a.y) - Number(b.y)));
}

// A mission has to be flown from somewhere: a friendly city, dock or ship within reach.
function baseFor(match, side, from) {
  const reach = airReach();
  if (reach <= 0) return null;
  const candidate = (cell) => cell && chebyshev(from, cell) <= reach;
  const home = (match.sites || []).find(
    (site) => site && site.owner === side && (site.kind === "city" || site.kind === "dock" || site.kind === "docks") && candidate(site),
  );
  if (home) return home;
  return (match.pieces || []).find(
    (unit) => unit && unit.side === side && unit.domain === "sea" && unit.transport !== true && candidate(unit),
  ) || null;
}

// Send one mission. Returns { ok, piece, events } or { error }.
export function sendMission(match, side, pieceId, mode, target) {
  if (!match || !Array.isArray(match.pieces)) return { error: "There is no match to fly in." };
  if (match.over) return { error: "The match is over." };
  const plane = match.pieces.find((piece) => piece && piece.id === String(pieceId));
  if (!plane) return { error: "No such aircraft: " + pieceId + "." };
  if (plane.side !== side) return { error: "That aircraft belongs to " + plane.side + "." };
  if (!isAircraft(plane)) return { error: "Only an aircraft flies a mission." };

  const remaining = inactiveRounds(plane, match.round);
  if (remaining > 0) return { error: `That aircraft is inactive for ${remaining} more rounds.` };

  const mission = MODES[String(mode)];
  if (!mission) return { error: "Missions are strike or patrol." };

  const at = target && Number.isInteger(Number(target.x)) && Number.isInteger(Number(target.y))
    ? { x: Number(target.x), y: Number(target.y) }
    : { x: plane.x, y: plane.y };
  if (at.y < 0 || at.y > 135) return { error: "The target is off the map." };

  const base = baseFor(match, side, plane);
  if (!base) return { error: "No friendly city, dock or ship within reach." };

  const events = [];
  plane.inactiveUntil = (Number(match.round) || 0) + mission.rounds;
  plane.facing = plane.facing ?? null;
  events.push({
    type: mission.type,
    side,
    pieceId: plane.id,
    mode: String(mode),
    x: at.x,
    y: at.y,
    rounds: mission.rounds,
    until: plane.inactiveUntil,
    note: mission.type === "strike" ? STRIKE_NOTE : REACH_NOTE,
  });

  // What a strike can actually do: cargo cannot defend itself. Anything else is a shot with
  // no damage figure, exactly as the archive's fights are.
  if (mission.type === "strike") {
    const caught = (match.pieces || []).find(
      (piece) => piece && piece.side !== side && piece.x === at.x && piece.y === at.y && piece.transport === true,
    );
    if (caught) {
      match.pieces = match.pieces.filter((piece) => piece.id !== caught.id);
      events.push({ type: "destroyed", side: caught.side, pieceId: caught.id, by: plane.id, x: caught.x, y: caught.y, note: "Stand-in strike. The transport is gone." });
    }
  }

  return { ok: true, piece: plane, events };
}

// Called once a round: says when an aircraft is flyable again, so the badge has an event.
export function tickAir(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces)) return events;
  const round = Number(match.round) || 0;
  for (const piece of match.pieces) {
    if (!isAircraft(piece)) continue;
    if (!Number.isFinite(Number(piece.inactiveUntil))) continue;
    if (inactiveRounds(piece, round) > 0) continue;
    if (piece.readyAnnounced === true) continue;
    piece.readyAnnounced = true;
    events.push({ type: "ready", side: piece.side, pieceId: piece.id, x: piece.x, y: piece.y });
  }
  return events;
}
