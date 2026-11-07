// detour — a piece goes round a friend instead of standing still.
//
// What fails if this is removed:
//   - advance() re-routes a piece whose next cell is held by a friend   -> every jammed army goes
//     stiff, which is what 13,075 route refusals in a 400-round bot match looked like
//   - a detour is bounded (tries per order, budget per round)           -> a jammed cell would BFS
//     the whole map every round for every blocked piece
//   - an ENEMY in the way is never a detour                             -> contact would turn into
//     pathfinding and armies would walk around each other forever
//
// The board is the real extract: the test finds an open land run on it rather than trusting a
// remembered coordinate.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX } from "../../server/move.mjs";
import { landPace } from "../../server/rules.mjs";

export const name = "detour";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

export async function run(ctx) {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "detour needs the board cells");
  const cell = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(cell(x, y)) === 1;

  // Somewhere with five open land cells in a row and open ground beside the middle of it.
  let run = null;
  for (let y = 2; y < 134 && !run; y++) {
    for (let x = 2; x < 318 && !run; x++) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!open(x + k, y)) { ok = false; break; }
      if (!ok) continue;
      if (!open(x + 2, y - 1) || !open(x + 2, y + 1)) continue;
      run = { x, y };
    }
  }
  must(run, "no open land run on the board: the test cannot run");

  const match = openMatch("1986");
  const walker = match.pieces.find((piece) => piece.id === "blue:land");
  must(walker, "1986 has no blue:land");

  // Walk along the run with a friend parked on the second cell.
  walker.x = run.x;
  walker.y = run.y;
  walker.path = [];
  // The order is planned on an open board, and only then does a friend step into the plan. That
  // is the case that used to freeze: a route that was clear when it was given, and a cell that
  // is held when the piece gets there.
  const ordered = issueOrder(match, "blue", walker.id, run.x + 4, run.y);
  must(ordered.ok, "the order past a friend must still be accepted: " + JSON.stringify(ordered));
  must(ordered.path.length >= 4, "the walk must be more than a step: " + JSON.stringify(ordered.path));
  match.pieces.push({
    id: "blue:blocker",
    side: "blue",
    kind: "infantry",
    domain: "land",
    x: run.x + 1,
    y: run.y,
    path: [],
  });

  let detours = 0;
  let blocked = 0;
  let arrived = false;
  for (let round = 0; round < 24; round++) {
    for (const event of advance(match)) {
      if (event.type === "detour" && event.pieceId === walker.id) detours += 1;
      if (event.type === "blocked" && event.pieceId === walker.id) blocked += 1;
    }
    if (wrapX(walker.x) === wrapX(run.x + 4) && walker.y === run.y) {
      arrived = true;
      break;
    }
  }
  must(arrived, "the walker must get round the friend and reach the destination: at " +
    JSON.stringify({ x: walker.x, y: walker.y }) + " after " + JSON.stringify({ detours, blocked }));
  must(detours >= 1, "getting round a friend must be recorded as a detour, not silence");

  // ---- an enemy in the way stops the path: contact is combat's job --------------------------
  walker.x = run.x;
  walker.y = run.y;
  walker.path = [];
  walker.detours = 0;
  // The friend from the first half is still standing there; move it clear so this half is only
  // about the enemy.
  const blocker = match.pieces.find((piece) => piece.id === "blue:blocker");
  if (blocker) {
    blocker.x = run.x;
    blocker.y = run.y + 3;
  }
  issueOrder(match, "blue", walker.id, run.x + 4, run.y);
  const foe = match.pieces.find((piece) => piece.side === "red" && piece.domain === "land");
  must(foe, "1986 has no red land piece");
  foe.x = run.x + 1;
  foe.y = run.y;
  foe.path = [];
  let sawBlocked = false;
  let sawDetour = false;
  for (let round = 0; round < 3 && !sawBlocked; round++) {
    for (const event of advance(match)) {
      if (event.pieceId !== walker.id) continue;
      if (event.type === "blocked") sawBlocked = true;
      if (event.type === "detour") sawDetour = true;
    }
  }
  must(sawBlocked, "an enemy in the way must stop the walker (blocked), not be routed around");
  must(!sawDetour, "an enemy must never be treated as an obstacle to walk around");
}
