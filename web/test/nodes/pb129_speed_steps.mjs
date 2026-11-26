// Node pb129_speed_steps: every step the speed control offers is a value the server accepts (PB-129).
//
// The defect: the header's up arrow sends a relative delta (+1) even at speed 6, where the button is
// disabled for a real pointer. A script-dispatched click (the PM's hand-check, a stale tab, a page a
// deploy behind) sent that delta, `clampSpeed(6 + 1)` answered null, and the player got "The speed
// must be a whole number from 0 to 6." for pressing a button that is not supposed to exist there.
// A second half: the server's `{op:"speed"}` reply had no handler in the page at all, so the header
// moved only because a `room` frame happened to follow it.
//
// This node drives the wire (a real socket against the suite's own server) for the server half, and
// pins the page's handler and guards from the served sources for the client half:
//   1. the delta steps 1 -> 6 are all accepted, with no error frame at any step;
//   2. a delta past the top (6 +1) and past the floor (0 -1) are no-ops: an `op:"speed"` and no
//      error, and the room's own number does not move;
//   3. an explicit out-of-range absolute speed (7) still errors, and a zero/NaN delta still errors —
//      the no-op is about a STEP past the end, not about accepting nonsense;
//   4. the page sends deltas and never an absolute speed, handles `op:"speed"`, and disables the
//      arrows at both ends.
//
// PB-267: the step loops match the answer's NUMBER, not its op. tellRoom() and the per-seat
// {op:"speed"} ack are two frames for one step, so the ack can still be in flight when the room
// frame answers; an op-only predicate let the next iteration adopt that stale ack and read the
// previous speed (the one-off "a +1 step at 2 landed on 2"). Both frames carry the new number, so
// requiring it changes no coverage and a step the server did not apply now times out instead of
// being misread.
export const name = "pb129_speed_steps";

export async function run(ctx) {
  const { fail } = ctx;
  const user = await ctx.register();
  const socket = ctx.socket(user.token);
  await socket.wait((m) => m.op === "welcome", "welcome");

  socket.send({ op: "bot", era: "1942", side: "blue" });
  const opened = await socket.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  const roomId = opened.room.id;

  function speedOfRoom() {
    const last = socket.box.filter((m) => m.op === "room" && m.room && m.room.id === roomId).pop();
    return last ? Number(last.room.speed) : NaN;
  }
  function mark() {
    return socket.box.length;
  }
  function errorsSince(from) {
    return socket.box.slice(from).filter((m) => m.op === "error");
  }

  // The room's opening speed is the number the steps start from, not an assumption.
  socket.send({ op: "sync" });
  await socket.wait((m) => m.op === "room" && m.room && m.room.id === roomId, "room after sync");
  const start = speedOfRoom();
  if (!Number.isInteger(start) || start < 0 || start > 6) fail("the room opened at speed " + start);

  // 1. Step to 6, one click at a time, and hold the server to accepting every step.
  if (start > 6) fail("start speed " + start + " is outside the offered range");
  while (speedOfRoom() < 6) {
    const from = mark();
    const before = speedOfRoom();
    const want = before + 1;
    socket.send({ op: "speed", delta: 1 });
    // PB-267: match on the NUMBER this step asks for, never on the frame's op alone. The server
    // sends tellRoom() and then a per-seat {op:"speed"} ack for the same step, so when only the room
    // frame has landed the ack is still in flight. An op-only predicate let the NEXT iteration take
    // that stale ack as its own answer and read the previous speed - the one-off "a +1 step at 2
    // landed on 2" (1942). Both frames carry the new number, so requiring it costs no coverage: a
    // step the server did not apply now times out as a missing answer instead of being read as an
    // ack for the wrong step.
    const reply = await socket.wait(
      (m) => (m.op === "room" && m.room && m.room.id === roomId && Number(m.room.speed) === want) ||
        (m.op === "speed" && Number(m.speed) === want) || (m.op === "error"),
      "answer to a +1 step at speed " + before + " (wanted " + want + ")", from);
    if (reply.op === "error") fail("a +1 step at speed " + before + " was refused: " + JSON.stringify(reply));
    const now = reply.op === "speed" ? Number(reply.speed) : Number(reply.room.speed);
    if (!(now === want)) fail("a +1 step at " + before + " landed on " + now);
    if (errorsSince(from).length) fail("a +1 step at speed " + before + " drew an error frame");
  }
  if (speedOfRoom() !== 6) fail("the steps did not reach the top: speed " + speedOfRoom());

  // 2. Past the top: a no-op with the room's own number, and no error sentence.
  const topFrom = mark();
  socket.send({ op: "speed", delta: 1 });
  // PB-267: the no-op's own ack is the only frame that says `unchanged`, so a stale ack for a
  // real step cannot be adopted as the answer to a step past the end.
  const topReply = await socket.wait((m) => (m.op === "speed" && m.unchanged === true) || m.op === "error", "answer to +1 at the top", topFrom);
  if (topReply.op === "error") fail("a step past the top was refused instead of being a no-op: " + JSON.stringify(topReply));
  if (Number(topReply.speed) !== 6) fail("a step past the top reported speed " + topReply.speed);
  if (topReply.unchanged !== true) fail("a step past the top did not say it changed nothing: " + JSON.stringify(topReply));
  const afterTop = errorsSince(topFrom);
  if (afterTop.length) fail("a step past the top drew " + afterTop.length + " error frame(s): " + JSON.stringify(afterTop[0]));
  socket.send({ op: "sync" });
  await socket.wait((m) => m.op === "room" && m.room && m.room.id === roomId, "room after the no-op");
  if (speedOfRoom() !== 6) fail("a no-op at the top moved the room's speed to " + speedOfRoom());

  // 3. Down to the floor, then past it.
  while (speedOfRoom() > 0) {
    const from = mark();
    const before = speedOfRoom();
    const want = before - 1;
    socket.send({ op: "speed", delta: -1 });
    // PB-267: the same stale-ack rule as the +1 loop above; the ack for the previous step can
    // still be in flight when the room frame for that step is the one that answered.
    const reply = await socket.wait(
      (m) => (m.op === "room" && m.room && m.room.id === roomId && Number(m.room.speed) === want) ||
        (m.op === "speed" && Number(m.speed) === want) || (m.op === "error"),
      "answer to a -1 step at speed " + before + " (wanted " + want + ")", from);
    if (reply.op === "error") fail("a -1 step at speed " + before + " was refused: " + JSON.stringify(reply));
    const now = reply.op === "speed" ? Number(reply.speed) : Number(reply.room.speed);
    if (!(now === want)) fail("a -1 step at " + before + " landed on " + now);
  }
  const floorFrom = mark();
  socket.send({ op: "speed", delta: -1 });
  const floorReply = await socket.wait((m) => (m.op === "speed" && m.unchanged === true) || m.op === "error", "answer to -1 at the floor", floorFrom);
  if (floorReply.op === "error") fail("a step past the floor was refused instead of being a no-op: " + JSON.stringify(floorReply));
  if (Number(floorReply.speed) !== 0) fail("a step past the floor reported speed " + floorReply.speed);
  if (errorsSince(floorFrom).length) fail("a step past the floor drew an error frame");

  // 4. Nonsense still errors: an explicit out-of-range speed, and a zero delta.
  const absoluteFrom = mark();
  socket.send({ op: "speed", speed: 7 });
  // PB-267: only an error can answer nonsense; waiting for a `speed` frame too let a stale ack be
  // read as acceptance. A server that accepts speed 7 now reds as a missing error, not as a pass.
  const absolute = await socket.wait((m) => m.op === "error", "error for speed 7", absoluteFrom);
  if (absolute.op !== "error") fail("an explicit out-of-range speed was accepted: " + JSON.stringify(absolute));
  if (!/whole number from 0 to 6/.test(String(absolute.error || ""))) {
    fail("the out-of-range sentence changed: " + JSON.stringify(absolute.error));
  }
  const zeroFrom = mark();
  socket.send({ op: "speed", delta: 0 });
  const zero = await socket.wait((m) => m.op === "error", "error for delta 0", zeroFrom);
  if (zero.op !== "error") fail("a zero delta was accepted: " + JSON.stringify(zero));

  socket.close();

  // The page half: deltas (never absolute), a handler for the server's own frame, guards at both ends.
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!/speedUp\?\.addEventListener\("click", \(\) => \{\s*\n\s*if \(!room\) return;\s*\n\s*send\(\{ op: "speed", delta: 1 \}\);/m.test(app)) {
    fail("the up arrow no longer sends a +1 delta");
  }
  if (!/speedDown\?\.addEventListener\("click", \(\) => \{\s*\n\s*if \(!room\) return;\s*\n\s*send\(\{ op: "speed", delta: -1 \}\);/m.test(app)) {
    fail("the down arrow no longer sends a -1 delta");
  }
  if (/op: "speed", speed:/.test(app)) {
    fail("the page sends an absolute speed to the server; the control is a pair of relative steps");
  }
  if (!/message\.op === "speed"/.test(app)) {
    fail('the page has no handler for the server\'s {op:"speed"} frame — the readout only moves on a room frame');
  }
  // The handler's own block, cut at the NEXT branch: a fixed character window reds correct code
  // whenever a comment grows, which is a test bug and not a regression.
  const speedAt = app.indexOf('message.op === "speed"');
  const nextBranch = app.indexOf("} else if (message.op ===", speedAt + 1);
  const speedBranch = app.slice(speedAt, nextBranch === -1 ? app.length : nextBranch);
  if (!/room\.speed = Number\(message\.speed\)/.test(speedBranch)) {
    fail("the op:speed handler does not take the server's number");
  }
  if (!/syncSpeed\(\)/.test(speedBranch)) fail("the op:speed handler does not sync the readout");
  if (!/speedUp\.disabled = !room \|\| speed >= 6;/.test(app)) fail("the up arrow is not disabled at the top of the range");
  if (!/speedDown\.disabled = !room \|\| speed <= 0;/.test(app)) fail("the down arrow is not disabled at the floor");
}
