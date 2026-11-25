// Node test: PB-245 — peacetime is a STATE the war can leave again (manual printed p.31-32).
//
// The page, verbatim (handed over from /mnt/nas/host-ops/openchq/pb245/manual-p31-p32.txt):
//   "At the start of the 1986 and 2023 scenarios, and at any time during those scenarios that both
//   players agree, peacetime conditions prevail. At the start of the game, this is called the cold
//   war. During a war, it is called a cease-fire."
//   "Duration: Peace lasts for a pre-set amount of time, depending upon the scenario. A counter in
//   Monitor One tells you how much time remains in mandatory peace; after that, either player can
//   start the war by pressing Begin Hostilities/Cease Fire."
//   "Producing units does not cause cities to become unready during peacetime."
//   "Regardless of the number of cities or units, a side does not use or generate oil during
//   peacetime. Cash, however, still accumulates, and at an accelerated rate."
//   "during peacetime, the opposing player's troops are 'invisible' ... The Intel Scan ... all units
//   are revealed ... Your opponent receives a message that you are performing an Intel Scan."
//   p.32 War Status: "allows you to begin hostilities, but only after the mandatory time has elapsed."
//
// Two numbers the page never prints are NOT invented here: the mandatory length and the cash rate
// live in config `peace` (UNVERIFIED). This file loads a config that SETS both explicitly, so the
// resume arms never lean on a default a reviewer would have to bless.
//
// Arms, one per acceptance criterion (AC5, instant transfer, is not in this commit):
//   AC1  accept -> peace; both seats read peace/over/winner; resume refused before the counter,
//        allowed after it, with its log line on both seats
//   AC2  production writes no readyRound while at peace (and does write when the war is on)
//   AC3  the fuel ledger neither charges NOR credits at peace; cash is multiplied by the config rate
//   AC4  enemy troops are invisible at peace; an Intel Scan reveal still crosses that gate
//   AC5  a peacetime transfer lands in the SAME round with no round cost, a hull transfers on
//        water, an aircraft lands ready, and the destination may not be neutral or enemy ground

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { answerCeasefire, useTool } from "../../server/late.mjs";
import { mandatoryRoundsFor, peaceOf, resumeWar } from "../../server/peace.mjs";
import { atWar } from "../wartime.mjs";
import { TRANSFER_AT_WAR, TRANSFER_NEUTRAL, transferPiece } from "../../server/move.mjs";
import { inactiveRounds } from "../../server/air.mjs";
import { isFriendly, ownersFor, regionLabel } from "../../server/territory.mjs";
import { forSeat } from "../../server/view.mjs";
import { logLines } from "../../server/log.mjs";
import { poolReadiness, readyRoundOf } from "../../server/readiness.mjs";
import { pay, upkeep } from "../../server/economy.mjs";
import { meterOf } from "../../server/resources.mjs";
import { resetRules } from "../../server/rules.mjs";

export const name = "pb245_peace";

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

// The two unprinted numbers, set explicitly for this file only.
const MANDATORY = { "1986": 3, "2023": 2 };
const CASH_RATE = 1.25;

function withPeaceConfig(fn) {
  const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb245-"));
  const file = path.join(dir, "game.json");
  shipped.peace = { ...(shipped.peace || {}), mandatoryRounds: { ...MANDATORY }, cashMultiplier: CASH_RATE };
  writeFileSync(file, JSON.stringify(shipped, null, 2));
  const before = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = file;
  resetRules();
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.OPENCHQ_CONFIG; else process.env.OPENCHQ_CONFIG = before;
    resetRules();
  }
}

// PB-245b: 1986/2023 open in the cold war (p.31), so a fixture that needs a WAR leaves it at the
// round it is about to use (the shipped config prints no length; this file's config sets 3/2, and
// `atWar` uses the scenario's own untilRound, so the war starts where the counter reaches zero).
function fresh(era = "1986", round = 3) {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  match.round = round;
  return atWar(match);
}

// The opening state itself, untouched: the cold war as the scenario deals it.
function opening(era = "1986", round = 0) {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  match.round = round;
  return match;
}

function truceAccepted(match) {
  const offer = useTool(match, "blue", "ceasefire");
  if (offer.error) fail("the proposal was refused: " + offer.error);
  const answer = answerCeasefire(match, "red", true);
  if (answer.error) fail("the acceptance was refused: " + answer.error);
  return answer;
}

export async function run() {
  // ---- the shipped file must not invent either number -------------------------------------
  {
    const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
    const block = shipped.peace || {};
    eq(block.mandatoryRounds, {}, "the shipped config prints no mandatory length (p.31 prints none)");
    eq(block.cashMultiplier, 1, "the shipped cash rate is 1: no acceleration on an unmeasured number");
  }

  withPeaceConfig(() => {
    // ---- AC1: the state, both seats, and the counter's own gate ---------------------------
    {
      const match = opening("1986", 3);
      // PB-245b: 1986 now OPENS in the cold war (p.31), so this arm leaves it first - with the same
      // config length it is testing (3), at the round that length is reached - and only then agrees
      // a truce. The state under test below is the agreed cease-fire, not the opening cold war.
      eq(peaceOf(match).coldWar, true, "a fresh 1986 match opens in the cold war (PB-245b)");
      const leave = resumeWar(match, "blue", 3);
      ok(leave && leave.ok, "the opening cold war can be left: " + JSON.stringify(leave && leave.error));
      eq(peaceOf(match).active, false, "a match that has left the peace is not at peace");
      truceAccepted(match);
      eq(match.over, false, "an accepted cease fire does not end the match");
      eq(match.winner, null, "an accepted cease fire names no winner");
      eq(mandatoryRoundsFor(match), MANDATORY["1986"], "the mandatory length comes from config, per scenario");
      const blue = forSeat(match, "blue");
      const red = forSeat(match, "red");
      eq([blue.peace.active, red.peace.active], [true, true], "both seats read peace");
      eq([blue.over, red.over], [false, false], "both seats read over:false");
      eq([blue.winner, red.winner], [null, null], "both seats read winner:null");
      eq([blue.peace.untilRound, red.peace.untilRound], [6, 6], "both seats read the same deadline (round 3 + config 3)");
      eq(blue.peace.canResume, false, "resume is refused while the counter is running");

      const early = resumeWar(match, "blue", 5);
      ok(early.error, "resume before the mandatory peace elapsed is refused");
      eq(early.remaining, 1, "the refusal names the rounds still to run");
      eq(peaceOf(match).active, true, "a refused resume leaves the peace standing");

      const late = resumeWar(match, "blue", 6);
      ok(late && late.ok, "resume is legal on the round the counter reaches zero: " + JSON.stringify(late && late.error));
      eq(peaceOf(match).active, false, "resume clears the peace");
      eq(peaceOf(match).brokenBy, "blue", "the state names the side that broke it");
      eq(late.events[0].type, "peace_broken", "resume emits the peace_broken event");
      const note = late.events[0].note || "";
      ok(/broken the peace/i.test(note), "the sentence says the peace was broken: " + note);
      for (const side of ["blue", "red"]) {
        const lines = logLines(match, side, late.events, 7);
        ok(lines.length > 0, "seat " + side + " reads the broken peace");
      }
      ok(resumeWar(match, "red", 9).error, "a war that is not at peace cannot be resumed");
    }

    // ---- AC2: production does not make a city unready -------------------------------------
    {
      const siteOf = (match) => (match.sites || []).find((site) => site && site.owner === "blue"
        && ["city", "capital", "base"].includes(String(site.kind)));
      // The war arm first: it proves the call site writes when nothing holds it back.
      {
        const match = fresh("1986", 3);
        const site = siteOf(match);
        ok(site, "the fixture has a blue producing site");
        const before = readyRoundOf(site);
        poolReadiness(match, "blue", site, "infantry");
        ok(readyRoundOf(site) > before || siteOf(match).readyRound !== undefined,
          "wartime production writes a readyRound (the arm would pin nothing otherwise)");
      }
      {
        const match = fresh("1986", 3);
        truceAccepted(match);
        const touched = [];
        for (const site of match.sites || []) {
          if (!site || site.owner !== "blue") continue;
          const before = readyRoundOf(site);
          poolReadiness(match, "blue", site, "infantry");
          if (readyRoundOf(site) !== before) touched.push(site.id);
        }
        eq(touched, [], "peacetime production makes no city unready");
      }
    }

    // ---- AC3: the fuel ledger is off BOTH ways, and cash is accelerated ---------------------
    {
      const atWar = fresh("1986", 3);
      const meter = meterOf(atWar, "blue", "fuel");
      ok(meter, "the 1986 seat has a fuel meter");
      meter.held = 1000;
      const heldBefore = Number(meter.held);
      upkeep(atWar);
      ok(Number(meter.held) !== heldBefore, "wartime upkeep settles the fuel ledger (the arm needs a live one)");

      const atPeace = fresh("1986", 3);
      truceAccepted(atPeace);
      const peaceMeter = meterOf(atPeace, "blue", "fuel");
      peaceMeter.held = 1000;
      peaceMeter.lastOut = 0;
      const peaceBefore = Number(peaceMeter.held);
      upkeep(atPeace);
      eq(Number(peaceMeter.held), peaceBefore, "peacetime neither uses nor generates oil");
    }
    {
      const war = fresh("1986", 1);
      const peace = fresh("1986", 1);
      truceAccepted(peace);
      const warIncome = pay(war).find((event) => event.type === "income" && event.side === "blue");
      const peaceIncome = pay(peace).find((event) => event.type === "income" && event.side === "blue");
      ok(warIncome, "the wartime payday produced an income event");
      ok(peaceIncome, "the peacetime payday produced an income event");
      eq(peaceIncome.cities >= warIncome.cities, true,
        "peacetime does not take cities off the payday for oil (" + peaceIncome.cities + " vs " + warIncome.cities + ")");
      if (warIncome.gross > 0) {
        eq(peaceIncome.gross, Math.round(warIncome.gross * CASH_RATE),
          "the cash rate is the config's (" + CASH_RATE + "): peace " + peaceIncome.gross + ", war " + warIncome.gross);
      }
    }

    // ---- AC4: the enemy is invisible at peace, and a scan still crosses it -----------------
    // The enemy is put INSIDE ordinary sight of a friendly piece first, so the arm measures the
    // peace gate itself: a far-away piece is hidden by the sight rule under any rule, and an arm
    // built on one stays green when the gate is deleted (measured: it did, before this fixture).
    {
      const match = fresh("1986", 3);
      const mine = (match.pieces || []).find((piece) => piece.side === "blue");
      const enemy = (match.pieces || []).find((piece) => piece.side === "red");
      ok(mine && enemy, "the fixture has a piece a side");
      enemy.x = mine.x;
      enemy.y = Number(mine.y) > 0 ? Number(mine.y) - 1 : Number(mine.y) + 1;
      const seen = () => forSeat(match, "blue").pieces.some((piece) => piece.id === enemy.id);
      ok(seen(), "the adjacent enemy piece is visible while the war is on (the arm needs a live sight path)");
      truceAccepted(match);
      ok(!seen(), "an enemy piece inside ordinary sight is invisible to the other seat during peacetime");
      enemy.revealedRound = Number(match.round);
      ok(seen(), "an Intel Scan reveal still shows the piece at peace (p.31 Intel Scan)");
    }

    // ---- AC5: the peacetime transfer ---------------------------------------------------------
    // p.31: "units may be transferred from one location in the world to another, instantly ...
    // This does not cause air units to become unready" and "units may not be produced in or
    // transferred to neutral or enemy territory". The arm reads the round before and after, so
    // "instant" is a measurement and not the absence of a field.
    {
      const blueCity = (match) => (match.sites || []).find((site) => site && site.owner === "blue"
        && ["city", "capital", "base"].includes(String(site.kind)));
      const soldierOf = (match) => (match.pieces || []).find((piece) => piece && piece.side === "blue"
        && piece.domain !== "sea" && piece.kind !== "aircraft");

      // (a) the war is on: the op is refused, and nothing moves.
      {
        const war = fresh("1986", 3);
        const soldier = soldierOf(war);
        const city = blueCity(war);
        const before = { x: soldier.x, y: soldier.y };
        const refused = transferPiece(war, "blue", soldier.id, city.x, city.y);
        eq(refused.error, TRANSFER_AT_WAR, "a transfer is refused while the war is on");
        eq([soldier.x, soldier.y], [before.x, before.y], "the refused transfer moved nothing");
      }

      // (b) at peace: same round, no cost, the piece is there and it is not walking.
      {
        const match = fresh("1986", 3);
        truceAccepted(match);
        const soldier = soldierOf(match);
        const city = blueCity(match);
        const done = transferPiece(match, "blue", soldier.id, city.x, city.y);
        ok(done && done.ok, "a peacetime transfer is accepted: " + JSON.stringify(done && done.error));
        eq(match.round, 3, "a transfer does not advance the round (instant, p.31)");
        eq([soldier.x, soldier.y], [city.x, city.y], "the piece is on the destination cell in the same round");
        eq(soldier.path, [], "a transfer leaves no path to walk: nothing is queued");
        eq(done.rounds, 0, "a transfer quotes no rounds");

        // (c) neutral and enemy GROUND are refused (p.31), and the sentence says so. The enemy
        // site is a nation's ground; the neutral cell is a region no side owns.
        const enemy = (match.sites || []).find((site) => site && site.owner === "red");
        ok(enemy, "the fixture has an enemy site");
        eq(transferPiece(match, "blue", soldier.id, enemy.x, enemy.y).error, TRANSFER_NEUTRAL,
          "an enemy city is not a transfer destination");
        const owners = ownersFor(match);
        let neutral = null;
        for (let rid = 0; rid < (owners ? owners.length : 0) && !neutral; rid += 1) {
          if (owners[rid] !== null) continue;
          const label = regionLabel(rid);
          if (label && !isFriendly(match, "blue", label.x, label.y)) neutral = label;
        }
        ok(neutral, "the fixture has a neutral region (the arm would otherwise pin nothing)");
        eq(transferPiece(match, "blue", soldier.id, neutral.x, neutral.y).error, TRANSFER_NEUTRAL,
          "neutral ground is not a transfer destination");
        eq([soldier.x, soldier.y], [city.x, city.y], "the refused transfers left the piece where it was");
      }

      // (d) a hull transfers across water - open sea is unassigned, not a nation's territory, so
      // the neutral/enemy sentence does not apply to it; the water rule does.
      {
        const match = fresh("1986", 3);
        truceAccepted(match);
        const hull = (match.pieces || []).find((piece) => piece && piece.side === "blue" && piece.domain === "sea");
        ok(hull, "the fixture has a blue hull");
        const tx = Number(hull.x) + 2;
        const ty = Number(hull.y);
        const done = transferPiece(match, "blue", hull.id, tx, ty);
        ok(done && done.ok, "a hull transfers on water: " + JSON.stringify(done && done.error));
        eq([hull.x, hull.y], [tx, ty], "the hull is on the water cell it was sent to");
        eq(match.round, 3, "the hull's transfer spent no round");
      }

      // (e) an aircraft lands READY and only on a friendly strip (p.22 berth + p.31 readiness).
      {
        const match = fresh("1986", 3);
        truceAccepted(match);
        const soldier = soldierOf(match);
        const plane = {
          id: "blue:air", side: "blue", kind: "aircraft", domain: "air",
          x: Number(soldier.x), y: Number(soldier.y), path: [], pace: 1,
          strength: 100, maxStrength: 100,
        };
        match.pieces.push(plane);
        // A plane that still owes rounds is exactly the case p.31 names: the transfer must not
        // LEAVE it unready, and it must not ADD to its wait either.
        plane.inactiveUntil = Number(match.round) + 2;
        const strips = (match.sites || []).filter((site) => site && site.owner === "blue"
          && ["city", "capital", "base"].includes(String(site.kind)));
        // The plane must MOVE: a strip on its own cell would be refused as "already on that cell"
        // and the arm would pin the wrong sentence.
        const strip = [...strips].reverse().find((site) => Number(site.x) !== Number(plane.x)
          || Number(site.y) !== Number(plane.y));
        ok(strip, "the fixture has a friendly air strip");
        const done = transferPiece(match, "blue", plane.id, strip.x, strip.y);
        ok(done && done.ok, "an aircraft transfers to a friendly city: " + JSON.stringify(done && done.error));
        eq([plane.x, plane.y], [strip.x, strip.y], "the aircraft is based on the strip it was sent to");
        eq(inactiveRounds(plane, match.round), 0, "the transfer did not leave the aircraft unready (p.31)");
        ok(done.ready === true, "the transfer reports the aircraft ready");

        // A friendly CELL that is not a strip is refused: p.22 still holds at peace.
        const owners = ownersFor(match);
        let openGround = null;
        for (let rid = 0; rid < (owners ? owners.length : 0) && !openGround; rid += 1) {
          if (owners[rid] !== "blue") continue;
          const label = regionLabel(rid);
          if (!label) continue;
          const site = (match.sites || []).find((entry) => entry
            && Number(entry.x) === Number(label.x) && Number(entry.y) === Number(label.y));
          if (!site) openGround = label;
        }
        ok(openGround, "the fixture has friendly ground with no air strip on it");
        const refused = transferPiece(match, "blue", plane.id, openGround.x, openGround.y);
        ok(refused.error, "an aircraft does not transfer onto open friendly ground");
        eq([plane.x, plane.y], [strip.x, strip.y], "the refused air transfer moved nothing");
      }
    }
  });
}
