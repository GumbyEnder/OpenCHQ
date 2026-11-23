// PB-164: the speed pair works at a paused clock, and the header says so.
//
// Filed at ff31844: "with the clock paused, the speed - control does not change the speed". Measured
// on the shipped build (browser, real clicks): a held 1986 match at speed 1 DID step to 0 and back -
// the server applies a speed step at a hold by design (lobby.setSpeed writes room.speed and only
// restarts the round clock when it is running). What the header showed was a bare "Speed 1" over a
// paused board: the one thing the arrows could not do - the floor at 0 - was a disabled button with
// the title still reading "Slower (speed -)", and nothing said a step taken while paused is the speed
// the match runs at when Play is pressed. That is the defect this node binds.
//
// Three arms:
//   1. wire: at a held clock -1 and +1 move the room's number, the clock stays held, and Play then
//      runs at the number the player set;
//   2. the floor is a no-op, not an error (the PB-129 shape, kept);
//   3. source: the readout names the hold, the arrows keep a working step at a hold, and a disabled
//      arrow carries the reason instead of the plain label.
export const name = "pb164_speed_held";

export async function run(ctx) {
  const { fail } = ctx;
  const user = await ctx.register();
  const socket = ctx.socket(user.token);
  await socket.wait((m) => m.op === "welcome", "welcome");

  socket.send({ op: "bot", era: "1986", side: "blue" });
  const opened = await socket.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  const roomId = opened.room.id;
  if (opened.room.clock !== "held") fail("a fresh match should open held, got clock " + opened.room.clock);

  const room = () => socket.box.filter((m) => m.op === "room" && m.room && m.room.id === roomId).pop().room;
  if (Number(room().speed) !== 1) fail("a fresh match should open at speed 1, got " + room().speed);

  // ---- 1. a step at a held clock is applied and leaves the clock held -----------------------
  let from = socket.box.length;
  socket.send({ op: "speed", delta: -1 });
  const down = await socket.wait((m) => (m.op === "speed") || (m.op === "error"), "answer to -1 while held", from);
  if (down.op === "error") fail("a speed step at a held clock was refused: " + JSON.stringify(down));
  if (Number(down.speed) !== 0) fail("a -1 at speed 1 landed on " + down.speed);
  if (String(down.clock) !== "held") fail("the speed frame dropped the held clock: " + JSON.stringify(down));

  from = socket.box.length;
  socket.send({ op: "speed", delta: 1 });
  const up = await socket.wait((m) => (m.op === "speed") || (m.op === "error"), "answer to +1 while held", from);
  if (up.op === "error") fail("a +1 at a held clock was refused: " + JSON.stringify(up));
  if (Number(up.speed) !== 1) fail("a +1 at speed 0 landed on " + up.speed);
  if (String(up.clock) !== "held") fail("the +1 frame started the clock: " + JSON.stringify(up));

  // Two more steps so Play resumes on a number the player chose, not the default.
  socket.send({ op: "speed", delta: 1 });
  await socket.wait((m) => m.op === "speed" && Number(m.speed) === 2, "speed 2 while held");

  from = socket.box.length;
  socket.send({ op: "run" });
  await socket.wait((m) => (m.op === "room" && m.room && m.room.id === roomId && m.room.clock === "running") ||
    (m.op === "speed" && m.clock === "running"), "clock running after Play", from);
  if (Number(room().speed) !== 2) fail("the held speed was lost when Play ran: " + room().speed);

  // ---- 2. the floor is a no-op, not a refusal ----------------------------------------------
  socket.send({ op: "hold" });
  await socket.wait((m) => m.op === "room" && m.room && m.room.id === roomId && m.room.clock === "held", "held again");
  socket.send({ op: "speed", speed: 0 });
  await socket.wait((m) => m.op === "speed" && Number(m.speed) === 0, "speed 0");
  // Settle briefly, then read the frames this step drew: a wait() can return on the frame that
  // crossed the boundary, and the answer to the next step is what this arm grades.
  await new Promise((resolve) => setTimeout(resolve, 120));
  from = socket.box.length;
  socket.send({ op: "speed", delta: -1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const floor = socket.box.slice(from).find((m) => m.op === "speed" || m.op === "error");
  if (!floor) fail("a step past the floor drew no answer: " + JSON.stringify(socket.box.slice(from).map((m) => m.op)));
  if (floor.op === "error") fail("a step past the floor drew a refusal instead of a no-op: " + JSON.stringify(floor));
  if (Number(floor.speed) !== 0) fail("a step past the floor moved the speed to " + floor.speed);
  if (floor.unchanged !== true) fail("a step past the floor did not say it changed nothing: " + JSON.stringify(floor));
  socket.close();

  // ---- 3. the served page: readout names the hold, arrows stay usable and explain themselves
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!/function roomHeld\(/.test(app)) fail("app.js has no held-clock predicate");
  const speedBlock = app.slice(app.indexOf("function syncSpeed("), app.indexOf("function syncGameButtons("));
  if (!/held \? " \\u00b7 held"/.test(speedBlock)) {
    fail("the readout does not name a held clock");
  }
  if (!/speed === 0 \? " \\u00b7 paused"/.test(speedBlock)) fail("the floor no longer reads as paused");
  if (!/speedDown\.disabled = !room \|\| speed <= 0;/.test(speedBlock)) fail("the down arrow is not disabled at the floor");
  if (!/speedUp\.disabled = !room \|\| speed >= 6;/.test(speedBlock)) fail("the up arrow is not disabled at the top");
  if (!/already at 0, the slowest/.test(speedBlock)) fail("a disabled down arrow does not say why");
  if (!/already at 6, the fastest/.test(speedBlock)) fail("a disabled up arrow does not say why");
  if (!/applies now, and is the speed it runs at when you press Play/.test(speedBlock)) {
    fail("a step taken at a hold does not say it sets the resume speed");
  }
  // Neither arrow may be disabled merely because the clock is held.
  if (/disabled = [^;]*roomHeld\(\)/.test(speedBlock)) fail("the arrows are disabled on a held clock; the step must still apply");

  // The click path must still send relative steps, never an absolute speed.
  if (/op: "speed", speed:/.test(app)) fail("the page sends an absolute speed; the control is a pair of steps");

  console.log("pb164_speed_held: steps apply at a hold, Play keeps the number, the header explains itself");
}
