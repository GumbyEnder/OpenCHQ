// PB-178 live leg: a bombing run's target has to lie inside the RESTRICTED air radius.
//
//   node tests/e2e/pb178-bomb-radius.mjs                 # starts its own server (OPENCHQ_DEBUG=1)
//   node tests/e2e/pb178-bomb-radius.mjs --url=<base>    # use a running server; it MUST be debug-on
//
// The defect this leg exists for: the port carried ONE air number (air.reach 10, a stand-in) and no
// target-distance test at all, so a bombing run was accepted at any distance from the aircraft as
// long as a friendly berth stood within reach of the plane. Manual p.25 names two circles - the
// restricted air radius "in which most missions must be performed", and the larger maximum air
// radius an unloaded transfer may use. PB-178 splits them and pins the Bomb order to the smaller one.
//
// What is measured, on a real page, a real socket and a real server, on a fresh match:
//   1. the server's briefing ships BOTH radii, restricted < maximum (the page cannot disagree with
//      the config the server charged);
//   2. Air > Bomb names the restricted radius before the player clicks, and sends nothing;
//   3. a target INSIDE the circle lands: one bomb_hit event, the site's timer +5, the aircraft away;
//   4. a target in the BAND (outside the restricted radius, inside the maximum) is refused with a
//      sentence that names the restricted radius, NOTHING goes on the wire, no bomb_hit is produced,
//      the site's timer does not move and the second aircraft is still ready.
//
// Evidence is the page's own room view, the server's own debug dump (/api/debug/room, OPENCHQ_DEBUG=1)
// and the page's wire log - never a hand-built board.
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
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb178")));
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb178-"));
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
  // INBOUND frames only, so it cannot answer this question.
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

  // The clock is the measurement's frame: rounds do not move under the click.
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
  const name = "e2e-pb178-" + Date.now().toString(36).slice(-8);
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

  // ---------------------------------------------------------------- 1. both radii on the wire
  const board0 = await page.evaluate(() => window.__chq.boardWidth ? window.__chq.boardWidth() : 320).catch(() => 320);
  const WIDTH = Number(board0) || 320;
  const away = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(WIDTH - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };

  // ---------------------------------------------------------------- buy an aircraft on a front cell
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
    const ports = (view.sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
    const cells = await page.evaluate(() => window.__chq.legalCells(8000));
    // The berth is where the plane flies from, so it is chosen for its REACH: the legal cell nearest
    // an enemy port, which is what puts a legal target inside (and a band target around) the circle.
    const pick = (cells || [])
      .filter((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y))
      .map((c) => ({ c, near: ports.length ? Math.min(...ports.map((s) => away(c, s))) : 999 }))
      .sort((a, b) => a.near - b.near)[0];
    if (!pick) return { error: "no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")" };
    await clickCell(pick.c);
    await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
      .catch(() => {});
    const after = await room();
    const plane = (after.pieces || []).find((p) => !before.has(p.id));
    if (!plane) return { error: "the aircraft never appeared on the board" };
    return { plane, cell: pick.c, near: pick.near, row: row.text };
  }

  const first = await buyAircraft();
  if (first.error) throw new Error(first.error);
  const planeId = first.plane.id;
  const planeCell = { x: Number(first.plane.x), y: Number(first.plane.y) };
  mark("an aircraft is bought and based on a front cell", true, planeId + " at " + planeCell.x + "," + planeCell.y + " (nearest enemy port " + first.near + ")");

  cur = await room();
  var briefing = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  mark("the briefing offers Bomb", Boolean(briefing && (briefing.missions || []).some((m) => m.mode === "bomb")), JSON.stringify(briefing && briefing.missions.map((m) => m.label)));
  const restricted = Math.floor(Number(briefing && briefing.restrictedReach));
  const maximum = Math.floor(Number(briefing && briefing.reach));
  mark("the briefing ships BOTH circles, restricted < maximum",
    Number.isFinite(restricted) && Number.isFinite(maximum) && restricted > 0 && restricted < maximum,
    "restricted " + restricted + ", maximum " + maximum);

  // ---------------------------------------------------------------- 2. Air > Bomb arms, names the circle
  async function airBomb() {
    await page.click('.navbtn[data-dialog="air"]');
    await page.waitForSelector("#dialogBody button", { timeout: 8000 });
    // The dialog lists every aircraft. The READY one is the aircraft this click is for; an inactive
    // plane's buttons are disabled, and clicking those would measure nothing (PB-178's first run
    // did exactly that and read a stale note as a result).
    const hit = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#dialogBody button")]
        .filter((b) => (b.textContent || "").trim().startsWith("Bomb"));
      const usable = buttons.filter((b) => !b.disabled);
      const el = usable[usable.length - 1] || null;
      if (!el) return null;
      const detail = { label: el.textContent.trim(), title: el.title || "", enabled: usable.length };
      el.click();
      return detail;
    });
    if (!hit) return { error: "the Air dialog has no enabled Bomb button" };
    await sleep(400);
    return hit;
  }

  const wireBeforeArm = (await sentFrames()).length;
  const armed = await airBomb();
  if (armed.error) throw new Error(armed.error);
  mark("the Bomb door's own help names the restricted radius",
    new RegExp("restricted air radius \\(" + restricted + " cells\\)").test(String(armed.title)),
    JSON.stringify(armed.title).slice(0, 160));
  const sentOnArm = (await sentFrames()).slice(wireBeforeArm).filter((line) => /mission/.test(String(typeof line === "string" ? line : JSON.stringify(line))));
  mark("Air > Bomb sends no order", sentOnArm.length === 0, "wire " + JSON.stringify(sentOnArm.slice(0, 2)));
  const armNote = (await note()) + " " + (await toast());
  mark("the board hands the player the map and names the circle",
    /Bomb: pick an empty enemy city/i.test(armNote), JSON.stringify(armNote.trim().slice(0, 160)));

  // ---------------------------------------------------------------- pick the two targets
  const dump = await debugRoom();
  const busy = new Set(((dump && dump.pieces) || []).map((p) => Number(p.x) + "," + Number(p.y)));
  const bombable = new Set(["city", "base", "facility", "capital"]);
  const sites = ((await room()).sites || [])
    .filter((s) => s.owner === "red" && bombable.has(String(s.kind)))
    .filter((s) => !busy.has(Number(s.x) + "," + Number(s.y)));
  const inside = sites.filter((s) => away(planeCell, s) <= restricted).sort((a, b) => away(planeCell, a) - away(planeCell, b))[0] || null;
  const band = sites.filter((s) => { const d = away(planeCell, s); return d > restricted && d <= maximum; })
    .sort((a, b) => away(planeCell, a) - away(planeCell, b))[0] || null;
  mark("an empty enemy site stands inside the restricted radius", Boolean(inside),
    inside ? inside.name + " (" + inside.kind + ") at " + inside.x + "," + inside.y + " d=" + away(planeCell, inside) : "none of " + sites.length + " empty enemy sites");
  mark("an empty enemy site stands in the band between the circles", Boolean(band),
    band ? band.name + " (" + band.kind + ") at " + band.x + "," + band.y + " d=" + away(planeCell, band) : "none of " + sites.length + " empty enemy sites");

  // ---------------------------------------------------------------- 3. inside the circle: it lands
  if (inside) {
    const roundBefore = Number((await room()).round) || 0;
    const wireBefore = (await sentFrames()).length;
    await clickCell({ x: inside.x, y: inside.y });
    await page.waitForFunction((id) => {
      const r = window.__chq.room();
      const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
      return p && p.ready === false;
    }, planeId, { timeout: 12000, polling: 100 }).catch(() => {});
    const wireSent = (await sentFrames()).slice(wireBefore);
    const frames = wireSent.filter((line) => /"op":"mission"/.test(String(typeof line === "string" ? line : JSON.stringify(line))));
    mark("the inside click sent exactly one mission frame", frames.length === 1, "wire " + JSON.stringify(frames.slice(0, 1)).slice(0, 200));
    const afterDump = await debugRoom();
    const hit = ((afterDump && afterDump.pendingEvents) || []).find((e) => e && e.type === "bomb_hit" && String(e.site) === String(inside.id));
    mark("the run landed as one bomb_hit on that site", Boolean(hit),
      JSON.stringify(hit && { site: hit.name, kind: hit.kind, cash: hit.cash, unready: hit.unready, round: hit.round }));
    const cur2 = await room();
    const siteAfter = (cur2.sites || []).find((s) => Number(s.x) === Number(inside.x) && Number(s.y) === Number(inside.y));
    mark("the site is unready 5 rounds after the run",
      Boolean(siteAfter) && Number(siteAfter.readyRound) === roundBefore + 5,
      "readyRound " + (siteAfter && siteAfter.readyRound) + " (round before " + roundBefore + ")");
    const brief2 = ((cur2.seat && cur2.seat.air) || []).find((p) => String(p.id) === String(planeId));
    mark("the aircraft is away after the run", Boolean(brief2) && brief2.ready === false, "ready " + (brief2 && brief2.ready) + ", roundsLeft " + (brief2 && brief2.roundsLeft));
  }

  // ---------------------------------------------------------------- 4. the band: refused, no wire order
  if (band) {
    const second = await buyAircraft();
    if (second.error) throw new Error(second.error);
    const secondId = second.plane.id;
    const secondCell = { x: Number(second.plane.x), y: Number(second.plane.y) };
    const bandForSecond = sites
      .filter((s) => { const d = Math.max(Math.min(Math.abs(secondCell.x - s.x), Math.abs(WIDTH - Math.abs(secondCell.x - s.x))), Math.abs(secondCell.y - s.y)); return d > restricted && d <= maximum; })
      .filter((s) => !(inside && s.id === inside.id))
      .sort((a, b) => away(secondCell, a) - away(secondCell, b))[0] || null;
    const target = bandForSecond || band;
    const targetMove = bandForSecond ? "second aircraft" : "first aircraft's cell";
    mark("a band target exists for the refusing aircraft", Boolean(target), target ? target.name + " d=" + away(secondCell, target) + " (" + targetMove + ")" : "none");
    if (target) {
      const wireBefore = (await sentFrames()).length;
      const arm2 = await airBomb();
      if (arm2.error) throw new Error(arm2.error);
      const dumpBefore = await debugRoom();
      const roundBefore = Number((await room()).round) || 0;
      await clickCell({ x: target.x, y: target.y });
      await sleep(700);
      const wireAfter = await sentFrames();
      const frames = wireAfter.slice(wireBefore)
        .filter((line) => /"op":"mission"/.test(String(typeof line === "string" ? line : JSON.stringify(line))));
      mark("the band click sent NO mission frame", frames.length === 0, "wire " + JSON.stringify(frames.slice(0, 2)).slice(0, 240));
      const said = (await note()) + " " + (await toast());
      mark("the refusal names the restricted radius and its size",
        new RegExp("restricted air radius \\(" + restricted + " cells\\)").test(said),
        JSON.stringify(said.trim().slice(-200)));
      const dumpAfter = await debugRoom();
      const hit = ((dumpAfter && dumpAfter.pendingEvents) || []).find((e) => e && e.type === "bomb_hit" && String(e.site) === String(target.id));
      mark("no bomb_hit was produced for the band target", !hit, JSON.stringify(hit || null));
      const cur3 = await room();
      const siteAfter = (cur3.sites || []).find((s) => Number(s.x) === Number(target.x) && Number(s.y) === Number(target.y));
      mark("the band target's timer did not move",
        !siteAfter || Number(siteAfter.readyRound || 0) <= roundBefore,
        "readyRound " + (siteAfter && siteAfter.readyRound) + " (round before " + roundBefore + ")");
      const brief3 = ((cur3.seat && cur3.seat.air) || []).find((p) => String(p.id) === String(secondId));
      mark("the refusing aircraft is still ready", Boolean(brief3) && brief3.ready === true, "ready " + (brief3 && brief3.ready));
      void dumpBefore;
    }
  }

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

const summary = { leg: "pb178-bomb-radius", passed: evidence.filter((e) => e.ok).length, failed, evidence };
writeFileSync(path.join(OUT, "pb178-bomb-radius.json"), JSON.stringify(summary, null, 2));
console.log("pb178 leg: " + summary.passed + " passed, " + failed + " failed, " + evidence.length + " checks");
process.exit(failed === 0 ? 0 : 1);
