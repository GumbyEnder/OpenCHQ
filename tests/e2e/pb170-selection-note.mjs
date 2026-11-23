// PB-170 leg: the selected aircraft's board note follows the room frame.
//
//   node tests/e2e/pb170-selection-note.mjs                 # starts its own server
//   node tests/e2e/pb170-selection-note.mjs --url=<base>    # use a running server
//
// The defect: the page kept the selected piece as the OBJECT it took out of the frame the click
// landed on. Every later frame replaces room.pieces, so that object froze — the board note said
// "Ready to fly" while the aircraft was away, which is the sentence the PM re-confirmed.
//
// What is measured, on a real page: the plane is selected, a bomb sends it away, and the note (read
// from the page's own board line, with the selection still on that plane) says "Away ... 8 rounds";
// one played round makes it 7; and after the countdown it reads "Ready to fly" at 0 with the same
// selection still bound.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb170")));
mkdirSync(OUT, { recursive: true });
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
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb170-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    const v = await fetch(BASE + "/api/version").then((r) => r.json()).catch(() => null);
    mark("the given host answers /api/version", Boolean(v), JSON.stringify(v));
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  // PB-170b: count the frames this page actually receives, by op and round, from the socket up.
  // The run below is graded on delta-only rounds, so a suite that merely "sees a full frame every
  // so often" must not be able to pass it. Installed before any page script runs.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.__chqFrames = { room: [], delta: [] };
    const record = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (!message || !message.op) return;
        if (message.op === "room") window.__chqFrames.room.push(Number(message.room && message.room.round));
        else if (message.op === "delta") window.__chqFrames.delta.push(Number(message.delta && message.delta.round));
      } catch (err) { void err; }
    };
    function Wrapped(...args) {
      const socket = new Native(...args);
      socket.addEventListener("message", record);
      return socket;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;
    window.WebSocket = Wrapped;
  });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const note = () => page.evaluate(() => window.__chq.note());
  const state = () => page.evaluate(() => window.__chq.state());

  async function setClock(want) {
    for (let i = 0; i < 6; i++) {
      const cur0 = await room();
      if (!cur0) return false;
      const now = cur0.clock === "running" ? "running" : "held";
      if (now === want) return true;
      await page.click("#clockBtn").catch(() => {});
      await page.waitForFunction((w) => {
        const r = window.__chq.room();
        return Boolean(r) && (r.clock === "running" ? "running" : "held") === w;
      }, want, { timeout: 8000, polling: 100 }).catch(() => {});
      await sleep(150);
    }
    return false;
  }

  async function setSpeedOne() {
    for (let i = 0; i < 8; i++) {
      const cur = await room();
      if (!cur) return false;
      if (Number(cur.speed) === 1) return true;
      const btn = await page.$("#speedDown");
      if (!btn) return false;
      // PB-174's lesson: a click on a disabled button spends a timeout. Guard on the read.
      if (await btn.evaluate((el) => el.disabled)) return false;
      await btn.click().catch(() => {});
      await sleep(250);
    }
    return Number((await room()).speed) === 1;
  }

  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(250);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(160);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(160);
    return true;
  }

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb170-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  await setClock("held");
  mark("a 1986 match is open and held", true, name);

  // ---- one aircraft -------------------------------------------------------------------------
  let cur = await room();
  const before = new Set((cur.pieces || []).map((p) => p.id));
  await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
  await sleep(250);
  await page.click('button.buyrow[data-kind="aircraft"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 }).catch(() => {});
  cur = await room();
  const mine = new Set(((cur.sites || []).filter((s) => s.owner === "blue")).map((s) => s.x + "," + s.y));
  const taken = new Set((cur.pieces || []).map((p) => p.x + "," + p.y));
  const cells = await page.evaluate(() => window.__chq.legalCells(8000));
  const pick = (cells || []).find((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y));
  if (!pick) throw new Error("no free friendly city/base cell for the aircraft");
  await clickCell(pick);
  await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 }).catch(() => {});
  cur = await room();
  const plane = (cur.pieces || []).find((p) => !before.has(p.id));
  if (!plane) throw new Error("the aircraft never appeared on the board");
  const planeId = plane.id;
  mark("one aircraft is bought and placed", true, planeId);

  // Select it: the note must speak about THIS plane.
  await clickCell({ x: plane.x, y: plane.y });
  await page.waitForFunction((id) => String(window.__chq.state().selected) === String(id), String(planeId), { timeout: 8000, polling: 100 }).catch(() => {});
  const readyNote = await note();
  mark("the selected plane reads ready before it flies", /Ready to fly/.test(readyNote), JSON.stringify(readyNote.slice(0, 120)));

  // ---- send it away with a bomb ---------------------------------------------------------------
  async function airBomb() {
    await page.click('.navbtn[data-dialog="air"]');
    await page.waitForSelector("#dialogBody button", { timeout: 8000 });
    const hit = await page.evaluate(() => {
      const el = [...document.querySelectorAll("#dialogBody button")].find((b) => (b.textContent || "").trim() === "Bomb");
      if (!el) return null;
      el.click();
      return true;
    });
    if (!hit) throw new Error("the Air dialog has no Bomb button");
    await sleep(400);
  }

  const candidates = ((await room()).sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
  let target = null;
  for (const candidate of candidates.slice(0, 6)) {
    await airBomb();
    await clickCell({ x: candidate.x, y: candidate.y });
    await page.waitForFunction((id) => {
      const r = window.__chq.room();
      const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
      return p && p.ready === false;
    }, planeId, { timeout: 6000, polling: 100 }).catch(() => {});
    const brief = (((await room()).seat || {}).air || []).find((p) => String(p.id) === String(planeId));
    if (brief && brief.ready === false) {
      target = candidate;
      break;
    }
  }
  if (!target) throw new Error("no enemy city accepted the bombing run");
  mark("the bomb sends the aircraft away", true, target.name);

  // Selection must still be on that plane, and the note must follow the FRAME, not the click.
  // The pointer is still over the target cell, where the board note is the route preview, so move
  // it off the board first: this reads the SELECTION note, which is the sentence PB-170 is about.
  await page.mouse.move(8, 8);
  await sleep(400);
  const stillSelected = String((await state()).selected) === String(planeId);
  const awayNote = await note();
  mark("the selection is still bound to the plane after the mission", stillSelected, JSON.stringify((await state()).selected));
  mark("the note reads 'Away ... 8 rounds' while it is away", /Away on a mission: 8 rounds/.test(awayNote), JSON.stringify(awayNote.slice(0, 160)));

  // ---- the delta-only run: 8 rounds, speed 1, no pause -----------------------------------------
  // PB-170b AC (a) and (b). The note is sampled on every round the clock produces, with the clock
  // running from the first tick to the eighth and never held, so each of those rounds reaches this
  // page as a `delta` frame. The socket wrapper installed above counts what really arrived.
  const planeInactive = (frame) => {
    const brief = ((frame && frame.seat && frame.seat.air) || []).find((p) => String(p.id) === String(planeId));
    return brief ? Number(brief.inactive) : null;
  };
  const startRound = Number((await room()).round) || 0;
  await page.evaluate(() => { window.__chqFrames.room.length = 0; window.__chqFrames.delta.length = 0; });
  mark("the clock is at speed 1 for the run", await setSpeedOne(), JSON.stringify((await room()).speed));
  await setClock("running");
  const seen = [];
  let lastRound = startRound;
  const runDeadline = Date.now() + 150000;
  while (Date.now() < runDeadline && lastRound < startRound + 8) {
    const frame = await room();
    const round = Number(frame && frame.round) || 0;
    if (round > lastRound) {
      seen.push({ round, note: await note(), inactive: planeInactive(frame) });
      lastRound = round;
    }
    await sleep(100);
  }
  const frames = await page.evaluate(() => ({ room: window.__chqFrames.room.slice(), delta: window.__chqFrames.delta.slice() }));
  await setClock("held");
  await sleep(300);

  const roundsInWindow = (list) => list.filter((n) => Number.isFinite(n) && n > startRound && n <= startRound + 8);
  const deltaRounds = roundsInWindow(frames.delta);
  const roomRounds = roundsInWindow(frames.room);
  mark("the run covered 8 rounds with no pause", seen.length >= 8, JSON.stringify(seen.map((s) => s.round)));
  mark("every round in the window arrived as a delta frame", new Set(deltaRounds).size >= 8, JSON.stringify(deltaRounds));
  mark("no full room frame landed in the window", roomRounds.length === 0, JSON.stringify(roomRounds));

  const noteByRound = new Map(seen.map((s) => [s.round, s.note]));
  for (let k = 1; k <= 8; k++) {
    const text = noteByRound.get(startRound + k);
    if (k < 8) {
      const want = new RegExp("Away on a mission: " + (8 - k) + " rounds?");
      mark("round +" + k + " reads " + (8 - k) + " rounds left", typeof text === "string" && want.test(text), JSON.stringify(String(text || "").slice(0, 140)));
    } else {
      mark("round +8 (inactive 0) reads 'Ready to fly'", typeof text === "string" && /Ready to fly/.test(text), JSON.stringify(String(text || "").slice(0, 140)));
    }
  }
  const finalSelected = String((await state()).selected) === String(planeId);
  mark("the same selection is still bound at 0", finalSelected, JSON.stringify((await state()).selected));
  mark("no page error during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

  await page.screenshot({ path: path.join(OUT, "pb170-selection-note.png") });
} catch (err) {
  failed += 1;
  evidence.push({ step: "leg threw", ok: false, detail: String(err && err.stack ? err.stack : err) });
  console.error("FAIL leg threw — " + String(err && err.message ? err.message : err));
} finally {
  try {
    if (browser) await browser.close();
  } catch (err) { void err; }
  try {
    if (server) server.kill("SIGKILL");
  } catch (err) { void err; }
  writeFileSync(path.join(OUT, "pb170-selection-note.json"), JSON.stringify({ base: BASE, failed, evidence }, null, 2));
  console.log("pb170 selection note: " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  process.exit(failed ? 1 : 0);
}
