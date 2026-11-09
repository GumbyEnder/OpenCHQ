// A refresh is not a logout. The cookie alone must restore the same user, a running match must
// come back to the same seat, and signing out must still end the session.
export const name = "session_reload";

async function me(base, token) {
  const res = await fetch(base + "/api/me", {
    headers: token ? { cookie: "openchq_session=" + token } : {},
  });
  return (await res.json()).user;
}

export async function run(ctx) {
  const { fail } = ctx;
  const user = await ctx.register();

  // The cookie is a durable one, not a session cookie: HttpOnly, SameSite=Lax, a Max-Age.
  const res = await fetch(ctx.base + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.user.username, password: "node-test-pass" }),
  });
  const setCookie = (res.headers.getSetCookie?.() || [])[0] || "";
  for (const flag of ["HttpOnly", "SameSite=Lax", "Max-Age=", "Path=/"]) {
    if (!setCookie.includes(flag)) fail("the session cookie is missing " + flag + ": " + setCookie);
  }
  const token = (setCookie.match(/openchq_session=([^;]+)/) || [])[1];
  if (!token) fail("no session token in " + setCookie);

  // Reload: only the returned cookie, no body, no Authorization header.
  const again = await me(ctx.base, token);
  if (!again || again.username !== user.user.username) {
    fail("the session did not survive a reload: " + JSON.stringify(again));
  }

  // A running match is rejoined on the same seat.
  const first = ctx.socket(token);
  await first.wait((m) => m.op === "welcome", "welcome");
  first.send({ op: "bot", era: "1942", side: "blue" });
  const room = await first.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  const roomId = room.room.id;
  first.send({ op: "run" });
  await first.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "clock running");

  first.close();
  const reloaded = ctx.socket(token);
  const welcome = await reloaded.wait((m) => m.op === "welcome", "welcome after reload");
  if (!welcome.room) fail("a reloaded page with a valid cookie landed in no match");
  if (welcome.room.id !== roomId) fail("a reload landed in room " + welcome.room.id + " not " + roomId);
  if (welcome.room.you !== "blue") fail("a reload lost the seat: " + welcome.room.you);

  // Signing out still ends it.
  await fetch(ctx.base + "/api/logout", { method: "POST", headers: { cookie: "openchq_session=" + token } });
  const gone = await me(ctx.base, token);
  if (gone) fail("signing out left the session alive: " + JSON.stringify(gone));

  reloaded.close();
  console.log("session_reload: cookie flags present, /api/me after reload returned the same user, match and seat kept, logout ended it");
}
