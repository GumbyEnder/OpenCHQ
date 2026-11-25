// pb242_refusal_payload — AC2 on the WIRE, not off the diff.
//
// What breaks if this node is removed: the two nuke tickets (PB-230, PB-242) both return a refusal
// carrying `reason` and `terrain`, and both are unusable if the field dies between the engine and
// the page. It died exactly there. `lobby.toolOp` rebuilt the tool reply as `{ error }`, which
// dropped both fields; `main.mjs`'s passthrough then forwarded `reason: null, terrain: null`, and
// `app.js` had nothing to print. A lake and the open sea read identically to a player, and the
// suite stayed 177/0/0 green over it because every existing arm stopped at `useTool` — the one
// function that still had the fields.
//
// So this node deliberately does NOT call useTool for its main arm. It spawns the real server with
// nukes on, registers a seat, opens a real socket, and reads the error frame a player's page would
// have received. A `useTool`-level pin cannot see this hole; a socket-level one cannot miss it.
//
// Three halves, all cheap:
//   1. the page-side text function keeps the server's sentence verbatim and prints the ground
//      separately ({ refusalText, refusalGround, refusalLine } are pure, so they are pinned here);
//   2. the real server + real ws: a lake aim arrives with reason "no region" and terrain "lake";
//   3. a positive control on the SAME socket: a legal sea aim is accepted, so arm 2 cannot pass by
//      the tool being broken.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refusalGround, refusalLine, refusalText } from "../../public/command.mjs";
import { boardPayload } from "../../server/board.mjs";
import { NO_REGION, regionAt } from "../../server/territory.mjs";
import { NUKE_HOME_UNKNOWN } from "../../server/nukestrike.mjs";

export const name = "pb242_refusal_payload";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LAKE = { x: 73, y: 34 };   // NO_REGION lake, outside both capital rings (exclusion 2)
const SEA = { x: 25, y: 3 };     // NO_REGION ocean, outside both capital rings

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function must(ok, message) {
  if (!ok) fail(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function cookieOf(res) {
  const line = (res.headers.getSetCookie?.() || [])[0] || "";
  const hit = line.match(/openchq_session=([^;]+)/);
  if (!hit) fail("no session cookie from /api/register");
  return hit[1];
}

async function startServer(port, dataDir, configFile) {
  const child = spawn(process.execPath, ["web/server/main.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
      OPENCHQ_CONFIG: configFile,
      OPENCHQ_WS_PING_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start: " + log)), 8000);
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
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      resolve();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function openSocket(base, token) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", {
    headers: { cookie: "openchq_session=" + token },
  });
  const box = [];
  ws.addEventListener("message", (event) => {
    try {
      box.push(JSON.parse(event.data));
    } catch {
      box.push({ op: "unparseable", raw: String(event.data) });
    }
  });
  return {
    ws,
    box,
    send: (value) => ws.send(JSON.stringify(value)),
    async wait(pred, label, from = 0, deadlineMs = 4000) {
      const start = Date.now();
      while (Date.now() - start < deadlineMs) {
        const hit = box.slice(from).find(pred);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      fail(label + " missing within " + deadlineMs + "ms: " + JSON.stringify(box.slice(from).map((m) => m.op)));
    },
    close: () => {
      try {
        ws.close();
      } catch { /* a socket that never opened needs no close */ }
    },
  };
}

export async function run(ctx) {
  // --- 0. the board still has the two cells this node aims at ----------------------------------
  // A moved board must red this arm loudly instead of quietly pointing at a different terrain.
  let payload;
  try {
    payload = boardPayload();
  } catch (err) {
    ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
  }
  must(Boolean(payload && payload.cells), "the board has no terrain grid");
  const terrainAt = (at) => payload.terrain[payload.cells[at.y * 320 + at.x]];
  eq("the lake fixture is a NO_REGION cell", regionAt(LAKE.x, LAKE.y), NO_REGION);
  eq("the lake fixture is lake", terrainAt(LAKE), "lake");
  eq("the sea control is a NO_REGION cell", regionAt(SEA.x, SEA.y), NO_REGION);
  eq("the sea control is ocean", terrainAt(SEA), "ocean");

  // --- 1. the page's half, as pure functions ---------------------------------------------------
  {
    const sentence = NUKE_HOME_UNKNOWN;
    eq("the page prints the server's sentence verbatim", refusalText({ error: sentence, terrain: "lake" }), sentence);
    eq("the page prints the ground it was sent", refusalGround({ terrain: "lake" }), "Ground: lake.");
    eq("a frame with no ground prints no ground", refusalGround({ error: sentence, terrain: null }), "");
    eq("an order refusal prints no ground", refusalGround({ error: "Start the clock first." }), "");
    // The flash is the line the player reads, so the ground has to be ON it, not only beside it in
    // a panel the player may never open. The sentence keeps its own bytes as the prefix.
    eq(
      "the refusal the player reads carries the ground",
      refusalLine({ error: sentence, terrain: "lake" }),
      sentence + " Ground: lake.",
    );
    eq(
      "a refusal with no ground is the sentence, byte for byte",
      refusalLine({ error: "Start the clock first." }),
      "Start the clock first.",
    );
    // Presence checks, not behaviour: the page must CALL these on an error frame, or the pure half
    // above pins a library nobody reads.
    const app = readFileSync(path.join(root, "web", "public", "app.js"), "utf8");
    must(app.includes("refusalGround(message)"), "app.js never calls refusalGround on an error frame");
    must(app.includes("refusalLine(message)"), "app.js never reads the refusal line on an error frame");
  }

  // --- 2 + 3. the real server, the real socket --------------------------------------------------
  const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-refusal-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "openchq-refusal-cfg-"));
  let child = null;
  let socket = null;
  try {
    const config = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
    config.nukes = { ...(config.nukes || {}), enabled: true };
    const configFile = path.join(configDir, "game.json");
    writeFileSync(configFile, JSON.stringify(config, null, 2));

    const port = await freePort();
    child = await startServer(port, dataDir, configFile);
    const base = "http://127.0.0.1:" + port;

    const reg = await fetch(base + "/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "RefusalSeat", password: "node-test-pass" }),
    });
    const regBody = await reg.json();
    if (reg.status !== 200) fail("register: " + reg.status + " " + JSON.stringify(regBody));
    const token = cookieOf(reg);

    socket = openSocket(base, token);
    await socket.wait((m) => m.op === "welcome" || m.op === "presence" || m.op === "room", "socket hello", 0, 6000);

    socket.send({ op: "bot", era: "1986", side: "blue" });
    const opened = await socket.wait((m) => m.op === "room" && m.room && m.room.id !== undefined, "the bot room frame");
    must(Boolean(opened.room), "the bot room frame carried no room");

    // toolOp refuses while the clock is held, so the clock has to run for this arm to reach the
    // aim at all. (That guard is PB-230's and is not under test here.)
    socket.send({ op: "run" });
    await socket.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "the running clock");

    // --- the refusal: a lake must arrive WITH its ground ---------------------------------------
    let from = socket.box.length;
    socket.send({ op: "tool", tool: "nuke", to: LAKE });
    const refusal = await socket.wait((m) => m.op === "error", "the lake refusal", from);
    eq("the lake refusal is the engine's own sentence", refusal.error, NUKE_HOME_UNKNOWN);
    eq("the lake refusal carries its reason over the wire", refusal.reason, "no region");
    eq("the lake refusal carries its terrain over the wire", refusal.terrain, "lake");

    // --- the control: the same socket accepts a legal sea aim ----------------------------------
    from = socket.box.length;
    socket.send({ op: "tool", tool: "nuke", to: SEA });
    const accepted = await socket.wait(
      (m) => (m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "nuke")) || m.op === "error",
      "the sea launch answer", from,
    );
    must(accepted.op !== "error", "a legal sea aim was refused on the same socket: " + JSON.stringify(accepted));
    const strike = accepted.events.find((e) => e.type === "nuke");
    eq("the accepted sea launch lands on the aimed cell", { x: strike.x, y: strike.y }, SEA);
    must(Number(strike.cost) > 0, "the accepted sea launch carried no cost");

    console.log(
      "refusal payload: lake -> reason " + JSON.stringify(refusal.reason) + " terrain " +
      JSON.stringify(refusal.terrain) + "; sea aim accepted at " + strike.cost,
    );
  } finally {
    if (socket) socket.close();
    await stopServer(child);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* leftover temp dir */ }
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* leftover temp dir */ }
  }
}
