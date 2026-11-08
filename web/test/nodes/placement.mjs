// Node placement: where a bought unit may stand.
//
// The owner's rule is wider than the archive's: land and air anywhere on ground inside the seat's own
// zone, hulls in coastal water. Both reaches are stand-ins in config/game.json, so this pins the
// numbers to the config, the mask to the rule, and the refusal to the sentence a player reads.
import { canPlace, domainOf, maskBase64, placementMask, placementRefusal } from "../../server/placement.mjs";
import { placementRules } from "../../server/rules.mjs";
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

// Ocean everywhere, plain ground in one block, and a single shallow lake to prove a lake is not a
// harbour.
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
  // --- the rule comes from config -------------------------------------------
  const rules = placementRules();
  eq("the zone reach is the config's", rules.zone, 8);
  eq("the coastal reach is the config's", rules.coast, 4);

  // --- a kind knows its domain ----------------------------------------------
  eq("a hull is sea", [domainOf("ship"), domainOf("submarine")], ["sea", "sea"]);
  eq("everything else is land", [domainOf("infantry"), domainOf("tank"), domainOf("aircraft")], ["land", "land", "land"]);

  const grid = board();

  // --- land: ground inside the zone, never water, never an occupied cell -----
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const mask = placementMask(match, "blue", "infantry", grid);
    const at = (x, y) => mask.mask[y * W + x];
    eq("ground beside the city is legal", at(80, 50), 1);
    eq("ground at the edge of the zone is legal", at(88, 50), 1);
    eq("ground beyond the zone is not", at(89, 50), 0);
    eq("water in the zone is not legal ground", at(80, 39), 0);
    eq("a lake is not legal ground", at(80, 70), 0);
    if (!mask.count) fail("the land mask is empty over a city with ground around it");

    // an occupied cell is not offered
    match.pieces.push({ id: "blue:land", side: "blue", domain: "land", kind: null, x: 80, y: 50 });
    const again = placementMask(match, "blue", "infantry", grid);
    eq("an occupied cell is not offered", again.mask[50 * W + 80], 0);

    // a seat with no territory has nowhere to place
    const empty = placementMask(match, "red", "infantry", grid);
    if (!empty.error) fail("a side holding nothing was offered cells");
  }

  // --- sea: coastal water only ----------------------------------------------
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const mask = placementMask(match, "blue", "ship", grid);
    const at = (x, y) => mask.mask[y * W + x];
    eq("water one cell off the coast is legal", at(80, 39), 1);
    eq("water at the edge of the coastal reach is legal", at(80, 36), 1);
    eq("open ocean is not", at(80, 34), 0);
    eq("land is not a berth", at(80, 50), 0);
    eq("a lake is not a harbour", at(80, 70), 0);
    if (!mask.count) fail("the sea mask is empty beside a coast");
  }

  // --- the refusal names the rule and the number ----------------------------
  eq("the land sentence names the zone",
    placementRefusal("tank", "land", 8, 4),
    "A tank goes on land inside your own zone, within 8 cells of a site you hold.");
  eq("the sea sentence names the coast",
    placementRefusal("ship", "sea", 8, 4),
    "A ship goes in coastal water, within 4 cells of land.");

  // --- canPlace is the gate the purchase goes through -----------------------
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    eq("a legal cell passes", canPlace(match, "blue", "infantry", 82, 52, grid).ok, true);
    const deep = canPlace(match, "blue", "infantry", 80, 39, grid);
    if (!deep.error) fail("canPlace accepted open water");
    const outside = canPlace(match, "blue", "infantry", 200, 100, grid);
    if (!outside.error) fail("canPlace accepted a cell outside the zone");
    const fractional = canPlace(match, "blue", "infantry", 82.5, 52, grid);
    if (!fractional.error) fail("canPlace accepted a fractional cell");
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

  // --- a purchase lands where it was asked to ---------------------------------
  {
    const match = matchWith([{ id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" }]);
    const bought = buy(match, "blue", "infantry", 82, 52, grid);
    if (!bought.ok) fail("a legal purchase was refused: " + JSON.stringify(bought));
    eq("the piece stands on the chosen cell", [bought.piece.x, bought.piece.y], [82, 52]);
    const refused = buy(match, "blue", "infantry", 80, 39, grid);
    if (!refused.error) fail("a purchase in open water was accepted");
  }

  // --- the page asks the server, and paints what it is given -----------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes('op: "placement"')) fail("the page never asks the server where a unit may stand");
  if (!app.includes("paintPlacement")) fail("the page never paints the placement cells");
  const dialogs = await (await fetch(ctx.base + "/dialogs.mjs")).text();
  if (!dialogs.includes('id: "air"')) fail("the navigation has no air command");
}
