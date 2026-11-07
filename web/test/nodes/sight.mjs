// Node test: sight (order 160). Owner: A5.
//
// Pure module test - no server, no sockets. Each match is built directly from openMatch so a
// failure names the exact rule that broke. Radii come from ctx.config, never from a literal.

import { CELL_W, SEATS } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "sight";

function unit(id, side, x, y, extra = {}) {
  return {
    id,
    side,
    domain: "land",
    kind: "infantry",
    x,
    y,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
    ...extra,
  };
}

function ids(view) {
  return view.pieces.map((piece) => piece.id).sort();
}

function expect(fail, condition, message) {
  if (!condition) fail("sight: " + message);
}

function expectAbsent(fail, view, id, why) {
  expect(fail, !ids(view).includes(id), why + " - " + id + " leaked into the view");
}

function expectPresent(fail, view, id, why) {
  expect(fail, ids(view).includes(id), why + " - " + id + " is missing from the view");
}

// X wraps for the seat's sight, so "radius cells away" means this many steps across the seam.
function acrossSeam(x, steps) {
  return (((x - steps) % CELL_W) + CELL_W) % CELL_W;
}

export async function run(ctx) {
  const { fail, config } = ctx;
  const radius = Number(config.sightCells);
  const routeSteps = Number(config.enemyRouteSteps);
  expect(fail, Number.isInteger(radius) && radius > 0, "config.sightCells is not a positive integer");
  expect(fail, Number.isInteger(routeSteps) && routeSteps > 0, "config.enemyRouteSteps is not a positive integer");

  // ---- radius: exactly sightCells is seen, one further is not, and X wraps ---------------
  const reach = openMatch("1942");
  reach.pieces = [
    unit("blue:scout", "blue", 2, 60),
    unit("blue:second", "blue", 150, 100),
    unit("red:edge", "red", acrossSeam(2, radius), 60), // exactly radius cells away across the seam
    unit("red:diagonal", "red", 2 + radius, 60 + radius), // Chebyshev: a diagonal counts as radius
    unit("red:beyond", "red", acrossSeam(2, radius + 1), 60), // one cell too far, across the seam
    unit("red:beyondDiagonal", "red", 2 + radius, 60 + radius + 1), // Chebyshev: one too far vertically
  ];
  const reachView = forSeat(reach, "blue");
  expectPresent(fail, reachView, "blue:scout", "own piece at 2,60");
  expectPresent(fail, reachView, "blue:second", "own piece far from everything");
  expectPresent(fail, reachView, "red:edge", "enemy at exactly sightCells across the X seam");
  expectPresent(fail, reachView, "red:diagonal", "enemy at exactly sightCells on the diagonal");
  expectAbsent(fail, reachView, "red:beyond", "enemy at sightCells + 1 across the X seam");
  expectAbsent(fail, reachView, "red:beyondDiagonal", "enemy at sightCells + 1 on the diagonal");
  expect(
    fail,
    ids(reachView).join(",") === ["blue:scout", "blue:second", "red:diagonal", "red:edge"].sort().join(","),
    "the view carries pieces a seat may not see: " + ids(reachView).join(",")
  );

  // the same geometry must hide when the seat is red and the scouts swap sides
  const mirrored = forSeat(reach, "red");
  expectPresent(fail, mirrored, "red:edge", "an enemy of red at exactly sightCells across the seam");
  expectAbsent(fail, mirrored, "blue:second", "a blue piece far from every red piece");

  // ---- routes: an enemy route is cut to its first enemyRouteSteps steps -------------------
  const fiveSteps = [
    { x: 5, y: 60, pace: 1 },
    { x: 6, y: 60, pace: 1 },
    { x: 7, y: 60, pace: 1 },
    { x: 8, y: 60, pace: 1 },
    { x: 9, y: 60, pace: 1 },
  ];
  const routed = openMatch("1942");
  routed.pieces = [
    unit("blue:scout", "blue", 2, 60),
    unit("blue:marcher", "blue", 2, 70, { path: fiveSteps.map((step) => ({ ...step })) }),
    unit("red:marcher", "red", 4, 60, { kind: "tank", path: fiveSteps.map((step) => ({ ...step })) }),
  ];
  const routedView = forSeat(routed, "blue");
  const enemyRoute = routedView.routes["red:marcher"];
  const seenSteps = Math.min(fiveSteps.length, routeSteps);
  expect(fail, Array.isArray(enemyRoute), "a visible enemy with an order has no route in the view");
  expect(
    fail,
    enemyRoute.length === seenSteps,
    "an enemy route of " + fiveSteps.length + " steps reached the seat with " + otherLength(enemyRoute) +
      " steps, expected " + seenSteps
  );
  expect(
    fail,
    JSON.stringify(enemyRoute) === JSON.stringify(fiveSteps.slice(0, routeSteps)),
    "the enemy route is not the first " + routeSteps + " steps: " + JSON.stringify(enemyRoute)
  );
  const enemyPiece = routedView.pieces.find((piece) => piece.id === "red:marcher");
  expect(
    fail,
    Array.isArray(enemyPiece.path) && enemyPiece.path.length === seenSteps,
    "the enemy piece carries a longer path than its route: " + JSON.stringify(enemyPiece.path)
  );
  const ownRoute = routedView.routes["blue:marcher"];
  expect(
    fail,
    Array.isArray(ownRoute) && ownRoute.length === fiveSteps.length,
    "a seat's own route was cut: " + JSON.stringify(ownRoute)
  );
  // filtering is a copy, not an edit of the match
  const redInMatch = routed.pieces.find((piece) => piece.id === "red:marcher");
  expect(fail, redInMatch.path.length === fiveSteps.length, "forSeat shortened the enemy path stored in the match");

  // ---- submarines: still is absent, moving is present, fighting is present ---------------
  const boats = openMatch("1942");
  boats.pieces = [
    unit("blue:scout", "blue", 2, 60),
    unit("blue:ownSub", "blue", 2, 61, { domain: "sea", kind: "submarine" }),
    unit("red:still", "red", 3, 60, { domain: "sea", kind: "submarine" }),
    unit("red:moving", "red", 3, 61, { domain: "sea", kind: "submarine", path: [{ x: 4, y: 61, pace: 1 }] }),
    unit("red:fighting", "red", 3, 62, { domain: "sea", kind: "submarine", fighting: "blue:scout" }),
  ];
  const boatView = forSeat(boats, "blue");
  expectAbsent(fail, boatView, "red:still", "a submarine that did not move this round");
  expectPresent(fail, boatView, "red:moving", "a submarine that moved this round");
  expectPresent(fail, boatView, "red:fighting", "a submarine in a fight");
  expectPresent(fail, boatView, "blue:ownSub", "own submarine, even while still");
  expect(fail, !("red:still" in boatView.routes), "a hidden submarine left a route behind");

  // ---- hidden pieces are absent, never flagged ------------------------------------------
  const topKeys = Object.keys(reachView).sort().join(",");
  // Sorted, so roundSeconds sits before routes ("roundS" < "route").
  expect(fail, topKeys === "alarm,capitals,notes,over,pieces,roundSeconds,routes,seat,sites,unscreened,winner", "the view shape changed: " + topKeys);
  for (const piece of reachView.pieces) {
    for (const key of ["hidden", "visible", "concealed", "seen"]) {
      expect(fail, !(key in piece), "a piece carries a '" + key + "' flag: " + JSON.stringify(piece));
    }
  }
  for (const key of ["hidden", "hiddenCount", "hiddenPieces", "omitted"]) {
    expect(fail, !(key in reachView), "the view carries a hidden-piece count or list: " + key);
  }
  expect(
    fail,
    JSON.stringify(reachView).indexOf("red:beyond") === -1,
    "a hidden piece's id appears somewhere in the serialized view"
  );

  // ---- concealed era: the other side stays out until its capital is seen ------------------
  const hiddenMatch = openMatch("9999");
  hiddenMatch.sites = [
    { id: "blueCity", name: "Blue City", x: 30, y: 30, kind: "city", owner: "blue" },
    { id: "redWell", name: "Red Well", x: 200, y: 100, kind: "oilfield", owner: "red" },
    { id: "noMans", name: "No Man's Land", x: 120, y: 70, kind: "city", owner: null },
  ];
  hiddenMatch.pieces = [
    unit("blue:scout", "blue", 10, 10),
    unit("red:army", "red", 200, 100),
    unit("red:patrol", "red", SEATS.red.x - 3, SEATS.red.y),
  ];
  const blind = forSeat(hiddenMatch, "blue");
  expect(fail, !ids(blind).some((id) => id.startsWith("red:")), "concealed era leaked an enemy piece before the capital was seen");
  expect(fail, blind.capitals.blue && blind.capitals.blue.x === SEATS.blue.x, "the seat lost its own capital");
  expect(fail, blind.capitals.red === undefined || blind.capitals.red === null, "concealed era sent the enemy capital before it was seen");
  expect(fail, !blind.sites.some((site) => site.id === "redWell"), "concealed era leaked an enemy-owned site");
  expect(fail, blind.sites.some((site) => site.id === "noMans"), "concealed era dropped neutral sites");
  expect(fail, blind.sites.some((site) => site.id === "blueCity"), "concealed era dropped the seat's own sites");
  expect(fail, blind.notes.some((note) => String(note).includes("Moscow")), "concealed era gave no note: " + JSON.stringify(blind.notes));

  // walk a scout up to the enemy capital: the other side appears
  hiddenMatch.pieces[0].x = SEATS.red.x - radius;
  hiddenMatch.pieces[0].y = SEATS.red.y;
  const found = forSeat(hiddenMatch, "blue");
  expect(fail, found.capitals.red && found.capitals.red.x === SEATS.red.x, "seeing the capital did not reveal it");
  expectPresent(fail, found, "red:patrol", "an enemy next to the revealed capital");
  expect(fail, found.notes.length === 0, "the concealment note outlived the sighting: " + JSON.stringify(found.notes));
  expect(fail, found.sites.some((site) => site.id === "redWell"), "the reveal did not restore the enemy's sites");
  expectAbsent(fail, found, "red:army", "an enemy army still out of sight after the reveal");

  // the sighting is remembered: the scout walks away and the side stays known
  hiddenMatch.pieces[0].x = 10;
  hiddenMatch.pieces[0].y = 10;
  const remembered = forSeat(hiddenMatch, "blue");
  expect(fail, remembered.capitals.red && remembered.capitals.red.x === SEATS.red.x, "the capital was forgotten after the scout left");

  // red is still blind: concealment is per seat, not shared
  const redBlind = forSeat(hiddenMatch, "red");
  expectAbsent(fail, redBlind, "blue:scout", "blue's scout is out of red's sight");
  expect(fail, redBlind.capitals.blue === undefined || redBlind.capitals.blue === null, "red saw blue's capital without finding it");

  // a normal era never conceals a side
  const openEra = openMatch("1918");
  openEra.pieces = [unit("blue:scout", "blue", 2, 60), unit("red:army", "red", 200, 100)];
  const openView = forSeat(openEra, "blue");
  expect(fail, openView.capitals.red && openView.capitals.red.x === SEATS.red.x, "the 1918 view concealed the enemy capital");
  expectAbsent(fail, openView, "red:army", "an enemy far from every blue piece in 1918");
}

function otherLength(value) {
  return Array.isArray(value) ? value.length : JSON.stringify(value);

  // --- the seat view carries what the seat can spend, and when it is next paid ---------
  // Without this the page cannot draw a payment countdown and the clock is dead time.
  const purse = openMatch("1986", []);
  purse.clock = "running";
  purse.round = 22;
  purse.sides = { blue: { cash: 7, fuel: 100 }, red: { cash: 3, fuel: 100 } };
  const mineView = forSeat(purse, "blue");
  expect(fail, mineView.seat && mineView.seat.cash === 7, "the seat view lost its cash");
  expect(fail, mineView.seat && mineView.seat.fuel === 100, "the seat view lost its fuel");
  expect(fail, mineView.seat && Number.isFinite(mineView.seat.payIn), "the seat view has no payment countdown");
  expect(fail, mineView.seat.payIn > 0 && mineView.seat.payIn <= mineView.seat.payEvery, "the countdown is outside one payment");
  // The other side's purse must not travel: a seat knows only its own.
  expect(fail, !JSON.stringify(mineView).includes('"cash":3'), "the enemy purse leaked into the seat view");
}
