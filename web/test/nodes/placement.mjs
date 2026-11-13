// Node placement: where a bought unit may stand (D-019, the original's rule).
//
// Manual p.27 "General Placement Rules": land units and aircraft go on any friendly city or
// base; ships only on a friendly dock. There is no reach: this pins the mask to the site kinds,
// the readiness byte, the refusal sentences, and the wire form the page paints.
import { canPlace, domainOf, friendlySites, maskBase64, placementMask, placementRefusal, placementSite } from "../../server/placement.mjs";
import { shopFor } from "../../server/shop.mjs";
import { readinessRules } from "../../server/rules.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy } from "../../server/economy.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

const W = 320;
const H = 136;

// Ocean everywhere, plain ground in one block, and a single shallow lake. Terrain no longer
// decides placement (the site kind does), but a board is still required and the mask is indexed
// by cell, so the grid stays.
function board() {
  const terrain = ["ocean", "docks", "shallows", "lake", "capital", "base", "city", "oilfield",
    "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland", "facility"];
  const cells = new Array(W * H).fill(0);
  for (let y = 40; y <= 60; y++) {
    for (let x = 60; x <= 100; x++) cells[y * W + x] = 8;
  }
  cells[70 * W + 80] = 3; // a lake inside the block
  return { width: W, height: H, cells, terrain };
}

function matchWith(sites) {
  const match = openMatch("1986", []);
  match.sites = sites.map((site) => ({ owner: null, ...site }));
  return match;
}

export const name = "placement";

export async function run(ctx) {
  // --- the readiness constants come from config, and there is no reach any more ---------
  const rules = readinessRules();
  eq("the readiness radius is the config's", rules.radius, 5);
  eq("the readiness cost is per billion of price", rules.roundsPerBillion, 1);
  if (!Number.isFinite(rules.cityWeight) || !Number.isFinite(rules.capitalWeight)) {
    fail("the readiness weights are not numbers: " + JSON.stringify(rules));
  }

  // --- a kind knows its domain ----------------------------------------------
  eq("a hull is sea", [domainOf("cruiser"), domainOf("carrier"), domainOf("submarine")], ["sea", "sea", "sea"]);
  eq("everything else is land", [domainOf("infantry"), domainOf("tank"), domainOf("aircraft")], ["land", "land", "land"]);

  const grid = board();

  // --- land: exactly the cells of friendly cities, capitals and bases ---------
  {
    const match = matchWith([
      { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
      { id: 2, name: "Depot", x: 82, y: 52, kind: "base", owner: "blue" },
      { id: 3, name: "Seat", x: 78, y: 50, kind: "capital", owner: "blue" },
      { id: 4, name: "Theirs", x: 90, y: 50, kind: "city", owner: "red" },
      { id: 5, name: "Neutral", x: 70, y: 50, kind: "city", owner: null },
      { id: 6, name: "Well", x: 60, y: 50, kind: "oilfield", owner: "blue" },
      { id: 7, name: "Port", x: 80, y: 45, kind: "dock", owner: "blue" },
    ]);
    const mask = placementMask(match, "blue", "infantry", grid);
    const at = (x, y) => mask.mask[y * W + x];
    eq("a friendly city cell is legal", at(80, 50), 1);
    eq("a friendly base cell is legal", at(82, 52), 1);
    eq("a friendly capital cell is legal", at(78, 50), 1);
    eq("the cell beside a city is not", at(81, 50), 0);
    eq("a ground cell with no site is not", at(85, 55), 0);
    eq("an enemy city is not", at(90, 50), 0);
    eq("a neutral city is not", at(70, 50), 0);
    eq("an oilfield is not a city or base", at(60, 50), 0);
    eq("a dock is not a land cell", at(80, 45), 0);
    eq("the mask counts exactly the three friendly land sites", mask.count, 3);

    // an occupied cell is not offered
    match.pieces.push({ id: "blue:land", side: "blue", domain: "land", kind: null, x: 80, y: 50 });
    const again = placementMask(match, "blue", "infantry", grid);
    eq("an occupied cell is not offered", again.mask[50 * W + 80], 0);
    eq("the mask is down to the two open sites", again.count, 2);

    // a side with no territory has nowhere to place
    const none = matchWith([
      { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
      { id: 2, name: "TheirCity", x: 90, y: 50, kind: "city", owner: "red" },
    ]);
    const empty = placementMask(none, "red", "infantry", grid);
    if (empty.error) fail("a side holding a city was refused: " + empty.error);
    const landless = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const red = placementMask(landless, "red", "infantry", grid);
    if (!red.error) fail("a side holding nothing was offered cells");
    if (!/no city or base/.test(red.error)) fail("the no-territory sentence is wrong: " + red.error);
  }

  // --- readiness: 1 is ready, 2 is a friendly site that is still unready -----
  {
    const match = matchWith([
      { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
      { id: 2, name: "Far", x: 120, y: 50, kind: "city", owner: "blue" },
    ]);
    match.round = 4;
    match.sites[0].readyRound = 9;
    const mask = placementMask(match, "blue", "infantry", grid);
    eq("an unready city is still offered, marked 2", mask.mask[50 * W + 80], 2);
    eq("a ready city is marked 1", mask.mask[50 * W + 120], 1);
    eq("the counts split ready and unready", [mask.ready, mask.unready, mask.count], [1, 1, 2]);
    const blocked = canPlace(match, "blue", "infantry", 80, 50, grid);
    if (!blocked.error) fail("canPlace accepted a purchase in an unready city");
    eq("the refusal names the ready round", blocked.error.includes("ready at round 9"), true);
    // the round passes and the same cell is legal again
    match.round = 9;
    eq("the city is legal on its ready round", canPlace(match, "blue", "infantry", 80, 50, grid).ok, true);
  }

  // --- sea: exactly the cells of friendly docks ------------------------------
  {
    const match = matchWith([
      { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
      { id: 2, name: "Port", x: 80, y: 45, kind: "dock", owner: "blue" },
      { id: 3, name: "TheirPort", x: 90, y: 45, kind: "dock", owner: "red" },
      { id: 4, name: "Anchorage", x: 80, y: 44, kind: "docks", owner: "blue" },
    ]);
    const mask = placementMask(match, "blue", "cruiser", grid);
    const at = (x, y) => mask.mask[y * W + x];
    eq("a friendly dock is legal", at(80, 45), 1);
    eq("the legacy docks kind is legal too", at(80, 44), 1);
    eq("an enemy dock is not", at(90, 45), 0);
    eq("coastal water beside the dock is not", at(80, 43), 0);
    eq("a friendly city is not a berth", at(80, 50), 0);
    eq("the mask counts exactly the two friendly docks", mask.count, 2);
  }

  // --- no docks, no hulls: the sentence says why ------------------------------
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const mask = placementMask(match, "blue", "cruiser", grid);
    if (!mask.error) fail("a hull was offered with no dock");
    if (!/no dock/.test(mask.error)) fail("the no-dock sentence is wrong: " + mask.error);
    // AC2: the buy menu says it before the click, not after. The row carries the same sentence the
    // mask gives, and the land rows are untouched.
    eq("the side holds no dock", friendlySites(match, "blue", "sea"), 0);
    const shop = shopFor("1942", { seaRefusal: mask.error });
    const sea = shop.filter((row) => row.domain === "sea");
    if (!sea.length) fail("the 1942 shop sells no hulls at all");
    for (const row of sea) eq("the hull row is refused with the mask's sentence: " + row.kind, row.refused, mask.error);
    for (const row of shop.filter((r) => r.domain !== "sea")) {
      if (row.refused) fail("a land/tool row was refused by the no-dock rule: " + row.kind);
    }
    const withDock = matchWith([
      { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
      { id: 2, name: "Port", x: 70, y: 45, kind: "dock", owner: "blue" },
    ]);
    eq("a dock is held", friendlySites(withDock, "blue", "sea"), 1);
    eq("the same shop with a dock refuses no hull",
      shopFor("1942", { seaRefusal: "" }).filter((row) => row.domain === "sea" && row.refused).length, 0);
  }

  // --- the refusal names the unit, then the rule ----------------------------
  eq("the land sentence names the unit and the rule",
    placementRefusal("tank", "land", "Land units and aircraft go only on a friendly city or base."),
    "That is not a valid place for tank. Land units and aircraft go only on a friendly city or base. That cell is not a friendly city or base you hold.");
  eq("the sea sentence names the unit and the dock",
    placementRefusal("cruiser", "sea", "Ships go only on a friendly dock."),
    "That is not a valid place for cruiser. Ships go only on a friendly dock. That cell is not a friendly dock you hold.");
  if (!placementRefusal("infantry", "land", "x").includes("not a valid place for infantry")) {
    fail("the refusal does not say 'not a valid place for infantry'");
  }

  // --- canPlace is the gate the purchase goes through -----------------------
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const ok = canPlace(match, "blue", "infantry", 80, 50, grid);
    eq("a legal cell passes", ok.ok, true);
    eq("the legal cell names its site", ok.site && ok.site.id, 1);
    eq("placementSite finds the same site", placementSite(match, "blue", "infantry", 80, 50).id, 1);
    const deep = canPlace(match, "blue", "infantry", 81, 51, grid);
    if (!deep.error) fail("canPlace accepted a cell beside the city");
    // This is the click on a cell the page did not highlight: the sentence must name the unit.
    if (!deep.error.includes("not a valid place for infantry")) {
      fail("an unhighlighted click says " + JSON.stringify(deep.error));
    }
    const fractional = canPlace(match, "blue", "infantry", 80.5, 50, grid);
    if (!fractional.error) fail("canPlace accepted a fractional cell");
    const off = canPlace(match, "blue", "infantry", -1, 50, grid);
    if (!off.error) fail("canPlace accepted a cell off the board");
  }

  // --- the mask travels as base64 and comes back byte for byte --------------
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const mask = placementMask(match, "blue", "tank", grid);
    const encoded = maskBase64(mask.mask);
    const back = Buffer.from(encoded, "base64");
    eq("the mask survives the wire", back.length, mask.mask.length);
    let same = true;
    for (let i = 0; i < back.length; i++) if (back[i] !== mask.mask[i]) { same = false; break; }
    eq("the mask is unchanged by base64", same, true);
    // The wire form is base64 of one byte per cell: 58 KB for a 320x136 board, paid once when a unit
    // is armed. Small enough to send, large enough to want run-length encoding if it ever grows.
    eq("base64 of the full board is the expected size", encoded.length, Math.ceil(mask.mask.length / 3) * 4);
    eq("the mask is not padded short", back.length, W * H);
  }

  // --- a purchase lands where it was asked to, and tires its neighbours -----
  {
    const match = matchWith([
      { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
      { id: 2, name: "Next", x: 82, y: 50, kind: "city", owner: "blue" },
    ]);
    // Three 10b infantry: the producing cell, the refusal on the neighbour, then the same
    // neighbour after its ready round. Cash must cover all three or the last refusal names the
    // pool instead of readiness and the ready-round assertion proves nothing.
    match.sides.blue.cash = 100000;
    const bought = buy(match, "blue", "infantry", 80, 50, grid);
    if (!bought.ok) fail("a legal purchase was refused: " + JSON.stringify(bought));
    eq("the piece stands on the chosen city cell", [bought.piece.x, bought.piece.y], [80, 50]);
    // 10b infantry, the producing city and its one neighbour inside radius 5: ceil(10 * 1.5) = 15.
    eq("the purchase reports the ready round", bought.readiness && bought.readiness.round, 15);
    const off = buy(match, "blue", "infantry", 81, 51, grid);
    if (!off.error) fail("a purchase off a city was accepted");
    // the neighbouring city is unready too, and the refusal names its round
    const again = buy(match, "blue", "infantry", 82, 50, grid);
    if (!again.error) fail("a neighbouring unready city accepted a purchase");
    if (!/ready at round 15/.test(again.error)) fail("neighbour refusal: " + again.error);
    // once the round passes the neighbour produces again
    match.round = 15;
    const later = buy(match, "blue", "infantry", 82, 50, grid);
    if (!later.ok) fail("the neighbour was still refused at its ready round: " + JSON.stringify(later));
  }

  // --- the bot obeys the same rule (AC6): its purchase lands on a bot city -------------------
  {
    const { ordersFor } = await import("../../server/bot.mjs");
    const match = openMatch("1986", []);
    match.sites = [{ id: 1, name: "Red Home", x: 80, y: 50, kind: "city", owner: "red" }];
    match.seats = {
      blue: { username: "Ada", kind: "human" },
      red: { username: "Bot", kind: "bot" },
    };
    match.sides.red.cash = 100000;
    const events = ordersFor(match, "red");
    const bought = events.find((event) => event.type === "bot_buy");
    if (!bought) fail("the bot never bought: " + JSON.stringify(events.slice(0, 3)));
    eq("the bot purchase lands on the bot's own city cell", bought.at, { x: 80, y: 50 });
    const piece = (match.pieces || []).find((unit) => unit.id === bought.pieceId);
    if (!piece) fail("the bot_buy event names no piece");
    eq("the piece is the bot's and stands on the city", [piece.side, piece.x, piece.y], ["red", 80, 50]);
  }

  // --- the page asks the server, and paints what it is given -----------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes('op: "placement"')) fail("the page never asks the server where a unit may stand");
  if (!app.includes("paintPlacement")) fail("the page never paints the placement cells");
  const dialogs = await (await fetch(ctx.base + "/dialogs.mjs")).text();
  if (!dialogs.includes('id: "air"')) fail("the navigation has no air command");
}
