// Node test for `transports` (order 270).
//
// What breaks if this node is removed: a land unit walks across an ocean at the slow land
// pace and is indistinguishable from an escort, so sea control means nothing - there is no
// cargo to catch. Here a land piece in water is a transport (it does not fight back and the
// first exchange sinks it), and stepping onto land puts it back on foot.

import { boardPayload, CELL_W, matchSites, resolveDataRoot } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { advance, issueOrder, planOrder } from "../../server/move.mjs";
import { laneGraph } from "../../server/lanes.mjs";
import { resolve } from "../../server/combat.mjs";

export const name = "transports";

function piece(id, side, x, y) {
  return { id, side, domain: "land", kind: null, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
}

// A cell next to water, and a water cell next to it, read from the decoded board.
function coastPair(cells) {
  for (let y = 0; y < 136; y++) {
    for (let x = 0; x < CELL_W - 1; x++) {
      const here = cells[y * CELL_W + x];
      const next = cells[y * CELL_W + x + 1];
      const after = cells[y * CELL_W + x + 2];
      // land, then at least two water cells: boarding and staying at sea are separate facts.
      if (here !== undefined && here >= 4 && next !== undefined && next <= 2 && after !== undefined && after <= 2) {
        return { land: { x, y }, water: { x: x + 1, y }, deeper: { x: x + 2, y } };
      }
    }
  }
  return null;
}

// The walk across water costs more than one round, so step until the piece lands there.
function stepsUntil(match, piece_, limit = 4) {
  for (let i = 0; i < limit; i++) {
    advance(match);
    if (piece_.path.length === 0) return i + 1;
  }
  return limit;
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("the map extract is missing, so transports cannot be proven here");

  const pair = coastPair(board.cells);
  if (!pair) fail("no coast with water beside land was found on this board");

  const match = openMatch("1986", []);
  match.clock = "running";
  const walker = piece("blue:land", "blue", pair.land.x, pair.land.y);
  match.pieces = [walker];

  // --- an order into water puts the piece in a transport ------------------------------
  const order = issueOrder(match, "blue", "blue:land", pair.water.x, pair.water.y);
  if (order.error) fail("a land piece was refused the water: " + order.error);
  const events = [];
  for (let i = 0; i < 4 && walker.path.length > 0; i++) events.push(...advance(match));
  if (walker.x !== pair.water.x || walker.y !== pair.water.y) {
    fail("the walker never reached the water: " + JSON.stringify({ x: walker.x, y: walker.y }));
  }
  if (walker.transport !== true) fail("a land piece in the ocean is not a transport: " + JSON.stringify(walker));
  if (!events.some((event) => event.type === "embarked" && event.pieceId === walker.id)) {
    fail("boarding produced no embarked event: " + JSON.stringify(events));
  }

  // --- staying at sea does not re-announce the transport ------------------------------
  issueOrder(match, "blue", "blue:land", pair.deeper.x, pair.deeper.y);
  const again = [];
  for (let i = 0; i < 4 && walker.path.length > 0; i++) again.push(...advance(match));
  if (again.some((event) => event.type === "embarked")) fail("a second water step re-announced boarding");
  if (walker.transport !== true) fail("the transport stopped being a transport at sea");

  // --- caught at sea: cargo does not shoot back and does not survive ------------------
  const sea = piece("blue:land", "blue", 10, 10);
  sea.transport = true;
  const hunter = piece("red:ship", "red", 11, 10);
  hunter.domain = "sea";
  hunter.kind = "cruiser"; // T-003: damage is per kind, so a hull has to name its kind
  const seaMatch = openMatch("1986", []);
  seaMatch.clock = "running";
  seaMatch.round = 1; // a fight fires on the first round a pair is in contact
  seaMatch.pieces = [sea, hunter];
  const fight = resolve(seaMatch);
  const shots = fight.filter((event) => event.type === "shot");
  if (shots.some((event) => event.side === "blue")) fail("a transport returned fire: " + JSON.stringify(shots));
  if (!shots.some((event) => event.side === "red")) fail("the hunter did not fire on the transport");
  const sunk = fight.find((event) => event.type === "destroyed");
  if (!sunk || sunk.pieceId !== "blue:land") fail("the transport survived being caught: " + JSON.stringify(fight));
  if (seaMatch.pieces.length !== 1 || seaMatch.pieces[0].id !== "red:ship") {
    fail("the wrong piece survived the catch: " + JSON.stringify(seaMatch.pieces));
  }

  // --- a transport is cargo only at sea: the same pair on land fights normally --------
  const ashore = piece("blue:land", "blue", 40, 40);
  const enemy = piece("red:land", "red", 41, 40);
  const landMatch = openMatch("1986", []);
  landMatch.clock = "running";
  landMatch.pieces = [ashore, enemy];
  const landFight = resolve(landMatch);
  if (landFight.some((event) => event.type === "destroyed")) {
    fail("two land pieces settled a fight in one exchange; the HITS rule is six");
  }
  if (landMatch.pieces.length !== 2) fail("land combat removed a piece early");

  // --- AC4: a European coastal city to a North American one sails the lanes ------------------
  // Manual p.21-22: a land order whose line crosses water boards transports and follows the
  // standard sea routes. The route therefore has a land leg, a sea leg made of water cells that
  // pass lane waypoints in lane order, and a land leg on the far shore - never a straight line
  // across the ocean, and never a dry cell in the middle of the sea leg.
  const cities = matchSites("1986", board);
  const europe = cities.find((site) => site.name === "Paris");
  const america = cities.find((site) => site.name === "New York");
  if (!europe || !america) fail("the 1986 site table has no Paris or New York, so the crossing cannot be proven");

  const crossing = openMatch("1986", []);
  crossing.clock = "running";
  const marcher = piece("blue:land", "blue", europe.x, europe.y);
  crossing.pieces = [marcher];
  const plan = planOrder(crossing, "blue", "blue:land", america.x, america.y);
  if (!plan || plan.error) fail("the France to US East Coast order was refused: " + JSON.stringify(plan));

  const terrainAtCell = (x, y) => board.cells[y * CELL_W + x];
  const isSea = (x, y) => {
    const id = terrainAtCell(x, y);
    return id === 0 || id === 1 || id === 2;
  };
  const route = plan.path;
  const waterIndexes = route.map((step, index) => (isSea(step.x, step.y) ? index : -1)).filter((index) => index >= 0);
  if (waterIndexes.length === 0) fail("the France to New York route never reaches water: " + route.length + " steps");
  const firstSea = waterIndexes[0];
  const lastSea = waterIndexes[waterIndexes.length - 1];
  if (firstSea === 0) fail("the crossing starts at sea: the European land leg is missing");
  if (lastSea === route.length - 1) fail("the crossing ends at sea: the North American land leg is missing");

  // Every cell of the sea leg is water (ids 0-2: ocean, docks, coastal shallows).
  for (let i = firstSea; i <= lastSea; i++) {
    const step = route[i];
    if (!isSea(step.x, step.y)) {
      fail("a dry cell sits inside the sea leg at route index " + i + ": " + JSON.stringify(step) +
        " terrain " + terrainAtCell(step.x, step.y));
    }
  }

  // At least 2 lane waypoints, visited in lane order (each consecutive pair a rule edge).
  const graph = laneGraph(resolveDataRoot());
  if (graph.error) fail("the lane graph did not decode: " + graph.error);
  const waypointAt = new Map();
  graph.waypoints.forEach((point, index) => waypointAt.set(point.x + "," + point.y, index));
  const visited = [];
  for (let i = firstSea; i <= lastSea; i++) {
    const index = waypointAt.get(route[i].x + "," + route[i].y);
    if (index !== undefined) visited.push({ routeIndex: i, index });
  }
  if (visited.length < 2) {
    fail("the sea leg passes " + visited.length + " lane waypoint(s); the lanes were not followed: " +
      JSON.stringify(visited));
  }
  for (let i = 1; i < visited.length; i++) {
    const pair = visited[i - 1].index + " -> " + visited[i].index;
    if (!graph.adjacency[visited[i - 1].index].includes(visited[i].index)) {
      fail("the sea leg visits lane waypoints out of order (" + pair + " is not a lane edge)");
    }
  }

  // The order ends where the player aimed, on the American coast.
  const end = route[route.length - 1];
  if (end.x !== america.x || end.y !== america.y) {
    fail("the crossing ended at " + end.x + "," + end.y + " instead of New York " + america.x + "," + america.y);
  }
  console.log(
    "transports AC4: Paris(" + europe.x + "," + europe.y + ") -> New York(" + america.x + "," + america.y + ") " +
      route.length + " steps, land leg " + firstSea + ", sea leg " + (lastSea - firstSea + 1) +
      " water cells, land leg " + (route.length - 1 - lastSea) + ", waypoints " +
      visited.map((hit) => hit.index).join("->") + " in lane order"
  );
}
