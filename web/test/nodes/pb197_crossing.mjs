// PB-197 — two same-side walkers whose paths cross must pass each other, not deadlock.
//
// What breaks if this is removed: advance()'s per-step check (move.mjs, canStepInto) asked the
// walker to be able to leave a FRIEND's cell inside the same round, and answered "no" for both
// walkers at once. A at 78,45 walking west through 77,45 and B at 77,45 walking east through
// 78,45 each held the other, both kept `state: moving`, and neither moved for 37 rounds (PB-197).
// Manual p.10: "units may move through each other, though they may not stop to occupy the same
// space at the same time" — a crossing is legal when each leaves the shared cell in that round.
//
// The legs below drive the real advance(): a crossing pair (AC1), a stationary friend mid-path and
// a held destination (AC2), and an enemy in the way as the control row (AC4).

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX, pieceState } from "../../server/move.mjs";
import { landPace } from "../../server/rules.mjs";

export const name = "pb197_crossing";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function infantry(id, side, x, y) {
  return { id, side, kind: "infantry", domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

function cellOf(piece) {
  return wrapX(piece.x) + "," + Number(piece.y);
}

export async function run(ctx) {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "PB-197 needs the board cells");
  const cell = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(cell(x, y)) === 1;

  // An open land run of eight cells, with open ground above and below its middle four so the
  // stationary-friend leg can route round without the map deciding the answer.
  let run = null;
  for (let y = 2; y < 134 && !run; y++) {
    for (let x = 2; x < 316 && !run; x++) {
      let ok = true;
      for (let k = -1; k < 7 && ok; k++) if (!open(x + k, y)) ok = false;
      for (let k = 0; k < 4 && ok; k++) if (!open(x + k, y - 1) || !open(x + k, y + 1)) ok = false;
      if (ok) run = { x, y };
    }
  }
  must(run, "PB-197: no open land run on the board, the test cannot run");

  // ---- AC1: crossing paths, both arrive, never a shared round-end cell --------------------
  {
    const match = openMatch("1986");
    const a = infantry("blue:a", "blue", run.x + 1, run.y);
    const b = infantry("blue:b", "blue", run.x, run.y);
    match.pieces = [a, b];
    match.round = 1;
    const orderA = issueOrder(match, "blue", a.id, run.x - 2, run.y);
    must(orderA.ok && orderA.path.length > 0, "AC1: the westbound order was refused: " + JSON.stringify(orderA));
    const orderB = issueOrder(match, "blue", b.id, run.x + 4, run.y);
    must(orderB.ok && orderB.path.length > 0, "AC1: the eastbound order was refused: " + JSON.stringify(orderB));
    const steps = Math.max(orderA.path.length, orderB.path.length);
    const limit = steps + 2;

    const arrived = new Map();
    for (let round = 1; round <= limit + 6; round++) {
      advance(match);
      const cellA = cellOf(a);
      const cellB = cellOf(b);
      must(cellA !== cellB, "AC1: round " + round + " ended with both units on " + cellA +
        " (states " + pieceState(a, match) + "/" + pieceState(b, match) + ")");
      if (a.path.length === 0 && !arrived.has(a.id)) arrived.set(a.id, round);
      if (b.path.length === 0 && !arrived.has(b.id)) arrived.set(b.id, round);
    }
    must(arrived.has(a.id) && arrived.has(b.id),
      "AC1: a crossing pair never both arrived within " + (limit + 6) + " rounds (arrived: " +
      JSON.stringify([...arrived]) + ", paths " + a.path.length + "/" + b.path.length + ")");
    must(arrived.get(a.id) <= limit && arrived.get(b.id) <= limit,
      "AC1: a crossing pair took longer than N+2 = " + limit + " rounds (" + JSON.stringify([...arrived]) + ")");
    must(wrapX(a.x) === wrapX(run.x - 2) && Number(a.y) === run.y,
      "AC1: the westbound walker ended at " + cellOf(a) + ", not " + (run.x - 2) + "," + run.y);
    must(wrapX(b.x) === wrapX(run.x + 4) && Number(b.y) === run.y,
      "AC1: the eastbound walker ended at " + cellOf(b) + ", not " + (run.x + 4) + "," + run.y);
    must(a.path.length === 0 && b.path.length === 0, "AC1: a walker arrived with its path still on");
    console.log("pb197 crossing: " + JSON.stringify([...arrived]) + " rounds, N+2 = " + limit);
  }

  // ---- AC2a: a stationary friend mid-path is passed (or walked around), never stopped on ---
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", run.x, run.y);
    const friend = infantry("blue:stood", "blue", run.x + 2, run.y);
    match.pieces = [mover, friend];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, run.x + 4, run.y);
    must(order.ok, "AC2a: the order past a stationary friend was refused: " + JSON.stringify(order));
    let arrivedRound = 0;
    for (let round = 1; round <= 16; round++) {
      advance(match);
      const here = cellOf(mover);
      must(here !== cellOf(friend), "AC2a: round " + round + " ended the mover on the stationary friend's cell " + here);
      if (mover.path.length === 0) { arrivedRound = round; break; }
    }
    must(arrivedRound > 0, "AC2a: the mover never got past a stationary friend (at " + cellOf(mover) + ", path " + mover.path.length + ")");
    must(wrapX(mover.x) === wrapX(run.x + 4), "AC2a: the mover ended at " + cellOf(mover) + ", not at its destination");
  }

  // ---- AC2b: a held destination is never entered; the walker stops one cell short --------
  // A human order is kept (PB-097b / move_massed: the retry is the contract until Q-new), so the
  // mover stands exactly one cell short of the friend for as long as the friend stays. The bot is
  // the seat that re-plans after more than three blocked rounds (pb197_bot_replan).
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", run.x, run.y);
    match.pieces = [mover];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, run.x + 4, run.y);
    must(order.ok, "AC2b: the order onto a free destination was refused: " + JSON.stringify(order));
    // The friend arrives AFTER the order, which is the live race (planOrder refuses a held cell).
    const friend = infantry("blue:late", "blue", run.x + 4, run.y);
    match.pieces.push(friend);
    for (let round = 1; round <= 12; round++) {
      advance(match);
      must(cellOf(mover) !== cellOf(friend), "AC2b: round " + round + " ended the mover on the held destination");
    }
    must(wrapX(mover.x) !== wrapX(run.x + 4), "AC2b: the mover stopped on the held destination");
    must(Math.abs(wrapX(mover.x) - wrapX(run.x + 4)) === 1, "AC2b: the mover stopped " +
      Math.abs(wrapX(mover.x) - wrapX(run.x + 4)) + " cells short, wanted exactly one");
    must(mover.path.length === 1, "AC2b: the held order was not kept for the retry (path " + mover.path.length + ")");
    must(wrapX(mover.x) === wrapX(run.x + 3), "AC2b: the mover did not settle one cell short (at " + cellOf(mover) + ")");
    must(Number(mover.holdRounds || 0) > 0, "AC2b: the held counter never rose; the bot could not see the stall");
  }

  // ---- AC4: an enemy still blocks, exactly as before (control row) -------------------------
  {
    const match = openMatch("1986");
    const mover = infantry("blue:mover", "blue", run.x, run.y);
    match.pieces = [mover];
    match.round = 1;
    const order = issueOrder(match, "blue", mover.id, run.x + 4, run.y);
    must(order.ok, "AC4: the order was refused: " + JSON.stringify(order));
    const foe = infantry("red:wall", "red", run.x + 1, run.y);
    match.pieces.push(foe);
    let blocked = 0;
    const pathAtStart = mover.path.length;
    for (let round = 1; round <= 6; round++) {
      for (const event of advance(match)) {
        if (event.type === "blocked" && event.pieceId === mover.id) blocked += 1;
      }
      must(cellOf(mover) !== cellOf(foe), "AC4: the mover entered the enemy's cell");
    }
    must(wrapX(mover.x) === wrapX(run.x), "AC4: an enemy no longer blocks: the mover reached " + cellOf(mover));
    must(blocked > 0, "AC4: an enemy in the way produced no blocked event");
    must(mover.path.length === pathAtStart, "AC4: an enemy dropped the order (path " + mover.path.length + ")");
  }

  console.log("pb197_crossing: crossing pair passes, a standing friend is passed, a held destination stops one short, an enemy still blocks");
}
