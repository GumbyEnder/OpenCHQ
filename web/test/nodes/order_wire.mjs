// Node test for `order_wire` (order 240).
//
// What breaks if this node is removed: the server still accepts `op: "order"`, but nothing
// in the page ever sends one. A player can see the board and cannot touch it. This file
// proves the three things that make the click real:
//   1. the page's helpers pick only the seat's own piece and build the socket order,
//   2. the server's planner returns the route and its cost in rounds WITHOUT moving the
//      piece, so a hover cannot be mistaken for an order,
//   3. a real socket order moves the piece on the next round and an acknowledgement comes
//      back; a refused order's sentence arrives and is shown, not swallowed.

import { openMatch } from "../../server/match.mjs";
import { issueOrder, planOrder } from "../../server/move.mjs";
import {
  PICK_HINT,
  REFUSED,
  ackText,
  cellAtEvent,
  orderMessage,
  ownPieceAt,
  previewLine,
  refusalText,
  routeRequest,
  roundsText,
} from "../../public/command.mjs";
import { fitViewport, paintPreview } from "../../public/render.mjs";

export const name = "order_wire";

const BLUE_CAPITAL = { x: 79, y: 44 };
const BLUE_STEP = { x: 80, y: 44 };
const RED_CAPITAL = { x: 183, y: 25 };

const ROOM_PIECES = [
  { id: "blue:land", side: "blue", domain: "land", kind: null, x: 79, y: 44, path: [] },
  { id: "blue:sea", side: "blue", domain: "sea", kind: null, x: 0, y: 15, path: [] },
  { id: "red:land", side: "red", domain: "land", kind: null, x: 183, y: 25, path: [] },
];

function eq(fail, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

function ok(fail, label, value) {
  if (!value) fail(label);
}

function recorder() {
  const ops = [];
  const ctx = {
    _stroke: "",
    lineWidth: 1,
    font: "",
    fillStyle: "",
    set strokeStyle(value) {
      this._stroke = value;
    },
    get strokeStyle() {
      return this._stroke;
    },
    beginPath() {
      ops.push({ op: "begin" });
    },
    moveTo(x, y) {
      ops.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      ops.push({ op: "lineTo", x, y });
    },
    rect(x, y, w, h) {
      ops.push({ op: "rect", x, y, w, h, color: this._stroke });
    },
    stroke() {
      ops.push({ op: "stroke", color: this._stroke });
    },
    fillText() {},
    clearRect() {},
    fillRect() {},
    arc() {},
  };
  return { ctx, ops };
}

async function opened(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed to open")));
  });
}

// A round is a tunable, so waits for the shipped clock follow config instead of 2 s.
async function waitUntil(box, from, pred, label, deadlineMs, fail) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const hit = box.slice(from).find(pred);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fail(label + " missing within " + deadlineMs + "ms: " +
    JSON.stringify(box.slice(from).map((m) => (m.op === "room" && m.room
      ? { op: m.op, round: m.room.round, clock: m.room.clock }
      : m.op))));
}

function storedMatch(ctx, roomId) {
  const store = ctx.sqlite();
  try {
    const row = store.prepare("SELECT state FROM rooms WHERE id = ?").get(roomId);
    return row ? JSON.parse(row.state).match : null;
  } finally {
    store.close();
  }
}

export async function run(ctx) {
  const { fail, base } = ctx;

  // ---- 1. the page's half: pick an own piece, build the order --------------------------
  const mine = ownPieceAt(ROOM_PIECES, BLUE_CAPITAL, "blue");
  if (!mine || mine.id !== "blue:land") fail("clicking blue's own piece did not select it: " + JSON.stringify(mine));
  if (ownPieceAt(ROOM_PIECES, RED_CAPITAL, "blue")) fail("blue selected a piece that is not its own");
  if (ownPieceAt(ROOM_PIECES, BLUE_CAPITAL, "red")) fail("red selected blue's piece");
  if (ownPieceAt(ROOM_PIECES, { x: 4, y: 4 }, "blue")) fail("an empty cell selected a piece");

  eq(fail, "the order the page sends", orderMessage(mine, BLUE_STEP), {
    op: "order",
    piece: "blue:land",
    to: { x: 80, y: 44 },
  });
  eq(fail, "the hover request", routeRequest(mine, { x: 81, y: 44 }), {
    op: "route",
    piece: "blue:land",
    to: { x: 81, y: 44 },
  });
  // X still wraps when the page names a destination.
  eq(fail, "a wrapped destination", orderMessage(mine, { x: 320, y: 44 }).to, { x: 0, y: 44 });

  // Pointer over a CSS-half-size canvas lands on the right cell.
  const view = fitViewport(640, 272);
  const canvas = {
    width: 640,
    height: 272,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 136 }),
  };
  eq(fail, "a click on a scaled canvas", cellAtEvent({ clientX: 1, clientY: 1 }, canvas, view), { x: 1, y: 1 });
  eq(fail, "a click on Washington", cellAtEvent({ clientX: 79.5, clientY: 44.5 }, canvas, view), BLUE_CAPITAL);

  ok(fail, "a two-round walk is named in rounds", roundsText(2).startsWith("2 round"));
  ok(fail, "the acknowledgement names the cost", ackText({ op: "ordered", rounds: 3 }).includes("3 rounds"));
  ok(fail, "a zero-length order is acknowledged, not silent", ackText({ rounds: 0 }).length > 0);
  eq(fail, "a refusal is the server's sentence", refusalText({ error: "Wasteland is refused." }), "Wasteland is refused.");
  eq(fail, "an empty refusal is still something", refusalText({}), REFUSED);
  ok(fail, "the hover line names the cost", previewLine({ rounds: 2, path: [] }).includes("2 rounds"));
  ok(fail, "the hover line shows a refusal", previewLine({ error: "Wasteland is refused." }).includes("Wasteland"));
  ok(fail, "the pick hint tells the player what to do", PICK_HINT.length > 0);

  // ---- 2. the planner previews without moving anything ---------------------------------
  const match = openMatch("1986");
  const before = JSON.stringify(match.pieces);
  const plan = planOrder(match, "blue", "blue:land", BLUE_STEP.x, BLUE_STEP.y);
  if (!plan || plan.error) fail("the planner refused an adjacent open cell: " + JSON.stringify(plan));
  eq(fail, "the plan is the next cell", plan.path[0], { x: BLUE_STEP.x, y: BLUE_STEP.y, pace: plan.path[0].pace });
  const cost = plan.path.reduce((sum, step) => sum + Math.max(1, step.pace), 0);
  eq(fail, "the plan states its cost in rounds", plan.rounds, cost);
  ok(fail, "the cost is at least one round per step", plan.rounds >= plan.path.length);
  eq(fail, "a preview does not move the piece", JSON.stringify(match.pieces), before);

  // An enemy-held cell is a target, not an obstacle: you give the order and the walk closes until
  // combat decides. A cell held by a friend is still refused - two pieces never share a cell.
  const attack = planOrder(match, "blue", "blue:land", RED_CAPITAL.x, RED_CAPITAL.y);
  if (!attack || !attack.ok || !Array.isArray(attack.path) || attack.path.length === 0) {
    fail("the planner refused an order onto an enemy-held cell: " + JSON.stringify(attack).slice(0, 200));
  }
  const blueFriend = (match.pieces || []).find((piece) => piece.side === "blue" && piece.id !== "blue:land" && !piece.path);
  const friendCell = blueFriend ? { x: blueFriend.x, y: blueFriend.y } : null;
  if (friendCell) {
    const refusedHeld = planOrder(match, "blue", "blue:land", friendCell.x, friendCell.y);
    if (!refusedHeld || !/holds that cell/.test(String(refusedHeld.error || ""))) {
      fail("the planner did not refuse a cell a friendly piece holds: " + JSON.stringify(refusedHeld).slice(0, 200));
    }
  }
  const refusedOffMap = planOrder(match, "blue", "blue:land", BLUE_CAPITAL.x, -1);
  if (!refusedOffMap || !/off the map/.test(String(refusedOffMap.error || ""))) {
    fail("the planner did not refuse an off-map destination: " + JSON.stringify(refusedOffMap));
  }
  const refusedArmy = planOrder(match, "blue", "red:land", RED_CAPITAL.x, RED_CAPITAL.y);
  if (!refusedArmy || !/belongs/.test(String(refusedArmy.error || ""))) {
    fail("the planner previewed the other army's route: " + JSON.stringify(refusedArmy));
  }
  eq(fail, "a refused preview does not move the piece either", JSON.stringify(match.pieces), before);

  // The order applies exactly the route the preview showed.
  const ordered = issueOrder(match, "blue", "blue:land", BLUE_STEP.x, BLUE_STEP.y);
  if (!ordered || ordered.error) fail("the order was refused: " + JSON.stringify(ordered));
  eq(fail, "the order walks the previewed route", ordered.path, plan.path);

  // ---- 3. the preview paints a route, not a marker alone ------------------------------
  const drawn = recorder();
  const steps = paintPreview(drawn.ctx, { from: BLUE_CAPITAL, to: BLUE_STEP, path: plan.path, rounds: plan.rounds }, view);
  eq(fail, "the preview returns its step count", steps, plan.path.length);
  ok(fail, "the preview draws a line", drawn.ops.some((op) => op.op === "lineTo"));
  ok(fail, "the preview marks the destination", drawn.ops.some((op) => op.op === "rect"));

  // ---- 4. a real socket: hover, order, ack, refusal -------------------------------------
  const player = await ctx.register("OrdWire");
  const sock = ctx.socket(player.token);
  try {
    await opened(sock.ws);
    await sock.wait((m) => m.op === "welcome", "welcome");
    // This test reads a board by waiting for the frame that shows it, so it asks for whole
    // frames instead of merging diffs.
    sock.send({ op: "fullframes", on: true });
    sock.send({ op: "bot", era: "1986", side: "blue" });
    const start = await sock.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
    const roomId = start.room.id;

    // Hover: the reply is a route with a cost, and the piece has not moved.
    let mark = sock.box.length;
    sock.send(routeRequest({ id: "blue:land" }, BLUE_STEP));
    const hover = await sock.wait((m) => m.op === "route" && m.piece === "blue:land", "route preview", mark);
    if (hover.error) fail("the hover was refused: " + JSON.stringify(hover));
    if (!Array.isArray(hover.path) || hover.path.length === 0) fail("the hover returned no route: " + JSON.stringify(hover));
    eq(fail, "the hover route starts beside the capital", { x: hover.path[0].x, y: hover.path[0].y }, BLUE_STEP);
    ok(fail, "the hover names a cost in rounds", Number(hover.rounds) >= hover.path.length);
    const storedAfterHover = storedMatch(ctx, roomId);
    const hovered = storedAfterHover.pieces.find((p) => p.id === "blue:land");
    if (hovered.x !== BLUE_CAPITAL.x || hovered.y !== BLUE_CAPITAL.y || hovered.path.length !== 0) {
      fail("a hover moved the piece: " + JSON.stringify(hovered));
    }

    // The click: {op:"order",piece,to:{x,y}} moves it, and is acknowledged in place.
    mark = sock.box.length;
    sock.send(orderMessage({ id: "blue:land" }, BLUE_STEP));
    const ack = await sock.wait((m) => m.op === "ordered" && m.piece === "blue:land", "order acknowledgement", mark);
    eq(fail, "the acknowledgement repeats the destination", ack.to, BLUE_STEP);
    eq(fail, "the acknowledgement carries the hovered cost", ack.rounds, hover.rounds);
    const queued = await sock.wait((m) => m.op === "room" && m.room && m.room.id === roomId &&
      (m.room.pieces || []).some((p) => p.id === "blue:land" && p.path.length > 0), "ordered room view", mark);
    ok(fail, "the seat sees its own order on the board", queued);

    // One round of the shipped clock takes the step.
    const roundMs = Math.max(1, Number(ctx.config.roundSeconds) || 5) * 1000;
    mark = sock.box.length;
    sock.send({ op: "run" });
    await waitUntil(sock.box, mark, (m) => m.op === "room" && m.room && m.room.id === roomId &&
      m.room.round >= 1, "a round ran", roundMs + 4000, fail);
    await sock.wait((m) => m.op === "room" && m.room && m.room.id === roomId &&
      (m.room.pieces || []).some((p) => p.id === "blue:land" && p.x === BLUE_STEP.x && p.y === BLUE_STEP.y),
      "the piece moved after a round", mark);
    sock.send({ op: "hold" });

    // A refusal arrives as the server's sentence and reads as one on the page. The cell is
    // held by the seat's own other piece, so the answer cannot depend on where a bot is.
    mark = sock.box.length;
    sock.send(orderMessage({ id: "blue:land" }, { x: 0, y: 15 }));
    const refused = await sock.wait((m) => m.op === "error", "refused order", mark);
    if (!/holds that cell/.test(String(refused.error || ""))) {
      fail("the refusal reason is not the server's: " + JSON.stringify(refused));
    }
    eq(fail, "the page shows the refusal verbatim", refusalText(refused), String(refused.error));
    ok(fail, "the refusal is not swallowed", refusalText(refused).trim().length > 0);

    // And the other army is still not this seat's to order.
    mark = sock.box.length;
    sock.send(orderMessage({ id: "red:land" }, RED_CAPITAL));
    const foreign = await sock.wait((m) => m.op === "error", "foreign order refused", mark);
    if (!/belongs|not yours/i.test(String(foreign.error || ""))) {
      fail("ordering the other army was not refused: " + JSON.stringify(foreign));
    }
    sock.send({ op: "leave" });
  } finally {
    sock.close();
  }
}
