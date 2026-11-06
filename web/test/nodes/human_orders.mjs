// human_orders — a human room is two people, not one person and a machine.
//
// What fails if this is removed:
//   - the server stamps the seat table onto the match            -> bot.mjs would order a human seat
//   - the clock only asks a bot seat for orders                  -> a human room would get bot orders
//   - `op: "order"` derives the side from the seat table         -> a forged `side` would be believed
//   - move.issueOrder re-checks piece ownership                  -> a forged piece id would move the
//                                                                   other army
//
// The room is opened the way a player opens one (invite, accept), each seat orders its own
// army through its own socket, and a forged order from blue is checked against the stored
// match: the red army must still be sitting on Moscow with no path.

import { openMatch } from "../../server/match.mjs";
import { ordersFor } from "../../server/bot.mjs";

export const name = "human_orders";

const BLUE_CAPITAL = { x: 79, y: 44 };
const RED_CAPITAL = { x: 183, y: 25 };
// Open ground next to each capital, read from the extract in the orders node already.
const BLUE_STEP = { x: 80, y: 44 };
const RED_STEP = { x: 184, y: 25 };

function opened(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed to open")));
  });
}

// The harness wait caps at 2 s; a round is a tunable, so this one waits on the configured
// round length instead of assuming the beat.
async function waitUntil(box, from, pred, label, deadlineMs, fail) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const hit = box.slice(from).find(pred);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fail(label + " missing within " + deadlineMs + "ms: " +
    JSON.stringify(box.slice(from).map((m) => (m.op === "room" && m.room
      ? { op: m.op, id: m.room.id, clock: m.room.clock, round: m.room.round }
      : m.op))));
}

function storedMatch(ctx, roomId) {
  const store = ctx.sqlite();
  try {
    const row = store.prepare("SELECT state, clock FROM rooms WHERE id = ?").get(roomId);
    if (!row) return null;
    const state = JSON.parse(row.state);
    return { match: state.match, seats: state.seats, clock: row.clock };
  } finally {
    store.close();
  }
}

function pieceOf(match, id, fail) {
  const unit = (match && Array.isArray(match.pieces) ? match.pieces : []).find((p) => p.id === id);
  if (!unit) fail("the stored match has no " + id + ": " + JSON.stringify(match && match.pieces));
  return unit;
}

export async function run(ctx) {
  const { fail } = ctx;

  // ---- the module refuses a human seat even when asked directly -------------------------
  // The room stamps match.seats from its seat table; bot.mjs must read that and stand down.
  const probe = openMatch("1986");
  probe.seats = { blue: { kind: "human" }, red: { kind: "human" } };
  for (const side of ["blue", "red"]) {
    const events = ordersFor(probe, side);
    const ordered = events.filter((event) => event.type === "bot_order");
    if (ordered.length) fail("bot orders were issued to a human " + side + " seat: " + JSON.stringify(ordered));
    const skipped = events.find((event) => event.type === "bot_skip" && event.side === side);
    if (!skipped || !/human/.test(String(skipped.reason || ""))) {
      fail("a human " + side + " seat was not told to stand down: " + JSON.stringify(events));
    }
  }
  // A bot seat in the same shape is still ordered, so the check above is not "never order".
  const botProbe = openMatch("1986");
  botProbe.seats = { blue: { kind: "human" }, red: { kind: "bot" } };
  if (botProbe.pieces.find((p) => p.id === "red:land").path.length !== 0) fail("bot probe started with a path");
  const botEvents = ordersFor(botProbe, "red");
  const botMarch = botEvents.find((event) => event.type === "bot_order" && event.pieceId === "red:land");
  if (!botMarch) fail("a bot seat was not ordered: " + JSON.stringify(botEvents));
  if (ordersFor(botProbe, "blue").some((event) => event.type === "bot_order")) {
    fail("the human seat beside a bot was ordered anyway");
  }

  // ---- a real human room, opened by invite and accept -----------------------------------
  const ada = await ctx.register("HOrdAda");
  const gus = await ctx.register("HOrdGus");
  const sa = ctx.socket(ada.token);
  const sb = ctx.socket(gus.token);
  try {
    await Promise.all([opened(sa.ws), opened(sb.ws)]);
    await ctx.waitFor(sa.box, 0, (m) => {
      if (m.op !== "welcome" && m.op !== "presence") return false;
      const names = (m.users || []).map((u) => u.username);
      return names.includes("HOrdAda") && names.includes("HOrdGus");
    }, "both human_orders players present");

    sa.send({ op: "invite", user: "HOrdGus", era: "1986", side: "blue" });
    const invite = await sb.wait((m) => m.op === "invite" && m.invite.from === "HOrdAda", "invite");
    sb.send({ op: "answer", id: invite.invite.id, accept: true });

    const blueRoom = await sa.wait((m) => m.op === "room" && m.room && m.room.mode === "human", "blue room");
    const redRoom = await sb.wait((m) => m.op === "room" && m.room && m.room.mode === "human", "red room");
    const roomId = blueRoom.room.id;
    if (!roomId || roomId !== redRoom.room.id) fail("the two seats are in different rooms");
    if (blueRoom.room.you !== "blue" || redRoom.room.you !== "red") {
      fail("seat sides are wrong: " + blueRoom.room.you + "/" + redRoom.room.you);
    }
    if (blueRoom.room.blue.kind !== "human" || blueRoom.room.red.kind !== "human") {
      fail("a human room has a non-human seat: " + JSON.stringify([blueRoom.room.blue, blueRoom.room.red]));
    }

    // ---- the clock does not hand either human seat bot orders ---------------------------
    // One real round of the shipped clock: if the lobby asked a human seat for bot orders,
    // the armies would have paths and be marching by the time this round lands. The round
    // length is a tunable (config/game.json -> roundSeconds), so the deadline follows it
    // instead of hard-coding a wall time.
    const roundMs = Math.max(1, Number(ctx.config.roundSeconds) || 5) * 1000;
    let mark = sa.box.length;
    sa.send({ op: "run" });
    await waitUntil(sa.box, mark, (m) => m.op === "room" && m.room && m.room.id === roomId &&
      m.room.clock === "running" && m.room.round >= 1, "a human round ran", roundMs + 3000, fail);
    mark = sa.box.length;
    sa.send({ op: "hold" });
    await ctx.waitFor(sa.box, mark, (m) => m.op === "room" && m.room && m.room.id === roomId &&
      m.room.clock === "held", "human clock held");

    let stored = storedMatch(ctx, roomId);
    if (!stored || !stored.match) fail("the human room was not stored");
    const blueIdle = pieceOf(stored.match, "blue:land", fail);
    const redIdle = pieceOf(stored.match, "red:land", fail);
    if (blueIdle.path.length !== 0 || redIdle.path.length !== 0) {
      fail("a bot ordered a human room: " + JSON.stringify({ blue: blueIdle.path, red: redIdle.path }));
    }
    if (blueIdle.x !== BLUE_CAPITAL.x || blueIdle.y !== BLUE_CAPITAL.y) fail("blue moved without an order");
    if (redIdle.x !== RED_CAPITAL.x || redIdle.y !== RED_CAPITAL.y) fail("red moved without an order");
    if (!stored.match.seats || stored.match.seats.blue.kind !== "human" || stored.match.seats.red.kind !== "human") {
      fail("the stored match does not record both seats as human: " + JSON.stringify(stored.match.seats));
    }

    // ---- each socket orders its own army ----------------------------------------------
    mark = sa.box.length;
    sa.send({ op: "order", piece: "blue:land", x: BLUE_STEP.x, y: BLUE_STEP.y });
    const blueOrdered = await ctx.waitFor(sa.box, mark, (m) => {
      if (m.op !== "room" || !m.room || m.room.id !== roomId) return false;
      const unit = (m.room.pieces || []).find((p) => p.id === "blue:land");
      return unit && unit.path.length > 0;
    }, "blue order accepted");
    attributable(blueOrdered, fail);
    stored = storedMatch(ctx, roomId);
    const blueWalk = pieceOf(stored.match, "blue:land", fail);
    if (blueWalk.path.length === 0 || blueWalk.path[0].x !== BLUE_STEP.x || blueWalk.path[0].y !== BLUE_STEP.y) {
      fail("blue's own order did not reach the match: " + JSON.stringify(blueWalk.path));
    }
    const bluePathAfterOrder = JSON.stringify(blueWalk.path);

    mark = sb.box.length;
    sb.send({ op: "order", piece: "red:land", x: RED_STEP.x, y: RED_STEP.y });
    await ctx.waitFor(sb.box, mark, (m) => {
      if (m.op !== "room" || !m.room || m.room.id !== roomId) return false;
      const unit = (m.room.pieces || []).find((p) => p.id === "red:land");
      return unit && unit.path.length > 0;
    }, "red order accepted");
    stored = storedMatch(ctx, roomId);
    const redWalk = pieceOf(stored.match, "red:land", fail);
    if (redWalk.path.length === 0 || redWalk.path[0].x !== RED_STEP.x || redWalk.path[0].y !== RED_STEP.y) {
      fail("red's own order did not reach the match: " + JSON.stringify(redWalk.path));
    }
    const redPathAfterOrder = JSON.stringify(redWalk.path);

    // ---- a forged side is refused -------------------------------------------------------
    // Blue names red's side on its own piece: the side in the message is not believed.
    mark = sa.box.length;
    sa.send({ op: "order", piece: "blue:land", x: BLUE_STEP.x, y: BLUE_STEP.y, side: "red" });
    const forgedSide = await sa.wait((m) => m.op === "error", "forged side refused", mark);
    if (!/not yours|side/i.test(String(forgedSide.error || ""))) {
      fail("forged side refusal reads: " + JSON.stringify(forgedSide));
    }
    stored = storedMatch(ctx, roomId);
    if (JSON.stringify(pieceOf(stored.match, "blue:land", fail).path) !== bluePathAfterOrder) {
      fail("a forged side changed blue's own path");
    }

    // Blue names red's side and red's piece: the other army must not move.
    mark = sa.box.length;
    sa.send({ op: "order", piece: "red:land", x: RED_CAPITAL.x, y: RED_CAPITAL.y, side: "red" });
    const forgedArmy = await sa.wait((m) => m.op === "error", "forged army refused", mark);
    if (!/not yours|side|belongs/i.test(String(forgedArmy.error || ""))) {
      fail("forged army refusal reads: " + JSON.stringify(forgedArmy));
    }
    stored = storedMatch(ctx, roomId);
    const redAfterForgery = pieceOf(stored.match, "red:land", fail);
    if (redAfterForgery.x !== RED_CAPITAL.x || redAfterForgery.y !== RED_CAPITAL.y) {
      fail("a forged order moved the other army to " + redAfterForgery.x + "," + redAfterForgery.y);
    }
    if (JSON.stringify(redAfterForgery.path) !== redPathAfterOrder) {
      fail("a forged order repathed the other army: " + JSON.stringify(redAfterForgery.path));
    }

    // And the same forged piece without a side: the side comes from the seat, so red's piece
    // is refused to a blue socket even when no side is claimed.
    mark = sa.box.length;
    sa.send({ op: "order", piece: "red:land", x: RED_STEP.x, y: RED_STEP.y });
    const pieceRefusal = await sa.wait((m) => m.op === "error", "foreign piece refused without a side", mark);
    if (!/belongs|not yours/i.test(String(pieceRefusal.error || ""))) {
      fail("foreign piece refusal reads: " + JSON.stringify(pieceRefusal));
    }
    stored = storedMatch(ctx, roomId);
    if (JSON.stringify(pieceOf(stored.match, "red:land", fail).path) !== redPathAfterOrder) {
      fail("blue repathed red's army with no side claimed");
    }
  } finally {
    sa.close();
    sb.close();
  }
}

// A room message carries a round; a room with no round is not the match talking.
function attributable(message, fail) {
  if (!message.room || typeof message.room.round !== "number") {
    fail("the room message has no round: " + JSON.stringify(message.room));
  }
}
