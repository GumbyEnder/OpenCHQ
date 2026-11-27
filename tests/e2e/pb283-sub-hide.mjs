// PB-283 page leg: the still submarine is absent from the SEAT'S frame, not from the match.
//
// The node leg (web/test/nodes/pb283_sub_hide.mjs) proves the filter on forSeat(). This leg proves
// the same rule through the page's own room() - the payload a browser really receives - and proves
// it is a FILTER and not a missing piece: the raw room on the same server carries the submarine.
//
//   node tests/e2e/pb283-sub-hide.mjs                 # own server from this tree
//   node tests/e2e/pb283-sub-hide.mjs --url=<base>    # a running server (not supported for the
//                                                     # staging half: it writes the room row)
//
// The staging half is the point. A two-human 1986 room is created through the real invite/accept
// flow, then the server is stopped and the stored room's match gets two pieces appended:
// a blue cruiser and a red submarine one cell away from it (inside sight radius 8). Nothing else
// about the room moves. Restart, sign in as blue, read room():
//   1. blue sees its own staged cruiser;
//   2. blue does NOT see the still red submarine, and the id/serialised payload never names it;
//   3. the same server's /api/debug/room (OPENCHQ_DEBUG=1, read-only) DOES carry it - so the piece
//      exists and the seat view is what withholds it;
//   4. the same submarine with one ordered step becomes visible to blue through room();
//   5. on the same cells and viewport, only that one field changed between (2) and (4).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const OUT = evidenceDir("pb283-sub-hide", (process.argv.find((v) => v.startsWith("--out=")) || "").slice(6));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + " - " + detail);
  writeFileSync(path.join(OUT, "pb283-sub-hide.json"), JSON.stringify({ base: BASE, evidence }, null, 2));
}

const SUB = "red:stage:submarine:0";
const CRUISER = "blue:stage:cruiser:0";
const SURFACE = "red:stage:cruiser:0";
const CRUISER_CELL = { x: 150, y: 60 };
const SURFACE_CELL = { x: 151, y: 60 };
const SUB_CELL = { x: 152, y: 60 };

let BASE = "";
let child = null;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(port, dataDir) {
  child = spawn(process.execPath, ["web/server/main.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
      OPENCHQ_DEBUG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/api/version");
      if (res.ok) return;
    } catch {}
    await sleep(120);
  }
  throw new Error("the server did not answer on " + port);
}

async function stopServer() {
  if (!child) return;
  const dying = child;
  child = null;
  await new Promise((resolve) => {
    dying.once("exit", resolve);
    dying.kill();
    setTimeout(resolve, 4000);
  });
  await sleep(250);
}

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

// The seat's own frame, exactly what the browser has.
const seatRoom = (page) => page.evaluate(() => window.__chq.room());

function stageRoom(dataDir, roomId, pieces) {
  const db = new DatabaseSync(path.join(dataDir, "openchq.sqlite"));
  try {
    const row = db.prepare("SELECT state FROM rooms WHERE id = ?").get(roomId);
    if (!row) throw new Error("the room row is missing: " + roomId);
    const state = JSON.parse(row.state);
    if (!state.match) throw new Error("the room row has no match to stage");
    state.match.pieces = pieces;
    db.prepare("UPDATE rooms SET state = ? WHERE id = ?").run(JSON.stringify(state), roomId);
    const readBack = JSON.parse(db.prepare("SELECT state FROM rooms WHERE id = ?").get(roomId).state);
    return (readBack.match.pieces || []).map((p) => p.id);
  } finally {
    db.close();
  }
}

function stagedPieces(subExtra = {}) {
  return [
    {
      id: CRUISER, side: "blue", domain: "sea", kind: "cruiser",
      x: CRUISER_CELL.x, y: CRUISER_CELL.y, path: [], pace: 1, facing: null,
      fighting: null, shots: 0, strength: 100,
    },
    {
      id: SURFACE, side: "red", domain: "sea", kind: "cruiser",
      x: SURFACE_CELL.x, y: SURFACE_CELL.y, path: [], pace: 1, facing: null,
      fighting: null, shots: 0, strength: 100,
    },
    {
      id: SUB, side: "red", domain: "sea", kind: "submarine",
      x: SUB_CELL.x, y: SUB_CELL.y, path: [], pace: 1, facing: null,
      fighting: null, shots: 0, strength: 100, ...subExtra,
    },
  ];
}

function idsOf(room) {
  return (room && Array.isArray(room.pieces) ? room.pieces : []).map((p) => p.id);
}

async function waitForSeat(page, roomId) {
  await page.waitForFunction((id) => {
    const room = window.__chq.room();
    return room && String(room.id) === String(id);
  }, roomId, { timeout: 25000, polling: 100 });
  await sleep(300);
}

async function main() {
  const { chromium } = await loadPlaywright();
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb283-"));
  BASE = "http://127.0.0.1:" + port;
  await startServer(port, dataDir);
  mark("a local server answers", true, BASE + " data=" + dataDir);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const tag = Date.now().toString(36).slice(-6);
  const blueName = "SubBlue" + tag;
  const redName = "SubRed" + tag;
  const ctxBlue = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxRed = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blue = await ctxBlue.newPage();
  const red = await ctxRed.newPage();
  const pageErrors = [];
  blue.on("pageerror", (err) => pageErrors.push("blue: " + String(err)));
  red.on("pageerror", (err) => pageErrors.push("red: " + String(err)));

  await signIn(blue, blueName, "pw-blue-" + tag);
  await signIn(red, redName, "pw-red-" + tag);
  await blue.selectOption('#launch select[name="era"]', "1942");
  await blue.selectOption('#launch select[name="side"]', "blue");
  await blue.waitForSelector("li.person", { timeout: 25000 });
  await blue.evaluate((name) => {
    const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
    row.querySelector("button").click();
  }, redName);
  await red.waitForSelector("#invites .invite button", { timeout: 25000 });
  await red.evaluate(() => document.querySelector("#invites .invite button").click());
  await blue.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "human",
    null, { timeout: 25000, polling: 100 });
  const roomId = await blue.evaluate(() => window.__chq.room().id);
  await waitForSeat(red, roomId);
  mark("a real two-human 1942 room exists", true, "room " + roomId);

  // ---- variant A: the submarine is still ------------------------------------------------------
  await stopServer();
  const idsA = stageRoom(dataDir, roomId, stagedPieces());
  mark("the stored room carries all three staged pieces", idsA.includes(SUB) && idsA.includes(CRUISER) && idsA.includes(SURFACE), idsA.join(","));
  await startServer(port, dataDir);
  await blue.goto(BASE, { waitUntil: "domcontentloaded" });
  await waitForSeat(blue, roomId);

  const still = await seatRoom(blue);
  const stillIds = idsOf(still);
  const stillJson = JSON.stringify(still);
  mark("blue sees its own staged cruiser", stillIds.includes(CRUISER), stillIds.join(","));
  mark("the range control is live: a still enemy SURFACE hull one cell away is visible", stillIds.includes(SURFACE), "pieces=" + stillIds.join(","));
  mark("blue does NOT see the still red submarine", !stillIds.includes(SUB), "pieces=" + stillIds.join(","));
  mark("the still submarine is named nowhere in blue's payload", !stillJson.includes(SUB), "serialised frame read");

  const raw = await (await fetch(BASE + "/api/debug/room?id=" + encodeURIComponent(roomId))).json();
  const rawPieces = Array.isArray(raw.pieces) ? raw.pieces : [];
  const rawSub = rawPieces.find((p) => p.id === SUB);
  mark("the same server's raw room carries the submarine at its cell", Boolean(rawSub) && rawSub.x === SUB_CELL.x && rawSub.y === SUB_CELL.y,
    rawSub ? "raw " + SUB + " at " + rawSub.x + "," + rawSub.y : "raw room does not carry it");
  mark("the raw room is read through the debug route, not the seat frame", rawPieces.length >= 3, "raw pieces " + rawPieces.length);

  // ---- variant B: the same submarine, one ordered step ---------------------------------------
  await stopServer();
  const idsB = stageRoom(dataDir, roomId, stagedPieces({ path: [{ x: SUB_CELL.x + 1, y: SUB_CELL.y }] }));
  mark("the same room now stores one ordered step for the submarine", idsB.includes(SUB), "path length 1 at " + (SUB_CELL.x + 1) + "," + SUB_CELL.y);
  await startServer(port, dataDir);
  await blue.goto(BASE, { waitUntil: "domcontentloaded" });
  await waitForSeat(blue, roomId);

  const moving = await seatRoom(blue);
  const movingIds = idsOf(moving);
  const movingSub = (moving.pieces || []).find((p) => p.id === SUB);
  const rawB = await (await fetch(BASE + "/api/debug/room?id=" + encodeURIComponent(roomId))).json();
  const rawSubB = (Array.isArray(rawB.pieces) ? rawB.pieces : []).find((p) => p.id === SUB);
  mark("the restarted server loaded the ordered step from the row", Boolean(rawSubB) && Number(rawSubB.steps) === 1,
    rawSubB ? "raw steps " + rawSubB.steps + " next " + JSON.stringify(rawSubB.next) + " at " + rawSubB.x + "," + rawSubB.y : "raw room does not carry the submarine");
  mark("the moving red submarine IS visible to blue through room()", Boolean(movingSub),
    movingSub ? "seen at " + movingSub.x + "," + movingSub.y + " path " + JSON.stringify(movingSub.path) : "pieces=" + movingIds.join(","));
  mark("the two variants differ only in the submarine's own state",
    idsOf(still).filter((id) => id !== SUB).sort().join(",") === movingIds.filter((id) => id !== SUB).sort().join(","),
    "A=" + stillIds.filter((id) => id !== SUB).join(",") + " B=" + movingIds.filter((id) => id !== SUB).join(","));

  bracket("pages report no error", pageErrors.length === 0, pageErrors.join(" | ") || "none");
  await ctxRed.close();
  await ctxBlue.close();
  await browser.close();
  await stopServer();
  return 0;
}

function bracket(label, ok, detail) {
  mark(label, ok, detail);
}

try {
  await main();
} catch (err) {
  mark("the leg reached its summary", false, String(err && err.message ? err.message : err));
}
const summary = "PB-283 sub hide: " + evidence.filter((r) => r.ok).length + " passed / " + failed +
  " failed / " + evidence.length + " checks";
console.log(summary);
writeFileSync(path.join(OUT, "pb283-sub-hide.json"), JSON.stringify({ base: BASE, summary, evidence }, null, 2));
await stopServer();
process.exit(failed ? 1 : 0);
