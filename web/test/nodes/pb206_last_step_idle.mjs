// Node test: PB-206 — a unit that spent its LAST step this round reads `moving`, not `idle`.
//
// The defect: view.stateOf() published "moving" only while `path.length > 0`, so the one round in
// which a unit completed its move — path emptied, `movedRound` stamped by the walker — came out as
// "idle". `state` is one of the five words the unit list shows, so a hand-check that asks "did
// that unit move" read the wrong answer in the round that mattered (the PM's 8662 read was
// reported as "an idle RED id at a new cell"; movement is not the PB-207 identity defect, but the
// word was still wrong).
//
// What breaks if this is removed: `stateOf` stops consulting `movedThisRound()` and every unit
// that just finished a move reads idle for a round, which is exactly the pre-fix behaviour. The
// second half of the pin (a unit that did NOT move this round still reads idle) is what stops the
// fix from making every unit permanently "moving".
//
// The walker's own stamp is the witness: `piece.movedRound` is written at move.mjs:1261 on each
// real step (and air.mjs:493 for a flown mission), and `movedThisRound()` reads that field.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, wrapX } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "pb206_last_step_idle";

function seatPiece(match, id) {
  const view = forSeat(match, "blue");
  return (view.pieces || []).find((piece) => piece.id === id) || null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!board || !Array.isArray(board.cells)) fail("pb206 needs the board cells: " + board.source);
  if (board.cells.length !== board.width * (board.height || 136) && board.cells.length !== CELL_W * 136) {
    fail("pb206: board cell count " + board.cells.length);
  }

  const match = openMatch("1986");
  const walker = match.pieces.find((unit) => unit.id === "blue:land");
  if (!walker) fail("1986 has no blue:land piece: " + JSON.stringify(match.pieces.map((p) => p.id)));

  // A one-step land order east of the opening piece. Same cell `orders` uses, so the ground is
  // known open; the pace comes from the path the order cuts, never from a number here.
  const from = { x: wrapX(walker.x), y: walker.y };
  const to = { x: from.x + 1, y: from.y };
  const ordered = issueOrder(match, "blue", "blue:land", to.x, to.y);
  if (!ordered || !ordered.ok) fail("pb206: the one-step order was refused: " + JSON.stringify(ordered));
  if (!Array.isArray(ordered.path) || ordered.path.length !== 1) {
    fail("pb206: a one-cell order is not one step: " + JSON.stringify(ordered.path));
  }

  match.clock = "running";

  // Control 1: a path in hand already reads moving (this half passed before the fix).
  const withPath = seatPiece(match, "blue:land");
  if (!withPath) fail("pb206: blue:land is absent from blue's own view");
  if (withPath.state !== "moving") fail("pb206: a piece carrying 1 step reads " + JSON.stringify(withPath.state));

  // The round that spends the last step.
  tickMatch(match);
  if (walker.path.length !== 0) fail("pb206: the walker kept " + walker.path.length + " steps after its only step");
  const stepRound = Number(match.round);
  if (Number(walker.movedRound) !== stepRound) {
    fail("pb206: the walker stamped movedRound=" + JSON.stringify(walker.movedRound) +
      " on round " + match.round + " — the pin is reading the wrong field");
  }

  // THE ASSERTION the card is about: empty path, moved this round -> "moving".
  const afterStep = seatPiece(match, "blue:land");
  if (!afterStep) fail("pb206: blue:land is absent from blue's own view after its step");
  if (afterStep.state !== "moving") {
    fail("pb206: a unit that spent its last step on round " + match.round +
      " reads " + JSON.stringify(afterStep.state) + " (want \"moving\")");
  }

  // Control 2: the next round it did not move, so it must read idle — the fix must not make every
  // unit permanently moving.
  tickMatch(match);
  if (Number(walker.movedRound) >= Number(match.round)) {
    fail("pb206: the walker re-stamped movedRound=" + walker.movedRound + " on round " + match.round);
  }
  const nextRound = seatPiece(match, "blue:land");
  if (!nextRound) fail("pb206: blue:land is absent from blue's own view on the next round");
  if (nextRound.state !== "idle") {
    fail("pb206: a unit that did not move on round " + match.round + " reads " +
      JSON.stringify(nextRound.state) + " (want \"idle\")");
  }

  // Control 3: a piece that never moved at all reads idle (the field is absent, not stale).
  const still = match.pieces.find((unit) => unit.side === "blue" && unit.id !== "blue:land" && !unit.path?.length);
  if (still) {
    const view = seatPiece(match, still.id);
    if (view && view.state !== "idle") {
      fail("pb206: a never-moved piece reads " + JSON.stringify(view.state) + " on round " + match.round);
    }
  }

  console.log("pb206_last_step_idle: blue:land reads moving on its step round (" + stepRound +
    ") and idle on the next, from the walker's own movedRound stamp");
}
