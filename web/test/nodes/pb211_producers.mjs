// Node test: PB-211 gate (f) — the producers that are not combat.resolve carry the fields the log
// reads instead of a board lookup, and the militia never reads as a fight line.
//
// This is the read-out half of PB-211, pinned separately from the beat rule so the rule commit can
// be backed out without the producer pins and vice versa. What it holds:
//   * the overrun path's two shot events name targetSide/attackerKind/targetKind, and both of its
//     destroyed events name the kind that was lost - the log builds after the dead are filtered, so
//     a missing field is a blank line, not a cosmetic one;
//   * the militia's shot names targetSide/targetKind and attackerKind "militia" and pays the
//     configured amount;
//   * a militia event never becomes a "landed a hit" line for either seat. log.mjs has TWO gates
//     for that (the grouping pass that builds the shot map, and the emit branch); each one alone
//     keeps the militia silent, which is measured in the gate evidence for this card - the pin says
//     the behaviour, so a change that removes both is red.

import { advance, issueOrder } from "../../server/move.mjs";
import { resolve } from "../../server/combat.mjs";
import { logLines } from "../../server/log.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb211_producers";

function unit(id, side, kind, x, y, extra = {}) {
  return {
    id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null,
    fighting: null, shots: 0, strength: combatRules().maxStrength,
    maxStrength: combatRules().maxStrength,
    ...extra,
  };
}

function matchOf(pieces, extra = {}) {
  return {
    era: "1986", round: 1, clock: "running", pieces, sites: [], capitals: {},
    sides: { blue: {}, red: {} }, foughtRound: -1, over: false, winner: null, ...extra,
  };
}

const shotsOf = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.type === "shot");
const pairShots = (events, a, b) =>
  shotsOf(events).filter((e) => (e.pieceId === a && e.target === b) || (e.pieceId === b && e.target === a));

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();

  // --- the overrun's shot events name both sides and both nouns ------------------------------
  {
    const tank = unit("blue:tank:9", "blue", "tank", 30, 70);
    const foot = unit("red:infantry:9", "red", "infantry", 31, 70);
    const match = matchOf([tank, foot], { round: 1 });
    const order = issueOrder(match, "blue", "blue:tank:9", 34, 70);
    if (order.error) fail("pb211: the tank refused the order: " + order.error);
    const events = advance(match) || [];
    const shots = pairShots(events, "blue:tank:9", "red:infantry:9");
    if (shots.length !== 2) fail("pb211: the overrun did not produce one exchange: " + JSON.stringify(events.map((e) => e.type)));
    for (const shot of shots) {
      if (!shot.targetSide) fail("pb211: overrun shot has no targetSide: " + JSON.stringify(shot));
      if (!shot.attackerKind) fail("pb211: overrun shot has no attackerKind: " + JSON.stringify(shot));
      if (!shot.targetKind) fail("pb211: overrun shot has no targetKind: " + JSON.stringify(shot));
      if (shot.targetSide === shot.side) fail("pb211: overrun shot names its own side as the target's: " + JSON.stringify(shot));
    }
    const mine = shots.find((e) => e.side === "blue");
    const theirs = shots.find((e) => e.side === "red");
    if (mine.attackerKind !== "tank" || mine.targetKind !== "infantry") {
      fail("pb211: the tank's overrun shot reads " + JSON.stringify([mine.attackerKind, mine.targetKind]));
    }
    if (theirs.attackerKind !== "infantry" || theirs.targetKind !== "tank") {
      fail("pb211: the foot's answer reads " + JSON.stringify([theirs.attackerKind, theirs.targetKind]));
    }
  }

  // --- an overrun that kills names what it killed -------------------------------------------
  {
    const tank = unit("blue:tank:3", "blue", "tank", 30, 72);
    const foot = unit("red:infantry:3", "red", "infantry", 31, 72, { strength: 1, maxStrength: 1 });
    const match = matchOf([tank, foot], { round: 1 });
    const order = issueOrder(match, "blue", "blue:tank:3", 33, 72);
    if (order.error) fail("pb211: the tank refused the order: " + order.error);
    const events = advance(match) || [];
    const lost = events.find((e) => e.type === "destroyed" && e.pieceId === "red:infantry:3");
    if (!lost) fail("pb211: the overrun did not report the loss: " + JSON.stringify(events.map((e) => e.type)));
    if (lost.kind !== "infantry") fail("pb211: the overrun's destroyed event carries kind " + JSON.stringify(lost.kind));
    if (lost.side !== "red") fail("pb211: the overrun's destroyed event names the wrong side: " + lost.side);
  }

  // --- the militia is a producer too, and it never prints a fight line -----------------------
  // The militia's shot carries targetSide/targetKind and attackerKind "militia"; the fields are
  // what make the event readable at all once the attacker it shot has left the board.
  {
    const cell = 51;
    const city = { id: cell, kind: "city", owner: "red", name: "Garrison", x: 61, y: 80 };
    const attacker = unit("blue:infantry:7", "blue", "infantry", 60, 80);
    const defender = unit("red:infantry:7", "red", "infantry", 61, 80);
    const match = matchOf([attacker, defender], { round: 3, sites: [city] });
    const events = resolve(match) || [];
    const militia = shotsOf(events).filter((e) => e.militia === true);
    if (militia.length !== 1) fail("pb211: the city militia did not pay the attacker back: " + JSON.stringify(events.map((e) => e.type)));
    const m = militia[0];
    if (m.side !== "red") fail("pb211: the militia shot names side " + JSON.stringify(m.side));
    if (m.targetSide !== "blue") fail("pb211: the militia shot has targetSide " + JSON.stringify(m.targetSide));
    if (m.targetKind !== "infantry") fail("pb211: the militia shot has targetKind " + JSON.stringify(m.targetKind));
    if (m.attackerKind !== "militia") fail("pb211: the militia shot has attackerKind " + JSON.stringify(m.attackerKind));
    if (Number(m.amount) !== Number(cfg.militiaDamage)) {
      fail("pb211: the militia paid " + JSON.stringify(m.amount) + ", config says " + cfg.militiaDamage);
    }
    if (String(m.pieceId || "").startsWith("militia:") !== true) {
      fail("pb211: the militia shot does not name itself as the militia: " + JSON.stringify(m.pieceId));
    }
    // Both seats: the round's real exchange reads in both directions, the militia adds nothing.
    for (const side of ["blue", "red"]) {
      const lines = (logLines(match, side, events) || []).map((line) => line.text);
      const landed = lines.filter((text) => /landed/.test(text));
      if (landed.length !== 2) {
        fail("pb211: " + side + " read " + landed.length + " fight lines in a one-pair round with militia: " + JSON.stringify(lines));
      }
      if (lines.some((text) => /militia/i.test(text))) {
        fail("pb211: " + side + " read a militia line: " + JSON.stringify(lines));
      }
    }
    // And a militia event on its own - the case both gates exist for - is silence for both seats.
    const alone = { ...m, at: { x: 400, y: 10 } };
    const bare = matchOf([unit("blue:far", "blue", "infantry", 40, 100)], { round: 3, sites: [] });
    for (const side of ["blue", "red"]) {
      const lines = logLines(bare, side, [alone]) || [];
      if (lines.length !== 0) {
        fail("pb211: a lone militia event produced " + side + " lines: " + JSON.stringify(lines.map((l) => l.text)));
      }
    }
  }

  console.log("pb211_producers: the overrun's shots and losses and the militia's shot carry " +
    "targetSide/attackerKind/targetKind, and a militia event is silence for both seats");
}
