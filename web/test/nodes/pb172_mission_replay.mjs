// PB-172 node: a mission is an order, and one order id is answered once.
//
// The defect this node exists for: the mission ack carried no id (main.mjs sent `{op:"ack",
// events}`), so the page — which settles an order BY ID — never settled a mission. The mission id
// stayed in orderQueue and was replayed on the next socket open, where the server saw the aircraft
// already away and answered "That aircraft is inactive for 8 more rounds."; the page painted that
// as an error toast even though the bomb had landed.
//
// What is measured here, on a real socket and a real server:
//   1. a mission sent with an id gets an ack carrying THAT id (and its events);
//   2. the same frame sent again is answered from the server's memory of the first reply
//      (`duplicate: true`, the same events) and is NEVER refused;
//   3. the replay applies nothing: the target's readyRound and the aircraft's roundsLeft are the
//      same before and after the duplicate.
export const name = "pb172_mission_replay";

function readyCells(message) {
  const binary = Buffer.from(String(message.mask), "base64");
  const width = Number(message.width);
  const height = Number(message.height);
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (binary[y * width + x] === 1) out.push({ x, y });
    }
  }
  return out;
}

function firstReadyCell(message) {
  const cells = readyCells(message);
  return cells.length ? cells[0] : null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const user = await ctx.register();
  const sock = ctx.socket(user.token);
  await sock.wait((m) => m.op === "welcome", "welcome");

  sock.send({ op: "bot", era: "1986", side: "blue" });
  const opening = await sock.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  const roomId = opening.room.id;
  sock.send({ op: "hold" });

  // ---- one aircraft, bought and placed through the same frames the page sends -----------------
  sock.send({ op: "placement", kind: "aircraft" });
  const mask = await sock.wait((m) => m.op === "placement" && m.kind === "aircraft", "placement mask");
  if (mask.error || !mask.mask) fail("no aircraft placement mask: " + JSON.stringify(mask));
  // PB-178: the plane is based where it is bought, so the berth is chosen for its REACH: the ready
  // cell nearest an enemy city or base. The first cell in the mask can sit an ocean away from any
  // target, and a bombing run is now refused outside the restricted air radius.
  const width = Number(mask.width) || 320;
  const ports = ((opening.room || {}).sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
  const dist = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(width - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };
  const options = readyCells(mask).map((c) => ({
    c, near: ports.length ? Math.min(...ports.map((s) => dist(c, s))) : 0,
  })).sort((a, b) => a.near - b.near);
  const cell = options.length ? options[0].c : null;
  if (!cell) fail("the aircraft placement mask offered no ready cell");

  const buyId = "pb172-buy-air-1";
  sock.send({ op: "buy", id: buyId, kind: "aircraft", x: cell.x, y: cell.y });
  const bought = await sock.wait((m) => m.op === "bought" && m.id === buyId, "aircraft bought");
  const planeId = String(bought.piece || "");
  if (!planeId) fail("the bought frame names no piece: " + JSON.stringify(bought));

  // ---- one mission, on the nearest enemy port the server accepts -----------------------------
  // PB-178: a bombing run's target must lie inside the restricted air radius (manual p.25), so the
  // candidates are the enemy ports INSIDE that circle, nearest first, rather than the first eight in
  // the view - a far port is now refused for distance and would test the radius, not the replay.
  const view = () => (sock.box.filter((m) => m.op === "room" && m.room && m.room.id === roomId).pop() || {}).room;
  const briefing = (((view() || {}).seat && view().seat.air) || []).find((p) => String(p.id) === planeId) || {};
  const cells = Math.floor(Number(briefing.restrictedReach)) || 0;
  const away = (s) => {
    const dx = Math.abs(Number(cell.x) - Number(s.x));
    return Math.max(Math.min(dx, Math.abs(width - dx)), Math.abs(Number(cell.y) - Number(s.y)));
  };
  const candidates = ((view() || {}).sites || [])
    .filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"))
    .filter((s) => cells <= 0 || away(s) <= cells)
    .sort((a, b) => away(a) - away(b));
  if (!candidates.length) fail("the view carries no enemy city inside the restricted air radius to aim at");

  let mission = null;
  let ack = null;
  for (const site of candidates) {
    const id = "pb172-mission-1";
    const frame = { op: "mission", kind: "mission", id, piece: planeId, mode: "bomb", to: { x: site.x, y: site.y } };
    const from = sock.box.length;
    sock.send(frame);
    const answer = await sock.wait((m) => (m.op === "ack" || m.op === "error") && m.id === id, "mission answer", from);
    if (answer.op === "ack") {
      mission = frame;
      ack = answer;
      break;
    }
  }
  if (!mission) fail("no enemy site accepted a bombing run; every candidate was refused");

  if (ack.id !== mission.id) fail("the mission ack carries id " + JSON.stringify(ack.id) + ", not " + mission.id);
  if (!Array.isArray(ack.events) || !ack.events.length) fail("the mission ack carries no events: " + JSON.stringify(ack));

  const target = mission.to;
  const before = view() || {};
  const siteBefore = (before.sites || []).find((s) => Number(s.x) === Number(target.x) && Number(s.y) === Number(target.y));
  const airBefore = ((before.seat && before.seat.air) || []).find((p) => String(p.id) === planeId);
  if (!airBefore) fail("the aircraft is not in the seat's air briefing after the mission");

  // ---- the replay: the exact frame a reconnect flush sends -------------------------------------
  const fromReplay = sock.box.length;
  sock.send(mission);
  const replay = await sock.wait((m) => (m.op === "ack" || m.op === "error") && m.id === mission.id, "replay answer", fromReplay);
  if (replay.op === "error") {
    fail("a replayed mission was refused: " + JSON.stringify(replay.error));
  }
  if (replay.duplicate !== true) fail("a replayed mission was re-applied instead of answered from memory: " + JSON.stringify(replay));
  const replayEvents = (replay.events || []).length;
  if (replayEvents !== (ack.events || []).length) {
    fail("the replay's answer carries " + replayEvents + " events, the first answer carried " + (ack.events || []).length);
  }
  const refused = sock.box.slice(fromReplay).filter((m) => m.op === "error");
  if (refused.length) fail("a replay put a refusal on the wire: " + JSON.stringify(refused.map((m) => m.error)));

  // ---- nothing was applied twice --------------------------------------------------------------
  sock.send({ op: "sync" });
  const after = await sock.wait((m) => m.op === "room" && m.room && m.room.id === roomId, "room after replay", fromReplay);
  const roomAfter = after.room;
  const siteAfter = (roomAfter.sites || []).find((s) => Number(s.x) === Number(target.x) && Number(s.y) === Number(target.y));
  const airAfter = ((roomAfter.seat && roomAfter.seat.air) || []).find((p) => String(p.id) === planeId);
  if (!siteAfter || !airAfter) fail("the room lost the target or the aircraft after the replay");
  if (Number(siteAfter.readyRound) !== Number(siteBefore && siteBefore.readyRound)) {
    fail("the replay charged the site again: readyRound " + (siteBefore && siteBefore.readyRound) + " -> " + siteAfter.readyRound);
  }
  if (Number(airAfter.roundsLeft) !== Number(airBefore.roundsLeft)) {
    fail("the replay spent the aircraft again: roundsLeft " + airBefore.roundsLeft + " -> " + airAfter.roundsLeft);
  }

  console.log("pb172_mission_replay: the ack names the order; a replay is answered from memory, never refused, and charges nothing");
}
