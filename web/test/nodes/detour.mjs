// detour — a straight line is a straight line. There is no going round.
//
// What fails if this is removed:
//   - advance() re-routes a piece whose next cell is held by a friend   -> the walker would be an
//     A* again, and a land route would bend around terrain, which is the game T-004 removed
//   - a friend on the line is passed through, with no `blocked`         -> it would become an
//     obstacle again, which PB-097's ruling (Manual p.10) forbids
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

  // ---- a friend standing on the line is passed through, not blocked (PB-097a) --------------
  // Manual p.10: "units may move through each other, though they may not stop to occupy the same
  // space at the same time". This infantry walks one cell a round, so it spends one round sharing
  // the friend's cell on its way past — the engine's round boundary is a discretisation of "passing
  // through", not a stop. What it may not do is END there: when its path empties it is one cell
  // past, at the destination. Before PB-097 any occupant cleared the path, which is how a stack
  // ordered at one cell scattered.
  match.pieces.push({
    id: "blue:blocker",
    side: "blue",
    kind: "infantry",
    domain: "land",
    x: run.x + 1,
    y: run.y,
    path: [],
  });

  // A mid-path crossing is only observable at two or more cells a round: at one cell a round the
  // round boundary always lands on the friend's cell, which PB-122 forbids ("walkers may cross a
  // friend; they may not finish a round on one"). So the runner is a tank (rate 2) and crosses the
  // friend inside one round. The infantry case is pinned by pb122_convergence instead.
  const runner = {
    id: "blue:runner",
    side: "blue",
    kind: "tank",
    domain: "land",
    x: run.x,
    y: run.y,
    path: [],
    credit: 0,
    pace: 1,
    strength: 100,
    maxStrength: 100,
    transport: false,
    entrenched: false,
    pinned: false,
    fighting: null,
  };
  match.pieces.push(runner);
  // Keep the infantry walker out of the run while the tank crosses it (it is re-placed for the
  // enemy leg below); two blues on run.x would be a stack before the test starts.
  walker.x = run.x + 40;
  walker.y = run.y + 40;
  const runOrder = issueOrder(match, "blue", runner.id, run.x + 4, run.y);
  must(runOrder.ok, "the runner's order must be accepted: " + JSON.stringify(runOrder));
  // Pace is terrain's; pin it to open ground so the leg measures the crossing, not the map.
  for (const step of runner.path) step.pace = 1;
  runner.credit = 0;

  let detours = 0;
  let blocked = 0;
  let arrived = false;
  let crossedMidPath = false;
  for (let round = 0; round < 24; round++) {
    for (const event of advance(match)) {
      if (event.pieceId !== runner.id) continue;
      if (event.type === "detour") detours += 1;
      if (event.type === "blocked") blocked += 1;
    }
    if (wrapX(runner.x) > wrapX(run.x + 1) && runner.y === run.y) crossedMidPath = true;
    if (wrapX(runner.x) === wrapX(run.x + 4) && runner.y === run.y) arrived = true;
    // A walk that has finished must not be sitting on the friend's cell.
    must(runner.path.length > 0 || !(wrapX(runner.x) === wrapX(run.x + 1) && runner.y === run.y),
      "the walker stopped on a friendly piece's cell");
    // PB-122: no round may END with the runner on the friend's cell.
    must(!(wrapX(runner.x) === wrapX(run.x + 1) && runner.y === run.y),
      "round " + round + ": the runner ended on the friend's cell");
  }
  must(arrived, "a friend on the line stopped the walker: p.10 lets it pass through");
  must(crossedMidPath, "the runner never passed the friend's cell: the crossing was not exercised");
  must(detours === 0, "a friend in the way was routed around: the walker is searching again");
  must(blocked === 0, "a friend on the line was reported as blocked: " + blocked + " times");
  must(runner.path.length === 0, "the walker arrived with its path still on: " + JSON.stringify(runner.path));

  // ---- an enemy in the way is contact, not an obstacle -------------------------------------
  match.pieces = match.pieces.filter((piece) => piece.id !== runner.id);
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
  let overlapped = false;
  for (let round = 0; round < 3; round++) {
    for (const event of advance(match)) {
      if (event.pieceId !== walker.id) continue;
      if (event.type === "blocked") sawBlocked = true;
      if (event.type === "detour") sawDetour = true;
    }
    if (wrapX(walker.x) === wrapX(foe.x) && walker.y === foe.y) overlapped = true;
  }
  // PB-195, Manual p.9: an enemy is not an obstacle to walk around, and not a wall to stop short
  // of either - the walker PRESSES IN and the two icons overlap, which is where they fight.
  must(overlapped, "an enemy in the way must be entered (overlap), not stopped short of");
  must(!sawBlocked, "an enemy in the way was reported as a hold instead of an overlap");
  must(!sawDetour, "an enemy must never be treated as an obstacle to walk around");

  console.log("detour: straight line " + expected.length + " steps; a friend on the line is passed through and never routed around; an enemy is entered and overlapped");
}
