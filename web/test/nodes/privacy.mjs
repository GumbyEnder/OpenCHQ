// T-007 Part 1 (privacy). A handle may be an email address, and the lobby used to print it.
//
// This test says what a client is allowed to receive:
//   - no payload that reaches another player carries an `email` field, a value shaped like an
//     email address, or the handle the account signed in with;
//   - a seat and a player row show the display name (the part before the @), and two accounts that
//     share a local part get distinct names ("beta" and "beta 2") rather than a collision.
//
// It reads the frames off a real socket, not the code: the assertion is over what was sent.
import { displayNames, localName, looksLikeEmail } from "../../server/names.mjs";

export const name = "privacy";

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function walk(value, visit, path = "") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visit, path + "[" + i + "]"));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) walk(inner, visit, path + "." + key);
  }
}

function assertClean(message, label) {
  walk(message, (value, at) => {
    if (typeof value === "string" && EMAIL_SHAPE.test(value)) {
      throw new Error(label + ": a payload carried an email address at " + at + ": " + value);
    }
    if (/^email$/i.test(String(at.split(".").pop() || "")) && value) {
      throw new Error(label + ": a payload carried an `email` field at " + at);
    }
  });
}

export async function run(ctx) {
  const { fail } = ctx;

  // ---- the rule itself: local part, no email, a stable suffix for a collision ----------------
  if (localName("shane@example.com") !== "shane") fail("localName must drop the domain");
  if (localName("  spaced@example.com  ") !== "spaced") fail("localName must trim");
  if (localName("@example.com") !== "Player") fail("a handle that is only a domain must not leak");
  if (localName("") !== "Player") fail("an empty handle must read Player");
  if (!looksLikeEmail("a.b@c.co")) fail("looksLikeEmail must see an address");
  if (looksLikeEmail("plain-name")) fail("looksLikeEmail must not fire on a plain name");
  const two = displayNames(["beta@one.example.com", "beta@two.example.com"]);
  const names = [...two.values()].sort();
  if (names.join("|") !== "beta|beta 2") fail("colliding local parts must be told apart: " + names.join("|"));

  // ---- what actually goes on the wire -------------------------------------------------------
  const alpha = await ctx.register("alpha.probe@example.com");
  const betaOne = await ctx.register("beta@one.example.com");
  const betaTwo = await ctx.register("beta@two.example.com");
  const sockets = [ctx.socket(alpha.token), ctx.socket(betaOne.token), ctx.socket(betaTwo.token)];
  try {
    for (const sock of sockets) await sock.wait((m) => m.op === "welcome", "a welcome frame");

    // Every frame any of these three receives is checked: presence, invites, welcome and the
    // room frames that follow a bot match. `box` is filled from the moment the socket is built.
    const seen = () => sockets.flatMap((sock) => sock.box);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Presence: three accounts, three distinct display names, no address among them.
    const presence = seen().filter((m) => m.op === "presence").pop();
    if (!presence) fail("no presence frame after three sign-ins: " + JSON.stringify(seen().map((m) => m.op)));
    const shown = presence.users.map((user) => user.username);
    // The suite shares one server, so other nodes' accounts may be online too. What this asserts is
    // that our three are there, told apart, and that none of the rows is an address.
    for (const wanted of ["alpha.probe", "beta", "beta 2"]) {
      if (!shown.includes(wanted)) fail("the lobby list is missing " + wanted + ": " + shown.join("|"));
    }
    if (shown.some((name) => looksLikeEmail(name)) || shown.some((name) => /@/.test(name))) {
      fail("the lobby list carries an address: " + shown.join("|"));
    }

    // An invite addressed by display name reaches the right account, and the frame it carries
    // names both sides by display name.
    const before = sockets[0].box.length;
    sockets[1].send({ op: "invite", user: "alpha.probe", era: "1942", side: "blue" });
    const invite = await sockets[0].wait((m) => m.op === "invite", "the invite frame", before);
    if (!invite.invite || invite.invite.to !== "alpha.probe" || invite.invite.from !== "beta") {
      fail("an invite must name display names only: " + JSON.stringify(invite.invite));
    }

    // A bot match carries the seat table.
    const roomFrom = sockets[0].box.length;
    sockets[0].send({ op: "bot", era: "1918", side: "blue" });
    const room = await sockets[0].wait((m) => m.op === "room" && m.room, "a room frame", roomFrom);
    if (room.room.blue.username !== "alpha.probe") {
      fail("the seat must show a display name: " + JSON.stringify(room.room.blue));
    }
    if (room.room.red.kind !== "bot" || room.room.red.username !== "Bot") {
      fail("the bot seat must stay Bot: " + JSON.stringify(room.room.red));
    }
    if (room.room.note && EMAIL_SHAPE.test(String(room.room.note))) fail("a room note carried an email");

    // A refused order's sentence is the last thing that names a player on the wire.
    sockets[0].send({ op: "quit" });

    // ---- the HTTP side: /api/me returns the display name -------------------------------------
    const me = await fetch(ctx.base + "/api/me", {
      headers: { cookie: "openchq_session=" + alpha.token },
    }).then((res) => res.json());
    if (!me.user || me.user.username !== "alpha.probe") {
      fail("/api/me must answer with the display name: " + JSON.stringify(me));
    }
    assertClean(me, "/api/me");

    // ---- the sweep: nothing that reached a client had an address in it ----------------------
    const all = seen();
    if (!all.length) fail("no frames were captured, so nothing was proved");
    for (const message of all) assertClean(message, "socket frame");
  } finally {
    for (const sock of sockets) {
      try {
        sock.close();
      } catch {
        // Already gone.
      }
    }
  }
}
