// PB-097b — an attack order completes as ENGAGE inside range, not by occupying the cell.
//
// What breaks if this is removed: advance()'s enemy arm (move.mjs, the `if (occupant && !friendly)`
// block) stopped the walker one cell short, KEPT the path and re-attempted the step every round.
// A unit ordered onto an enemy-held cell therefore parked one cell short for the rest of the match,
// died at range, and the order never completed — the park-and-retry loop PB-195's trace (room 8572)
// exposed. Manual p.10 forbids sharing a cell; the measured land range is landEngageCells = 2 with
// the trace note "dist^2 <= 5" (config/game.json:349), so occupancy was never the requirement.
//
// Legs (frodo room 8626 §4, PM room 8624 §2):
//   (a) an order onto an enemy-held cell from dist^2 = 9 is SILENT at 9, completes on the first
//       round it is inside dist^2 <= 5, and emits zero blocked/retry ticks afterwards;
//   (b) an order onto an enemy-held cell from offset (2,2) (dist^2 = 8) does not complete at 8 and
//       completes after the first step that brings it inside range, exactly one engage event,
//       never on the enemy's cell;
//   (t) the measured pair itself, standing: dist^2 = 5 fires, dist^2 = 8 does not;
//   (c) control — a mid-path enemy still holds the walker and keeps the order (PB-197 AC4: the
//       hold counter is the bot's re-plan trigger). 8626 §4b's "a stop inside range completes,
//       mid-path included" is NOT taken literally: it reds detour, pb197_bot_replan and
//       pb197_crossing AC4. The completion is keyed on the ordered DESTINATION being held.
// The tank-onto-INFANTRY overrun arm (p.9) is unchanged and is covered by the overrun legs.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX, squaredDistance, inEngageRange } from "../../server/move.mjs";
import { landPace, combatRules } from "../../server/rules.mjs";

export const name = "pb097b_engage";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function infantry(id, side, x, y) {
  return { id, side, kind: "infantry", domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

const cellOf = (piece) => wrapX(piece.x) + "," + Number(piece.y);

function dist2(a, b) {
  const dx = wrapX(a.x) - wrapX(b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "PB-097b needs the board cells");
  const id = (x, y) => board.cells[Number(y) * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(id(x, y)) === 1;

  // An open land block of five by five: every offset the legs use — (3,0), (2,2), (2,1), (4,0) —
  // has to be walkable for the orders to plan.
  let block = null;
  for (let y = 2; y < 130 && !block; y++) {
    for (let x = 2; x < 300 && !block; x++) {
      let ok = true;
      for (let i = 0; i <= 4 && ok; i++) for (let j = 0; j <= 4 && ok; j++) if (!open(x + i, y + j)) ok = false;
      if (ok) block = { x, y };
    }
  }
  must(block, "PB-097b: no open five-by-five land block on the board, the test cannot run");
  const range = combatRules().landEngageCells;
  must(range === 2, "PB-097b: landEngageCells is " + range + ", not the measured 2");

  // ---- the measured pair, standing: dist^2 = 5 fires, dist^2 = 8 does not ---------------------
  {
    const near = infantry("blue:near", "blue", block.x, block.y);
    const at5 = infantry("red:at5", "red", block.x + 2, block.y + 1);
    const at8 = infantry("red:at8", "red", block.x + 2, block.y + 2);
    must(dist2(near, at5) === 5, "pair: the (2,1) offset reads dist^2 = " + dist2(near, at5) + ", wanted 5");
    must(dist2(near, at8) === 8, "pair: the (2,2) offset reads dist^2 = " + dist2(near, at8) + ", wanted 8");
    must(squaredDistance(near, at5) === 5, "pair: squaredDistance disagrees on (2,1): " + squaredDistance(near, at5));
    must(inEngageRange(near, at5, range), "pair: dist^2 = 5 is NOT in engage range");
    must(!inEngageRange(near, at8, range), "pair: dist^2 = 8 IS in engage range");
  }

  // ---- (t) standing at dist^2 = 5 fires without a step ----------------------------------------
  // Placed FIRST so a mutant that re-introduces the path.length gate on the destination check
  // reds HERE: at (2,1) the remaining path is still two steps, which is exactly the gate.
  {
    const match = openMatch("1986");
    const mover = infantry("blue:thresh", "blue", block.x, block.y);
    const foe = infantry("red:thresh", "red", block.x + 2, block.y + 1);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, block.x + 2, block.y + 1);
    must(order.ok, "(t): the (2,1) order was refused: " + JSON.stringify(order));
    must(mover.path.length > 1, "(t): the (2,1) walk should be longer than one step, it is " + mover.path.length);
    const events = advance(match);
    const engaged = events.find((e) => e.type === "engage" && e.pieceId === mover.id);
    must(engaged, "(t): dist^2 = 5 did NOT complete the order (events " + JSON.stringify(events.map((e) => e.type)) + ")");
    must(!events.some((e) => e.type === "move" && e.pieceId === mover.id), "(t): dist^2 = 5 took a step first");
    must(mover.path.length === 0, "(t): the walker kept a path at dist^2 = 5");
    must(dist2(mover, foe) === 5, "(t): the standing pair drifted to dist^2 = " + dist2(mover, foe));
  }

  // ---- (a) order onto an enemy-held cell from dist^2 = 9: silent at 9, completes inside 5 ------
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", block.x, block.y);
    const foe = infantry("red:wall", "red", block.x + 3, block.y);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, block.x + 3, block.y);
    must(order.ok && order.path.length === 3, "(a) the attack order was refused: " + JSON.stringify(order));
    must(inEngageRange(mover, foe, range) === false, "(a) the pair started inside range at dist^2 = " + dist2(mover, foe));

    let engagedAt = null;
    let blocked = 0;
    let steps = 0;
    for (let round = 1; round <= 10; round++) {
      const before = dist2(mover, foe);
      const events = advance(match);
      for (const event of events) {
        if (event.type === "blocked" && event.pieceId === mover.id) blocked += 1;
        if (event.type === "move" && event.pieceId === mover.id) steps += 1;
        if (event.type === "engage" && event.pieceId === mover.id) {
          must(before <= 5, "(a) round " + round + " completed the order at dist^2 = " + before + ", outside the measured 5");
          engagedAt = { round, event };
        }
      }
      must(cellOf(mover) !== cellOf(foe), "(a): round " + round + " ended the mover on the enemy's cell");
      if (engagedAt) break;
    }
    must(engagedAt, "(a): the attack order never completed as ENGAGE");
    must(engagedAt.round === 2, "(a): completed on round " + engagedAt.round + ", wanted 2 (silent at dist^2 = 9, fires at 4)");
    must(steps === 1, "(a): the walker took " + steps + " steps, wanted 1 before completing");
    must(engagedAt.event.target === foe.id, "(a): the engage event names " + JSON.stringify(engagedAt.event.target));
    must(engagedAt.event.reach === range, "(a): the engage event carries reach " + engagedAt.event.reach);
    must(mover.path.length === 0, "(a): the walker kept a path after engaging: " + JSON.stringify(mover.path));
    must(mover.fighting === foe.id, "(a): the engaged walker recorded no target: " + JSON.stringify(mover.fighting));
    must(Number(mover.holdRounds || 0) === 0, "(a): an engaged walker still counts a hold: " + mover.holdRounds);
    must(blocked === 0, "(a): an engaging walker emitted " + blocked + " blocked/retry events");

    // No retry ticks: five further rounds produce no step and no hold for the mover.
    const x = wrapX(mover.x);
    const y = Number(mover.y);
    for (let round = 1; round <= 5; round++) {
      const later = advance(match);
      must(!later.some((e) => e.pieceId === mover.id && e.type === "move"), "(a): the engaged walker stepped again");
      must(!later.some((e) => e.pieceId === mover.id && e.type === "blocked"), "(a): the engaged walker retried the step");
      must(wrapX(mover.x) === x && Number(mover.y) === y, "(a): the engaged walker drifted to " + cellOf(mover));
      must(Number(mover.holdRounds || 0) === 0, "(a): a hold was counted after the order completed");
    }
  }

  // ---- (b) offset (2,2), dist^2 = 8: no completion at 8, one step into range completes ---------
  {
    const match = openMatch("1986");
    const mover = infantry("blue:diag", "blue", block.x, block.y);
    const foe = infantry("red:diag", "red", block.x + 2, block.y + 2);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, block.x + 2, block.y + 2);
    must(order.ok, "(b): the diagonal order was refused: " + JSON.stringify(order));
    must(dist2(mover, foe) === 8, "(b): the pair starts at dist^2 = " + dist2(mover, foe) + ", wanted 8");

    const first = advance(match);
    must(!first.some((e) => e.type === "engage" && e.pieceId === mover.id),
      "(b): the order completed at dist^2 = 8, which the measured 5 forbids");
    must(cellOf(mover) !== cellOf(foe), "(b): the first step ended the mover on the enemy's cell");
    must(dist2(mover, foe) <= 5, "(b): one step left the pair at dist^2 = " + dist2(mover, foe) + ", still outside 5");

    let engaged = null;
    let closes = 0;
    let guard = 0;
    while (!engaged && guard++ < 10) {
      const events = advance(match);
      for (const event of events) {
        if (event.type === "move" && event.pieceId === mover.id) closes += 1;
        if (event.type === "engage" && event.pieceId === mover.id) engaged = event;
      }
      must(cellOf(mover) !== cellOf(foe), "(b): the mover ended a round on the enemy's cell");
    }
    must(engaged, "(b): the diagonal attack order never completed as ENGAGE");
    must(closes === 0, "(b): completed after " + closes + " further steps, wanted the first round inside range");
    must(dist2(mover, foe) <= 5, "(b): completed at dist^2 = " + dist2(mover, foe) + ", outside 5");
    must(mover.path.length === 0, "(b): the walker kept a path after engaging");
    must(wrapX(mover.x) !== wrapX(foe.x) || Number(mover.y) !== Number(foe.y), "(b): the walker occupied the enemy's cell");
  }

  // ---- (c) control: a MID-PATH enemy still holds the walker and keeps the order (PB-197 AC4) ---
  // frodo 8626 §4b read literally ("a stop inside range completes, mid-path included") reds three
  // shipped legs — detour, pb197_bot_replan and pb197_crossing AC4 — because the hold counter IS
  // the bot's re-plan trigger. The completion is keyed on the ordered DESTINATION being held, so a
  // mid-path enemy keeps the hold and this arm pins it.
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mid", "blue", block.x, block.y);
    const foe = infantry("red:mid", "red", block.x + 1, block.y);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, block.x + 4, block.y);
    must(order.ok, "(c): the behind-the-enemy order was refused: " + JSON.stringify(order));
    const pathAtStart = mover.path.length;
    let blocked = 0;
    for (let round = 1; round <= 4; round++) {
      for (const event of advance(match)) {
        if (event.type === "blocked" && event.pieceId === mover.id) blocked += 1;
        must(event.type !== "engage" || event.pieceId !== mover.id,
          "(c): a mid-path enemy completed the order as ENGAGE");
      }
      must(cellOf(mover) !== cellOf(foe), "(c): the mover entered the mid-path enemy's cell");
    }
    must(blocked === 1, "(c): a mid-path enemy produced " + blocked + " blocked events, wanted 1 (once per hold)");
    must(mover.path.length === pathAtStart, "(c): a mid-path enemy dropped the order: path " + mover.path.length + " of " + pathAtStart);
    must(wrapX(mover.x) === wrapX(block.x), "(c): the mover advanced past a mid-path enemy to " + cellOf(mover));
    must(Number(mover.holdRounds || 0) === 4, "(c): the bot's re-plan counter reads " + mover.holdRounds + " after 4 blocked rounds");
  }

  console.log("pb097b_engage: an attack order completes as ENGAGE inside dist^2 <= 5 (silent at 8 and 9), a mid-path enemy still holds, with zero retry ticks");
}
