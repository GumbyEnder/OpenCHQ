// Node test for `combat` (order 150, rewritten for T-003). Owner: A4.
//
// What breaks if this node is removed: two hostile pieces that stop one cell short would stand
// forever with no shot at all, nothing would record `foughtRound`, and a fight would never end.
// The numbers come from config.combat; this test asserts the shape of a fight, not a figure.

import { adjacent, distance, resolve, SHOT_NOTE, FIGHT_OVER_NOTE } from "../../server/combat.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "combat";

function piece(id, side, x, y, kind = "infantry") {
  return {
    id,
    side,
    domain: "land",
    kind,
    x,
    y,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
  };
}

function matchOf(pieces, round = 1) {
  return {
    era: "1986",
    round,
    clock: "running",
    pieces,
    capitals: { blue: { x: 79, y: 44 }, red: { x: 183, y: 25 } },
    sides: { blue: {}, red: {} },
    sites: [],
    foughtRound: -1,
    winner: null,
    over: false,
  };
}

const shotsOf = (events) => events.filter((event) => event.type === "shot");

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();
  const say = (what, actual) => fail(what + ": " + JSON.stringify(actual));

  // --- adjacency and reach: Chebyshev, X wraps, Y does not -------------------------------
  if (!adjacent({ x: 10, y: 10 }, { x: 11, y: 10 })) say("side neighbours are not adjacent", [10, 10, 11, 10]);
  if (!adjacent({ x: 10, y: 10 }, { x: 10, y: 11 })) say("vertical neighbours are not adjacent", [10, 10, 10, 11]);
  if (!adjacent({ x: 10, y: 10 }, { x: 11, y: 11 })) say("diagonal neighbours are not adjacent", [10, 10, 11, 11]);
  if (!adjacent({ x: 319, y: 4 }, { x: 0, y: 4 })) say("X did not wrap across the seam", [319, 0]);
  if (!adjacent({ x: 0, y: 4 }, { x: 319, y: 5 })) say("diagonal across the seam is not adjacent", [0, 319]);
  if (adjacent({ x: 10, y: 10 }, { x: 10, y: 10 })) say("a piece is adjacent to itself", [10, 10]);
  if (adjacent({ x: 10, y: 10 }, { x: 12, y: 10 })) say("two cells apart counted as adjacent", [10, 12]);
  if (adjacent({ x: 10, y: 0 }, { x: 10, y: 135 })) say("Y wrapped, which it must not", [0, 135]);
  if (adjacent(null, { x: 1, y: 1 })) say("a null piece counted as adjacent", null);
  if (distance({ x: 319, y: 4 }, { x: 0, y: 4 }) !== 1) say("distance did not wrap X", distance({ x: 319, y: 4 }, { x: 0, y: 4 }));

  // --- contact: two hostile pieces fire, and neither moves -------------------------------
  const pair = [piece("blue:land", "blue", 10, 10), piece("red:land", "red", 11, 10)];
  const match = matchOf(pair, 1);
  const events = resolve(match);
  const shots = shotsOf(events);
  if (shots.length !== 2) say("one round of contact did not produce a shot from each side", events);
  const fromBlue = shots.find((event) => event.side === "blue");
  const fromRed = shots.find((event) => event.side === "red");
  if (!fromBlue || fromBlue.pieceId !== "blue:land") say("blue shot event is wrong", shots);
  if (!fromRed || fromRed.pieceId !== "red:land") say("red shot event is wrong", shots);
  if (fromBlue.at.x !== 11 || fromBlue.at.y !== 10) say("blue's shot did not land on the enemy cell", fromBlue.at);
  if (fromRed.at.x !== 10 || fromRed.at.y !== 10) say("red's shot did not land on the enemy cell", fromRed.at);
  if (pair[0].x !== 10 || pair[0].y !== 10 || pair[1].x !== 11 || pair[1].y !== 10) {
    say("resolve moved a piece; stopping one short is move.mjs's job and fighting stays put", pair);
  }
  if (match.foughtRound !== 1) say("foughtRound did not record the round the shot resolved", match.foughtRound);
  for (const event of shots) {
    if (event.note !== SHOT_NOTE) say("shot event lost its note", event);
    if (!(event.amount > 0)) say("a shot carried no damage", event);
  }
  if (pair[0].strength !== cfg.maxStrength - cfg.baseDamage.infantry) say("blue's bar did not drop by base damage", pair[0].strength);
  if (pair[1].strength !== cfg.maxStrength - cfg.baseDamage.infantry) say("red's bar did not drop by base damage", pair[1].strength);

  // --- one continuous fight: a shot every other round, never twice in a row --------------
  const fight = [piece("blue:land", "blue", 40, 40), piece("red:land", "red", 41, 40)];
  const fightMatch = matchOf(fight, 1);
  const firedOn = [];
  for (let round = 1; round <= 6; round++) {
    fightMatch.round = round;
    const roundEvents = shotsOf(resolve(fightMatch));
    if (roundEvents.length > 0) {
      firedOn.push(round);
      if (roundEvents.length !== 2) say("round " + round + " fired " + roundEvents.length + " times for one pair", roundEvents);
    }
  }
  if (JSON.stringify(firedOn) !== JSON.stringify([1, 3, 5])) {
    say("shots did not fall on every other round of one continuous fight", firedOn);
  }
  if (fightMatch.foughtRound !== 5) say("foughtRound is not the last round a shot landed", fightMatch.foughtRound);
  if (fight[0].fighting !== "red:land" || fight[1].fighting !== "blue:land") say("pieces did not record who they are fighting", [fight[0].fighting, fight[1].fighting]);

  // --- a break ends the fight; a later meeting starts a new one --------------------------
  const gap = matchOf([piece("blue:land", "blue", 40, 40), piece("red:land", "red", 41, 40)], 1);
  resolve(gap);
  gap.round = 2;
  gap.pieces[1].x = 60; // synthetic separation; move.mjs owns real movement
  const parted = resolve(gap);
  if (parted.length !== 0) say("pieces that are no longer in contact still fought", parted);
  if (gap.pieces[0].fighting !== null || Number(gap.pieces[0].fightRounds || 0) !== 0) {
    say("a broken fight kept its bookkeeping", gap.pieces[0]);
  }
  gap.round = 3;
  gap.pieces[1].x = 41;
  const again = shotsOf(resolve(gap));
  if (again.length !== 2) say("re-engaging did not fire", again);

  // --- a fight ends on strength, not on a shot count -------------------------------------
  // A tank (more damage) against infantry: the tank lands its killing hit first, so the duel has
  // a survivor to check. The archive's removal line is gone; strength decides.
  const duel = [piece("blue:land", "blue", 40, 40, "tank"), piece("red:land", "red", 41, 40, "infantry")];
  duel[0].movedRound = 7; // blue advanced into contact; red has been sitting there
  const duelMatch = matchOf(duel, 1);
  let killed = null;
  let rounds = 0;
  while (!killed && rounds < 40) {
    rounds += 1;
    duelMatch.round = rounds;
    killed = resolve(duelMatch).find((event) => event.type === "destroyed") || null;
  }
  if (!killed) fail("a continuous fight never removed a piece");
  if (killed.note !== FIGHT_OVER_NOTE) fail("the removal line is not this module's: " + killed.note);
  if (duelMatch.pieces.length !== 1) fail("removal left " + duelMatch.pieces.length + " pieces");
  const survivor = duelMatch.pieces[0];
  if (survivor.fighting !== null) fail("the survivor kept the dead piece's fight bookkeeping");
  // Full strength, the tank's damage a hit, one hit every other round: the last hit ends it.
  const expectedHits = Math.ceil(cfg.maxStrength / cfg.baseDamage.tank);
  if (rounds !== expectedHits * cfg.shotEveryRounds - 1) {
    fail("the fight took " + rounds + " rounds, expected " + (expectedHits * cfg.shotEveryRounds - 1));
  }

  // --- friends and enemies out of reach never fire ---------------------------------------
  const friends = [piece("blue:land", "blue", 10, 10), piece("blue:tank", "blue", 11, 10, "tank")];
  const friendlyMatch = matchOf(friends, 1);
  if (resolve(friendlyMatch).length !== 0) say("two friendly pieces shot at each other", friends);
  if (friends[0].fighting !== null) say("a friendly pair recorded a fight", friends[0]);
  const apart = [piece("blue:land", "blue", 10, 10), piece("red:land", "red", 10 + cfg.landEngageCells + 1, 10)];
  const apartMatch = matchOf(apart, 1);
  if (resolve(apartMatch).length !== 0) say("enemies beyond the engagement range fired", apart);
  if (apart[0].fighting !== null) say("enemies beyond the engagement range recorded a fight", apart[0]);

  // --- the seam is a real front: 319 and 0 are adjacent ----------------------------------
  const seam = matchOf([piece("blue:land", "blue", 319, 7), piece("red:land", "red", 0, 7)], 1);
  const seamShots = shotsOf(resolve(seam));
  if (seamShots.length !== 2) say("enemies across the X seam did not fire", seamShots);

  // --- empty rosters and finished matches are quiet, not crashes -------------------------
  const empty = matchOf([], 1);
  if (resolve(empty).length !== 0) say("an empty roster produced events", empty.pieces);
  if (empty.foughtRound !== -1) say("an empty roster touched foughtRound", empty.foughtRound);
  const done = matchOf([piece("blue:land", "blue", 10, 10), piece("red:land", "red", 11, 10)], 4);
  done.over = true;
  if (resolve(done).length !== 0) say("a finished match kept fighting", done);
  if (done.foughtRound !== -1) say("a finished match touched foughtRound", done.foughtRound);

  // --- an unknown kind has no damage until the config gives it one ------------------------
  const unknown = matchOf([piece("blue:land", "blue", 10, 10, null), piece("red:land", "red", 11, 10, null)], 1);
  const unknownEvents = resolve(unknown);
  if (unknownEvents.some((event) => event.type === "shot" || event.type === "destroyed")) {
    say("an untyped piece invented damage", unknownEvents);
  }
}
