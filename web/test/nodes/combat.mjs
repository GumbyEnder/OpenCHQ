// Node test for `combat` (order 150). Owner: A4.
//
// What breaks if this node is removed: two hostile pieces that stop one cell short would
// stand forever with no shot note at all, and nothing would record `foughtRound` or the
// per-piece shot count. Each assertion below names the fact it pins down.

import { adjacent, resolve, SHOT_NOTE, FIGHT_OVER_NOTE, OVERRUN_NOTE } from "../../server/combat.mjs";
import { hitsToKill } from "../../server/rules.mjs";

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

  // --- the archive's stand-in fight: after HITS shots the defender is gone -------------
  // docs/POLISH_LOOP.md: "after that many shots in one continuous fight, the defender is
  // removed". The mover is the attacker, so the stationary piece defends.
  const limit = hitsToKill();
  if (limit !== 6) fail("HITS left 6; WEB_HANDOFF says raising it changes the desktop result: " + limit);
  const duel = [piece("blue:land", "blue", 40, 40), piece("red:land", "red", 41, 40)];
  duel[0].movedRound = 7; // blue advanced into contact; red has been sitting there
  const duelMatch = matchOf(duel, 1);
  let killed = null;
  for (let round = 1; round <= 2 * limit + 2 && !killed; round++) {
    duelMatch.round = round;
    const out = resolve(duelMatch);
    killed = out.find((event) => event.type === "destroyed") || null;
    if (killed && round < 2 * limit - 1) fail("a piece died before HITS shots landed: round " + round);
  }
  if (!killed) fail("a continuous fight never removed the defender");
  if (killed.side !== "red") fail("the mover did not survive; the defender must be the stationary piece: " + JSON.stringify(killed));
  if (killed.note !== FIGHT_OVER_NOTE) fail("the removal line is not the archive's: " + killed.note);
  if (duelMatch.pieces.length !== 1) fail("removal left " + duelMatch.pieces.length + " pieces");
  if (duelMatch.pieces[0].id !== "blue:land") fail("the wrong piece survived: " + JSON.stringify(duelMatch.pieces));
  if (duelMatch.pieces[0].fighting !== null || duelMatch.pieces[0].shots !== 0) {
    fail("the survivor kept the dead piece's fight bookkeeping", duelMatch.pieces[0]);
  }

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

  // --- overrun: surplus force breaks a cell, and 1v1 never does -----------------------
  // The archive had overrun (the owner's list of missing combat depth names it). How much more
  // force it took was never recovered, so the rule counts: strictly more friendly pieces on the
  // defender's cell than the defender has, with both combatants excluded from the count.
  const twoOnOne = matchOf(
    [
      piece("blue:land", "blue", 10, 10),
      piece("blue:land:2", "blue", 10, 11),
      piece("red:land", "red", 11, 10),
    ],
    1,
  );
  twoOnOne.pieces[0].movedRound = 1; // blue is the attacker
  twoOnOne.pieces[2].movedRound = 0;
  const broken = resolve(twoOnOne);
  if (!broken.some((event) => event.type === "overrun")) say("two against one did not overrun", JSON.stringify(broken.map((e) => e.type)));
  if (twoOnOne.pieces.length !== 2) say("the overrun did not remove the defender", twoOnOne.pieces.length);
  if (!twoOnOne.pieces.every((unit) => unit.side === "blue")) say("the overrun removed the wrong piece");
  const overrunEvent = broken.find((event) => event.type === "overrun");
  if (overrunEvent && overrunEvent.by !== "blue:land") say("the overrun did not name the attacker", overrunEvent.by);
  if (/\d/.test(String(OVERRUN_NOTE))) say("the overrun note invented a number: " + OVERRUN_NOTE);

  // Even numbers do not break: 2v2 is a fight, not an overrun.
  const twoOnTwo = matchOf(
    [
      piece("blue:land", "blue", 10, 10),
      piece("blue:land:2", "blue", 10, 11),
      piece("red:land", "red", 11, 10),
      piece("red:land:2", "red", 11, 11),
    ],
    1,
  );
  twoOnTwo.pieces[0].movedRound = 1;
  twoOnTwo.pieces[2].movedRound = 0;
  const even = resolve(twoOnTwo);
  if (even.some((event) => event.type === "overrun")) say("an even fight overran");

  // A plain 1v1 still grinds: the existing hits rule is what removes the defender.
  const oneOnOne = matchOf([piece("blue:land", "blue", 10, 10), piece("red:land", "red", 11, 10)], 1);
  oneOnOne.pieces[0].movedRound = 1;
  oneOnOne.pieces[1].movedRound = 0;
  const grind = resolve(oneOnOne);
  if (grind.some((event) => event.type === "overrun")) say("a 1v1 overran, which makes every fight instant");
  if (oneOnOne.pieces.length !== 2) say("a 1v1 was decided in one exchange");
}
