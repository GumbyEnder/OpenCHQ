// Land movement. Owner: A2, node `orders`.
//
// A seat orders its own land piece to a cell. The piece walks one step per round, and a step
// whose ground is slower or is transport costs more beats. Both of those numbers come from
// rules.landPace; nothing here names the ratio or hard-codes a step cost. X wraps, Y does not,
// wasteland is refused, and a cell another piece holds is never entered: the walker stops one
// short and the fight belongs to combat.
//
// Sea lanes are lanes.mjs. A land order never becomes a sea route.

import { CELL_W, CELL_H, boardPayload, resolveDataRoot } from "./board.mjs";
import { landPace, isRefused } from "./rules.mjs";
import { seaRoute } from "./lanes.mjs";

// Cell ids for the board, or null when the extract is missing. Cached because boardPayload
// builds them once per process.
let cellsCache;
function cells() {
  if (cellsCache !== undefined) return cellsCache;
  try {
    cellsCache = boardPayload().cells || null;
  } catch {
    cellsCache = null;
  }
  return cellsCache;
}

export function wrapX(x) {
  return ((Number(x) % CELL_W) + CELL_W) % CELL_W;
}

// Signed shortest delta on the cylinder, -160..160.
export function wrapDelta(from, to) {
  let d = wrapX(to) - wrapX(from);
  if (d > CELL_W / 2) d -= CELL_W;
  else if (d < -CELL_W / 2) d += CELL_W;
  return d;
}

function terrainAt(x, y) {
  const grid = cells();
  if (!grid) return null;
  const index = Number(y) * CELL_W + wrapX(x);
  return grid[index] ?? null;
}

// Terrain cost of entering a cell. With no extract the ground is treated as open, so a test
// that runs without board data still walks rather than crashing.
function paceAt(x, y) {
  const id = terrainAt(x, y);
  if (id === null) return 1;
  return landPace(id);
}

function pieceAt(match, x, y, skipId = null) {
  const wx = wrapX(x);
  for (const unit of match.pieces || []) {
    if (skipId !== null && unit.id === skipId) continue;
    if (wrapX(unit.x) === wx && Number(unit.y) === Number(y)) return unit;
  }
  return null;
}

// Every cell a piece currently holds. An order and a walk both treat these as solid.
export function blockedCells(match) {
  const out = new Set();
  for (const unit of (match && match.pieces) || []) {
    out.add(wrapX(unit.x) + "," + Number(unit.y));
  }
  return out;
}

// Dial-weighted BFS over the cylinder. Entering a cell costs rules.landPace of that cell;
// refused cells (wasteland) are never entered, and held cells are skipped unless they are
// the destination (which issueOrder has already rejected).
function route(match, from, to) {
  const sx = wrapX(from.x);
  const sy = Number(from.y);
  const gx = wrapX(to.x);
  const gy = Number(to.y);
  if (sy < 0 || sy >= CELL_H || gy < 0 || gy >= CELL_H) return null;
  if (sx === gx && sy === gy) return [];

  const start = sy * CELL_W + sx;
  const goal = gy * CELL_W + gx;
  const dist = new Int32Array(CELL_W * CELL_H).fill(-1);
  const prev = new Int32Array(CELL_W * CELL_H).fill(-1);
  dist[start] = 0;
  const buckets = [[start]];
  const held = blockedCells(match);

  let cur = 0;
  let guard = 0;
  const limit = CELL_W * CELL_H * 4;
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (cur < buckets.length && guard < limit) {
    const bucket = buckets[cur];
    if (!bucket || bucket.length === 0) {
      cur += 1;
      continue;
    }
    guard += 1;
    const i = bucket.pop();
    if (dist[i] !== cur) continue;
    if (i === goal) break;

    const x = i % CELL_W;
    const y = (i - x) / CELL_W;
    for (const [dx, dy] of steps) {
      const ny = y + dy;
      if (ny < 0 || ny >= CELL_H) continue;
      const nx = wrapX(x + dx);
      const ni = ny * CELL_W + nx;
      const pace = paceAt(nx, ny);
      if (pace < 0) continue;
      if (ni !== goal && held.has(nx + "," + ny)) continue;
      const nd = cur + pace;
      if (dist[ni] !== -1 && dist[ni] <= nd) continue;
      dist[ni] = nd;
      prev[ni] = i;
      while (buckets.length <= nd) buckets.push([]);
      buckets[nd].push(ni);
    }
  }

  if (dist[goal] < 0) return null;
  const path = [];
  let walk = goal;
  let safety = 0;
  while (walk !== start) {
    if (prev[walk] < 0) return null;
    const px = walk % CELL_W;
    const py = (walk - px) / CELL_W;
    path.push({ x: px, y: py, pace: Math.max(1, paceAt(px, py)) });
    walk = prev[walk];
    safety += 1;
    if (safety > CELL_W * CELL_H) return null;
  }
  path.reverse();
  return path;
}

export function issueOrder(match, side, pieceId, toX, toY) {
  if (!match || !Array.isArray(match.pieces)) return { error: "No match is running." };
  if (match.over) return { error: "This match is over." };
  const piece = match.pieces.find((unit) => unit.id === pieceId);
  if (!piece) return { error: "No such piece: " + pieceId + "." };
  if (piece.side !== side) return { error: "That piece belongs to " + piece.side + "." };

  const x = Number(toX);
  const y = Number(toY);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { error: "An order needs whole cells." };
  if (y < 0 || y >= CELL_H) return { error: "The destination is off the map." };

  // A ship sails the recovered lane graph, never a straight line. The land walker below is
  // deliberately not consulted: it does not know where water is.
  if (piece.domain === "sea") {
    const holder = pieceAt(match, x, y, piece.id);
    if (holder) return { error: "Another piece holds that cell (" + holder.id + ")." };
    let route = null;
    try {
      route = seaRoute(resolveDataRoot() || "", { x: piece.x, y: piece.y }, { x, y });
    } catch {
      route = null;
    }
    if (!route || !route.length) return { error: "No sea lane reaches that cell." };
    piece.path = route.map((step) => ({ x: step.x, y: step.y, pace: 1 }));
    return { ok: true, path: piece.path };
  }

  if (isRefused(terrainAt(x, y) ?? -1)) return { error: "Wasteland is refused." };

  const holder = pieceAt(match, x, y, piece.id);
  if (holder) return { error: "Another piece holds that cell (" + holder.id + ")." };

  const path = route(match, piece, { x, y });
  if (path === null) return { error: "No route. Wasteland is refused and a held cell is not entered." };
  if (path.length === 0) {
    piece.path = [];
    piece.pace = 1;
    return { ok: true, path: [] };
  }
  piece.path = path;
  piece.pace = Math.max(1, Number(path[0].pace) || 1);
  return { ok: true, path: path.map((step) => ({ ...step })) };
}

function facingFor(fromX, fromY, toX, toY) {
  const dx = wrapDelta(fromX, toX);
  const dy = Number(toY) - Number(fromY);
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? "e" : "w";
  if (dy !== 0) return dy > 0 ? "s" : "n";
  return null;
}

// One running round. A step whose ground costs two beats is taken on the second round the
// piece spends on it, and the pace counter only decrements where the ground allows.
export function advance(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces) || match.over) return events;
  for (const piece of match.pieces) {
    if (!Array.isArray(piece.path) || piece.path.length === 0) continue;
    // A ship's path comes from the lane graph (lanes.seaRoute), stepped one waypoint at a time;
    // a land piece's comes from a walk. The stepping below is the same either way, so neither
    // domain may be skipped here - skipping sea is what left every routed ship standing still.

    const next = piece.path[0];
    const nx = wrapX(next.x);
    const ny = Number(next.y);
    const occupant = pieceAt(match, nx, ny, piece.id);
    if (occupant) {
      // Stop one short: the walker never shares a cell, and the clash is combat's job.
      piece.path = [];
      piece.pace = 1;
      events.push({ type: "blocked", pieceId: piece.id, by: occupant.id, x: nx, y: ny });
      continue;
    }

    const owed = Math.max(1, Number(piece.pace) || 1);
    if (owed > 1) {
      piece.pace = owed - 1;
      continue;
    }

    const fromX = piece.x;
    const fromY = piece.y;
    piece.facing = facingFor(fromX, fromY, nx, ny);
    piece.x = nx;
    piece.y = ny;
    piece.path.shift();
    piece.pace = piece.path.length > 0 ? Math.max(1, Number(piece.path[0].pace) || 1) : 1;
    events.push({ type: "move", pieceId: piece.id, x: nx, y: ny });
  }
  return events;
}
