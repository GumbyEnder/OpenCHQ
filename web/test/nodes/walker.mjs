// walker — the straight-line walker (T-004, AC1-AC3 and AC7).
//
// What fails if this is removed:
//   - a move is a Bresenham line with the binary's class test     -> a route bends around terrain,
//     which is the A* this task replaced (move.mjs no longer contains one)
//   - the X gap over 160 takes the short way round the cylinder   -> an order across the seam
//     walks 305 cells the wrong way instead of 15 the right way
//   - class 3 refuses wasteland and fails at a path-cost sum of 100 -> the archive's own route
//     test is gone and any line is accepted
//   - a land order's path is exactly the Bresenham cell sequence  -> an order could be bent by
//     code between the walker and the piece
//
// The class table and the cost bytes are RULES.md section 1-2 / DS:0x011C; the synthetic grids
// below carry terrain ids, not a copy of the code's conditions.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { bresenham, walkLine, walkClassAllows, issueOrder } from "../../server/move.mjs";
import { landPace, pathCostFor, walkCostLimit } from "../../server/rules.mjs";

export const name = "walker";

const here = path.dirname(fileURLToPath(import.meta.url));
const moveFile = path.resolve(here, "..", "..", "server", "move.mjs");

// A synthetic terrain grid: a row of ids, one cell per column, so a walk along a row is one id per
// step. Anything outside the row is open plain.
function row(ids) {
  return (x) => (x >= 0 && x < ids.length ? ids[x] : 8);
}

export async function run(ctx) {
  const { fail } = ctx;

  // ---- AC1: the class table ----------------------------------------------------------------
  if (!walkClassAllows(0, 0) || !walkClassAllows(0, 1) || !walkClassAllows(0, 2)) {
    fail("class 0 did not accept ocean, docks and shallows (ids 0-2)");
  }
  if (walkClassAllows(0, 8)) fail("class 0 accepted plain ground");
  if (!walkClassAllows(1, 0) || !walkClassAllows(1, 1)) fail("class 1 refused ocean or docks");
  if (walkClassAllows(1, 2)) fail("class 1 accepted shallows (id 2)");
  if (walkClassAllows(2, 0) || walkClassAllows(2, 1) || walkClassAllows(2, 2)) {
    fail("class 2 accepted a water id");
  }
  if (!walkClassAllows(2, 8) || !walkClassAllows(2, 3)) fail("class 2 refused land or lake");
  if (walkClassAllows(3, 14)) fail("class 3 accepted wasteland");
  if (walkClassAllows(4, 14)) fail("class 4 accepted wasteland");
  if (!walkClassAllows(5, 14)) fail("class 5 hard-failed on wasteland");

  // The walk itself must agree with the table: a two-cell walk into the refused id returns ok:false.
  const into = (ids, cls) => walkLine({ x: 0, y: 0 }, { x: 1, y: 0 }, cls, row(ids));
  if (!into([8, 1], 0).ok || !into([8, 2], 0).ok) fail("a class-0 walk refused docks or shallows");
  if (into([8, 8], 0).ok) fail("a class-0 walk entered plain ground");
  if (!into([8, 1], 1).ok) fail("a class-1 walk refused docks");
  if (into([8, 2], 1).ok) fail("a class-1 walk entered shallows");
  if (into([8, 1], 2).ok) fail("a class-2 walk entered docks");
  if (into([8, 2], 2).ok) fail("a class-2 walk entered shallows");
  if (!into([8, 8], 2).ok) fail("a class-2 walk refused plain ground");
  if (into([8, 14], 3).ok) fail("a class-3 walk entered wasteland");
  if (into([8, 14], 4).ok) fail("a class-4 walk entered wasteland");
  if (!into([8, 14], 5).ok) fail("a class-5 walk refused a single wasteland cell");

  // ---- AC1: the summed path-cost fail at 100 -----------------------------------------------
  // Desert 3: 33 cells add 99 and pass, 34 add 102 and fail.
  const desert = (n) => row(new Array(n + 1).fill(11));
  if (!walkLine({ x: 0, y: 0 }, { x: 33, y: 0 }, 3, desert(33)).ok) {
    fail("33 desert cells (cost 99) were refused");
  }
  const over = walkLine({ x: 0, y: 0 }, { x: 34, y: 0 }, 3, desert(34));
  if (over.ok || over.fail !== "cost") fail("34 desert cells (cost 102) were not refused on the sum: " + JSON.stringify(over));
  // Jungle 9: 11 cells add 99, 12 add 108.
  if (!walkLine({ x: 0, y: 0 }, { x: 11, y: 0 }, 3, row(new Array(12).fill(12))).ok) {
    fail("11 jungle cells (cost 99) were refused");
  }
  if (walkLine({ x: 0, y: 0 }, { x: 12, y: 0 }, 3, row(new Array(13).fill(12))).ok) {
    fail("12 jungle cells (cost 108) were accepted");
  }
  // Polar 13: 7 cells pass, 8 fail.
  if (!walkLine({ x: 0, y: 0 }, { x: 7, y: 0 }, 3, row(new Array(8).fill(13))).ok) {
    fail("7 polar cells (cost 91) were refused");
  }
  if (walkLine({ x: 0, y: 0 }, { x: 8, y: 0 }, 3, row(new Array(9).fill(13))).ok) {
    fail("8 polar cells (cost 104) were accepted");
  }
  // Wasteland 77 still counts for class 5: one passes on the terrain test, two fail on the sum.
  if (walkLine({ x: 0, y: 0 }, { x: 2, y: 0 }, 5, row(new Array(3).fill(14))).ok) {
    fail("two wasteland cells (cost 154) were accepted by class 5");
  }
  // The limit is the archive's 100, not a number this code chose.
  if (walkCostLimit() !== 100) fail("the walker's cost limit is " + walkCostLimit() + ", not 100");
  if (pathCostFor(11) !== 3) fail("the desert path-cost byte is " + pathCostFor(11) + ", not 3");

  // ---- AC1: start equals end returns 1 ------------------------------------------------------
  const still = walkLine({ x: 20, y: 20 }, { x: 20, y: 20 }, 3, () => 8);
  if (!still.ok || still.steps !== 1 || still.cells.length !== 1) {
    fail("start = end did not return 1: " + JSON.stringify(still));
  }

  // ---- AC2: the seam is walked the short way ------------------------------------------------
  const east = walkLine({ x: 310, y: 50 }, { x: 5, y: 50 }, 3, () => 8);
  if (!east.ok) fail("the seam walk was refused");
  if (east.steps !== 15) fail("the seam walk is " + east.steps + " steps, not 15");
  let prev = 310;
  for (const cell of east.cells.slice(1)) {
    const step = (cell.x - prev + CELL_W) % CELL_W;
    if (step !== 1) fail("the seam walk is not one cell east per step at x=" + prev + " -> " + cell.x);
    prev = cell.x;
  }
  if (prev !== 5) fail("the seam walk ended at x=" + prev + ", not 5");
  const west = bresenham({ x: 310, y: 50 }, { x: 5, y: 50 });
  if (west.length !== east.cells.length) fail("the westward reading is " + (west.length - 1) + " steps: the long way was taken");

  // ---- AC3: a land order is exactly the Bresenham sequence ----------------------------------
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("the map extract is missing, so the straight order cannot be proven");
  const cellAt = (x, y) => board.cells[y * CELL_W + ((x % CELL_W) + CELL_W) % CELL_W];
  // A diagonal rectangle of open ground, so the line is not trivially horizontal.
  let spot = null;
  for (let y = 2; y < 132 && !spot; y++) {
    for (let x = 2; x < 313 && !spot; x++) {
      let ok = true;
      for (let dy = 0; dy <= 3 && ok; dy++) {
        for (let dx = 0; dx <= 5 && ok; dx++) {
          if (landPace(cellAt(x + dx, y + dy)) !== 1) ok = false;
        }
      }
      if (ok) spot = { x, y };
    }
  }
  if (!spot) fail("no open 6x4 patch on the board: the straight-order check cannot run");
  const match = openMatch("1986");
  const walker = match.pieces.find((piece) => piece.id === "blue:land");
  walker.x = spot.x;
  walker.y = spot.y;
  walker.path = [];
  const order = issueOrder(match, "blue", walker.id, spot.x + 5, spot.y + 3);
  if (order.error) fail("the open diagonal order was refused: " + order.error);
  const line = bresenham({ x: spot.x, y: spot.y }, { x: spot.x + 5, y: spot.y + 3 }).slice(1);
  if (order.path.length !== line.length) {
    fail("the order is " + order.path.length + " steps, Bresenham is " + line.length);
  }
  for (let i = 0; i < line.length; i++) {
    if (order.path[i].x !== line[i].x || order.path[i].y !== line[i].y) {
      fail("step " + i + " is " + order.path[i].x + "," + order.path[i].y + " not " + line[i].x + "," + line[i].y);
    }
  }

  // ---- AC7: no A* (or any other search) is left in move.mjs ---------------------------------
  if (!existsSync(moveFile)) fail("move.mjs is not where this test expects it");
  const source = readFileSync(moveFile, "utf8");
  const banned = /A\*|dijkstra|heuristic|openSet|closedSet|priorityQueue|min-heap|\bheap\b/i;
  const hits = source.split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => banned.test(entry.line))
    .map((entry) => entry.index + ": " + entry.line.trim());
  if (hits.length) fail("move.mjs still carries a search: " + hits.join(" | "));

  console.log("walker: class table 0-5, cost sum 100 at desert 3/jungle 9/polar 13/wasteland 77, " +
    "seam " + east.steps + " steps, straight order " + order.path.length + " steps, no search left");
}
