// pb317_show_common_persist — Show Common survives Switch Sides, dies with the room.
// (manual p.35 l.1119-1120 the mode; l.1133-1135 "step 4 sets Show Common, THEN presses Switch
// Sides; step 5 the next player toggles Show-Who to his own side")
//
// What breaks if this is removed:
//   - the mode does not follow the seat      -> a player who set Common and switched sides arrives on
//                                               the other side in Normal, with the War panel's own
//                                               button already reading Common (the two disagree);
//   - the mode is stored on the room/MATCH   -> it becomes a setting both players inherit, and the
//                                               opponent's frames carry a view they never chose
//                                               (PB-310's "opponent sees nothing" proof);
//   - the mode outlives its room             -> Leave, start a fresh war on the same room id, and the
//                                               new game opens already thinned out while its own slot
//                                               says "Show Common" for a press nobody made;
//   - the off frame keeps a showCommon block -> the footer's fixed slot has something to paint in
//                                               Normal, and the page cannot tell the modes apart.
//
// The page-side half of AC (a)-(e) lives in tests/e2e/pb317-show-common-flag.mjs; this file pins the
// wire facts that half reads, so a page leg that goes green against a stale field still has a red.
//
// All assertions are off the socket, not off view.mjs: `forSeat` is the producer, and a leg that
// calls it directly would grade the payload with the code that made it.

export const name = "pb317_show_common_persist";

function fail(message) {
  throw new Error("node test pb317_show_common_persist: " + message);
}

function ok(value, message) {
  if (!value) fail(message);
}

export async function run(ctx) {
  if (!ctx || typeof ctx.register !== "function") {
    fail("no socket harness in the test context");
  }
  const player = await ctx.register("pb317_common");
  const sock = ctx.socket(player.token);
  await sock.wait((m) => m.op === "welcome", "the welcome");

  // ---- 1. a solo war opens in Normal ------------------------------------------------------------
  let mark = sock.box.length;
  sock.send({ op: "bot", era: "1942", side: "blue" });
  const opened = await sock.wait((m) => m.op === "room" && m.room && m.room.mode === "bot",
    "the bot room", mark, 30000);
  ok(!("showCommon" in opened.room), "a fresh war opened carrying a showCommon field");
  ok(opened.room.you === "blue", "the solo war did not open on the side that was asked for: " + opened.room.you);

  // ---- 2. the mode goes on as a WHOLE frame -----------------------------------------------------
  mark = sock.box.length;
  sock.send({ op: "show_common" });
  const ackOn = await sock.wait((m) => m.op === "show_common", "the on ack", mark, 20000);
  ok(ackOn.on === true, "the toggle ack did not say on: " + JSON.stringify(ackOn));
  const common = await sock.wait((m) => m.op === "room" && m.room && m.room.showCommon
    && m.room.showCommon.on === true, "the Common frame", mark, 20000);
  ok(common.room.you === "blue", "the Common frame came from the wrong seat: " + common.room.you);

  // ---- 3. Switch Sides KEEPS the mode and the seat keeps its own frame --------------------------
  mark = sock.box.length;
  sock.send({ op: "switch_sides" });
  const switched = await sock.wait((m) => m.op === "switched", "the switch ack", mark, 20000);
  ok(switched.side === "red", "the switch did not land on the other side: " + JSON.stringify(switched));
  const afterSwap = await sock.wait((m) => m.op === "room" && m.room && m.room.you === "red",
    "the frame for the new side", mark, 20000);
  ok(afterSwap.room.showCommon && afterSwap.room.showCommon.on === true,
    "Switch Sides dropped Show Common: the new side arrived in Normal (manual p.35 l.1133-1135)");

  // ---- 4. the swap does not leave a copy behind on the side that was given up -------------------
  // The abandoned seat is a bot's now, so nothing is sent to it; the fact to pin is that the mode is
  // still exactly one seat's, and that the seat that holds it can still turn it OFF from the new side.
  mark = sock.box.length;
  sock.send({ op: "show_common" });
  const ackOff = await sock.wait((m) => m.op === "show_common", "the off ack after the swap", mark, 20000);
  ok(ackOff.on === false, "the press from the new side did not say off: " + JSON.stringify(ackOff));
  const normal = await sock.wait((m) => m.op === "room" && m.room && m.room.you === "red"
    && m.room.pieces !== undefined && !m.room.showCommon, "the Normal frame after the swap", mark, 20000);
  ok(!("showCommon" in normal.room), "the off frame still carried a showCommon block");

  // ---- 5. Leave ends the mode with the room -----------------------------------------------------
  // Common is ON when the player leaves: that is the state that could leak into the next war.
  mark = sock.box.length;
  sock.send({ op: "show_common" });
  await sock.wait((m) => m.room && m.room.showCommon && m.room.showCommon.on === true,
    "Common on before leaving", mark, 20000);
  mark = sock.box.length;
  sock.send({ op: "leave" });
  const gone = await sock.wait((m) => m.op === "room" && m.room === null, "the leave", mark, 20000);
  ok(gone.room === null, "leave did not close the room: " + JSON.stringify(gone));
  const roomId = common.room.id;

  // A fresh war is Normal, and — the arm that matters — the mode is not left behind on the lobby's
  // map for the room id that was just thrown away.
  mark = sock.box.length;
  sock.send({ op: "bot", era: "1942", side: "blue" });
  const reopened = await sock.wait((m) => m.op === "room" && m.room && m.room.mode === "bot",
    "the next war", mark, 30000);
  ok(!("showCommon" in reopened.room),
    "a war opened after Leave carrying the previous game's Show Common (room " + roomId + ")");
  ok(reopened.room.pieces.some((p) => p.side === "blue"),
    "the next war opened with no blue pieces to draw");
}
