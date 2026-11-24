// PB-214b: the dig-in must not begin on the round a unit spends its LAST step.
//
// The defect (PM live hand-check on beb0893, the arrival rounds of two 2-cell infantry legs): the
// walker empties a unit's path when it spends its last step and stamps `movedRound`, so the
// server's own `state` says "moving" and PB-214 made the badge paint moving — but `tickEntrench`
// ran after `advance` in the same tick, tested `path.length > 0`, saw a settled piece, published
// `entrenched: true` on that same round and the hover tip read "dug in". The dig-in had not begun,
// and combat paid the dug-in discount to a unit that had just walked in.
//
// This node drives REAL ticks over two legs (no hand-set flags) and pins both clauses:
//   (a) on the arrival round, while the state is moving, entrenched is false and the tip has no
//       "dug in";
//   (b) "dug in" first shows on the round the state leaves moving - the very next round, never
//       earlier - and the badge word follows the server's word there.
// A parked infantry that never moved is the control: it still digs in on its first still round, so
// a tree that simply never entrenches cannot pass this node.
import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { digInIds } from "../../server/rules.mjs";
import { forSeat } from "../../server/view.mjs";
import { badgeHoverText, badgeState } from "../../public/badges.mjs";

export const name = "pb214b_arrival_entrench";

// PM's live legs, cell for cell: 79,44 -> 77,44 -> 75,44 on the shipped 1986 board. All five cells
// carry terrain id 8 (a dig-in cell), so both arrivals can dig in and clause (b) is proven twice.
const LEGS = [
  { to: { x: 77, y: 44 } },
  { to: { x: 75, y: 44 } },
];
const START = { x: 79, y: 44 };
const CONTROL = { x: 81, y: 43 }; // terrain id 8, far enough away to be nobody's neighbour
const MOVER = "blue:mover";
const PARKED = "blue:parked";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function terrainId(x, y) {
  let cells = null;
  try {
    cells = boardPayload().cells || null;
  } catch {
    cells = null;
  }
  if (!cells) return null;
  const wx = ((Number(x) % CELL_W) + CELL_W) % CELL_W;
  return cells[Number(y) * CELL_W + wx] ?? null;
}

function frameOf(match, pieceId) {
  const view = forSeat(match, "blue");
  const piece = (view.pieces || []).find((entry) => entry.id === pieceId);
  if (!piece) return null;
  const group = { top: piece, pieces: [piece], count: 1, x: piece.x, y: piece.y };
  return {
    round: match.round,
    x: piece.x,
    y: piece.y,
    pathLen: Array.isArray(piece.path) ? piece.path.length : null,
    state: piece.state,
    moving: piece.moving,
    entrenched: piece.entrenched,
    badge: badgeState(piece),
    tip: badgeHoverText(group),
  };
}

function unit(id, x, y) {
  return {
    id, side: "blue", domain: "land", kind: "infantry", x, y, path: [], pace: 1, facing: null,
    fighting: null, shots: 0, strength: 100, maxStrength: 100, entrenched: false,
  };
}

function setup() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.round = 0;
  match.sites = [];
  match.capitals = {};
  match.pieces = [unit(MOVER, START.x, START.y), unit(PARKED, CONTROL.x, CONTROL.y)];
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;

  // Both destinations must be ground an infantry can dig in on. With no extract the board has no
  // terrain and the walker treats every cell as plain, which is a dig-in cell too; this guard only
  // fires when a real extract says otherwise, so the pin cannot pass by landing on a city.
  const dug = digInIds();
  for (const leg of LEGS) {
    const id = terrainId(leg.to.x, leg.to.y);
    must(id === null || dug.has(Number(id)),
      "PB-214b fixture: " + leg.to.x + "," + leg.to.y + " carries terrain " + id + ", which cannot dig in");
  }

  const match = setup();
  const trace = [frameOf(match, MOVER)];
  const arrivals = [];
  const settled = [];

  for (let leg = 0; leg < LEGS.length; leg += 1) {
    const order = issueOrder(match, "blue", MOVER, LEGS[leg].to.x, LEGS[leg].to.y);
    must(!order.error, "leg " + (leg + 1) + " was refused: " + order.error);
    let arrival = null;
    for (let round = 0; round < 10 && !arrival; round += 1) {
      tickMatch(match);
      const frame = frameOf(match, MOVER);
      trace.push(frame);
      if (frame.x === LEGS[leg].to.x && frame.y === LEGS[leg].to.y && frame.pathLen === 0) arrival = frame;
    }
    must(!!arrival, "leg " + (leg + 1) + " never arrived at " + LEGS[leg].to.x + "," + LEGS[leg].to.y);
    arrivals.push(arrival);
    // The round the state leaves moving: one more tick, no new order in between.
    tickMatch(match);
    const after = frameOf(match, MOVER);
    trace.push(after);
    settled.push(after);
  }

  // (a) no frame may be both moving and dug in, on the wire or in the tip.
  for (const frame of trace) {
    if (frame.state !== "moving") continue;
    must(frame.entrenched === false, "PB-214b (a): round " + frame.round + " is moving but the wire says entrenched: " + JSON.stringify(frame));
    must(!/dug in/.test(frame.tip), "PB-214b (a): round " + frame.round + " is moving but the tip says '" + frame.tip + "'");
  }

  // (b) "dug in" starts on the round after each arrival, not on the arrival round.
  for (let i = 0; i < arrivals.length; i += 1) {
    const arrival = arrivals[i];
    const after = settled[i];
    must(arrival.state === "moving", "PB-214b: arrival round " + arrival.round + " is not moving: " + arrival.state);
    must(/dug in/.test(after.tip), "PB-214b (b): the round after arrival " + arrival.round + " has no 'dug in': " + after.tip);
    must(after.round === arrival.round + 1, "PB-214b (b): 'dug in' first shows on round " + after.round + ", not " + (arrival.round + 1));
    must(after.state !== "moving" && after.entrenched === true, "PB-214b (b): the first dug-in frame is not settled and dug in: " + JSON.stringify(after));
    // The badge word follows the server's word once the dig-in has begun (PM's r3/r6 question).
    must(after.badge === "digging", "the badge calls a dug-in piece '" + after.badge + "' while the unit list says '" + after.state + "'");
  }

  // Control: a piece that never moved digs in on its first still round, so (b) cannot pass on a tree
  // that simply never entrenches.
  tickMatch(match);
  const parked = frameOf(match, PARKED);
  must(!/dug in/.test(trace[0].tip), "control: a fresh infantry opens dug in: " + trace[0].tip);
  must(parked.entrenched === true && /dug in/.test(parked.tip), "control: a parked infantry never dug in; the pin proves nothing");
  must(parked.badge === "digging", "control: the parked dug-in badge says '" + parked.badge + "'");
}
