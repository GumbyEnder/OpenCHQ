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
import { landPace, isRefused, combatRules, cellsPerRound } from "./rules.mjs";
import { seaRoute, waterStepRoute } from "./lanes.mjs";
import { inactiveRounds, isAircraft } from "./air.mjs";
import { movementBlocked } from "./resources.mjs";
import { applyDamage, damageFor, ensureStrength } from "./combat.mjs";

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

// A LAND piece in the water is a transport, and a transport is cargo: it cannot fight back.
// The state follows the cell, so there is nothing to keep in sync by hand.
//
// The domain guard is not cosmetic. A cruiser or submarine is on water by definition, so an
// unguarded `transport = inWater` stamped cargo onto every hull: rules.cellsPerRound reads
// transport before domain and sailed a cruiser at the transport rate (2 instead of 3), and
// combat/air/escort read the same flag, so a cruiser was a target that could not shoot back
// (frodo's gate on 2d7326e). Only a sea piece can be cargo-free on water.
function syncTransport(piece, x, y) {
  const inWater = isWater(x, y);
  const cargo = inWater && piece.domain !== "sea";
  const had = piece.transport === true;
  piece.transport = cargo;
  return had !== cargo;
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

// --- the straight-line walker (RULES.md section 2, FUN_16ee_0728) ----------------------------
//
// The original does not pathfind. A move is a Bresenham line, and the walk is accepted or refused
// by a class test over the cells the line crosses. X wraps the short way round the cylinder
// (FUN_188b_01da), so a 305-cell westward order is walked as a 15-cell eastward one. There is no
// search here and there must not be: a route that bends around terrain is a different game.
//
// The path-cost bytes are the archive's own DS:0x011C table (RULES.md section 1). They are recovered
// facts, not tunables: desert 3, jungle 9, polar 13, wasteland 77, every other id 0. A class-3/4
// walk fails once the sum reaches 100.
export const WALK_COST_LIMIT = 100;
export const PATH_COST = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 9, 13, 77]);

// The class table, as the binary applies it:
//   0    ocean, docks and the second ocean only (ids 0-2)
//   1    ocean and docks only (ids 0-1)
//   2    the opposite: water ids 0-2 fail, every land id passes
//   3,4  wasteland (14) fails, the cost bytes add up, and a sum of 100 fails the route
//   5+   the same cost sum, but wasteland does not hard-fail
export function walkClassAllows(classByte, terrainId) {
  const cls = Number(classByte);
  const id = terrainId === null || terrainId === undefined ? 8 : Number(terrainId);
  if (!Number.isFinite(cls)) return true;
  if (cls === 0) return id <= 2;
  if (cls === 1) return id <= 1;
  if (cls === 2) return id >= 3;
  if (cls === 3 || cls === 4) return id !== 14;
  return true;
}

// The cell sequence of a straight line, start included, on the cylinder. Integer Bresenham: one
// cell per step and the short way in X. The loop is bounded by the longer axis, so a bad
// coordinate cannot spin here.
export function bresenham(from, to) {
  const sx0 = wrapX(from.x);
  const sy0 = Math.trunc(Number(from.y));
  const gx = wrapX(to.x);
  const gy = Math.trunc(Number(to.y));
  const dx = wrapDelta(sx0, gx);
  const adx = Math.abs(dx);
  const stepX = adx === 0 ? 0 : dx > 0 ? 1 : -1;
  const dy = gy - sy0;
  const ady = Math.abs(dy);
  const stepY = ady === 0 ? 0 : dy > 0 ? 1 : -1;
  const cells = [{ x: sx0, y: sy0 }];
  let x = sx0;
  let y = sy0;
  let err = adx - ady;
  const limit = Math.max(adx, ady) + 2;
  for (let i = 0; i < limit && (x !== gx || y !== gy); i++) {
    const e2 = 2 * err;
    if (e2 > -ady) {
      err -= ady;
      x = wrapX(x + stepX);
    }
    if (e2 < adx) {
      err += adx;
      y += stepY;
    }
    cells.push({ x, y });
  }
  return cells;
}

// One order's line, tested against a walker class. Returns the cells (start..end), the accumulated
// path cost, and the reason a refusal happened. Start equals end is the walker's immediate return
// of 1: one cell, no test, no cost.
//
// `lookup` lets a test walk a synthetic grid; the server passes the board's own terrain.
export function walkLine(from, to, classByte, lookup = null) {
  const cells = bresenham(from, to);
  const cls = Number(classByte);
  // The binary's return is a step count, and a walk that starts where it ends returns 1 (RULES §2).
  const moves = (count) => (count <= 1 ? 1 : count - 1);
  if (cells.length <= 1) return { ok: true, cells, steps: 1, cost: 0, fail: null };
  let cost = 0;
  for (let i = 1; i < cells.length; i++) {
    const cell = cells[i];
    const raw = lookup ? lookup(cell.x, cell.y) : terrainAt(cell.x, cell.y);
    const terrain = raw === null || raw === undefined ? 8 : Number(raw);
    if (!walkClassAllows(cls, terrain)) {
      return { ok: false, cells: cells.slice(0, i + 1), steps: moves(i), cost, fail: "terrain" };
    }
    if (cls >= 3) {
      cost += PATH_COST[terrain] || 0;
      if (cost >= WALK_COST_LIMIT) {
        return { ok: false, cells: cells.slice(0, i + 1), steps: moves(i), cost, fail: "cost" };
      }
    }
  }
  return { ok: true, cells, steps: moves(cells.length), cost, fail: null };
}

// A sea leg between two water cells on an order's line. A short hop is the straight water line -
// stepping one cell offshore is beaching, not a voyage, and sending a unit to a lane waypoint
// thirty cells away would be a teleport. A real crossing follows the lane graph (Manual p.21-22).
const SHORT_HOP_CELLS = 3;

function seaLeg(from, to, waterCells) {
  if (waterCells.length <= SHORT_HOP_CELLS) {
    // The hop's cells as the straight line gave them, but walked through water: the line between
    // two docks can pass over the port city, and a hull does not stand on land on its way in.
    let hop = null;
    try {
      hop = waterStepRoute(resolveDataRoot() || "", from, to);
    } catch {
      hop = null;
    }
    if (!hop || hop.length < 1) return null;
    return hop.map((cell) => ({ x: cell.x, y: cell.y, pace: 1 }));
  }
  let route = null;
  try {
    route = seaRoute(resolveDataRoot() || "", from, to);
  } catch {
    route = null;
  }
  if (!route || route.length < 2) return null;
  return route.map((cell) => ({ x: cell.x, y: cell.y, pace: 1 }));
}

function landStep(cell) {
  return { x: cell.x, y: cell.y, pace: Math.max(1, paceAt(cell.x, cell.y)) };
}

// A land order's path: the straight line, and where the line crosses water, a land leg, a sea leg
// on the lanes, then the land leg on the far shore (Manual p.21).
function planLandPath(piece, toX, toY) {
  const from = { x: piece.x, y: piece.y };
  if (wrapX(from.x) === wrapX(toX) && Number(from.y) === Number(toY)) return { path: [] };
  const walk = walkLine(from, { x: toX, y: toY }, 3);
  if (!walk.ok) {
    return {
      error: walk.fail === "cost"
        ? "No route: the ground on that line costs more than a march (Manual p.21, path cost 100)."
        : "No route: wasteland is refused (Manual p.21).",
    };
  }
  const cells = walk.cells;
  let first = -1;
  let last = -1;
  for (let i = 1; i < cells.length; i++) {
    if (!isWater(cells[i].x, cells[i].y)) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return { path: cells.slice(1).map(landStep) };

  const sea = seaLeg(cells[first], cells[last], cells.slice(first, last + 1));
  if (!sea) return { error: "No sea lane reaches that crossing." };
  return {
    path: [
      ...cells.slice(1, first).map(landStep),
      ...sea,
      ...cells.slice(last + 1).map(landStep),
    ],
  };
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

  // A land order is a straight line (Manual p.21; RULES.md section 2). Where that line crosses
  // water, the walk becomes a crossing: land leg, sea leg on the lanes, land leg.
  const planned = planLandPath(piece, x, y);
  if (planned.error) return { error: planned.error };
  const path = planned.path;
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
  piece.credit = 0;
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
    // The original repairs only a piece that is not in contact: in the measured duel the dug-in
    // garrison on Paris went 100 -> 87 -> 74 -> 61 -> 48 -> 35 with no repair between passes, and
    // only began to repair (+10 a pass) once the attacking tank was dead (T-015,
    // local/t015/duel-original.txt). Repairing under fire made the defender's bar rise between
    // the beats of the same fight.
    const fighting = piece.fighting !== null && piece.fighting !== undefined;
    if (!byCell) byCell = sitesByCell(match);
    const site = siteAtCell(byCell, piece);
    const kinds = piece.domain === "sea" ? ["dock", "docks"] : ["city", "capital", "base", "oilfield"];
    const friendly = Boolean(site) && site.owner === piece.side && kinds.includes(site.kind);
    if (!friendly || moving || fighting) {
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

    // Cells per round (T-004; Manual p.9, p.21). The credit is the walking a piece has in hand:
    // an infantry gains 1 a round, a tank 2, a hull 3. Slow ground still costs a beat, so a
    // pace-2 cell takes two rounds of an infantry's credit and one round of a tank's.
    //
    // The walking is a straight line, so there is no way round anything: the walker stops one
    // cell short of a held cell and the clash belongs to combat (or to the tank's overrun, p.9).
    const rate = cellsPerRound(piece);
    let credit = (Number(piece.credit) || 0) + rate;
    let spent = 0;
    let stopped = false;
    while (piece.path.length > 0 && spent < rate) {
      const next = piece.path[0];
      const nx = wrapX(next.x);
      const ny = Number(next.y);
      const pace = Math.max(1, Number(next.pace) || 1);
      if (credit < pace) break;
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
        if (!overrun) {
          // Stop one short: the walker never shares a cell, and the clash is combat's job.
          piece.path = [];
          piece.pace = 1;
          piece.detours = 0;
          piece.overrunBy = null;
          piece.overrunCell = null;
          events.push({ type: "blocked", pieceId: piece.id, by: occupant.id, x: nx, y: ny });
          stopped = true;
          break;
        }
        const onRound = Number(match.round) || 0;
        // Overrun is a MOVEMENT result (Manual p.9) but its damage is an exchange like any other:
        // one matrix cell, the defender's entrenchment and the defender's terrain cover, all from
        // damageFor (FUN_194c_000e). It is applied ONCE and the round's front beat is consumed
        // (match.foughtRound), so combat.resolve does not fire the same pair again in this round -
        // that double exchange is what let a lone tank kill a dug-in garrison on Paris
        // (T-015, local/t015/duel-remake.txt).
        const combat = combatRules();
        const max = combat.maxStrength;
        if (match.foughtRound !== onRound) {
          const foot = damageFor(piece, occupant, combat);
          const hull = damageFor(occupant, piece, combat);
          piece.fighting = occupant.id;
          occupant.fighting = piece.id;
          piece.fightRounds = Number(piece.fightRounds || 0) + 1;
          occupant.fightRounds = Number(occupant.fightRounds || 0) + 1;
          match.foughtRound = onRound;
          const footHit = applyDamage(occupant, foot.amount, max);
          const hullHit = applyDamage(piece, hull.amount, max);
          events.push({
            type: "shot", side: piece.side, pieceId: piece.id, target: occupant.id,
            base: foot.base, amount: foot.amount, covered: foot.covered, entrenched: foot.entrenched,
            flank: foot.flank, rear: foot.rear, after: footHit.after, round: onRound, overrun: true,
          });
          events.push({
            type: "shot", side: occupant.side, pieceId: occupant.id, target: piece.id,
            base: hull.base, amount: hull.amount, covered: hull.covered, entrenched: hull.entrenched,
            flank: hull.flank, rear: hull.rear, after: hullHit.after, round: onRound, overrun: true,
          });
          if (footHit.dead) {
            doomed.add(occupant.id);
            events.push({
              type: "destroyed", side: occupant.side, pieceId: occupant.id, by: piece.id,
              x: nx, y: ny, strength: 0, round: onRound, note: "Overrun.",
            });
            // The cell is free; the tank walks into it and keeps its order.
            events.push({
              type: "overrun", side: piece.side, pieceId: piece.id, by: occupant.id,
              target: occupant.id, x: nx, y: ny, round: onRound,
              tankLoss: hull.amount, infantryStrength: footHit.after, tankStrength: hullHit.after,
              note: "Overrun.",
            });
          } else if (hullHit.dead) {
            doomed.add(piece.id);
            events.push({
              type: "destroyed", side: piece.side, pieceId: piece.id, by: occupant.id,
              x: piece.x, y: piece.y, strength: 0, round: onRound,
              note: "Overrun. The tank was lost.",
            });
            piece.path = [];
            stopped = true;
            break;
          } else {
            piece.overrunBy = occupant.id;
            piece.overrunCell = { x: nx, y: ny };
            events.push({ type: "overrun_hold", pieceId: piece.id, by: occupant.id, x: nx, y: ny, round: onRound });
            stopped = true;
            break;
          }
        } else {
          piece.overrunBy = occupant.id;
          piece.overrunCell = { x: nx, y: ny };
          events.push({ type: "overrun_hold", pieceId: piece.id, by: occupant.id, x: nx, y: ny, round: onRound });
          stopped = true;
          break;
        }
      }

      const fromX = piece.x;
      const fromY = piece.y;
      // The tank that was held out of this cell walks into it now that combat has cleared it:
      // that arrival is the overrun the log and the player see.
      if (piece.overrunCell && wrapX(piece.overrunCell.x) === nx && Number(piece.overrunCell.y) === ny) {
        events.push({
          type: "overrun",
          side: piece.side,
          pieceId: piece.id,
          by: piece.overrunBy,
          target: piece.overrunBy,
          x: nx,
          y: ny,
          round: Number(match.round) || 0,
          note: "Overrun.",
        });
        piece.overrunBy = null;
        piece.overrunCell = null;
      }
      piece.facing = facingFor(fromX, fromY, nx, ny);
      piece.x = nx;
      piece.y = ny;
      piece.path.shift();
      credit -= pace;
      spent += 1;
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
    piece.credit = stopped ? 0 : Math.max(0, credit);
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
