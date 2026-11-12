// Sea lanes. Owner: A3.
//
// 151 waypoints live inside CHQ_unpacked.EXE, immediately after the unpacked
// data segment at file base 0x328B0 (DS:0). The layout below is the one
// scripts/sea_lanes.gd reads; every table starts where that script says it does
// and the three integrity facts it checks hold on this machine:
//   waypoint[0] = (0, 15), waypoint[150] = (318, 10), 151 points, 27 groups.
// Each group's slot stride equals its member count and every slot inside a group
// is unique, so the tables are self-consistent, not a lucky guess.
//
// Only the server reads this file. Nothing here returns bytes or a path to the
// executable: laneGraph() hands back plain numbers.

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardPayload } from "./board.mjs";

export const WAYPOINT_COUNT = 151;
export const GROUP_COUNT = 27;

const FILE_BASE = 0x328b0;
const AT_X = 0x3356; // 151 little-endian uint16
const AT_Y = 0x3484; // 151 bytes
const AT_GROUP = 0x351c; // 151 bytes; bit 0x20 means "second group in AT_ALT"
const AT_ALT = 0x35b4; // 151 bytes
const AT_SLOT = 0x364c; // 151 bytes; low nibble = slot in first group, high = slot in second
const AT_STRIDE = 0x36e4; // 27 bytes: slots per group row
const AT_BASE = 0x3700; // 27 little-endian uint16: first edge byte per group
const AT_EDGES = 0x3736;
const AT_END = 0x3de2; // exclusive

const EXE_NAME = "CHQ_unpacked.EXE";
const CELL_W = 320;
const CELL_H = 136;

const graphCache = new Map();

function exeCandidates(dataRoot) {
  if (!dataRoot) return [];
  const out = [];
  const override = process.env.OPENCHQ_EXE;
  if (override) out.push(override);
  out.push(path.join(dataRoot, "exe", EXE_NAME));
  out.push(path.join(dataRoot, EXE_NAME));
  return out;
}

function findExe(dataRoot) {
  for (const candidate of exeCandidates(dataRoot)) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

// DS:0 group byte -> up to two group ids. With bit 0x20 the low five bits are
// the first group and the alt table names the second.
function ends(groupByte, altByte) {
  if (groupByte & 0x20) return { first: groupByte & 0x1f, second: altByte };
  return { first: groupByte, second: -1 };
}

function emptyGraph(error) {
  return { waypoints: [], edges: [], adjacency: [], count: 0, error };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledWorldFile = path.resolve(here, "..", "data", "world.json");

// The public host has no extract, so the lane tables cannot be read there. tools/bake_world.mjs
// writes the decoded waypoints and edges into web/data/world.json for exactly that host. The
// table is still a derivation of ours, never the executable.
function bundledGraph(error) {
  if (!existsSync(bundledWorldFile)) return emptyGraph(error || "no bundled lane table");
  let world;
  try {
    world = JSON.parse(readFileSync(bundledWorldFile, "utf8"));
  } catch (err) {
    return emptyGraph("cannot read the baked world: " + err.message);
  }
  const lanes = world && world.lanes;
  if (!lanes || !Array.isArray(lanes.waypoints) || !Array.isArray(lanes.adjacency)) {
    return emptyGraph(error || "the baked world carries no lane table");
  }
  const waypoints = lanes.waypoints.map((point) => ({ x: Number(point.x), y: Number(point.y) }));
  const adjacency = lanes.adjacency.map((row) => (Array.isArray(row) ? row.map(Number) : []));
  const edges = [];
  for (let a = 0; a < adjacency.length; a++) {
    for (const b of adjacency[a]) edges.push({ a, b });
  }
  return {
    waypoints,
    edges,
    adjacency,
    count: waypoints.length,
    edgeCount: edges.length,
    source: "bundled",
    error: "",
  };
}

// Reads the waypoint tables once and caches the result per data root.
export function laneGraph(dataRoot) {
  const key = String(dataRoot || "");
  const hit = graphCache.get(key);
  if (hit) return hit;

  // No data root means the public host: play the baked lane table instead of refusing every
  // sea order. An explicit root that does not exist still fails, so a broken install is loud.
  if (key === "") {
    const baked = bundledGraph("no CHQ_unpacked.EXE under (no data root)");
    graphCache.set(key, baked);
    return baked;
  }

  const exe = findExe(key);
  if (!exe) {
    const miss = emptyGraph("no CHQ_unpacked.EXE under " + (key || "(no data root)"));
    graphCache.set(key, miss);
    return miss;
  }

  let buf;
  try {
    buf = readFileSync(exe);
  } catch (err) {
    const miss = emptyGraph("cannot read the unpacked EXE: " + err.message);
    graphCache.set(key, miss);
    return miss;
  }

  if (buf.length < FILE_BASE + AT_END) {
    const miss = emptyGraph(
      "unpacked EXE is " + buf.length + " bytes, the lane tables need " + (FILE_BASE + AT_END)
    );
    graphCache.set(key, miss);
    return miss;
  }

  const waypoints = [];
  for (let i = 0; i < WAYPOINT_COUNT; i++) {
    const at = FILE_BASE + AT_X + i * 2;
    waypoints.push({
      x: buf[at] | (buf[at + 1] << 8),
      y: buf[FILE_BASE + AT_Y + i],
    });
  }

  const group = new Array(WAYPOINT_COUNT);
  const alt = new Array(WAYPOINT_COUNT);
  const slot = new Array(WAYPOINT_COUNT);
  for (let i = 0; i < WAYPOINT_COUNT; i++) {
    group[i] = buf[FILE_BASE + AT_GROUP + i];
    alt[i] = buf[FILE_BASE + AT_ALT + i];
    slot[i] = buf[FILE_BASE + AT_SLOT + i];
  }

  const stride = new Array(GROUP_COUNT);
  const base = new Array(GROUP_COUNT);
  for (let g = 0; g < GROUP_COUNT; g++) {
    stride[g] = buf[FILE_BASE + AT_STRIDE + g];
    const at = FILE_BASE + AT_BASE + g * 2;
    base[g] = buf[at] | (buf[at + 1] << 8);
  }

  const edges = buf.subarray(FILE_BASE + AT_EDGES, FILE_BASE + AT_END);

  // A group row is a slot-by-slot matrix naming the neighbour index, or 0xFF for
  // "no lane". The matrix is directional: keep it exactly as stored.
  const edgeAt = (grp, slotA, slotB) => {
    if (grp < 0 || grp >= GROUP_COUNT) return -1;
    const index = stride[grp] * slotA + slotB + base[grp];
    if (index < 0 || index >= edges.length) return -1;
    return edges[index];
  };

  const adjacency = Array.from({ length: WAYPOINT_COUNT }, () => []);
  const edgesOut = [];
  for (let a = 0; a < WAYPOINT_COUNT; a++) {
    const ga = ends(group[a], alt[a]);
    for (let b = 0; b < WAYPOINT_COUNT; b++) {
      if (a === b) continue;
      const gb = ends(group[b], alt[b]);
      const link = (named) => {
        if (named !== b) return;
        if (adjacency[a].includes(b)) return;
        adjacency[a].push(b);
        edgesOut.push({ a, b });
      };
      if (ga.first === gb.first) link(edgeAt(ga.first, slot[a] & 0x0f, slot[b] & 0x0f));
      if (gb.second >= 0 && ga.first === gb.second) link(edgeAt(ga.first, slot[a] & 0x0f, slot[b] >> 4));
      if (ga.second >= 0 && ga.second === gb.first) link(edgeAt(ga.second, slot[a] >> 4, slot[b] & 0x0f));
      if (ga.second >= 0 && gb.second >= 0 && ga.second === gb.second) {
        link(edgeAt(ga.second, slot[a] >> 4, slot[b] >> 4));
      }
    }
  }

  const problems = [];
  if (waypoints.length !== WAYPOINT_COUNT) problems.push("waypoint count " + waypoints.length);
  if (waypoints[0].x !== 0 || waypoints[0].y !== 15) {
    problems.push("first waypoint " + waypoints[0].x + "," + waypoints[0].y + " not 0,15");
  }
  if (waypoints[WAYPOINT_COUNT - 1].x !== 318 || waypoints[WAYPOINT_COUNT - 1].y !== 10) {
    problems.push("last waypoint " + waypoints[WAYPOINT_COUNT - 1].x + "," +
      waypoints[WAYPOINT_COUNT - 1].y + " not 318,10");
  }
  const stray = waypoints.findIndex((p) => p.x < 0 || p.x >= CELL_W || p.y < 0 || p.y >= CELL_H);
  if (stray >= 0) problems.push("waypoint " + stray + " is off the map");
  if (edgesOut.length === 0) problems.push("no lane edges decoded");

  // Every waypoint must be sailable from every other one, or the tables were read
  // at the wrong offset.
  const seen = new Array(WAYPOINT_COUNT).fill(false);
  const queue = [0];
  seen[0] = true;
  let reached = 1;
  while (queue.length) {
    const u = queue.shift();
    for (const v of adjacency[u]) if (!seen[v]) { seen[v] = true; reached++; queue.push(v); }
  }
  if (reached !== WAYPOINT_COUNT) problems.push("lane graph reaches only " + reached + " of 151 waypoints");

  if (problems.length) {
    const bad = emptyGraph("lane tables did not decode cleanly: " + problems.join("; "));
    graphCache.set(key, bad);
    return bad;
  }

  const graph = {
    waypoints,
    edges: edgesOut,
    adjacency,
    count: waypoints.length,
    edgeCount: edgesOut.length,
    error: "",
  };
  graphCache.set(key, graph);
  return graph;
}

export function resetLaneCache() {
  graphCache.clear();
  legCache.clear();
  sailCache.clear();
}

// Every water cell a hull can actually sail to: the water connected to at least one lane
// waypoint, walked one cell at a time. The terrain map has 105 one-cell water pockets on this
// board (row 0 and a few inland holes); a ship bought there could never move, because the only
// way out was a jump the lanes do not make. Placement asks this set, so the highlight a player
// clicks is water the hull can leave.
const sailCache = new Map();

export function sailableWater(dataRoot) {
  const key = String(dataRoot || "");
  const hit = sailCache.get(key);
  if (hit) return hit;
  const graph = laneGraph(key);
  const set = new Set();
  if (!graph.error && graph.waypoints.length) {
    const queue = [];
    for (const wp of graph.waypoints) {
      if (!isWater(cellId(key, wp.x, wp.y))) continue;
      const cellKey = wp.x + "," + wp.y;
      if (set.has(cellKey)) continue;
      set.add(cellKey);
      queue.push({ x: wp.x, y: wp.y });
    }
    let head = 0;
    while (head < queue.length) {
      const cell = queue[head++];
      for (const hop of WATER_HOPS) {
        const x = (cell.x + hop.dx + CELL_W) % CELL_W;
        const y = cell.y + hop.dy;
        if (y < 0 || y >= CELL_H) continue;
        const cellKey = x + "," + y;
        if (set.has(cellKey)) continue;
        if (!isWater(cellId(key, x, y))) continue;
        set.add(cellKey);
        queue.push({ x, y });
      }
    }
  }
  sailCache.set(key, set);
  return set;
}

// A cell's terrain as the SERVER SERVES IT: boardPayload's grid, which is the raw tmap.bin plus
// the site painter. Reading tmap.bin here and stopping there was a lie the gate caught - the
// painter lays a city (id 6), capital (4) or base (5) over cells the raw map paints as water, so
// 267,48 is water to a raw reader and Tokyo's city block to the player, and a lane leg could
// stand a hull on it. The hull is drawn on boardPayload's cells, so that is the map it sails.
function cellId(dataRoot, x, y) {
  if (y < 0 || y >= CELL_H) return null;
  try {
    const cells = boardPayload().cells;
    if (!Array.isArray(cells)) return null;
    const cx = ((Math.trunc(x) % CELL_W) + CELL_W) % CELL_W;
    return cells[y * CELL_W + cx] ?? null;
  } catch {
    return null;
  }
}

// 0 ocean, 1 docks, 2 shallows. Anything above is dry ground.
function isWater(id) {
  return id !== null && id >= 0 && id <= 2;
}

function point(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.trunc(x), y: Math.trunc(y) };
}

function wrapX(dx) {
  const abs = Math.abs(dx);
  return abs > CELL_W / 2 ? CELL_W - abs : abs;
}

function laneCost(a, b) {
  return Math.max(wrapX(b.x - a.x), Math.abs(b.y - a.y));
}

function nearestWaypoint(graph, target, accept = null) {
  let best = -1;
  let bestCost = Infinity;
  let fallback = -1;
  let fallbackCost = Infinity;
  for (let i = 0; i < graph.waypoints.length; i++) {
    const cost = laneCost(graph.waypoints[i], target);
    if (cost < fallbackCost) {
      fallbackCost = cost;
      fallback = i;
    }
    if (accept && !accept(i)) continue;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best >= 0 ? best : fallback;
}

function shortestChain(graph, start, goal) {
  const count = graph.waypoints.length;
  const dist = new Array(count).fill(Infinity);
  const prev = new Array(count).fill(-1);
  const used = new Array(count).fill(false);
  dist[start] = 0;
  for (let step = 0; step < count; step++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      if (!used[i] && dist[i] < best) { best = dist[i]; u = i; }
    }
    if (u < 0) break;
    if (u === goal) break;
    used[u] = true;
    for (const v of graph.adjacency[u]) {
      const next = dist[u] + Math.max(1, laneCost(graph.waypoints[u], graph.waypoints[v]));
      if (next < dist[v]) { dist[v] = next; prev[v] = u; }
    }
  }
  if (!Number.isFinite(dist[goal])) return null;
  const chain = [];
  let cur = goal;
  let guard = 0;
  while (cur !== start && guard++ <= count) {
    chain.push(cur);
    cur = prev[cur];
    if (cur < 0) return null;
  }
  chain.push(start);
  chain.reverse();
  return chain;
}

// The waypoint nearest a cell that the terrain map paints as water. This is the seam T-004 asks
// for: a ship or a transport may sit anywhere on the ocean, but the lane graph only joins its 151
// waypoints, so an arbitrary water cell has to be joined to one of them before it can sail.
//
// The nearest wet waypoint wins; the nearest waypoint of any kind is the fallback for a caller that
// does not pass an accept test, and for a graph whose every neighbour is painted dry.
export function joinLane(dataRoot, cell, accept = null) {
  const graph = laneGraph(dataRoot);
  if (graph.error || !graph.waypoints.length) return null;
  const target = point(cell);
  if (!target) return null;
  const wet = accept || ((i) => isWater(cellId(dataRoot, graph.waypoints[i].x, graph.waypoints[i].y)));
  const index = nearestWaypoint(graph, target, wet);
  if (index < 0) return null;
  return { index, waypoint: graph.waypoints[index], graph };
}

// One lane leg, expanded to the cells a hull actually crosses. `cellId` decides what counts as
// water: the archive's lanes are coarser than its terrain map, so 27 of the 151 waypoints sit on a
// cell painted as ground. Dropping those cells would leave a hole in the leg, and a hole is a
// teleport: the hull skips a cell, never meets what stands on it, and lands on dry ground if the
// hole is at an anchor. So a leg is expanded cell by cell, and where the straight lane line is
// interrupted by ground the leg is walked around it through water (waterLeg between two points).
// No leg ever stands on a dry cell: a lane waypoint painted dry is not an anchor, and if the water
// walk between two wet anchors fails, the order is refused rather than given a jump.
function legCells(dataRoot, a, b) {
  const dx = b.x - a.x;
  const gap = Math.abs(dx);
  const sx = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  // The short way round the cylinder: a 305-cell westward leg is a 15-cell eastward one.
  const stepX = gap > CELL_W / 2 ? -sx : sx;
  let x = a.x;
  let y = a.y;
  const distX = gap > CELL_W / 2 ? CELL_W - gap : gap;
  const distY = Math.abs(b.y - a.y);
  let err = distX - distY;
  const sy = b.y === a.y ? 0 : b.y > a.y ? 1 : -1;
  const out = [];
  let guard = 0;
  while (guard++ <= CELL_W) {
    out.push({ x, y });
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 > -distY && distX > 0) { err -= distY; x = (x + stepX + CELL_W) % CELL_W; }
    if (e2 < distX && distY > 0) { err += distX; y += sy; }
    if (distX === 0) y += sy;
  }
  return out;
}

// How far apart two cells are, with the cylinder folded in.
function stepGap(a, b) {
  const raw = Math.abs(b.x - a.x);
  const dx = Math.min(raw, CELL_W - raw);
  return Math.max(dx, Math.abs(b.y - a.y));
}

// A path a hull can actually sail: every consecutive pair is one cell apart.
function isContiguous(cells) {
  for (let i = 1; i < cells.length; i++) if (stepGap(cells[i - 1], cells[i]) !== 1) return false;
  return true;
}

const WATER_HOPS = [];
for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx !== 0 || dy !== 0) WATER_HOPS.push({ dx, dy });

// The water cells between two points, one cell at a time, going around ground. Breadth-first
// because every hop is one cell, so the first path found is the shortest in cells. Both ends must
// be water as well: a leg that cannot begin and finish on water has no water-only path, and the
// caller refuses the order instead of handing back a jump or a hull standing on dry ground.
function waterWalk(dataRoot, from, to, limit = CELL_W * CELL_H) {
  const goalKey = to.x + "," + to.y;
  const startKey = from.x + "," + from.y;
  if (!isWater(cellId(dataRoot, from.x, from.y)) || !isWater(cellId(dataRoot, to.x, to.y))) return null;
  if (startKey === goalKey) return [from];
  const passable = (x, y) => {
    if (y < 0 || y >= CELL_H) return false;
    return isWater(cellId(dataRoot, x, y));
  };
  const parent = new Map();
  parent.set(startKey, null);
  const queue = [from];
  let head = 0;
  while (head < queue.length && head < limit) {
    const cell = queue[head++];
    for (const hop of WATER_HOPS) {
      const x = (cell.x + hop.dx + CELL_W) % CELL_W;
      const y = cell.y + hop.dy;
      const key = x + "," + y;
      if (parent.has(key) || !passable(x, y)) continue;
      parent.set(key, cell);
      if (key === goalKey) {
        const path = [{ x, y }];
        let back = cell;
        while (back) {
          path.push({ x: back.x, y: back.y });
          back = parent.get(back.x + "," + back.y);
        }
        return path.reverse();
      }
      queue.push({ x, y });
    }
  }
  return null;
}

const legCache = new Map();

// One lane leg as water cells a hull crosses, contiguous from end to end. The straight lane line
// when it is already water the whole way; otherwise a water walk around the ground it crosses.
function waterLeg(dataRoot, a, b) {
  const keyIn = dataRoot + "|" + a.x + "," + a.y + "|" + b.x + "," + b.y;
  const hit = legCache.get(keyIn);
  if (hit !== undefined) return hit;

  const line = legCells(dataRoot, a, b);
  const lineOk = line.length > 1 &&
    line.every((cell) => isWater(cellId(dataRoot, cell.x, cell.y))) &&
    isContiguous(line) &&
    line[0].x === a.x && line[0].y === a.y &&
    line[line.length - 1].x === b.x && line[line.length - 1].y === b.y;
  const result = lineOk ? line : waterWalk(dataRoot, a, b);
  legCache.set(keyIn, result);
  return result;
}

// The lane plan from `from` to `to`: the water cells a hull crosses, and the lane waypoint
// indices it actually anchors to, in order. Null when the lane graph cannot join them. Refuses
// outright when both endpoints are dry land: a land order is move.mjs's business and must never
// turn into a sea route.
function lanePlan(dataRoot, from, to) {
  const start = point(from);
  const end = point(to);
  if (!start || !end) return null;
  if (start.y < 0 || start.y >= CELL_H || end.y < 0 || end.y >= CELL_H) return null;
  if (start.x === end.x && start.y === end.y) return null;

  // A sea leg starts and ends on water. A dry endpoint is a land order (move.mjs owns it) or a
  // lake cell the lanes never reach; either way a sea route would have to stand a hull on dry
  // ground, so refuse instead of inventing a path.
  const startTerrain = cellId(dataRoot, start.x, start.y);
  const endTerrain = cellId(dataRoot, end.x, end.y);
  if (!isWater(startTerrain) || !isWater(endTerrain)) return null;

  const graph = laneGraph(dataRoot);
  if (graph.error || !graph.waypoints.length) return null;

  const startIndex = nearestWaypoint(graph, start, (i) => isWater(cellId(dataRoot, graph.waypoints[i].x, graph.waypoints[i].y)));
  const goalIndex = nearestWaypoint(graph, end, (i) => isWater(cellId(dataRoot, graph.waypoints[i].x, graph.waypoints[i].y)));
  if (startIndex < 0 || goalIndex < 0) return null;

  let legs;
  if (startIndex === goalIndex) {
    legs = [startIndex];
  } else {
    legs = shortestChain(graph, startIndex, goalIndex);
    if (!legs) return null;
  }

  // A lane step has to be water. Some of the recovered waypoints sit on a cell the terrain map
  // paints as ground (the archive's lanes are coarser than its terrain); those are not anchors a
  // hull can stand on, and forcing them in (as this used to) put a ship on dry land. They are
  // skipped, and the legs around them are walked through water instead.
  const wet = legs.filter((index) => isWater(cellId(dataRoot, graph.waypoints[index].x, graph.waypoints[index].y)));

  // The anchors: where the hull is, the water lane waypoints it passes, and where it ends.
  const anchors = [{ x: start.x, y: start.y }];
  for (const index of wet) {
    const wp = graph.waypoints[index];
    const prev = anchors[anchors.length - 1];
    if (prev.x === wp.x && prev.y === wp.y) continue;
    anchors.push({ x: wp.x, y: wp.y });
  }
  const lastAnchor = anchors[anchors.length - 1];
  if (lastAnchor.x !== end.x || lastAnchor.y !== end.y) anchors.push({ x: end.x, y: end.y });

  // Every leg between anchors is one cell at a time through water. A leg that cannot be walked
  // (a lake, a lane table that crosses a continent with no water gap) refuses the whole route
  // rather than handing back a jump the hull would make through a cell it never visits.
  //
  // Cells are appended as the walk gives them, and only an exact repeat of the cell just pushed is
  // dropped. A global "already seen" set looked tidier but cut loops: a leg that walked back
  // through an earlier cell lost it, and the path jumped two cells instead of one.
  const steps = [];
  const push = (cell) => {
    const prev = steps[steps.length - 1];
    if (prev && prev.x === cell.x && prev.y === cell.y) return;
    steps.push({ x: cell.x, y: cell.y });
  };
  push(anchors[0]);
  for (let i = 1; i < anchors.length; i++) {
    const leg = waterLeg(dataRoot, anchors[i - 1], anchors[i]);
    if (!leg) return null;
    for (const cell of leg) push(cell);
  }
  if (steps.length < 2) return null;
  return { steps, waypoints: wet.slice() };
}

// The water cells of a sea route, for a hull to follow step by step.
export function seaRoute(dataRoot, from, to) {
  const plan = lanePlan(dataRoot, from, to);
  return plan ? plan.steps : null;
}

// A short water hop, walked cell by cell around any ground the straight line crosses. A land
// order's sea leg uses this when the crossing is only a few cells long: the lanes are for
// voyages, and sending a unit to a waypoint thirty cells away would be a teleport. Walking it
// (rather than taking the line's cells as they come) is what keeps a hull off the port city that
// sits between two dock cells on a straight line - 209 of the 60,874 planned land routes did
// step onto that city at the final hop.
export function waterStepRoute(dataRoot, from, to) {
  const a = point(from);
  const b = point(to);
  if (!a || !b) return null;
  const path = waterWalk(dataRoot, a, b);
  return path ? path.map((cell) => ({ x: cell.x, y: cell.y })) : null;
}

// The lane waypoints a sea route anchors to, in lane order. A test asks this instead of scraping
// the cells, because a water walk may pass over a waypoint cell that is not on the chain.
export function seaWaypoints(dataRoot, from, to) {
  const plan = lanePlan(dataRoot, from, to);
  return plan ? plan.waypoints : null;
}
