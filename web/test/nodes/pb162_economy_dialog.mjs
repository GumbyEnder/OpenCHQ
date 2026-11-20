// Node test: PB-162 — the Economy dialog tells the truth about sites and oil.
//
// Four user-visible defects on the shipped build cb46fc4, all in the Economy dialog:
//   1. "Oilfields held 5" beside a top bar whose In charged for 11 type-5 fields (heldSites
//      counted world.json's drawn `oilfield`/`well` sketch, never the subtype);
//   2. "Cities held 37" beside "31 cities" paying, unexplained (six type-3 bases and three
//      capitals are drawn with `kind: "city"`);
//   3. the footer claimed "Bases and capitals pay nothing", which PB-150 contradicts: the first
//      capital is free and every further capital pays as one city;
//   4. "fuel 0 held · rate unknown" sat beside a real oil reserve of 3000.
//
// What this pins:
//   - the 1986 Blue opening counts 29 cities / 3 capitals / 6 bases / 27 docks / 11 oil fields,
//     paying 31, and every figure matches the seat's own oil readout (In 2200 / Out 1754);
//   - a world.json sketch well (kind only, no subtype) is counted as no oil field, and a type-5
//     `facility` is;
//   - the oil line prints the reserve and the In/Out flow, and the generic fuel meter is not
//     drawn beside it;
//   - the footer words are the PB-150 rule, and the old sentence is gone from the page source.

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { seedOwners, payoutFor } from "../../server/economy.mjs";
import { forSeat } from "../../server/view.mjs";
import { economyModel, heldSites, oilLine, siteSubtype } from "../../public/dialogs.mjs";

export const name = "pb162_economy_dialog";

function fail(message) {
  throw new Error(message);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(label + ": " + a + " !== " + b);
}

function must(cond, label) {
  if (!cond) fail(label);
}

export async function run(ctx) {
  // --- 1986 Blue at round 0, the PM's own hand-check view --------------------
  const match = openMatch("1986", matchSites("1986"));
  seedOwners(match);
  const view = forSeat(match, "blue");
  const model = economyModel({ you: "blue", sites: view.sites, seat: view.seat, pieces: view.pieces });

  // The counts are by subtype. The 37 "cities" of the old helper are 29 type-4 cities plus
  // 6 type-3 bases plus 2 capitals drawn as cities, and the third capital has kind "capital".
  eq("1986 Blue holds 29 type-4 cities", model.held.city, 29);
  eq("1986 Blue holds 3 capitals", model.held.capital, 3);
  eq("1986 Blue holds 6 type-3 bases drawn as cities", model.held.base, 6);
  eq("1986 Blue holds 27 docks", model.held.dock, 27);
  eq("1986 Blue holds the 11 type-5 oil fields, not world.json's 5 sketch wells", model.held.oilfield, 11);

  // 29 cities + one paying extra capital = 31, the figure the payday prints.
  eq("the payday pays 31", model.income.cities, 31);
  eq("the payday figure is the economy module's", model.income, payoutFor(match, "blue"));
  eq("the counts reconcile with the payday: cities + capitals - 1", model.held.city + model.held.capital - 1, model.income.cities);

  // --- the stocks line is the real oil budget, not the fuel stand-in ---------
  must(model.oil, "the seat carries no oil budget");
  eq("the reserve is the seat's own", [model.oil.held, model.oil.cap], [3000, 10000]);
  eq("In and Out are the seat's own", [model.oil.in, model.oil.out], [2200, 1754]);
  eq("the top bar's In is 200 per type-5 field", model.oil.in, model.oil.wells * 200);
  eq("the oil line reads as the player sees it", oilLine(model.oil),
    "oil: 3000 of 10000 held · In 2200 / Out 1754 a round");
  eq("no generic fuel meter is drawn beside the oil budget", model.reserves.map((meter) => meter.kind), ["steel"]);
  eq("a scenario that never spends the reserve says so",
    oilLine({ uses: false }), "oil: no oil use in this scenario");

  // --- a sketch well is not an oil field; a type-5 facility is --------------
  eq("a world.json oilfield with no subtype is not a type-5 field", siteSubtype({ kind: "oilfield" }), 0);
  eq("a world.json well with no subtype is not a type-5 field", siteSubtype({ kind: "well" }), 0);
  eq("a type-5 facility is a field", siteSubtype({ kind: "facility", type: 5 }), 5);
  const sketchy = heldSites({
    sites: [
      { id: 1, kind: "oilfield", owner: "blue" },
      { id: 2, kind: "well", owner: "blue" },
      { id: 3, kind: "facility", type: 5, owner: "blue" },
      { id: 4, kind: "city", type: 4, owner: "blue" },
      { id: 5, kind: "city", type: 3, owner: "blue" },
      { id: 6, kind: "city", type: 1, owner: "blue" },
      { id: 7, kind: "facility", type: 5, owner: "red" },
    ],
  }, "blue");
  eq("heldSites counts subtypes and ignores the sketch", sketchy,
    { city: 1, capital: 1, base: 1, dock: 0, oilfield: 1 });

  // --- every dialog figure comes from the payload ---------------------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  for (const row of ["Paying cities", "Cities held", "Capitals held", "Bases held", "Docks held", "Oilfields held"]) {
    must(app.includes('"' + row + '"'), "the economy dialog has no " + row + " row");
  }
  must(!/model\.held\.well/.test(app), "the dialog still reads the retired held.well bucket");
  must(app.includes("Your first capital is free"),
    "the footer does not state the free-first-capital rule");
  must(app.includes("Bases, docks and oil fields pay nothing"),
    "the footer does not state what pays nothing");
  must(!/Bases and capitals pay nothing/.test(app),
    "the retracted footer sentence is still in the page");
  must(app.includes("oilLine("), "the dialog does not draw the oil budget line");
}
