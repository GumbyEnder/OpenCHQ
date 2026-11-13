// Every order has an id, and the server applies one id at most once. A socket that drops while
// a buy is in flight must not make the purchase vanish silently, and a resend must not buy twice.
export const name = "ws_order_queue";

function decodeCell(message) {
  const binary = Buffer.from(String(message.mask), "base64");
  const width = Number(message.width);
  const height = Number(message.height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (binary[y * width + x]) return { x, y };
    }
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const user = await ctx.register();

  const first = ctx.socket(user.token);
  await first.wait((m) => m.op === "welcome", "welcome");
  first.send({ op: "bot", era: "1942", side: "blue" });
  const opening = await first.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  const roomId = opening.room.id;

  first.send({ op: "placement", kind: "infantry" });
  const mask = await first.wait((m) => m.op === "placement" && m.kind === "infantry", "placement mask");
  if (mask.error || !mask.mask) fail("no placement mask: " + JSON.stringify(mask));
  const cell = decodeCell(mask);
  if (!cell) fail("the placement mask offered no cell");

  // The client sends an id with every order. The same id sent twice is the reconnect resend.
  // T-001 recovered the p.28 prices: infantry is 10 billion and the early start pool is 9, so a
  // seat cannot buy at round 0. Let city income land first — 13 cities x 50 million is 650 a
  // round, two rounds to afford the cheapest unit. That is the real opening of a 1942 match, not
  // a test shortcut, and this test is about order ids surviving a drop, not about economy.
  first.send({ op: "run" });
  const started = Date.now();
  let afford = null;
  while (!afford) {
    first.send({ op: "sync" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const m of first.box) {
      if (m.op === "room" && m.room && m.room.id === roomId && m.room.seat) afford = m;
    }
    if (afford && afford.room.seat.cash >= 10000) break;
    afford = null;
    if (Date.now() - started > 30000) {
      const last = first.box.filter((m) => m.op === "room" && m.room).pop();
      fail("income never made one infantry affordable: round " + (last && last.room.round)
        + ", cash " + (last && last.room.seat && last.room.seat.cash));
    }
  }
  first.send({ op: "hold" });
  const buy = { op: "buy", id: "test-buy-1", kind: "infantry", x: cell.x, y: cell.y };
  first.send(buy);
  await first.wait((m) => m.op === "bought" && m.id === "test-buy-1", "first buy");

  // The socket drops. A queued order is resent on the new socket with the same id.
  first.close();
  const second = ctx.socket(user.token);
  await second.wait((m) => m.op === "welcome", "welcome on reconnect");
  // Ask for the seat's whole room rather than waiting for an unsolicited frame: the rejoin may
  // arrive inside the welcome, and this node is about the order, not about which frame carried it.
  second.send({ op: "sync" });
  await second.wait((m) => m.op === "room" && m.room && m.room.id === roomId, "room after reconnect");
  second.send(buy);
  const ack = await second.wait((m) => (m.op === "ack" && m.id === "test-buy-1") ||
    (m.op === "bought" && m.id === "test-buy-1") ||
    (m.op === "error" && m.id === "test-buy-1"), "resend answer");

  // Exactly one purchase, and an answer the page can act on: never zero and silent. A resent buy is
  // answered from the server's memory of the first reply, flagged duplicate, so a page that lost the
  // original answer still learns the piece landed (PB-025) — and the piece count below is what
  // proves it was not applied twice.
  if (ack.op === "bought" && !ack.duplicate) fail("a resent buy executed twice instead of being recognised: " + JSON.stringify(ack));
  if (ack.op !== "ack" && ack.op !== "bought" && ack.op !== "error") fail("a resent buy was answered with an unknown op: " + JSON.stringify(ack));

  // Ask for the whole room and count the unit. It must be exactly one.
  second.send({ op: "sync" });
  const whole = await second.wait((m) => m.op === "room" && m.room && m.room.id === roomId, "sync room");
  // T-007 AC9 gives the opening force real kinds, so the board already carries the era's infantry
  // before the purchase: the count that matters is the one this buy added. T-013b: 1942 opens with
  // the original's own army (13 blue infantry pieces), so the opening count comes from the room the
  // server already sent, not from a constant.
  const infantry = (whole.room.pieces || []).filter(
    (piece) => piece.kind === "infantry" && piece.side === "blue"
  );
  const openingInfantry = (opening.room.pieces || []).filter(
    (piece) => piece.kind === "infantry" && piece.side === "blue"
  ).length;
  if (infantry.length !== openingInfantry + 1) {
    fail("a buy sent across a drop is on the board " + (infantry.length - openingInfantry) + " time(s), expected 1");
  }

  // An order is idempotent the same way: two copies of one id give one path.
  second.send({ op: "sync" });
  const fresh = await second.wait((m) => m.op === "room" && m.room && m.room.id === roomId, "sync before order");
  const army = (fresh.room.pieces || []).find((piece) => piece.side === "blue" && piece.domain === "land");
  if (!army) fail("no blue land piece in the room");
  // A destination that is really land: read the board the server serves.
  const board = await (await fetch(ctx.base + "/api/board")).json();
  let dest = null;
  for (let r = 1; r <= 6 && !dest; r++) {
    for (let dy = -r; dy <= r && !dest; dy++) {
      for (let dx = -r; dx <= r && !dest; dx++) {
        const x = ((army.x + dx) % board.width + board.width) % board.width;
        const y = army.y + dy;
        if (y < 0 || y >= board.height) continue;
        const id = board.cells[y * board.width + x];
        if (id !== null && id > 2 && id !== 14) dest = { x, y };
      }
    }
  }
  if (!dest) fail("no land cell near the blue army to order it to");
  const order = { op: "order", id: "test-order-1", piece: army.id, x: dest.x, y: dest.y };
  second.send(order);
  const ordered = await second.wait((m) => m.op === "ordered" && m.id === "test-order-1", "first order");
  if (!ordered) fail("the order was not acknowledged");
  second.send(order);
  const replay = await second.wait((m) => (m.op === "ordered" || m.op === "ack") && m.id === "test-order-1" && m.duplicate === true, "duplicate ack");
  if (!replay) fail("a duplicate order was not answered as a duplicate");

  second.close();
  console.log("ws_order_queue: one purchase across a drop, duplicate order acknowledged, no silent loss");
}
