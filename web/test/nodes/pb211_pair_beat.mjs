// Node test: PB-211 / D-030 — the combat beat is per PAIR, not per front.
//
// The report (game 8751 §2): in a room where a tank keeps pressing a held cell, a fresh pair beside
// it fired twice in twelve rounds - both after the overrun fight had ended. The cause was one
// global clock: the overrun path wrote `match.foughtRound` and `combat.resolve` read it as the gate
// for every pair in the room, so one exchange on one front silenced every other pair that round.
//
// D-030 (frodo 8754, PM 8753 §2): each piece keeps its own `lastShotRound`, and a pair exchanges
// only when BOTH members are due -
//   round - max(a.lastShotRound ?? -1, b.lastShotRound ?? -1) >= shotEveryRounds
// The `max` is the ruling's whole refinement: without it a piece that fired recently on another
// front joins a fresh fight and fires while its new partner stays silent, which is a one-sided
// exchange and is not what p.22's "once every other round" describes.
//
// What breaks if this node is removed: the front-wide clock comes back (pair B goes silent behind
// any other exchange in the room), a fresh partner opens a one-sided exchange against a piece that
// fired last round, and the overrun pair can exchange twice in the round the same tank both overran
// and resolve fired (T-015's double exchange). The producer fields are pinned by pb211_producers.

import { advance, issueOrder } from "../../server/move.mjs";
import { resolve } from "../../server/combat.mjs";
import { logLines } from "../../server/log.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb211_pair_beat";

const B_BLUE = "blue:infantry:2";
const B_RED = "red:infantry:2";
const OR_BLUE = "blue:tank:1";
const OR_RED = "red:infantry:1";

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
const damageIn = (events) => shotsOf(events).filter((e) => e.militia !== true).reduce((n, e) => n + (Number(e.amount) || 0), 0);

// One arm of the board: pair B is blue:infantry:2 beside red:infantry:2, adjacent, no orders. In
// the overrun arm a blue tank is re-ordered onto the held cell every round and meets red infantry
// 1; in the control arm the same tank is parked with no enemy beside it, so no overrun happens
// anywhere in the room. Pair B never sees an order in either arm.
//
// The overrun defender's bar is topped back up between rounds so the pair lives the whole window
// and its cadence is readable for twelve rounds; pair B is never topped up, so its damage total is
// the arm's real output.
function runArm(overrun, rounds = 12) {
  const pieces = [
    unit(B_BLUE, "blue", "infantry", 40, 40),
    unit(B_RED, "red", "infantry", 41, 40),
    unit(OR_BLUE, "blue", "tank", 30, 60),
  ];
  if (overrun) pieces.push(unit(OR_RED, "red", "infantry", 31, 60));
  const match = matchOf(pieces);
  const rows = [];
  for (let round = 1; round <= rounds; round++) {
    match.round = round;
    if (overrun) {
      const tank = match.pieces.find((p) => p.id === OR_BLUE);
      if (tank) {
        tank.path = [];
        const order = issueOrder(match, "blue", OR_BLUE, 34, 60);
        if (order && order.error) rows.push({ round, error: order.error });
      }
    }
    const events = (advance(match) || []).concat(resolve(match) || []);
    rows.push({
      round,
      pairBShots: pairShots(events, B_BLUE, B_RED).length,
      pairBDamage: damageIn(pairShots(events, B_BLUE, B_RED)),
      pairOShots: pairShots(events, OR_BLUE, OR_RED).length,
      events,
    });
    if (overrun) {
      const held = match.pieces.find((p) => p.id === OR_RED);
      if (held) {
        held.strength = combatRules().maxStrength;
        held.maxStrength = combatRules().maxStrength;
      }
    }
  }
  return { match, rows };
}

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();
  const beat = Number(cfg.shotEveryRounds);
  if (beat !== 2) fail("pb211: shotEveryRounds is " + beat + ", D-017's ruled pace is 2");

  const overrun = runArm(true);
  const control = runArm(false);
  const errors = [...overrun.rows, ...control.rows].filter((r) => r.error);
  if (errors.length) fail("pb211: the arm could not be driven: " + JSON.stringify(errors));

  // --- (a) pair B is the control arm's pair B, round for round ------------------------------
  // The gate: the overrun arm's pair B exchanges on the same rounds and for the same damage as the
  // room where no overrun happens at all. This is the card itself.
  {
    const o = overrun.rows.map((r) => ({ round: r.round, shots: r.pairBShots, damage: r.pairBDamage }));
    const c = control.rows.map((r) => ({ round: r.round, shots: r.pairBShots, damage: r.pairBDamage }));
    const played = o.filter((r) => r.shots > 0 || c.find((x) => x.round === r.round).shots > 0);
    if (played.length < 4) fail("pb211: pair B barely fought in the window: " + JSON.stringify(o));
    if (JSON.stringify(o) !== JSON.stringify(c)) {
      fail("pb211: overrun arm pair B is not the control arm's pair B\n  overrun: " +
        JSON.stringify(o) + "\n  control: " + JSON.stringify(c));
    }
    const oRounds = overrun.rows.filter((r) => r.pairBShots > 0).map((r) => r.round);
    if (JSON.stringify(oRounds) !== JSON.stringify([1, 3, 5, 7, 9])) {
      fail("pb211: pair B fired on " + JSON.stringify(oRounds) + ", the beat is r, r+2, r+4 ...");
    }
  }

  // --- (a2) the max is load-bearing: a fresh partner does not open a one-sided exchange ------
  // A piece that exchanged last round meets a NEW enemy this round. The pair can only be due when
  // BOTH members are, so nothing fires. A "whichever side is due" form would let the fresh enemy
  // shoot while the veteran holds fire - the one-sided exchange D-030's max exists to stop.
  {
    const veteran = unit("blue:infantry:1", "blue", "infantry", 40, 40);
    const doomedFoot = unit("red:infantry:1", "red", "infantry", 41, 40, { strength: 1, maxStrength: 100 });
    const match = matchOf([veteran, doomedFoot], { round: 1 });
    const first = resolve(match) || [];
    if (pairShots(first, "blue:infantry:1", "red:infantry:1").length !== 2) {
      fail("pb211: the opening exchange did not happen: " + JSON.stringify(pairShots(first, "blue:infantry:1", "red:infantry:1").map((e) => e.amount)));
    }
    if (Number(veteran.lastShotRound) !== 1) fail("pb211: the veteran did not stamp round 1: " + veteran.lastShotRound);
    // A fresh enemy walks in beside it the next round; the veteran has 1 on its clock.
    match.pieces.push(unit("red:infantry:2b", "red", "infantry", 40, 41));
    match.round = 2;
    const second = pairShots(resolve(match) || [], "blue:infantry:1", "red:infantry:2b");
    if (second.length !== 0) {
      fail("pb211: a fresh partner exchanged while the veteran was not due (one-sided exchange): " +
        JSON.stringify(second.map((e) => e.pieceId + "->" + e.target)));
    }
    match.round = 3;
    const third = pairShots(resolve(match) || [], "blue:infantry:1", "red:infantry:2b");
    if (third.length !== 2) {
      fail("pb211: the pair did not exchange once both members were due: " + JSON.stringify(third.map((e) => e.pieceId)));
    }
  }

  // --- (b) a same-tick overrun + resolve is ONE exchange -------------------------------------
  // AC12 of combat_rules calls advance() only, so the double exchange has no pin there. This leg
  // runs both producers in the same round, which is how a real room runs them.
  {
    const tank = unit("blue:tank:9", "blue", "tank", 30, 70);
    const foot = unit("red:infantry:9", "red", "infantry", 31, 70);
    const match = matchOf([tank, foot], { round: 1 });
    const order = issueOrder(match, "blue", "blue:tank:9", 34, 70);
    if (order.error) fail("pb211: the tank refused the order: " + order.error);
    const advanced = advance(match) || [];
    const resolved = resolve(match) || [];
    const overrunShots = pairShots(advanced, "blue:tank:9", "red:infantry:9");
    const resolveShots = pairShots(resolved, "blue:tank:9", "red:infantry:9");
    if (overrunShots.length !== 2) {
      fail("pb211: the overrun exchange is not one exchange (2 shots): " + JSON.stringify(overrunShots.map((e) => e.amount)));
    }
    if (overrunShots.filter((e) => e.overrun === true).length !== 2) {
      fail("pb211: advance() produced shots for this pair that are not the overrun's");
    }
    if (resolveShots.length !== 0) {
      fail("pb211: resolve fired the pair again in the overrun round (double exchange): " +
        JSON.stringify(resolveShots.map((e) => e.amount)));
    }
    for (const piece of [tank, foot]) {
      if (Number(piece.lastShotRound) !== 1) {
        fail("pb211: " + piece.id + " did not stamp the round it exchanged: " + piece.lastShotRound);
      }
      // PB-211 (PM 8762 §1(a)): the overrun IS a shot on the piece's counter. The room leg read a
      // tank frozen at 4 shots through two overrun rounds while its strength fell 35 -> 18 -> 1.
      if (Number(piece.shots) !== 1) {
        fail("pb211: " + piece.id + " exchanged in the overrun and its shot counter reads " + piece.shots);
      }
    }
  }

  // --- (b2) no piece exchanges twice inside shotEveryRounds ----------------------------------
  // The per-PIECE half of D-030: over a whole arm, every piece's appearances as a shooter are at
  // least `beat` rounds apart - including the overrun rounds, which are the ones that used to be
  // uncounted. A per-pair-only stamp passes (a) and still lets a piece fire on two fronts.
  {
    for (const arm of [overrun.rows, control.rows]) {
      const last = new Map();
      for (const row of arm) {
        const seen = new Set(shotsOf(row.events).filter((e) => e.militia !== true).map((e) => e.pieceId));
        for (const id of seen) {
          if (last.has(id) && row.round - last.get(id) < beat) {
            fail("pb211: " + id + " fired on rounds " + last.get(id) + " and " + row.round +
              " - inside shotEveryRounds " + beat);
          }
          last.set(id, row.round);
        }
      }
    }
  }

  // --- (c) the overrun pair's own cadence is unchanged ---------------------------------------
  // 1,3,5,7 at shotEveryRounds 2 - not two exchanges on 1,3 - and never more than one exchange in
  // a round. D-017's pace does not move; only the coupling does.
  {
    const rows = overrun.rows.slice(0, 8);
    const rounds = rows.filter((r) => r.pairOShots > 0).map((r) => r.round);
    if (JSON.stringify(rounds) !== JSON.stringify([1, 3, 5, 7])) {
      fail("pb211: the overrun pair exchanged on " + JSON.stringify(rounds) + ", want [1,3,5,7]");
    }
    for (const row of overrun.rows) {
      if (row.pairOShots > 2) {
        fail("pb211: the overrun pair fired " + row.pairOShots + " times in round " + row.round);
      }
    }
  }

  const bRounds = overrun.rows.filter((r) => r.pairBShots > 0).map((r) => r.round);
  const oRounds = overrun.rows.filter((r) => r.pairOShots > 0).map((r) => r.round);
  console.log("pb211_pair_beat: pair B fires [" + bRounds.join(",") + "] with damage " +
    overrun.rows.reduce((n, r) => n + r.pairBDamage, 0).toFixed(2) +
    " in the overrun arm and " + control.rows.reduce((n, r) => n + r.pairBDamage, 0).toFixed(2) +
    " in the control, the overrun pair fires [" + oRounds.join(",") +
    "], and neither pair ever exchanges twice in a round");
}
