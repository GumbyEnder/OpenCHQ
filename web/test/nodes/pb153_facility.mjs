// Node test: PB-153 — the 20 `facility` sites are the original's oil fields.
//
// The derivation (audit row 21, DERIVED three ways, confirmed or refuted by RE-E6):
//   - oil production counts type 5 (FUN_15f4_0664 4695-4701; setup 13133);
//   - bombing a type-5 site costs oil, not cash (FUN_1ac5_0dbe 8768-8782);
//   - records 64-83 sit outside the 64-record city loops.
// The 38 `wells` in world.json are a hand-placed sketch (modern/docs/RESOURCES.md:19), not
// original data.
//
// What this pins, one line per acceptance criterion:
//   1. a tank on a friendly facility cell is refused with the normal land-placement message;
//   2. a red infantry on Blue's site 64 changes the owner and fires a capture event;
//   3. readiness never lists a facility id;
//   4. a world.json sketched well drives no rule (no oil field, no capture of the well itself);
//   5. the labels say DERIVED and point at RE-E6.

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { buy, seedOwners, occupy } from "../../server/economy.mjs";
import { readinessNeighbours, poolReadiness } from "../../server/readiness.mjs";
import { oilFlow } from "../../server/resources.mjs";
import { isOilField, siteTypeOf } from "../../server/sitetype.mjs";
import { sourceOf } from "../../server/rules.mjs";

export const name = "pb153_facility";

function must(cond, message, fail) {
  if (!cond) fail(message);
}

function eq(actual, expected, label, fail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function opening(era = "1986") {
  const match = openMatch(era, matchSites(era));
  seedOwners(match);
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;
  // The placement rule is a board rule: a purchase needs the width/height/cells the page paints
  // its mask from. The suite's own server serves the board, bundled here (no extract on this host).
  const board = await (await fetch(ctx.base + "/api/board")).json();

  // ---- 1. no land purchase on an oil field ------------------------------------------------
  {
    const match = opening();
    const field = match.sites.find((site) => site && site.type === 5 && site.owner === "blue");
    must(field, "1986 must open with a blue type-5 field", fail);
    eq(field.kind, "facility", "the type-5 site is the asset list's `facility` kind", fail);
    match.sides.blue.cash = 99999;
    const refused = buy(match, "blue", "tank", field.x, field.y, board);
    must(refused && typeof refused.error === "string", "a tank on a friendly oil field must be refused", fail);
    must(/friendly city or base/i.test(refused.error),
      "the refusal must be the normal land-placement message: " + refused.error, fail);
    console.log("pb153 criterion 1 ok: a tank on a friendly facility cell is refused with the land message");
  }

  // ---- 2. a ground unit standing on a type-5 field takes it --------------------------------
  {
    const match = opening();
    const field = match.sites.find((site) => site && site.id === 64);
    must(field, "site 64 must be in the 1986 table", fail);
    eq(field.type, 5, "site 64 is subtype 5 (the RE-E6 probe site)", fail);
    eq(field.owner, "blue", "site 64 opens blue in 1986", fail);
    eq([field.x, field.y], [18, 18], "site 64 is at (18,18), the coordinate RE-E6 hovers", fail);
    match.pieces = [{ id: "r64", side: "red", kind: "infantry", domain: "land", x: field.x, y: field.y, path: [] }];
    const events = occupy(match);
    const captured = events.find((event) => event.type === "capture" && event.site === 64);
    must(captured, "standing on site 64 must fire a capture event: " + JSON.stringify(events), fail);
    eq(field.owner, "red", "site 64 must change hands", fail);
    must(/site_64|oil field/i.test(String(captured.name || "")),
      "the capture event must name the site (or call it an oil field): " + JSON.stringify(captured), fail);
    console.log("pb153 criterion 2 ok: red infantry on site 64 takes it and the capture event names it");
  }

  // ---- 3. readiness never lists an oil field ----------------------------------------------
  {
    const match = opening();
    const city = match.sites.find((site) => site && site.kind === "city" && site.owner === "blue");
    must(city, "1986 must open with a blue city", fail);
    const neighbours = readinessNeighbours(match, "blue", city);
    must(neighbours.length > 0, "the city must have its own readiness list", fail);
    const fields = neighbours.filter((site) => siteTypeOf(site) === 5 || site.kind === "facility");
    eq(fields.length, 0, "a facility must never be a readiness neighbour", fail);
    match.sides.blue.cash = 99999;
    const built = buy(match, "blue", "infantry", city.x, city.y, board);
    must(built && built.ok, "a funded infantry at a friendly city must be bought: " + JSON.stringify(built), fail);
    const listed = built.readiness && Array.isArray(built.readiness.ids) ? built.readiness.ids : [];
    for (const id of listed) {
      const site = match.sites.find((entry) => entry && entry.id === id);
      must(site && siteTypeOf(site) !== 5, "a purchase marked an oil field unready: id " + id, fail);
    }
    must(poolReadiness(match, "blue", city, "infantry") !== null, "poolReadiness must still work on a city", fail);
    console.log("pb153 criterion 3 ok: readiness lists no facility id");
  }

  // ---- 4. the sketched world.json wells drive nothing -------------------------------------
  {
    // A well is drawn and carries a display owner, but it is not an oil field and no piece
    // can take it: the capture path is subtype-driven, not kind-driven.
    const match = openMatch("1986", []);
    match.sites = [
      { id: 900, name: "Sketched well", kind: "oilfield", owner: "blue", x: 30, y: 30 },
      { id: 901, name: "City", kind: "city", type: 4, owner: "blue", x: 40, y: 40 },
    ];
    match.pieces = [];
    seedOwners(match);
    eq(match.sites[0].owner, "blue", "a sketched well keeps its display owner", fail);
    eq(isOilField(match.sites[0]), false, "a sketched well is not an oil field", fail);
    eq(oilFlow(match, "blue").fields, 0, "a sketched well must not count as a producing field", fail);
    eq(oilFlow(match, "blue").in, 200, "with no field the minimum In still applies (1 x 200)", fail);
    match.pieces = [{ id: "r900", side: "red", kind: "infantry", domain: "land", x: 30, y: 30, path: [] }];
    const events = occupy(match);
    eq(match.sites[0].owner, "blue", "a red infantry on a sketched well must not take it", fail);
    eq(events.filter((event) => event.type === "capture").length, 0,
      "a sketched well must fire no capture event: " + JSON.stringify(events), fail);
    console.log("pb153 criterion 4 ok: a world.json well produces, captures and pays nothing");
  }

  // ---- 5. the label is DERIVED and names RE-E6 --------------------------------------------
  {
    const source = String(sourceOf("sites.oilField"));
    must(/DERIVED/.test(source), "the type-5 rule must be labelled DERIVED: " + source, fail);
    must(/RE-E6/.test(source), "the type-5 rule must point at RE-E6: " + source, fail);
    must(/FUN_15f4_0664/.test(source) && /FUN_1ac5_0dbe/.test(source),
      "the derivation must cite both routines: " + source, fail);
    console.log("pb153 criterion 5 ok: DERIVED, RE-E6, FUN_15f4_0664 and FUN_1ac5_0dbe are cited");
  }

  console.log("pb153_facility ok: placement, capture, readiness, sketched wells, labels");
}
