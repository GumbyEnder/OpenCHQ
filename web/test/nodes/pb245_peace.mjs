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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { answerCeasefire, useTool } from "../../server/late.mjs";
import { mandatoryRoundsFor, peaceOf, resumeWar } from "../../server/peace.mjs";
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

function fresh(era = "1986", round = 3) {
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
      const match = fresh("1986", 3);
      eq(peaceOf(match), null, "a match that never agreed a truce is not at peace");
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
  });
}
