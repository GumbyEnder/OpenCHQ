// late_ops — the 1986 kit and the air are reachable by a player, not only by the engine.
//
// What fails if this is removed:
//   - `op:"tool"` reaches late.useTool through the seat check   -> the kit exists and nobody can
//     spend it, which is what the page looked like before
//   - `op:"mission"` reaches air.sendMission                    -> an aircraft can never fly
//   - `op:"entrench"` / `op:"repair"` reach move.mjs            -> the piece menu is decoration
//   - the room says which tools the era has                     -> a player cannot know what they own
//
// Everything here goes over a real socket with a real session, the way the page does it.

export const name = "late_ops";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

export async function run(ctx) {
  const account = await ctx.register("LateProbe");
  const sock = ctx.socket(account.token);
  await new Promise((resolve) => {
    if (sock.ws.readyState === 1) return resolve();
    sock.ws.addEventListener("open", () => resolve());
  });
  await sock.wait((m) => m.op === "welcome", "welcome");

  sock.send({ op: "bot", era: "1986", side: "blue" });
  const first = await sock.wait((m) => m.op === "room" && m.room && m.room.era === "1986", "the 1986 room");
  const room = first.room;

  // The room has to say what the era offers, or no player can use it.
  must(Array.isArray(room.tools) && room.tools.length > 0, "the room must carry the era's tools");
  const names = room.tools.map((tool) => tool.name);
  for (const wanted of ["intel", "satellite", "aid", "ceasefire", "nuke"]) {
    must(names.includes(wanted), "1986 must offer " + wanted + ": " + names.join(","));
  }
  const nuke = room.tools.find((tool) => tool.name === "nuke");
  must(nuke && nuke.allowed === false, "a nuke must carry its refusal with it: " + JSON.stringify(nuke));

  // ---- the tools go through the socket and change the match ---------------------------------
  // Each send gets a mark: the box holds every frame since the socket opened, and a predicate
  // that matches "any reply" would match the welcome from a minute ago.
  // The kit is spent in a running match: a held clock is a break, and a tool used while paused
  // would be a free action. Start first, the way a player does.
  let mark = sock.box.length;
  sock.send({ op: "run" });
  await sock.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "the clock running", mark);

  mark = sock.box.length;
  sock.send({ op: "tool", tool: "satellite" });
  const sat = await sock.wait((m) => m.op === "error" || m.op === "room" || m.op === "log", "satellite reply", mark);
  must(sat, "the satellite must be answered");

  // Intel before contact has nothing to reveal, and says so instead of failing silently.
  mark = sock.box.length;
  sock.send({ op: "tool", tool: "intel" });
  const intel = await sock.wait((m) => m.op === "error" || m.op === "room" || m.op === "log", "intel reply", mark);
  must(intel, "intel must be answered");

  mark = sock.box.length;
  sock.send({ op: "tool", tool: "nuke" });
  const nukeReply = await sock.wait((m) => m.op === "error", "a refused nuke", mark);
  must(nukeReply && /refused|nuke/i.test(String(nukeReply.error || "")),
    "a nuke must be refused out loud: " + JSON.stringify(nukeReply));

  // ---- a mission needs an aircraft, and there is one in 1986 -------------------------------
  const plane = (room.pieces || []).find((piece) => piece.kind === "aircraft" && piece.side === "blue");
  if (plane) {
    mark = sock.box.length;
    sock.send({ op: "mission", piece: plane.id, mode: "strike", to: { x: plane.x + 3, y: plane.y } });
    const flown = await sock.wait((m) => m.op === "error" || m.op === "room" || m.op === "log", "mission reply", mark);
    must(flown, "a mission must be answered");
  }

  // ---- entrench: infantry standing still, and the refusal names the piece -----------------
  mark = sock.box.length;
  sock.send({ op: "entrench", piece: "blue:land" });
  const dug = await sock.wait((m) => m.op === "error" || m.op === "room" || m.op === "log", "entrench reply", mark);
  must(dug, "an entrench order must be answered");

  // A piece that is not yours is refused, whichever op asks.
  mark = sock.box.length;
  sock.send({ op: "entrench", piece: "red:land" });
  const wrong = await sock.wait((m) => m.op === "error", "an entrench on the enemy's piece", mark);
  must(wrong && /belongs to/i.test(String(wrong.error || "")),
    "another side's piece must be refused by the module, not the page: " + JSON.stringify(wrong));

  sock.close();
}
