// Node test: buying, oil ownership, income and per-side fuel (graph nodes buy, oil,
// income, fuel). Drives web/server/economy.mjs directly over a match built to the shape
// in docs/CONTRACTS.md.
//
// What breaks if this feature is removed: a purchase would never spend or mark its city,
// a nuke would be accepted, wells would never change owner, income would never land on
// round 25 (or would land on round 24), and a dry side would keep a full reserve.

import { priceOf } from "../../server/rules.mjs";
import { resourceSpec } from "../../server/resources.mjs";
import { startPool } from "../../server/rules.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy, capture, occupy, pay, upkeep } from "../../server/economy.mjs";

export const name = "economy";

// The board asset list: Washington and Moscow are capitals (not cities), the cities and
// the oilfields name the country they sit in, and one city and one field are neutral.
const SITES = [
  { id: 0, name: "Washington", x: 79, y: 44, kind: "capital", country_id: 0 },
  { id: 1, name: "Moscow", x: 183, y: 25, kind: "capital", country_id: 1 },
  { id: 10, name: "New York", x: 80, y: 40, kind: "city", country_id: 0 },
  { id: 11, name: "Chicago", x: 75, y: 42, kind: "city", country_id: 0 },
  { id: 14, name: "Denver", x: 70, y: 42, kind: "city", country_id: 0 },
  { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", country_id: 1 },
  { id: 13, name: "Riyadh", x: 200, y: 60, kind: "city", country_id: 20 },
  { id: 20, name: "Norfolk", x: 2, y: 16, kind: "dock", country_id: 0 },
  { id: 22, name: "Norfolk Roads", x: 4, y: 16, kind: "dock", country_id: 0 },
  { id: 21, name: "Sevastopol", x: 299, y: 69, kind: "dock", country_id: 1 },
  { id: 30, name: "Volga", x: 190, y: 30, kind: "oilfield", country_id: 1 },
  { id: 31, name: "Permian", x: 70, y: 50, kind: "oilfield", country_id: 0 },
  { id: 32, name: "Ghawar", x: 210, y: 65, kind: "oilfield", country_id: 20 },
];

function freshMatch() {
  const match = openMatch("1986", []);
  match.sites = SITES.map((site) => ({ ...site, owner: null }));
  return match;
}

// A board to place on: ocean everywhere, with plain ground around the blue sites and off the blue
// dock, so the placement rule (a friendly city or base for land and air, a friendly dock for
// ships) can be exercised without the real extract.
function boardFixture() {
  const width = 320;
  const height = 136;
  const terrain = ["ocean", "docks", "shallows", "lake", "capital", "base", "city", "oilfield",
    "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland", "facility"];
  const cells = new Array(width * height).fill(0); // ocean
  for (let y = 32; y <= 52; y++) {
    for (let x = 58; x <= 92; x++) cells[y * width + x] = 8; // plain around the blue cities
  }
  for (let y = 12; y <= 20; y++) {
    for (let x = 0; x <= 8; x++) cells[y * width + x] = 8; // plain around the blue dock
  }
  return { width, height, cells, terrain };
}

function siteOf(match, id) {
  return match.sites.find((site) => site.id === id);
}

export async function run(ctx) {
  const { fail } = ctx;
  const must = (cond, message) => {
    if (!cond) fail(message);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const reserve = Number(resourceSpec("fuel").reserve);
  const burn = Number(resourceSpec("fuel").burn);

  // ---- oil: wells and cities start with the country they are in -------------------------
  const match = freshMatch();
  eq(siteOf(match, 30).owner, null, "ownership must not be pre-set by the fixture");
  eq(match.sides.blue.cash, startPool("1986"), "blue pool at open");
  // The early start pool is a stand-in of 9 billion (T-001 leaves startPool alone); an infantry
  // now costs the recovered 10 billion, so fund the fixture rather than pretend the stand-in is
  // the price source.
  match.sides.blue.cash = 100000;
  match.sides.red.cash = 100000;

  const first = upkeep(match);

  eq(siteOf(match, 30).owner, "red", "a Russian well starts Red");
  eq(siteOf(match, 31).owner, "blue", "a USA well starts Blue");
  eq(siteOf(match, 32).owner, null, "any other country's well stays neutral");
  eq(siteOf(match, 12).owner, "red", "a Soviet city starts Red");
  eq(siteOf(match, 13).owner, null, "a neutral city has no owner");
  eq(siteOf(match, 0).owner, null, "a capital is not a country claim");
  // each side starts at its own reserve and burns a round with no unit on a well
  eq(match.sides.blue.fuel, reserve - burn, "blue's own reserve after one dry round");
  eq(match.sides.red.fuel, reserve - burn, "red's own reserve after one dry round");
  eq(match.sides.blue.dry, false, "blue is not dry yet");
  eq(match.sides.red.dry, false, "red is not dry yet");
  must(Array.isArray(first), "upkeep returns an events list");

  // ---- buy: the setup phase spends the start pool --------------------------------------
  // A purchase used to be free until the clock first ran, which made a 2023 start a free
  // army: fill the board, then press Run. The start pool is what the setup phase spends.
  //
  // Where a purchase may stand is placement.mjs, not a city or a dock: land and air go on ground
  // inside the seat's own zone, hulls go into coastal water. The fixture board is ocean with plain
  // ground around the blue sites.
  const board = boardFixture();

  const firstBuy = buy(match, "blue", "infantry", 80, 40, board);
  must(firstBuy && firstBuy.ok === true, "a setup purchase was refused: " + JSON.stringify(firstBuy));
  eq(firstBuy.piece.kind, "infantry", "bought piece kind");
  eq(firstBuy.piece.side, "blue", "bought piece side");
  eq(firstBuy.piece.domain, "land", "infantry domain");
  eq(firstBuy.piece.x + "," + firstBuy.piece.y, "80,40", "a purchase stands on the cell it was placed on");
  const infantryPrice = priceOf("infantry");
  eq(match.sides.blue.cash, 100000 - infantryPrice, "a setup purchase must spend its price");
  // Readiness (T-011): the city produced a 10 billion infantry, so it and the friendly cities
  // within the config radius are unready until the round the server names. New York's neighbours
  // inside radius 5 are itself and Chicago, so the weight is 1 + 2 x cityWeight (1.5) and
  // 10 x 1.5 rounds up to 15.
  must(Number(siteOf(match, 10).readyRound) > 0, "a purchase must put its city on a ready round");
  eq(siteOf(match, 10).readyRound, 15, "the buying city's ready round (10b infantry, two cities)");
  eq(siteOf(match, 11).readyRound, 15, "a nearby friendly city must go unready too");
  // A neighbouring city is refused while it is unready, in the words AC4 names.
  const tired = buy(match, "blue", "infantry", 75, 42, board);
  must(tired && tired.error, "an unready city accepted a purchase");
  must(/ready at round 15/.test(tired.error), "the unready refusal must name the round: " + tired.error);

  // two pieces cannot share a cell
  const shared = buy(match, "blue", "infantry", 80, 40, board);
  must(shared && shared.error, "two pieces were allowed to share a cell");
  must(/share/.test(shared.error), "wrong refusal for a shared cell: " + shared.error);

  // ---- buy: a nuke is always refused ---------------------------------------------------
  const cashBeforeNuke = match.sides.blue.cash;
  const nuke = buy(match, "blue", "nuke", 70, 42, board);
  must(nuke && nuke.error, "a nuke was accepted");
  must(/refus/i.test(nuke.error), "a nuke must be refused: " + nuke.error);
  eq(match.sides.blue.cash, cashBeforeNuke, "a refused nuke must not spend");
  eq(match.pieces.filter((piece) => piece.kind === "nuke").length, 0, "a nuke piece was placed");

  // ---- buy: after the clock has run it spends the price and the city goes unready ------
  match.round = 3;
  match.clock = "running";
  const tankPrice = priceOf("tank");
  eq(tankPrice, 2 * infantryPrice, "the tank price is twice an infantry (p.22)");
  const cashBeforeTank = match.sides.blue.cash;
  const tank = buy(match, "blue", "tank", 70, 42, board);
  must(tank && tank.ok === true, "a tank after the clock ran was refused: " + JSON.stringify(tank));
  eq(match.sides.blue.cash, cashBeforeTank - tankPrice, "a tank costs twice an infantry");
  eq(tank.piece.kind, "tank", "tank kind");
  eq(siteOf(match, 14).readyRound, 33, "the producing city's ready round (20b tank, two cities)");

  // ---- buy: the placement rule (D-019) --------------------------------------------------
  // A cell that is not a friendly city or base is refused, and the sentence names the rule.
  const infantryAtSea = buy(match, "blue", "infantry", 200, 100, board);
  must(infantryAtSea && infantryAtSea.error, "land was bought in open water");
  must(/city or base/i.test(infantryAtSea.error), "the land refusal must name the rule: " + infantryAtSea.error);
  // A hull inland is refused, and the sentence names the dock.
  const shipInland = buy(match, "blue", "cruiser", 85, 45, board);
  must(shipInland && shipInland.error, "a cruiser was bought inland");
  must(/dock/i.test(shipInland.error), "the hull refusal must name the dock: " + shipInland.error);
  // ... and a friendly dock is accepted.
  const ship = buy(match, "blue", "cruiser", 2, 16, board);
  must(ship && ship.ok === true, "a cruiser on a friendly dock was refused: " + JSON.stringify(ship));
  eq(ship.piece.domain, "sea", "cruiser domain");
  // A carrier is a hull too.
  const carrier = buy(match, "blue", "carrier", 4, 16, board);
  must(carrier && carrier.ok === true, "a carrier on a friendly dock was refused: " + JSON.stringify(carrier));
  // No dock, no hull: Red's own dock is not Blue's to build on.
  const redDock = buy(match, "blue", "cruiser", 299, 69, board);
  must(redDock && redDock.error, "blue built a hull on Red's dock");
  must(/dock/i.test(redDock.error), "the enemy-dock refusal must name the dock: " + redDock.error);

  // and a side may not place in the other side's country: only its own sites are legal
  const inRedCity = buy(match, "blue", "infantry", 180, 22, board);
  must(inRedCity && inRedCity.error, "blue placed a unit in Red's country");
  must(/city or base/i.test(inRedCity.error), "the enemy-city refusal must name the rule: " + inRedCity.error);

  // ---- income: every round, cities only (Manual p.27) -----------------------------------
  // Blue holds three cities (10, 11, 14) and wells. A well gives oil, not cash, so only the
  // cities pay: 3 x 50 million = 150 million (0.15 billion) each round.
  match.round = 24;
  match.clock = "running";
  const cashAt24 = match.sides.blue.cash;
  const paid24 = pay(match);
  const blue24 = paid24.find((event) => event.type === "income" && event.side === "blue");
  must(blue24, "round 24 did not pay blue: " + JSON.stringify(paid24));
  eq(blue24.cities, 3, "blue city count");
  eq(blue24.cashWells, 0, "wells pay no cash");
  eq(blue24.amount, 150, "blue income on one round (3 cities x 50 million)");
  eq(match.sides.blue.cash, cashAt24 + 150, "income must land every round, cities only");
  const red24 = paid24.find((event) => event.type === "income" && event.side === "red");
  must(red24, "round 24 did not pay red: " + JSON.stringify(paid24));
  eq(red24.amount, 50, "red income (one city, its well pays nothing)");

  match.round = 25;
  const cashAt25 = match.sides.blue.cash;
  const paid25 = pay(match);
  const blue25 = paid25.find((event) => event.type === "income" && event.side === "blue");
  must(blue25, "round 25 did not pay blue: " + JSON.stringify(paid25));
  eq(match.sides.blue.cash, cashAt25 + 150, "round 25 pays again, not every 25th round");

  // ---- income: exactly 1.5 billion from 3 cities + 2 wells over 10 rounds (criterion 4) ---
  {
    const tenth = openMatch("1986", []);
    tenth.sites = [
      { id: 40, name: "A", x: 10, y: 10, kind: "city", owner: "blue" },
      { id: 41, name: "B", x: 11, y: 10, kind: "city", owner: "blue" },
      { id: 42, name: "C", x: 12, y: 10, kind: "city", owner: "blue" },
      { id: 43, name: "W1", x: 13, y: 10, kind: "well", owner: "blue" },
      { id: 44, name: "W2", x: 14, y: 10, kind: "well", owner: "blue" },
    ];
    tenth.sides.blue.cash = 0;
    tenth.sides.red.cash = 0;
    for (let round = 1; round <= 10; round++) {
      tenth.round = round;
      const events = pay(tenth);
      const one = events.find((event) => event.type === "income" && event.side === "blue");
      must(one, "round " + round + " did not pay blue: " + JSON.stringify(events));
      eq(one.amount, 150, "round " + round + " income (0.15 billion)");
      eq(one.cashWells, 0, "round " + round + " wells pay no cash");
    }
    eq(tenth.sides.blue.cash, 1500, "3 cities + 2 wells over 10 rounds is exactly 1.5 billion");
    console.log("criterion 4 ok: 3 cities + 2 wells, 10 rounds, cash 0 -> 1500 million; each event 150 (0.15b), wells 0 in cash");
  }

  // ---- income: a base and a capital pay nothing while capitalPays is false (criterion 6) ---
  {
    const quiet = openMatch("1986", []);
    quiet.sites = [
      { id: 50, name: "Base", x: 10, y: 10, kind: "base", owner: "blue" },
      { id: 51, name: "Capital", x: 11, y: 10, kind: "capital", owner: "blue" },
    ];
    quiet.sides.blue.cash = 0;
    quiet.sides.red.cash = 0;
    quiet.round = 1;
    for (let round = 1; round <= 10; round++) {
      quiet.round = round;
      pay(quiet);
    }
    eq(quiet.sides.blue.cash, 0, "a base and a capital paid cash while capitalPays is false");
    console.log("criterion 6 ok: a base + a capital held 10 rounds add 0 while capitalPays is false");
  }

  // ---- income: a finished match pays nothing -------------------------------------------
  match.round = 50;
  match.over = true;
  const cashOver = match.sides.blue.cash;
  eq(pay(match).length, 0, "a finished match must not pay");
  eq(match.sides.blue.cash, cashOver, "a finished match must not add to the pool");
  match.over = false;

  // ---- income: a side that never fixed its pool is not paid ----------------------------
  match.round = 75;
  match.sides.blue.cash = -1;
  const redAt75 = match.sides.red.cash;
  const shortPay = pay(match);
  const skipped = shortPay.find((event) => event.type === "income_skipped" && event.side === "blue");
  must(skipped, "a cash-short side was paid: " + JSON.stringify(shortPay));
  must(!shortPay.some((event) => event.type === "income" && event.side === "blue"), "a cash-short side was paid");
  eq(match.sides.blue.cash, -1, "a cash-short side's pool must not grow");
  eq(match.sides.red.cash, redAt75 + 50, "the other side is still paid");
  match.sides.blue.cash = cashAt25 + 150;

  // ---- fuel: a dry side stops, the other keeps its reserve ----------------------------
  match.sides.blue.fuel = 1;
  match.sides.red.fuel = reserve;
  match.sides.blue.dry = false;
  match.sides.red.dry = false;
  const dryEvents = upkeep(match);
  eq(match.sides.blue.fuel, 0, "a side down to 1 must not go below zero");
  eq(match.sides.blue.dry, true, "a side at zero must be marked dry");
  must(dryEvents.some((event) => event.type === "dry" && event.side === "blue"), "no dry event for blue");
  eq(match.sides.red.dry, false, "a dry blue must not stop red");
  eq(match.sides.red.fuel, reserve - burn, "red keeps its own reserve and burns one round");
  must(!dryEvents.some((event) => event.type === "dry" && event.side === "red"), "red was wrongly marked dry");

  // ---- oil: a well pays oil, never cash (criterion 5) ----------------------------------
  {
    const wellOnly = openMatch("1986", []);
    wellOnly.sites = [{ id: 60, name: "Well", x: 10, y: 10, kind: "well", owner: "blue" }];
    wellOnly.pieces = [{ id: "blue:land", side: "blue", domain: "land", kind: null, x: 10, y: 10, path: [], pace: 1 }];
    wellOnly.sides.blue.cash = 1000;
    wellOnly.sides.red.cash = 1000;
    wellOnly.sides.blue.fuel = 100;
    for (let round = 1; round <= 10; round++) {
      wellOnly.round = round;
      upkeep(wellOnly);
    }
    eq(wellOnly.sides.blue.cash, 1000, "owning a well for 10 rounds changed cash");
    must(wellOnly.sides.blue.fuel > 100, "a held well did not refill oil: " + wellOnly.sides.blue.fuel);
    eq(wellOnly.sides.blue.fuel, Number(resourceSpec("fuel").reserve), "a well refilled the reserve");
    console.log("criterion 5 ok: a held well for 10 rounds left cash at 1000 and refilled fuel to the reserve");
  }

  // ---- oil: standing on a red well flips its owner to blue ----------------------------
  const walker = match.pieces.find((piece) => piece.id === "blue:land");
  must(walker, "the opening blue land piece is missing");
  walker.x = 190;
  walker.y = 30;
  eq(siteOf(match, 30).owner, "red", "the Volga well was Red before the capture");
  const capEvents = upkeep(match);
  eq(siteOf(match, 30).owner, "blue", "standing on a Red well must take it for Blue");
  must(
    capEvents.some((event) => event.type === "capture" && event.site === 30 && event.side === "blue" && event.from === "red"),
    "no capture event for the Volga well: " + JSON.stringify(capEvents)
  );
  must(match.sides.blue.wells.includes(30), "blue's well list did not take the field");
  must(!match.sides.red.wells.includes(30), "red's well list kept the field");
  // standing on any well refills that side, and clears the dry flag
  eq(match.sides.blue.fuel, reserve, "standing on a well must refill the reserve");
  eq(match.sides.blue.dry, false, "a refuelled side is no longer dry");

  // capture() is the same rule asked directly, and it refuses a cell with no well
  eq(capture(match, "red", 210, 65).length, 1, "a neutral well must be takeable");
  eq(siteOf(match, 32).owner, "red", "the neutral well did not flip to red");
  eq(capture(match, "red", 200, 60).length, 0, "a city is not a well: capture must do nothing");

  // ---- occupation: a city changes hands, a capital is held only while stood on --------
  // Until this existed, capture() could only ever take a well, so every city on the map was
  // decorative and income could not move with the board.
  const occ = freshMatch();
  occ.pieces = [
    { id: "blue:land", side: "blue", domain: "land", kind: null, x: 180, y: 22, path: [], pace: 1, facing: null, fighting: null, shots: 0 },
    { id: "red:land", side: "red", domain: "land", kind: null, x: 10, y: 10, path: [], pace: 1, facing: null, fighting: null, shots: 0 },
  ];
  const firstTake = occupy(occ);
  eq(siteOf(occ, 12).owner, "blue", "a blue piece standing on Kiev did not take it");
  const takeEvent = firstTake.find((event) => event.type === "capture" && event.site === 12);
  must(Boolean(takeEvent), "taking a city produced no capture event: " + JSON.stringify(firstTake));
  eq(takeEvent.from, "red", "the capture event did not name the side that lost the city");
  eq(occupy(occ).length, 0, "standing still on an owned city captured it again");

  // Red walks on and takes it back.
  occ.pieces[1].x = 180;
  occ.pieces[1].y = 22;
  occ.pieces[0].x = 0;
  occ.pieces[0].y = 0;
  const retake = occupy(occ);
  eq(siteOf(occ, 12).owner, "red", "an enemy piece did not take the city back");
  must(retake.some((event) => event.type === "capture" && event.side === "red"), "the retake was silent");

  // A capital is taken by standing on it, and stays taken: that claim is what the win
  // condition reads when nobody is standing there.
  occ.pieces[0].x = 183;
  occ.pieces[0].y = 25;
  must(occupy(occ).some((event) => event.type === "capture" && event.site === 1 && event.side === "blue"),
    "a blue piece on Moscow did not take the capital");
  eq(siteOf(occ, 1).owner, "blue", "Moscow did not flip");
  occ.pieces[0].x = 0;
  occ.pieces[0].y = 0;
  eq(occupy(occ).length, 0, "walking off a taken capital must not silently change the claim");
  eq(siteOf(occ, 1).owner, "blue", "a taken capital lost its claim when the piece stepped off");

  // ---- the module never invents an oil production rating ------------------------------
  for (const site of match.sites) {
    must(!Object.hasOwn(site, "production"), "a site carries an invented production rating: " + JSON.stringify(site));
  }
  for (const piece of match.pieces) {
    must(!Object.hasOwn(piece, "production"), "a piece carries a production rating");
  }
}
