// Node test: PB-216 — the city militia is a producer of its own, and an overrun reads right.
//
// Three holes were measured on the live board before this node existed (card PB-216, probes in
// /mnt/nas/host-ops/openchq/pb216/):
//
//   1. the militia block walked `hits`, so with no defender left there was no hit to hang on and
//      the manual's own case ("Do you see it take damage even after the enemy unit is destroyed?",
//      L246-247) never fired - 0 militia shots in eight rounds with a tank alone on Berlin;
//   2. the site lookup was the ANCHOR cell only, while D-026 places a unit on the clicked
//      footprint cell: Berlin is (161,30) and the PB-211 room's defender stood at (160,29), so a
//      defender fighting on its own city got no militia at all;
//   3. `overrun` carried `side` = the overrunner, and the log's own-side branch printed "a unit was
//      lost" - the seat that WON read a loss - while the kill event left `overrunCell` set and the
//      arrival branch fired a second overrun for the same kill ("2 units were lost", one tank).
//
// What breaks if this node is removed: the militia goes back to being an exchange rider (an
// undefended city stops shooting), the reach goes back to the anchor (a defender on a footprint
// cell is undefended), and the overrun line goes back to the winner's wrong voice with a count of
// two. The footprint index itself is placement.footprintCellIndex; this node reads it through
// combat so a change there reds here.

import { advance, issueOrder } from "../../server/move.mjs";
import { resolve } from "../../server/combat.mjs";
import { logLines } from "../../server/log.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb216_militia";

// Berlin on the shipped 1986 board: the site record's own cell and its measured D-026 block
// (web/data/footprints.json id 11) - [[160,29],[161,29],[162,29],[160,30],[161,30],[162,30],
// [160,31],[161,31],[162,31]]. The anchor is (161,30); a unit bought at Berlin lands on the cell
// the player clicked, and (160,29) is the cell the PB-211 room leg actually used.
const BERLIN = { id: 11, kind: "city", owner: "red", name: "Berlin", x: 161, y: 30 };
const ANCHOR = { x: 161, y: 30 };
const FOOTPRINT = { x: 160, y: 29 };
const OUTSIDE = { x: 157, y: 30 };

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
    era: "1986", round: 1, clock: "running", pieces, sites: [{ ...BERLIN }], capitals: {},
    sides: { blue: {}, red: {} }, foughtRound: -1, over: false, winner: null, ...extra,
  };
}

const texts = (match, side, events) => (logLines(match, side, events) || []).map((line) => line.text);
const militiaShots = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.militia === true);

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();
  const dmg = Number(cfg.militiaDamage);
  const every = Number(cfg.shotEveryRounds);

  // --- 1. an undefended enemy city shoots the occupier on its cadence ------------------------
  // A tank stands inside Berlin with no defender left - the manual's case. Nothing exchanges, so
  // the old hits-loop produced no militia event at all. The tank is on a FOOTPRINT cell, which is
  // also arm 2's reach; the anchor arm below separates the two claims.
  {
    const tank = unit("blue:tank:216", "blue", "tank", FOOTPRINT.x, FOOTPRINT.y);
    const match = matchOf([tank], { round: 12 });
    const fired = [];
    for (let round = 12; round <= 19; round++) {
      match.round = round;
      const events = (advance(match) || []).concat(resolve(match) || []);
      if (militiaShots(events).length) fired.push(round);
      const other = (Array.isArray(events) ? events : []).filter((e) => e.type === "shot" && e.militia !== true);
      if (other.length) fail("pb216: an undefended city produced a non-militia exchange at r" + round + ": " + JSON.stringify(other.map((e) => e.pieceId)));
      if (round === 12) {
        const blue = texts(match, "blue", events);
        const red = texts(match, "red", events);
        const expected = "an enemy militia landed a hit on your tank for " + dmg + " (" + (Number(cfg.maxStrength) - dmg) + " left)";
        if (!blue.includes(expected)) fail("pb216: the occupier did not read its militia line at r12: " + JSON.stringify(blue));
        if (!red.some((text) => text === "your militia landed a hit on an enemy tank for " + dmg + " (" + (Number(cfg.maxStrength) - dmg) + " left)")) {
          fail("pb216: the city's owner did not read its militia line at r12: " + JSON.stringify(red));
        }
      }
    }
    const want = [12];
    for (let round = 12 + every; round <= 19; round += every) want.push(round);
    if (fired.join(",") !== want.join(",")) fail("pb216: the militia cadence over r12-r19 read " + fired.join(",") + ", not " + want.join(","));
    const expectedStrength = Number(cfg.maxStrength) - dmg * want.length;
    if (Number(tank.strength) !== expectedStrength) fail("pb216: the tank was left on " + tank.strength + ", not " + expectedStrength);
    if (match.sites[0].owner !== "red") fail("pb216: an unordered tank captured the city; the arm is measuring the wrong thing: " + match.sites[0].owner);
  }

  // --- 2. the reach is the footprint, not the anchor ----------------------------------------
  // The site is resolved from the cell of the piece the city SHOOTS - anywhere inside the block,
  // not just the anchor (the old lookup keyed the site from the defender's cell alone). Same
  // undefended board, the occupier moved: anchor, a footprint cell one off, and one cell outside.
  {
    const drawAt = (at) => {
      const blue = unit("blue:infantry:216", "blue", "infantry", at.x, at.y);
      const match = matchOf([blue], { round: 4 });
      const events = resolve(match) || [];
      return { at, militia: militiaShots(events), blue, events };
    };
    const onAnchor = drawAt(ANCHOR);
    const onFootprint = drawAt(FOOTPRINT);
    const outside = drawAt(OUTSIDE);
    if (onAnchor.militia.length !== 1) fail("pb216: an occupier on the anchor drew " + onAnchor.militia.length + " militia events");
    if (onFootprint.militia.length !== 1) fail("pb216: an occupier on a footprint cell drew " + onFootprint.militia.length + " militia events (anchor-only reach)");
    if (outside.militia.length !== 0) fail("pb216: an occupier one cell outside the block drew militia: " + JSON.stringify(outside.militia.map((e) => e.at)));
    for (const arm of [onAnchor, onFootprint]) {
      const shot = arm.militia[0];
      if (shot.target !== "blue:infantry:216") fail("pb216: the militia shot at " + shot.target);
      if (shot.side !== "red" || shot.targetSide !== "blue") fail("pb216: the militia's seats read " + shot.side + "/" + shot.targetSide);
      if (shot.attackerKind !== "militia") fail("pb216: the militia's noun is " + shot.attackerKind);
    }

    // PB-288 (PM 9779 §4, difference (i)): the militia lands on pieces standing on the site's own
    // cells and on nothing else. A defender holding a footprint cell still trades shots, but the
    // city no longer reaches an attacker one cell OUTSIDE the block - the original has no such
    // branch, and the arm that asserted the reach is now the arm that forbids it. The inside half
    // is the ruling's positive side: an attacker that steps onto the footprint pays the per-pass
    // amount.
    const defender = unit("red:infantry:218", "red", "infantry", FOOTPRINT.x, FOOTPRINT.y);
    const outsideAttacker = unit("blue:infantry:218", "blue", "infantry", FOOTPRINT.x - 1, FOOTPRINT.y);
    const held = matchOf([outsideAttacker, defender], { round: 5 });
    const heldEvents = resolve(held) || [];
    const exchange = (Array.isArray(heldEvents) ? heldEvents : []).filter((e) => e.type === "shot" && e.militia !== true);
    if (exchange.length !== 2) fail("pb216: the footprint defender did not exchange: " + JSON.stringify(heldEvents.map((e) => e.type)));
    if (militiaShots(heldEvents).length !== 0) {
      fail("pb216: a city's militia reached an attacker one cell OUTSIDE the block: " + JSON.stringify(militiaShots(heldEvents).map((e) => e.at)));
    }

    const defenderIn = unit("red:infantry:219", "red", "infantry", FOOTPRINT.x, FOOTPRINT.y);
    const inside = unit("blue:infantry:219", "blue", "infantry", ANCHOR.x, ANCHOR.y);
    const engaged = matchOf([inside, defenderIn], { round: 5 });
    const engagedEvents = resolve(engaged) || [];
    if (militiaShots(engagedEvents).length !== 1) {
      fail("pb216: an attacker standing on a footprint cell drew " + militiaShots(engagedEvents).length + " militia events, expected 1");
    }
  }

  // --- 3. one overrun, one event, and each seat reads it in its own voice --------------------
  {
    const tank = unit("blue:tank:217", "blue", "tank", FOOTPRINT.x - 1, FOOTPRINT.y);
    const foot = unit("red:infantry:217", "red", "infantry", FOOTPRINT.x, FOOTPRINT.y, { strength: 1, maxStrength: 1 });
    const match = matchOf([tank, foot], { round: 11 });
    const order = issueOrder(match, "blue", "blue:tank:217", FOOTPRINT.x, FOOTPRINT.y);
    if (order && order.error) fail("pb216: the tank refused the overrun order: " + order.error);
    const events = (advance(match) || []).concat(resolve(match) || []);
    const overruns = (Array.isArray(events) ? events : []).filter((e) => e.type === "overrun");
    if (overruns.length !== 1) fail("pb216: one overrun produced " + overruns.length + " overrun events: " + JSON.stringify(overruns.map((e) => ({ side: e.side, target: e.target, at: e.at || [e.x, e.y] }))));
    const event = overruns[0];
    if (event.side !== "blue") fail("pb216: the overrun event's side is " + event.side + ", not the winner");
    if (event.targetSide !== "red" || event.kind !== "infantry") fail("pb216: the overrun event names " + event.targetSide + "/" + event.kind);
    if (Number(tank.x) !== FOOTPRINT.x || Number(tank.y) !== FOOTPRINT.y) fail("pb216: the tank did not walk into the overrun cell: " + tank.x + "," + tank.y);

    const blue = texts(match, "blue", events);
    const red = texts(match, "red", events);
    const winner = blue.filter((text) => /overrun/.test(text));
    if (winner.length !== 1) fail("pb216: the winner read " + winner.length + " overrun lines: " + JSON.stringify(blue));
    if (!/^an enemy infantry was overrun /.test(winner[0]) || !/Berlin/.test(winner[0])) {
      fail("pb216: the winner's overrun line reads " + JSON.stringify(winner[0]));
    }
    if (blue.some((text) => /a unit was lost/.test(text))) fail("pb216: the winner still read a loss: " + JSON.stringify(blue));
    const lost = red.filter((text) => /lost/.test(text));
    if (lost.length !== 1) fail("pb216: the loser read " + lost.length + " loss lines: " + JSON.stringify(red));
    if (!/^lost an infantry /.test(lost[0]) || !/Berlin/.test(lost[0])) fail("pb216: the loser's loss line reads " + JSON.stringify(lost[0]));
  }

  console.log("pb216_militia: an undefended enemy city shoots the occupier every " + every +
    " rounds on the footprint and never on the anchor alone, and one overrun is one event that the " +
    "winner reads as \"an enemy infantry was overrun\" and the loser as \"lost an infantry\"");
}
