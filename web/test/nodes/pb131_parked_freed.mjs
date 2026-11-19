// PB-131: a unit ordered onto a cell a stationary FRIEND then occupies parks on the last free
// adjacent cell, keeps the order live, says nothing after the one blocked line, and takes the cell
// on the first free round AT ITS RATE.
//
// This is a PROOF-ONLY regression pin (openchq-pm 7439, on the red-first leg measured GREEN at
// 0f7aade in room 7443): no code changed. It drives the real move.mjs — issueOrder() plans, advance()
// walks — so it pins the actual rule and not a re-implementation of it.
//
// One shape note, because it changes how the leg is reproduced: issueOrder() already REFUSES an order
// onto an occupied cell ("Another piece holds that cell"). The only way this build reaches Q67's shape
// is a friend arriving on the destination AFTER the order exists, so every arm issues the order while
// the destination is free and then places the pinned friend on it.
//
// Rules pinned, and the line each one lives on at 0f7aade:
//   - move.mjs friendly-hold branch: noteHold(...) then `stopped = true; break;`, `piece.path` kept;
//   - move.mjs:1045 `piece.credit = stopped ? 0 : Math.max(0, credit)` — no accumulation while held;
//   - noteHold's own dedupe (`piece.heldBy`/`piece.heldCell`) — one blocked line per hold, no repeats;
//   - AC2's rate: infantry one cell, tank two per walking round, and exactly the remaining cell on the
//     first free round (no batched completion of the kept path).
import { CELL_H, CELL_W, boardPayload } from "../../server/board.mjs";
import { advance, issueOrder } from "../../server/move.mjs";
import { cellsPerRound, landPace } from "../../server/rules.mjs";

export const name = "pb131_parked_freed";

function unit(id, side, kind, x, y, extra = {}) {
  return { id, side, kind, domain: "land", x, y, strength: 10, ...extra };
}

// A horizontal run of pace-1 land on the board's own terrain, so "one cell per round" is the
// terrain's answer and not the harness assuming it.
function paceOneRun(min) {
  const grid = boardPayload().cells;
  if (!Array.isArray(grid)) return null;
  for (let y = 1; y < CELL_H - 1; y++) {
    let run = 0;
    for (let x = 0; x < CELL_W; x++) {
      const id = grid[y * CELL_W + x];
      const ok = id >= 3 && id !== 14 && landPace(id) === 1;
      run = ok ? run + 1 : 0;
      if (run >= min) {
        return { x: x - run + 1, y, ids: grid.slice(y * CELL_W + x - run + 1, y * CELL_W + x + 1) };
      }
    }
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const runCells = paceOneRun(20);
  if (!runCells) ctx.skip("no 20-cell pace-1 land run on this board");
  const X0 = runCells.x;
  const Y0 = runCells.y;

  function walk(match, rounds) {
    const trace = [];
    for (let i = 0; i < rounds; i++) {
      match.round = (Number(match.round) || 0) + 1;
      const events = advance(match);
      const a = match.pieces.find((p) => p.id === "a");
      trace.push({
        round: match.round,
        x: a.x,
        y: a.y,
        remaining: Array.isArray(a.path) ? a.path.length : 0,
        credit: Number(a.credit) || 0,
        blocked: events.filter((e) => e.type === "blocked").length,
        detour: events.filter((e) => e.type === "detour").length,
      });
    }
    return trace;
  }
  const fmt = (t) => t.map((r) => `r${r.round}:x${r.x} rem${r.remaining} cr${r.credit} blk${r.blocked}`).join(" | ");

  if (cellsPerRound({ kind: "infantry", domain: "land" }) !== 1 || cellsPerRound({ kind: "tank", domain: "land" }) !== 2) {
    fail("the rate table moved: infantry " + cellsPerRound({ kind: "infantry", domain: "land" }) +
      ", tank " + cellsPerRound({ kind: "tank", domain: "land" }));
  }

  // ---- arm 1+2: infantry, dest held 3 cells out ------------------------------------------------
  const inf = { round: 0, pieces: [unit("a", "blue", "infantry", X0, Y0)] };
  const infOrder = issueOrder(inf, "blue", "a", X0 + 3, Y0);
  inf.pieces.push(unit("f", "blue", "infantry", X0 + 3, Y0, { pinned: true }));
  if (!infOrder || infOrder.error) fail("the infantry order was refused at plan time: " + JSON.stringify(infOrder));
  const plannedInf = Array.isArray(inf.pieces.find((p) => p.id === "a").path) ? inf.pieces.find((p) => p.id === "a").path.length : -1;
  const infHeld = walk(inf, 5);
  const parkedInf = inf.pieces.find((p) => p.id === "a");
  const blockedEvents = infHeld.reduce((n, r) => n + r.blocked, 0);
  if (parkedInf.x !== X0 + 2) fail("infantry parked at x" + parkedInf.x + ", not 1 short of the held cell (x" + (X0 + 2) + "): " + fmt(infHeld));
  if (!Array.isArray(parkedInf.path) || parkedInf.path.length !== 1) {
    fail("the order did not stay live while held: " + fmt(infHeld));
  }
  if (blockedEvents !== 1) fail("expected exactly one blocked line per hold, got " + blockedEvents + ": " + fmt(infHeld));
  if (!infHeld.every((r) => r.detour === 0)) fail("a detour was invented for a held destination: " + fmt(infHeld));
  if ((Number(parkedInf.credit) || 0) !== 0) fail("credit accumulated while held: " + parkedInf.credit + ": " + fmt(infHeld));

  const f = inf.pieces.find((p) => p.id === "f");
  f.x = X0 + 10;
  f.pinned = true;
  const freed = walk(inf, 1)[0];
  if (freed.x !== X0 + 3) fail("the freed infantry did not take the cell on the first free round (x" + freed.x + "): " + fmt([freed]));
  if (freed.x - (X0 + 2) !== 1) fail("the free round moved more than the infantry rate (a jump): " + fmt([freed]));
  if (freed.remaining !== 0) fail("the order did not complete on arrival: " + fmt([freed]));

  // ---- arm 3: tank rate, park, free ------------------------------------------------------------
  const tank = { round: 0, pieces: [unit("a", "blue", "tank", X0, Y0)] };
  const tankOrder = issueOrder(tank, "blue", "a", X0 + 6, Y0);
  tank.pieces.push(unit("f", "blue", "infantry", X0 + 6, Y0, { pinned: true }));
  if (!tankOrder || tankOrder.error) fail("the tank order was refused at plan time: " + JSON.stringify(tankOrder));
  const tankHeld = walk(tank, 5);
  const parkedTank = tank.pieces.find((p) => p.id === "a");
  const tankBlocked = tankHeld.reduce((n, r) => n + r.blocked, 0);
  if (tankHeld[0].x - X0 !== 2) fail("the tank did not cover its rate on the first walking round (x" + tankHeld[0].x + "): " + fmt(tankHeld));
  if (!tankHeld.every((r) => r.detour === 0)) fail("the tank invented a detour for a held destination: " + fmt(tankHeld));
  if (tankBlocked !== 1) fail("tank: expected one blocked line across the held rounds, got " + tankBlocked + ": " + fmt(tankHeld));
  if (parkedTank.x !== X0 + 5) fail("the tank parked at x" + parkedTank.x + ", not 1 short (x" + (X0 + 5) + "): " + fmt(tankHeld));
  if ((Number(parkedTank.credit) || 0) !== 0) fail("tank credit accumulated while held: " + parkedTank.credit + ": " + fmt(tankHeld));

  const tf = tank.pieces.find((p) => p.id === "f");
  tf.x = X0 + 10;
  tf.pinned = true;
  const tankFreed = walk(tank, 1)[0];
  if (tankFreed.x !== X0 + 6) fail("the freed tank did not take the cell on the first free round (x" + tankFreed.x + "): " + fmt([tankFreed]));
  if (tankFreed.x - (X0 + 5) !== 1) fail("the freed tank batched its kept path instead of stepping the one remaining cell: " + fmt([tankFreed]));

  console.log(
    "pb131_parked_freed: board run x" + X0 + " y" + Y0 + " (terrain " + JSON.stringify(runCells.ids) + ")\n" +
      "  infantry path " + plannedInf + ": " + fmt(infHeld) + " -> freed " + fmt([freed]) + "\n" +
      "  tank: " + fmt(tankHeld) + " -> freed " + fmt([tankFreed]) + "\n" +
      "  parks adjacent, order live, one blocked line per hold, credit 0 while held, rate on the free round"
  );
}
