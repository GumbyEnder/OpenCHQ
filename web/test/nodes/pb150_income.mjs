// Node test: PB-150 — income pays the original's cities.
//
// The original's paying count for a side (FUN_2dfc_1246 @ 2dfc:1246, decompiled.c 25571-25586):
//
//     count(type 4) + max(0, count(type 1) + count(type 2) - 1)
//
// over the sites the side owns, where `type` is the site subtype (the 84-row era table's low
// three bits). Type 3 (base) and type 5 (oil field) never pay; a side's first capital is free,
// every extra one pays like a city. Income is count x money.cityIncome.
//
// What this pins, one line per acceptance criterion:
//   1. the era-table openings pay 1918 Blue 13 / Red 8, 1942 Blue 31 / Red 18, 1986 Blue 31 /
//      Red 10, and the cash is exactly the measured Monitor Four figures (.650/.400/1.550/1.550);
//   2. capturing a type-4 city adds 1; capturing a type-3 base adds 0; two capitals pay for one;
//   3. sites with no subtype (docks, world.json wells) never pay;
//   4. incomeGate(match, side) is the single hook pay() consults;
//   5. the 2023 opening - whose era row is ownerSource "rolled" with every owner null - is paid
//      off seedOwners (world.json countries), not the original's owner file. Those two counts are
//      a pin of today's board, not a measurement of the original.
//
// A captured type-3 base pays 0 (criterion 2), but it does become a legal placement site and air
// base for the side that took it, because friendly() reads the owner byte. That behaviour is
// UNVERIFIED against the original (RE question: in DOSBox, capture an enemy airbase and see
// whether you can buy and place aircraft there); it is stated here so it is a decision to check,
// not a side effect of the capture rule.

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { eraTable } from "../../server/era.mjs";
import { atWar } from "../wartime.mjs";
import { payoutFor, seedOwners, occupy, pay, incomeGate } from "../../server/economy.mjs";
import { cityIncome } from "../../server/rules.mjs";
import { siteTypeOf } from "../../server/sitetype.mjs";

export const name = "pb150_income";

function must(cond, message, fail) {
  if (!cond) fail(message);
}

function eq(actual, expected, label, fail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// T-035 (RE-E4): the payday is a WARTIME rule, and 1986/2023 open in the cold war (which no longer
// runs a round at all), so every fixture here leaves the peace before measuring it.
function opening(era) {
  const match = atWar(openMatch(era, matchSites(era)));
  seedOwners(match);
  return match;
}

// A synthetic room: no roster, so every count below comes from the sites the test wrote.
function room(sites) {
  const match = atWar(openMatch("1986", []));
  match.sites = sites;
  match.pieces = [];
  match.round = 0;
  match.over = false;
  match.sides.blue.cash = 0;
  match.sides.red.cash = 0;
  return match;
}

function site(id, type, owner, x = 10, y = 10) {
  const kind = type === 5 ? "facility" : type === 3 ? "base" : type === 1 || type === 2 ? "capital" : "city";
  return { id, name: `${kind} ${id}`, kind, type, owner, x, y };
}

export async function run(ctx) {
  const { fail } = ctx;
  const perCity = Number(cityIncome());

  // ---- 1. the era-table openings ----------------------------------------------------------
  // The measured Monitor Four figures (docs/re/START_MONEY.md): 1918 .650 Blue / .400 Red,
  // 1942 1.550 Blue, 1986 1.550 Blue. The counts are the original's, not a kind count: 14 of
  // the 84 sites disagree between the asset list's `kind` and the table's subtype.
  {
    const expected = {
      "1918": { blue: 13, red: 8 },
      "1942": { blue: 31, red: 18 },
      "1986": { blue: 31, red: 10 },
    };
    for (const era of Object.keys(expected)) {
      const match = opening(era);
      for (const side of ["blue", "red"]) {
        const paid = payoutFor(match, side);
        eq(paid.cities, expected[era][side], `${era} ${side} paying sites`, fail);
        eq(paid.amount, expected[era][side] * perCity, `${era} ${side} income in millions`, fail);
      }
    }
    eq(payoutFor(opening("1918"), "blue").amount, 650, "1918 Blue pays .650 b (measured)", fail);
    eq(payoutFor(opening("1918"), "red").amount, 400, "1918 Red pays .400 b (measured)", fail);
    eq(payoutFor(opening("1942"), "blue").amount, 1550, "1942 Blue pays 1.550 b (measured)", fail);
    eq(payoutFor(opening("1986"), "blue").amount, 1550, "1986 Blue pays 1.550 b (measured)", fail);
    console.log("pb150 criterion 1 ok: 1918 13/8, 1942 31/18, 1986 31/10 paying sites; .650/.400/1.550/1.550 b");
  }

  // ---- 2. capture adds exactly what the subtype says --------------------------------------
  {
    // A type-4 city: the capturer's count goes up by one.
    const match = room([site(10, 4, "blue", 10, 10), site(11, 4, "blue", 20, 20)]);
    const before = payoutFor(match, "red").cities;
    match.pieces = [{ id: "r1", side: "red", kind: "infantry", domain: "land", x: 10, y: 10, path: [] }];
    occupy(match);
    eq(match.sites[0].owner, "red", "the red infantry must take the type-4 city", fail);
    eq(payoutFor(match, "red").cities, before + 1, "capturing a type-4 city must add 1 to the count", fail);

    // A type-3 base: no income for the capturer.
    const base = room([site(20, 3, "blue", 10, 10), site(21, 4, "blue", 20, 20)]);
    const redBefore = payoutFor(base, "red").cities;
    base.pieces = [{ id: "r2", side: "red", kind: "infantry", domain: "land", x: 10, y: 10, path: [] }];
    occupy(base);
    eq(base.sites[0].owner, "red", "the red infantry must take the type-3 base", fail);
    eq(payoutFor(base, "red").cities, redBefore, "capturing a type-3 base must add 0", fail);

    // Two capitals: the side is paid for exactly one of them.
    const caps = room([site(30, 1, "blue", 10, 10), site(31, 2, "blue", 20, 20), site(32, 3, "blue", 30, 30)]);
    eq(payoutFor(caps, "blue").cities, 1, "two capitals pay for exactly one (the first is free)", fail);
    eq(payoutFor(caps, "blue").amount, perCity, "one extra capital pays one city's income", fail);
    console.log("pb150 criterion 2 ok: type-4 capture +1, type-3 capture +0, two capitals pay 1");
  }

  // ---- 3. no subtype, no income -----------------------------------------------------------
  {
    const docks = room([
      { id: 40, name: "Dock", kind: "dock", owner: "blue", x: 10, y: 10 },
      { id: 41, name: "Well", kind: "oilfield", owner: "blue", x: 11, y: 10 },
      { id: 42, name: "Field", kind: "facility", type: 5, owner: "blue", x: 12, y: 10 },
    ]);
    for (const entry of docks.sites) eq(siteTypeOf(entry), entry.id === 42 ? 5 : 0, `site ${entry.id} subtype`, fail);
    eq(payoutFor(docks, "blue").cities, 0, "docks, sketched wells and oil fields never pay cash", fail);
    console.log("pb150 criterion 3 ok: docks/wells/oil fields pay no cash");
  }

  // ---- 4. incomeGate is the single hook ---------------------------------------------------
  {
    const match = room([site(50, 4, "blue", 10, 10), site(51, 4, "red", 20, 20)]);
    match.round = 1;
    eq(incomeGate(match, "blue"), true, "incomeGate must return true outside PB-156's roll", fail);
    const events = pay(match);
    const blue = events.find((event) => event.type === "income" && event.side === "blue");
    must(blue, "a paying side must still be paid through the gate", fail);
    eq(blue.amount, perCity, "one paying city pays one cityIncome", fail);
    eq(match.sides.blue.cash, perCity, "the pool must hold the income", fail);
    console.log("pb150 criterion 4 ok: incomeGate(match, side) gates the payday");
  }

  // ---- 5. the 2023 opening rides on seedOwners --------------------------------------------
  // 2023's era row is ownerSource "rolled" and every one of its 84 owners is null, so its opening
  // is decided by seedOwners from world.json's country map, not by the original's owner file.
  // world.json's countries are a sketch (like its wells), so the two counts below are a pin of
  // today's board and NOT a measurement of the original: if the sketch moves, this goes red and
  // the number has to be re-derived, not preserved.
  {
    const table = eraTable("2023");
    must(table && Array.isArray(table.sites), "2023 must have a baked era row", fail);
    eq(table.ownerSource, "rolled", "2023 owner source must be the seedOwners path", fail);
    eq(table.sites.filter((entry) => entry.owner).length, 0, "2023 era row must carry no file owners", fail);
    const match = opening("2023");
    must(match.sites.some((entry) => entry.owner === "blue" || entry.owner === "red"),
      "seedOwners must give 2023 an opening owner", fail);
    eq(payoutFor(match, "blue").cities, 13, "2023 Blue paying sites (seedOwners opening)", fail);
    eq(payoutFor(match, "red").cities, 7, "2023 Red paying sites (seedOwners opening)", fail);
    eq(payoutFor(match, "blue").amount, 650, "2023 Blue pays .650 b (seedOwners opening)", fail);
    eq(payoutFor(match, "red").amount, 350, "2023 Red pays .350 b (seedOwners opening)", fail);
    console.log("pb150 criterion 5 ok: 2023 13/7 paying sites off seedOwners (rolled, 0 file owners)");
  }

  console.log("pb150_income ok: era openings, capture counts, subtype-only income, incomeGate, 2023 seedOwners");
}
