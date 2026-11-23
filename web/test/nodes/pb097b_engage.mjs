// PB-097b — an attack order completes as ENGAGE inside range, not by occupying the cell.
//
// What breaks if this is removed: advance()'s enemy arm (move.mjs, the `if (occupant && !friendly)`
// block) stopped the walker one cell short, KEPT the path and re-attempted the step every round.
// A unit ordered onto an enemy-held cell therefore parked one cell short for the rest of the match,
// died at range, and the order never completed — the park-and-retry loop PB-195's trace (room 8572)
// exposed. Manual p.10 forbids sharing a cell; combat.mjs already fights any enemy inside
// `landEngageCells` (dist^2 <= 5), so occupancy was never the requirement.
//
// The legs below drive the real advance(): (a) an order onto an enemy-held cell stops at range and
// completes as ENGAGE with no retry tick, and (b) an order placed 8 cells out closes to range, then
// engages, without ever entering the cell. A third arm pins the measured range pair itself on a
// standing pair (dist^2 = 4 <= 5 fires, dist^2 = 9 >= 8 stays silent), through combat.mjs's own
// candidatesFor/resolve rather than through the move arm. A mid-path enemy is the control row: it
// still blocks and keeps the order, because the ordered destination may be reachable once that
// enemy moves.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX } from "../../server/move.mjs";
import { landPace, combatRules } from "../../server/rules.mjs";
import { distance, candidatesFor, resolve } from "../../server/combat.mjs";

export const name = "pb097b_engage";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function infantry(id, side, x, y) {
  return { id, side, kind: "infantry", domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

const cellOf = (piece) => wrapX(piece.x) + "," + Number(piece.y);
const near = (a, b) => Math.max(Math.abs(wrapX(a.x) - wrapX(b.x)), Math.abs(Number(a.y) - Number(b.y)));

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "PB-097b needs the board cells");
  const id = (x, y) => board.cells[Number(y) * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(id(x, y)) === 1;

  // An open land run of ten cells on one row: the 8-cell order needs the whole line walkable.
  let run = null;
  for (let y = 2; y < 134 && !run; y++) {
    for (let x = 2; x < 310 && !run; x++) {
      let ok = true;
      for (let k = 0; k <= 9 && ok; k++) if (!open(x + k, y)) ok = false;
      if (ok) run = { x, y };
    }
  }
  must(run, "PB-097b: no open ten-cell land run on the board, the test cannot run");
  const range = combatRules().landEngageCells;
  must(range === 2, "PB-097b: landEngageCells is " + range + ", not the measured 2");

  // ---- AC(a): ordered ONTO an enemy-held cell -> stops at range, ENGAGE, no retry tick ---------
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", run.x, run.y);
    const foe = infantry("red:wall", "red", run.x + 3, run.y);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, run.x + 3, run.y);
    must(order.ok && order.path.length === 3, "AC(a): the attack order was refused: " + JSON.stringify(order));

    let engagedAt = null;
    let blocked = 0;
    let steps = 0;
    for (let round = 1; round <= 10; round++) {
      for (const event of advance(match)) {
        if (event.type === "blocked" && event.pieceId === mover.id) blocked += 1;
        if (event.type === "move" && event.pieceId === mover.id) steps += 1;
        if (event.type === "engage" && event.pieceId === mover.id) engagedAt = { round, event };
      }
      must(cellOf(mover) !== cellOf(foe), "AC(a): round " + round + " ended the mover on the enemy's cell");
      if (engagedAt) break;
    }
    must(engagedAt, "AC(a): the attack order never completed as ENGAGE");
    must(engagedAt.event.target === foe.id, "AC(a): the engage event names " + JSON.stringify(engagedAt.event.target));
    must(near(mover, foe) <= range, "AC(a): engaged at distance " + near(mover, foe) + ", outside range " + range);
    must(near(mover, foe) === 1, "AC(a): the walker stopped " + near(mover, foe) + " cells short, wanted one");
    must(mover.path.length === 0, "AC(a): the walker kept a path after engaging: " + JSON.stringify(mover.path));
    must(mover.fighting === foe.id, "AC(a): the engaged walker recorded no target: " + JSON.stringify(mover.fighting));
    must(Number(mover.holdRounds || 0) === 0, "AC(a): an engaged walker still counts a hold: " + mover.holdRounds);
    must(blocked === 0, "AC(a): an engaging walker emitted " + blocked + " blocked/retry events");
    must(steps === 2, "AC(a): the walker took " + steps + " steps before engaging, wanted 2");

    // No retry ticks: five further rounds produce no step and no hold for the mover.
    const x = wrapX(mover.x);
    const y = Number(mover.y);
    for (let round = 1; round <= 5; round++) {
      const later = advance(match);
      must(!later.some((e) => e.pieceId === mover.id && e.type === "move"), "AC(a): the engaged walker stepped again");
      must(!later.some((e) => e.pieceId === mover.id && e.type === "blocked"), "AC(a): the engaged walker retried the step");
      must(wrapX(mover.x) === x && Number(mover.y) === y, "AC(a): the engaged walker drifted to " + cellOf(mover));
      must(Number(mover.holdRounds || 0) === 0, "AC(a): a hold was counted after the order completed");
    }
  }

  // ---- AC(b): ordered from 8 cells out -> closes to range, then ENGAGE, never occupies ---------
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", run.x, run.y);
    const foe = infantry("red:far", "red", run.x + 8, run.y);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, run.x + 8, run.y);
    must(order.ok, "AC(b): the long order was refused: " + JSON.stringify(order));
    must(distance(mover, foe) === 8, "AC(b): the pair starts at distance " + distance(mover, foe) + ", wanted 8");

    let engagedAt = null;
    let closest = Infinity;
    for (let round = 1; round <= 20; round++) {
      for (const event of advance(match)) {
        if (event.type === "engage" && event.pieceId === mover.id) engagedAt = { round, event };
      }
      closest = Math.min(closest, near(mover, foe));
      must(cellOf(mover) !== cellOf(foe), "AC(b): round " + round + " ended the mover on the enemy's cell");
      if (engagedAt) break;
    }
    must(engagedAt, "AC(b): the 8-cell attack order never completed as ENGAGE (closest " + closest + ")");
    must(engagedAt.round === 8, "AC(b): engaged on round " + engagedAt.round + ", wanted 8 (7 free cells walked, then contact)");
    must(closest === 1, "AC(b): closest approach was " + closest + ", wanted the step short of contact");
    must(mover.path.length === 0, "AC(b): the walker kept a path after engaging");
    must(wrapX(mover.x) !== wrapX(foe.x), "AC(b): the walker occupied the enemy's cell");
  }

  // ---- AC(range): the measured pair itself (frodo 8617 §4; 8574 §1) --------------------------
  // `landEngageCells` = 2, so the threshold is dist^2 <= 5. On a Chebyshev board the reachable
  // squared distances either side of 5 are 4 (dist 2 -> inside) and 9 (dist 3 -> outside): those
  // are the two values this arm pins, on a standing pair (no order), through the engine's own
  // range gate (candidatesFor) and its own exchange (resolve), not through the move arm.
  {
    must(range * range <= 5, "range pin: landEngageCells^2 = " + range * range + " is not inside the measured 5");
    const outside = range + 1;
    must(outside * outside >= 8, "range pin: (landEngageCells+1)^2 = " + outside * outside + " is not outside the measured 8");

    // inside: dist 2 (dist^2 = 4 <= 5) -> a candidate, and a real exchange.
    {
      const match = openMatch("1986");
      const a = infantry("blue:in", "blue", run.x, run.y);
      const b = infantry("red:in", "red", run.x + range, run.y);
      match.pieces = [a, b];
      match.round = 2;
      match.foughtRound = -1;
      must(distance(a, b) === range, "range pin: the inside pair stands at " + distance(a, b) + ", wanted " + range);
      must(candidatesFor(a, match.pieces).some((p) => p.id === b.id),
        "range pin: an enemy at dist^2 = " + range * range + " (<= 5) was not a candidate");
      const shots = resolve(match).filter((e) => e.type === "shot" && e.pieceId === a.id);
      must(shots.length === 1, "range pin: dist^2 = " + range * range + " produced " + shots.length + " shots, wanted 1");
    }

    // outside: dist 3 (dist^2 = 9 >= 8) -> no candidate, no shot, no contact.
    {
      const match = openMatch("1986");
      const a = infantry("blue:out", "blue", run.x, run.y);
      const b = infantry("red:out", "red", run.x + outside, run.y);
      match.pieces = [a, b];
      match.round = 2;
      match.foughtRound = -1;
      must(distance(a, b) === outside, "range pin: the outside pair stands at " + distance(a, b) + ", wanted " + outside);
      must(!candidatesFor(a, match.pieces).some((p) => p.id === b.id),
        "range pin: an enemy at dist^2 = " + outside * outside + " (>= 8) WAS a candidate");
      const events = resolve(match);
      must(!events.some((e) => e.type === "shot" || e.type === "engage"),
        "range pin: dist^2 = " + outside * outside + " fired: " + JSON.stringify(events));
      must(a.fighting === null && b.fighting === null,
        "range pin: contact recorded at dist^2 = " + outside * outside);
    }
  }

  // ---- control: a MID-PATH enemy still blocks and keeps the order (unchanged rule) ------------
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", run.x, run.y);
    const foe = infantry("red:mid", "red", run.x + 1, run.y);
    match.pieces = [mover, foe];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, run.x + 4, run.y);
    must(order.ok, "control: the order was refused: " + JSON.stringify(order));
    const pathAtStart = mover.path.length;
    let blocked = 0;
    for (let round = 1; round <= 4; round++) {
      for (const event of advance(match)) {
        if (event.type === "blocked" && event.pieceId === mover.id) blocked += 1;
        must(event.type !== "engage" || event.pieceId !== mover.id,
          "control: a mid-path enemy completed the order as ENGAGE");
      }
      must(cellOf(mover) !== cellOf(foe), "control: the mover entered the mid-path enemy's cell");
    }
    must(blocked === 1, "control: a mid-path enemy produced " + blocked + " blocked events, wanted 1 (once per hold)");
    must(mover.path.length === pathAtStart, "control: a mid-path enemy dropped the order: path " + mover.path.length + " of " + pathAtStart);
    must(wrapX(mover.x) === wrapX(run.x), "control: the mover advanced past a mid-path enemy to " + cellOf(mover));
  }

  console.log("pb097b_engage: an attack order completes as ENGAGE at range, from contact and from 8 cells out, the measured range pair is pinned (dist^2 4 fires / 9 silent), and a mid-path enemy still blocks");
}
