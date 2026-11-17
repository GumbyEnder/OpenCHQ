// move_massed — a stack ordered at one cell keeps its orders (PB-097, PM 6415).
//
// Manual PDF p.10: "units may move through each other, though they may not stop to occupy the same
// space at the same time". The two halves of that sentence are two rules, and both are pinned here:
//
//   a. a FRIENDLY piece mid-route does not block and does not clear the path — the walker passes
//      through it and still arrives. Before PB-097 advance() cleared the path on any occupant, so
//      three tanks ordered onto a capital scattered and stood, and no attack ever reached a
//      defender.
//   b. at an OCCUPIED DESTINATION the unit keeps its order and retries every round, emitting
//      `blocked` on each of them. It never silently drops the order. (What the original does with
//      the 2nd and 3rd unit of a stack is UNVERIFIED — Open RE Question Q-new — so (b) is the rule
//      until that experiment runs.)
//
// The board is the real extract: the test finds an open land run rather than trusting a
// remembered coordinate.
import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX } from "../../server/move.mjs";
import { landPace, cellsPerRound } from "../../server/rules.mjs";

export const name = "move_massed";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function tank(id, x, y) {
  return {
    id, side: "blue", kind: "tank", domain: "land",
    x, y, path: [], credit: 0, pace: 1, strength: 100, maxStrength: 100,
    transport: false, entrenched: false, pinned: false, fighting: null,
  };
}

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "move_massed needs the board cells");
  const terrain = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(terrain(x, y)) === 1;

  // A row with ten open, coastal-free land cells. Water would turn a land piece into a transport
  // and change its rate, which is not the question here.
  let run_ = null;
  for (let y = 2; y < 134 && !run_; y++) {
    for (let x = 2; x < 308 && !run_; x++) {
      let ok = true;
      for (let k = 0; k < 10; k++) if (!open(x + k, y)) { ok = false; break; }
      if (ok) run_ = { x, y };
    }
  }
  must(run_, "no open land run of ten cells on the board: the test cannot run");

  // ---- (a) a friend mid-route does not block and does not clear the path ---------------------
  {
    const match = openMatch("1986");
    match.clock = "running";
    match.pieces = [tank("blue:t1", run_.x, run_.y), tank("blue:friend", run_.x + 1, run_.y)];
    const ordered = issueOrder(match, "blue", "blue:t1", run_.x + 5, run_.y);
    must(ordered.ok, "the order along the run must be accepted: " + JSON.stringify(ordered));
    const walker = match.pieces.find((p) => p.id === "blue:t1");
    const steps = ordered.path.length;
    const blocked = [];
    let arrivedRound = 0;
    const budget = steps * 4;
    for (let round = 1; round <= budget && !arrivedRound; round++) {
      match.round = round;
      for (const event of advance(match)) {
        if (event.pieceId === "blue:t1" && event.type === "blocked") blocked.push(round);
      }
      if (wrapX(walker.x) === wrapX(run_.x + 5) && walker.y === run_.y) arrivedRound = round;
    }
    must(arrivedRound > 0,
      "the walker did not arrive past a friendly piece standing on its line (PB-097a): " +
      JSON.stringify({ x: walker.x, y: walker.y, path: walker.path.length }));
    must(blocked.length === 0, "a friendly piece mid-route was reported as blocked: rounds " + JSON.stringify(blocked));
    const rate = cellsPerRound(tank("blue:t1", run_.x, run_.y));
    const expected = Math.ceil(steps / rate);
    must(arrivedRound === expected,
      "arrival round " + arrivedRound + " is not the credit arithmetic (" + steps + " steps at " + rate +
      "/round = " + expected + ")");
    console.log("move_massed: a friend mid-route is passed through; " + steps + " steps at " + rate +
      "/round arrived on round " + arrivedRound);
  }

  // ---- (b) three tanks onto one cell: all keep their orders, one occupies --------------------
  {
    const match = openMatch("1986");
    match.clock = "running";
    const dest = { x: run_.x + 8, y: run_.y };
    match.pieces = [
      tank("blue:t1", run_.x, run_.y),
      tank("blue:t2", run_.x + 2, run_.y),
      tank("blue:t3", run_.x + 4, run_.y),
    ];
    const orders = {};
    for (const id of ["blue:t1", "blue:t2", "blue:t3"]) {
      const plan = issueOrder(match, "blue", id, dest.x, dest.y);
      must(plan.ok && plan.path.length > 0, id + "'s order was refused: " + JSON.stringify(plan));
      // Pin the run to open ground: terrain pace would make the race depend on the bundled map.
      for (const step of match.pieces.find((p) => p.id === id).path) step.pace = 1;
      orders[id] = plan.path.length;
    }
    must(orders["blue:t1"] === 8 && orders["blue:t2"] === 6 && orders["blue:t3"] === 4,
      "the plans are not 8/6/4 steps: " + JSON.stringify(orders));

    const blockedByRound = {};
    const blockedHolds = {};
    let occupier = null;
    for (let round = 1; round <= 30; round++) {
      match.round = round;
      const events = advance(match);
      for (const event of events) {
        if (event.type === "blocked") {
          blockedByRound[event.pieceId] = blockedByRound[event.pieceId] || [];
          blockedByRound[event.pieceId].push(round);
          blockedHolds[event.pieceId] = blockedHolds[event.pieceId] || [];
          blockedHolds[event.pieceId].push({ round, by: event.by, cell: event.x + "," + event.y });
        }
      }
      const onDest = match.pieces.filter((p) => wrapX(p.x) === wrapX(dest.x) && p.y === dest.y);
      must(onDest.length <= 1, "round " + round + ": " + onDest.length + " pieces stood on the destination cell");
      if (onDest.length === 1) occupier = onDest[0].id;
      for (const p of match.pieces) {
        const d = Math.abs(wrapX(p.x) - wrapX(dest.x)) + Math.abs(p.y - dest.y);
        must(d > 0 || p.id === occupier,
          "round " + round + ": " + p.id + " stood on a cell another piece holds");
      }
    }

    must(occupier, "no tank ever occupied the destination cell");
    const pieces = Object.fromEntries(match.pieces.map((p) => [p.id, p]));
    for (const id of ["blue:t1", "blue:t2", "blue:t3"]) {
      const p = pieces[id];
      must(Boolean(p), id + " was removed from the match");
    }

    // The two that did not get in hold their order on the last cell they can legally hold — one
    // short of the destination, or two when the cell one short is itself taken by another waiter.
    // PB-122: what they may never do is END a round on a friend's cell; the stack is what forced
    // the second waiter out to two cells (the old "always exactly one short" reading).
    const waitingCells = [];
    for (const id of ["blue:t1", "blue:t2", "blue:t3"]) {
      if (id === occupier) continue;
      const p = pieces[id];
      const d = Math.abs(wrapX(p.x) - wrapX(dest.x)) + Math.abs(p.y - dest.y);
      must(d >= 1, id + " ended on the destination cell while " + occupier + " held it");
      must(d <= 2, id + " ended " + d + " cells from the destination, not on a held-short cell");
      must(p.path.length >= 1, id + " dropped its order: path is " + JSON.stringify(p.path));
      // PB-121: the hold is ONE fact. A piece presses at a new cell as the queue shuffles, and each
      // hold speaks once; the same blocker at the same cell never speaks twice. (14 frames r6..r19
      // on live was the repeat this pins against.)
      const holds = blockedHolds[id] || [];
      const keys = holds.map((hold) => hold.by + "@" + hold.cell);
      must(new Set(keys).size === keys.length,
        id + " repeated one hold instead of speaking once: " + JSON.stringify(holds));
      must(holds.length >= 1, id + " never reported its hold: " + JSON.stringify(blockedByRound[id] || []));
      waitingCells.push(wrapX(p.x) + "," + p.y);
    }
    must(new Set(waitingCells).size === waitingCells.length,
      "two waiting tanks ended on one cell: " + JSON.stringify(waitingCells));

    // And the retry is what eventually gets them in: clear the cell and the next round walks one
    // of them onto it, without a new order.
    const waiting = ["blue:t1", "blue:t2", "blue:t3"].filter((id) => id !== occupier);
    const depart = pieces[occupier];
    depart.x = run_.x;
    depart.y = run_.y;
    depart.path = [];
    match.round += 1;
    advance(match);
    const moved = waiting.filter((id) => wrapX(pieces[id].x) === wrapX(dest.x) && pieces[id].y === dest.y);
    must(moved.length === 1,
      "after the cell freed " + moved.length + " waiting tanks walked in, expected exactly 1: " +
      JSON.stringify(waiting.map((id) => ({ id, x: pieces[id].x, y: pieces[id].y, path: pieces[id].path.length }))));

    console.log("move_massed: three tanks kept their orders; " + occupier + " occupies the cell; the other two " +
      "hold on the last free cells they can legally stand on and speak once per hold; one walks in the round the cell frees");
  }
}
