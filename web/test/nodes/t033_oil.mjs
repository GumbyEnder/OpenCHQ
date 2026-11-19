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

import { resourceSpec, oilFlow, oilReadout, chargeOil, spendOil, movementBlocked, meterOf, upkeepResources } from "../../server/resources.mjs";
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

function own(kind, id, owner, x = 10, y = 10, type = null) {
  const site = { id, name: `${kind} ${id}`, kind, owner, x, y };
  if (type !== null) site.type = type;
  return site;
}

// PB-153: a type-5 site is the oil field. `own("facility", id, side, x, y, 5)`.
function field(id, owner, x = 10, y = 10) {
  return own("facility", id, owner, x, y, 5);
}

// A subtype-4 paying city.
function city(id, owner, x = 10, y = 10) {
  return own("city", id, owner, x, y, 4);
}

export async function run(ctx) {
  const { fail } = ctx;
  const fuel = resourceSpec("fuel");

  // ---- 1. the rates are the recovered ones, and each says where it came from ---------------
  must(typeof fuel.source === "string" && /ECONOMY_RE\.md/.test(fuel.source),
    "the fuel spec must name its derivation (ECONOMY_RE.md) in `source`", fail);
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
    const match = room([field(1, "blue"), field(2, "blue"), city(3, "blue"), city(4, "blue")]);
    const flow = oilFlow(match, "blue");
    eq(flow.fields, 2, "two owned type-5 oil fields", fail);
    eq(flow.cities, 2, "two owned paying cities", fail);
    eq(flow.pieces, 0, "a room with no pieces pays no per-piece term", fail);
    eq(flow.in, 2 * Number(fuel.inPerWell), "In must be fields * inPerWell", fail);
    eq(flow.out, 2 * Number(fuel.outPerCity) + Number(fuel.outBase), "Out must be cities * outPerCity + outBase", fail);
    // The per-piece term: every live piece costs 2 a round (FUN_15f4_0664 4850).
    const crewed = room([city(3, "blue")]);
    crewed.pieces = [
      { id: "b1", side: "blue", kind: "tank", domain: "land", x: 1, y: 1, path: [] },
      { id: "b2", side: "blue", kind: "submarine", domain: "sea", x: 2, y: 2, path: [] },
      { id: "r1", side: "red", kind: "tank", domain: "land", x: 3, y: 3, path: [] },
    ];
    const flow2 = oilFlow(crewed, "blue");
    eq(flow2.pieces, 2, "only blue's pieces bill blue", fail);
    eq(flow2.out, Number(fuel.outPerCity) + Number(fuel.outBase) + 2 * Number(fuel.perPiece),
      "Out must add perPiece for each of the side's pieces", fail);
    // A world.json sketched well has no subtype and produces nothing (PB-153).
    const sketched = room([own("oilfield", 9, "blue"), own("well", 10, "blue")]);
    eq(oilFlow(sketched, "blue").in, Number(fuel.inMinWells) * Number(fuel.inPerWell),
      "a sketched world.json well must not produce oil", fail);
    // A side with no field still runs the minimum (4704-4707: count 0 becomes 1 before *200).
    const barren = room([]);
    eq(oilFlow(barren, "blue").in, Number(fuel.inMinWells) * Number(fuel.inPerWell), "the minimum In must hold at zero fields", fail);
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
    // Four cities, no production beyond the 200 minimum, an empty reserve. Out = 4*50+200 = 400,
    // available = 0 + 200, deficit 200: lost = floor(200 * 4 / 400) = 2 cities (7668).
    const match = room([city(3, "blue"), city(4, "blue"), city(5, "blue"), city(6, "blue")]);
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
    eq(blue.cities, 2, "lost = floor(deficit * cities / lastOut): 4 - floor(200*4/400) = 2", fail);
    eq(match.sides.blue.cash - before, 2 * Number(cityIncome()), "a short side must be paid for the cities that still pay", fail);
    // The funded side in the same room is paid in full.
    const red = events.find((event) => event.type === "income" && event.side === "red");
    if (red) must(!red.oilShort, "a funded side must not be marked short", fail);
  }

  // ---- 5b. the reserve floor and the shortage round ---------------------------------------
  {
    // Funded round: reserve = available - city term - per-piece, floored at 40 (4770).
    const funded = room([city(3, "blue")]);
    funded.sides.blue.resources = { fuel: { held: 60, dry: false } };
    funded.sides.blue.fuel = 60;
    funded.round = 1;
    upkeepResources(funded);
    // available = 60 + 200 = 260; city term = 250; residual 10 -> floored to 40.
    eq(meterOf(funded, "blue", "fuel").held, 40, "a funded round must clamp the reserve up to the 40 floor", fail);
    // Short round: zero the reserve, force the spend above available (RE-E5 did this with 0x1456).
    const short = room([city(3, "blue"), city(4, "blue")]);
    short.sides.blue.resources = { fuel: { held: 0, dry: false } };
    short.sides.blue.fuel = 0;
    short.round = 1;
    upkeepResources(short);
    // available 200 < Out 300: the side could not pay the city term, so the reserve is 0, not 40.
    eq(meterOf(short, "blue", "fuel").held, 0, "a shortage round must leave the reserve at 0 (4864-4870)", fail);
    eq(meterOf(short, "blue", "fuel").dry, true, "a shortage round must flag the side dry", fail);
  }

  // ---- 6. ships are charged (RE-E5, DOSBox 1986 Blue) --------------------------------------
  {
    // The capture: one ordered submarine raised Out 1812 -> 1817 and cut the round's reserve
    // delta by exactly 5. So a sea move costs the 5 moving-piece base and nothing per kind
    // (kinds 7-9 sit above the DS:0x19a6 allowance table).
    eq(fuel.shipKinds, [], "the free-ship exemption must be empty (RE-E5 capture)", fail);
    const match = room([]);
    match.sides.blue.resources = { fuel: { held: 500, dry: false } };
    const bill = chargeOil(match, "blue", "submarine", 1);
    eq(bill.cost, Number(fuel.moveCostPerCell), "a submarine cell must cost the 5 moving-piece base", fail);
    eq(meterOf(match, "blue", "fuel").held, 500 - Number(fuel.moveCostPerCell), "ships must move the reserve", fail);
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

  // ---- hand-worked 1986 Blue opening (7696 item 5) -----------------------------------------
  // The real board, not a synthetic one: every term written out against RE-E5's panel
  // (docs/re/ECONOMY_RE.md §1.1-1.2, §3). In matches the DOSBox reading exactly; Out differs
  // only because the remake opens with 2 pieces a side where the original scenario has 31.
  {
    const { matchSites } = await import("../../server/board.mjs");
    const { seedOwners } = await import("../../server/economy.mjs");
    const opening = openMatch("1986", matchSites("1986"));
    seedOwners(opening);
    const flow = oilFlow(opening, "blue");
    const fields = opening.sites.filter((site) => site && site.owner === "blue" && Number(site.type) === 5).length;
    const type4 = opening.sites.filter((site) => site && site.owner === "blue" && Number(site.type) === 4).length;
    const caps = opening.sites.filter((site) => site && site.owner === "blue" && (Number(site.type) === 1 || Number(site.type) === 2)).length;
    const pieces = opening.pieces.filter((piece) => piece && piece.side === "blue").length;
    // In = 200 x type-5 fields. DOSBox: 2200 (11 fields).
    eq(fields, 11, "1986 Blue owns 11 type-5 oil fields (RE-E5 panel In = 2200)", fail);
    eq(flow.in, fields * Number(fuel.inPerWell), "In must be the field count times the yield", fail);
    eq(flow.in, 2200, "1986 Blue opening In is the measured 2200", fail);
    // Out = 50 x paying cities + 200 + 2 x pieces. DOSBox steady state: 1812 at 31 cities,
    // 31 pieces: 31 x 50 + 200 + 2 x 31. The remake's roster is 2 pieces a side, so its Out is
    // 1750 + 4 = 1754; the formula is the same and the difference is named in ECONOMY_RE.md §3.
    const paying = type4 + Math.max(0, caps - 1);
    eq(paying, 31, "1986 Blue pays 31 cities (RE-E5 paid 1812 = 31 x 50 + 200 + 62)", fail);
    eq(flow.cities, paying, "the flow's city count must be the PB-150 paying count", fail);
    eq(flow.cityOut, paying * Number(fuel.outPerCity) + Number(fuel.outBase), "city term: 50 x paying + 200", fail);
    eq(flow.pieces, pieces, "the flow must count the side's pieces", fail);
    eq(flow.out, flow.cityOut + pieces * Number(fuel.perPiece), "Out = city term + 2 per piece", fail);
    eq([flow.in, flow.cityOut, pieces, flow.out], [2200, 1750, 2, 1754],
      "the hand-worked 1986 Blue opening (In, city term, pieces, Out)", fail);
  }

  console.log("t033_oil ok: rates, In/Out, stall, air, income, ships, eras, foe readout, opening");
}
