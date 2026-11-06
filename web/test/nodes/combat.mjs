// Node test for `combat` (order 150). Owner: A4.
//
// What breaks if this node is removed: two hostile pieces that stop one cell short would
// stand forever with no shot note at all, and nothing would record `foughtRound` or the
// per-piece shot count. Each assertion below names the fact it pins down.

import { adjacent, resolve, SHOT_NOTE } from "../../server/combat.mjs";

export const name = "combat";

function piece(id, side, x, y) {
  return {
    id,
    side,
    domain: "land",
    kind: null,
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
const DAMAGE_KEYS = ["hits", "hp", "health", "damage", "dead", "killed", "strength"];

export async function run(ctx) {
  const { fail } = ctx;
  const say = (what, actual) => fail(what + ": " + JSON.stringify(actual));

  // --- adjacency: Chebyshev 1, X wraps, Y does not -------------------------------------
  if (!adjacent({ x: 10, y: 10 }, { x: 11, y: 10 })) say("side neighbours are not adjacent", [10, 10, 11, 10]);
  if (!adjacent({ x: 10, y: 10 }, { x: 10, y: 11 })) say("vertical neighbours are not adjacent", [10, 10, 10, 11]);
  if (!adjacent({ x: 10, y: 10 }, { x: 11, y: 11 })) say("diagonal neighbours are not adjacent", [10, 10, 11, 11]);
  if (!adjacent({ x: 319, y: 4 }, { x: 0, y: 4 })) say("X did not wrap across the seam", [319, 0]);
  if (!adjacent({ x: 0, y: 4 }, { x: 319, y: 5 })) say("diagonal across the seam is not adjacent", [0, 319]);
  if (adjacent({ x: 10, y: 10 }, { x: 10, y: 10 })) say("a piece is adjacent to itself", [10, 10]);
  if (adjacent({ x: 10, y: 10 }, { x: 12, y: 10 })) say("two cells apart counted as adjacent", [10, 12]);
  if (adjacent({ x: 10, y: 0 }, { x: 10, y: 135 })) say("Y wrapped, which it must not", [0, 135]);
  if (adjacent(null, { x: 1, y: 1 })) say("a null piece counted as adjacent", null);

  // --- contact: two hostile pieces on adjacent cells fire, and neither moves -----------
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
    say("resolve moved a piece; stopping one cell short is move.mjs's job and fighting stays put", pair);
  }
  if (match.foughtRound !== 1) say("foughtRound did not record the round the shot resolved", match.foughtRound);

  // --- the shot note carries no digit, and no piece holds a damage figure --------------
  for (const event of shots) {
    if (event.note !== SHOT_NOTE) say("shot event lost the archive's note", event);
    if (/\d/.test(String(event.note))) say("the shot note invented a digit", event.note);
  }
  if (!/no damage yet/.test(SHOT_NOTE)) say("the shot note stopped saying the shot has no damage", SHOT_NOTE);
  for (const unit of pair) {
    for (const key of DAMAGE_KEYS) {
      if (Object.hasOwn(unit, key)) say("a piece grew a damage field named " + key, unit);
    }
  }

  // --- one continuous fight: a shot every other round, never twice in a row ------------
  const fight = [piece("blue:land", "blue", 40, 40), piece("red:land", "red", 41, 40)];
  const fightMatch = matchOf(fight, 1);
  const firedOn = [];
  for (let round = 1; round <= 6; round++) {
    fightMatch.round = round;
    const before = { x: fight[0].x, y: fight[0].y };
    const roundEvents = resolve(fightMatch);
    if (roundEvents.length > 0) {
      firedOn.push(round);
      if (roundEvents.length !== 2) say("round " + round + " fired " + roundEvents.length + " times for one pair", roundEvents);
    }
    if (fight[0].x !== before.x || fight[0].y !== before.y) say("a fight moved blue on round " + round, fight[0]);
  }
  if (JSON.stringify(firedOn) !== JSON.stringify([1, 3, 5])) {
    say("shots did not fall on every other round of one continuous fight", firedOn);
  }
  if (fight[0].shots !== 3 || fight[1].shots !== 3) say("per-piece shot count is not 3 after six rounds", [fight[0].shots, fight[1].shots]);
  if (fight[0].fighting !== "red:land" || fight[1].fighting !== "blue:land") say("pieces did not record who they are fighting", [fight[0].fighting, fight[1].fighting]);
  if (fightMatch.foughtRound !== 5) say("foughtRound is not the last round a shot landed", fightMatch.foughtRound);

  // --- a break ends the fight; a later meeting starts a new one ------------------------
  const gap = matchOf([piece("blue:land", "blue", 40, 40), piece("red:land", "red", 41, 40)], 1);
  resolve(gap);
  gap.round = 2;
  gap.pieces[1].x = 60; // synthetic separation; move.mjs owns real movement
  const parted = resolve(gap);
  if (parted.length !== 0) say("pieces that are no longer adjacent still fought", parted);
  if (gap.pieces[0].fighting !== null || gap.pieces[0].shots !== 0) {
    say("a broken fight kept its bookkeeping", gap.pieces[0]);
  }
  gap.round = 3;
  gap.pieces[1].x = 41;
  const again = shotsOf(resolve(gap));
  if (again.length !== 2) say("re-engaging did not fire", again);
  if (gap.pieces[0].shots !== 1) say("a new continuous fight inherited old shots", gap.pieces[0].shots);

  // --- friends and distant enemies never fire -----------------------------------------
  const friends = [piece("blue:land", "blue", 10, 10), piece("blue:tank", "blue", 11, 10)];
  const friendlyMatch = matchOf(friends, 1);
  if (resolve(friendlyMatch).length !== 0) say("two friendly pieces shot at each other", friends);
  if (friends[0].fighting !== null) say("a friendly pair recorded a fight", friends[0]);
  const apart = [piece("blue:land", "blue", 10, 10), piece("red:land", "red", 12, 10)];
  const apartMatch = matchOf(apart, 1);
  if (resolve(apartMatch).length !== 0) say("enemies two cells apart fired", apart);
  if (apart[0].fighting !== null) say("enemies two cells apart recorded a fight", apart[0]);

  // --- the seam is a real front: 319 and 0 are adjacent -------------------------------
  const seam = matchOf([piece("blue:land", "blue", 319, 7), piece("red:land", "red", 0, 7)], 1);
  const seamShots = shotsOf(resolve(seam));
  if (seamShots.length !== 2) say("enemies across the X seam did not fire", seamShots);

  // --- empty rosters and finished matches are quiet, not crashes ----------------------
  const empty = matchOf([], 1);
  if (resolve(empty).length !== 0) say("an empty 2023 roster produced events", empty.pieces);
  if (empty.foughtRound !== -1) say("an empty roster touched foughtRound", empty.foughtRound);
  const done = matchOf([piece("blue:land", "blue", 10, 10), piece("red:land", "red", 11, 10)], 4);
  done.over = true;
  if (resolve(done).length !== 0) say("a finished match kept fighting", done);
  if (done.foughtRound !== -1) say("a finished match touched foughtRound", done.foughtRound);

  // --- and the roster is never shortened: removal waits on a measured hit count -------
  const roster = [piece("blue:land", "blue", 10, 10), piece("red:land", "red", 11, 10)];
  const rosterMatch = matchOf(roster, 1);
  for (let round = 1; round <= 8; round++) {
    rosterMatch.round = round;
    resolve(rosterMatch);
  }
  if (rosterMatch.pieces.length !== 2) say("combat removed a piece on damage that does not exist", rosterMatch.pieces.length);
  if (rosterMatch.over) say("combat ended the match on a hit count that was never measured", rosterMatch.over);
}
