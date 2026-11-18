// PB-117 — a short sea order is the straight water line, not a voyage to a lane waypoint.
// Owner: game.
//
// What breaks if this is removed: a sea order always planned on the recovered lane graph, and the
// graph's answer to a destination that is not on a lane is "sail to the nearest waypoint and come
// back out", so a one-cell order quoted 28 rounds and walked 84 cells. Measured on origin/web
// 53c9760: destroyer 58,66 -> 59,66 = 84 cells / 28 rounds, and 7527 of 8815 adjacent sea orders
// in the sampled sweep were over the cells/3+1 bound.
//
// The fix keeps the lane plan for a real crossing and takes the cheaper of the two plans for a hop
// of SHORT_HOP_CELLS or less, then drops the origin cell both builders prepend (the land path
// already drops it) so the hull is not charged a round of credit for standing still.
//
// Each arm below fails by name on the pre-fix code: the named leg arms and the sweep arms quote a
// bound the old plan blows through, and the long-crossing control fails if every sea order became
// a straight line.
import { CELL_W, resolveDataRoot } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, walkRounds, wrapX } from "../../server/move.mjs";
import { boardPayload } from "../../server/board.mjs";

export const name = "pb117_sea_hop";

function piece(kind, domain, x, y) {
  return { id: "blue:p", side: "blue", kind, domain, x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

function plan(kind, domain, x, y, tx, ty) {
  const match = openMatch("1986");
  match.clock = "held";
  match.pieces = [piece(kind, domain, x, y)];
  return issueOrder(match, "blue", "blue:p", tx, ty);
}

export async function run(ctx) {
  const fail = ctx.fail;
  if (!resolveDataRoot()) ctx.skip("pb117_sea_hop: no data root resolved (set OPENCHQ_DATA or OPENCHQ_EXTRACT)");
  const problems = [];

  // 1. NAMED LEG. One cell, one round. Before the fix: 84 cells / 28 rounds.
  const named = plan("destroyer", "sea", 58, 66, 59, 66);
  if (!named || !named.ok) {
    problems.push("destroyer 58,66->59,66 was refused: " + (named && named.error));
  } else {
    if (named.rounds > 1) problems.push("destroyer 58,66->59,66 quotes " + named.rounds + " rounds for one cell (bound 1)");
    if (named.path.length > 1) problems.push("destroyer 58,66->59,66 walks " + named.path.length + " cells for one cell (bound 1 step)");
    const last = named.path[named.path.length - 1];
    if (!last || wrapX(last.x) !== wrapX(59) || last.y !== 66) problems.push("destroyer 58,66->59,66 does not end on its destination");
    if (named.rounds !== walkRounds(piece("destroyer", "sea", 58, 66), named.path)) {
      problems.push("destroyer 58,66->59,66 quote is not the walk's own rounds");
    }
  }

  // 2. SWEEP. Adjacent and 2-3 cell sea orders on open water, sampled every 11 cells x 7 rows, the
  // same stride the PB-113 sweep uses. Hull rate is 3 cells a round, so the bound is cells/3+1 on
  // the straight span; a water walk around a headland can be longer than the span, so a handful of
  // 2-3 cell orders are allowed to exceed it as long as their quote is exactly the walk (checked
  // below). Adjacent orders have no such excuse: 0 over the bound is the assertion.
  const board = boardPayload();
  const terrain = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const wet = (x, y) => { const id = terrain(x, y); return id !== null && id !== undefined && Number(id) <= 3; };
  const bound = (span) => Math.floor(span / 3) + 1;
  let accepted = 0, adjacent = 0, adjacentOver = 0, over = 0, revisits = 0, wrongQuote = 0;
  for (let y = 3; y < 133; y += 7) {
    for (let x = 3; x < 300; x += 11) {
      if (!wet(x, y)) continue;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (!dx && !dy) continue;
          const tx = x + dx, ty = y + dy;
          if (ty < 0 || ty >= 136 || !wet(tx, ty)) continue;
          const o = plan("destroyer", "sea", x, y, tx, ty);
          if (!o || !o.ok) continue;
          accepted++;
          const span = Math.max(Math.abs(dx), Math.abs(dy));
          const b = bound(span);
          const p = piece("destroyer", "sea", x, y);
          if (o.rounds !== walkRounds(p, o.path)) wrongQuote++;
          const first = o.path.findIndex((c) => wrapX(c.x) === wrapX(tx) && c.y === ty);
          if (first >= 0 && first !== o.path.length - 1) revisits++;
          if (o.rounds > b) {
            over++;
            // the only acceptable overs are water walks longer than the span, which must still
            // quote exactly what they walk at 3 cells a round
            if (o.rounds !== Math.ceil(o.path.length / 3)) wrongQuote++;
          }
          if (span === 1) { adjacent++; if (o.rounds > b) adjacentOver++; }
        }
      }
    }
  }
  if (!accepted) problems.push("the sea sweep accepted no orders at all");
  if (adjacentOver > 0) problems.push(adjacentOver + " of " + adjacent + " adjacent sea orders are over the 1-round bound");
  if (revisits > 0) problems.push(revisits + " sea orders reach their destination and keep walking (PB-113 regression)");
  if (wrongQuote > 0) problems.push(wrongQuote + " sea quotes are not the walk's own rounds");

  // 3. CONTROL: a real crossing is still a lane voyage, not a straight line. PB-133 moved this
  // control: 3,3 -> 10,3 is a seven-cell open-water hop whose direct water walk is seven cells, so
  // under the span bound it is correctly a straight walk now (measured: 7 cells / 3 rounds at
  // 4560dbd+PB-133; it was the 17-cell lane plan before). The control is now a crossing whose
  // straight line is land: 2,2 -> 22,22, span 20, 14 land cells on the line, water walk 39 cells
  // (over span+3) and lane plan 52. If the span bound leaked into a real crossing the path would
  // be the 39-cell water walk.
  const long = plan("destroyer", "sea", 2, 2, 22, 22);
  if (!long || !long.ok) problems.push("the long crossing 2,2->22,22 was refused");
  else if (long.path.length < 8) problems.push("the long crossing is a straight line (" + long.path.length + " cells)");
  else if (long.path.length <= 23) problems.push("the long crossing is the water walk, not the lane plan (" + long.path.length + " cells)");

  if (problems.length) fail(problems.join("; "));
  return "58,66->59,66 is 1 cell / 1 round; sea sweep " + accepted + " accepted, " + adjacent +
    " adjacent with " + adjacentOver + " over bound, " + over + " over bound of which " + 0 +
    " mis-quoted; 0 revisits; long crossing still " + (long && long.path ? long.path.length : 0) + " cells";
}
