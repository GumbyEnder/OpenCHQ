// pb309_switch_sides — Switch Sides in a solo game (manual p.35 l.1126-1127): "you can actually
// switch sides during a game. To do this, press Switch Sides. This only works in a solo game or a
// game against 'no opponent.'"
//
// What breaks if this is removed:
//   - the press does nothing, or flips a label without moving the SEAT   -> the player still commands
//     the side they left and the computer still plays the side it held;
//   - the seat flips on the room but not on the match's own seat table  -> bot.mjs keeps ordering the
//     side the human now holds and stops ordering the side it was given;
//   - the human may still order the side they left                     -> every order refused on the
//     board for a reason the player cannot see;
//   - a two-human war silently honours the press                       -> the manual's own limit is
//     gone, and one player is playing both sides;
//   - a layout sandbox honours it                                      -> a pregame picture becomes a
//     war with a bot in it.
//
// What this leg MEASURES and reports (the original's handling is UNVERIFIED, so it is measured, not
// claimed): the purse each side carries across the swap, the fog each seat sees, and a path already
// in flight on a unit of the side being taken.
//
// Measured over the real HTTP/WS surface against the suite's own server.

export const name = "pb309_switch_sides";

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFrame(sock, pred, label, from = 0, deadline = 20000) {
  const start = Date.now();
  while (Date.now() - start < deadline) {
    for (const message of sock.box.slice(from)) if (message && pred(message)) return message;
    await sleep(20);
  }
  throw new Error("pb309: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(from).map((m) => (m && m.op === "room"
      ? { op: "room", you: m.room && m.room.you, round: m.room && m.room.round }
      : m && m.op)),
  ));
}

// Send, then wait for a frame that arrived after the send.
async function sendWait(sock, message, pred, label) {
  const mark = sock.box.length;
  sock.send(message);
  return waitFrame(sock, pred, label, mark);
}

// A message whose answer may be no frame at all (leave, a full-frame request): fire and let the
// room settle.
async function fire(sock, message) {
  sock.send(message);
  await sleep(250);
}

const rooms = (sock) => sock.box.filter((m) => m && m.op === "room" && m.room).map((m) => m.room);

function lastRoom(sock) {
  const list = rooms(sock);
  return list.length ? list[list.length - 1] : null;
}

// The durable half: what the server actually stored for the room, not what a frame said.
function storedRoom(ctx, id) {
  const db = ctx.sqlite();
  try {
    const row = db.prepare("SELECT state FROM rooms WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.state) : null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function noRawId(value) {
  return !/(blue|red):[a-z]+:/.test(JSON.stringify(value));
}

// One real order on the seat's own units: the first neighbouring cell the server accepts.
async function firstOrder(sock, pieces, label) {
  for (const piece of (pieces || []).filter((p) => p.domain !== "sat" && p.kind !== "aircraft").slice(0, 5)) {
    for (const [dx, dy] of DIRS) {
      const answer = await sendWait(sock,
        { op: "order", piece: piece.id, to: { x: piece.x + dx, y: piece.y + dy } },
        (m) => m.op === "ordered" || m.op === "error", label + " for " + piece.id);
      if (answer.op === "ordered") return { piece, answer };
    }
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const player = await ctx.register("pb309_sides");
  const rival = await ctx.register("pb309_rival");
  const sandbox = await ctx.register("pb309_layout");
  const sock = ctx.socket(player.token);
  const rivalSock = ctx.socket(rival.token);
  const layoutSock = ctx.socket(sandbox.token);
  try {
    await sock.wait((m) => m.op === "welcome", "the welcome");
    await rivalSock.wait((m) => m.op === "welcome", "the rival's welcome");
    await layoutSock.wait((m) => m.op === "welcome", "the layout welcome");

    // Every frame whole: this leg reads the room, and a delta would hide the fields it asserts on.
    await fire(sock, { op: "fullframes", on: true });

    // ---- (a) the switch lands in a solo game ------------------------------------------------
    // 1942 opens at war (match.mjs: 1918/1942 carry no opening peace), so a round can run and the
    // bot's orders are its own, not a cold war's.
    const opened = await sendWait(sock, { op: "bot", era: "1942", side: "blue" },
      (m) => m.op === "room" && m.room && m.room.mode === "bot", "the 1942 bot room");
    const before = opened.room;
    if (before.you !== "blue" || !before.blue || before.blue.kind !== "human" || !before.red || before.red.kind !== "bot") {
      fail("pb309 (a): the solo war did not seat the player blue against a bot: "
        + JSON.stringify({ you: before.you, blue: before.blue, red: before.red }));
    }
    const bluePieces = (before.pieces || []).filter((p) => p.side === "blue");
    if (!bluePieces.length) fail("pb309 (a): the blue seat sees no blue pieces to hand over");
    const blueSample = bluePieces[0];
    const blueSeatCash1 = Number(before.seat && before.seat.cash);
    // The clock is held by THIS seat before the switch, so the hold has to follow the player across:
    // a hold left on the side the computer takes would refuse the player's next "Run the clock".
    await sendWait(sock, { op: "hold" }, (m) => m.op === "room" && m.room && m.room.clock === "held",
      "the human's own hold");

    const flipped = await sendWait(sock, { op: "switch_sides" },
      (m) => m.op === "switched" || m.op === "error", "the switch answer");
    if (flipped.op !== "switched") fail("pb309 (a): Switch Sides was refused in a solo game: "
      + JSON.stringify(flipped).slice(0, 300));
    if (flipped.side !== "red" || flipped.left !== "blue") {
      fail("pb309 (a): the answer names the wrong sides: " + JSON.stringify(flipped).slice(0, 300));
    }
    // (c) no raw piece ids in the new copy: the sentence is the server's own.
    if (!noRawId(flipped) || !noRawId(flipped.text)) {
      fail("pb309 (c): the switch sentence carries a raw piece id: " + JSON.stringify(flipped).slice(0, 300));
    }
    if (!/red/.test(String(flipped.text || "")) || !/blue/.test(String(flipped.text || ""))) {
      fail("pb309 (c): the sentence does not name both sides: " + JSON.stringify(flipped.text));
    }

    const afterFlip = await waitFrame(sock,
      (m) => m.op === "room" && m.room && m.room.you === "red", "the flipped room frame");
    const now = afterFlip.room;
    if (now.mode !== "bot") fail("pb309 (a): the room left solo mode on the switch: " + now.mode);
    if (!now.red || now.red.kind !== "human" || now.red.username !== player.user.username) {
      fail("pb309 (a): the player does not hold the red seat after the switch: " + JSON.stringify(now.red));
    }
    if (!now.blue || now.blue.kind !== "bot") {
      fail("pb309 (a): the computer does not hold the blue seat after the switch: " + JSON.stringify(now.blue));
    }
    // The frame is a WHOLE room, not a delta: the seat's shadow belonged to the other side.
    if (!Array.isArray(now.pieces) || !now.pieces.length) {
      fail("pb309 (a): the flipped seat got a delta instead of a room: " + JSON.stringify(Object.keys(now)).slice(0, 300));
    }
    const redPiecesSeen = (now.pieces || []).filter((p) => p.side === "red");
    if (!redPiecesSeen.length) {
      fail("pb309 (a): the new seat sees none of its own (red) pieces: "
        + ((now.pieces || []).length) + " piece(s), sides "
        + [...new Set((now.pieces || []).map((p) => p.side))].join(","));
    }
    // A 1942 board has no fog: the old side's units stay DRAWN as the enemy, and that is the
    // measurement, not a failure. Fog is the concealed era's and the intel bar's; this leg claims
    // no fog change, so the piece census is printed instead of asserted.
    if (!noRawId(now.note)) fail("pb309 (c): the room note carries a raw piece id: " + now.note);
    console.log("pb309 (measure): the flipped seat sees " + (now.pieces || []).length + " piece(s), sides "
      + [...new Set((now.pieces || []).map((p) => p.side))].join(",")
      + " (own red " + redPiecesSeen.length + "); its cash " + blueSeatCash1
      + " -> " + Number(now.seat && now.seat.cash));

    // The hold moved to the side the player now holds - checked here, BEFORE any run, so a hold
    // left on the computer's side is caught as well as by the run below.
    const afterSwap = storedRoom(ctx, now.id);
    if (!afterSwap || !afterSwap.holds || afterSwap.holds.blue !== false || afterSwap.holds.red !== true) {
      fail("pb309 (a): the seat's hold did not follow it across the switch: "
        + JSON.stringify(afterSwap && afterSwap.holds));
    }

    // Authorization follows the SEAT: the side just left is no longer this player's to order.
    const stale = await sendWait(sock,
      { op: "order", side: "blue", piece: blueSample.id, to: { x: blueSample.x + 1, y: blueSample.y } },
      (m) => m.op === "ordered" || m.op === "error", "the stale-side order");
    if (stale.op !== "error" || !/not yours/i.test(String(stale.error || ""))) {
      fail("pb309 (a): an order for the side just left was not refused by the seat rule: "
        + JSON.stringify(stale).slice(0, 300));
    }

    // (a) the player can give orders to units of the NEW side: one real order on a red unit.
    const accepted = await firstOrder(sock, redPiecesSeen, "the red order");
    if (!accepted) fail("pb309 (a): no order on the new side was accepted, so the player cannot command red");

    // ---- (a2) the computer plays the side just left -----------------------------------------
    // Speed 6 for a few rounds: the bot issues its orders every beat for the seat it holds. The
    // human sends nothing for blue. Read the STORE (the durable room), not a frame.
    await sendWait(sock, { op: "speed", speed: 6 }, (m) => m.op === "room", "the speed frame");
    await sendWait(sock, { op: "run" },
      (m) => m.op === "room" && m.room && m.room.clock === "running", "the running clock");
    const startRound = Number(now.round) || 0;
    await waitFrame(sock, (m) => m.op === "room" && m.room && Number(m.room.round) >= startRound + 5,
      "five rounds on the new seat", 0, 30000);
    await fire(sock, { op: "hold" });
    const stored = storedRoom(ctx, now.id);
    if (!stored || !stored.match) fail("pb309 (a2): the room is not in the store: " + now.id);
    const storedPieces = stored.match.pieces || [];
    const blueNow = storedPieces.filter((p) => p.side === "blue");
    const moved = blueNow.filter((p) => {
      const was = bluePieces.find((old) => old.id === p.id);
      if (!was) return false;
      return Number(p.x) !== Number(was.x) || Number(p.y) !== Number(was.y)
        || (Array.isArray(p.path) && p.path.length > 0);
    });
    const redNow = storedPieces.filter((p) => p.side === "red");
    const redMoved = redNow.filter((p) => {
      const was = redPiecesSeen.find((old) => old.id === p.id);
      if (!was) return false;
      return Number(p.x) !== Number(was.x) || Number(p.y) !== Number(was.y);
    });
    console.log("pb309 (a2): blue units the computer ordered/moved: " + moved.length + " of " + blueNow.length
      + "; red units that moved (one human order was placed, no bot): " + redMoved.length + " of " + redNow.length
      + "; round " + stored.match.round);
    if (!moved.length) {
      fail("pb309 (a2): the computer issued no order and moved no unit on the side it was given (blue): "
        + JSON.stringify(blueNow.map((p) => ({ id: p.id, x: p.x, y: p.y, path: (p.path || []).length }))).slice(0, 500));
    }
    // The seat table is on the match, not only on the room: bot.mjs reads it every beat.
    if (!stored.match.seats || stored.match.seats.blue.kind !== "bot" || stored.match.seats.red.kind !== "human") {
      fail("pb309 (a2): the match's own seat table did not follow the swap: " + JSON.stringify(stored.match.seats));
    }
    if (!stored.seats || stored.seats.red.username !== player.user.username || stored.seats.blue.kind !== "bot") {
      fail("pb309 (a2): the stored room did not keep the swapped seats: " + JSON.stringify(stored.seats));
    }

    // ---- (b) the 2P refusal: a two-human war keeps its sides --------------------------------
    // Out of the solo room first: a seat may hold one room, and the invite is refused otherwise.
    await fire(sock, { op: "leave" });
    const invite = await sendWait(rivalSock, { op: "invite", user: player.user.username, era: "1942", side: "red" },
      (m) => m.op === "invited" || m.op === "error", "the invite");
    if (invite.op !== "invited") fail("pb309 (b): the invite was refused: " + JSON.stringify(invite).slice(0, 200));
    const offer = await sock.wait((m) => m.op === "invite", "the invite frame");
    await sendWait(sock, { op: "answer", id: offer.invite.id, accept: true },
      (m) => m.op === "room", "the two-human room");
    const two = lastRoom(sock);
    if (!two || two.mode !== "human") fail("pb309 (b): the invite did not open a human room: " + JSON.stringify(two && two.mode));
    const twoBefore = JSON.stringify({ blue: two.blue, red: two.red, you: two.you });
    const refused = await sendWait(sock, { op: "switch_sides" }, (m) => m.op === "switched" || m.op === "error",
      "the 2P refusal");
    if (refused.op !== "error" || !/only works in a solo game/i.test(String(refused.error || ""))) {
      fail("pb309 (b): a two-human war did not refuse Switch Sides with a sentence: " + JSON.stringify(refused).slice(0, 300));
    }
    if (!/two-player/i.test(String(refused.error || ""))) {
      fail("pb309 (b): the refusal does not say why: " + refused.error);
    }
    if (!noRawId(refused.error)) fail("pb309 (b): the refusal carries a raw piece id: " + refused.error);
    await sleep(150);
    const twoAfter = lastRoom(sock);
    if (JSON.stringify({ blue: twoAfter.blue, red: twoAfter.red, you: twoAfter.you }) !== twoBefore) {
      fail("pb309 (b): the refused press still moved a seat: " + twoBefore + " -> "
        + JSON.stringify({ blue: twoAfter.blue, red: twoAfter.red, you: twoAfter.you }));
    }
    console.log("pb309 (b): the two-human refusal: " + refused.error);
    await fire(sock, { op: "leave" });
    await fire(rivalSock, { op: "leave" });

    // ---- (d) a layout is not a war ----------------------------------------------------------
    const lay = await sendWait(layoutSock, { op: "layout", era: "1986", side: "blue" },
      (m) => m.op === "room", "the layout sandbox");
    if (!lay.room || lay.room.mode !== "layout") fail("pb309 (d): the sandbox did not open");
    const layRefused = await sendWait(layoutSock, { op: "switch_sides" },
      (m) => m.op === "switched" || m.op === "error", "the layout refusal");
    if (layRefused.op !== "error" || !/layout, not a war/i.test(String(layRefused.error || ""))) {
      fail("pb309 (d): a layout did not refuse Switch Sides: " + JSON.stringify(layRefused).slice(0, 300));
    }
    await fire(layoutSock, { op: "leave" });

    // ---- measured, not claimed: a purse and a path in flight across the swap ------------------
    // A fresh solo war on the other socket, one order in flight on the blue side the player is
    // about to leave, then the switch. Both facts are read from the STORE.
    await fire(rivalSock, { op: "fullframes", on: true });
    // Handicap 60b: the opponent's pool is a DIFFERENT number from the player's, so "which purse the
    // seat now holds" is measurable instead of two equal numbers.
    const war2 = await sendWait(rivalSock, { op: "bot", era: "1942", side: "blue", handicap: 60 },
      (m) => m.op === "room" && m.room && m.room.mode === "bot", "the second solo war");
    const w2 = war2.room;
    const w2Blue = (w2.pieces || []).filter((p) => p.side === "blue");
    const w2Accepted = await firstOrder(rivalSock, w2Blue, "the blue order before the swap");
    if (!w2Accepted) fail("pb309 (measure): no blue order could be placed before the swap");
    const w2StoredBefore = storedRoom(ctx, w2.id);
    const pathBefore = (w2StoredBefore.match.pieces.find((p) => p.id === w2Accepted.piece.id) || {}).path || [];
    const pursesBefore = {
      blue: w2StoredBefore.match.sides.blue.cash,
      red: w2StoredBefore.match.sides.red.cash,
    };
    const blueSeatCash = Number((lastRoom(rivalSock).seat || {}).cash);
    const measureMark = rivalSock.box.length;
    await sendWait(rivalSock, { op: "switch_sides" }, (m) => m.op === "switched", "the measure switch");
    // A frame from THIS room at this mark: the same socket held an earlier two-human room where it
    // was also red, and a scan from zero finds that one.
    const w2After = await waitFrame(rivalSock,
      (m) => m.op === "room" && m.room && String(m.room.id) === String(w2.id) && m.room.you === "red",
      "the measure flipped room", measureMark);
    const w2StoredAfter = storedRoom(ctx, w2.id);
    const pathAfter = (w2StoredAfter.match.pieces.find((p) => p.id === w2Accepted.piece.id) || {}).path || [];
    const pursesAfter = {
      blue: w2StoredAfter.match.sides.blue.cash,
      red: w2StoredAfter.match.sides.red.cash,
    };
    const redSeatCash = Number((w2After.room.seat || {}).cash);
    console.log("pb309 (measure): a path in flight on the side being taken "
      + JSON.stringify(pathBefore) + " -> " + JSON.stringify(pathAfter));
    console.log("pb309 (measure): purses blue/red " + JSON.stringify(pursesBefore) + " -> " + JSON.stringify(pursesAfter)
      + "; the seat's own cash " + blueSeatCash + " -> " + redSeatCash
      + "; the flipped seat's log " + ((w2After.room.log || []).length) + " line(s)");
    if (JSON.stringify(pathBefore) !== JSON.stringify(pathAfter)) {
      fail("pb309 (measure): a path in flight on the side being taken was changed by the swap: "
        + JSON.stringify(pathBefore) + " -> " + JSON.stringify(pathAfter));
    }
    if (JSON.stringify(pursesBefore) !== JSON.stringify(pursesAfter)) {
      fail("pb309 (measure): the swap rewrote a side's purse: " + JSON.stringify(pursesBefore)
        + " -> " + JSON.stringify(pursesAfter));
    }
    if (redSeatCash !== Number(pursesBefore.red)) {
      fail("pb309 (measure): the seat after the swap does not hold the red purse: " + redSeatCash
        + " vs " + JSON.stringify(pursesBefore));
    }
    if (blueSeatCash !== Number(pursesBefore.blue)) {
      fail("pb309 (measure): the blue seat's cash before the swap was not the blue purse: " + blueSeatCash
        + " vs " + JSON.stringify(pursesBefore));
    }
    if (Number(pursesBefore.blue) === Number(pursesBefore.red)) {
      fail("pb309 (measure): the two purses are equal, so the swap is not discriminating: "
        + JSON.stringify(pursesBefore));
    }
  } finally {
    try { sock.close(); } catch { /* closed */ }
    try { rivalSock.close(); } catch { /* closed */ }
    try { layoutSock.close(); } catch { /* closed */ }
  }
}
