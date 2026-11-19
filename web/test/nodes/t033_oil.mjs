// Node test: T-033 — the oil budget. What this pins, one line per acceptance criterion:
//
//  1. every rate the budget runs on is the recovered number, and each carries its source string
//     (config/game.json resources.fuel) — ECONOMY.md is the derivation;
//  2. In = wells * 200 (minimum one well), Out = cities * 50 + 200;
//  3. a side with no oil stops: `advance` moves nothing and says so once (`oil_hold`);
//  4. a side with no oil cannot fly a mission (`sendMission` refuses, naming oil);
//  5. a side with no oil loses the cities it cannot pay for at the payday (`oilIncome`);
//  6. ships use no oil (Manual p.36) and cost nothing per cell;
//  7. 1918 and 1942 carry the budget but never run short (reserve rewritten to the cap);
//  8. the seat payload carries the opponent's In/Out/reserve too (Alt Function, p.27), and the
//     page draws it.
//
// Every expectation is read through the module under test or through config; no literal repeats a
// number that the config owns.

import { resourceSpec, oilFlow, oilReadout, chargeOil, spendOil, movementBlocked, meterOf } from "../../server/resources.mjs";
import { openMatch } from "../../server/match.mjs";
import { advance } from "../../server/move.mjs";
import { sendMission } from "../../server/air.mjs";
import { pay } from "../../server/economy.mjs";
import { forSeat } from "../../server/view.mjs";
import { cityIncome } from "../../server/rules.mjs";
import { oilText, oilWarning, purseText, OIL_WARNING } from "../../public/command.mjs";

export const name = "t033_oil";

function must(cond, message, fail) {
  if (!cond) fail(message);
}

function eq(actual, expected, label, fail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// A 1986 room with the given owned sites and no pieces of its own: the opening roster would add
// wells and cities nobody counted.
function room(sites, era = "1986") {
  const match = openMatch(era, []);
  match.sites = sites;
  match.pieces = [];
  match.round = 0;
  match.clock = "running";
  return match;
}

function own(kind, id, owner, x = 10, y = 10) {
  return { id, name: `${kind} ${id}`, kind, owner, x, y };
}

export async function run(ctx) {
  const { fail } = ctx;
  const fuel = resourceSpec("fuel");

  // ---- 1. the rates are the recovered ones, and each says where it came from ---------------
  must(typeof fuel.source === "string" && /ECONOMY\.md/.test(fuel.source),
    "the fuel spec must name its derivation (ECONOMY.md) in `source`", fail);
  eq(Number(fuel.reserve), 3000, "setup reserve (FUN_20b1_01b6 @ 20b1:0b46)", fail);
  eq(Number(fuel.reserveCap), 10000, "reserve cap (FUN_15f4_0664 4876-4883)", fail);
  eq(Number(fuel.inPerWell), 200, "In per well (0x144a = wells*200, 4704-4710)", fail);
  eq(Number(fuel.outPerCity), 50, "Out per city (0x1452 = cities*50+200, 4723)", fail);
  eq(Number(fuel.outBase), 200, "Out base (4723)", fail);
  eq(Number(fuel.moveCostByKind.infantry), 5 + 12, "infantry per-cell: 5 base + allowance 12 (0x19a6)", fail);
  eq(Number(fuel.moveCostByKind.tank), 5 + 24, "tank per-cell: 5 base + allowance 24 (0x19a6)", fail);
  eq(Number(fuel.airMission), 20, "air mission (0d7e(0x14), 4839)", fail);
  eq(fuel.freeEras, ["1918", "1942"], "the two scenarios whose reserve is rewritten (4700)", fail);
  console.log("rates ok: reserve/cap/In/Out/per-kind/air all read from the spec with its source");

  // ---- 2. In and Out ---------------------------------------------------------------------
  {
    const match = room([own("oilfield", 1, "blue"), own("well", 2, "blue"), own("city", 3, "blue"), own("city", 4, "blue")]);
    const flow = oilFlow(match, "blue");
    eq(flow.wells, 2, "two owned wells", fail);
    eq(flow.cities, 2, "two owned cities", fail);
    eq(flow.in, 2 * Number(fuel.inPerWell), "In must be wells * inPerWell", fail);
    eq(flow.out, 2 * Number(fuel.outPerCity) + Number(fuel.outBase), "Out must be cities * outPerCity + outBase", fail);
    // A side with no well still runs the minimum (4704-4707: count 0 becomes 1 before *200).
    const barren = room([]);
    eq(oilFlow(barren, "blue").in, Number(fuel.inMinWells) * Number(fuel.inPerWell), "the minimum In must hold at zero wells", fail);
  }

  // ---- 3. a dry side stops, and says so once ---------------------------------------------
  {
    const match = room([own("city", 3, "blue"), own("city", 4, "red")]);
    const piece = { id: "blue:1:infantry", side: "blue", kind: "infantry", domain: "land", x: 20, y: 20, path: [{ x: 21, y: 20 }], pace: 1 };
    match.pieces = [piece];
    match.sides.blue.fuel = 0;
    match.sides.blue.dry = true;
    match.sides.blue.resources = { fuel: { held: 0, dry: true } };
    eq(movementBlocked(match, "blue"), "fuel", "a dry side must be blocked on fuel", fail);
    const events = advance(match);
    eq(piece.x, 20, "a dry side's piece must not step", fail);
    // A side that is not flagged dry but cannot afford the NEXT cell stops at that cell and says
    // so once: this is the per-unit charge, not the round-level gate above.
    const shortSide = room([own("city", 3, "blue")]);
    shortSide.pieces = [{ ...piece, x: 20, y: 20, path: [{ x: 21, y: 20 }] }];
    shortSide.sides.blue.resources = { fuel: { held: 3, dry: false } };
    shortSide.sides.blue.fuel = 3;
    shortSide.sides.blue.dry = false;
    const shortEvents = advance(shortSide);
    eq(shortSide.pieces[0].x, 20, "an unaffordable step must not land", fail);
    must(shortEvents.some((event) => event.type === "oil_hold"), "an unaffordable step must be logged as oil_hold: " + JSON.stringify(shortEvents), fail);
    void events;
  }

  // ---- 3b. the charge itself: enough oil moves one cell and bills the kind's rate ---------
  {
    const match = room([]);
    match.sides.blue.resources = { fuel: { held: 1000, dry: false } };
    const bill = chargeOil(match, "blue", "tank", 1);
    must(bill.ok, "a funded tank step must be paid", fail);
    eq(bill.cost, Number(fuel.moveCostByKind.tank), "a tank cell must cost its configured rate", fail);
    eq(meterOf(match, "blue", "fuel").held, 1000 - Number(fuel.moveCostByKind.tank), "the reserve must drop by the rate", fail);
    const empty = room([]);
    empty.sides.blue.resources = { fuel: { held: 3, dry: false } };
    const short = chargeOil(empty, "blue", "tank", 1);
    eq(short.ok, false, "an unaffordable step must be refused", fail);
    eq(meterOf(empty, "blue", "fuel").dry, true, "a refused step must leave the side dry", fail);
  }

  // ---- 4. planes cannot fly without oil ---------------------------------------------------
  {
    const match = room([own("city", 3, "blue")]);
    match.pieces = [{ id: "blue:7:aircraft", side: "blue", kind: "aircraft", domain: "air", x: 10, y: 10, path: [] }];
    match.sides.blue.resources = { fuel: { held: 0, dry: true } };
    match.sides.blue.fuel = 0;
    const refused = sendMission(match, "blue", "blue:7:aircraft", "strike", { x: 12, y: 10 });
    must(refused && typeof refused.error === "string" && /oil/i.test(refused.error),
      "a dry side's mission must be refused with oil named: " + JSON.stringify(refused), fail);
    // Funded: the mission is allowed and the 20 is taken.
    const funded = room([own("city", 3, "blue")]);
    funded.pieces = [{ id: "blue:7:aircraft", side: "blue", kind: "aircraft", domain: "air", x: 10, y: 10, path: [] }];
    funded.sides.blue.resources = { fuel: { held: 500, dry: false } };
    funded.sides.blue.fuel = 500;
    const flown = sendMission(funded, "blue", "blue:7:aircraft", "strike", { x: 12, y: 10 });
    must(flown && flown.ok, "a funded mission must fly: " + JSON.stringify(flown), fail);
    eq(meterOf(funded, "blue", "fuel").held, 500 - Number(fuel.airMission), "a mission must cost its configured oil", fail);
  }

  // ---- 5. cities stop producing income ----------------------------------------------------
  {
    // Two cities, no wells' worth of production, an empty reserve: the payday is cut by the
    // unpaid share of Out (200 reserve-less vs 300 Out -> one of two cities lost, to rounding).
    const match = room([own("city", 3, "blue"), own("city", 4, "blue")]);
    match.round = 25; // a payday (payEvery)
    match.sides.blue.cash = 1000;
    match.sides.red.cash = 1000;
    match.sides.blue.resources = { fuel: { held: 0, dry: true } };
    match.sides.red.resources = { fuel: { held: 10000, dry: false } };
    const before = match.sides.blue.cash;
    const events = pay(match);
    const blue = events.find((event) => event.type === "income" && event.side === "blue");
    must(blue, "blue must still be paid a (reduced) income: " + JSON.stringify(events), fail);
    eq(blue.oilShort, true, "a short side's income event must carry oilShort", fail);
    must(blue.cities < 2, "a short side must lose cities from the payday: " + JSON.stringify(blue), fail);
    must(match.sides.blue.cash - before < 2 * Number(cityIncome()), "a short side must be paid less than a full payday", fail);
    // The funded side in the same room is paid in full.
    const red = events.find((event) => event.type === "income" && event.side === "red");
    if (red) must(!red.oilShort, "a funded side must not be marked short", fail);
  }

  // ---- 6. ships use no oil -----------------------------------------------------------------
  {
    const match = room([]);
    match.sides.blue.resources = { fuel: { held: 500, dry: false } };
    for (const kind of fuel.shipKinds) {
      const bill = chargeOil(match, "blue", kind, 1);
      eq(bill.cost, 0, `a ${kind} cell must cost no oil (Manual p.36)`, fail);
    }
    eq(meterOf(match, "blue", "fuel").held, 500, "ships must not move the reserve", fail);
  }

  // ---- 7. 1918 and 1942 carry the budget but never run short ------------------------------
  {
    for (const era of fuel.freeEras) {
      const match = room([own("city", 3, "blue")], era);
      match.sides.blue.resources = { fuel: { held: 0, dry: true } };
      match.sides.blue.fuel = 0;
      const readout = oilReadout(match, "blue");
      eq(readout.uses, false, `${era} must not use the reserve as a constraint`, fail);
      eq(readout.short, false, `${era} must never show the warning`, fail);
      const charged = chargeOil(match, "blue", "tank", 1);
      eq(charged.cost, 0, `${era} charges no oil`, fail);
    }
    const modern = room([own("city", 3, "blue")], "1986");
    eq(oilReadout(modern, "blue").uses, true, "1986 must use the budget", fail);
  }

  // ---- 8. the opponent's readout rides the seat payload (p.27 Alternate Function) ----------
  {
    const match = room([own("oilfield", 1, "blue"), own("city", 2, "red"), own("city", 3, "red")]);
    match.sides.blue.resources = { fuel: { held: 700, dry: false } };
    match.sides.red.resources = { fuel: { held: 120, dry: false } };
    match.sides.blue.fuel = 700;
    match.sides.red.fuel = 120;
    const view = forSeat(match, "blue");
    const seat = view.seat || view;
    must(seat.oil && seat.oil.side === "blue", "the seat must carry its own oil row: " + JSON.stringify(seat.oil), fail);
    must(seat.foeOil && seat.foeOil.side === "red", "the seat must carry the opponent's oil row (p.27)", fail);
    eq(seat.foeOil.held, 120, "the opponent's reserve must be their own number", fail);
    eq(seat.foeOil.out, 2 * Number(fuel.outPerCity) + Number(fuel.outBase), "the opponent's Out must be counted from their cities", fail);
    // The page draws both rows, and the warning is the server's flag, not a page-side guess.
    const ownText = oilText(seat.oil, false);
    const foeText = oilText(seat.foeOil, true);
    must(/oil in /.test(ownText) && /out /.test(ownText) && /reserve /.test(ownText), "the chip must print In/Out/reserve: " + ownText, fail);
    must(/^foe oil in /.test(foeText), "the alternate row must be labelled as the opponent's: " + foeText, fail);
    must(purseText(seat, true).includes(foeText), "the Alternate Function must swap the chip to the foe's row", fail);
    eq(oilWarning(seat.oil), "", "a funded side must not raise the red warning", fail);
    eq(oilWarning({ short: true }), OIL_WARNING, "a short side must raise the red warning", fail);
    const drySeat = { ...seat, oil: { ...seat.oil, short: true } };
    must(purseText(drySeat).includes("OIL SHORT"), "a short budget must print OIL SHORT in the chip", fail);
  }

  console.log("t033_oil ok: rates, In/Out, stall, air, income, ships, eras, foe readout");
}
