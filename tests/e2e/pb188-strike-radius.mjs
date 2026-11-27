// PB-188 live leg: a STRIKE's target has to lie inside the RESTRICTED air radius too.
//
//   node tests/e2e/pb188-strike-radius.mjs                 # starts its own server (OPENCHQ_DEBUG=1)
//   node tests/e2e/pb188-strike-radius.mjs --url=<base>    # use a running server; it MUST be debug-on
//
// The defect this leg exists for: PB-178 pinned the Bomb order to the smaller of the manual's two
// air circles, but left the Strike order on the maximum one. The manual's sentence is "the
// restricted air radius in which most missions must be performed", and a strike is a mission, so
// the port had a strike flying 10 cells while a bomb could not fly 7. PB-188 (ruling, room 8383 §4)
// makes the circle a property of the air layer.
//
// What is measured, on a real page, a real socket and a real server, on a fresh match:
//   1. the briefing ships BOTH radii, restricted < maximum;
//   2. both Strike doors name the restricted radius in their own text (Air dialog and Kit panel);
//   3. a strike at restricted+1 sends NO mission frame - measured by hooking WebSocket.prototype.send,
//      because the page's debug wire log holds INBOUND frames only and cannot answer it - and the
//      server's own event dump shows no strike event, the plane still ready, the round and the
//      seat's oil unmoved;
//   4. a strike exactly at the restricted radius sends exactly one mission frame and lands as one
//      strike event on that cell, with the aircraft away afterwards.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = evidenceDir("pb188", argOf("out"));
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb188-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers with the debug dump on", true, BASE);
  } else {
    const probe = await fetch(BASE + "/api/debug/room?id=none").catch(() => null);
    const body = probe ? await probe.json().catch(() => ({})) : {};
    if (!probe || probe.status !== 404 || /debug is off/.test(String(body.error || ""))) {
      throw new Error("this leg reads the room's own dump from /api/debug/room, which is off on " + BASE
        + " (start that host with OPENCHQ_DEBUG=1, or run with no --url to start one here)");
    }
    mark("the given host serves the debug dump", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  // "No order went out" is a claim about the socket, so the socket is what is measured: every frame
  // the page writes is recorded before the app's own handlers run. The page's debug wire log records
  // INBOUND frames only, so it cannot answer this question (game's finding, room 8383 §4 AC b).
  await context.addInitScript(() => {
    window.__sentFrames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { window.__sentFrames.push(String(data)); } catch { /* ignore */ }
      return send.call(this, data);
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const note = () => page.evaluate(() => window.__chq.note());
  const sentFrames = () => page.evaluate(() => (window.__sentFrames || []).slice());
  async function debugRoom() {
    const cur = await room();
    if (!cur || !cur.id) return null;
    const res = await fetch(BASE + "/api/debug/room?id=" + encodeURIComponent(cur.id));
    return res.ok ? res.json() : null;
  }

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

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb188-" + Date.now().toString(36).slice(-8);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  mark("a throwaway player registers", true, name);

  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  let cur = await room();
  mark("Play a bot opens a 1986 match", Boolean(cur && cur.seat), "round " + (cur && cur.round));
  await setClock("held");
  cur = await room();
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

  const board0 = await page.evaluate(() => window.__chq.boardWidth ? window.__chq.boardWidth() : 320).catch(() => 320);
  const WIDTH = Number(board0) || 320;
  const away = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(WIDTH - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };

  // ---------------------------------------------------------------- buy an aircraft
  async function buyAircraft() {
    const before = new Set(((await room()).pieces || []).map((p) => p.id));
    await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
    await sleep(250);
    const row = await page.evaluate(() => {
      const el = document.querySelector('button.buyrow[data-kind="aircraft"]');
      return el ? { disabled: Boolean(el.disabled), text: el.textContent.trim().slice(0, 80) } : null;
    });
    if (!row || row.disabled) return { error: "the aircraft row is missing or greyed: " + JSON.stringify(row) };
    await page.click('button.buyrow[data-kind="aircraft"]');
    const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
      .then(() => true).catch(() => false);
    if (!armed) return { error: "the aircraft purchase did not arm a placement" };
    const view = await room();
    const mine = new Set(((view.sites || []).filter((s) => s.owner === "blue")).map((s) => s.x + "," + s.y));
    const taken = new Set((view.pieces || []).map((p) => p.x + "," + p.y));
    const cells = await page.evaluate(() => window.__chq.legalCells(8000));
    const pick = (cells || []).filter((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y))[0];
    if (!pick) return { error: "no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")" };
    await clickCell(pick);
    await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
      .catch(() => {});
    const after = await room();
    const plane = (after.pieces || []).find((p) => !before.has(p.id));
    if (!plane) return { error: "the aircraft never appeared on the board" };
    return { plane, cell: pick };
  }

  const bought = await buyAircraft();
  if (bought.error) throw new Error(bought.error);
  const planeId = bought.plane.id;
  const planeCell = { x: Number(bought.plane.x), y: Number(bought.plane.y) };
  mark("an aircraft is bought and based", true, planeId + " at " + planeCell.x + "," + planeCell.y);

  cur = await room();
  let briefing = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  mark("the briefing offers Strike", Boolean(briefing && (briefing.missions || []).some((m) => m.mode === "strike")),
    JSON.stringify(briefing && briefing.missions.map((m) => m.label)));
  const restricted = Math.floor(Number(briefing && briefing.restrictedReach));
  const maximum = Math.floor(Number(briefing && briefing.reach));
  mark("the briefing ships BOTH circles, restricted < maximum",
    Number.isFinite(restricted) && Number.isFinite(maximum) && restricted > 0 && restricted < maximum,
    "restricted " + restricted + ", maximum " + maximum);

  const circleText = new RegExp("restricted air radius \\(" + restricted + " cells\\)");

  // ---------------------------------------------------------------- 2a. the Air door
  await page.click('.navbtn[data-dialog="air"]');
  await page.waitForSelector("#dialogBody button", { timeout: 8000 });
  const airStrike = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("#dialogBody button")]
      .filter((b) => (b.textContent || "").trim().startsWith("Strike"));
    const usable = buttons.filter((b) => !b.disabled);
    const el = usable[usable.length - 1] || null;
    if (!el) return null;
    const detail = { label: el.textContent.trim(), title: el.title || "", enabled: usable.length };
    el.click();
    return detail;
  });
  if (!airStrike) throw new Error("the Air dialog has no enabled Strike button");
  await sleep(400);
  mark("the Air dialog's Strike door names the restricted radius in its own text",
    circleText.test(String(airStrike.title)), JSON.stringify(airStrike.title).slice(0, 200));
  const airNote = (await note()) + " " + (await toast());
  mark("arming Strike hands the player the map and names the circle",
    circleText.test(airNote) && /Strike: pick the target cell/.test(airNote), JSON.stringify(airNote.trim().slice(0, 200)));

  // ---------------------------------------------------------------- 2b. the Kit door
  // The Kit panel draws a mission row for the SELECTED aircraft, so select the plane first.
  await clickCell(planeCell);
  await sleep(250);
  await page.click('.navbtn[data-dialog="kit"]').catch(() => {});
  await page.waitForSelector("#dialogBody button", { timeout: 8000 });
  const kitStrike = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("#dialogBody button")]
      .filter((b) => (b.textContent || "").trim().startsWith("Strike"));
    const el = buttons[buttons.length - 1] || null;
    return el ? { label: el.textContent.trim(), title: el.title || "" } : null;
  });
  mark("the Kit panel's Strike door names the restricted radius in its own text",
    Boolean(kitStrike) && circleText.test(String(kitStrike.title)),
    JSON.stringify(kitStrike && kitStrike.title).slice(0, 200));
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(200);

  // ---------------------------------------------------------------- 3. restricted+1: refused, no wire
  // Re-select the aircraft: the strike path only runs when the plane is the selection and the
  // mission on the wire would be the default one (strike).
  await clickCell(planeCell);
  await sleep(250);
  const bandCell = { x: ((planeCell.x + restricted + 1) % WIDTH + WIDTH) % WIDTH, y: planeCell.y };
  const bandDistance = away(planeCell, bandCell);
  mark("the refusing cell really is restricted+1", bandDistance === restricted + 1,
    "cell " + bandCell.x + "," + bandCell.y + " d=" + bandDistance);
  const seatFuelBefore = JSON.stringify((await room()).seat && (await room()).seat.fuel);
  const roundBefore = Number((await room()).round) || 0;
  const wireBefore = (await sentFrames()).length;
  await clickCell(bandCell);
  await sleep(700);
  const frames = (await sentFrames()).slice(wireBefore)
    .filter((line) => /"op":"mission"/.test(String(line)));
  mark("the strike at restricted+1 sent NO mission frame", frames.length === 0,
    "wire " + JSON.stringify(frames.slice(0, 2)).slice(0, 240));
  const said = (await note()) + " " + (await toast());
  mark("the refusal names the circle as a strike", /an air strike must be inside the restricted air radius/.test(said)
    && circleText.test(said), JSON.stringify(said.trim().slice(-220)));
  const dumpBand = await debugRoom();
  const strayStrike = ((dumpBand && dumpBand.pendingEvents) || []).find((e) => e && (e.type === "strike" || e.type === "strike_hit") &&
    Number(e.x) === Number(bandCell.x) && Number(e.y) === Number(bandCell.y));
  mark("no strike event was produced for the out-of-circle cell", !strayStrike, JSON.stringify(strayStrike || null));
  cur = await room();
  const briefBand = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  mark("the aircraft is still ready after the refusal", Boolean(briefBand) && briefBand.ready === true,
    "ready " + (briefBand && briefBand.ready));
  mark("the round did not move", (Number(cur.round) || 0) === roundBefore, "round " + cur.round + " (before " + roundBefore + ")");
  mark("the seat's oil did not move", JSON.stringify(cur.seat && cur.seat.fuel) === seatFuelBefore,
    "fuel " + JSON.stringify(cur.seat && cur.seat.fuel) + " (before " + seatFuelBefore + ")");

  // ---------------------------------------------------------------- 4. exactly at restricted: it flies
  await clickCell(planeCell);
  await sleep(250);
  const edgeCell = { x: ((planeCell.x + restricted) % WIDTH + WIDTH) % WIDTH, y: planeCell.y };
  mark("the accepting cell really is at the restricted radius", away(planeCell, edgeCell) === restricted,
    "cell " + edgeCell.x + "," + edgeCell.y + " d=" + away(planeCell, edgeCell));
  const wireEdge = (await sentFrames()).length;
  await clickCell(edgeCell);
  await page.waitForFunction((id) => {
    const r = window.__chq.room();
    const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
    return p && p.ready === false;
  }, planeId, { timeout: 12000, polling: 100 }).catch(() => {});
  const edgeFrames = (await sentFrames()).slice(wireEdge).filter((line) => /"op":"mission"/.test(String(line)));
  mark("the edge click sent exactly one mission frame", edgeFrames.length === 1,
    "wire " + JSON.stringify(edgeFrames.slice(0, 1)).slice(0, 200));
  const dumpEdge = await debugRoom();
  const landed = ((dumpEdge && dumpEdge.pendingEvents) || []).find((e) => e && e.type === "strike" &&
    Number(e.x) === Number(edgeCell.x) && Number(e.y) === Number(edgeCell.y));
  mark("the edge strike landed as one strike event on that cell", Boolean(landed),
    JSON.stringify(landed && { mode: landed.mode, x: landed.x, y: landed.y, rounds: landed.rounds }));
  cur = await room();
  const briefEdge = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  mark("the aircraft is away after the strike", Boolean(briefEdge) && briefEdge.ready === false,
    "ready " + (briefEdge && briefEdge.ready) + ", roundsLeft " + (briefEdge && briefEdge.roundsLeft));

  const errors = pageErrors.filter((text) => !/ResizeObserver/.test(text));
  mark("the page raised no script error", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} catch (err) {
  failed += 1;
  evidence.push({ step: "leg threw", ok: false, detail: String(err && err.stack || err) });
  console.error("LEG ERROR: " + (err && err.stack || err));
} finally {
  try {
    if (browser) await browser.close();
  } catch { /* ignore */ }
  try {
    if (server) server.kill("SIGTERM");
  } catch { /* ignore */ }
}

const summary = { leg: "pb188-strike-radius", passed: evidence.filter((e) => e.ok).length, failed, evidence };
writeFileSync(path.join(OUT, "pb188-strike-radius.json"), JSON.stringify(summary, null, 2));
console.log("pb188 leg: " + summary.passed + " passed, " + failed + " failed, " + evidence.length + " checks");
process.exit(failed === 0 ? 0 : 1);
