// t021_layers - aircraft and ground are two occupancy layers, and a hull may be bought at a
// coastal city (T-021; AC1, AC2).
//
// What fails if this is removed:
//   - a plane cannot be placed in a city holding a ground unit -> the air layer is merged with the
//     ground one again, and Shane's point 1 is gone (manual p.22/p.24: air is based at a site)
//   - a ground unit cannot be placed in a city holding a plane -> the same merge, the other way
//   - a second ground unit stacks on a ground unit            -> the fix widened ground stacking,
//     which the task forbids ("Ground-on-ground stacking is unchanged")
//   - a plane cannot base on its own carrier                  -> the carrier occupies its cell on
//     the ground layer and blocks its own aircraft
//   - a ground order onto a city holding a friendly plane is refused -> the walker still treats a
//     based plane as solid ground
//   - a coastal city offers no ship berth                     -> D-025 did not land, ships are back
//     to the 1 px dock cells T-017 already called too small
//   - an inland city or a landlocked base offers a berth      -> D-025 lost its "touches water" test
//   - a hull lands on the city cell instead of the water beside it -> the tie-break is gone
//   - the unready coastal city loses its round                -> readiness stopped applying to ships

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canPlace, friendlySites, layerOf, placementMask, siteLabel } from "../../server/placement.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy } from "../../server/economy.mjs";
import { planOrder } from "../../server/move.mjs";
import { sendMission, transferPlane, airBriefing } from "../../server/air.mjs";
import { configPath, resetRules, rules } from "../../server/rules.mjs";

export const name = "t021_layers";

const W = 320;
const H = 136;

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

// Plain ground everywhere, a shallow sea along the south edge, one dock terrain cell beside the
// coastal city, and a lake nowhere near the inland city.
// Terrain ids (board.TERRAIN): 0 ocean, 1 docks, 2 shallows, 6 city, 8 plain.
function board() {
  const terrain = ["ocean", "docks", "shallows", "lake", "capital", "base", "city", "oilfield",
    "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland", "facility"];
  const cells = new Array(W * H).fill(8);
  for (let x = 0; x < W; x++) for (let y = 100; y <= 110; y++) cells[y * W + x] = 0;
  cells[100 * W + 80] = 1; // the dock terrain beside the coastal city at 80,99
  return { width: W, height: H, cells, terrain };
}

function matchWith(sites, pieces = []) {
  const match = openMatch("1986", []);
  match.sites = sites.map((site) => ({ owner: null, ...site }));
  match.pieces = pieces;
  match.round = 0;
  if (match.sides && match.sides.blue) match.sides.blue.cash = 100000;
  if (match.sides && match.sides.red) match.sides.red.cash = 100000;
  return match;
}

const CITY = { id: 1, name: "Portsmouth", x: 80, y: 99, kind: "city", owner: "blue" };
const INLAND = { id: 2, name: "Kharkov", x: 40, y: 40, kind: "city", owner: "blue" };
const BASE = { id: 3, name: "Fort Base", x: 60, y: 99, kind: "base", owner: "blue" };
// The 150 docks board.matchSites derives on terrain id 1 are sites too; this one is unnamed, which
// is what exercises the "kind and nearest named city" label.
const DOCK = { id: 4, x: 80, y: 100, kind: "dock", owner: "blue" };

export async function run(ctx) {
  const grid = board();

  // --- layerOf: aircraft on air, everything else on ground ------------------------------
  eq("a plane holds the air layer",
    [layerOf("aircraft"), layerOf({ kind: "aircraft", domain: "land" })], ["air", "air"]);
  eq("ground and sea share one layer",
    [layerOf("infantry"), layerOf({ kind: "cruiser", domain: "sea" }), layerOf("tank")],
    ["ground", "ground", "ground"]);

  // --- AC1: a plane and a ground unit share a city -------------------------------
  {
    const tank = { id: "blue:tank:1", side: "blue", domain: "land", kind: "tank", x: 80, y: 99, strength: 20, maxStrength: 20 };
    const match = matchWith([CITY, INLAND, BASE], [tank]);

    // The city is offered to the aircraft even though a tank stands in it.
    const airMask = placementMask(match, "blue", "aircraft", grid);
    eq("a plane may be based where a ground unit stands", airMask.mask[99 * W + 80], 1);
    const air = canPlace(match, "blue", "aircraft", 80, 99, grid);
    eq("canPlace accepts the plane on an occupied friendly city", air.ok, true);
    eq("the plane lands on the city cell, not beside it", air.place, { x: 80, y: 99 });

    const plane = buy(match, "blue", "aircraft", 80, 99, grid);
    if (!plane.ok) fail("buying a plane into an occupied city was refused: " + JSON.stringify(plane));
    eq("the plane stands on the city cell", [plane.piece.x, plane.piece.y], [80, 99]);
    eq("the tank is still there", match.pieces.filter((p) => p.kind === "tank").length, 1);

    // The other direction: a ground unit into a city a plane is based in. A fresh city, because
    // 80,99 already holds the tank - that half of the rule has not moved.
    const solo = matchWith([CITY, BASE]);
    const raptor = { id: "blue:aircraft:9", side: "blue", domain: "land", kind: "aircraft", x: 60, y: 99, strength: 20, maxStrength: 20 };
    solo.pieces = [raptor];
    const ground = canPlace(solo, "blue", "infantry", 60, 99, grid);
    eq("a ground unit may be placed where a plane is based", ground.ok, true);
    const inf = buy(solo, "blue", "infantry", 60, 99, grid);
    if (!inf.ok) fail("an infantry into a plane's city was refused: " + JSON.stringify(inf));
    eq("both pieces are on the cell, one per layer",
      solo.pieces.filter((p) => p.x === 60 && p.y === 99).map((p) => layerOf(p)).sort(), ["air", "ground"]);

    // Ground-on-ground is unchanged: a third ground unit is still refused, and named.
    const third = canPlace(match, "blue", "tank", 80, 99, grid);
    if (!third.error) fail("a second ground unit was allowed to stack");
    if (!/Portsmouth/.test(third.error)) fail("the refusal does not name the site: " + third.error);
    if (!/already holds/.test(third.error)) fail("the refusal does not say the cell is held: " + third.error);
  }

  // --- the air layer is per site: a base too, and a carrier holds its own plane ------
  {
    const carrier = { id: "blue:carrier:1", side: "blue", domain: "sea", kind: "carrier", x: 90, y: 103, strength: 20, maxStrength: 20 };
    const match = matchWith([CITY, INLAND, BASE], [carrier]);
    const mask = placementMask(match, "blue", "aircraft", grid);
    eq("a carrier's own cell is an aircraft berth", mask.mask[103 * W + 90], 1);
    eq("a dock is not an aircraft berth", mask.mask[100 * W + 80], 0);
    const onCarrier = canPlace(match, "blue", "aircraft", 90, 103, grid);
    eq("a plane bases on a carrier that occupies its cell", onCarrier.ok, true);
    // ...and the carrier is not offered to the ground layer's land rule.
    const landMask = placementMask(match, "blue", "infantry", grid);
    eq("a carrier cell is not a land berth", landMask.mask[103 * W + 90], 0);
  }

  // --- AC1, transfer: a plane rebases onto a site holding a ground unit -------------
  {
    const tank = { id: "blue:tank:1", side: "blue", domain: "land", kind: "tank", x: 60, y: 99, strength: 20, maxStrength: 20 };
    // Inside the aircraft's stand-in reach (config air.reach, the same number the missions use):
    // the transfer range itself is not a recovered fact, so the test stays inside it.
    const plane = { id: "blue:aircraft:1", side: "blue", domain: "land", kind: "aircraft", x: 65, y: 99, strength: 20, maxStrength: 20 };
    const match = matchWith([CITY, INLAND, BASE], [tank, plane]);
    const moved = transferPlane(match, "blue", "blue:aircraft:1", { x: 60, y: 99 });
    if (moved.error) fail("a transfer onto an occupied friendly base was refused: " + moved.error);
    eq("the plane rebased onto the base cell", [moved.piece.x, moved.piece.y], [60, 99]);
    eq("the tank is untouched", match.pieces.find((p) => p.id === "blue:tank:1").x, 60);
    // A transfer's round cost is config's air.transferRounds, tagged UNVERIFIED (Q50 sub-item):
    // the manual names the sites, never a cost. 0 is today's file value, so a check against it
    // alone cannot tell "reads config" from "free transfer". Point config at a copy that charges
    // 3 rounds and re-run: a module that hard-codes 0 (or a price) fails here.
    eq("a transfer costs config's transferRounds (UNVERIFIED)",
      Number(moved.piece.inactiveUntil) || 0, Number(rules().air.transferRounds));
    {
      const priced = JSON.parse(readFileSync(configPath(), "utf8"));
      const configFile = path.join(ctx.dataDir, "game-transfer-cost.json");
      priced.air = { ...priced.air, transferRounds: 3 };
      writeFileSync(configFile, JSON.stringify(priced, null, 2));
      const previous = process.env.OPENCHQ_CONFIG;
      process.env.OPENCHQ_CONFIG = configFile;
      resetRules();
      try {
        const probe = { id: "blue:aircraft:2", side: "blue", domain: "land", kind: "aircraft", x: 65, y: 99, strength: 20, maxStrength: 20 };
        const pricedMatch = matchWith([CITY, INLAND, BASE], [probe]);
        pricedMatch.round = 7;
        const paid = transferPlane(pricedMatch, "blue", "blue:aircraft:2", { x: 60, y: 99 });
        if (paid.error) fail("a priced transfer was refused: " + paid.error);
        eq("a priced transfer charges the config rounds", Number(paid.piece.inactiveUntil), 10);
      } finally {
        if (previous === undefined) delete process.env.OPENCHQ_CONFIG;
        else process.env.OPENCHQ_CONFIG = previous;
        resetRules();
      }
    }
    // Enemy ground and open ground are refused.
    const enemyCity = { id: 4, name: "TheirTown", x: 100, y: 99, kind: "city", owner: "red" };
    match.sites.push({ owner: "red", ...enemyCity });
    const refused = transferPlane(match, "blue", "blue:aircraft:1", { x: 100, y: 99 });
    if (!refused.error) fail("a transfer onto an enemy city was allowed");
    const nowhere = transferPlane(match, "blue", "blue:aircraft:1", { x: 70, y: 70 });
    if (!nowhere.error) fail("a transfer onto open ground was allowed");
    eq("the briefing offers a transfer mode",
      airBriefing(match, "blue")[0].missions.some((mission) => mission.mode === "transfer"), true);
  }

  // --- AC1: the walker no longer treats a based plane as solid ground ---------------
  {
    const plane = { id: "blue:aircraft:1", side: "blue", domain: "land", kind: "aircraft", x: 80, y: 99, strength: 20, maxStrength: 20 };
    const inf = { id: "blue:infantry:1", side: "blue", domain: "land", kind: "infantry", x: 80, y: 95, strength: 20, maxStrength: 20, path: [] };
    const match = matchWith([CITY], [plane, inf]);
    match.clock = "running";
    const order = planOrder(match, "blue", "blue:infantry:1", 80, 99);
    if (order.error) fail("a walk into a city holding a based plane was refused: " + order.error);
    if (!Array.isArray(order.path) || order.path.length === 0) fail("the walk planned no path");
  }

  // --- AC2: D-025, a hull from any friendly coastal city or base --------------------
  {
    const match = matchWith([CITY, INLAND, BASE, DOCK]);
    const mask = placementMask(match, "blue", "cruiser", grid);
    const at = (x, y) => mask.mask[y * W + x];
    eq("the coastal city is a berth", at(80, 99), 1);
    eq("the coastal base is a berth", at(60, 99), 1);
    eq("the dock terrain cell beside it is still a berth", at(80, 100), 1);
    eq("an inland city is not a berth", at(40, 40), 0);

    const viaCity = canPlace(match, "blue", "cruiser", 80, 99, grid);
    eq("a click on the coastal city is accepted", viaCity.ok, true);
    // Docks first: 80,100 is the dock terrain cell beside the city.
    eq("the hull lands on the dock cell first", viaCity.place, { x: 80, y: 100 });
    eq("the berth is reported as a dock", viaCity.berth && viaCity.berth.dock, true);

    const bought = buy(match, "blue", "cruiser", 80, 99, grid);
    if (!bought.ok) fail("buying a hull at a coastal city was refused: " + JSON.stringify(bought));
    eq("the piece is on the water, not the city", [bought.piece.x, bought.piece.y], [80, 100]);
    eq("the message names the city", bought.label, "Portsmouth");

    // The dock cell is taken now, so the next hull from the base takes a neighbouring water cell.
    const baseBought = buy(match, "blue", "cruiser", 60, 99, grid);
    if (!baseBought.ok) fail("buying a hull at a coastal base was refused: " + JSON.stringify(baseBought));
    if (!bought.piece || baseBought.piece.y !== 100) fail("the second hull left the water: " + JSON.stringify(baseBought.piece));
    if (baseBought.piece.x < 59 || baseBought.piece.x > 61) fail("the second hull did not land beside the base: " + baseBought.piece.x);

    // An inland city issues no berth at all, and the sentence says so.
    const inland = canPlace(match, "blue", "cruiser", 40, 40, grid);
    if (!inland.error) fail("an inland city issued a ship berth");
    if (!/Kharkov/.test(inland.error)) fail("the inland refusal does not name the city: " + inland.error);
    if (!/inland/.test(inland.error)) fail("the inland refusal does not say why: " + inland.error);

    // friendlySites counts the coastal settlement as a berth, and only with a board.
    eq("two coastal settlements and one dock count with a board", friendlySites(match, "blue", "sea", grid), 3);
    eq("without a board the answer is the docks-only one", friendlySites(match, "blue", "sea"), 1);
  }

  // --- AC2: an unready coastal city still refuses, with its name and its round -------
  {
    const match = matchWith([CITY]);
    match.round = 4;
    match.sites[0].readyRound = 18;
    const off = buy(match, "blue", "cruiser", 80, 99, grid);
    if (!off.error) fail("an unready coastal city sold a hull");
    if (!/Portsmouth isn't ready/.test(off.error)) fail("the unready sentence lost the name: " + off.error);
    if (!/ready at round 18/.test(off.error)) fail("the unready sentence lost the round: " + off.error);
  }

  // --- PB-044: the messages name the place, never the order id ----------------------
  {
    const match = matchWith([CITY]);
    eq("a named site is its name", siteLabel(match, match.sites[0]), "Portsmouth");
    eq("an unnamed site is its kind and the nearest named city",
      siteLabel(match, { id: 9, kind: "dock", x: 81, y: 100 }), "dock near Portsmouth");
    const bought = buy(match, "blue", "infantry", 80, 99, grid);
    if (!bought.ok) fail("a land purchase was refused: " + JSON.stringify(bought));
    eq("the purchase carries the site's name, not the cell", bought.label, "Portsmouth");
  }

  // --- the page reads the site field, and prints no order id -----------------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes("message.site ? { site: message.site }")) {
    fail("the page never passes the site name to the purchase line");
  }
  if (/say\(message\.id \? "Order "/.test(app)) fail("the page still prints an order id in a refusal");
  if (!app.includes('pendingMission === "transfer"')) fail("the page has no transfer order to send");
}
