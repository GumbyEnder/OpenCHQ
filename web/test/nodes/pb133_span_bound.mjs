// PB-133 — a sea hop longer than 3 cells takes the direct water walk, not a lane detour.
// Owner: game.
//
// What breaks if this is removed: PB-117 built the direct water walk only when the hop was
// SHORT_HOP_CELLS (3) or less, so a 5-cell order over open water was the lane plan alone. Measured
// on origin/web 4560dbd (the PB-123 ship): cruiser 95,44 -> 100,44 quoted 5 rounds but walked 15
// cells, starting WEST (94,44) with the target due EAST; the sweep below found 416 of 967 five-cell
// orders starting west, 401 of them with an unblocked straight water line.
//
// The rule (PM 7001 item 3, "SPAN BOUND, not a bigger constant"): build the direct water walk for
// EVERY sea hop, and take it when the walk is within SHORT_HOP_CELLS of the straight-line span
// (walk <= span + 3). Otherwise the lane plan is the voyage. The lane plan is built for every hop
// so the over-bound case has a plan, and a lane plan that is genuinely shorter than the walk still
// wins (a lane route can pass through the destination early; stopAtDestination cuts it there).
//
// Each arm fails by name on the pre-fix code: the 5-cell arm quotes the 15-cell lane plan, the
// span+3 arm quotes the 18-cell lane plan, the span+4 arm quotes the 9-cell walk, the long-crossing
// arm quotes the 39-cell walk, and the sweep arm reports the 416 west starts.
import { CELL_W, CELL_H, boardPayload, resolveDataRoot } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { planOrder, walkRounds, wrapX, wrapDelta, bresenham } from "../../server/move.mjs";
import { seaRoute, waterStepRoute } from "../../server/lanes.mjs";

export const name = "pb133_span_bound";

const SHORT_HOP_CELLS = 3;

function piece(x, y) {
  return { id: "blue:p", side: "blue", kind: "cruiser", domain: "sea", x, y, path: [], credit: 0,
    pace: 1, strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false,
    fighting: null };
}

function plan(x, y, tx, ty) {
  const match = openMatch("1942");
  match.clock = "held";
  match.pieces = [piece(x, y)];
  return planOrder(match, "blue", "blue:p", tx, ty);
}

function trim(cells, x, y) {
  if (!Array.isArray(cells) || !cells.length) return null;
  const out = wrapX(cells[0].x) === wrapX(x) && Number(cells[0].y) === Number(y) ? cells.slice(1) : cells;
  return out.length ? out : null;
}

function stopAt(cells, tx, ty) {
  if (!Array.isArray(cells) || cells.length < 3) return cells;
  const at = cells.findIndex((s) => wrapX(s.x) === wrapX(tx) && s.y === Number(ty));
  if (at < 0 || at === cells.length - 1) return cells;
  return cells.slice(0, at + 1);
}

export async function run(ctx) {
  const fail = ctx.fail;
  if (!resolveDataRoot()) ctx.skip("pb133_span_bound: no data root resolved (set OPENCHQ_DATA or OPENCHQ_EXTRACT)");
  const problems = [];
  const board = boardPayload();
  const terrain = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const wet = (x, y) => { const id = terrain(x, y); return id !== null && id !== undefined && Number(id) <= 2; };
  const root = resolveDataRoot();

  const contiguous = (path) => path.every((c, i) => i === 0 ||
    (Math.abs(wrapDelta(path[i - 1].x, c.x)) <= 1 && Math.abs(c.y - path[i - 1].y) <= 1));
  const endsOn = (path, tx, ty) => path.length > 0 &&
    wrapX(path[path.length - 1].x) === wrapX(tx) && path[path.length - 1].y === Number(ty);
  const allWet = (path) => path.every((c) => wet(c.x, c.y));

  // 1. AC1. A 5-cell open-water order is the direct water walk, and the quote is the walk's own
  // rounds. Pre-fix: 15 cells / 5 rounds (the lane plan), first step WEST.
  {
    const x = 95, y = 44, tx = 100, ty = 44;
    const span = Math.max(Math.abs(wrapDelta(x, tx)), Math.abs(ty - y));
    const walk = trim(waterStepRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const lane = trim(seaRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const o = plan(x, y, tx, ty);
    if (!o || !o.ok) problems.push("the 5-cell open-water order 95,44->100,44 was refused: " + (o && o.error));
    else {
      if (!walk) problems.push("the 5-cell order has no direct water walk to compare against");
      else if (o.path.length !== walk.length) {
        problems.push("a 5-cell open-water order still takes the lane plan: 95,44->100,44 walks " +
          o.path.length + " cells / " + o.rounds + " rounds (the direct water walk is " + walk.length + ")");
      }
      if (o.path.length !== span) problems.push("the 5-cell order walks " + o.path.length + " cells for a span of " + span);
      if (!allWet(o.path)) problems.push("the 5-cell order's path leaves the water");
      if (!contiguous(o.path)) problems.push("the 5-cell order's path is not one cell at a time");
      if (!endsOn(o.path, tx, ty)) problems.push("the 5-cell order does not end on its destination");
      if (o.rounds !== walkRounds(piece(x, y), o.path)) problems.push("the 5-cell quote is not the walk's own rounds");
      if (lane && o.path.length === lane.length && lane.length !== walk.length) {
        problems.push("the 5-cell order is the lane plan (" + lane.length + " cells), not the walk");
      }
    }
  }

  // 2. AC1 boundary, inclusive at span+3. 92,5 -> 92,11: span 6, the straight line crosses land,
  // the water walk is 9 cells (span+3) and the lane plan is 37. The walk must be taken. (73,13 ->
  // 78,13 is also span+3 but its lane plan passes through the destination and stopAtDestination
  // cuts it to the same 8 cells, so it cannot tell the two plans apart.)
  {
    const x = 92, y = 5, tx = 92, ty = 11;
    const span = Math.max(Math.abs(wrapDelta(x, tx)), Math.abs(ty - y));
    const walk = trim(waterStepRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const lane = trim(seaRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const o = plan(x, y, tx, ty);
    if (!walk || walk.length !== span + SHORT_HOP_CELLS) {
      problems.push("the span+3 fixture moved: 92,5->92,11 water walk is " + (walk ? walk.length : "null") +
        " cells, expected " + (span + SHORT_HOP_CELLS));
    } else if (!o || !o.ok) {
      problems.push("the span+3 order 92,5->92,11 was refused: " + (o && o.error));
    } else if (o.path.length !== walk.length) {
      problems.push("the span+3 boundary is not inclusive: 92,5->92,11 walks " + o.path.length +
        " cells (the " + walk.length + "-cell water walk is within span+3" +
        (lane ? "; the lane plan is " + lane.length : "") + ")");
    }
  }

  // 3. AC1 boundary, exclusive at span+4. 8,23 -> 13,23: span 5, the water walk is 9 cells (span+4)
  // and the lane plan is 13. The lane plan must be taken.
  {
    const x = 8, y = 23, tx = 13, ty = 23;
    const span = Math.max(Math.abs(wrapDelta(x, tx)), Math.abs(ty - y));
    const walk = trim(waterStepRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const lane = trim(seaRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const laneStopped = lane ? stopAt(lane, tx, ty) : null;
    const o = plan(x, y, tx, ty);
    if (!walk || walk.length !== span + SHORT_HOP_CELLS + 1) {
      problems.push("the span+4 fixture moved: 8,23->13,23 water walk is " + (walk ? walk.length : "null") +
        " cells, expected " + (span + SHORT_HOP_CELLS + 1));
    } else if (!laneStopped) {
      problems.push("the span+4 fixture has no lane plan to fall back to");
    } else if (!o || !o.ok) {
      problems.push("the span+4 order 8,23->13,23 was refused: " + (o && o.error));
    } else if (o.path.length !== laneStopped.length) {
      problems.push("the span+4 boundary is not exclusive: 8,23->13,23 walks " + o.path.length +
        " cells (the " + walk.length + "-cell water walk is over span+3; the lane plan is " +
        laneStopped.length + ")");
    }
  }

  // 4. AC2. A real crossing still follows the lane graph. 2,2 -> 22,22: span 20, the straight line
  // crosses 14 land cells, the water walk is 39 cells (over span+3) and the lane plan is 52.
  {
    const x = 2, y = 2, tx = 22, ty = 22;
    const span = Math.max(Math.abs(wrapDelta(x, tx)), Math.abs(ty - y));
    const walk = trim(waterStepRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const lane = trim(seaRoute(root, { x, y }, { x: tx, y: ty }), x, y);
    const laneStopped = lane ? stopAt(lane, tx, ty) : null;
    const o = plan(x, y, tx, ty);
    if (!o || !o.ok) problems.push("the long crossing 2,2->22,22 was refused: " + (o && o.error));
    else {
      if (o.path.length <= span + SHORT_HOP_CELLS) {
        problems.push("a long crossing is a straight line: 2,2->22,22 walks " + o.path.length +
          " cells for a span of " + span + " (the lane plan is " + (laneStopped ? laneStopped.length : "null") + ")");
      }
      if (laneStopped && o.path.length !== laneStopped.length) {
        problems.push("the long crossing is not the lane plan: 2,2->22,22 walks " + o.path.length +
          " cells, the lane plan is " + laneStopped.length);
      }
      if (!allWet(o.path)) problems.push("the long crossing's path leaves the water");
      if (!contiguous(o.path)) problems.push("the long crossing's path is not one cell at a time");
      if (!endsOn(o.path, tx, ty)) problems.push("the long crossing does not end on its destination");
    }
  }

  // 5. AC2/AC4. PB-117's named leg is untouched: destroyer 58,66 -> 59,66 is 1 cell / 1 round.
  {
    const o = plan(58, 66, 59, 66);
    if (!o || !o.ok) problems.push("destroyer 58,66->59,66 was refused: " + (o && o.error));
    else {
      if (o.path.length !== 1) problems.push("destroyer 58,66->59,66 walks " + o.path.length + " cells (bound 1)");
      if (o.rounds !== 1) problems.push("destroyer 58,66->59,66 quotes " + o.rounds + " rounds (bound 1)");
      if (!endsOn(o.path, 59, 66)) problems.push("destroyer 58,66->59,66 does not end on its destination");
    }
  }

  // 6. AC3. The sweep: every water cell on a 5-cell stride, target 5 cells east, 1942 cruiser. A
  // surviving "starts west with the target east" is allowed only when the straight walk is blocked
  // (land on the line, or no water walk) or the walk is longer than the lane plan. Pre-fix: 416
  // west starts, 401 of them unexplained.
  {
    let sampled = 0, accepted = 0, west = 0, unexplained = 0;
    const bad = [];
    for (let y = 3; y < CELL_H - 3; y += 5) {
      for (let x = 3; x < CELL_W - 3; x += 5) {
        if (!wet(x, y)) continue;
        const tx = x + 5, ty = y;
        if (!wet(tx, ty)) continue;
        sampled++;
        const o = plan(x, y, tx, ty);
        if (!o || !o.ok) continue;
        accepted++;
        const first = o.path[0];
        if (!first || wrapDelta(x, first.x) >= 0) continue;
        west++;
        const line = bresenham({ x, y }, { x: tx, y: ty });
        const lineLand = line.filter((c) => !wet(c.x, c.y)).length;
        const walk = trim(waterStepRoute(root, { x, y }, { x: tx, y: ty }), x, y);
        const lane = trim(seaRoute(root, { x, y }, { x: tx, y: ty }), x, y);
        const laneStopped = lane ? stopAt(lane, tx, ty) : null;
        const blocked = lineLand > 0 || walk === null;
        const longerThanLane = walk !== null && laneStopped !== null && walk.length > laneStopped.length;
        if (!blocked && !longerThanLane) {
          unexplained++;
          if (bad.length < 4) bad.push(x + "," + y + "->" + tx + "," + ty + " walk " +
            (walk ? walk.length : "null") + " lane " + (laneStopped ? laneStopped.length : "null"));
        }
      }
    }
    if (!sampled) problems.push("the five-cell sea sweep sampled no water cells");
    if (!accepted) problems.push("the five-cell sea sweep accepted no orders at all");
    if (west > 4) problems.push(west + " of " + accepted + " five-cell sea orders start west with the target east (bound 4)");
    if (unexplained > 0) problems.push(unexplained + " west starts are unexplained by a blocked straight walk or a longer lane plan: " + bad.join("; "));
  }

  if (problems.length) fail(problems.join("; "));
  return "5-cell open water is the direct walk; span+3 walks, span+4 falls to lanes; long crossing is the lane plan; 58,66->59,66 is 1/1; sweep west starts within bound";
}
