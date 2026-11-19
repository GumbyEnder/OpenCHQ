// Node pb149_engagement: one attacker, one defender per exchange.
//
// PB-149 (Shane, 2026-11-19 4:12 PM ET): "1 infantry attack 2 enemy infantry, and all 3 died."
// Manual p.13: "An enemy can only fire at one of your units at a time." The rule this node pins is
// the one the ticket asks for: in a round where a single attacker fires, exactly one defender takes
// its fire. The second thing it records is the shape that actually can kill all three, which is not
// a same-round double hit: it is two full exchanges with the defenders already at the attrition
// floor (20) and the attacker at 60, so the attacker kills one defender per beat and the two
// defenders' return fire kills the attacker on the second beat.
import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { tickMatch } from "../../server/tick.mjs";

export const name = "pb149_engagement";

function fail(message) {
  throw new Error(message);
}

function ok(cond, message) {
  if (!cond) fail(message);
}

function unit(id, side, x, y, strength) {
  return {
    id, side, domain: "land", kind: "infantry", x, y,
    path: [], pace: 1, facing: null, fighting: null, shots: 0,
    strength, maxStrength: 100, pinned: false,
  };
}

// Plain ground, no site under it: (180,23), (181,23), (179,23) are terrain 8 on the bundled board
// and carry no attrition, so the only strength changes in the run are the exchange itself.
function board(blue, reds) {
  const match = openMatch("1986", JSON.parse(JSON.stringify(matchSites("1986"))));
  match.clock = "running";
  match.pieces = [unit("blue:infantry:1", "blue", 180, 23, blue),
    unit("red:infantry:1", "red", 181, 23, reds[0]),
    unit("red:infantry:2", "red", 179, 23, reds[1])];
  return match;
}

function runRounds(match, rounds) {
  const rows = [];
  for (let i = 0; i < rounds; i += 1) {
    const { events } = tickMatch(match);
    const shots = events.filter((event) => event.type === "shot");
    const dead = events.filter((event) => event.type === "destroyed");
    rows.push({ round: match.round, shots, dead, pieces: match.pieces.map((piece) => ({ id: piece.id, strength: piece.strength })) });
  }
  return rows;
}

// One attacker's fire in one round must reach exactly one defender.
function oneTargetPerAttacker(rows, attackerId) {
  for (const row of rows) {
    const fromAttacker = row.shots.filter((shot) => shot.pieceId === attackerId);
    const targets = new Set(fromAttacker.map((shot) => shot.target));
    if (targets.size > 1) {
      fail("pb149_engagement: round " + row.round + " — the lone attacker fired at " + targets.size + " defenders (" + [...targets].join(", ") + ")");
    }
  }
}

export async function run() {
  // --- full strength: 1 v 2 cannot wipe all three, and each beat is one defender -------------
  const fresh = board(100, [100, 100]);
  const freshRows = runRounds(fresh, 12);
  oneTargetPerAttacker(freshRows, "blue:infantry:1");

  const firstBeat = freshRows.find((row) => row.shots.length > 0);
  ok(Boolean(firstBeat), "pb149_engagement: the full-strength 1 v 2 never fired");
  const freshTargets = new Set(firstBeat.shots.filter((shot) => shot.pieceId === "blue:infantry:1").map((shot) => shot.target));
  ok(freshTargets.size === 1, "pb149_engagement: the attacker's first exchange hit " + freshTargets.size + " defenders, not 1");
  // Both defenders fire back: that is the manual's "an enemy can only fire at one of your units at
  // a time" per enemy, not a cap on how many enemies may pick the same target.
  ok(firstBeat.shots.filter((shot) => shot.target === "blue:infantry:1").length === 2,
    "pb149_engagement: both defenders should be able to pick the one attacker");

  const freshDead = freshRows.flatMap((row) => row.dead);
  ok(freshDead.length === 1 && freshDead[0].pieceId === "blue:infantry:1",
    "pb149_engagement: a full-strength 1 v 2 should end with only the attacker destroyed, got " + freshDead.map((event) => event.pieceId).join(", "));
  const freshRed = fresh.pieces.filter((piece) => piece.side === "red");
  ok(freshRed.length === 2, "pb149_engagement: both full-strength defenders should survive");

  // --- the measured 3-death shape: two exchanges, defenders on the floor ---------------------
  // Attrition floors a unit on an enemy site at 20 (config attritionFloor), so a defender can be
  // alive at 20 while a 55-strength attacker arrives. Beat 1 kills red:1 (the attacker takes 40);
  // beat 2 kills red:2 and red:2's return fire (15: the attacker entrenched after standing still
  // through round 1) kills it. That is two rounds of one-defender-per-beat fire, not one attacker
  // damaging two defenders in a round.
  const floored = board(55, [20, 20]);
  const flooredRows = runRounds(floored, 8);
  oneTargetPerAttacker(flooredRows, "blue:infantry:1");
  const flooredDead = flooredRows.flatMap((row) => row.dead.map((event) => ({ round: row.round, id: event.pieceId })));
  ok(flooredDead.length === 3, "pb149_engagement: the floor case should destroy all three units, got " + flooredDead.length);
  const beats = flooredRows.filter((row) => row.shots.length > 0);
  ok(beats.length === 2, "pb149_engagement: the floor case should take two exchange rounds, got " + beats.length);
  ok(flooredDead.filter((event) => event.round === beats[1].round).length === 2,
    "pb149_engagement: the second exchange must be the allowed same-round double kill (attacker + its target)");
}
