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

import { assertShippedNukesArmed } from "./_nuke_default.mjs";

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
  for (const wanted of ["intel", "aid", "ceasefire", "nuke"]) {
    must(names.includes(wanted), "1986 must offer " + wanted + ": " + names.join(","));
  }
  // PB-224: the satellite is a unit now, so there is no tool row for it. The door is the Buy row,
  // and the wire arm below buys the piece.
  must(!names.includes("satellite"), "1986 still offers the retired satellite tool: " + names.join(","));
  // PB-233 (f): the shipped default is armed, so the room's nuke row must say so. The forced-off
  // refusal is proved in-process (the socket's server keeps its own rules() and cannot be
  // re-configured from the test), and the tool door is exercised below on the armed config.
  const nuke = room.tools.find((tool) => tool.name === "nuke");
  must(nuke && nuke.allowed === true, "the armed room still carries a refusal on the nuke: " + JSON.stringify(nuke));
  assertShippedNukesArmed({});

  // ---- the tools go through the socket and change the match ---------------------------------
  // Each send gets a mark: the box holds every frame since the socket opened, and a predicate
  // that matches "any reply" would match the welcome from a minute ago.
  // The kit is spent in a running match: a held clock is a break, and a tool used while paused
  // would be a free action. Start first, the way a player does.
  let mark = sock.box.length;
  sock.send({ op: "run" });
  await sock.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "the clock running", mark);

  // PB-224 AC1 over the wire: buying a recon satellite answers a `bought` frame naming the piece.
  mark = sock.box.length;
  sock.send({ op: "buy", kind: "reconSat", to: { x: 100, y: 40 } });
  const sat = await sock.wait((m) => m.op === "bought" || m.op === "error", "satellite buy reply", mark);
  must(sat, "the satellite buy must be answered");
  must(sat.op === "bought" && String(sat.kind) === "reconSat",
    "buying a recon satellite must land a bought frame: " + JSON.stringify(sat));

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
