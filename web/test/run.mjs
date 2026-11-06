import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-web-"));
let child = null;

function fail(message) {
  throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function choosePort() {
  for (let i = 0; i < 20; i++) {
    const port = await freePort();
    if (port !== 8787) return port;
  }
  fail("no free port other than 8787");
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        OPENCHQ_WEB_HOST: "127.0.0.1",
        OPENCHQ_WEB_PORT: String(port),
        OPENCHQ_WEB_DATA: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const timer = setTimeout(() => reject(new Error("server did not start: " + log)), 5000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      log += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + ": " + log));
    });
  });
}

function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const pid = child.pid;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (err) {
          if (err.code !== "ESRCH") throw err;
        }
      }
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      clearTimeout(timer);
      if (err.code === "ESRCH") resolve();
      else throw err;
    }
  });
}

function cookieOf(res) {
  const line = (res.headers.getSetCookie?.() || [])[0] || "";
  const match = line.match(/openchq_session=([^;]+)/);
  if (!match) fail("missing session cookie");
  return match[1];
}

async function post(base, pathName, body) {
  const res = await fetch(base + pathName, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data, token: res.headers.get("set-cookie") ? cookieOf(res) : "" };
}

function listen(ws) {
  const box = [];
  ws.addEventListener("message", (event) => box.push(JSON.parse(event.data)));
  return box;
}

async function waitFor(box, from, pred, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const hit = box.slice(from).find(pred);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(label + " missing: " + JSON.stringify(box.slice(from)));
}

function openSocket(base, token) {
  return new WebSocket(base.replace("http", "ws") + "/ws", {
    headers: { cookie: "openchq_session=" + token },
  });
}

function expect401(port) {
  return new Promise((resolve, reject) => {
    const client = connect(port, "127.0.0.1", () => {
      client.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let raw = "";
    client.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.includes("\r\n")) {
        client.end();
        if (!raw.startsWith("HTTP/1.1 401")) reject(new Error("unsigned socket: " + raw.split("\r\n")[0]));
        else resolve();
      }
    });
    client.on("error", reject);
  });
}

async function main() {
  const port = await choosePort();
  if (port === 8787) fail("refusing port 8787");
  if (dataDir.includes(".local/share/openchq")) fail("test data dir is the real account database");
  await startServer(port);
  const base = "http://127.0.0.1:" + port;

  const shortPass = await post(base, "/api/register", { username: "Ada", password: "short" });
  if (shortPass.status !== 400) fail("short password was accepted");

  const ada = await post(base, "/api/register", { username: "Ada", password: "test-pass-1" });
  const gus = await post(base, "/api/register", { username: "Gus", password: "test-pass-1" });
  if (ada.status !== 200 || gus.status !== 200) fail("register failed " + JSON.stringify([ada.data, gus.data]));

  const duplicate = await post(base, "/api/register", { username: "ada", password: "test-pass-1" });
  if (duplicate.status !== 400) fail("duplicate name was accepted");

  const wrong = await post(base, "/api/login", { username: "Ada", password: "wrong-password" });
  if (wrong.status !== 400) fail("wrong password was accepted");

  await expect401(port);

  const wsAda = openSocket(base, ada.token);
  const wsGus = openSocket(base, gus.token);
  const adaBox = listen(wsAda);
  const gusBox = listen(wsGus);
  await Promise.all([
    new Promise((resolve) => wsAda.addEventListener("open", resolve)),
    new Promise((resolve) => wsGus.addEventListener("open", resolve)),
  ]);
  const present = await waitFor(
    adaBox,
    0,
    (message) => {
      if (message.op !== "welcome" && message.op !== "presence") return false;
      const names = (message.users || []).map((user) => user.username);
      return names.includes("Ada") && names.includes("Gus");
    },
    "both players present"
  );
  if (!present) fail("lobby missed a signed-in player");

  wsAda.send(JSON.stringify({ op: "bot", era: "1986", side: "blue" }));
  const botRoom = await waitFor(adaBox, 0, (message) => message.op === "room" && message.room && message.room.mode === "bot", "bot room");
  if (botRoom.room.you !== "blue" || botRoom.room.red.kind !== "bot" || botRoom.room.clock !== "held") {
    fail("bot room shape " + JSON.stringify(botRoom.room));
  }

  const afterBot = adaBox.length;
  wsAda.send(JSON.stringify({ op: "run" }));
  const running = await waitFor(adaBox, afterBot, (message) => message.op === "room" && message.room && message.room.clock === "running", "run");
  if (running.room.clock !== "running") fail("clock did not run");

  const afterRun = adaBox.length;
  wsAda.send(JSON.stringify({ op: "hold" }));
  const held = await waitFor(adaBox, afterRun, (message) => message.op === "room" && message.room && message.room.clock === "held", "hold");
  if (held.room.clock !== "held") fail("clock did not hold");

  const afterHold = adaBox.length;
  wsAda.send(JSON.stringify({ op: "leave" }));
  const leftBot = await waitFor(adaBox, afterHold, (message) => message.op === "room" && message.room === null, "leave bot");
  if (!String(leftBot.reason || "").includes("Ada")) fail("leave reason " + leftBot.reason);

  const afterLeave = adaBox.length;
  wsAda.send(JSON.stringify({ op: "invite", user: "Gus", era: "1942", side: "blue" }));
  const invited = await waitFor(gusBox, 0, (message) => message.op === "invite", "invite");
  if (invited.invite.from !== "Ada" || invited.invite.to !== "Gus") fail("invite " + JSON.stringify(invited.invite));
  wsGus.send(JSON.stringify({ op: "answer", id: invited.invite.id, accept: false }));
  const declined = await waitFor(adaBox, afterLeave, (message) => message.op === "declined", "decline");
  if (declined.by !== "Gus") fail("decline " + JSON.stringify(declined));

  const afterDecline = adaBox.length;
  wsAda.send(JSON.stringify({ op: "invite", user: "Gus", era: "1986", side: "blue" }));
  const invitedAgain = await waitFor(gusBox, 0, (message) => message.op === "invite" && message.invite.era === "1986", "second invite");
  wsGus.send(JSON.stringify({ op: "answer", id: invitedAgain.invite.id, accept: true }));
  const human = await waitFor(adaBox, afterDecline, (message) => message.op === "room" && message.room && message.room.mode === "human", "human room");
  if (human.room.you !== "blue" || human.room.red.username !== "Gus" || human.room.blue.username !== "Ada") {
    fail("human seats " + JSON.stringify(human.room));
  }
  const gusHuman = await waitFor(gusBox, 0, (message) => message.op === "room" && message.room && message.room.mode === "human", "gus room");
  if (gusHuman.room.you !== "red") fail("gus side " + gusHuman.room.you);

  const beforeClose = adaBox.length;
  wsGus.close();
  const closed = await waitFor(adaBox, beforeClose, (message) => message.op === "room" && message.room === null, "gus left");
  if (closed.reason !== "Gus left the match.") fail("close reason " + closed.reason);
  wsAda.close();
}

try {
  await main();
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
  console.log("WEB_OK");
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
