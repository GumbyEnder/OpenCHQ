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
const TERRAIN_STRIDE = 162; // same packing as board.mjs: 320x136 nibbles
const CELL_W = 320;
const CELL_H = 136;

const graphCache = new Map();
const terrainCache = new Map();

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

// Reads the waypoint tables once and caches the result per data root.
export function laneGraph(dataRoot) {
  const key = String(dataRoot || "");
  const hit = graphCache.get(key);
  if (hit) return hit;

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
  terrainCache.clear();
}

// Terrain ids are the same packing board.mjs reads. Only used to tell a land
// endpoint from a water one; nothing about the map leaves this module either.
function terrainRow(dataRoot, y) {
  const key = String(dataRoot || "");
  let terrain = terrainCache.get(key);
  if (!terrain) {
    const file = path.join(key, "data", "tmap.bin");
    if (!key || !existsSync(file)) {
      terrainCache.set(key, null);
      return null;
    }
    try {
      const fd = openSync(file, "r");
      try {
        const row = Buffer.alloc(TERRAIN_STRIDE * CELL_H);
        const read = readSync(fd, row, 0, row.length, 0);
        terrain = read >= TERRAIN_STRIDE ? row : null;
      } finally {
        closeSync(fd);
      }
    } catch {
      terrain = null;
    }
    terrainCache.set(key, terrain);
  }
  if (!terrain || y < 0 || y >= CELL_H) return null;
  return terrain;
}

function cellId(dataRoot, x, y) {
  const rows = terrainRow(dataRoot, y);
  if (!rows) return null;
  const cx = ((Math.trunc(x) % CELL_W) + CELL_W) % CELL_W;
  const value = rows[y * TERRAIN_STRIDE + (cx >> 1)];
  return cx % 2 === 0 ? (value >> 4) & 0x0f : value & 0x0f;
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

function nearestWaypoint(graph, target) {
  let best = -1;
  let bestCost = Infinity;
  for (let i = 0; i < graph.waypoints.length; i++) {
    const cost = laneCost(graph.waypoints[i], target);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
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

// Waypoints from `from` to `to`, in order, or null when the lane graph cannot
// join them. Refuses outright when both endpoints are dry land: a land order is
// move.mjs's business and must never turn into a sea route.
export function seaRoute(dataRoot, from, to) {
  const start = point(from);
  const end = point(to);
  if (!start || !end) return null;
  if (start.y < 0 || start.y >= CELL_H || end.y < 0 || end.y >= CELL_H) return null;
  if (start.x === end.x && start.y === end.y) return null;

  // Both ends dry: this is a land order and must never become a sea route.
  // One dry end is allowed on purpose — 27 of the 151 waypoints sit on a dry
  // cell according to tmap.bin (the eastern terminal at 318,10 is one), so the
  // lane graph, not the terrain map, decides where the sea legs run.
  const startTerrain = cellId(dataRoot, start.x, start.y);
  const endTerrain = cellId(dataRoot, end.x, end.y);
  if (startTerrain !== null && endTerrain !== null &&
    !isWater(startTerrain) && !isWater(endTerrain)) {
    return null;
  }

  const graph = laneGraph(dataRoot);
  if (graph.error || !graph.waypoints.length) return null;

  const startIndex = nearestWaypoint(graph, start);
  const goalIndex = nearestWaypoint(graph, end);
  if (startIndex < 0 || goalIndex < 0) return null;

  let legs;
  if (startIndex === goalIndex) {
    legs = [startIndex];
  } else {
    legs = shortestChain(graph, startIndex, goalIndex);
    if (!legs) return null;
  }

  const steps = [{ x: start.x, y: start.y }];
  for (const index of legs) {
    const wp = graph.waypoints[index];
    const last = steps[steps.length - 1];
    if (wp.x !== last.x || wp.y !== last.y) steps.push({ x: wp.x, y: wp.y });
  }
  const last = steps[steps.length - 1];
  if (last.x !== end.x || last.y !== end.y) steps.push({ x: end.x, y: end.y });
  if (steps.length < 2) return null;
  return steps;
}
