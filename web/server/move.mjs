// Land movement. Owner: A2, node `orders`.
//
// A seat orders its own land piece to a cell. The piece walks one step per round, and a step
// whose ground is slower or is transport costs more beats. Both of those numbers come from
// rules.landPace; nothing here names the ratio or hard-codes a step cost. X wraps, Y does not,
// wasteland is refused, and a cell another piece holds is never entered: the walker stops one
// short and the fight belongs to combat.
//
// Sea lanes are lanes.mjs. A land order never becomes a sea route.

import { CELL_W, CELL_H, TERRAIN, boardPayload, resolveDataRoot } from "./board.mjs";
import { landPace, isRefused, combatRules } from "./rules.mjs";
import { seaRoute } from "./lanes.mjs";
import { inactiveRounds, isAircraft } from "./air.mjs";
import { movementBlocked } from "./resources.mjs";
import { applyDamage, ensureStrength } from "./combat.mjs";

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

// The terrain name a strength-draining cell carries, or null where the map has no answer.
export function terrainNameAt(x, y) {
  const id = terrainAt(x, y);
  return id === null ? null : TERRAIN[Number(id)] || null;
}

// Sea terrain ids: ocean, docks, shallows (board.TERRAIN / rules.seaAccepts class 0).
const WATER_MAX_ID = 2;

function isWater(x, y) {
  const id = terrainAt(x, y);
  return id !== null && Number(id) <= WATER_MAX_ID;
}

// A land piece in the water is a transport, and a transport is cargo: it cannot fight back.
// The state follows the cell, so there is nothing to keep in sync by hand.
function syncTransport(piece, x, y) {
  const inWater = isWater(x, y);
  const had = piece.transport === true;
  piece.transport = inWater;
  return had !== inWater;
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
// Cells a walker will go round. Only its OWN side counts: a march into an enemy-held cell is
// contact, and combat decides it. Treating the enemy as an obstacle is what let two armies walk
// past each other for 244 rounds without a shot.
export function blockedCells(match, side = null) {
  const out = new Set();
  for (const unit of (match && match.pieces) || []) {
    if (side && unit.side !== side) continue;
    out.add(wrapX(unit.x) + "," + Number(unit.y));
  }
  return out;
}

// A* over the cylinder, with a wrap-aware Manhattan heuristic. Entering a cell costs
// rules.landPace of that cell; refused cells (wasteland) are never entered, and held cells are
// skipped unless they are the destination (which issueOrder has already rejected).
//
// This used to be a dial-weighted breadth-first search that allocated and filled two 43,520-entry
// arrays per order: 5.65 ms an order, and the order is what a player sends. The arrays are now
// reused with a generation stamp, and the heap is a flat Int32Array - a search explores a corridor
// instead of the whole board.
const CELLS = CELL_W * CELL_H;
const DIST = new Int32Array(CELLS);
const PREV = new Int32Array(CELLS);
const SEEN = new Int32Array(CELLS);
let generation = 0;

// Binary min-heap of cell indices, ordered by f = g + h. Two parallel Int32Arrays, no objects.
const HEAP_NODE = new Int32Array(CELLS + 1);
const HEAP_KEY = new Int32Array(CELLS + 1);
let heapSize = 0;

function heapPush(node, key) {
  let i = heapSize++;
  HEAP_NODE[i] = node;
  HEAP_KEY[i] = key;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (HEAP_KEY[up] <= HEAP_KEY[i]) break;
    const n = HEAP_NODE[up];
    const k = HEAP_KEY[up];
    HEAP_NODE[up] = HEAP_NODE[i];
    HEAP_KEY[up] = HEAP_KEY[i];
    HEAP_NODE[i] = n;
    HEAP_KEY[i] = k;
    i = up;
  }
}

function heapPop() {
  const node = HEAP_NODE[0];
  heapSize -= 1;
  HEAP_NODE[0] = HEAP_NODE[heapSize];
  HEAP_KEY[0] = HEAP_KEY[heapSize];
  let i = 0;
  for (;;) {
    const left = i * 2 + 1;
    if (left >= heapSize) break;
    const right = left + 1;
    const small = right < heapSize && HEAP_KEY[right] < HEAP_KEY[left] ? right : left;
    if (HEAP_KEY[i] <= HEAP_KEY[small]) break;
    const n = HEAP_NODE[small];
    const k = HEAP_KEY[small];
    HEAP_NODE[small] = HEAP_NODE[i];
    HEAP_KEY[small] = HEAP_KEY[i];
    HEAP_NODE[i] = n;
    HEAP_KEY[i] = k;
    i = small;
  }
  return node;
}

// Cheap and admissible: every cell costs at least one round, so the cell distance never
// overestimates the remaining cost.
function lowerBound(x, y, gx, gy) {
  const rawX = Math.abs(x - gx);
  return Math.min(rawX, CELL_W - rawX) + Math.abs(y - gy);
}

function route(match, from, to, side = null) {
  const sx = wrapX(from.x);
  const sy = Number(from.y);
  const gx = wrapX(to.x);
  const gy = Number(to.y);
  if (sy < 0 || sy >= CELL_H || gy < 0 || gy >= CELL_H) return null;
  if (sx === gx && sy === gy) return [];

  const start = sy * CELL_W + sx;
  const goal = gy * CELL_W + gx;
  // Two marks per search: visited and settled. One mark would let the previous search's settled
  // cells look settled in this one, which is how half these orders came back "no route".
  generation += 2;
  if (generation > 2000000000) {
    SEEN.fill(0);
    generation = 2;
  }
  const mark = generation;
  const held = blockedCells(match, side);

  heapSize = 0;
  DIST[start] = 0;
  PREV[start] = -1;
  SEEN[start] = mark;
  heapPush(start, lowerBound(sx, sy, gx, gy));

  let found = false;
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (heapSize > 0) {
    const i = heapPop();
    if (SEEN[i] === mark + 1) continue; // already settled with a shorter walk
    SEEN[i] = mark + 1;
    if (i === goal) {
      found = true;
      break;
    }

    const x = i % CELL_W;
    const y = (i - x) / CELL_W;
    const g = DIST[i];
    for (const [dx, dy] of steps) {
      const ny = y + dy;
      if (ny < 0 || ny >= CELL_H) continue;
      const nx = wrapX(x + dx);
      const ni = ny * CELL_W + nx;
      if (SEEN[ni] === mark + 1) continue;
      const pace = paceAt(nx, ny);
      if (pace < 0) continue;
      if (ni !== goal && held.has(nx + "," + ny)) continue;
      const nd = g + pace;
      if (SEEN[ni] === mark && DIST[ni] <= nd) continue;
      SEEN[ni] = mark;
      DIST[ni] = nd;
      PREV[ni] = i;
      heapPush(ni, nd + lowerBound(nx, ny, gx, gy));
    }
  }

  if (!found || SEEN[goal] !== mark + 1) return null;

  const path = [];
  let walk = goal;
  let safety = 0;
  while (walk !== start) {
    if (SEEN[walk] !== mark && SEEN[walk] !== mark + 1) return null;
    if (walk !== goal && PREV[walk] < 0) return null;
    const px = walk % CELL_W;
    const py = (walk - px) / CELL_W;
    path.push({ x: px, y: py, pace: Math.max(1, paceAt(px, py)) });
    walk = PREV[walk];
    safety += 1;
    if (safety > CELL_W * CELL_H) return null;
  }
  path.reverse();
  return path;
}

// The route an order WOULD take, without touching the match. The page hovers with this, so
// the preview a player sees is the walk the server will actually give them, not a straight
// line drawn by the client. `rounds` is the walk's cost in rounds: every step costs its
// terrain pace, so a slow cell is two rounds.
export function planOrder(match, side, pieceId, toX, toY) {
  if (!match || !Array.isArray(match.pieces)) return { error: "No match is running." };
  if (match.over) return { error: "This match is over." };
  const piece = match.pieces.find((unit) => unit.id === pieceId);
  if (!piece) return { error: "No such piece: " + pieceId + "." };
  if (piece.side !== side) return { error: "That piece belongs to " + piece.side + "." };
  if (isAircraft(piece)) {
    const remaining = inactiveRounds(piece, match.round);
    if (remaining > 0) return { error: `That aircraft is inactive for ${remaining} more rounds.` };
  }

  const x = Number(toX);
  const y = Number(toY);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { error: "An order needs whole cells." };
  if (y < 0 || y >= CELL_H) return { error: "The destination is off the map." };

  // A ship sails the recovered lane graph, never a straight line. The land walker below is
  // deliberately not consulted: it does not know where water is.
  // A preview writes nothing: entrench, repair and pin are cleared by a real order in issueOrder,
  // never by hovering.

  if (piece.domain === "sea") {
    // A ship ends on water. Without this a destroyer could be ordered onto Moscow's cell, and a
    // ship standing on a capital cell used to count as holding it.
    if (!isWater(x, y)) return { error: "A ship cannot end on land." };
    const holder = pieceAt(match, x, y, piece.id);
    if (holder) return { error: "Another piece holds that cell (" + holder.id + ")." };
    let route = null;
    try {
      route = seaRoute(resolveDataRoot() || "", { x: piece.x, y: piece.y }, { x, y });
    } catch {
      route = null;
    }
    if (!route || !route.length) return { error: "No sea lane reaches that cell." };
    const path = route.map((step) => ({ x: step.x, y: step.y, pace: 1 }));
    return { ok: true, path, rounds: path.length };
  }

  if (isRefused(terrainAt(x, y) ?? -1)) return { error: "Wasteland is refused." };

  // An order onto a cell held by the enemy is an attack, and it used to be refused as if it were
  // a collision. Two player-like sides then stood eight cells apart for a thousand rounds: neither
  // could give the order to close, so combat never began. A friend in the cell is still a refusal -
  // two pieces do not share a cell - but an enemy is who you were marching toward.
  const holder = pieceAt(match, x, y, piece.id);
  const attacking = Boolean(holder) && holder.side !== side;
  if (holder && !attacking) return { error: "Another piece holds that cell (" + holder.id + ")." };

  const path = route(match, piece, { x, y }, side);
  if (path === null) return { error: "No route. Wasteland is refused and a held cell is not entered." };
  const rounds = path.reduce((sum, step) => sum + Math.max(1, Number(step.pace) || 1), 0);
  return { ok: true, path, rounds };
}

export function issueOrder(match, side, pieceId, toX, toY) {
  const plan = planOrder(match, side, pieceId, toX, toY);
  if (!plan || plan.error) return plan || { error: "The order was refused." };
  const piece = match.pieces.find((unit) => unit.id === pieceId);
  // A new order ends digging, repairing and pinning (Manual p.22: a move order loses entrench;
  // a pinned unit stands until it is re-ordered). The preview never writes these.
  if (piece.entrenched === true) piece.entrenched = false;
  if (piece.repairing === true) piece.repairing = false;
  if (piece.pinned === true) piece.pinned = false;
  piece.stillRounds = 0;
  piece.fightRounds = 0;
  if (!plan.path.length) {
    piece.path = [];
    piece.pace = 1;
    return { ok: true, path: [], rounds: 0 };
  }
  piece.path = plan.path;
  piece.pace = Math.max(1, Number(plan.path[0].pace) || 1);
  piece.detours = 0;
  return { ok: true, path: plan.path.map((step) => ({ ...step })), rounds: plan.rounds };
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
// --- what a piece is doing -----------------------------------------------------------------
//
// The unit list names five states and the archive only ever printed the words: moving, digging,
// repairing, inactive, idle. Entrenching is infantry only and its bonus was never recovered, so
// it is recorded and shown and applies no number. A move order clears it (docs/POLISH_LOOP.md).

export function pieceState(piece, match) {
  if (!piece) return null;
  if (inactiveRounds(piece, match && match.round) > 0) return "inactive";
  if (Array.isArray(piece.path) && piece.path.length > 0) return "moving";
  if (piece.pinned === true) return "pinned";
  if (piece.repairing === true) return "repairing";
  if (piece.entrenched === true) return "digging";
  return "idle";
}

export const ENTRENCH_NOTE = "Dug in. Incoming hits land at the entrenched factor.";
export const REPAIR_NOTE = "Repairing. The rate is combat.repairPerRound.";

// Dig in. Infantry only, and only while standing still.
export function entrench(match, side, pieceId) {
  if (!match || !Array.isArray(match.pieces)) return { error: "There is no match." };
  if (match.over) return { error: "The match is over." };
  const piece = match.pieces.find((unit) => unit && unit.id === String(pieceId));
  if (!piece) return { error: "No such piece: " + pieceId + "." };
  if (piece.side !== side) return { error: "That piece belongs to " + piece.side + "." };
  if (piece.kind !== "infantry") return { error: "Only infantry can entrench." };
  if (piece.transport === true) return { error: "A transport cannot dig in." };
  if (Array.isArray(piece.path) && piece.path.length > 0) return { error: "That piece is still moving." };
  if (inactiveRounds(piece, match.round) > 0) return { error: "That unit is inactive." };
  piece.entrenched = true;
  piece.repairing = false;
  piece.dugRound = Number(match.round) || 0;
  return {
    ok: true,
    piece,
    state: "digging",
    events: [{ type: "entrench", side, pieceId: piece.id, x: piece.x, y: piece.y, round: Number(match.round) || 0, note: ENTRENCH_NOTE }],
  };
}

// Repair in place, at a friendly city, base or oil field; ships only in a dock (Manual p.23).
// No duration was recovered, so the state holds until the piece is ordered somewhere, while
// `repairStep` puts `combat.repairPerRound` back each round.
export function repair(match, side, pieceId) {
  if (!match || !Array.isArray(match.pieces)) return { error: "There is no match." };
  const piece = match.pieces.find((unit) => unit && unit.id === String(pieceId));
  if (!piece) return { error: "No such piece: " + pieceId + "." };
  if (piece.side !== side) return { error: "That piece belongs to " + piece.side + "." };
  if (Array.isArray(piece.path) && piece.path.length > 0) return { error: "That piece is still moving." };
  const site = (match.sites || []).find((entry) => entry && entry.x === piece.x && entry.y === piece.y);
  const allowed = piece.domain === "sea"
    ? ["dock", "docks"]
    : ["city", "capital", "base", "oilfield"];
  if (!site || !allowed.includes(site.kind)) {
    return { error: "Repair happens at a friendly city or dock (ships only on a dock)." };
  }
  if (site.owner !== side) return { error: `${site.name || "That site"} is not ${side}'s.` };
  piece.repairing = true;
  return {
    ok: true,
    piece,
    state: "repairing",
    events: [{ type: "repair", side, pieceId: piece.id, site: site.id, name: site.name, round: Number(match.round) || 0, note: REPAIR_NOTE }],
  };
}

function siteAtPiece(match, piece) {
  return (match.sites || []).find(
    (site) => site && Number(site.x) === Number(piece.x) && Number(site.y) === Number(piece.y),
  ) || null;
}

// One pass over the site list per round, keyed by cell. repairStep and attritionStep both need
// "what site is this piece standing on", and a per-piece scan of 84 sites is the difference
// between the tick inside its budget and outside it.
// Keyed once per site list, not once per step: attrition and repair both ask for it every round,
// and rebuilding 84 map entries per room per round was 5% of a 1000-room round in the bench.
// Ownership is read off the site object, so a capture needs no invalidation - only a new list does.
const siteCellCache = new WeakMap();

function sitesByCell(match) {
  const list = match.sites;
  if (!list) return new Map();
  const cached = siteCellCache.get(list);
  if (cached) return cached;
  const map = new Map();
  for (const site of list) {
    if (!site) continue;
    map.set(Number(site.y) * CELL_W + Number(site.x), site);
  }
  siteCellCache.set(list, map);
  return map;
}

function siteAtCell(map, piece) {
  return map.get(Number(piece.y) * CELL_W + Number(piece.x)) || null;
}

// One round of repair for every stopped, damaged piece on a friendly repair site. Ships only in a
// dock (p.23); land and air in a city, base or oil field. Never above starting maximum.
export function repairStep(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces)) return events;
  const combat = combatRules();
  const max = combat.maxStrength;
  const rate = combat.repairPerRound;
  if (rate <= 0) return events;
  let byCell = null;
  for (const piece of match.pieces) {
    if (!piece) continue;
    if (piece.kind === "aircraft") continue; // a plane away on a mission is not on the ground
    // Nothing to do for a piece already at full strength: this is the common case in a bench
    // room and in a quiet match, so the site table is not even built for it.
    if (ensureStrength(piece, max) >= max) {
      if (piece.repairing === true) piece.repairing = false;
      continue;
    }
    const moving = Array.isArray(piece.path) && piece.path.length > 0;
    if (!byCell) byCell = sitesByCell(match);
    const site = siteAtCell(byCell, piece);
    const kinds = piece.domain === "sea" ? ["dock", "docks"] : ["city", "capital", "base", "oilfield"];
    const friendly = Boolean(site) && site.owner === piece.side && kinds.includes(site.kind);
    if (!friendly || moving) {
      if (piece.repairing === true && !friendly) piece.repairing = false;
      continue;
    }
    const before = Number(piece.strength);
    piece.strength = Math.min(max, before + rate);
    piece.repairing = true;
    events.push({
      type: "repair_tick",
      side: piece.side,
      pieceId: piece.id,
      site: site.id ?? null,
      name: site.name || null,
      amount: Number((piece.strength - before).toFixed(2)),
      strength: piece.strength,
      round: Number(match.round) || 0,
    });
  }
  return events;
}

// Attrition per round (Manual p.21). A natural attrition terrain drains every unit on it; a site
// drains only the units that do not own it. The floor is the rule's own 20% of maximum, except
// wasteland, which can take a unit to zero. `lookup` is a seam for a test with no board extract.
export function attritionStep(match, lookup = null) {
  const events = [];
  if (!match || !Array.isArray(match.pieces)) return events;
  const combat = combatRules();
  const max = combat.maxStrength;
  const doomed = new Set();
  let byCell = null;
  const grid = lookup ? null : cells();

  for (const piece of match.pieces) {
    if (!piece || piece.kind === "aircraft") continue;
    let name;
    if (lookup) {
      name = lookup(piece, match);
    } else if (grid) {
      const id = grid[Number(piece.y) * CELL_W + Number(piece.x)];
      name = id === undefined || id === null ? null : TERRAIN[Number(id)] || null;
    } else {
      name = null;
    }
    if (!name) continue;
    const rate = Number(combat.attritionPerRound[name] || 0);
    if (rate <= 0) continue;
    const isSite = ["city", "base", "dock", "docks", "oilfield", "capital"].includes(name);
    if (isSite) {
      if (!byCell) byCell = sitesByCell(match);
      const site = siteAtCell(byCell, piece);
      if (!site || site.owner === piece.side) continue;
    }
    const floor = name === "wasteland" ? 0 : combat.attritionFloor * max;
    const before = ensureStrength(piece, max);
    const after = Math.max(floor, before - rate);
    if (after >= before) continue;
    piece.strength = after;
    events.push({
      type: "attrition",
      side: piece.side,
      pieceId: piece.id,
      terrain: name,
      amount: Number((before - after).toFixed(2)),
      strength: after,
      round: Number(match.round) || 0,
    });
    if (after <= 0) doomed.add(piece.id);
  }

  if (doomed.size > 0) {
    for (const piece of match.pieces) {
      if (!doomed.has(piece.id)) continue;
      events.push({ type: "destroyed", side: piece.side, pieceId: piece.id, by: "attrition", x: piece.x, y: piece.y, strength: 0, note: "Attrition." });
    }
    match.pieces = match.pieces.filter((piece) => !doomed.has(piece.id));
  }
  return events;
}

export function advance(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces) || match.over) return events;
  // A piece whose next cell is held used to drop its whole path and stand still, which is what
  // made an army in contact go stiff: 13,075 refusals in a 400-round bot match. It now looks for
  // a way round once a round, within a budget, and only stands still when there is no way round.
  let detours = 0;
  const DETOUR_BUDGET = 48;
  const doomed = new Set(); // pieces a round of overrun removed; filtered once, after the walk
  // A dry blocking resource stops that side's pieces; a non-blocking one (steel, which is not in
  // the original) never does. The answer is per side and does not change inside one round.
  const blocked = {};
  const isBlocked = (side) => {
    if (!(side in blocked)) {
      try {
        blocked[side] = movementBlocked(match, side);
      } catch {
        blocked[side] = null;
      }
    }
    return Boolean(blocked[side]);
  };
  for (const piece of match.pieces) {
    if (!Array.isArray(piece.path) || piece.path.length === 0) continue;
    if (isBlocked(piece.side)) continue;
    // An aircraft on a mission is not on the ground to be moved.
    if (inactiveRounds(piece, match.round) > 0) continue;
    // Pinned (p.22): a heavily engaged land unit stands until it is re-ordered, and issueOrder
    // is what clears the flag.
    if (piece.pinned === true) continue;
    // A ship's path comes from the lane graph (lanes.seaRoute), stepped one waypoint at a time;
    // a land piece's comes from a walk. The stepping below is the same either way, so neither
    // domain may be skipped here - skipping sea is what left every routed ship standing still.

    const next = piece.path[0];
    const nx = wrapX(next.x);
    const ny = Number(next.y);
    const occupant = pieceAt(match, nx, ny, piece.id);
    if (occupant) {
      // Overrun is the tank's (Manual p.9): a tank ordered into infantry fights through it,
      // taking losses, and carries on into the cell if the infantry is destroyed. The path is
      // never dropped here; a tank that is held keeps its order and tries again next round.
      const overrun =
        occupant.side !== piece.side &&
        piece.kind === "tank" &&
        piece.domain === "land" &&
        occupant.domain === "land" &&
        occupant.kind === "infantry" &&
        occupant.transport !== true;
      if (overrun) {
        const combat = combatRules();
        const foot = applyDamage(occupant, Number(combat.baseDamage.tank ?? 0));
        const hull = applyDamage(piece, Number(combat.baseDamage.infantry ?? 0));
        events.push({
          type: "overrun",
          side: piece.side,
          pieceId: piece.id,
          by: occupant.id,
          target: occupant.id,
          x: nx,
          y: ny,
          tankLoss: hull.dealt,
          infantryStrength: foot.after,
          tankStrength: hull.after,
          round: Number(match.round) || 0,
        });
        if (foot.dead) {
          doomed.add(occupant.id);
          events.push({ type: "destroyed", side: occupant.side, pieceId: occupant.id, by: piece.id, x: nx, y: ny, strength: 0, round: Number(match.round) || 0, note: "Overrun." });
          // fall through: the cell is free this round and the tank steps into it
        } else if (hull.dead) {
          doomed.add(piece.id);
          events.push({ type: "destroyed", side: piece.side, pieceId: piece.id, by: occupant.id, x: piece.x, y: piece.y, strength: 0, round: Number(match.round) || 0, note: "Overrun. The tank was lost." });
          continue;
        } else {
          events.push({ type: "overrun_hold", pieceId: piece.id, by: occupant.id, x: nx, y: ny });
          continue;
        }
      } else {
        // Stop one short: the walker never shares a cell, and the clash is combat's job. Going
        // round costs a route, so a piece gets a few tries per order and the round gets a budget.
        // An enemy in the way is contact, not an obstacle: the path stops and combat decides.
        const goal = occupant.side === piece.side ? piece.path[piece.path.length - 1] : null;
        const tries = Number(piece.detours) || 0;
        if (goal && tries < 4 && detours < DETOUR_BUDGET) {
          const around = route(match, { x: piece.x, y: piece.y }, goal, piece.side);
          if (around && around.length) {
            piece.path = around;
            piece.pace = Math.max(1, Number(around[0].pace) || 1);
            piece.detours = tries + 1;
            detours += 1;
            events.push({ type: "detour", pieceId: piece.id, by: occupant.id, x: nx, y: ny, rounds: around.length });
            continue;
          }
        }
        piece.path = [];
        piece.pace = 1;
        piece.detours = 0;
        events.push({ type: "blocked", pieceId: piece.id, by: occupant.id, x: nx, y: ny });
        continue;
      }
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
    // Combat needs to know who advanced into contact: the mover attacks, the piece that has
    // been sitting still defends. Nothing else reads this.
    piece.movedRound = Number(match.round) || 0;
    const changed = syncTransport(piece, nx, ny);
    events.push({ type: "move", pieceId: piece.id, x: nx, y: ny, transport: piece.transport });
    if (changed) {
      events.push({
        type: piece.transport ? "embarked" : "landed",
        pieceId: piece.id,
        side: piece.side,
        x: nx,
        y: ny,
      });
    }
  }
  if (doomed.size > 0) {
    match.pieces = match.pieces.filter((piece) => !doomed.has(piece.id));
    for (const piece of match.pieces) {
      if (piece.fighting && doomed.has(piece.fighting)) {
        piece.fighting = null;
        piece.fightRounds = 0;
      }
    }
  }
  return events;
}
