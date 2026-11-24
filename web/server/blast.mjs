// Radius blast geometry, shared by the killer satellite (PB-231) and the nuke's damage arm
// (PB-230). Owner: game, 2026-11-24.
//
// The archive's rule, in the card's own words (Manual L343-345 + p.29): a killer satellite picks a
// destination, starts over its home capital, travels fast, detonates on arrival, and kills every
// satellite of BOTH sides within about six cells; if the target moves, it retargets. The booklet
// never printed the count, so the radius lives in config (`blast.radius`) and every event says
// STAND-IN out loud rather than hiding an invented number in a comment.
//
// Nothing here decides WHEN a blast happens, WHO may fire, or what a launch costs. This module is
// geometry plus removal, so one primitive serves a satellite detonation and any later radius damage
// without a second copy of the same loop.

import { rules } from "./rules.mjs";

export const STAND_IN = "STAND-IN";

// The map's own vertical limit, as the nuke path already enforces it.
const MAX_Y = 135;

// The archived radius, or null when config does not set a usable one. A caller that cannot read a
// radius refuses rather than inventing one.
export function blastRadius() {
  const cfg = rules().blast || {};
  const radius = Number(cfg.radius);
  if (!Number.isInteger(radius) || radius < 1) return null;
  return radius;
}

// A square radius: the archive's own blast art is drawn around a cell, and every tool that reads a
// radius in this build (capital exclusion, satellite pass) counts cells in both axes.
export function inSquare(at, cell, radius) {
  if (!at || !cell) return false;
  const ax = Number(at.x);
  const ay = Number(at.y);
  const cx = Number(cell.x);
  const cy = Number(cell.y);
  if (![ax, ay, cx, cy].every(Number.isFinite)) return false;
  return Math.abs(cx - ax) <= radius && Math.abs(cy - ay) <= radius;
}

function cellOf(at) {
  if (!at) return null;
  const x = Number(at.x);
  const y = Number(at.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (y < 0 || y > MAX_Y) return null;
  return { x, y };
}

function order(a, b) {
  const ida = Number(a && a.id);
  const idb = Number(b && b.id);
  const na = Number.isFinite(ida) ? ida : Number.MAX_SAFE_INTEGER;
  const nb = Number.isFinite(idb) ? idb : Number.MAX_SAFE_INTEGER;
  if (na !== nb) return na - nb;
  return String((a && a.kind) || "").localeCompare(String((b && b.kind) || ""));
}

// Which pieces a blast catches, and which survive. Pure: it reads the array, never writes it, so a
// caller can grade the geometry (or dry-run it) without touching the board.
//
// options:
//   radius  - integer cells; defaults to config `blast.radius`
//   sides   - sides caught, both by default. A killer satellite kills its OWN side's satellites too.
//   kinds   - kinds caught, every kind when null/absent.
export function blastHits(pieces, at, options = {}) {
  const cell = cellOf(at);
  if (!cell) return { ok: false, error: "A blast needs a target cell on the map." };
  const radius = options.radius === undefined ? blastRadius() : Number(options.radius);
  if (!Number.isInteger(radius) || radius < 1) {
    return { ok: false, error: "No blast radius is set in config." };
  }
  const sides = Array.isArray(options.sides) && options.sides.length
    ? options.sides.slice()
    : ["blue", "red"];
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? new Set(options.kinds) : null;

  const killed = [];
  const survivors = [];
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (!piece) continue;
    const caught = sides.includes(piece.side)
      && (!kinds || kinds.has(piece.kind))
      && inSquare(cell, piece, radius);
    if (caught) killed.push(piece);
    else survivors.push(piece);
  }
  killed.sort(order);
  return { ok: true, cell, radius, killed, survivors };
}

// The mutating form: remove what the blast caught from the match and hand back one event that
// names the radius as a stand-in. `by` is the side that fired; the killed list keeps every side.
export function radiusKill(match, at, options = {}) {
  if (!match) return { error: "There is no match." };
  if (match.over) return { error: "The match is over." };
  const hits = blastHits(match.pieces, at, options);
  if (!hits.ok) return { error: hits.error };
  match.pieces = hits.survivors;
  const killed = hits.killed.map((piece) => ({
    id: piece.id,
    side: piece.side,
    kind: piece.kind,
    x: piece.x,
    y: piece.y,
    strength: piece.strength,
  }));
  const radius = hits.radius;
  const event = {
    type: "blast",
    side: options.by || null,
    x: hits.cell.x,
    y: hits.cell.y,
    radius,
    killed,
    note: `Blast of ${radius} cells. The ${radius} is a ${STAND_IN}: the archive kept the rule but never printed the count.`,
  };
  return { ok: true, radius, killed, events: [event] };
}
