// Node test: buying, oil ownership, income and per-side fuel (graph nodes buy, oil,
// income, fuel). Drives web/server/economy.mjs directly over a match built to the shape
// in docs/CONTRACTS.md.
//
// What breaks if this feature is removed: a purchase would never spend or mark its city,
// a nuke would be accepted, wells would never change owner, income would never land on
// round 25 (or would land on round 24), and a dry side would keep a full reserve.

import { priceOf, rules } from "../../server/rules.mjs";
import { startPool } from "../../server/rules.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy, capture, pay, upkeep } from "../../server/economy.mjs";

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
  const reserve = Number(rules().fuel.reserve);
  const burn = Number(rules().fuel.burn);

  // ---- oil: wells and cities start with the country they are in -------------------------
  const match = freshMatch();
  eq(siteOf(match, 30).owner, null, "ownership must not be pre-set by the fixture");
  eq(match.sides.blue.cash, startPool("1986"), "blue pool at open");

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

  // ---- buy: before the clock has run a purchase does not spend -------------------------
  const freeBuy = buy(match, "blue", "infantry", 80, 40);
  must(freeBuy && freeBuy.ok === true, "a purchase before the clock ran was refused: " + JSON.stringify(freeBuy));
  eq(freeBuy.piece.kind, "infantry", "bought piece kind");
  eq(freeBuy.piece.side, "blue", "bought piece side");
  eq(freeBuy.piece.domain, "land", "infantry domain");
  eq(match.sides.blue.cash, startPool("1986"), "a purchase before the clock ran must not spend");
  must(!siteOf(match, 10).unready, "a free purchase must not mark the city unready");

  // two pieces cannot share a cell
  const shared = buy(match, "blue", "infantry", 80, 40);
  must(shared && shared.error, "two pieces were allowed to share a cell");
  must(/share/.test(shared.error), "wrong refusal for a shared cell: " + shared.error);

  // ---- buy: a nuke is always refused ---------------------------------------------------
  const cashBeforeNuke = match.sides.blue.cash;
  const nuke = buy(match, "blue", "nuke", 70, 42);
  must(nuke && nuke.error, "a nuke was accepted");
  must(/refus/i.test(nuke.error), "a nuke must be refused: " + nuke.error);
  eq(match.sides.blue.cash, cashBeforeNuke, "a refused nuke must not spend");
  eq(match.pieces.filter((piece) => piece.kind === "nuke").length, 0, "a nuke piece was placed");

  // ---- buy: after the clock has run it spends the price and the city goes unready ------
  match.round = 3;
  match.clock = "running";
  const tankPrice = priceOf("tank");
  eq(tankPrice, 2, "the tank price");
  const cashBeforeTank = match.sides.blue.cash;
  const tank = buy(match, "blue", "tank", 70, 42);
  must(tank && tank.ok === true, "a tank after the clock ran was refused: " + JSON.stringify(tank));
  eq(match.sides.blue.cash, cashBeforeTank - tankPrice, "a tank costs 2");
  eq(tank.piece.kind, "tank", "tank kind");
  eq(siteOf(match, 14).unready, true, "the buying city must go unready");

  // ships buy at a dock, land does not; land buys at a city, ships do not
  const shipAtCity = buy(match, "blue", "ship", 75, 42);
  must(shipAtCity && shipAtCity.error, "a ship was bought in a city");
  must(/dock/i.test(shipAtCity.error), "the ship refusal must name the dock: " + shipAtCity.error);
  const landAtDock = buy(match, "blue", "infantry", 2, 16);
  must(landAtDock && landAtDock.error, "land was bought on a dock");
  must(/city/i.test(landAtDock.error), "the land refusal must name the city: " + landAtDock.error);
  const ship = buy(match, "blue", "ship", 2, 16);
  must(ship && ship.ok === true, "a ship at a friendly dock was refused: " + JSON.stringify(ship));
  eq(ship.piece.domain, "sea", "ship domain");

  // and a side may not buy in the other side's city
  const inRedCity = buy(match, "blue", "infantry", 180, 22);
  must(inRedCity && inRedCity.error, "blue bought in a Red city");

  // ---- income: round 24 does not pay, round 25 does ------------------------------------
  // Blue holds three cities (10, 11, 14) and now two wells (31, plus 30 after the capture
  // below). Red holds one city and one well. The payout is one per city and one per well.
  match.round = 24;
  match.clock = "running";
  const cashAt24 = match.sides.blue.cash;
  const noPay = pay(match);
  eq(noPay.length, 0, "round 24 must not pay");
  eq(match.sides.blue.cash, cashAt24, "round 24 must not add to the pool");

  match.round = 25;
  const cashAt25 = match.sides.blue.cash;
  const redAt25 = match.sides.red.cash;
  const paid = pay(match);
  const blueIncome = paid.find((event) => event.type === "income" && event.side === "blue");
  must(blueIncome, "round 25 did not pay blue: " + JSON.stringify(paid));
  eq(blueIncome.cities, 3, "blue city count");
  eq(blueIncome.wells, 1, "blue well count");
  eq(blueIncome.amount, 4, "blue income on round 25");
  eq(match.sides.blue.cash, cashAt25 + 4, "round 25 must add one per city and one per well");
  const redIncome = paid.find((event) => event.type === "income" && event.side === "red");
  must(redIncome, "round 25 did not pay red: " + JSON.stringify(paid));
  eq(redIncome.amount, 2, "red income (one city, one well)");
  eq(match.sides.red.cash, redAt25 + 2, "red pool on round 25");
  // capitals must not be counted as cities
  eq(match.sides.blue.cash - cashAt24, 4, "a capital was paid as a city");

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
  eq(match.sides.red.cash, redAt75 + 2, "the other side is still paid");
  match.sides.blue.cash = cashAt25 + 4;

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

  // ---- the module never invents an oil production rating ------------------------------
  for (const site of match.sites) {
    must(!Object.hasOwn(site, "production"), "a site carries an invented production rating: " + JSON.stringify(site));
  }
  for (const piece of match.pieces) {
    must(!Object.hasOwn(piece, "production"), "a piece carries a production rating");
  }
}
