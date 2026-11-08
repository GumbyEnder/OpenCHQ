// Node dialogs: the navigation, the purchase dialogue and the economy dialogue.
//
// The commands exist as buttons in the strip, and two of them - Buy and Economy - are dialogues that
// did not exist. Everything they print comes from the room the server sent: prices from the shop row,
// the payday from the seat's own `income`, the purse from the seat. This asserts the row building,
// the counts, the words, and that the payday the dialogue shows is the one the economy module counts.
import { NAV, buyRows, economyModel, navFor, reserveLine, untypedCount } from "../../public/dialogs.mjs";
import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { payoutFor, seedOwners } from "../../server/economy.mjs";
import { forSeat } from "../../server/view.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

const room = {
  era: 1986,
  you: "blue",
  round: 40,
  clock: "running",
  shop: [
    { kind: "infantry", price: 3, domain: "land" },
    { kind: "tank", price: 6, domain: "land" },
    { kind: "ship", price: 4, domain: "sea" },
    { kind: "nuke", price: 10, domain: "land", refused: "A nuke is refused." },
  ],
  pieces: [
    { id: "b1", side: "blue", kind: "infantry" },
    { id: "b2", side: "blue", kind: "infantry" },
    { id: "b3", side: "blue", kind: "tank" },
    { id: "r1", side: "red", kind: "tank" },
    { id: "r2", side: "red", kind: "tank" },
    { id: "r3", side: "red", kind: "ship" },
  ],
  sites: [
    { id: "s1", kind: "city", owner: "blue" },
    { id: "s2", kind: "city", owner: "blue" },
    { id: "s3", kind: "city", owner: "red" },
    { id: "s4", kind: "dock", owner: "blue" },
    { id: "s5", kind: "oilfield", owner: "blue" },
    { id: "s6", kind: "capital", owner: "blue" },
    { id: "s7", kind: "oilfield", owner: "red" },
  ],
  seat: {
    side: "blue",
    cash: 4,
    payIn: 10,
    payEvery: 25,
    income: { cities: 2, wells: 1, amount: 3 },
    reserves: [
      { kind: "fuel", held: 9997, reserve: 10000, rate: 1, dry: false },
      { kind: "steel", held: NaN, reserve: 40, rate: null, dry: false },
    ],
  },
};

export const name = "dialogs";

export async function run(ctx) {
  // --- the navigation is the command list -----------------------------------
  eq("the strip carries the original's commands", NAV.map((item) => item.id),
    ["buy", "economy", "kit", "map", "war", "log"]);
  for (const item of NAV) {
    if (!item.label || !item.title || !item.hint) fail("nav item " + item.id + " is missing its words");
  }
  eq("a nav id resolves", navFor("buy").title, "Buy units");
  eq("an unknown id is not a command", navFor("nope"), null);

  // --- the purchase table ---------------------------------------------------
  const rows = buyRows(room);
  eq("every shop row is offered", rows.map((row) => row.kind), ["infantry", "tank", "ship", "nuke"]);
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
  eq("infantry: two held, none seen, three billion", [byKind.infantry.own, byKind.infantry.known, byKind.infantry.price], [2, 0, 3]);
  eq("tank: one held, two seen", [byKind.tank.own, byKind.tank.known], [1, 2]);
  eq("ship: none held, one seen", [byKind.ship.own, byKind.ship.known], [0, 1]);
  eq("a six-billion tank is not affordable from four", byKind.tank.affordable, false);
  eq("a three-billion infantry is affordable from four", byKind.infantry.affordable, true);
  // The refused entry keeps the server's own sentence and is never dressed up as buyable.
  eq("the nuke carries the server's refusal", byKind.nuke.refused, "A nuke is refused.");

  // A seat that holds nothing still gets a table, not an error.
  const empty = buyRows({ shop: room.shop, pieces: [], sites: [], seat: { side: "red", cash: 0 } });
  eq("no pieces means zero held and zero seen", empty.map((row) => [row.own, row.known]).flat(), [0, 0, 0, 0, 0, 0, 0, 0]);

  // The opening force has no recovered order of battle, and the table says so rather than pretending
  // two untyped armies are zero infantry.
  eq("typed own pieces are not counted as untyped", untypedCount(room), 0);
  eq("opening pieces are counted as untyped", untypedCount({
    you: "blue",
    pieces: [{ side: "blue", kind: null }, { side: "blue", kind: null }, { side: "red", kind: null }],
    seat: { side: "blue" },
  }), 2);
  const opening = openMatch("1986", matchSites("1986"));
  if (untypedCount({ you: "blue", pieces: opening.pieces, seat: { side: "blue" } }) <= 0) {
    fail("the 1986 opening force is no longer untyped: the dialogue note never fires");
  }

  // --- the economy dialogue -------------------------------------------------
  const model = economyModel(room);
  eq("the purse is the seat's", model.cash, 4);
  eq("the next payday is the seat's countdown", [model.payIn, model.payEvery], [10, 25]);
  eq("the payday worth is the server's count", model.income, { cities: 2, wells: 1, amount: 3 });
  eq("held cities, docks and oilfields come off the site list",
    [model.held.city, model.held.dock, model.held.well], [2, 1, 1]);
  eq("the unit counts are the visible pieces", model.units, { own: 3, known: 3 });
  eq("the stocks are the seat's own meters", model.reserves.map((meter) => meter.kind), ["fuel", "steel"]);

  // A rate nobody recovered says so instead of printing a number.
  eq("a missing rate is said in words", reserveLine(model.reserves[1]), "steel: unknown held · rate unknown");
  eq("a known rate is printed", reserveLine(model.reserves[0]), "fuel: 9997 held · 1 a round");

  // --- the server sends the figure the dialogue prints -----------------------
  const match = openMatch("1986", matchSites("1986"));
  seedOwners(match);
  const seat = forSeat(match, "blue").seat;
  const counted = payoutFor(match, "blue");
  if (!seat || !seat.income) fail("the seat carries no income block");
  eq("the seat's income is the economy module's payout", seat.income, counted);
  if (counted.amount <= 0) fail("1986 opens with nothing paying: " + JSON.stringify(counted));
  eq("income is one per city plus one per well", counted.amount, counted.cities + counted.wells);

  // --- what the page ships --------------------------------------------------
  const html = await (await fetch(ctx.base + "/")).text();
  for (const id of ["nav", "dialog", "dialogBody", "dialogClose", "purseChip"]) {
    if (!html.includes('id="' + id + '"')) fail("the served page has no #" + id);
  }
  if (!/id="dialog"[^>]*class="dialog hidden"/.test(html)) fail("the dialogue does not ship closed");
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes("./dialogs.mjs")) fail("app.js does not use the dialogue module");
  const served = await fetch(ctx.base + "/dialogs.mjs");
  if (!served.ok) fail("the dialogue module is not served: " + served.status);
}
