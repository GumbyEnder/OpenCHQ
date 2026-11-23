// pb191 self-order - an order whose destination is the piece's own cell is refused, not acked.
//
// What fails if this is removed:
//   - a march to the cell the piece already stands on comes back {ok:true, rounds:0} and the page
//     says "Order sent. That piece is already on that cell."      -> the player reads an accepted
//     order for a click that moved nothing, and the ack clears the selection (PB-191)
//   - issueOrder clears entrench, repair, pin, stillRounds and fightRounds BEFORE it looks at the
//     empty path, so a no-op order still costs the unit its dug-in state   -> a click on the unit's
//     own cell silently un-entrenches it, which is the one thing an order is allowed to do
//   - the seam is not wrapped: a piece at x=319 ordered to x=0 is the same column           -> the
//     guard is skippable by clicking the wrap copy of the cell
//
// The refusal lives in planOrder so the hover preview and the real order cannot disagree: the
// preview a player reads before clicking says the same sentence the order would be refused with.

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch, eraOf } from "../../server/match.mjs";
import { issueOrder, planOrder } from "../../server/move.mjs";

// The board's width is the server's own CELL_W when it is exported; 320 is the map the 1986 era
// bakes. The seam test only needs the wrap column, so it is read here rather than imported.
const SEAM_W = 320;

export const name = "pb191 self-order";

export async function run(ctx) {
  const { fail } = ctx;
  const era = eraOf("1986");
  const sites = matchSites(era, boardPayload());
  const match = openMatch(era, sites, {});
  const piece = (match.pieces || []).find((unit) => unit && String(unit.side) === "blue");
  if (!piece) {
    match.pieces.push({ id: "pb191-inf", side: "blue", kind: "infantry", x: 40, y: 40, strength: 1, path: [] });
  }
  const unit = (match.pieces || []).find((candidate) => candidate && String(candidate.side) === "blue");
  const own = { x: Number(unit.x), y: Number(unit.y) };

  // ---- AC (a): the preview refuses the cell the piece stands on ------------------------------
  const preview = planOrder(match, "blue", unit.id, own.x, own.y);
  if (!preview || !preview.error) {
    fail("pb191: planOrder still plans a walk to the piece's own cell " + JSON.stringify(preview));
  }
  if (String(preview.error) !== "That piece is already on that cell.") {
    fail("pb191: the refusal sentence changed: " + JSON.stringify(preview.error));
  }

  // ---- AC (b): the order is refused and nothing is written -----------------------------------
  unit.entrenched = true;
  unit.repairing = true;
  unit.pinned = true;
  unit.stillRounds = 3;
  unit.fightRounds = 2;
  unit.path = [{ x: own.x + 1, y: own.y, pace: 1 }];
  unit.pace = 2;
  const before = JSON.stringify(unit);
  const result = issueOrder(match, "blue", unit.id, own.x, own.y);
  if (!result || !result.error) {
    fail("pb191: issueOrder still accepts an order to the piece's own cell " + JSON.stringify(result));
  }
  if (JSON.stringify(unit) !== before) {
    fail("pb191: a refused self-order still wrote to the piece: before " + before + " after " + JSON.stringify(unit));
  }

  // ---- AC (c): the seam. An unwrapped coordinate (x = 320) IS column 0, so a click on cell 0 is
  // the piece's own cell; but 319 and 0 are two different cells, and 319 -> 0 is a real one-cell
  // move that the guard must not eat.
  unit.x = SEAM_W;
  unit.y = 10;
  const across = planOrder(match, "blue", unit.id, 0, 10);
  if (!across || !across.error) {
    fail("pb191: the wrapped copy of the piece's own cell is not refused " + JSON.stringify(across));
  }
  unit.x = SEAM_W - 1;
  const seamMove = planOrder(match, "blue", unit.id, 0, 10);
  if (!seamMove || seamMove.error) {
    fail("pb191: the seam's one-cell move is refused: " + JSON.stringify(seamMove));
  }

  // ---- the control: a real one-cell order still plans, so the guard did not eat the move ----
  unit.x = own.x;
  unit.y = own.y;
  const one = planOrder(match, "blue", unit.id, own.x + 1, own.y);
  if (!one || one.error) {
    fail("pb191: a one-cell order is refused now: " + JSON.stringify(one));
  } else if (!(Number(one.rounds) >= 1) || !Array.isArray(one.path) || one.path.length === 0) {
    fail("pb191: a one-cell order planned no walk: " + JSON.stringify(one));
  }
}
