// PB-122 — a walk must not END a round on a cell a friend already holds (Manual p.9-10, R-UNT-06).
//
// The shape that broke the old guard: the friendly-cell block fired only when `piece.path.length === 1`
// (the next step was the destination). A walker whose straight path crosses a STOPPED friend enters
// that cell on a pass-through step (legal, PB-097/PB-109), then its next step is the held destination,
// so it never leaves: at e6f12ab the 4-unit convergence below stacked 2 units at (100,100) from r17
// and 3 from r32 to the end of the run.
//
// This leg drives the real advance() through tickMatch and asserts, for every round r0..r60, that no
// cell carries two friendly same-layer LAND units. Pass-through mid-path stays legal: a walker that
// can leave the friend's cell in the same round still crosses it, which the crossing case pins.
//
// Coordinates are hand-placed on purpose: openMatch() with no board data treats the ground as open,
// so the leg measures the movement rule, not a baked map.
import { openMatch } from "../../server/match.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";

export const name = "pb122_convergence";

function piece(id, x, y, kind = "infantry", side = "blue") {
  return { id, side, kind, domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null, shots: 0 };
}

// Two friendly land units on one cell, on the ground layer. An embarked piece and an aircraft are not
// on that layer, so they are excluded exactly as pieceAt() excludes them.
function sharedCells(match) {
  const cells = new Map();
  for (const unit of match.pieces || []) {
    if (unit.side !== "blue") continue;
    if (unit.domain !== "land" || unit.transport === true) continue;
    const key = String(unit.x) + "," + String(unit.y);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(unit.id);
  }
  return [...cells.entries()].filter(([, ids]) => ids.length > 1);
}

function runShape(label, era, units, to, rounds, fail) {
  const match = openMatch(era);
  match.clock = "running";
  match.seats = { blue: { kind: "human" }, red: { kind: "human" } };
  const placed = units.map(([id, x, y, kind]) => piece(id, x, y, kind || "infantry"));
  // A red unit far away, so both seats exist and the clock is a real match.
  match.pieces = [...placed, piece("red:watch", 200, 120, "infantry", "red")];
  const refusals = [];
  for (const [id] of units) {
    const order = issueOrder(match, "blue", id, to.x, to.y);
    if (!order || order.error) refusals.push(id + ": " + JSON.stringify(order && order.error));
  }
  if (refusals.length) {
    fail("PB-122: " + label + " could not be ordered onto " + to.x + "," + to.y + ": " + refusals.join(" | "));
    return null;
  }
  let firstStack = null;
  const start = sharedCells(match);
  if (start.length) firstStack = { round: 0, cells: start };
  for (let i = 0; i < rounds && !firstStack; i++) {
    tickMatch(match);
    const shared = sharedCells(match);
    if (shared.length) firstStack = { round: match.round, cells: shared };
  }
  if (firstStack) {
    fail("PB-122: " + label + " ended round " + firstStack.round + " with friendly land units sharing a cell: " +
      JSON.stringify(firstStack.cells) + " — a walker must stop short of a friend's cell, not finish the round on it");
    return null;
  }
  return match;
}

export async function run(ctx) {
  const fail = ctx.fail;

  // AC2: the exact 4-unit convergence PM measured at e6f12ab (2 stacked at r17, 3 at r32..r40).
  runShape("the 4-unit convergence (tank + three infantry onto one cell)", "1942",
    [["blue:tank", 96, 100, "tank"], ["blue:inf1", 89, 100], ["blue:inf2", 85, 100], ["blue:inf3", 81, 100]],
    { x: 101, y: 100 }, 60, fail);

  // AC3: a convergence SET — four walkers from four quarters, both file eras, plus a two-into-one
  // pair and a column whose middle walker starts one cell behind a stopped friend.
  const eras = ["1942", "1986"];
  for (const era of eras) {
    runShape("four quarters converging (" + era + ")", era,
      [["blue:q1", 97, 96], ["blue:q2", 105, 96], ["blue:q3", 97, 104], ["blue:q4", 105, 104]],
      { x: 101, y: 100 }, 60, fail);
    runShape("a followed column (" + era + ")", era,
      [["blue:head", 101, 96], ["blue:mid", 101, 97], ["blue:tail", 101, 98]],
      { x: 101, y: 100 }, 60, fail);
    runShape("a pair onto one cell (" + era + ")", era,
      [["blue:p1", 95, 100], ["blue:p2", 94, 100]],
      { x: 101, y: 100 }, 60, fail);
  }

  // Pass-through mid-path is UNCHANGED (PB-097/PB-109): a walker crossing a friend's cell while it
  // has a later step to take still crosses. Assert the crossing actually happened — otherwise this
  // leg's "no stacks" would pass on a build that simply refuses every friendly cell.
  const cross = openMatch("1942");
  cross.clock = "running";
  cross.seats = { blue: { kind: "human" }, red: { kind: "human" } };
  const stander = piece("blue:stander", 100, 100);
  const walker = piece("blue:crosser", 95, 100, "tank");
  cross.pieces = [stander, walker, piece("red:watch2", 200, 120, "infantry", "red")];
  const crossOrder = issueOrder(cross, "blue", "blue:crosser", 104, 100);
  if (!crossOrder || crossOrder.error) {
    fail("PB-122: the crossing order was refused: " + JSON.stringify(crossOrder));
    return;
  }
  // Terrain sets the pace; pin the run to open ground so the crossing is the thing measured.
  for (const step of walker.path) step.pace = 1;
  walker.credit = 0;
  let crossed = false;
  for (let i = 0; i < 20; i++) {
    tickMatch(cross);
    if (wrapX(walker.x) > 100) { crossed = true; break; }
  }
  if (!crossed) {
    fail("PB-122: a walker with ground to spare never crossed the friend's cell at (100,100) — " +
      "pass-through mid-path (PB-097/PB-109) regressed");
    return;
  }
  if (walker.path.length === 0 && sharedCells(cross).length) {
    fail("PB-122: the crossing walker finished on the friend's cell: " + JSON.stringify(sharedCells(cross)));
    return;
  }

  console.log("pb122_convergence: 0 shared cells r0..r60 across the 4-unit convergence and 6 convergence shapes; " +
    "a mid-path crossing still passes through (" + walker.id + " at " + walker.x + "," + walker.y + ")");
}

// wrapX is local to move.mjs; the crossing check only needs the direction of the step, and 95 -> 104
// never wraps.
function wrapX(x) {
  return Number(x);
}
