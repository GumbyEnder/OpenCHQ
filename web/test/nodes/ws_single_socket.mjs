// Node ws_single_socket: two reconnects in a row leave exactly one socket for the session.
//
// A second connection as the same account replaces the first: that is the rule the lobby has
// always stated. The failure it guards against is the registry growing a second entry, so orders
// fan out twice and presence lists the player twice. This test reconnects twice and reads the
// lobby's own presence list as the server-side count.
export const name = "ws_single_socket";

function opened(ws, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " did not open")), 3000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(label + " failed to connect"));
    }, { once: true });
  });
}

function closed(ws, label) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 3) return resolve();
    const timer = setTimeout(() => reject(new Error(label + " was not closed by the server")), 3000);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function until(pred, label, deadlineMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const hit = pred();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label + " did not happen within " + deadlineMs + "ms");
}

export async function run(ctx) {
  const { fail } = ctx;
  const account = await ctx.register();
  const username = account.user.username;

  // First connection: the session's only socket.
  const first = ctx.socket(account.token);
  await opened(first.ws, "first socket");
  first.wait((m) => m.op === "welcome", "first welcome");

  // Second connection as the same account: the server must close the first, not keep both.
  const second = ctx.socket(account.token);
  await opened(second.ws, "second socket");
  const secondWelcome = await second.wait((m) => m.op === "welcome", "second welcome");
  await closed(first.ws, "first socket after the second connect");
  if (first.ws.readyState !== 3) fail("the replaced socket was left open");
  if (secondWelcome.username !== username) fail("the second socket got the wrong account: " + secondWelcome.username);

  // A third connection in a row: the second is replaced the same way. If reconnects leaked, the
  // registry would now hold three peers and presence would show the name three times.
  const third = ctx.socket(account.token);
  await opened(third.ws, "third socket");
  const presence = await third.wait(
    (m) => m.op === "presence" || m.op === "welcome",
    "presence after the second reconnect"
  );
  await closed(second.ws, "second socket after the third connect");
  if (second.ws.readyState !== 3) fail("the second replaced socket was left open");

  const latest = await until(() => {
    const hit = third.box.filter((m) => m.op === "presence" || m.op === "welcome").pop();
    if (!hit) return null;
    const names = (hit.users || []).filter((user) => user.username === username);
    return names.length === 1 ? hit : null;
  }, "presence lists the account exactly once");
  const count = (latest.users || []).filter((user) => user.username === username).length;
  if (count !== 1) fail("presence lists " + username + " " + count + " times after two reconnects");

  // The surviving socket is the one that works: a room message comes back on it, and nothing
  // arrives on the closed ones (they cannot receive anything, but the registry must agree).
  const before = third.box.length;
  third.send({ op: "bot", era: "1918", side: "blue" });
  const room = await until(
    () => third.box.slice(before).find((m) => m.op === "room" && m.room),
    "the surviving socket can open a room"
  );
  if (room.room.you !== "blue") fail("the surviving socket opened the wrong side: " + room.room.you);

  third.send({ op: "leave" });
  third.close();
}
