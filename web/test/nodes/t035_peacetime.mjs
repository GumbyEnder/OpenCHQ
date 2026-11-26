// Node test: T-035 — the cold war economy, as MEASURED in the original (RE-E4), not as invented.
//
// Sources: repo docs/re/RE_E4.md (§1 the two captures, §2 the decompiled rules) and the CSVs under
// docs/re/evidence/re4/. Every figure asserted below is either a capture reading or the single
// arithmetic step config/game.json documents: the 0x148e cash field is in 40ths of a billion
// (docs/re/ECONOMY_RE.md:163) and money.perBillion is 1000, so the original's flat 10 units per call
// is 250 port money units, and the capture's +20 units/s is two calls a second.
//
// Arms, one per acceptance criterion that a node test can reach:
//   AC1  a 1986 cold war side's cash rises with NO round at perTick x ticksPerSecond per second, and
//        over one round's worth of time it rises faster than the same board's wartime payday
//   AC2  the oil ledger is untouched by the money tick (and a war round still moves it)
//   AC3  peacetime production marks no site unready while wartime production still does
//   AC4  the rate is exact across beats that are not a whole number of ticks (the carried fraction)
//   AC5  the shipped config carries the measured pair and NOT the retired multiplier; a war match
//        pays no money tick (the tick is the peace flag's, not the scenario's)
//
// NOT covered here, because it needs the room clock and a browser: AC4 of the ticket (the cold war
// room shows the peacetime readout and the war can start without a restart). That is the live leg;
// the lobby's own wiring of this function is exercised by the ws_* nodes and a live check.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { atWar } from "../wartime.mjs";
import { pay, peacePay, upkeep } from "../../server/economy.mjs";
import { answerCeasefire, useTool } from "../../server/late.mjs";
import { meterOf } from "../../server/resources.mjs";
import { poolReadiness, readyRoundOf } from "../../server/readiness.mjs";
import { peaceRules, resetRules, roundSeconds } from "../../server/rules.mjs";

export const name = "t035_peacetime";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function ok(value, label) {
  if (!value) fail(label);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const shippedPath = path.resolve(here, "..", "..", "..", "config", "game.json");

// The scenario as it is dealt: 1986 and 2023 open in the cold war (manual printed p.31).
function coldWar(era = "1986") {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  match.round = 0;
  return match;
}

function cash(side) {
  return Number(side && side.cash);
}

export async function run() {
  resetRules();
  const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
  const block = shipped.peace || {};

  // ---- AC5a: the shipped numbers are the measured ones, and the invented multiplier is gone ----
  {
    eq(block.cashPerTick, 250, "the shipped tick is 250 port units (original flat 10 x perBillion 1000 / 40)");
    eq(block.ticksPerSecond, 2, "the shipped rate is 2 ticks a second (capture A: +20 units/s)");
    eq(Object.hasOwn(block, "cashMultiplier"), false, "no peace multiplier in the shipped config");
    const rules = peaceRules();
    eq(rules.cashPerTick, 250, "peaceRules() reads the shipped per-tick amount");
    eq(rules.ticksPerSecond, 2, "peaceRules() reads the shipped tick rate");
    ok(String(block._source || "").includes("RE-E4"), "the config carries its source line (RE-E4)");
    pad();
  }

  // ---- AC1: cash rises with no round, at the measured rate, and no piece moves ----------------
  {
    const match = coldWar();
    const round = match.round;
    const pieceBefore = JSON.stringify(match.pieces);
    const blueBefore = cash(match.sides.blue);
    const redBefore = cash(match.sides.red);
    const events = peacePay(match, 5);
    eq(match.round, round, "the money tick does not advance the round (capture A: 0x1476 stayed 0)");
    eq(JSON.stringify(match.pieces), pieceBefore, "the money tick moves no piece");
    eq(cash(match.sides.blue) - blueBefore, 2500, "5 s of peacetime pays 250 x 2 x 5 = 2500 to blue");
    eq(cash(match.sides.red) - redBefore, 2500, "the other seat is paid the same flat amount");
    const blue = events.find((event) => event.side === "blue");
    ok(blue, "the tick emitted an income event");
    eq(blue.peace, true, "the event is labelled peacetime income");
    eq(blue.cities, 0, "no city count: FUN_15f4_0cdc pays flat, not per city");
    eq(blue.round, round, "the event's round is the frozen round");
    pad();
  }

  // ---- AC1b: faster than the same board's wartime payday over the same wall time --------------
  {
    const peaceBoard = coldWar();
    const warBoard = atWar(coldWar());
    warBoard.round = 1;
    const tick = peacePay(peaceBoard, roundSeconds())[0];
    const payday = pay(warBoard).find((event) => event.type === "income" && event.side === "blue");
    ok(tick && payday, "both sides of the comparison produced an income event");
    ok(tick.gross > payday.gross,
      "peacetime pays more in one round's time than the war payday ("
        + tick.gross + " vs " + payday.gross + ")");
    eq(pay(peaceBoard).length, 0, "a peacetime round pays no payday");
    eq(peacePay(warBoard, 5).length, 0, "a war match pays no money tick");
    pad();
  }

  // ---- AC2: the money tick touches no oil, and a war round still does ------------------------
  {
    const peaceBoard = coldWar();
    const peaceMeter = meterOf(peaceBoard, "blue", "fuel");
    ok(peaceMeter, "the 1986 seat has a fuel meter");
    peaceMeter.held = 1000;
    peaceMeter.lastOut = 0;
    const peaceHeld = Number(peaceMeter.held);
    peacePay(peaceBoard, 5);
    eq(Number(peaceMeter.held), peaceHeld, "peacetime: the money tick neither charges nor credits oil");

    const warBoard = atWar(coldWar());
    const warMeter = meterOf(warBoard, "blue", "fuel");
    warMeter.held = 1000;
    const warHeld = Number(warMeter.held);
    upkeep(warBoard);
    ok(Number(warMeter.held) !== warHeld, "wartime: upkeep settles the ledger (the arm needs a live one)");
    pad();
  }

  // ---- AC3: peacetime production marks no site unready; wartime production still does --------
  {
    const peaceBoard = coldWar();
    const touchedAtPeace = [];
    for (const site of peaceBoard.sites || []) {
      if (!site || site.owner !== "blue") continue;
      const before = readyRoundOf(site);
      poolReadiness(peaceBoard, "blue", site, "infantry");
      if (readyRoundOf(site) !== before) touchedAtPeace.push(site.id);
    }
    eq(touchedAtPeace, [], "peacetime production makes no city unready");

    const warBoard = atWar(coldWar());
    const touchedAtWar = [];
    for (const site of warBoard.sites || []) {
      if (!site || site.owner !== "blue") continue;
      const before = readyRoundOf(site);
      poolReadiness(warBoard, "blue", site, "infantry");
      if (readyRoundOf(site) !== before) touchedAtWar.push(site.id);
    }
    ok(touchedAtWar.length > 0, "wartime production does mark sites unready (the arm is not vacuous)");
    pad();
  }

  // ---- AC5b: a MID-WAR cease fire (round > 0) pays the tick, never the payday ------------------
  // This is the arm that holds the pay() guard: at round 0 the payday is skipped by the round gate
  // anyway, so a peace fixture at round 0 cannot tell a peace guard from a round gate.
  {
    const match = atWar(coldWar());
    match.round = 3;
    const offer = useTool(match, "blue", "ceasefire");
    ok(!offer.error, "the cease fire was proposed: " + (offer && offer.error));
    const answer = answerCeasefire(match, "red", true);
    ok(!answer.error && answer.accepted, "the cease fire was accepted: " + JSON.stringify(answer && answer.error));
    ok(match.round > 0, "the fixture is past round 0 (otherwise the round gate would answer for the guard)");
    eq(pay(match).length, 0, "a mid-war cease fire pays no payday, however many rounds the match holds");
    const paid = peacePay(match, 5).find((event) => event.type === "income" && event.side === "blue");
    ok(paid && paid.gross === 2500, "the same minute pays the flat tick instead (" + (paid && paid.gross) + ")");
    pad();
  }

  // ---- AC5c: the tick has the original's own ceiling (money < 20000 units) ---------------------
  {
    eq(peaceRules().cashPerTickCap, 500000, "the shipped cap is the original's 20000 units x 25");
    const match = coldWar();
    match.sides.blue.cash = 500000;
    const before = cash(match.sides.blue);
    const events = peacePay(match, 5);
    eq(cash(match.sides.blue), before, "a side at the 500 b ceiling takes no more tick");
    eq(events.some((event) => event.side === "blue"), false, "and emits no income event for it");
    eq(events.some((event) => event.side === "red"), true, "the other side still ticks");
    pad();
  }

  // ---- AC4: a beat that is not a whole number of ticks pays the same per second --------------
  {
    const many = coldWar();
    const manyBefore = cash(many.sides.blue);
    for (let i = 0; i < 10; i += 1) peacePay(many, 0.7);
    const manyPaid = cash(many.sides.blue) - manyBefore;

    const one = coldWar();
    const oneBefore = cash(one.sides.blue);
    peacePay(one, 7);
    const onePaid = cash(one.sides.blue) - oneBefore;

    eq(Math.abs(manyPaid - onePaid) <= 1, true,
      "ten 0.7 s beats and one 7 s beat pay the same within a unit (" + manyPaid + " vs " + onePaid + ")");
    eq(manyPaid, 3500, "7 s of peacetime is 250 x 2 x 7 = 3500");
    pad();
  }
}

// A blank line between arms keeps the runner's own output readable.
function pad() {
  console.log("");
}
