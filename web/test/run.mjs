import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// A round is a tunable (config/game.json -> roundSeconds), so anything that waits for the
// shipped clock uses the configured length instead of the 2 s message cap.
async function waitUntil(box, from, pred, label, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const hit = box.slice(from).find(pred);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(label + " missing within " + deadlineMs + "ms: " + JSON.stringify(
    box.slice(from).map((m) => (m.op === "room" && m.room
      ? { op: m.op, id: m.room.id, clock: m.room.clock, round: m.room.round }
      : m.op))
  ));
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

// ---- per-node test modules ---------------------------------------------------------------
// Every web/test/nodes/*.mjs exports { name, run(ctx) }. Parallel work adds files here, never
// edits this harness. A throwing module fails the suite.
async function runNodeTests(ctx) {
  const nodesDir = path.join(root, "web", "test", "nodes");
  let files = [];
  try {
    files = readdirSync(nodesDir).filter((file) => file.endsWith(".mjs")).sort();
  } catch {
    return;
  }
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(nodesDir, file)).href);
    const label = String(mod.name || file.replace(/\.mjs$/, ""));
    if (typeof mod.run !== "function") fail("node test " + file + " has no run(ctx)");
    try {
      await mod.run(ctx);
      console.log("node test ok: " + label);
    } catch (err) {
      fail("node test " + label + ": " + (err && err.message ? err.message : err));
    }
  }
}

function makeContext(base, port) {
  const config = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
  let serial = 0;
  return {
    base,
    port,
    dataDir,
    config,
    fail,
    waitFor,
    sqlite: () => new DatabaseSync(path.join(dataDir, "openchq.sqlite")),
    async register(name) {
      const user = name || "NodeTest" + (++serial) + Math.floor(Math.random() * 1000);
      const res = await post(base, "/api/register", { username: user, password: "node-test-pass" });
      if (res.status !== 200) fail("node test register " + user + ": " + JSON.stringify(res.data));
      return { token: res.token, user: res.data.user };
    },
    socket(token) {
      const ws = openSocket(base, token);
      const box = listen(ws);
      return {
        ws,
        box,
        send: (value) => ws.send(JSON.stringify(value)),
        wait: (pred, label, from = 0) => waitFor(box, from, pred, label),
        close: () => ws.close(),
      };
    },
  };
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

  // --- pieces + sight: the match opens with 4 pieces, and a seat sees only its own.
  const opening = botRoom.room;
  if (opening.era !== "1986") fail("opening era " + opening.era);
  if (opening.round !== 0) fail("a new match starts at round " + opening.round);
  if (!Array.isArray(opening.pieces)) fail("the room view has no pieces: " + JSON.stringify(opening));
  const unit = (id) => opening.pieces.find((piece) => piece.id === id);
  const expectUnit = (id, side, domain, x, y) => {
    const found = unit(id);
    if (!found) fail("opening is missing " + id + ": " + JSON.stringify(opening.pieces));
    if (found.side !== side || found.domain !== domain || found.x !== x || found.y !== y) {
      fail(id + " is " + JSON.stringify(found));
    }
    if (found.side !== "blue" && found.side !== "red") fail("piece on no side: " + JSON.stringify(found));
  };
  if (opening.pieces.length !== 2) fail("a blue seat saw " + opening.pieces.length + " pieces at the opening, expected its own 2");
  expectUnit("blue:land", "blue", "land", 79, 44);
  expectUnit("blue:sea", "blue", "sea", 0, 15);
  if (unit("red:land") || unit("red:sea")) fail("the other seat's pieces were sent to blue: " + JSON.stringify(opening.pieces));
  if (JSON.stringify(opening).includes("hidden")) fail("a hidden piece was flagged instead of omitted");
  const cellAt = (x, y) => board.cells[y * 320 + x];
  if (cellAt(79, 44) !== 4 || cellAt(183, 25) !== 4) fail("the land pieces are not on the capitals");
  if (cellAt(0, 15) !== 0 || cellAt(300, 70) !== 0) fail("the ships are not on ocean cells");
  if (new Set(opening.pieces.map((piece) => piece.id)).size !== 2) fail("piece ids are not unique");

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

  // --- pieces: 2023 is the empty era, and its room view says so.
  const after1986 = adaBox.length;
  wsAda.send(JSON.stringify({ op: "bot", era: "2023", side: "blue" }));
  const empty2023 = await waitFor(
    adaBox,
    after1986,
    (message) => message.op === "room" && message.room && message.room.mode === "bot" && message.room.era === "2023",
    "2023 bot room"
  );
  if (!Array.isArray(empty2023.room.pieces)) fail("the 2023 view has no pieces field");
  if (empty2023.room.pieces.length !== 0) fail("2023 opened with " + empty2023.room.pieces.length + " pieces");
  const after2023 = adaBox.length;
  wsAda.send(JSON.stringify({ op: "leave" }));
  await waitFor(adaBox, after2023, (message) => message.op === "room" && message.room === null, "leave 2023");

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
  // A human room opens the same match, and each seat gets its own two pieces plus nothing of
  // the other side's.
  if (!Array.isArray(human.room.pieces) || human.room.pieces.length !== 2) {
    fail("1942 blue seat pieces " + JSON.stringify(human.room.pieces));
  }
  if (human.room.pieces.filter((piece) => piece.side !== "blue").length !== 0) {
    fail("the human room leaked the other seat's pieces: " + JSON.stringify(human.room.pieces));
  }
  if (!Array.isArray(gusHuman.room.pieces) || gusHuman.room.pieces.length !== 2 ||
      gusHuman.room.pieces.filter((piece) => piece.side !== "red").length !== 0) {
    fail("gus's seat view " + JSON.stringify(gusHuman.room.pieces));
  }

  // ---- a dropped client pauses the game, it does not end it ----------------------------
  const survivedId = human.room.id;
  if (!survivedId) fail("human room has no id");
  const roundMs = Math.max(1, Number(JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8")).roundSeconds) || 5) * 1000;

  // Red queues a standing order before it drops, on the cell beside Moscow. A human room runs
  // no bot, so this path can only have come from red's own socket.
  const RED_CAPITAL = { x: 183, y: 25 };
  const RED_STEP = { x: 184, y: 25 };
  const beforeGusOrder = gusBox.length;
  wsGus.send(JSON.stringify({ op: "order", piece: "red:land", x: RED_STEP.x, y: RED_STEP.y }));
  const redQueued = await waitFor(gusBox, beforeGusOrder, (m) => {
    if (m.op !== "room" || !m.room || m.room.id !== survivedId) return false;
    const red = (m.room.pieces || []).find((piece) => piece.id === "red:land");
    return red && red.path.length > 0;
  }, "red standing order");
  const queuedRed = (redQueued.room.pieces || []).find((piece) => piece.id === "red:land");
  if (queuedRed.x !== RED_CAPITAL.x || queuedRed.y !== RED_CAPITAL.y) fail("red moved before the clock ran: " + JSON.stringify(queuedRed));

  wsAda.send(JSON.stringify({ op: "run" }));
  const runningHuman = await waitFor(
    adaBox,
    0,
    (m) => m.op === "room" && m.room && m.room.id === survivedId && m.room.clock === "running",
    "human clock running"
  );
  if (!runningHuman) fail("the human clock never ran");

  const beforeClose = adaBox.length;
  wsGus.close();
  const paused = await waitFor(
    adaBox,
    beforeClose,
    (m) => m.op === "room" && m.room && m.room.id === survivedId && m.room.clock === "held",
    "gus dropped and the match paused"
  );
  if (!/disconnected/.test(String(paused.room.note || ""))) fail("pause note " + paused.room.note);
  if (paused.room.red.username !== "Gus" || paused.room.red.kind !== "human") {
    fail("the dropped seat was not kept: " + JSON.stringify(paused.room.red));
  }

  const store = new DatabaseSync(path.join(dataDir, "openchq.sqlite"));
  const kept = store.prepare("SELECT clock, state FROM rooms WHERE id = ?").get(survivedId);
  if (!kept) fail("a dropped client deleted the stored game");
  if (kept.clock !== "held") fail("stored clock after a drop is " + kept.clock);
  const keptSeats = JSON.parse(kept.state).seats;
  if (keptSeats.blue.username !== "Ada" || keptSeats.red.username !== "Gus") {
    fail("stored seats after a drop " + JSON.stringify(keptSeats));
  }
  // The standing order was in the row the drop wrote: a pause is not a cancel.
  const keptRed = (JSON.parse(kept.state).match.pieces || []).find((piece) => piece.id === "red:land");
  if (!keptRed || !Array.isArray(keptRed.path) || keptRed.path.length === 0) {
    fail("a drop dropped the absent seat's standing order: " + JSON.stringify(keptRed));
  }
  store.close();

  // ---- red comes back before anyone touches the clock ----------------------------------
  // The socket is closed and a new one is opened as the same account while the server is
  // still up: a returning player, not a process restart. The seat is handed back with the
  // same filtered view and the same board; the clock stays held, and the note a drop wrote
  // does not survive the return.
  const wsRed = openSocket(base, gus.token);
  const redBox = listen(wsRed);
  await new Promise((resolve) => wsRed.addEventListener("open", resolve));
  const back = await waitFor(redBox, 0, (m) => m.op === "welcome", "welcome after a reconnect");
  if (!back.room) fail("a returning socket got no room");
  if (back.room.id !== survivedId) fail("a returning socket landed in room " + back.room.id + " not " + survivedId);
  if (back.room.you !== "red") fail("a returning socket lost its side: " + back.room.you);
  if (back.room.clock !== "held") fail("a reconnect resumed the clock: " + back.room.clock);
  if (/disconnected/.test(String(back.room.note || ""))) fail("the drop note outlived the reconnect: " + back.room.note);
  const backPieces = Array.isArray(back.room.pieces) ? back.room.pieces : [];
  if (!backPieces.some((piece) => piece.id === "red:land")) {
    fail("a returning seat did not get its own pieces: " + JSON.stringify(backPieces.map((piece) => piece.id)));
  }
  if (backPieces.some((piece) => piece.side !== "red")) {
    fail("a returning seat's view leaked the other side: " + JSON.stringify(backPieces.map((piece) => piece.id)));
  }
  // The view is filtered, not the match: a returning seat sees what any seat sees.
  if (JSON.stringify(back.room).includes("hidden")) fail("a returning seat was sent a hidden flag");
  // The order queued before the drop is still on the piece, untouched by the return.
  const backQueued = backPieces.find((piece) => piece.id === "red:land");
  if (backQueued.path.length === 0) fail("a return lost the seat's standing order: " + JSON.stringify(backQueued));
  // ... and the seat that stayed is told the game is whole again.
  await waitUntil(adaBox, 0, (m) => m.op === "room" && m.room && m.room.id === survivedId &&
    !/disconnected/.test(String(m.room.note || "")), "the waiting seat was told the player is back", 2000);

  // Red drops a second time and stays away while blue runs a round: the standing order
  // executes with nobody in the seat.
  wsRed.close();
  const pausedAgain = await waitUntil(adaBox, 0, (m) => m.op === "room" && m.room && m.room.id === survivedId &&
    m.room.clock === "held" && /disconnected/.test(String(m.room.note || "")), "red dropped again", 2000);
  const pausedRound = pausedAgain.room.round;
  const beforeResume = adaBox.length;
  wsAda.send(JSON.stringify({ op: "run" }));
  const resumed = await waitUntil(adaBox, beforeResume, (m) => m.op === "room" && m.room && m.room.id === survivedId && m.room.clock === "running", "resume after a drop", roundMs + 2000);
  if (resumed.room.red.username !== "Gus") fail("resume lost the other seat");
  await waitUntil(adaBox, beforeResume, (m) => m.op === "room" && m.room && m.room.id === survivedId && m.room.round > pausedRound, "a round with red away", roundMs + 4000);
  const afterRound = adaBox.length;
  wsAda.send(JSON.stringify({ op: "hold" }));
  await waitUntil(adaBox, afterRound, (m) => m.op === "room" && m.room && m.room.id === survivedId && m.room.clock === "held", "hold after the absent round", roundMs + 2000);

  // ---- red comes back to a board that moved while it was gone --------------------------
  const wsRed2 = openSocket(base, gus.token);
  const redBox2 = listen(wsRed2);
  await new Promise((resolve) => wsRed2.addEventListener("open", resolve));
  const backAgain = await waitFor(redBox2, 0, (m) => m.op === "welcome", "welcome after the second reconnect");
  if (!backAgain.room) fail("a returning socket got no room the second time");
  if (backAgain.room.id !== survivedId) fail("a returning socket landed in room " + backAgain.room.id);
  if (backAgain.room.you !== "red") fail("a returning socket lost its side: " + backAgain.room.you);
  const moved = (backAgain.room.pieces || []).find((piece) => piece.id === "red:land");
  if (!moved) fail("a returning seat did not get its army back");
  if (moved.x !== RED_STEP.x || moved.y !== RED_STEP.y || moved.path.length !== 0) {
    fail("the absent seat's standing order did not execute: " + JSON.stringify(moved));
  }
  wsRed2.close();

  // ---- and the game outlives the process ----------------------------------------------
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
  if (welcome.room.red.username !== "Gus") fail("the other seat was lost across the restart");
  wsAfter.close();

  // ---- drop_godot: this branch carries only the browser game --------------------------
  const godotLeftovers = ["project.godot", "scenes", "scripts", "icon.svg", "icon.svg.import", "run-windows.bat"];
  for (const leftover of godotLeftovers) {
    if (existsSync(path.join(root, leftover))) fail("the Godot tree is still on the web branch: " + leftover);
  }
  if (!existsSync(path.join(root, "web", "server", "main.mjs"))) fail("dropping the Godot tree took the web server with it");
  const archive = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/desktop-godot"], {
    cwd: root,
    encoding: "utf8",
  });
  if (archive.status !== 0 || !String(archive.stdout).trim()) {
    fail("origin/desktop-godot is gone: the archive branch must outlive the deletion");
  }

  // ---- the node tests, one file per graph node ------------------------------------------
  await runNodeTests(makeContext(base, port));
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
