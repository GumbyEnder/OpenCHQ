import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { colorForTerrain, PALETTE, paintBoard, SCHEMATIC } from "../public/paint.mjs";

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

  const boardRes = await fetch(base + "/api/board");
  if (boardRes.status !== 200) fail("board status " + boardRes.status);
  const boardText = await boardRes.text();
  const board = JSON.parse(boardText);
  if (board.source !== "extract") {
    fail("board needs the local extract beside this project; got source " + board.source);
  }
  if (board.width !== 320 || board.height !== 136) fail("board size " + board.width + "x" + board.height);
  if (board.stride !== 162) fail("board stride " + board.stride);
  if (!Array.isArray(board.cells)) fail("board cells missing");
  if (board.cells.length !== 320 * 136) fail("board cell count " + board.cells.length);
  for (let i = 0; i < board.cells.length; i++) {
    const id = board.cells[i];
    if (!Number.isInteger(id) || id < 0 || id > 15) fail("cell " + i + " is " + JSON.stringify(id));
  }
  if (!Array.isArray(board.terrain) || board.terrain.length !== 16) fail("terrain table " + JSON.stringify(board.terrain));
  if (board.terrain[0] !== "ocean" || board.terrain[14] !== "wasteland" || board.terrain[15] !== "facility") {
    fail("terrain names moved: " + JSON.stringify(board.terrain));
  }
  const blue = board.capitals && board.capitals.blue;
  const red = board.capitals && board.capitals.red;
  if (!blue || !red) fail("board capitals missing " + JSON.stringify(board.capitals));
  if (blue.name !== "Washington" || blue.x !== 79 || blue.y !== 44) fail("blue capital " + JSON.stringify(blue));
  if (red.name !== "Moscow" || red.x !== 183 || red.y !== 25) fail("red capital " + JSON.stringify(red));
  const sites = Array.isArray(board.sites) ? board.sites : [];
  const named = (name) => sites.find((site) => site.name === name);
  if (!named("Washington") || named("Washington").kind !== "capital") fail("Washington is not a capital site");
  if (!named("Moscow") || named("Moscow").kind !== "capital") fail("Moscow is not a capital site");
  if (sites.filter((site) => site.kind === "capital").length !== 2) fail("capital count " + sites.filter((s) => s.kind === "capital").length);
  const capIndex = (x, y) => y * 320 + x;
  if (board.cells[capIndex(79, 44)] !== 4) fail("Washington cell id " + board.cells[capIndex(79, 44)]);
  if (board.cells[capIndex(183, 25)] !== 4) fail("Moscow cell id " + board.cells[capIndex(183, 25)]);
  const forbidden = ["WORLD_MAP", ".png", ".PNG", ".exe", ".EXE", "stills", "unpacked", "base64", "iVBOR", "/mnt/nas"];
  for (const token of forbidden) {
    if (boardText.includes(token)) fail("board payload leaks " + token);
  }

  // --- board_paint: the pure painter draws cell ids, not the original picture.
  const paintModule = await fetch(base + "/paint.mjs");
  if (paintModule.status !== 200) fail("paint.mjs is not served: " + paintModule.status);
  if (!String(paintModule.headers.get("content-type") || "").includes("javascript")) {
    fail("paint.mjs content-type " + paintModule.headers.get("content-type"));
  }
  const recorder = () => {
    const fills = [];
    const ctx = {
      _style: "",
      set fillStyle(value) {
        this._style = value;
      },
      get fillStyle() {
        return this._style;
      },
      fillRect(x, y, w, h) {
        fills.push({ x, y, w, h, color: this._style });
      },
      clearRect() {},
    };
    return { ctx, fills };
  };
  const at = (fills, x, y) => fills.find((fill) => fill.x === x * 2 && fill.y === y * 2);
  const grid = recorder();
  const painted = paintBoard(grid.ctx, board, { scale: 2 });
  if (painted.mode !== "cells") fail("painter mode " + painted.mode);
  if (painted.painted < 320 * 136 * 0.5) fail("painter painted only " + painted.painted + " cells");
  const spots = [["ocean", 0], ["shallows", 2], ["city", 6], ["capital", 4]];
  const seen = {};
  for (const [name, id] of spots) {
    const index = board.cells.indexOf(id);
    if (index < 0) fail("board has no " + name + " cell");
    const x = index % 320;
    const y = Math.floor(index / 320);
    const fill = at(grid.fills, x, y);
    if (!fill) fail("painter skipped " + name + " at " + x + "," + y);
    if (fill.color !== PALETTE[name]) fail("painted " + name + " as " + fill.color + " not " + PALETTE[name]);
    seen[name] = fill.color;
  }
  if (new Set(Object.values(seen)).size !== 4) fail("paint colors are not distinct: " + JSON.stringify(seen));
  if (colorForTerrain("nonsense") !== null) fail("painter invented a color for an unknown terrain");
  if (colorForTerrain(board.terrain[0]) !== PALETTE.ocean) fail("terrain name lookup moved");

  const fallback = recorder();
  const schematic = paintBoard(fallback.ctx, {
    source: "missing",
    cells: null,
    width: 320,
    height: 136,
    capitals: { blue: { x: 79, y: 44 }, red: { x: 183, y: 25 } },
  }, { scale: 2 });
  if (schematic.mode !== "schematic") fail("missing extract did not fall back: " + schematic.mode);
  if (!String(schematic.message || "").includes("extract is missing")) {
    fail("schematic does not say the extract is missing: " + schematic.message);
  }
  const blueMark = at(fallback.fills, 79, 44);
  if (!blueMark || blueMark.color !== SCHEMATIC.blue) fail("schematic does not mark Washington");
  const redMark = at(fallback.fills, 183, 25);
  if (!redMark || redMark.color !== SCHEMATIC.red) fail("schematic does not mark Moscow");
  const schematicColors = Object.values(SCHEMATIC);
  if (fallback.fills.some((fill) => !schematicColors.includes(fill.color))) {
    fail("schematic used a color outside its palette: " + JSON.stringify([...new Set(fallback.fills.map((f) => f.color))]));
  }

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

  // ---- a game outlives the process -----------------------------------------------------
  // Ada starts a bot room, runs the clock, and the server is killed without closing anything.
  // The room must come back on the next boot, paused, still hers.
  const wsBefore = openSocket(base, ada.token);
  const boxBefore = listen(wsBefore);
  await new Promise((resolve) => wsBefore.addEventListener("open", resolve));
  wsBefore.send(JSON.stringify({ op: "bot", era: "1986", side: "blue" }));
  const beforeRoom = await waitFor(boxBefore, 0, (m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room before restart");
  const survivedId = beforeRoom.room.id;
  if (!survivedId) fail("bot room has no id");
  wsBefore.send(JSON.stringify({ op: "run" }));
  await waitFor(boxBefore, 0, (m) => m.op === "room" && m.room && m.room.clock === "running", "clock running before restart");

  const store = new DatabaseSync(path.join(dataDir, "openchq.sqlite"));
  const row = store.prepare("SELECT id, clock, state FROM rooms WHERE id = ?").get(survivedId);
  if (!row) fail("room was never written to the store: " + survivedId);
  if (row.clock !== "running") fail("stored clock is " + row.clock);
  const storedSeats = JSON.parse(row.state).seats;
  if (storedSeats.blue.username !== "Ada") fail("stored seat " + JSON.stringify(storedSeats));
  store.close();

  await stopServer();
  await startServer(port);

  const wsAfter = openSocket(base, ada.token);
  const boxAfter = listen(wsAfter);
  await new Promise((resolve) => wsAfter.addEventListener("open", resolve));
  const welcome = await waitFor(boxAfter, 0, (m) => m.op === "welcome", "welcome after restart");
  if (!welcome.room) fail("the game did not survive the restart");
  if (welcome.room.id !== survivedId) fail("reconnected to a different room " + welcome.room.id);
  if (welcome.room.clock !== "held") fail("a restart resumed the clock: " + welcome.room.clock);
  if (welcome.room.you !== "blue") fail("seat was lost across the restart: " + welcome.room.you);
  wsAfter.close();
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
