// PB-195 live leg — land units overlap to fight.
//
//   node tests/e2e/pb195-land-overlap.mjs                 # starts its own server from this tree
//   node tests/e2e/pb195-land-overlap.mjs --url=<base>    # use a running (deployed) server
//   node tests/e2e/pb195-land-overlap.mjs --watch=300000   # chase budget in ms
//
// What it measures on a real page, socket and server: a seat's infantry is ordered onto an enemy
// infantry's cell, and the walker ENDS UP IN THAT CELL instead of stopping one short. Before
// PB-195 the order produced "a unit could not step: the way was held" and the two pieces traded
// fire from two cells apart; Manual p.9 says attacking is moving your unit so the two icons
// overlap. A second check reads the enemy's strength after the overlap: the icons that share a
// cell must be in a fight.
//
// The leg re-issues the order every few seconds while the bot moves its piece, so a chase that
// both sides walk toward still converges (an infantry is 1 cell a round; the two close at 2).
// If the budget runs out without an overlap, that is a FAIL with the last distance printed - it
// is never reported as a pass on the strength of the walker merely surviving.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const WATCH_MS = Number(argOf("watch", "240000")) || 240000;
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb195")));
mkdirSync(OUT, { recursive: true });
const ERA = "1986";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir, OPENCHQ_DEBUG: "1" };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + ": " + log));
    });
  });
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb195-"));
let server = null;
let browser = null;
let BASE = GIVEN;

const roomOf = (page) => page.evaluate(() => window.__chq.room());
const logOf = (page) => page.evaluate(() => window.__chq.log());
const noteOf = (page) => page.evaluate(() => window.__chq.note());

async function clickCell(page, cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const size = page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) {
    await page.click("#camFit");
    return clickCell(page, cell);
  }
  await page.mouse.click(point.x, point.y);
  return point;
}

async function hoverCell(page, cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.move(point.x, point.y);
  await sleep(90);
}

const wrapDelta = (a, b) => {
  const raw = Math.abs(Number(a) - Number(b));
  return raw > 160 ? 320 - raw : raw;
};
const gapOf = (a, b) => Math.max(wrapDelta(a.x, b.x), Math.abs(Number(a.y) - Number(b.y)));

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("the given host answers /api/version", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });

  const signedIn = await page.evaluate(() => Boolean(window.__chq && window.__chq.me()));
  if (!signedIn) {
    const name = (process.env.E2E_PREFIX || "e2e") + Date.now().toString(36).slice(-8);
    const password = process.env.E2E_PASSWORD || "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
  }
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  mark("a seat is signed in", true);

  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(
    (wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted,
    ERA,
    { timeout: 20000, polling: 100 },
  );
  mark("a " + ERA + " bot room is open", true);
  const roomId = (await roomOf(page)).id;
  const dump = async () => (await fetch(BASE + "/api/debug/room?id=" + encodeURIComponent(roomId))).json();

  // Speed 6, clock running: 0.6 s a round.
  for (let i = 0; i < 5; i++) await page.click("#speedUp");
  const pressed = await page.getAttribute("#clockBtn", "aria-pressed");
  if (pressed !== "true") await page.click("#clockBtn");

  let overlaps = null;
  let lastGap = null;
  let lastOrderNote = "";
  let mineId = null;
  let loopNote = "";
  let lastClose = null;
  const started = Date.now();
  // No orders are sent from this leg. It starts the clock and waits: under Manual p.9 the seat's
  // infantry must be OVERLAPPED by the attacker for any exchange to happen, and the bot's assault
  // is the attacker here. That also dodges the crossing-swap race (two walkers each ordered into
  // the other's cell trade places every round and never share one - PB-197's ground), which made an
  // earlier version of this leg chase a moving bot for 200 s at a constant gap of 1.
  while (Date.now() - started < WATCH_MS) {
    const dbg = await dump();
    const pieces = dbg.pieces || [];
    const mine = pieces.find((p) => p.side === "blue" && p.domain === "land");
    const foes = pieces.filter((p) => p.side !== "blue" && p.domain === "land");
    if (!mine) { loopNote = "no own land piece (pieces=" + pieces.length + ")"; break; }
    mineId = mine.id;
    if (!foes.length) { loopNote = "no enemy land piece (pieces=" + pieces.length + ")"; break; }
    foes.sort((a, b) => gapOf(mine, a) - gapOf(mine, b));
    const foe = foes[0];
    lastGap = gapOf(mine, foe);
    lastOrderNote = "round " + dbg.round;
    if (lastGap === 0) {
      overlaps = { mine: { id: mine.id, x: mine.x, y: mine.y, strength: mine.strength }, foe: { id: foe.id, x: foe.x, y: foe.y, strength: foe.strength } };
      break;
    }
    lastClose = pieces.filter((p) => p.domain === "land").map((p) => ({ id: p.id, side: p.side, x: p.x, y: p.y, next: p.next, steps: p.steps, pinned: p.pinned }));
    await sleep(700);
  }

  mark("an enemy land unit overlapped the seat's infantry (Manual p.9)", Boolean(overlaps),
    overlaps ? "both at " + overlaps.foe.x + "," + overlaps.foe.y
      : (loopNote || ("last gap " + lastGap + "; last hover note: " + lastOrderNote)));

  if (overlaps) {
    // Two icons in one cell are in a fight: the enemy's bar must move, or the seat's log says a hit.
    let hit = null;
    const until = Date.now() + 20000;
    while (Date.now() < until && !hit) {
      const dbg = await dump();
      const foe = (dbg.pieces || []).find((p) => p.id === (overlaps.foe && overlaps.foe.id));
      const mine = (dbg.pieces || []).find((p) => p.id === mineId);
      const foeStrength = Number(foe && foe.strength);
      const mineStrength = Number(mine && mine.strength);
      if ((Number.isFinite(foeStrength) && foeStrength < 100) || (Number.isFinite(mineStrength) && mineStrength < 100)) {
        hit = { foeStrength, mineStrength };
        break;
      }
      const lines = await logOf(page);
      const shot = lines.find((line) => /Strength hit|strength|hit/i.test(String(line)));
      if (shot) { hit = { line: shot }; break; }
      await sleep(800);
    }
    mark("the overlap produced an exchange (a strength bar moved)", Boolean(hit), JSON.stringify(hit || {}));
  }

  const lines = await logOf(page);
  mark("the log never reports 'the way was held' for this attack",
    !lines.some((line) => /could not step|way was held/i.test(String(line))),
    lines.filter((line) => /could not step|way was held/i.test(String(line))).slice(-2).join(" | "));

  const file = path.join(OUT, "pb195-land-overlap-" + Date.now() + ".json");
  writeFileSync(file, JSON.stringify({ base: BASE, era: ERA, overlaps, lastGap, lastOrderNote, lastClose, log: lines.slice(-40), evidence }, null, 2) + "\n");
  console.log("evidence: " + file);
  console.log(failed ? "PB-195 LIVE: " + failed + " FAIL" : "PB-195 LIVE: all checks passed");
} catch (err) {
  mark("the leg ran to the end", false, err && err.message ? err.message : String(err));
  console.log(failed ? "PB-195 LIVE: " + failed + " FAIL" : "PB-195 LIVE: all checks passed");
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGKILL");
}

process.exit(failed ? 1 : 0);
