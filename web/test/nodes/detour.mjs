// detour — a straight line is a straight line. There is no going round.
//
// What fails if this is removed:
//   - advance() re-routes a piece whose next cell is held by a friend   -> the walker would be an
//     A* again, and a land route would bend around terrain, which is the game T-004 removed
//   - a blocked piece stops one short and drops its order              -> it would walk through a
//     friendly piece, i.e. two units on one cell
//   - an ENEMY in the way is never a detour                             -> contact is combat's job
//
// T-004 replaced the A* the older version of this test pinned. The behaviour it asserted (a piece
// finding its way round a friend) is exactly what the original does not do: a move is a Bresenham
// line with no obstacle search (RULES.md section 2). This test pins that instead.
//
// The board is the real extract: the test finds an open land run on it rather than trusting a
// remembered coordinate.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX, bresenham } from "../../server/move.mjs";
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

  // ---- the order is the straight line, not a search --------------------------------------
  walker.x = run.x;
  walker.y = run.y;
  walker.path = [];
  const ordered = issueOrder(match, "blue", walker.id, run.x + 4, run.y);
  must(ordered.ok, "the order along the run must be accepted: " + JSON.stringify(ordered));
  const expected = bresenham({ x: run.x, y: run.y }, { x: run.x + 4, y: run.y }).slice(1);
  must(ordered.path.length === expected.length,
    "the order is " + ordered.path.length + " steps, the straight line is " + expected.length);
  for (let i = 0; i < expected.length; i++) {
    must(ordered.path[i].x === expected[i].x && ordered.path[i].y === expected[i].y,
      "step " + i + " is " + ordered.path[i].x + "," + ordered.path[i].y + " not " + expected[i].x + "," + expected[i].y);
  }

  // ---- a friend standing on the line stops the piece one short, and it stays stopped -------
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
      if (event.pieceId !== walker.id) continue;
      if (event.type === "detour") detours += 1;
      if (event.type === "blocked") blocked += 1;
    }
    if (wrapX(walker.x) === wrapX(run.x + 4) && walker.y === run.y) arrived = true;
    // It must never stand on the friend's cell, whatever happens.
    must(!(wrapX(walker.x) === wrapX(run.x + 1) && walker.y === run.y),
      "the walker stood on a friendly piece's cell");
  }
  must(!arrived, "a straight line has no way round a friend, so the piece cannot arrive");
  must(detours === 0, "a friend in the way was routed around: the walker is searching again");
  must(blocked >= 1, "a friend in the way was not reported as blocked");
  must(walker.path.length === 0, "a blocked piece kept its order: " + JSON.stringify(walker.path));

  // ---- an enemy in the way is contact, not an obstacle -------------------------------------
  walker.x = run.x;
  walker.y = run.y;
  walker.path = [];
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

  console.log("detour: straight line " + expected.length + " steps; a friend blocks and is not routed around; an enemy is contact");
}
