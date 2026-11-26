// pb268_peace_income — at peace the purse names the TICK, not a round that never runs (PB-268).
//
// What fails if this is removed:
//   - the strip goes back to "+1.55b/rd" and the chip title to "payment in 1 round" while the cold war
//     pays a flat 500/s and the round counter is frozen at 0 — the contradiction frodo measured on the
//     served build (room 9548 §5: chip "57b +1.55b/rd", title "payment in 1 round", cash +2500 per beat);
//   - a client-side constant replaces the config: the second and third seats below carry DIFFERENT
//     peaceIncome rates (100 x 3 = 300/s, 750 x 2 = 1500/s), so a client that hardcodes 500 reds;
//   - the Economy dialogue goes back to its three war rows plus the Alternate Function's foe line at
//     peace, which is FOUR false sentences, not one.
//
// The server arm is the config binding: view.mjs seatStatus builds `peaceIncome` from peaceRules(), so
// cutting config/game.json's peace.cashPerTick (250 -> 0) or ticksPerSecond (2 -> 1) reds THIS node —
// that is the mutant pair the ticket names, and it fails here rather than only in a browser.
//
// Both states are covered (PB-268 AC3): war, then peace, then war again on a real 1986 match.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { matchSites, resolveDataRoot } from "../../server/board.mjs";
import { forSeat } from "../../server/view.mjs";
import { resumeWar } from "../../server/peace.mjs";
import { resetRules } from "../../server/rules.mjs";
import {
  formatRate,
  peaceIncomeOf,
  purseSummary,
  purseSummaryParts,
  purseText,
} from "../../public/command.mjs";
import { economyModel, foeIncomeValue, paydayRows } from "../../public/dialogs.mjs";

export const name = "pb268_peace_income";

function fail(message) {
  throw new Error(message);
}

function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(label + ": got " + a + ", want " + b);
}

function ok(value, label) {
  if (!value) fail(label);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const shippedPath = path.resolve(here, "..", "..", "..", "config", "game.json");

// A seat as the server sends it at WAR: the wartime payday, the round countdown, no peaceIncome.
const warSeat = {
  cash: 57000,
  fuel: 8,
  payIn: 1,
  payEvery: 1,
  income: { cities: 31, wells: 0, cashWells: 0, amount: 1550 },
  oil: null,
  foeOil: null,
  reserves: [],
};

// The same seat at PEACE: the countdown still reads 1 (the round never advances) and the server's
// peaceIncome is what the page has to print instead.
function peaceSeat(perTick = 250, ticksPerSecond = 2) {
  return {
    ...warSeat,
    peaceIncome: { perTick, ticksPerSecond, perSecond: perTick * ticksPerSecond, cap: 500000 },
  };
}

export async function run(ctx) {
  // ---- WAR: every string is byte-identical to what shipped (PB-180's legs stay unrelaxed) --------
  {
    const parts = purseSummaryParts(warSeat);
    eq("war: the strip's cash leg", parts.cash, "57b");
    eq("war: the strip's income leg", parts.income, " +1.55b/rd");
    eq("war: the strip", purseSummary(warSeat), "57b +1.55b/rd");
    const full = purseText(warSeat);
    ok(/payment in 1 round/.test(full), "war: the chip title keeps the payday countdown: " + full);
    ok(!/peace income/.test(full), "war: the chip title claims no peace income: " + full);
    eq("war: no peace rate on the seat", peaceIncomeOf(warSeat), null);

    const model = economyModel({
      seat: warSeat,
      you: "blue",
      peace: { active: false },
      opponent: { income: { cities: 31, amount: 1550 } },
      pieces: [],
      sites: [],
    });
    eq("war: the dialogue model reads the peace state", model.peace, { active: false, income: null });
    const rows = paydayRows(model);
    eq("war: three payday rows", rows.map((row) => row.label), ["Next payday", "Payday every", "Payday worth"]);
    eq("war: next payday", rows[0].value, "in 1 round");
    eq("war: payday every", rows[1].value, "1 round");
    eq("war: payday worth", rows[2].value, "1.55b per round · 31 cities + 0 paying oil");
    eq("war: the foe line is the other side's payday", foeIncomeValue(model), "1.55b per round");
  }

  // ---- PEACE: the tick, at the config's rate, and no row claims a round -------------------------
  {
    const seat = peaceSeat();
    const parts = purseSummaryParts(seat);
    eq("peace: the strip's cash leg", parts.cash, "57b");
    eq("peace: the strip's income leg is per second", parts.income, " +500M/s");
    eq("peace: the strip", purseSummary(seat), "57b +500M/s");
    const full = purseText(seat);
    ok(/peace income 500M a second \(250M a tick, 2 ticks a second\)/.test(full),
      "peace: the chip title names the tick and its rate: " + full);
    ok(!/payment in \d/.test(full), "peace: the chip title still claims a round: " + full);
    ok(!/\/rd/.test(purseSummary(seat)), "peace: the strip still claims a round");

    // The Alternate Function still says whose leg it is; at peace both seats are paid the same tick.
    eq("peace: the alternate marks the foe leg", purseSummaryParts(seat, { cities: 31, amount: 1550 }).income,
      " +foe 500M/s");

    const model = economyModel({
      seat,
      you: "blue",
      peace: { active: true },
      opponent: { income: { cities: 31, amount: 1550 } },
      pieces: [],
      sites: [],
    });
    eq("peace: the model carries the rate", model.peace.active, true);
    eq("peace: the model's rate is the server's", model.peace.income.perSecond, 500);
    const rows = paydayRows(model);
    eq("peace: ONE row, and it is not the countdown", rows.length, 1);
    eq("peace: the row is the peace income", rows[0].label, "Peace income");
    eq("peace: the row's text", rows[0].value, "500M a second (250M a tick, 2 a second) · no payday during the peace");
    ok(!/round/.test(rows[0].label + " " + rows[0].value), "peace: a row still claims a round: " + rows[0].value);
    eq("peace: the foe line is the tick, not a war payday", foeIncomeValue(model),
      "500M a second (the peace tick, both seats)");
  }

  // ---- NOT HARDCODED: a different config rate has to move every label ---------------------------
  {
    const slow = peaceSeat(100, 3);
    eq("config 100 x 3: the strip", purseSummaryParts(slow).income, " +300M/s");
    ok(/peace income 300M a second \(100M a tick, 3 ticks a second\)/.test(purseText(slow)),
      "config 100 x 3: the chip title follows the config: " + purseText(slow));
    const model = economyModel({ seat: slow, you: "blue", peace: { active: true }, pieces: [], sites: [] });
    eq("config 100 x 3: the dialogue row", paydayRows(model)[0].value,
      "300M a second (100M a tick, 3 a second) · no payday during the peace");

    const fast = peaceSeat(750, 2);
    eq("config 750 x 2: the strip reads in billions", purseSummaryParts(fast).income, " +1.5b/s");
    eq("formatter: millions", formatRate(500), "500M");
    eq("formatter: billions", formatRate(1500), "1.5b");
    eq("formatter: a zero rate is a rate, not an absence", formatRate(0), "0M");
  }

  // ---- A PEACE THAT PAYS NOTHING STILL SAYS SO (frodo 9569 §3f) --------------------------------
  // "Row disappears" is indistinguishable from "peace is off": the zero cut must print 0M/s.
  {
    const zero = peaceSeat(0, 2);
    eq("zero rate: the strip prints an explicit zero", purseSummaryParts(zero).income, " +0M/s");
    ok(/peace income 0M a second/.test(purseText(zero)),
      "zero rate: the chip title says the peace pays nothing: " + purseText(zero));
    const model = economyModel({ seat: zero, you: "blue", peace: { active: true }, pieces: [], sites: [] });
    eq("zero rate: the dialogue keeps the row and prints 0M", paydayRows(model)[0].label, "Peace income");
    eq("zero rate: the dialogue row's text", paydayRows(model)[0].value,
      "0M a second (0M a tick, 2 a second) · no payday during the peace");
    eq("zero rate: the foe row is still a peace row", foeIncomeValue(model), "0M a second (the peace tick, both seats)");
  }

  // ---- STRUCTURAL: the client owns no rate, and the readout has one gated producer -------------
  // Frodo 9569 §3f G1: grade this structurally rather than with a digit grep over JavaScript.
  {
    const clientDir = path.resolve(here, "..", "..", "public");
    const clients = readdirSync(clientDir).filter((file) => file.endsWith(".mjs"));
    for (const file of clients) {
      const text = readFileSync(path.join(clientDir, file), "utf8");
      ok(!/\b250\b/.test(text), "client " + file + " carries the config's per-tick amount (250)");
      ok(!/import[^;]*peaceRules/.test(text), "client " + file + " imports the server's peace rules");
    }
    const view = readFileSync(path.resolve(here, "..", "..", "server", "view.mjs"), "utf8");
    ok(/peaceActive\(match\) \? peaceRules\(\) : null/.test(view),
      "view.mjs no longer gates the peace readout on peaceActive()");
    const servers = readdirSync(path.resolve(here, "..", "..", "server"))
      .filter((file) => file.endsWith(".mjs") && file !== "view.mjs");
    for (const file of servers) {
      ok(!readFileSync(path.resolve(here, "..", "..", "server", file), "utf8").includes("peaceIncome"),
        "server " + file + " also produces peaceIncome; view.mjs must be the only producer");
    }
  }

  // ---- THE SERVER: peaceIncome comes from config, is absent at war, and flips back --------------
  if (!resolveDataRoot()) {
    return ctx.skip("pb268: no reference extract (set OPENCHQ_DATA / OPENCHQ_EXTRACT), server arm skipped");
  }
  {
    resetRules();
    const shipped = JSON.parse(readFileSync(shippedPath, "utf8")).peace || {};
    const perSecond = shipped.cashPerTick * shipped.ticksPerSecond;

    const match = openMatch("1986", matchSites("1986"));
    match.clock = "running";
    const frame = forSeat(match, "blue");
    eq("a 1986 room opens at peace", frame.peace && frame.peace.active, true);
    // The seat's tick IS the config pair - no second copy of the rule on the server, none on the page.
    eq("the seat carries the tick exactly as config pays it", frame.seat.peaceIncome, {
      perTick: shipped.cashPerTick,
      ticksPerSecond: shipped.ticksPerSecond,
      perSecond,
      cap: shipped.cashPerTickCap,
    });
    // The shipped pair, printed. A config cut (250->0, 2->1) reds HERE - on the label the fix owns -
    // rather than on a guard assertion about the config itself.
    eq("the shipped pair is 250 x 2 = 500 a second", perSecond, 500);
    eq("the live seat frame prints the tick", purseSummaryParts(frame.seat).income, " +500M/s");
    ok(/peace income 500M a second/.test(purseText(frame.seat)),
      "the live chip title does not name the tick: " + purseText(frame.seat));
    ok(!/payment in \d/.test(purseText(frame.seat)),
      "the live seat frame still claims a round: " + purseText(frame.seat));

    // AC2: Begin Hostilities puts the per-round text back on the SAME room.
    const back = resumeWar(match, "blue", match.round);
    ok(back && back.ok, "the cold war could not be broken: " + JSON.stringify(back));
    const warFrame = forSeat(match, "blue");
    eq("after Begin Hostilities the tick is gone", warFrame.seat.peaceIncome, null);
    ok(/ \+\d*(\.\d+)?b\/rd$/.test(purseSummaryParts(warFrame.seat).income),
      "after Begin Hostilities the strip is not per-round: " + purseSummaryParts(warFrame.seat).income);
    ok(/payment in \d/.test(purseText(warFrame.seat)),
      "after Begin Hostilities the countdown is not back: " + purseText(warFrame.seat));
    eq("after Begin Hostilities the room is at war", warFrame.peace && warFrame.peace.active, false);
  }
}
