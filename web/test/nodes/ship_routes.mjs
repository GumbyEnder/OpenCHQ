// A ship at Washington can reach the Atlantic and a European port. The live build answered
// every order with "No sea lane reaches that cell" because the public host has no extract, so
// the lane table was empty there; the baked lane table is now played instead.
//
// On the real board: routes are all water, pass two or more lane waypoints, every ship-placeable
// cell reaches a fixed mid-Atlantic cell, a real cut-off water cell is refused, and the clock
// moves the hull along the route.
import { boardPayload, matchSites, resolveDataRoot, CELL_W, CELL_H } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { placementMask } from "../../server/placement.mjs";
import { laneGraph, resetLaneCache, seaRoute } from "../../server/lanes.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";

export const name = "ship_routes";

const HULL = "cruiser";
const MID_ATLANTIC = { x: 37, y: 50 };

function waterId(board, x, y) {
  return board.cells[y * CELL_W + x];
}

function isWaterCell(board, cell) {
  const id = waterId(board, cell.x, cell.y);
  return id !== null && id >= 0 && id <= 2;
}

function nearest(mask, board, target) {
  let best = null;
  let bestGap = Infinity;
  for (let id = 0; id < mask.length; id++) {
    if (!mask[id]) continue;
    const x = id % CELL_W;
    const y = (id - x) / CELL_W;
    const dx = Math.abs(x - target.x);
    const gap = Math.max(Math.min(dx, CELL_W - dx), Math.abs(y - target.y));
    if (gap < bestGap) {
      bestGap = gap;
      best = { x, y };
    }
  }
  return best;
}

function waypointCount(route) {
  const graph = laneGraph(resolveDataRoot());
  const keys = new Set((graph.waypoints || []).map((p) => p.x + "," + p.y));
  return route.filter((step) => keys.has(step.x + "," + step.y)).length;
}

function checkRoute(route, board, label) {
  if (!Array.isArray(route) || route.length < 3) {
    throw new Error(label + ": expected a route of at least 3 steps, got " + JSON.stringify(route));
  }
  for (const step of route) {
    if (!isWaterCell(board, step)) {
      throw new Error(label + ": route steps on non-water cell " + step.x + "," + step.y +
        " (id " + waterId(board, step.x, step.y) + ")");
    }
  }
  const points = waypointCount(route);
  if (points < 2) throw new Error(label + ": route visits " + points + " lane waypoints, expected 2+");
  return points;
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  const root = resolveDataRoot();
  if (!root || !Array.isArray(board.cells)) {
    ctx.skip("ship_routes: no extracted board on this host (set OPENCHQ_DATA or OPENCHQ_EXTRACT)");
  }
  resetLaneCache();

  const match = openMatch("1942", matchSites("1942", board));
  seedOwners(match);
  const mask = placementMask(match, "blue", HULL, board);
  if (mask.error) fail("ship_routes: a hull cannot be placed at all: " + mask.error);

  const washington = { x: 79, y: 44 };
  const start = nearest(mask.mask, board, washington);
  if (!start) fail("ship_routes: no coastal cell near Washington for a hull");
  if (Math.max(Math.abs(start.x - washington.x), Math.abs(start.y - washington.y)) > 8) {
    fail("ship_routes: the nearest hull berth to Washington is " + start.x + "," + start.y);
  }

  const mid = seaRoute(root, start, MID_ATLANTIC);
  const midPoints = checkRoute(mid, board, "Washington -> mid-Atlantic");

  // A British or French port: a real docks cell in the eastern Atlantic.
  const docks = [];
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      if (board.cells[y * CELL_W + x] === 1) docks.push({ x, y });
    }
  }
  const port = docks
    .filter((cell) => cell.x >= 140 && cell.x <= 175 && cell.y >= 5 && cell.y <= 30)
    .sort((a, b) => a.x - b.x || a.y - b.y)[0];
  if (!port) fail("ship_routes: no British/French docks cell on the board");
  const euro = seaRoute(root, start, port);
  const euroPoints = checkRoute(euro, board, "Washington -> " + port.x + "," + port.y);

  // Every cell where placement allows a hull must reach the same mid-Atlantic cell.
  let tried = 0;
  const failures = [];
  for (let id = 0; id < mask.mask.length; id++) {
    if (!mask.mask[id]) continue;
    tried += 1;
    const x = id % CELL_W;
    const y = (id - x) / CELL_W;
    const route = seaRoute(root, { x, y }, MID_ATLANTIC);
    if (!route) failures.push(x + "," + y);
  }
  if (tried < 100) fail("ship_routes: only " + tried + " hull cells were tested");
  if (failures.length) {
    fail("ship_routes: " + failures.length + " of " + tried + " hull cells cannot reach mid-Atlantic: " +
      failures.slice(0, 8).join(" "));
  }

  // A cut-off water cell really is refused. A lake is water the lanes never touch.
  let lake = null;
  for (let y = 0; y < CELL_H && !lake; y++) {
    for (let x = 0; x < CELL_W && !lake; x++) {
      if (board.cells[y * CELL_W + x] === 3) lake = { x, y };
    }
  }
  if (!lake) fail("ship_routes: the board has no lake, so the cut-off case cannot be shown");
  const inland = seaRoute(root, lake, MID_ATLANTIC);
  if (inland !== null) {
    fail("ship_routes: a lake at " + lake.x + "," + lake.y + " was given a sea route: " + JSON.stringify(inland));
  }

  // The clock moves the hull along the route it was given.
  const sailing = openMatch("1942", matchSites("1942", board));
  seedOwners(sailing);
  sailing.clock = "running";
  const hullMask = placementMask(sailing, "blue", HULL, board);
  const berth = nearest(hullMask.mask, board, washington);
  sailing.pieces = [{ id: "blue:cruiser:test", side: "blue", domain: "sea", kind: HULL, x: berth.x, y: berth.y, path: [] }];
  const order = issueOrder(sailing, "blue", "blue:cruiser:test", MID_ATLANTIC.x, MID_ATLANTIC.y);
  if (!order || order.error) fail("ship_routes: the order was refused: " + JSON.stringify(order));
  const routeCells = new Set(order.path.map((step) => step.x + "," + step.y));
  const before = { x: sailing.pieces[0].x, y: sailing.pieces[0].y };
  for (let i = 0; i < 3; i++) tickMatch(sailing);
  const after = { x: sailing.pieces[0].x, y: sailing.pieces[0].y };
  if (after.x === before.x && after.y === before.y) {
    fail("ship_routes: three running rounds left the hull on " + before.x + "," + before.y);
  }
  if (!routeCells.has(after.x + "," + after.y)) {
    fail("ship_routes: the hull stepped to " + after.x + "," + after.y + ", which is not on its route");
  }

  console.log("ship_routes: berth " + start.x + "," + start.y +
    "; mid-Atlantic " + mid.length + " steps / " + midPoints + " waypoints" +
    "; " + port.x + "," + port.y + " " + euro.length + " steps / " + euroPoints + " waypoints" +
    "; " + tried + " hull cells all route; lake refused; clock moved " +
    before.x + "," + before.y + " -> " + after.x + "," + after.y);
}
