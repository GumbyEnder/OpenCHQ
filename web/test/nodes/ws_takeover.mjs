// F1: two tabs on one session must not trade the socket. The newer tab wins, the older one is
// told once that the session moved and is closed with 4001; it must not be able to reconnect
// and start a cycle. Before this, the older peer was closed with 1000 and every page treated
// that as a dropped connection, so the two tabs alternated "Connection lost" and "Reconnected"
// roughly every two seconds.
export const name = "ws_takeover";

const TAKEOVER_CODE = 4001;

function opened(ws, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " did not open")), 3000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(label + " failed to connect"));
    }, { once: true });
  });
}

function closedWith(ws, label) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 3) return resolve({ code: ws._closeCode ?? null });
    const timer = setTimeout(() => reject(new Error(label + " was not closed by the server")), 3000);
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: Number(event.code), reason: String(event.reason || "") });
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

  const older = ctx.socket(account.token);
  await opened(older.ws, "older tab");
  // Attach the close watcher before anything can close it: a close that lands between two
  // awaits leaves only readyState 3 and the code is gone.
  const olderClosed = closedWith(older.ws, "older tab");
  await older.wait((m) => m.op === "welcome", "older welcome");

  const newer = ctx.socket(account.token);
  await opened(newer.ws, "newer tab");
  const newWelcome = await newer.wait((m) => m.op === "welcome", "newer welcome");
  if (newWelcome.username !== username) fail("the newer tab got the wrong account: " + newWelcome.username);

  // The older tab is told why, once, and closed with the takeover code.
  const notice = await older.wait((m) => m.op === "replaced", "replaced notice to the older tab");
  if (!/another tab/i.test(String(notice.reason || ""))) {
    fail("the takeover notice does not name another tab: " + JSON.stringify(notice));
  }
  const close = await olderClosed;
  if (close.code !== TAKEOVER_CODE) {
    fail("the older tab was closed with " + close.code + ", not " + TAKEOVER_CODE + " (a 1000 reads as a drop and reconnects)");
  }
  const notices = older.box.filter((m) => m.op === "replaced").length;
  if (notices !== 1) fail("the older tab got " + notices + " takeover notices, expected 1");

  // No cycle: over several ping intervals the newer socket must stay the only one, still
  // receiving, and presence must list the account exactly once. If the older tab had a working
  // reconnect it would appear here as a second presence entry and the newer socket would close.
  const pings = 4;
  const window = 300 * pings; // the suite runs the server with OPENCHQ_WS_PING_MS=300
  await new Promise((resolve) => setTimeout(resolve, window));
  if (newer.ws.readyState !== 1) fail("the newer socket did not survive the takeover window");
  const latest = await until(() => {
    const hit = newer.box.filter((m) => m.op === "presence").pop();
    if (!hit) return null;
    return hit;
  }, "presence on the surviving socket");
  const names = (latest.users || []).filter((user) => user.username === username).length;
  if (names !== 1) fail("presence lists " + username + " " + names + " times after a takeover");

  // The surviving socket still works: a room opens on it.
  const before = newer.box.length;
  newer.send({ op: "bot", era: "1918", side: "blue" });
  const room = await until(
    () => newer.box.slice(before).find((m) => m.op === "room" && m.room),
    "the surviving socket can open a room"
  );
  if (!room) fail("the surviving socket stopped working after the takeover");

  newer.send({ op: "leave" });
  newer.close();
  console.log("ws_takeover: newer tab wins, older tab told once, close 4001, no reconnect cycle");
}
