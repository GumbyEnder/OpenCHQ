// The empty seat's orders. Owner: A7. See docs/CONTRACTS.md.
//
// In a bot room the empty seat marches its army toward the player's capital and sails its ship
// once when its path is empty. Who is a bot is the caller's decision: the seat table on the
// match records `kind`, and this module only reads it. It never guesses a bot from an empty
// seat, a username, or a room mode, because a human seat's orders are the human's to send.
//
// The module asks the movement module for every path. It never invents a route: land orders go
// through move.issueOrder, whose destinations are the cells beside the opposing capital (the
// capital itself is held by its garrison, and a walker never enters a held cell). A ship's
// target comes from lanes.seaRoute. Both of those are other agents' files and may still be
// stubs, so every call is wrapped: a refusal becomes a note, never a crash.

import { CELL_H, CELL_W, boardPayload, resolveDataRoot } from "./board.mjs";
import { laneGraph, seaRoute } from "./lanes.mjs";
import { issueOrder, wrapDelta, wrapX } from "./move.mjs";
import { isRefused } from "./rules.mjs";

const SIDES = new Set(["blue", "red"]);

function opposite(side) {
  return side === "blue" ? "red" : "blue";
}

function hasPath(piece) {
  return Array.isArray(piece.path) && piece.path.length > 0;
}

// Bot-ness is only ever read from an explicit record on the match. Anything else is "unknown",
// and an unknown seat is ordered because the caller already decided to ask for bot orders.
function seatKind(match, side) {
  const seats = match && match.seats;
  const seat = seats && typeof seats === "object" ? seats[side] : null;
  if (seat && typeof seat.kind === "string") return seat.kind;

  if (match && match.botSide) return match.botSide === side ? "bot" : "human";
  if (match && match.bot === side) return "bot";
  if (match && Array.isArray(match.bots)) return match.bots.includes(side) ? "bot" : null;

  return null;
}

let cellsCache;
function cells() {
  if (cellsCache !== undefined) return cellsCache;
  try {
    const payload = boardPayload();
    cellsCache = Array.isArray(payload.cells) ? payload.cells : null;
  } catch {
    cellsCache = null;
  }
  return cellsCache;
}

function terrainAt(x, y) {
  const grid = cells();
  if (!grid) return null;
  return grid[Number(y) * CELL_W + wrapX(x)] ?? null;
}

function heldByOther(match, piece, x, y) {
  const wx = wrapX(x);
  return (match.pieces || []).some(
    (unit) => unit.id !== piece.id && wrapX(unit.x) === wx && Number(unit.y) === Number(y)
  );
}

// The cells a walker can finish on beside the capital, nearest the army first. The capital
// itself is skipped: its garrison holds it, and a piece stops one short of a shared cell.
function approachCells(match, piece, capital) {
  const dx = Math.sign(wrapDelta(capital.x, piece.x));
  const dy = Math.sign(Number(piece.y) - Number(capital.y));
  const candidates = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const x = wrapX(capital.x + ox);
      const y = Number(capital.y) + oy;
      if (y < 0 || y >= CELL_H) continue;
      if (heldByOther(match, piece, x, y)) continue;
      const id = terrainAt(x, y);
      if (id !== null && isRefused(id)) continue;
      const gap = Math.max(Math.abs(wrapDelta(piece.x, x)), Math.abs(Number(piece.y) - y));
      const approach = (ox === -dx && oy === -dy) ? -1 : 0;
      candidates.push({ x, y, gap, approach });
    }
  }
  candidates.sort((a, b) => a.approach - b.approach || a.gap - b.gap);
  return candidates;
}

// When the ring around the capital is full, waiting is not a plan.
//
// Units do not stack, so a capital whose eight neighbours are all occupied leaves the march with
// nothing to stand on. A 400-round bot run logged 26,834 "no approach cell beside the capital"
// skips, which is a bot that has stopped thinking rather than a siege. That number came from a
// harness that is not in local/, so this change carries no re-measured before/after: the run needs
// reproducing before anyone claims the skips are gone. An occupied cell is not off limits
// to an order - the engine treats a move onto an enemy cell as an attack - so the army attacks the
// weakest point of the ring instead of queueing behind it. The rule is the engine's own overrun
// arithmetic: the cell with the fewest enemy pieces beside it is the one a group can break.
export function assaultCells(match, piece, capital) {
  const out = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const x = wrapX(capital.x + ox);
      const y = Number(capital.y) + oy;
      if (y < 0 || y >= CELL_H) continue;
      const holder = (match.pieces || []).find(
        (unit) => unit && unit.x === x && unit.y === y && unit.id !== piece.id && unit.side !== piece.side,
      );
      if (!holder) continue;
      const friends = (match.pieces || []).filter(
        (other) => other && other.side === holder.side && other.id !== holder.id &&
          Math.max(Math.abs(wrapDelta(other.x, x)), Math.abs(Number(other.y) - y)) <= 1,
      ).length;
      const gap = Math.max(Math.abs(wrapDelta(piece.x, x)), Math.abs(Number(piece.y) - y));
      out.push({ x, y, gap, defenders: friends, holder: holder.id });
    }
  }
  out.sort((a, b) => a.defenders - b.defenders || a.gap - b.gap);
  return out;
}

function note(side, pieceId, reason) {
  return { type: "bot_skip", side, pieceId, reason: String(reason || "refused") };
}

function routeTarget(route) {
  if (!Array.isArray(route) || route.length === 0) return null;
  for (let i = route.length - 1; i >= 0; i--) {
    const step = route[i];
    if (step && Number.isInteger(step.x) && Number.isInteger(step.y)) return { x: step.x, y: step.y };
  }
  return null;
}

function dataRootFor(match) {
  if (match && typeof match.dataRoot === "string" && match.dataRoot) return match.dataRoot;
  // lanes.mjs takes the data root explicitly; the board module knows where the extract is.
  try {
    return resolveDataRoot() || "";
  } catch {
    return "";
  }
}

// Concentration. A line that marches evenly at a capital grinds and never breaks - measured:
// 1200 rounds, 27 kills, no winner, because overrun needs surplus and an even front has none.
// So the bot picks ONE point of the enemy line - the enemy piece with the fewest enemy friends
// beside it - and the whole army converges there. That is behaviour, not a rule, so it costs
// no fidelity: the same pieces, the same orders, aimed better.
export function focusTarget(match, side, foe, capital) {
  const enemies = (match.pieces || []).filter((unit) => unit && unit.side === foe);
  if (enemies.length === 0) return capital;
  const mine = (match.pieces || []).filter((unit) => unit && unit.side === side);
  const friends = (cell) => enemies.filter((other) => other.id !== cell.id && Math.max(Math.abs(wrapDelta(other.x, cell.x)), Math.abs(Number(other.y) - Number(cell.y))) <= 1).length;

  let best = null;
  let bestCost = Infinity;
  for (const enemy of enemies) {
    // Distance from the army's centre of mass, so the choice is one the army can reach.
    let sum = 0;
    for (const piece of mine) sum += Math.max(Math.abs(wrapDelta(piece.x, enemy.x)), Math.abs(Number(piece.y) - Number(enemy.y)));
    const cost = friends(enemy) * 1000 + (mine.length ? sum / mine.length : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = enemy;
    }
  }
  return best ? { x: best.x, y: best.y } : capital;
}

// Exported so the ring case can be driven directly: the endgame state is hard to reach through
// ordersFor, which picks a focus of its own first.
export function marchOne(match, side, piece, capital, events) {
  const cells = approachCells(match, piece, capital);
  if (cells.length === 0) {
    // The ring is full: attack its weakest point rather than stand still. Units do not stack, so
    // there is no cell to queue on and no order to give except the one the engine calls an attack.
    const targets = assaultCells(match, piece, capital);
    for (const cell of targets.slice(0, 3)) {
      let result;
      try {
        result = issueOrder(match, side, piece.id, cell.x, cell.y);
      } catch (err) {
        continue;
      }
      if (result && result.ok) {
        events.push({ type: "bot_order", side, pieceId: piece.id, to: { x: cell.x, y: cell.y },
          path: result.path || [], assault: true, defenders: cell.defenders });
        return;
      }
    }
    events.push(note(side, piece.id, targets.length
      ? "ringed, and no attack could be issued"
      : "no approach cell beside the capital"));
    return;
  }
  let last = "no path";
  // At most a handful of tries: the nearest face first, then the rest of the ring.
  for (const cell of cells.slice(0, 4)) {
    let result;
    try {
      result = issueOrder(match, side, piece.id, cell.x, cell.y);
    } catch (err) {
      last = err && err.message ? err.message : err;
      continue;
    }
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      events.push({ type: "bot_order", side, pieceId: piece.id, to: { x: cell.x, y: cell.y }, path: result.path });
      return;
    }
    last = (result && result.error) || "no path";
  }
  events.push(note(side, piece.id, last));
}

export function ordersFor(match, side) {
  const events = [];
  if (!match || !SIDES.has(side)) return events;
  if (!Array.isArray(match.pieces)) return events;
  if (match.over) return events;

  if (seatKind(match, side) === "human") {
    events.push({ type: "bot_skip", side, reason: "seat is human; the caller sends its orders" });
    return events;
  }

  const foe = opposite(side);
  const capital = match.capitals && match.capitals[foe];
  if (!capital || !Number.isInteger(capital.x) || !Number.isInteger(capital.y)) return events;

  const mine = match.pieces.filter((piece) => piece && piece.side === side);
  // One focus for the whole army: a weak point of the enemy line once there is contact, the
  // capital until then.
  const focus = focusTarget(match, side, foe, capital);

  // The army marches on the player's capital. A piece already on a path keeps it; the army is
  // re-ordered only once it has arrived, so an order is not re-issued every round.
  for (const piece of mine) {
    if (piece.domain !== "land") continue;
    if (hasPath(piece)) continue;
    marchOne(match, side, piece, focus, events);
  }

  // One sail: a ship that already has a path is left alone. Only an idle ship is routed. The
  // destination is a lane waypoint near the enemy capital - not the enemy ship's own cell,
  // which its crew occupies - so the sail is a real lane route rather than a refused order.
  const waypoints = (() => {
    try {
      return laneGraph(dataRootFor(match)).waypoints || [];
    } catch {
      return [];
    }
  })();
  const nearestLane = (target) => {
    let best = null;
    let bestDist = Infinity;
    for (const point of waypoints) {
      const dx = Math.abs(point.x - target.x);
      const wrap = Math.min(dx, 320 - dx);
      const dist = Math.max(wrap, Math.abs(point.y - target.y));
      if (dist < bestDist) {
        bestDist = dist;
        best = point;
      }
    }
    return best;
  };
  const seaTarget = nearestLane(capital) || { x: capital.x, y: capital.y };
  for (const piece of mine) {
    if (piece.domain !== "sea") continue;
    if (hasPath(piece)) continue;

    let route = null;
    try {
      route = seaRoute(dataRootFor(match), { x: piece.x, y: piece.y }, seaTarget);
    } catch {
      route = null;
    }

    // The lane lookup may snap the target onto water. If it has nothing yet, ask the movement
    // module for the target directly and let it refuse rather than inventing a route.
    const target = routeTarget(route) || seaTarget;
    let result;
    try {
      result = issueOrder(match, side, piece.id, target.x, target.y);
    } catch (err) {
      events.push(note(side, piece.id, err && err.message ? err.message : err));
      continue;
    }
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      events.push({ type: "bot_order", side, pieceId: piece.id, to: target, path: result.path });
    } else {
      events.push(note(side, piece.id, (result && result.error) || "no route"));
    }
  }

  return events;
}
