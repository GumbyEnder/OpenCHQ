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
import { landPace, isRefused, combatRules, cellsPerRound, pathCostFor, walkCostLimit, digInIds } from "./rules.mjs";
import { seaRoute, waterStepRoute } from "./lanes.mjs";
import { inactiveRounds, isAircraft } from "./air.mjs";
import { movementBlocked, oilCostPerCell, oilMeterFor, syncOilSeat } from "./resources.mjs";
import { applyDamage, damageFor, ensureStrength, distance, rangeOf } from "./combat.mjs";

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

// PB-097b: a land ATTACK order completes as ENGAGE once the walker is inside its own engage range.
// The measured threshold is a SQUARED distance - config/game.json:349 pins landEngageCells = 2 with
// the trace note "dist^2 <= 5" - so the test is dx^2 + dy^2 <= 5, NOT combat.mjs's Chebyshev
// `distance()` (max(|dx|,|dy|) <= 2, which admits a (2,2) offset at dist^2 = 8). frodo room 8626
// §4a: do not express the completion rule through distance() unless that function is itself pinned
// to the spec; it is not.
const ENGAGE_DIST2 = 5;

export function squaredDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = wrapDelta(a.x, b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

// Land reads the measured squared threshold; sea keeps its kind's Chebyshev range (p.22, p.24);
// anything with no reach (air, a transport's cargo) is never in range.
export function inEngageRange(piece, foe, reach) {
  const r = reach === undefined ? rangeOf(piece) : reach;
  if (!piece || !foe || !(r > 0)) return false;
  if (piece.domain === "sea") return distance(piece, foe) <= r;
  return squaredDistance(piece, foe) <= ENGAGE_DIST2;
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

// A piece standing on a cell, on the GROUND layer only. An aircraft based in a city does not hold
// its ground (manual p.22/p.24: the air layer is separate, T-021), so a walker may enter a city a
// friendly plane is based in and a hull may sail under one.
function pieceAt(match, x, y, skipId = null) {
  const wx = wrapX(x);
  for (const unit of match.pieces || []) {
    if (skipId !== null && unit.id === skipId) continue;
    if (isAircraft(unit)) continue;
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
    if (isAircraft(unit)) continue; // a based plane holds air, not the cell under it (T-021)
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
// The bytes and the limit are config.terrain.pathCost (T-016); this module holds no copy of them.

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
      cost += pathCostFor(terrain);
      if (cost >= walkCostLimit()) {
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

// The round an order lands on, computed the way the walk spends its credit (PB-096).
//
// `rounds` used to be a sum of the path's paces, with no cell rate in it at all, and the sea arm
// was `path.length`. Both were wrong in opposite directions: a tank walks 2 cells a round, so its
// quote was double the walk, and a hull walks 3, so every ship quote was three times too long. An
// infantry crossing water is worse than either — it walks 1 on land and 2 as cargo, so no single
// divisor exists for the path.
//
// So run the same loop advance() runs, per step, at the rate in force on that step: rate cells of
// walking are granted a round, a step costs its terrain pace, and unspent credit carries. That is
// the only arithmetic that answers "when does it get there" — 26 quoted for a 22-round walk was
// this bug, not a rounding difference.
export function walkRounds(piece, path) {
  if (!Array.isArray(path) || path.length === 0) return 0;
  const kind = piece && piece.kind;
  const domain = piece && piece.domain;
  // A sea piece is never cargo (rules.cellsPerRound reads transport first, so a hull stamped as
  // cargo would sail at the transport rate — the bug the syncTransport guard exists to prevent).
  let transport = domain === "sea" ? false : Boolean(piece && piece.transport === true);
  let credit = 0;
  let rounds = 0;
  let i = 0;
  while (i < path.length) {
    const rate = cellsPerRound({ kind, domain, transport });
    credit += rate;
    rounds += 1;
    let spent = 0;
    while (i < path.length && spent < rate) {
      const pace = Math.max(1, Number(path[i].pace) || 1);
      if (credit < pace) break;
      credit -= pace;
      spent += 1;
      // The state follows the cell: entering water turns a land piece into cargo, and the NEXT
      // round's rate is the transport's.
      transport = domain !== "sea" && isWater(path[i].x, path[i].y);
      i += 1;
    }
  }
  return rounds;
}

// PB-113: an order stops where it arrives. A sea route walks legs between lane waypoints and the
// destination is appended as the LAST anchor, so a leg toward an intermediate waypoint can cross
// the destination cell first and then sail on for tens of cells before coming back to it (the
// destroyer 58,66 -> 61,66 case planned 82 cells and quoted 28 rounds for a 3-cell order). A land
// order whose line crosses water has the same shape through its sea hop. Cutting at the first cell
// that is the destination keeps the arrival honest for every path shape, and because the quote is
// computed from the path it is cut to, the printed rounds still equal the round the unit arrives.
function stopAtDestination(path, to) {
  if (!Array.isArray(path) || path.length < 3) return path;
  const at = path.findIndex((step) => wrapX(step.x) === wrapX(to.x) && step.y === Number(to.y));
  if (at < 0 || at === path.length - 1) return path;
  return path.slice(0, at + 1);
}

// The route an order WOULD take, without touching the match. The page hovers with this, so
// the preview a player sees is the walk the server will actually give them, not a straight
// line drawn by the client. `rounds` is the round the order lands on, from walkRounds().
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

  // PB-191: an order whose destination is the cell the piece already stands on is not an order.
  // walkLine returns path [] for from == to, so this used to come back ACKED as "Order sent. That
  // piece is already on that cell." AFTER issueOrder had already cleared entrench, repair, pin and
  // the still/fight counters - a click that spent no round still cost the player state, and at the
  // fit a two-pixel miss on a piece's own cell was enough to reach it. Refused here, before any
  // write, so the page's own guard has a server-side twin that cannot drift. The wrap is the seam's:
  // 319 and 0 are the same column.
  if (wrapX(piece.x) === wrapX(x) && Number(piece.y) === y) {
    return { error: "That piece is already on that cell." };
  }

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

    // A short hop is the straight water line, exactly as a land order's sea leg treats one
    // (seaLeg's SHORT_HOP_CELLS above): stepping a few cells offshore is not a voyage, and the
    // lane graph answers it by walking the hull to the nearest waypoint and back out again. That
    // is PB-117's defect - a one-cell order quoted 28 rounds and sailed 84 cells - and it is not
    // PB-113: 59,66 is never on that path. Longer crossings still follow the lanes (Manual p.21-22).
    //
    // PB-133: the direct water walk is built for EVERY hop, not only a short one, and the bound is
    // the straight-line span plus PB-117's slack - a walk within SHORT_HOP_CELLS of the straight
    // line is a hop, anything longer is a voyage (PM 7001 item 3, "SPAN BOUND, not a bigger
    // constant"). The lane plan is built for every hop too, because a walk over the bound still
    // needs a voyage plan to fall back to, and because a lane plan that is genuinely shorter than
    // the walk must win (a lane route can pass through the destination early; stopAtDestination
    // cuts it there). Where the straight line is land the water walk detours, so a real headland
    // lands over the bound and the lane plan is the only plan - the AC2 control.
    const span = Math.max(Math.abs(wrapDelta(piece.x, x)), Math.abs(Number(y) - Number(piece.y)));
    const build = (fn) => {
      try {
        const cells = fn();
        return Array.isArray(cells) && cells.length ? cells : null;
      } catch {
        // a route builder that cannot walk this water contributes no plan
        return null;
      }
    };
    // Neither route builder hands back steps; both start with the cell the hull already stands on.
    // Keeping it costs the hull a credit on its own cell - a 3-step hop then costs 4 spent moves and
    // quotes 2 rounds instead of 1 - so the origin is dropped exactly as the land path drops it
    // (planLandPath returns cells.slice(1)). The remaining list is cells to walk INTO.
    const trimOrigin = (cells) => {
      if (!cells) return null;
      const out = wrapX(cells[0].x) === wrapX(piece.x) && Number(cells[0].y) === Number(piece.y)
        ? cells.slice(1) : cells;
      return out.length ? out : null;
    };
    const walk = trimOrigin(build(() => waterStepRoute(resolveDataRoot() || "", { x: piece.x, y: piece.y }, { x, y })));
    const lane = trimOrigin(build(() => seaRoute(resolveDataRoot() || "", { x: piece.x, y: piece.y }, { x, y })));
    if (!walk && !lane) return { error: "No sea lane reaches that cell." };
    const cost = (cells) => walkRounds(piece, cells);
    const withinBound = Boolean(walk) && walk.length <= span + SHORT_HOP_CELLS;
    let route;
    if (withinBound && (!lane || cost(walk) <= cost(lane))) route = walk;
    else route = lane || walk;
    const path = stopAtDestination(route.map((step) => ({ x: step.x, y: step.y, pace: 1 })), { x, y });
    return { ok: true, path, rounds: walkRounds(piece, path) };
  }

  if (isRefused(terrainAt(x, y) ?? -1)) return { error: "Wasteland is refused." };

  // An order onto a cell held by the enemy is an attack, and it used to be refused as if it were
  // a collision. Two player-like sides then stood eight cells apart for a thousand rounds: neither
  // could give the order to close, so combat never began. A friend in the cell is still a refusal -
  // two pieces do not share a cell - but an enemy is who you were marching toward.
  //
  // PM 6416: this plan-time refusal stays AS IS until Q-new is answered. PB-097's fix is in
  // advance(), not here: an order already accepted keeps its stored path and retries; nothing
  // re-plans through planOrder on a retry.
  const holder = pieceAt(match, x, y, piece.id);
  const attacking = Boolean(holder) && holder.side !== side;
  if (holder && !attacking) return { error: "Another piece holds that cell (" + holder.id + ")." };

  // A land order is a straight line (Manual p.21; RULES.md section 2). Where that line crosses
  // water, the walk becomes a crossing: land leg, sea leg on the lanes, land leg.
  const planned = planLandPath(piece, x, y);
  if (planned.error) return { error: planned.error };
  const path = stopAtDestination(planned.path, { x, y });
  const rounds = walkRounds(piece, path);
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
  piece.heldBy = null;
  piece.heldCell = null;
  piece.holdRounds = 0;
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
  // T-016: the original's bit 0x20 terrains only (config terrain.digIn). A unit cannot dig in on a
  // city, base, capital, lake, polar or wasteland cell; tickEntrench applies the same list.
  const ground = terrainAt(piece.x, piece.y);
  if (ground !== null && ground !== undefined && !digInIds().has(Number(ground))) {
    return { error: "That ground cannot be dug in." };
  }
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
    if (isAircraft(piece)) continue; // a plane away on a mission is not on the ground
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
    if (!piece || isAircraft(piece)) continue;
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

// PB-097b: the completion itself, shared by the two places an attack order can finish as ENGAGE -
// a hostile blocker on the next cell, and an in-range enemy holding the ordered destination. The
// order is done: the path is cleared so nothing re-attempts a step, the target is recorded the way
// p.22 records one ("keeps that target until it dies, moves off, or a closer enemy arrives"), the
// hold credit is zeroed and one event speaks. Before this the path was KEPT and the step was
// re-attempted every round: the unit parked one cell short for the rest of the match, died at
// range, and the order never completed (PB-195's trace, the park-and-retry loop).
function completeAsEngage(piece, foe, x, y, events, match, reach) {
  piece.overrunBy = null;
  piece.overrunCell = null;
  piece.path = [];
  piece.fighting = foe.id;
  piece.holdRounds = 0;
  piece.credit = 0;
  events.push({
    type: "engage",
    side: piece.side,
    pieceId: piece.id,
    by: foe.id,
    target: foe.id,
    x: piece.x,
    y: piece.y,
    targetX: Number(wrapX(x)),
    targetY: Number(y),
    reach,
    round: Number(match.round) || 0,
    note: "Engaged.",
  });
}

// A hold is one fact, not one per round. The piece remembers who is holding it out and where; the
// same blocker at the same cell on the next round is the same hold and stays silent (PB-121). A new
// order or a real step clears the memory, so a second hold speaks again.
function noteHold(piece, occupant, x, y, events) {
  const cell = wrapX(x) + "," + Number(y);
  if (piece.heldBy === occupant.id && piece.heldCell === cell) return;
  piece.heldBy = occupant.id;
  piece.heldCell = cell;
  events.push({ type: "blocked", side: piece.side, pieceId: piece.id, by: occupant.id, x, y, retry: true });
}

// PB-122: a friendly cell may be CROSSED but never finished on (Manual p.9-10, R-UNT-06). A step
// into a friend is legal only when the same round carries the walker off that cell again; otherwise
// the walker would end the round co-located with the friend for good (the held destination freezes
// it there). Predict the rest of this round from the credit left after the step, and refuse the
// entry when the walk cannot leave.
function canStepInto(piece, match, path, credit, seen = new Set([piece.id])) {
  if (!Array.isArray(path) || path.length === 0) return false;
  const next = path[0];
  const pace = Math.max(1, Number(next.pace) || 1);
  if (credit < pace) return false;
  const occupant = pieceAt(match, wrapX(next.x), Number(next.y), piece.id);
  if (!occupant) return true;
  if (occupant.side !== piece.side) return false; // an enemy stops the walk; a tank may overrun, but that outcome is not a pass-through
  if (occupant.side === piece.side) {
    // Another friend on the next cell: only a walk that can leave BOTH this round is a crossing.
    if (path.length === 1) return false;
    return canStepInto(piece, match, path.slice(1), credit - pace, seen);
  }
  return false;
}

// PB-197 (PB-197 deadlock at 78,45 / 77,45): a friend that will LEAVE its cell during this same
// round is not a wall. Two adjacent walkers whose paths cross (A west through B's cell, B east
// through A's) both failed PB-122's per-round test, because neither could get off the friend's
// cell inside the round, so neither took the first step and both reported "moving" forever. The
// step is safe when the friend vacates: the round ends with each on the other's start cell.
// The prediction follows only the friend's immediate step, bounded, and treats the mutual swap
// (each walking into the other's cell) as vacating. A friend already walked this round, or one
// held by a third piece or by an enemy, is not predicted to move: its credit has been settled and
// its chance to step has passed (`walked` carries the ids advance() has already processed).
function willVacate(match, unit, seen, walked) {
  if (!unit || unit.pinned === true) return false;
  if (walked && walked.has(unit.id)) return false;
  if (!Array.isArray(unit.path) || unit.path.length === 0) return false;
  if (inactiveRounds(unit, match.round) > 0) return false;
  const next = unit.path[0];
  const pace = Math.max(1, Number(next.pace) || 1);
  if ((Number(unit.credit) || 0) + cellsPerRound(unit) < pace) return false;
  const nx = wrapX(next.x);
  const ny = Number(next.y);
  if (nx === wrapX(unit.x) && ny === Number(unit.y)) return false; // an order never ends where it starts
  const occupant = pieceAt(match, nx, ny, unit.id);
  if (!occupant) return true;
  if (occupant.side !== unit.side) return false; // contact, not a crossing
  if (seen.has(occupant.id)) return true; // the swap: each is leaving for the other's cell
  if (seen.size >= 4) return false; // a long chain is not worth predicting; the round will show it
  const nextSeen = new Set(seen);
  nextSeen.add(unit.id);
  return willVacate(match, occupant, nextSeen, walked);
}

// PB-197: a walker held out of a cell round after round is not making progress. This is the number
// of consecutive blocked rounds after which the BOT re-plans that unit onto a fresh goal (bot.mjs).
// The movement layer itself keeps the order (PB-097b / move_massed): a human order is the human's
// to change, and the walker already stops one cell short, which is all Manual p.10 permits.
export const HOLD_STALL_ROUNDS = 3;

// PB-122 AC6 (PM 6699, 6740): a walker whose next step is held by a STATIONARY friend re-plans
// around that cell when a free land route exists, keeps its order and arrives; it holds only when
// no way round exists. The straight line is still the plan (T-004) — this is not a general A*: the
// search runs only at the moment a stopped friend holds the next step, it walks cell-to-cell (no
// diagonal shortcuts, so going round always costs at least the line it replaces), it never crosses
// water, it cannot enter any cell a piece stands on, and it must end on the SAME destination. Where
// the straight line is walkable nothing here runs at all.
const DETOUR_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Pieces that have already been told they are out of oil. A WeakSet keyed on the piece keeps the
// once-per-episode rule without adding a key to a serialized object (see saveRoom's JSON cost).
const oilHoldAnnounced = new WeakSet();
const DETOUR_MAX_EXPANSIONS = 6000;
const DETOUR_MAX_STEPS = 96;

function isStationary(unit) {
  if (!unit) return false;
  if (unit.pinned === true) return true;
  return !Array.isArray(unit.path) || unit.path.length === 0;
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] <= heap[i][0]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let min = i;
      if (left < heap.length && heap[left][0] < heap[min][0]) min = left;
      if (right < heap.length && heap[right][0] < heap[min][0]) min = right;
      if (min === i) break;
      [heap[min], heap[i]] = [heap[i], heap[min]];
      i = min;
    }
  }
  return top;
}

// A bounded land route from where the piece stands to the order's destination, stepping around
// every occupied cell (the stopped friend included). Returns null when there is no way round.
function planDetour(piece, match, destX, destY) {
  if (!Array.isArray(piece.path) || piece.path.length === 0) return null;
  if (!cells()) return null;
  // A path with a sea leg is a crossing; its route belongs to the lane graph, not to this search.
  for (const step of piece.path) if (isWater(step.x, step.y)) return null;

  const goalX = wrapX(destX);
  const goalY = Number(destY);
  const goalKey = goalX + "," + goalY;
  const startKey = wrapX(piece.x) + "," + Number(piece.y);
  if (startKey === goalKey) return null;

  const solid = blockedCells(match);
  solid.delete(startKey); // the walker is not an obstacle to itself
  if (solid.has(goalKey)) return null; // the destination itself is held: there is nowhere to go

  const best = new Map([[startKey, 0]]);
  const prev = new Map();
  const heap = [[0, 0, startKey]];
  let opened = 0;
  while (heap.length > 0 && opened < DETOUR_MAX_EXPANSIONS) {
    const [cost, len, key] = heapPop(heap);
    if (cost > (best.get(key) ?? Infinity)) continue;
    opened += 1;
    if (key === goalKey) {
      const out = [];
      let cursor = goalKey;
      while (cursor !== startKey) {
        const [x, y] = cursor.split(",").map(Number);
        out.push(landStep({ x, y }));
        cursor = prev.get(cursor);
        if (cursor === undefined) return null;
      }
      out.reverse();
      return out.length > 0 ? out : null;
    }
    const [cx, cy] = key.split(",").map(Number);
    for (const [dx, dy] of DETOUR_DIRS) {
      const nx = wrapX(cx + dx);
      const ny = cy + dy;
      if (ny < 0 || ny >= CELL_H) continue;
      const nextKey = nx + "," + ny;
      if (solid.has(nextKey)) continue;
      const id = terrainAt(nx, ny);
      if (id === null) continue; // no board data: the search has nothing to route on
      if (isWater(nx, ny) || isRefused(id)) continue;
      if (!walkClassAllows(3, id)) continue;
      const nextLen = len + 1;
      if (nextLen > DETOUR_MAX_STEPS) continue;
      const nextCost = cost + Math.max(1, Number(paceAt(nx, ny)) || 1);
      if (nextCost >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, nextCost);
      prev.set(nextKey, key);
      heapPush(heap, [nextCost, nextLen, nextKey]);
    }
  }
  return null;
}

export function advance(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces) || match.over) return events;
  const doomed = new Set(); // pieces a round of overrun removed; filtered once, after the walk
  // A dry blocking resource stops that side's pieces; a non-blocking one (steel, which is not in
  // the original) never does. The answer is per side and does not change inside one round.
  // T-033 hot path: the bench ticks 1,000 rooms x 8 pieces and each moved cell debits the side's
  // oil meter. Resolving the per-kind price and the side's meter per PIECE meant a config lookup
  // and a seat walk per piece; both are per-round facts, so they are cached for this call and the
  // held value stays in a local until the piece's walk ends. The rule is unchanged: the same
  // meter is debited for the same cells, and the seat is written back once per side.
  const oilPrices = new Map();
  const oilMeters = new Map();
  const oilHeld = new Map();
  const oilDirty = new Set();
  const oilPriceOf = (kind) => {
    let price = oilPrices.get(kind);
    if (price === undefined) {
      price = oilCostPerCell(match, kind);
      oilPrices.set(kind, price);
    }
    return price;
  };
  const oilMeterOf = (side) => {
    let meter = oilMeters.get(side);
    if (meter === undefined) {
      meter = oilMeterFor(match, side);
      oilMeters.set(side, meter);
      if (meter) oilHeld.set(side, Number(meter.held));
    }
    return meter;
  };
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
  // PB-197: pieces already processed this round. The crossing prediction may only trust a friend
  // that has not had its turn yet; once its credit is settled, "it will vacate" is no longer true.
  const walked = new Set();
  for (const piece of match.pieces) {
    if (!Array.isArray(piece.path) || piece.path.length === 0) continue;
    if (isBlocked(piece.side)) continue;
    // An aircraft on a mission is not on the ground to be moved.
    if (inactiveRounds(piece, match.round) > 0) continue;
    // Pinned (p.22): a heavily engaged land unit stands until it is re-ordered, and issueOrder
    // is what clears the flag.
    if (piece.pinned === true) continue;
    walked.add(piece.id);

    // PB-097b: the ordered destination is HELD by an enemy and the walker is already inside its
    // own engage range - the order completes NOW, without having to bump into the cell. frodo
    // room 8626 §4b: the path.length gate is gone entirely, so a walker that is in range engages
    // whether the enemy sits on the ordered cell or mid-path. A tank ordered into INFANTRY is
    // still the overrun arm (p.9) and walks on to fight through it.
    const destination = piece.path[piece.path.length - 1];
    if (destination) {
      const holder = pieceAt(match, wrapX(destination.x), Number(destination.y), piece.id);
      const intoInfantry = Boolean(holder) && piece.kind === "tank" && piece.domain === "land" &&
        holder.domain === "land" && holder.kind === "infantry" && holder.transport !== true;
      if (holder && holder.side !== piece.side && !intoInfantry) {
        const destReach = rangeOf(piece, combatRules());
        if (inEngageRange(piece, holder, destReach)) {
          completeAsEngage(piece, holder, destination.x, destination.y, events, match, destReach);
          continue;
        }
      }
    }

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
    // Oil, resolved once for this piece's whole walk (T-033): a ship or a free-era side pays 0
    // and never touches a meter.
    const oilPrice = oilPriceOf(piece.kind);
    const oilMeter = oilPrice > 0 ? oilMeterOf(piece.side) : null;
    let heldLocal = oilMeter ? oilHeld.get(piece.side) : 0;
    let oilTouched = false;
    while (piece.path.length > 0 && spent < rate) {
      const next = piece.path[0];
      const nx = wrapX(next.x);
      const ny = Number(next.y);
      const pace = Math.max(1, Number(next.pace) || 1);
      if (credit < pace) break;
      const occupant = pieceAt(match, nx, ny, piece.id);
      // Manual p.10: "units may move through each other, though they may not stop to occupy the
      // same space at the same time". So a FRIENDLY piece never blocks a route and never clears
      // the order (PB-097a): the walker passes through every friendly cell except the one it is
      // ordered TO. That destination is the only stopping place, and there the rule is (b): do not
      // enter, keep the order and retry every round. The attempt is a `blocked` event ONCE per hold
      // (PB-121): the retry is the same fact every round, and a Log that repeats it for 14 rounds
      // buries everything else. A different blocker or a different cell is a new hold and speaks.
      // Before PB-097 any occupant cleared the path, so a stack ordered at one cell scattered and
      // stood wherever the first of them arrived.
      const friendly = Boolean(occupant) && occupant.side === piece.side;
      const atDestination = piece.path.length === 1;
      // A friend on the destination holds the walker short. A friend mid-path may be crossed when
      // either this round carries the walker off that cell again (PB-122), or the friend is itself
      // walking out of it this round (PB-197: crossing paths, A west through B while B east through
      // A, must not deadlock). Otherwise the step would end the round co-located with the friend.
      const leaves = !atDestination &&
        canStepInto(piece, match, piece.path.slice(1), credit - pace, new Set([piece.id]));
      const friendLeaves = occupant && friendly && !atDestination && !leaves &&
        willVacate(match, occupant, new Set([piece.id]), walked);
      if (occupant && friendly && (atDestination || (!leaves && !friendLeaves))) {
        // AC6: a stopped friend holding the next cell is a cell to walk AROUND when the ground
        // allows it. The detour re-plans from where the piece stands onto the same destination and
        // is capped, so a piece that keeps meeting friends cannot search every round forever.
        if (!atDestination && isStationary(occupant) && Number(piece.detours || 0) < 8) {
          const last = piece.path[piece.path.length - 1];
          const detour = planDetour(piece, match, last.x, last.y);
          if (detour) {
            piece.path = detour;
            piece.pace = Math.max(1, Number(detour[0].pace) || 1);
            piece.detours = Number(piece.detours || 0) + 1;
            events.push({
              type: "detour",
              side: piece.side,
              pieceId: piece.id,
              by: occupant.id,
              x: nx,
              y: ny,
              steps: detour.length,
            });
            continue; // walk the new path with the credit still in hand
          }
        }
        // PB-097b / move_massed: a FRIENDLY-held destination keeps the order and the walker is
        // held one cell short of it (it may not stop on the friend's cell, Manual p.10). The unit
        // is not stuck mid-map: it is as far as the rule allows. The bot is the side that re-plans
        // after HOLD_STALL_ROUNDS of this (bot.mjs); a human order is the human's to change.
        piece.holdRounds = Number(piece.holdRounds || 0) + 1;
        noteHold(piece, occupant, nx, ny, events);
        stopped = true;
        break;
      }
      if (occupant && !friendly) {
        // Overrun is the tank's (Manual p.9): a tank ordered into infantry fights through it,
        // taking losses, and carries on into the cell if the infantry is destroyed. The path is
        // never dropped here; a tank that is held keeps its order and tries again next round.
        const overrun =
          piece.kind === "tank" &&
          piece.domain === "land" &&
          occupant.domain === "land" &&
          occupant.kind === "infantry" &&
          occupant.transport !== true;
        if (!overrun) {
          // PB-097b: an ATTACK order completes as ENGAGE. A walker may never share a cell (p.10),
          // so the walk stops here; if the blocked cell IS the ordered cell and the enemy is inside
          // the walker's own engage range, the order is DONE - path cleared, target recorded, one
          // event - instead of parking one cell short and re-attempting the step every round.
          //
          // The in-range-but-not-adjacent case (frodo 8626 §4b: offset (2,2), one step to dist^2=5)
          // is completed by the destination check at the top of this piece's turn, not here; a
          // MID-PATH enemy keeps the hold below, because PB-197 AC4 and the detour leg both require
          // that a unit blocked in the way still counts a hold and keeps its order.
          // A tank ordered into INFANTRY is the overrun arm above and never reaches here.
          const engageCombat = combatRules();
          const reach = rangeOf(piece, engageCombat);
          if (atDestination && inEngageRange(piece, occupant, reach)) {
            completeAsEngage(piece, occupant, nx, ny, events, match, reach);
            stopped = true;
            break;
          }
          // Stop one short: the walker never shares a cell, and the clash is combat's job. The
          // order is KEPT so the unit presses again next round instead of standing where it
          // happened to meet the enemy.
          piece.overrunBy = null;
          piece.overrunCell = null;
          // PB-197: the bot reads this counter to re-plan; a unit held by an enemy is still held,
          // exactly as before (AC4), it just no longer counts as a unit that is making progress.
          piece.holdRounds = Number(piece.holdRounds || 0) + 1;
          noteHold(piece, occupant, nx, ny, events);
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
        //
        // The same beat gates the overrun itself: an exchange is due when `shotEveryRounds` rounds
        // have passed since the last one, not merely because this round has not fired yet. The
        // earlier `foughtRound !== onRound` test fired on two consecutive rounds (the held tank
        // re-tries every round), which no reading of the rule allows - T-015 cadence trace.
        const combat = combatRules();
        const max = combat.maxStrength;
        const beatDue = onRound - Number(match.foughtRound ?? -1) >= combat.shotEveryRounds;
        if (beatDue) {
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
      // Oil (T-033): one cell entered costs this kind's charge out of the side's budget. A side
      // that cannot pay stops here and says so once per episode; the order stays live, so the
      // piece walks on when the wells pay again (Manual p.27 "units stop moving"). The price and
      // the meter are resolved once per piece (before the walk), not per cell: this loop is the
      // bench's hot path.
      if (oilMeter) {
        if (!Number.isFinite(heldLocal) || heldLocal < oilPrice) {
          heldLocal = 0;
          oilMeter.dry = true;
          oilTouched = true;
          // Said once per episode. A module-level WeakSet, not a field on the piece: a new key on
          // a serialized piece changes its hidden class and the store bench pays for it.
          if (!oilHoldAnnounced.has(piece)) {
            oilHoldAnnounced.add(piece);
            events.push({
              type: "oil_hold", side: piece.side, pieceId: piece.id,
              x: piece.x, y: piece.y, round: Number(match.round) || 0,
            });
          }
          stopped = true;
          break;
        }
        heldLocal -= oilPrice;
        oilMeter.dry = heldLocal <= 0;
        oilTouched = true;
      }
      oilHoldAnnounced.delete(piece);
      piece.facing = facingFor(fromX, fromY, nx, ny);
      piece.x = nx;
      piece.y = ny;
      piece.path.shift();
      // A real step ends any hold: the piece has left the cell it was held at, so a later hold on
      // that cell is a new fact and speaks again (PB-121). Clearing only here is what keeps a
      // pace-2 round honest: those rounds attempt no step at all (credit < pace), so they are the
      // SAME hold and must stay silent. The old `if (!stopped)` clear at the end of the pass ran on
      // exactly those rounds and re-emitted the line on pace-2 ground (live e6f12ab r23, r25, r27).
      piece.heldBy = null;
      piece.heldCell = null;
      piece.holdRounds = 0;
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
    if (oilMeter) {
      oilHeld.set(piece.side, heldLocal);
      if (oilTouched) oilDirty.add(piece.side);
    }
    piece.credit = stopped ? 0 : Math.max(0, credit);
    // Nothing to clear here: the hold memory lives until a step is actually taken (above) or a new
    // order replaces it (issueOrder). A round with no step attempted is not an end of the hold.
  }
  // One seat write per side that actually paid, after every piece of that side has walked.
  for (const side of oilDirty) {
    const meter = oilMeters.get(side);
    if (!meter) continue;
    meter.held = oilHeld.get(side);
    meter.dry = meter.held <= 0;
    syncOilSeat(match, side, meter);
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
