// Node test: PB-211 gate (f) — the producers that are not combat.resolve carry the fields the log
// reads instead of a board lookup, and the city militia reads as a fight line for the two seats
// that have first-party news of it.
//
// This is the read-out half of PB-211, pinned separately from the beat rule so the rule commit can
// be backed out without the producer pins and vice versa. What it holds:
//   * the overrun path's two shot events name targetSide/attackerKind/targetKind, and both of its
//     destroyed events name the kind that was lost - the log builds after the dead are filtered, so
//     a missing field is a blank line, not a cosmetic one;
//   * the militia's shot names targetSide/targetKind and attackerKind "militia" and pays the
//     configured amount;
//   * a militia shot DOES become a "landed a hit" line for its city's owner and for the seat whose
//     piece took the 2, and for nobody else (card 8745 §2 AC1/AC2, PM 8762 §1(b)). The sight test
//     is disabled inside that branch, so the line does not depend on the reader having a piece
//     near the city - the militia is the city's own defence, not a sighting.
//   * the militia line survives the round its 2 is the killing blow (AC1's last clause).

import { advance, issueOrder } from "../../server/move.mjs";
import { damageFor, resolve } from "../../server/combat.mjs";
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
    // The overrun line renders through the same shot branch as resolve's, so it must carry the
    // strength the target is left on. `after` alone is not enough: the renderer reads `strength`,
    // and without it the overrun line was the one fight line with no "(N left)" tail.
    const tankLine = (logLines(match, "blue", events) || []).map((l) => l.text)
      .find((text) => /your tank landed a hit/.test(text));
    if (!tankLine || !/\(\d+ left\)$/.test(tankLine)) {
      fail("pb211: the overrun line that blue reads is " + JSON.stringify(tankLine) + " - no strength tail");
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

  // --- the militia is a producer too, and it reads for its two first-party seats --------------
  // The militia's shot carries targetSide/targetKind and attackerKind "militia"; the fields are
  // what make the event readable at all once the attacker it shot has left the board. The line it
  // produces is the city's own defence (manual p.10, p.23) and is NOT sight-gated.
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

    // AC1 - the reader that OWNS the firing city reads its own militia, with the target's kind,
    // the configured amount and the strength the target is left on. AC2 - the seat whose piece
    // took the 2 reads it too (PB-208's first-party rule, same shape).
    const tail = "for " + Number(cfg.militiaDamage) + " (" + Math.round(Number(m.strength)) + " left)";
    const linesFor = (side) => (logLines(match, side, events) || []).map((line) => line.text);
    const redMilitia = linesFor("red").filter((text) => /militia/.test(text));
    if (redMilitia.length !== 1) fail("pb211: the city's owner read " + redMilitia.length + " militia lines: " + JSON.stringify(linesFor("red")));
    if (redMilitia[0] !== "your militia landed a hit on an enemy infantry " + tail) {
      fail("pb211: the city's owner read " + JSON.stringify(redMilitia[0]) + ", want \"your militia landed a hit on an enemy infantry " + tail + "\"");
    }
    const blueMilitia = linesFor("blue").filter((text) => /militia/.test(text));
    if (blueMilitia.length !== 1) fail("pb211: the seat that took the 2 read " + blueMilitia.length + " militia lines: " + JSON.stringify(linesFor("blue")));
    if (blueMilitia[0] !== "an enemy militia landed a hit on your infantry " + tail) {
      fail("pb211: the seat that took the 2 read " + JSON.stringify(blueMilitia[0]));
    }

    // The sight test is DISABLED inside the militia branch: a board with no piece of the reader's
    // anywhere (so `legible` is false for everyone) still gives the city's owner its militia line.
    // This is the "sight mutant disabled" arm - swap the militia branch back to the plain sight
    // test and this read goes empty.
    const noEyes = matchOf([], { round: 3, sites: [] });
    const ownOnly = (logLines(noEyes, "red", [m]) || []).map((line) => line.text);
    if (ownOnly.length !== 1 || !/^your militia landed a hit on an enemy infantry /.test(ownOnly[0])) {
      fail("pb211: the city's owner, with no piece on the board, read " + JSON.stringify(ownOnly) + " - the militia line is sight-gated again");
    }

    // AC2's other half, isolated: a seat that owns neither the firing city nor the piece that took
    // the 2 reads nothing. Only two seats exist, so the firing city and the target are both made
    // red here to leave blue with neither stake - the predicate is what is under test, not a legal
    // board.
    const stray = { ...m, side: "red", targetSide: "red" };
    if ((logLines(noEyes, "blue", [stray]) || []).length !== 0) {
      fail("pb211: a seat with no stake in the militia shot read " + JSON.stringify((logLines(noEyes, "blue", [stray]) || []).map((l) => l.text)));
    }

    // And the sight test is DISABLED, not merely unreachable. For a legal militia event both seats
    // are already first-party (`mine` or `onMe`), so a sighted-bystander arm needs an event that
    // does not name the side it hit - a row saved before this producer carried `targetSide`. Such
    // a seat must read NOTHING: "landed a hit on your infantry" is a claim the event cannot
    // support, and the militia branch never consults sight, so the answer is silence, not a guess.
    // Mutant: swap the branch back to the plain sight test and this seat reads a line.
    const blind = { ...m };
    delete blind.targetSide;
    const watcher = unit("blue:infantry:9", "blue", "infantry", 61, 79);
    const watchers = matchOf([watcher], { round: 3, sites: [] });
    const watched = (logLines(watchers, "blue", [blind]) || []).map((line) => line.text);
    if (watched.length !== 0) {
      fail("pb211: a militia event with no targetSide read " + JSON.stringify(watched) + " to a bystander that could see the cell");
    }

    // AC1's last clause - the round the militia's 2 is the KILLING blow. The attacker is left on
    // exactly the militia's damage by the exchange, so the 2 lands as the killing hit and the line
    // still comes out, naming the target's kind and "0 left".
    {
      const brief = unit("blue:infantry:8", "blue", "infantry", 60, 82);
      const hold = unit("red:infantry:8", "red", "infantry", 61, 82);
      const bite = Number(damageFor(hold, brief, cfg).amount) || 0;
      brief.strength = bite + Number(cfg.militiaDamage);
      const city2 = { id: 52, kind: "city", owner: "red", name: "Garrison", x: 61, y: 82 };
      const m2 = matchOf([brief, hold], { round: 5, sites: [city2] });
      const ev2 = resolve(m2) || [];
      const killed = ev2.find((e) => e.type === "destroyed" && e.pieceId === "blue:infantry:8");
      if (!killed) fail("pb211: the militia's killing blow was not reported: " + JSON.stringify(ev2.map((e) => e.type + ":" + (e.pieceId || ""))));
      const lastLines = (logLines(m2, "red", ev2) || []).map((line) => line.text).filter((text) => /militia/.test(text));
      if (lastLines.length !== 1) fail("pb211: the killing militia round read " + JSON.stringify(lastLines));
      if (lastLines[0] !== "your militia landed a hit on an enemy infantry for " + Number(cfg.militiaDamage) + " (0 left)") {
        fail("pb211: the killing militia line read " + JSON.stringify(lastLines[0]));
      }
    }
  }

  console.log("pb211_producers: the overrun's shots and losses and the militia's shot carry " +
    "targetSide/attackerKind/targetKind, and the militia reads as a fight line for its city's " +
    "owner and for the seat that took the 2, sight-blind on both");
}
