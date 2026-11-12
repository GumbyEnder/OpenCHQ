// Node test for `transports` (order 270).
//
// What breaks if this node is removed: a land unit walks across an ocean at the slow land
// pace and is indistinguishable from an escort, so sea control means nothing - there is no
// cargo to catch. Here a land piece in water is a transport (it does not fight back and the
// first exchange sinks it), and stepping onto land puts it back on foot.

import { boardPayload, CELL_W, matchSites, resolveDataRoot } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { advance, issueOrder, planOrder } from "../../server/move.mjs";
import { laneGraph, seaRoute, seaWaypoints } from "../../server/lanes.mjs";
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
  // across the ocean.
  //
  // Frodo's gate on 28a4012 rejected the first cut of this: the lane legs were expanded by
  // dropping the cells the terrain map paints as ground, which left holes, so a hull jumped two
  // to four cells at a time and could stand on land. Three crossings are pinned here, one of them
  // the Archangel -> Los Angeles route his sweep named (35 jumps and a dry cell on that cut).
  const cities = matchSites("1986", board);
  const byName = new Map(cities.map((site) => [site.name, site]));
  const terrainAtCell = (x, y) => board.cells[y * CELL_W + x];
  const isSea = (x, y) => {
    const id = terrainAtCell(x, y);
    return id === 0 || id === 1 || id === 2;
  };
  const stepGap = (a, b) => {
    const raw = Math.abs(b.x - a.x);
    return Math.max(Math.min(raw, CELL_W - raw), Math.abs(b.y - a.y));
  };
  const graph = laneGraph(resolveDataRoot());
  if (graph.error) fail("the lane graph did not decode: " + graph.error);
  const waypointAt = new Map();
  graph.waypoints.forEach((point, index) => waypointAt.set(point.x + "," + point.y, index));
  const root = resolveDataRoot();

  const crossings = [
    { from: "Paris", to: "New York", bothLegs: true },
    { from: "Archangel", to: "Los Angeles", bothLegs: false },
    { from: "Archangel", to: "Tokyo", bothLegs: false },
  ];
  const ac4 = [];
  for (const spec of crossings) {
    const from = byName.get(spec.from);
    const to = byName.get(spec.to);
    if (!from || !to) fail("the 1986 site table has no " + spec.from + " or " + spec.to);

    const match = openMatch("1986", []);
    match.clock = "running";
    match.pieces = [piece("blue:land", "blue", from.x, from.y)];
    const plan = planOrder(match, "blue", "blue:land", to.x, to.y);
    if (!plan || plan.error) fail(spec.from + " -> " + spec.to + " was refused: " + JSON.stringify(plan));
    const route = plan.path;

    // 1. The whole order is a walk: every consecutive pair is one cell apart. A jump is the
    //    teleport frodo measured, and it hides contact from a transport's path.
    for (let i = 1; i < route.length; i++) {
      const gap = stepGap(route[i - 1], route[i]);
      if (gap !== 1) {
        fail(spec.from + " -> " + spec.to + " jumps " + gap + " cells at route index " + i + ": " +
          JSON.stringify(route.slice(Math.max(0, i - 2), i + 2)));
      }
    }

    // 2. The longest water run of the path is the crossing; it must have lane waypoints in lane
    //    order, and the same leg the lanes give must be water-only and contiguous.
    let run = null;
    let best = null;
    for (let i = 0; i < route.length; i++) {
      const wet = isSea(route[i].x, route[i].y);
      if (wet && run && stepGap(route[i - 1], route[i]) === 1) {
        run.end = i;
      } else if (wet) {
        run = { start: i, end: i };
      } else {
        if (run && (!best || run.end - run.start > best.end - best.start)) best = run;
        run = null;
      }
    }
    if (run && (!best || run.end - run.start > best.end - best.start)) best = run;
    if (!best) fail(spec.from + " -> " + spec.to + " never crosses water");
    if (spec.bothLegs) {
      if (best.start === 0) fail(spec.from + " -> " + spec.to + " starts at sea: the land leg is missing");
      if (best.end === route.length - 1) fail(spec.from + " -> " + spec.to + " ends at sea: the land leg is missing");
    }
    if (best.end - best.start + 1 < 6) {
      fail(spec.from + " -> " + spec.to + " sea leg is only " + (best.end - best.start + 1) + " cells");
    }

    const sea = seaRoute(root, { x: route[best.start].x, y: route[best.start].y },
      { x: route[best.end].x, y: route[best.end].y });
    if (!Array.isArray(sea) || sea.length < 2) {
      fail("the lanes gave no sea route for " + spec.from + " -> " + spec.to);
    }
    for (let i = 1; i < sea.length; i++) {
      if (stepGap(sea[i - 1], sea[i]) !== 1) {
        fail("the sea leg for " + spec.from + " -> " + spec.to + " jumps at " + i + ": " +
          JSON.stringify(sea.slice(Math.max(0, i - 1), i + 1)));
      }
    }
    for (let i = 1; i < sea.length - 1; i++) {
      if (!isSea(sea[i].x, sea[i].y)) {
        fail("the sea leg for " + spec.from + " -> " + spec.to + " stands on dry land at " +
          JSON.stringify(sea[i]) + " terrain " + terrainAtCell(sea[i].x, sea[i].y));
      }
    }

    // The lane chain the route anchors to, in order, each consecutive pair a stored lane edge.
    const chain = seaWaypoints(root, { x: route[best.start].x, y: route[best.start].y },
      { x: route[best.end].x, y: route[best.end].y });
    if (!Array.isArray(chain) || chain.length < 2) {
      fail(spec.from + " -> " + spec.to + " anchors to " + (chain ? chain.length : 0) + " lane waypoint(s)");
    }
    // Consecutive anchors are joined by the lane chain. A waypoint the terrain map paints as
    // ground is not an anchor (a hull cannot stand on it), so the hop may skip such a node - but
    // only such a node, and never a wet waypoint, which the hull would have had to visit.
    const wetIndex = new Set(graph.waypoints
      .map((point, index) => (terrainAtCell(point.x, point.y) <= 2 ? index : -1))
      .filter((index) => index >= 0));
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const b = chain[i];
      const seen = new Set([a]);
      const queue = [a];
      let reached = false;
      while (queue.length && !reached) {
        const node = queue.shift();
        for (const next of graph.adjacency[node]) {
          if (next === b) { reached = true; break; }
          if (seen.has(next) || wetIndex.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      if (!reached) {
        fail(spec.from + " -> " + spec.to + " visits lane waypoints out of order (" +
          a + " -> " + b + " is not a lane chain)");
      }
    }
    // Every chain anchor is a cell the hull actually visits.
    const onRoute = new Set(route.map((step) => step.x + "," + step.y));
    for (const index of chain) {
      const wp = graph.waypoints[index];
      if (!onRoute.has(wp.x + "," + wp.y)) {
        fail(spec.from + " -> " + spec.to + " anchors to waypoint " + index + " but never visits it");
      }
    }
    const visited = chain.map((index) => ({ index }));
    if (waypointAt.size === 0) fail("the lane graph has no waypoints");

    const end = route[route.length - 1];
    if (end.x !== to.x || end.y !== to.y) {
      fail(spec.from + " -> " + spec.to + " ended at " + end.x + "," + end.y);
    }

    ac4.push({
      spec, route,
      land: best.start,
      sea: best.end - best.start + 1,
      tail: route.length - 1 - best.end,
      waypoints: visited.map((hit) => hit.index).join("->"),
    });
  }
  const paris = ac4[0];
  console.log(
    "transports AC4: Paris(" + byName.get("Paris").x + "," + byName.get("Paris").y + ") -> New York(" +
      byName.get("New York").x + "," + byName.get("New York").y + ") " + paris.route.length +
      " steps, land leg " + paris.land + ", sea leg " + paris.sea + " water cells, land leg " + paris.tail +
      ", waypoints " + paris.waypoints + " in lane order; " + ac4.slice(1).map((row) =>
        row.spec.from + "->" + row.spec.to + " " + row.route.length + " steps, " + row.sea +
        " sea cells, waypoints " + row.waypoints).join("; ") + "; 0 jumps in all three"
  );
}
