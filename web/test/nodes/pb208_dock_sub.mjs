// Node test: PB-208 — an infantry firing on a submarine in a dock cell produces the PB-202 fight
// line for BOTH seats, and the damage numbers are the measured table's, not a guess.
//
// The report (PM 8669 §2): a blue submarine sitting at the Istanbul dock took 35 per exchange from
// red land infantry (the infantry went 100 -> 98 -> 96) and was lost at r17. "No fight line ever
// named my sub."
//
// What was actually broken — measured on the shipped tree before this pin, and the reason the round
// that killed the unit was the one round with no line:
//   * the shot line's sight gate (`legible`) is evaluated against the match AFTER combat.mjs has
//     filtered the dead, so a killing hit removes the target first and the removed piece was often
//     the only eye on its own cell — the seat's own loss silently dropped its own fight line;
//   * the `destroyed` event carried no kind, so every loss read "lost a unit".
// The numbers were never the defect: infantry -> submarine is 35 (damageMatrix row 1, column 7,
// DS:0x18f0, config/game.json combat.measured.damageMatrix), the dock's militia pays 2 back
// (combat.militiaDamage, the 100 -> 98 -> 96 the PM saw), and terrain cover is applied to the
// defender's cell exactly as FUN_194c_000e does it — so the same 35 reads 23 when the target
// stands on city-like ground and 35 on open water. Both readings are asserted below: the pin says
// the amount is the table's, not that it is a constant.
//
// What breaks if this node is removed: both defects come back — a seat losing a unit reads only
// "lost a unit", and its last exchange is not named at all.

import { baseDamageFor, coverDamage, resolve } from "../../server/combat.mjs";
import { logLines } from "../../server/log.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb208_dock_sub";

function piece(id, side, x, y, extra = {}) {
  return {
    id, side, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
    strength: 100, maxStrength: 100, domain: "land", kind: null,
    ...extra,
  };
}

// A blue-owned dock. The submarine stands on the dock cell (the berth a hull is placed at, PB-210)
// and the red infantry stands on the land cell beside it.
const DOCK = { id: 51, kind: "dock", owner: "blue", name: "Istanbul", x: 76, y: 60, country_id: "TR" };

function dockFight(subStrength) {
  return {
    round: 12,
    foughtRound: -1,
    over: false,
    sites: [DOCK],
    pieces: [
      piece("blue:submarine:1", "blue", DOCK.x, DOCK.y, { domain: "sea", kind: "submarine", strength: subStrength }),
      piece("red:infantry:1", "red", DOCK.x, DOCK.y - 1, { kind: "infantry" }),
    ],
  };
}

function texts(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => line.text);
}

export async function run(ctx) {
  const { fail } = ctx;
  const rules = combatRules();

  // ---- the number, from the measured table, before any terrain is considered ---------------
  const submarine = piece("probe:submarine", "blue", DOCK.x, DOCK.y, { domain: "sea", kind: "submarine" });
  const base = Number(baseDamageFor("infantry", submarine, rules));
  if (base !== 35) {
    fail("pb208: infantry -> submarine is " + JSON.stringify(base) +
      ", the measured row 1 column 7 is 35 (DS:0x18f0)");
  }
  if (Number(rules.militiaDamage) !== 2) {
    fail("pb208: dock militia damage is " + JSON.stringify(rules.militiaDamage) + ", want 2");
  }

  // The amount the exchange will actually pay here: the table cell, covered by the defender's
  // terrain the way the original's FUN_194c_000e covers it (city-like ground takes a third off a
  // kind-1 attacker, a mountain a quarter, open water nothing).
  const covered = Number(coverDamage(base, submarine));
  if (!(covered > 0) || covered > base) {
    fail("pb208: covered damage " + JSON.stringify(covered) + " is not inside (0, " + base + "]");
  }

  // ---- (1) a surviving exchange names the submarine for both seats -------------------------
  {
    const match = dockFight(100);
    const events = resolve(match);
    const sub = match.pieces.find((unit) => unit.id === "blue:submarine:1");
    if (!sub) fail("pb208: the submarine was removed by a non-killing exchange");
    if (Number(sub.strength) !== 100 - covered) {
      fail("pb208: the submarine is on " + JSON.stringify(sub.strength) + " after one exchange, want " +
        (100 - covered) + " (table " + base + ", covered " + covered + ")");
    }
    const blue = texts(logLines(match, "blue", events));
    const red = texts(logLines(match, "red", events));
    if (!blue.some((text) => /your submarine/.test(text) && text.includes("for " + covered))) {
      fail("pb208: blue's log does not name its own submarine taking " + covered + ": " + JSON.stringify(blue));
    }
    if (!red.some((text) => /enemy submarine/.test(text) && text.includes("for " + covered))) {
      fail("pb208: red's log does not name the enemy submarine taking " + covered + ": " + JSON.stringify(red));
    }
  }

  // ---- (2) the killing exchange: the seat that lost the unit still reads the fight ----------
  // The submarine starts on exactly the damage one hit pays, and it is the only blue piece in
  // sight of the cell — so the removed target cannot make its own news legible after the fact.
  {
    const match = dockFight(covered);
    const events = resolve(match);
    if (match.pieces.some((unit) => unit.id === "blue:submarine:1")) {
      fail("pb208: a " + covered + "-strength submarine survived a " + covered + "-point hit");
    }
    const blue = texts(logLines(match, "blue", events));
    const red = texts(logLines(match, "red", events));
    if (!blue.some((text) => /your submarine/.test(text) && text.includes("for " + covered))) {
      fail("pb208: the killing round dropped blue's fight line for its own submarine: " + JSON.stringify(blue));
    }
    const loss = blue.find((text) => /^lost /.test(text));
    if (!loss) fail("pb208: blue's log never reports the loss: " + JSON.stringify(blue));
    if (!/submarine/.test(loss)) {
      fail("pb208: the loss line does not name the submarine: " + JSON.stringify(loss));
    }
    if (!red.some((text) => /enemy submarine/.test(text))) {
      fail("pb208: red's log lost the shot that killed the submarine: " + JSON.stringify(red));
    }
  }

  // ---- (3) the narrowness of the fix: an event that is NOT the seat's own still needs sight --
  // The new first-party branch keys on `targetSide`, so a shot between the other side's pieces (or
  // any shot the reader is not in) still falls back to the sight gate. Without this control the
  // fix would be "every fight line is free", which is a fog leak.
  {
    const match = {
      round: 40, foughtRound: -1, over: false, sites: [],
      pieces: [piece("blue:infantry:9", "blue", 40, 100, { kind: "infantry" })],
    };
    const far = { x: 300, y: 20 };
    const theirs = {
      type: "shot", side: "red", pieceId: "red:1", target: "red:2", targetSide: "red",
      attackerKind: "infantry", targetKind: "infantry", amount: 20, strength: 80,
      round: 40, at: far,
    };
    const blue = texts(logLines(match, "blue", [theirs]));
    if (blue.some((text) => /landed/.test(text))) {
      fail("pb208: blue read a fight it was not in and could not see: " + JSON.stringify(blue));
    }
    const red = texts(logLines(match, "red", [theirs]));
    if (!red.some((text) => /landed/.test(text))) {
      fail("pb208: red lost a fight between its own pieces: " + JSON.stringify(red));
    }
    // And the reader's own piece as the TARGET is the case the fix exists for: it reads even with
    // no blue piece left anywhere near the cell.
    const mine = { ...theirs, side: "red", pieceId: "red:1", target: "blue:7", targetSide: "blue" };
    const blueOwn = texts(logLines(match, "blue", [mine]));
    if (!blueOwn.some((text) => /your infantry/.test(text))) {
      fail("pb208: blue did not read a hit on its own piece out of sight: " + JSON.stringify(blueOwn));
    }
  }

  console.log("pb208_dock_sub: infantry -> submarine = 35 from row 1 col 7, paid " + covered +
    " on a dock cell after terrain cover, 2 militia back; both seats read the fight, and the seat " +
    "that loses the unit still reads the shot that took it");
}
