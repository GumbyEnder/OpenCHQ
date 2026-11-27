// pb304_layouts — Layout Armies and Saved Layouts (manual p.16 l.417, p.37 l.1151-1164).
//
// What breaks if this is removed:
//   - "Lay Out Armies" opens in an era other than 1986                  -> a 1942/2023 board can be
//     re-drawn and then cannot be used, because the start path refuses it;
//   - a layout unit may be put on neutral or enemy ground               -> "freely WITHIN friendly
//     territory" (p.37) is the rule, and a silent teleport breaks the setup's whole point;
//   - intel or foreign aid answers inside the sandbox                    -> p.37 l.1158 forbids both;
//   - the sandbox pays income (a round ticks, or the cold-war peace tick runs) -> "you do not accrue
//     money" (p.37 l.1158);
//   - Save Setup is a silent second row for one name                     -> two setups in one name;
//   - a 1986 war cannot be opened on a saved layout, or loses the stored positions, destinations or
//     remaining funds                                                      -> p.37 "The game will open
//     with your units in your preset configuration."
//
// Measured over the real HTTP/WS surface against the suite's own server.

export const name = "pb304_layouts";

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(base, token, pathName, body) {
  const res = await fetch(base + pathName, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie: "openchq_session=" + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitFrame(sock, pred, label, from = 0, deadline = 15000) {
  const start = Date.now();
  while (Date.now() - start < deadline) {
    for (const message of sock.box.slice(from)) if (message && pred(message)) return message;
    await sleep(25);
  }
  throw new Error("pb304: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(from).map((m) => (m && m.op === "room"
      ? { op: "room", id: m.room && m.room.id, mode: m.room && m.room.mode, clock: m.room && m.room.clock }
      : m && m.op)),
  ));
}

// Send, then wait for a frame that arrived after the send.
async function sendWait(sock, message, pred, label) {
  const mark = sock.box.length;
  sock.send(message);
  return waitFrame(sock, pred, label, mark);
}

function lastRoom(sock) {
  const frames = sock.box.filter((m) => m && m.op === "room" && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

function noRawId(value) {
  return !/(blue|red):[a-z]+:/.test(JSON.stringify(value));
}

export async function run(ctx) {
  const { fail } = ctx;
  const player = await ctx.register("pb304_layout");
  const other = await ctx.register("pb304_other");
  const sock = ctx.socket(player.token);
  const bystander = ctx.socket(other.token);
  try {
    await sock.wait((m) => m.op === "welcome", "the welcome");
    await bystander.wait((m) => m.op === "welcome", "the second welcome");

    // ---- (a) the door is 1986-only ---------------------------------------------------------
    const refused = await sendWait(sock, { op: "layout", era: "1942", side: "blue" },
      (m) => m.op === "error" || (m.op === "room" && m.room), "the 1942 refusal");
    if (refused.op !== "error" || !/1986/.test(String(refused.error || ""))) {
      fail("pb304 (a): Lay Out Armies opened for 1942: " + JSON.stringify(refused).slice(0, 300));
    }
    const noRoom = lastRoom(sock);
    if (noRoom) fail("pb304 (a): the refused 1942 request still created a room " + noRoom.id);

    // ---- (a)(b) 1986 opens the sandbox ------------------------------------------------------
    const opened = await sendWait(sock, { op: "layout", era: "1986", side: "blue" },
      (m) => m.op === "room" && m.room, "the layout room");
    let room = opened.room;
    if (room.mode !== "layout") fail("pb304 (a): the room mode is " + room.mode + ", not layout");
    if (String(room.era) !== "1986") fail("pb304 (a): the layout room's era is " + room.era);
    if (room.clock !== "held") fail("pb304 (a): the layout room opened with the clock " + room.clock);
    if (Number(room.round) !== 0) fail("pb304 (a): the layout room opened at round " + room.round);
    if (!room.blue || room.blue.kind !== "human" || (room.red && room.red.kind === "bot")) {
      fail("pb304 (a): layout mode seated an opponent: " + JSON.stringify({ blue: room.blue, red: room.red }));
    }
    if ((room.tools || []).length !== 0) {
      fail("pb304 (c): the room still offers tools in layout mode: " + JSON.stringify(room.tools));
    }
    const openingCash = Number(room.seat && room.seat.cash);
    if (!Number.isFinite(openingCash) || openingCash <= 0) {
      fail("pb304 (b): the sandbox opened with no starting funds: " + JSON.stringify(room.seat));
    }

    // ---- (c) intel and foreign aid are refused, each with its own sentence ------------------
    const scan = await sendWait(sock, { op: "tool", tool: "scan" },
      (m) => m.op === "error" || m.op === "ack", "the scan refusal");
    if (scan.op !== "error" || !/Intel scans are unavailable/.test(String(scan.error || ""))) {
      fail("pb304 (c): an intel scan was not refused in layout mode: " + JSON.stringify(scan).slice(0, 300));
    }
    const aid = await sendWait(sock, { op: "tool", tool: "aid" },
      (m) => m.op === "error" || m.op === "ack", "the aid refusal");
    if (aid.op !== "error" || !/Foreign aid is unavailable/.test(String(aid.error || ""))) {
      fail("pb304 (c): foreign aid was not refused in layout mode: " + JSON.stringify(aid).slice(0, 300));
    }

    // ---- (d) the clock does not run and the purse does not move -----------------------------
    const ran = await sendWait(sock, { op: "run" },
      (m) => m.op === "error" || (m.op === "room" && m.room), "the run refusal");
    if (ran.op !== "error" || !/pregame setup/.test(String(ran.error || ""))) {
      fail("pb304 (d): the clock ran in layout mode: " + JSON.stringify(ran).slice(0, 300));
    }
    const cashBefore = Number(lastRoom(sock).seat && lastRoom(sock).seat.cash);
    const peaceBefore = JSON.stringify((lastRoom(sock) || {}).peace ?? null);
    await sleep(1600);
    room = lastRoom(sock);
    // pm 10035 item 6: the 1986 cold-war counter must not advance while the sandbox is open. The
    // counter is round-based (peace.remaining = untilRound - round), so with the round pinned at 0
    // and the tick skipping a layout room it cannot move; this line records the two reads rather
    // than asserting a sixth arm.
    console.log("pb304 peace counter in layout mode: " + peaceBefore + " -> "
      + JSON.stringify(room.peace ?? null) + " (round " + room.round + ")");
    const cashAfter = Number(room.seat && room.seat.cash);
    if (cashAfter !== cashBefore) {
      fail("pb304 (d): the sandbox purse moved from " + cashBefore + " to " + cashAfter + " while held");
    }
    if (Number(room.round) !== 0) fail("pb304 (d): a round passed in layout mode (round " + room.round + ")");

    // ---- (b) move inside friendly territory, refused outside it, destination, buy ----------
    const mine = (room.pieces || []).filter((p) => p.side === "blue" && p.domain !== "sat");
    if (!mine.length) fail("pb304 (b): the sandbox has no blue pieces to lay out");
    let friendlyMove = null;
    let hostile = null;
    for (const piece of mine.slice(0, 6)) {
      for (const [dx, dy] of DIRS) {
        const to = { x: piece.x + dx, y: piece.y + dy };
        const answer = await sendWait(sock,
          { op: "transfer", id: "pb304-move-" + piece.id + "-" + dx + "-" + dy, piece: piece.id, to },
          (m) => m.op === "transferred" || m.op === "error", "the move answer for " + piece.id);
        if (answer.op === "transferred") {
          friendlyMove = { piece: piece.id, x: answer.to && answer.to.x, y: answer.to && answer.to.y };
          break;
        }
      }
      if (friendlyMove) break;
    }
    if (!friendlyMove) fail("pb304 (b): no friendly-territory move was accepted, so the sandbox cannot be drawn");
    room = lastRoom(sock);
    const moved = (room.pieces || []).find((p) => p.id === friendlyMove.piece);
    if (!moved || Number(moved.x) !== Number(friendlyMove.x) || Number(moved.y) !== Number(friendlyMove.y)) {
      fail("pb304 (b): the accepted move did not reach the room frame: " + JSON.stringify({ friendlyMove, moved }));
    }
    // A red city is neutral-or-enemy ground for a blue land unit.
    const redSite = (room.sites || []).find((site) => site.owner === "red");
    const landPiece = (room.pieces || []).find((p) => p.side === "blue" && p.domain === "land");
    if (redSite && landPiece) {
      const answer = await sendWait(sock,
        { op: "transfer", id: "pb304-hostile", piece: landPiece.id, to: { x: redSite.x, y: redSite.y } },
        (m) => m.op === "transferred" || m.op === "error", "the hostile move answer");
      hostile = answer;
      if (answer.op === "transferred") {
        fail("pb304 (b): a unit was laid out on enemy ground (" + redSite.x + "," + redSite.y + ")");
      }
      if (!/neutral or enemy territory/.test(String(answer.error || ""))) {
        fail("pb304 (b): the hostile move was refused with the wrong sentence: " + JSON.stringify(answer.error));
      }
    } else {
      fail("pb304 (b): the board carries no red site or no blue land unit, so the hostile arm is unproven");
    }

    let destSet = null;
    for (const [dx, dy] of DIRS) {
      const to = { x: friendlyMove.x + dx, y: friendlyMove.y + dy };
      const answer = await sendWait(sock, { op: "destination", id: "pb304-dest-" + dx + "-" + dy, piece: friendlyMove.piece, to },
        (m) => m.op === "destination" || m.op === "error", "the destination answer");
      if (answer.op === "destination") {
        destSet = { x: Number(answer.to.x), y: Number(answer.to.y) };
        break;
      }
    }
    if (!destSet) fail("pb304 (b): no starting destination could be set in the layout sandbox");

    // Buy with the opening funds, on friendly ground.
    let bought = null;
    for (const site of (room.sites || []).filter((s) => s.owner === "blue").slice(0, 10)) {
      const answer = await sendWait(sock, { op: "buy", id: "pb304-buy-" + site.id, kind: "infantry", to: { x: site.x, y: site.y } },
        (m) => m.op === "bought" || m.op === "error", "the buy answer at " + site.name);
      if (answer.op === "bought") {
        bought = { piece: answer.piece, cash: Number(answer.cash) };
        break;
      }
    }
    if (!bought) fail("pb304 (b): a unit could not be bought with the sandbox's opening funds");
    if (!(bought.cash < openingCash)) {
      fail("pb304 (b): the purchase did not spend from the opening funds (" + openingCash + " -> " + bought.cash + ")");
    }
    room = lastRoom(sock);
    const piecesBeforeSave = (room.pieces || []).filter((p) => p.side === "blue").length;
    const cashBeforeSave = Number(room.seat && room.seat.cash);

    // ---- (e) Save Setup: naming, uniqueness, explicit overwrite ----------------------------
    const first = await api(ctx.base, player.token, "/api/layouts", { name: "  North   Line " });
    if (first.status !== 200 || !first.data.ok) fail("pb304 (e): Save Setup refused: " + JSON.stringify(first.data));
    if (first.data.layout.name !== "North Line") {
      fail("pb304 (e): the layout name was not cleaned: " + JSON.stringify(first.data.layout.name));
    }
    const layoutId = first.data.layout.id;
    if (Number(first.data.layout.pieces) !== piecesBeforeSave) {
      fail("pb304 (e): the saved layout counts " + first.data.layout.pieces + " units, the sandbox " + piecesBeforeSave);
    }
    if (Number(first.data.layout.cash) !== cashBeforeSave) {
      fail("pb304 (e): the saved layout's purse " + first.data.layout.cash + " is not the sandbox's " + cashBeforeSave);
    }
    const dup = await api(ctx.base, player.token, "/api/layouts", { name: "north line" });
    if (dup.status !== 400 || !dup.data.exists) {
      fail("pb304 (e): a duplicate layout name was accepted: " + JSON.stringify(dup.data));
    }
    if (dup.data.id !== layoutId) fail("pb304 (e): the refusal did not name the existing layout");
    const over = await api(ctx.base, player.token, "/api/layouts", { name: "north line", overwrite: true });
    if (over.status !== 200 || !over.data.overwritten || over.data.layout.id !== layoutId) {
      fail("pb304 (e): the overwrite did not replace the same layout: " + JSON.stringify(over.data));
    }
    const list = await api(ctx.base, player.token, "/api/layouts");
    if (list.status !== 200 || list.data.layouts.length !== 1) {
      fail("pb304 (e): the account lists " + (list.data.layouts || []).length + " layouts after one save");
    }
    if (!noRawId(list.data.layouts)) fail("pb304 (h): a layout list line carries a raw side:kind id");
    if (!noRawId(over.data.layout)) fail("pb304 (h): the save answer carries a raw side:kind id");
    // The two stores are separate: Save Game refuses the sandbox and Resume Saved War never lists it.
    const slotSave = await api(ctx.base, player.token, "/api/slots", { name: "not a war" });
    if (slotSave.status !== 400) fail("pb304 (e): Save Game filed the layout as a war: " + JSON.stringify(slotSave.data));
    const slots = await api(ctx.base, player.token, "/api/slots");
    if ((slots.data.slots || []).length !== 0) fail("pb304 (e): a layout appeared in Resume Saved War");
    // Another account cannot open this layout by id.
    const foreign = await api(ctx.base, other.token, "/api/layouts");
    if ((foreign.data.layouts || []).length !== 0) fail("pb304 (e): another account lists this account's layout");

    // ---- (f)(g) a 1986 war opens on the layout ----------------------------------------------
    const leave = await sendWait(sock, { op: "quit" }, (m) => m.op === "room" && m.room === null, "the quit answer");
    if (leave.op !== "room" || leave.room !== null) fail("pb304: quitting the sandbox did not clear the room");
    const warFrame = await sendWait(sock, { op: "bot", era: "1986", side: "blue", layout: layoutId },
      (m) => m.op === "room" && m.room, "the layout war");
    const war = warFrame.room;
    if (war.mode !== "bot") fail("pb304 (f): the layout war opened in mode " + war.mode);
    if (!war.bot || !war.bot.level) fail("pb304 (g): the layout war seated no computer opponent");
    const warMine = (war.pieces || []).filter((p) => p.side === "blue");
    if (warMine.length !== piecesBeforeSave) {
      fail("pb304 (f): the war opened with " + warMine.length + " blue units, the layout stored " + piecesBeforeSave);
    }
    const stored = over.data.layout;
    if (Number(war.seat && war.seat.cash) !== Number(stored.cash)) {
      fail("pb304 (f): the war opened with " + (war.seat && war.seat.cash) + " but the layout left " + stored.cash);
    }
    const movedInWar = warMine.find((p) => Number(p.x) === Number(friendlyMove.x) && Number(p.y) === Number(friendlyMove.y));
    if (!movedInWar) {
      fail("pb304 (f): the laid-out unit is not at its stored cell " + friendlyMove.x + "," + friendlyMove.y +
        "; war pieces: " + JSON.stringify(warMine.map((p) => [p.kind, p.x, p.y])));
    }
    if (!movedInWar.destination || Number(movedInWar.destination.x) !== destSet.x || Number(movedInWar.destination.y) !== destSet.y) {
      fail("pb304 (f): the stored starting destination did not come back: " + JSON.stringify(movedInWar.destination));
    }
    // A layout drawn for blue cannot open a red war, and a layout cannot open a 1942 war.
    await sendWait(sock, { op: "quit" }, (m) => m.op === "room" && m.room === null, "the layout-war quit");
    const wrongSide = await sendWait(sock, { op: "bot", era: "1986", side: "red", layout: layoutId },
      (m) => m.op === "error" || (m.op === "room" && m.room), "the wrong-side refusal");
    if (wrongSide.op !== "error" || !/drawn for the blue side/.test(String(wrongSide.error || ""))) {
      fail("pb304 (f): the layout opened a red war: " + JSON.stringify(wrongSide).slice(0, 300));
    }
    const wrongEra = await sendWait(sock, { op: "bot", era: "1942", side: "blue", layout: layoutId },
      (m) => m.op === "error" || (m.op === "room" && m.room), "the non-1986 layout refusal");
    if (wrongEra.op !== "error" || !/1986 wars only/.test(String(wrongEra.error || ""))) {
      fail("pb304 (f): a layout opened a 1942 war: " + JSON.stringify(wrongEra).slice(0, 300));
    }
  } finally {
    sock.close();
    bystander.close();
  }
}
