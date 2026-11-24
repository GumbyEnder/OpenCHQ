// Node test for the shared radius-blast primitive (PB-231, reused by PB-230).
//
// The test grades the geometry, not a launch: which cells a blast catches, which sides, which
// kinds, and that the radius is read from config rather than typed into the module. Every number
// it compares comes out of rules().blast.radius, so a tunable change is a test that follows the
// file, and a missing radius is a refusal, not a silent default.

import { blastHits, blastRadius, inSquare, radiusKill, STAND_IN } from "../../server/blast.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "pb231_radius_kill";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function piece(id, side, kind, x, y, extra = {}) {
  return { id, side, kind, x, y, domain: "land", path: [], pace: 1, strength: 100, ...extra };
}

function matchOf(pieces, extra = {}) {
  return {
    era: "1986",
    round: 3,
    clock: "running",
    pieces,
    sites: [],
    capitals: { blue: { x: 10, y: 10 }, red: { x: 40, y: 40 } },
    sides: { blue: { cash: 1000 }, red: { cash: 1000 } },
    over: false,
    ...extra,
  };
}

export async function run() {
  const radius = blastRadius();
  must(Number.isInteger(radius) && radius >= 1, "config blast.radius must be an integer >= 1, got " + radius);
  must(rules().blast && String(rules().blast.source || "").includes(STAND_IN),
    "config blast.source must name the radius a " + STAND_IN);
  // The binding itself, not the module's own answer re-read: a hardcoded 6 must red as soon as
  // config says 7 (gate 8951 §4, m1b).
  must(blastRadius() === Number(rules().blast.radius),
    "blastRadius must return config blast.radius: config " + rules().blast.radius
      + ", module " + blastRadius());

  // AC: the square radius is inclusive at the edge and one cell beyond it is outside.
  const at = { x: 50, y: 50 };
  must(inSquare(at, { x: 50 + radius, y: 50 }, radius), "the radius cell is inside the square");
  must(!inSquare(at, { x: 50 + radius + 1, y: 50 }, radius), "one cell past the radius is outside");
  must(inSquare(at, { x: 50 + radius, y: 50 + radius }, radius), "the square counts both axes");
  must(!inSquare(at, { x: NaN, y: 50 }, radius), "a non-finite cell is not inside");

  // AC: both sides are caught, the firer's own pieces included, and only what is inside.
  const board = [
    piece(1, "red", "sat", 50, 50),
    piece(2, "blue", "sat", 51, 49),
    piece(3, "red", "tank", 52, 52),
    piece(4, "blue", "tank", 90, 90),
  ];
  const all = blastHits(board, at);
  must(all.ok, "a blast on the map must resolve: " + all.error);
  must(all.killed.length === 3, "three pieces sit inside the radius, got " + all.killed.length);
  must(all.killed.map((p) => p.id).join(",") === "1,2,3", "kills are ordered by id, got " + all.killed.map((p) => p.id).join(","));
  must(all.survivors.length === 1 && all.survivors[0].id === 4, "the piece outside survives");

  // AC: the killed list is ordered by id, not by the order the board happens to sit in. The board
  // above is already ascending, so insertion order alone would pass it (gate 8951 §4, m7).
  const shuffled = [
    piece(3, "red", "tank", 52, 52),
    piece(1, "red", "sat", 50, 50),
    piece(2, "blue", "sat", 51, 49),
  ];
  const ordered = blastHits(shuffled, at);
  must(ordered.ok, "a blast on an out-of-order board must resolve: " + ordered.error);
  must(ordered.killed.map((p) => p.id).join(",") === "1,2,3",
    "kills are ordered by id even when the board is not, got " + ordered.killed.map((p) => p.id).join(","));

  // AC: a kind filter catches satellites only, both sides, and still honours the radius.
  const sats = blastHits(board, at, { kinds: ["sat"] });
  must(sats.ok, "a filtered blast must resolve");
  must(sats.killed.map((p) => p.id).join(",") === "1,2", "only both sides' satellites die, got " + sats.killed.map((p) => p.id).join(","));
  must(sats.survivors.length === 2, "both tanks survive a satellite-only blast");

  // AC: the pure form never mutates the array it was handed.
  must(board.length === 4, "blastHits must not touch the caller's array");

  // AC: the mutating form removes the caught pieces and emits one event that names the stand-in.
  const match = matchOf(board.slice());
  const fired = radiusKill(match, at, { kinds: ["sat"], by: "blue" });
  must(!fired.error, "a satellite blast must fire: " + fired.error);
  must(match.pieces.length === 2, "two pieces remain after the blast, got " + match.pieces.length);
  must(fired.killed.every((p) => p.kind === "sat"), "the event only reports satellites");
  const event = fired.events[0];
  must(event.type === "blast", "the event is a blast");
  must(event.radius === radius, "the event carries the config radius, got " + event.radius);
  must(event.side === "blue", "the event names the firer");
  must(String(event.note).includes(String(radius)) && String(event.note).includes(STAND_IN),
    "the event says the radius is a " + STAND_IN + ": " + event.note);

  // AC: fail closed. No cell, an off-map cell, a bad radius, a finished match and no match all refuse.
  must(!blastHits(board, null).ok, "a blast without a cell must refuse");
  must(!blastHits(board, { x: 4, y: 400 }).ok, "a cell off the map must refuse");
  must(!blastHits(board, { x: 4.5, y: 20 }).ok, "a fractional cell must refuse");
  must(!blastHits(board, at, { radius: 0 }).ok, "radius 0 must refuse");
  must(!blastHits(board, at, { radius: -3 }).ok, "a negative radius must refuse");
  const finished = radiusKill(matchOf([], { over: true }), at);
  must(Boolean(finished.error), "a blast on a finished match must refuse");
  const missing = radiusKill(null, at);
  must(Boolean(missing.error), "a blast with no match must refuse");

  // AC: an empty radius is still a detonation - it fires and reports nothing killed, rather than
  // silently turning a click into a no-op.
  const empty = radiusKill(matchOf([piece(9, "red", "sat", 200, 120)]), at);
  must(!empty.error, "an empty blast still fires");
  must(empty.killed.length === 0, "an empty blast kills nothing");
  must(empty.events.length === 1, "an empty blast still reports one event");
}
