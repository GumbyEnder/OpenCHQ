// Node 120 — sea lanes. Owner: A3.
//
// What breaks if this feature is removed: a ship ordered between two water cells
// gets no lane path (seaRoute returns null forever), the 151 waypoint table is
// never decoded, and a land-to-land order can be handed to the lane router. The
// assertions below pin the real decoded table, so the numbers are on record in
// the run output instead of being described.

import { resolveDataRoot } from "../../server/board.mjs";
import { laneGraph, seaRoute, resetLaneCache } from "../../server/lanes.mjs";

export const name = "lanes";

export async function run(ctx) {
  const fail = ctx.fail;

  const root = resolveDataRoot();
  if (!root) fail("lanes: no data root resolved, the waypoint tables cannot be read");

  const graph = laneGraph(root);
  if (graph.error) fail("lanes: the waypoint table did not decode: " + graph.error);

  const waypoints = graph.waypoints;
  const key = (p) => p.x + "," + p.y;

  // --- the table itself. These are the values this machine's executable holds.
  if (waypoints.length !== 151) {
    fail("lanes: decoded " + waypoints.length + " waypoints, the archive has 151: " +
      JSON.stringify(waypoints.slice(0, 5)));
  }
  if (graph.count !== waypoints.length) fail("lanes: count field " + graph.count + " != " + waypoints.length);
  const first = waypoints.slice(0, 3).map((p) => key(p));
  if (first.join(" ") !== "0,15 0,28 3,64") {
    fail("lanes: first three waypoints are " + JSON.stringify(first) + " not 0,15 0,28 3,64");
  }
  if (key(waypoints[150]) !== "318,10") {
    fail("lanes: last waypoint is " + key(waypoints[150]) + " not 318,10");
  }
  for (let i = 0; i < waypoints.length; i++) {
    const p = waypoints[i];
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) fail("lanes: waypoint " + i + " is not integer: " + JSON.stringify(p));
    if (p.x < 0 || p.x > 319 || p.y < 0 || p.y > 135) fail("lanes: waypoint " + i + " is off the map: " + JSON.stringify(p));
  }
  const unique = new Set(waypoints.map(key));
  if (unique.size !== waypoints.length) fail("lanes: duplicate waypoints " + (waypoints.length - unique.size));

  // --- edges are indices, and the graph is connected in every direction.
  if (!Array.isArray(graph.edges) || graph.edges.length === 0) fail("lanes: no lane edges decoded");
  if (graph.edges.length !== 519) {
    fail("lanes: decoded " + graph.edges.length + " lane edges, this table holds 519");
  }
  const edgeSet = new Set();
  for (const edge of graph.edges) {
    const a = edge.a;
    const b = edge.b;
    if (!Number.isInteger(a) || !Number.isInteger(b)) fail("lanes: edge is not integer: " + JSON.stringify(edge));
    if (a < 0 || a >= waypoints.length || b < 0 || b >= waypoints.length) {
      fail("lanes: edge points outside the table: " + JSON.stringify(edge));
    }
    if (a === b) fail("lanes: edge is a self loop at " + a);
    edgeSet.add(a + ">" + b);
    if (!graph.adjacency[a].includes(b)) fail("lanes: adjacency misses edge " + a + ">" + b);
  }
  const adjacencyCount = graph.adjacency.reduce((sum, row) => sum + row.length, 0);
  if (adjacencyCount !== graph.edges.length) {
    fail("lanes: adjacency holds " + adjacencyCount + " links for " + graph.edges.length + " edges");
  }
  const seen = new Array(waypoints.length).fill(false);
  seen[0] = true;
  const queue = [0];
  let reached = 1;
  while (queue.length) {
    const u = queue.shift();
    for (const v of graph.adjacency[u]) if (!seen[v]) { seen[v] = true; reached++; queue.push(v); }
  }
  if (reached !== waypoints.length) fail("lanes: the lane graph reaches " + reached + " of " + waypoints.length + " waypoints");

  // --- the executable and its path stay on this machine.
  const serialized = JSON.stringify(graph);
  for (const leak of [".exe", ".EXE", "/mnt/nas", "unpacked", "CHQ_"]) {
    if (serialized.includes(leak)) fail("lanes: the graph payload leaks " + leak);
  }
  if (serialized.length > 40000) fail("lanes: the graph payload is " + serialized.length + " bytes, too large to be waypoints only");

  // --- one root, one parse.
  if (laneGraph(root) !== graph) fail("lanes: laneGraph did not reuse its cached graph for the same root");
  resetLaneCache();
  const again = laneGraph(root);
  if (again.waypoints.length !== 151) fail("lanes: re-reading the root lost waypoints: " + again.error);
  if (again === graph) fail("lanes: resetLaneCache did not drop the cached graph");
  resetLaneCache();

  // --- a ship sails exactly one lane step between two neighbouring waypoints.
  const ship = waypoints[0];              // 0,15 — the Blue ship's opening cell
  const neighbourIndex = graph.adjacency[0].find((i) => i !== 150);
  if (neighbourIndex === undefined) fail("lanes: waypoint 0 has no lane neighbour to sail to");
  const neighbour = waypoints[neighbourIndex];
  const step = seaRoute(root, ship, neighbour);
  if (!Array.isArray(step)) fail("lanes: no route between two adjacent waypoints " + key(ship) + " -> " + key(neighbour));
  if (step.length !== 2) fail("lanes: one lane step produced " + step.length + " steps: " + JSON.stringify(step));
  if (key(step[0]) !== key(ship)) fail("lanes: route does not start at the ship: " + key(step[0]));
  if (key(step[1]) !== key(neighbour)) fail("lanes: route lands at " + key(step[1]) + " not " + key(neighbour));
  if (!edgeSet.has(0 + ">" + neighbourIndex)) fail("lanes: the step is not a stored lane edge");

  // --- a long route stays on the lane graph from end to end.
  const goal = { x: 300, y: 70 };         // the Red ship's opening cell
  const route = seaRoute(root, ship, goal);
  if (!Array.isArray(route)) fail("lanes: no sea route from " + key(ship) + " to " + key(goal));
  if (route.length < 3) fail("lanes: the long route is only " + route.length + " steps: " + JSON.stringify(route));
  if (key(route[0]) !== key(ship)) fail("lanes: the long route starts at " + key(route[0]));
  if (key(route[route.length - 1]) !== key(goal)) fail("lanes: the long route ends at " + key(route[route.length - 1]) + " not " + key(goal));

  const indexOf = new Map(waypoints.map((p, i) => [key(p), i]));
  let interior = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = indexOf.get(key(route[i]));
    const b = indexOf.get(key(route[i + 1]));
    if (a === undefined || b === undefined) continue; // caller attachment leg
    if (!edgeSet.has(a + ">" + b)) fail("lanes: route step " + key(route[i]) + " -> " + key(route[i + 1]) + " is not a lane edge");
    interior++;
  }
  if (interior < 1) fail("lanes: the long route used no lane edge at all: " + JSON.stringify(route));

  // --- land-to-land never becomes a sea route: both capitals are dry ground.
  if (seaRoute(root, { x: 79, y: 44 }, { x: 183, y: 25 }) !== null) {
    fail("lanes: a land-to-land order was given a sea route");
  }
  if (seaRoute(root, { x: 183, y: 25 }, { x: 79, y: 44 }) !== null) {
    fail("lanes: a reversed land-to-land order was given a sea route");
  }
  if (seaRoute(root, ship, ship) !== null) fail("lanes: a ship already in place was given a route");

  // --- no root, no graph, no route. Never invented points.
  resetLaneCache();
  const missing = laneGraph("/nonexistent-openchq-root");
  if (missing.waypoints.length !== 0) fail("lanes: a missing root invented " + missing.waypoints.length + " waypoints");
  if (!missing.error) fail("lanes: a missing root reported no reason");
  if (seaRoute("/nonexistent-openchq-root", ship, goal) !== null) fail("lanes: a missing root produced a sea route");
  resetLaneCache();
  laneGraph(root);

  console.log(
    "lanes: " + waypoints.length + " waypoints, " + graph.edges.length + " lane edges, first " +
      first.join(" / ") + ", last " + key(waypoints[waypoints.length - 1]) +
      ", long route " + route.length + " steps"
  );
}
