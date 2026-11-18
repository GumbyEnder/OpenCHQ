// pb122_ac6 — a stopped friend is a cell to walk AROUND, when the ground allows it (PM 6699/6740).
//
// What fails if this is removed:
//   - the plan leg: infantry 95,100 -> 104,100 on 1986 open land with a stationary friend at
//     100,100 must ARRIVE, printing its arrival round                     -> 37ebd0d holds at 99,100
//     forever with `arrivedRound = NEVER` (measured on this exact shape)
//   - the detour must not be an optimizer: with no friend on the line the same order arrives
//     sooner or at the same round; a route found around a stopped friend that beats the straight
//     line would mean the search is planning moves the player did not give
//   - the negative leg: a pinch cell whose removal disconnects the two sides (a real one-cell
//     isthmus, found on the board and asserted here, not a remembered coordinate) -> holds
//     indefinitely, order kept, exactly ONE blocked line, never ends on the friend's cell
//   - AC1 stays green in the same run: every round below is checked for two friends on one cell
//
// The friend-steps-aside control (friend moves on round 6) is printed next to the plan leg because
// the PM's gate names r11: at 37ebd0d the walker waits for the friend and arrives r11; at the fix
// it no longer waits, so that control is expected to arrive earlier there. Arriving only when the
// friend moves is the fail; arriving while it never moves is the pass.

import { boardPayload, CELL_W, CELL_H } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX } from "../../server/move.mjs";
import { landPace, isRefused } from "../../server/rules.mjs";

export const name = "pb122_ac6";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function infantry(id, x, y) {
  return {
    id,
    side: "blue",
    kind: "infantry",
    domain: "land",
    x,
    y,
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
}

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "pb122_ac6 needs the board cells");
  const cell = (x, y) => board.cells[Number(y) * CELL_W + wrapX(x)];
  const pace = (x, y) => landPace(cell(x, y));
  const land = (x, y) => {
    const id = cell(x, y);
    return id !== null && id !== undefined && Number(id) >= 3 && !isRefused(Number(id));
  };
  const water = (x, y) => {
    const id = cell(x, y);
    return id === null || id === undefined || Number(id) <= 2;
  };

  // ---- the PM's shape: 95,100 -> 104,100 on 1986 open land, friend at 100,100 ---------------
  const Y = 100;
  const S = 95;
  const F = 100;
  const G = 104;
  must(pace(S, Y) === 1 && pace(G, Y) === 1, "the AC6 shape needs open land at 95,100 and 104,100");
  must(pace(100, 101) === 1, "the AC6 shape needs open ground below the friend's cell (100,101)");
  must(pace(101, Y) !== 1, "the AC6 shape expects 101,100 to be slow ground, so the way round is a real detour");

  function runLeg({ friendMovesOn = null, withFriend = true, rounds = 40 }) {
    const match = openMatch("1986");
    match.pieces = [];
    const walker = infantry("blue:walker", S, Y);
    const friend = infantry("blue:friend", F, Y);
    if (withFriend) match.pieces.push(friend);
    match.pieces.push(walker);
    const ordered = issueOrder(match, "blue", walker.id, G, Y);
    must(ordered.ok, "the AC6 order must be accepted: " + JSON.stringify(ordered));
    const planned = ordered.path.length;
    const crossesFriend = ordered.path.some((step) => wrapX(step.x) === F && Number(step.y) === Y);
    let blockedLines = 0;
    let arrivedRound = null;
    let stackedRound = null;
    for (let round = 0; round < rounds; round++) {
      if (friendMovesOn !== null && round === friendMovesOn) {
        friend.x = F;
        friend.y = Y - 3; // steps aside onto open ground, out of the line
      }
      for (const event of advance(match)) {
        if (event.pieceId !== walker.id || event.type !== "blocked") continue;
        blockedLines += 1;
      }
      // AC1: no round ends with two friendly land units on one cell.
      const seen = new Map();
      for (const unit of match.pieces) {
        if (unit.domain !== "land") continue;
        const key = wrapX(unit.x) + "," + Number(unit.y);
        if (seen.has(key)) stackedRound = round;
        seen.set(key, unit.id);
      }
      if (wrapX(walker.x) === G && walker.y === Y && walker.path.length === 0) {
        arrivedRound = round;
        break;
      }
    }
    return {
      planned,
      crossesFriend,
      blockedLines,
      arrivedRound,
      final: wrapX(walker.x) + "," + walker.y,
      pathLeft: walker.path.length,
      detours: Number(walker.detours || 0),
      stackedRound,
    };
  }

  // The straight line is what was ordered: the plan still crosses the friend's cell.
  const line = runLeg({ withFriend: false });
  must(line.arrivedRound !== null, "with no friend on the line the order must arrive (control)");
  must(line.detours === 0, "with no friend on the line there is nothing to detour: " + line.detours);
  const lineRound = line.arrivedRound;

  // PM gate leg (a): a stationary friend, open ground around -> re-plans, keeps the order, arrives.
  const plan = runLeg({});
  must(plan.crossesFriend, "the order must still be the straight line through the friend's cell");
  must(plan.arrivedRound !== null,
    "a stationary friend held the walker with open ground around: arrivedRound NEVER, " +
      "final " + plan.final + ", pathLeft " + plan.pathLeft + ", blocked " + plan.blockedLines);
  must(plan.stackedRound === null, "round " + plan.stackedRound + ": two friendly land units ended on one cell");
  must(plan.detours === 1, "the walker should have detoured exactly once, not " + plan.detours + " times");
  must(plan.arrivedRound >= lineRound,
    "the detour beat the straight line (" + plan.arrivedRound + " < " + lineRound +
      "): the search is planning moves the player did not give");

  // The PM's friend-steps-aside control, printed for the record (see the header: at 37ebd0d this
  // is r11; at the fix the walker leaves before the friend moves).
  const aside = runLeg({ friendMovesOn: 6 });
  must(aside.arrivedRound !== null, "the friend-steps-aside control must arrive");

  // ---- leg (b)/negative: a one-cell isthmus, no way round ----------------------------------
  // Find a cell F whose two opposite land neighbours are disconnected without it (4-neighbour
  // land graph, bounded search). That is the "walled in" shape, asserted rather than remembered.
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const key = (x, y) => wrapX(x) + "," + Number(y);
  function reachable(sx, sy, gx, gy, skip) {
    const seen = new Set([key(sx, sy)]);
    const queue = [[sx, sy]];
    let opened = 0;
    while (queue.length > 0 && opened < 6000) {
      const [x, y] = queue.shift();
      opened += 1;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        const k = key(nx, ny);
        if (k === skip || seen.has(k) || ny < 0 || ny >= CELL_H) continue;
        if (!land(nx, ny)) continue;
        if (k === key(gx, gy)) return true;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    return false;
  }

  let pinch = null;
  for (let y = 10; y < CELL_H - 10 && !pinch; y++) {
    for (let x = 2; x < CELL_W - 2 && !pinch; x++) {
      if (!land(x, y) || pace(x, y) !== 1) continue;
      const neighbours = N4.filter(([dx, dy]) => land(x + dx, y + dy) && pace(x + dx, y + dy) === 1);
      if (neighbours.length !== 2) continue;
      const [a, b] = neighbours;
      if (!(a[0] === -b[0] && a[1] === -b[1])) continue;
      const s = { x: x - 2 * a[0], y: y - 2 * a[1] };
      const g = { x: x + 2 * a[0], y: y + 2 * a[1] };
      if (!land(s.x, s.y) || !land(g.x, g.y)) continue;
      // The flanks of the pinch must be impassable land: water, not walkable ground.
      const flankA = { x: x + a[1], y: y + a[0] };
      const flankB = { x: x - a[1], y: y - a[0] };
      if (!water(flankA.x, flankA.y) || !water(flankB.x, flankB.y)) continue;
      if (reachable(s.x, s.y, g.x, g.y, key(x, y))) continue;
      pinch = { f: { x, y }, s, g };
    }
  }
  must(pinch, "no one-cell isthmus found on the board: the negative leg cannot run");
  must(pace(pinch.f.x, pinch.f.y) === 1, "the pinch cell must be walkable ground");

  const net = openMatch("1986");
  net.pieces = [];
  const held = infantry("blue:held", pinch.s.x, pinch.s.y);
  const wall = infantry("blue:wall", pinch.f.x, pinch.f.y);
  net.pieces.push(wall, held);
  const netOrder = issueOrder(net, "blue", held.id, pinch.g.x, pinch.g.y);
  must(netOrder.ok, "the negative-leg order must be accepted: " + JSON.stringify(netOrder));
  must(netOrder.path.some((step) => wrapX(step.x) === pinch.f.x && Number(step.y) === pinch.f.y),
    "the negative leg's straight line must cross the friend's cell");
  let netBlocked = 0;
  let netArrived = false;
  let netEndedOnFriend = false;
  for (let round = 0; round < 60; round++) {
    for (const event of advance(net)) {
      if (event.pieceId !== held.id || event.type !== "blocked") continue;
      netBlocked += 1;
    }
    if (wrapX(held.x) === pinch.g.x && Number(held.y) === pinch.g.y && held.path.length === 0) netArrived = true;
    if (wrapX(held.x) === pinch.f.x && Number(held.y) === pinch.f.y) netEndedOnFriend = true;
  }
  must(!netArrived, "the walker crossed a one-cell isthmus a friend was holding: there is no way round");
  must(!netEndedOnFriend, "the walker ended a round on the friend's cell in the corridor");
  must(held.path.length > 0, "the walker dropped its order when it could not get round: pathLeft 0");
  must(netBlocked === 1, "the held walker spoke " + netBlocked + " blocked lines, wanted exactly 1");

  console.log(
    "pb122_ac6: PM shape 95,100->104,100 friend at 100,100: line control r" + lineRound +
      ", detour r" + plan.arrivedRound + " (" + plan.detours + " re-plan, one blocked line " +
      plan.blockedLines + "), friend-steps-aside control r" + aside.arrivedRound +
      "; isthmus " + pinch.f.x + "," + pinch.f.y + " holds 60 rounds, order kept, 1 blocked line",
  );
}
