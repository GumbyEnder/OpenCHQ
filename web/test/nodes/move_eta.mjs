// move_eta — the quoted walk is the round the unit actually lands on (PB-096, PM 6415).
//
// The order reply carries `rounds`, and the page prints it as "N rounds to walk". That number used
// to be a sum of the path's terrain paces with no cell rate in it (move.mjs), so a tank walking 2
// cells a round was quoted double its walk; and the sea arm was `path.length`, so every hull — 3
// cells a round — was quoted three times too long. An infantry crossing water has no single
// divisor at all: 1 cell a round on land, 2 as cargo.
//
// The rule this pins: `rounds` is the round the unit arrives on, measured, not derived. Every leg
// below issues a real order, walks it with advance() until the unit is standing on the destination,
// and requires the quote to equal that round. The old formulas are excluded by construction —
// each one is asserted to be different from the quote, so a silent return to them is red.
//
// The board is the real extract: each leg finds its own geometry (open run, crossing, sea lane)
// instead of trusting a remembered coordinate.
import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX, walkRounds } from "../../server/move.mjs";
import { landPace, cellsPerRound } from "../../server/rules.mjs";

export const name = "move_eta";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function piece(id, kind, domain, x, y) {
  return {
    id, side: "blue", kind, domain,
    x, y, path: [], credit: 0, pace: 1, strength: 100, maxStrength: 100,
    transport: false, entrenched: false, pinned: false, fighting: null,
  };
}

// Walk the order with the real engine and return the round the unit stands on the destination.
// The budget is generous: it must not become a second opinion on the arithmetic.
function measureArrival(match, id, tx, ty) {
  const walker = match.pieces.find((p) => p.id === id);
  for (let round = 1; round <= 400; round++) {
    match.round = round;
    advance(match);
    if (wrapX(walker.x) === wrapX(tx) && walker.y === ty) return round;
  }
  return 0;
}

// Issue, measure, and check the quote against the arrival and against the two formulas that were
// wrong. Returns the accepted order so a leg can assert on its path.
function leg(match, p, tx, ty, label, expect) {
  match.pieces = [p];
  const ordered = issueOrder(match, "blue", p.id, tx, ty);
  must(ordered.ok, label + ": the order must be accepted — " + JSON.stringify(ordered));
  const paceSum = ordered.path.reduce((sum, step) => sum + Math.max(1, Number(step.pace) || 1), 0);
  shouldEqual(walkRounds(p, ordered.path), ordered.rounds, label + ": walkRounds is the quote planOrder returns");
  const arrived = measureArrival(match, p.id, tx, ty);
  must(arrived > 0, label + ": the unit never reached the destination — the order was dropped");
  shouldEqual(ordered.rounds, arrived, label + ": quoted rounds != the round it arrives on");
  if (expect.steps !== undefined) shouldEqual(ordered.path.length, expect.steps, label + ": path length");
  // The two retired formulas. On a 1-cell-a-round walk they coincide with the truth, so only
  // assert them apart where the rate actually differs.
  if (expect.differsFromPathLength) {
    must(ordered.rounds !== ordered.path.length,
      label + ": rounds == path.length — the ship arm's old quote is back");
  }
  if (expect.differsFromPaceSum) {
    must(ordered.rounds !== paceSum,
      label + ": rounds == sum(step.pace) — the land arm's old quote is back");
  }
  return { ordered, arrived, paceSum };
}

function shouldEqual(got, want, why) {
  must(got === want, why + " (" + got + " != " + want + ")");
}

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "move_eta needs the board cells");
  const terrain = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(terrain(x, y)) === 1;
  const water = (x, y) => {
    const id = terrain(x, y);
    return id !== null && Number(id) <= 3;
  };

  // ---- geometry the legs need, found on the board ---------------------------------------------
  // A straight run of ten open land cells. Water would turn a land piece into a transport mid-run
  // and change its rate, which is the crossing leg's job, not this one's.
  let run_ = null;
  for (let y = 2; y < 134 && !run_; y++) {
    for (let x = 2; x < 306 && !run_; x++) {
      let ok = true;
      for (let k = 0; k < 10; k++) if (!open(x + k, y)) { ok = false; break; }
      if (ok) run_ = { x, y };
    }
  }
  must(run_, "no open land run of ten cells on the board: the test cannot run");

  // ---- tank: 2 cells a round, so the pace sum is double the walk ------------------------------
  {
    const match = openMatch("1986");
    match.clock = "running";
    const tank = piece("blue:t1", "tank", "land", run_.x, run_.y);
    const rate = cellsPerRound(tank);
    shouldEqual(rate, 2, "the tank rate in force is 2 cells a round (config move.cellsPerRound)");
    const { ordered, arrived } = leg(match, tank, run_.x + 7, run_.y, "tank over open land", {
      steps: 7, differsFromPaceSum: true,
    });
    shouldEqual(arrived, Math.ceil(ordered.path.length / rate), "tank: arrival is the credit arithmetic");
  }

  // ---- infantry over the same run: 1 cell a round, the control -------------------------------
  {
    const match = openMatch("1986");
    match.clock = "running";
    const infantry = piece("blue:i1", "infantry", "land", run_.x, run_.y);
    shouldEqual(cellsPerRound(infantry), 1, "the infantry rate in force is 1 cell a round");
    leg(match, infantry, run_.x + 7, run_.y, "infantry over open land", { steps: 7 });
  }

  // ---- infantry with a sea leg: land 1, cargo 2, land 1 — no single divisor exists -----------
  // Scan for an order whose line crosses enough water that seaLeg builds a crossing. The rate in
  // force changes at the water's edge, which is exactly what a divisor cannot express.
  let crossing = null;
  for (let y = 4; y < 132 && !crossing; y++) {
    for (let x = 4; x < 300 && !crossing; x++) {
      if (!open(x, y)) continue;
      for (let d = 4; d <= 12 && !crossing; d++) {
        const match = openMatch("1986");
        match.pieces = [piece("blue:i2", "infantry", "land", x, y)];
        const ordered = issueOrder(match, "blue", "blue:i2", x + d, y);
        if (!ordered.ok) continue;
        const wet = ordered.path.filter((step) => water(step.x, step.y)).length;
        if (wet >= 3) crossing = { x, y, d, wet };
      }
    }
  }
  must(crossing, "no land order crosses water on this board: the sea leg cannot be measured");
  {
    const match = openMatch("1986");
    match.clock = "running";
    const infantry = piece("blue:i2", "infantry", "land", crossing.x, crossing.y);
    const { ordered } = leg(match, infantry, crossing.x + crossing.d, crossing.y,
      "infantry with a sea leg", { differsFromPaceSum: false });
    const wet = ordered.path.filter((step) => water(step.x, step.y)).length;
    must(wet >= 3, "the crossing leg's path lost its water steps");
    // The mixed rate has to beat the land-only arithmetic: cargo walks at 2, so the quote is
    // strictly shorter than one round per step where the water is.
    must(ordered.rounds < ordered.path.length,
      "infantry crossing: the quote equals one round per step — the transport rate is not applied");
  }

  // ---- ship: 3 cells a round, and a same-round arrival so the quote cannot pass by rounding ----
  // "Same round" means the route divides by the rate exactly: arrival is len/3 with no ceiling and
  // no leftover credit. A test that only measured a remainder route would still pass if the quote
  // were ceil(len/rate) for the wrong rate on that one case.
  let exact = null;   // len % 3 == 0
  let remainder = null; // len % 3 != 0
  for (let y = 2; y < 134 && !(exact && remainder); y++) {
    for (let x = 2; x < 306 && !(exact && remainder); x++) {
      if (!water(x, y)) continue;
      for (let d = 6; d <= 14 && !(exact && remainder); d++) {
        const match = openMatch("1986");
        match.pieces = [piece("blue:s1", "destroyer", "sea", x, y)];
        const ordered = issueOrder(match, "blue", "blue:s1", x + d, y);
        if (!ordered.ok || ordered.path.length < 6) continue;
        const len = ordered.path.length;
        if (len % 3 === 0 && !exact) exact = { x, y, d, len };
        if (len % 3 !== 0 && !remainder) remainder = { x, y, d, len };
      }
    }
  }
  must(exact, "no sea route whose length is a multiple of the hull rate: the same-round case cannot run");
  {
    const match = openMatch("1986");
    match.clock = "running";
    const ship = piece("blue:s1", "destroyer", "sea", exact.x, exact.y);
    shouldEqual(cellsPerRound(ship), 3, "the hull rate in force is 3 cells a round");
    const { ordered, arrived } = leg(match, ship, exact.x + exact.d, exact.y,
      "ship, same-round arrival", { differsFromPathLength: true });
    shouldEqual(arrived, exact.len / 3, "ship: the same-round arrival is len/3, not a ceiling");
    shouldEqual(ordered.rounds, exact.len / 3, "ship: the quote must be len/3 with no rounding");
  }
  if (remainder) {
    const match = openMatch("1986");
    match.clock = "running";
    const ship = piece("blue:s2", "destroyer", "sea", remainder.x, remainder.y);
    const { ordered, arrived } = leg(match, ship, remainder.x + remainder.d, remainder.y,
      "ship, leftover credit", { differsFromPathLength: true });
    shouldEqual(arrived, Math.ceil(remainder.len / 3), "ship: a remainder route arrives on the ceiling round");
    shouldEqual(ordered.rounds, Math.ceil(remainder.len / 3), "ship: the quote carries the floor's leftover credit");
  }
}
