// PB-172 leg: is the second mission frame the SAME order replayed out of the page's queue?
//
//   node tests/e2e/pb172-mission-replay.mjs                  # starts its own server
//   node tests/e2e/pb172-mission-replay.mjs --url=<base>     # use a running server (no debug dump needed)
//
// The report this leg settles: right after a bomb target click the page sends a second mission order,
// the server refuses it with "That aircraft is inactive for N more rounds.", and that refusal paints
// as a toast even though the bomb landed.
//
// The page's own wire is wrapped here (addInitScript), not read through __chq.wire(), because the
// question is about ORDER IDS and that log carries labels, not ids.
//
// What is measured, on a real page/socket/server:
//   1. one aircraft bought and placed; Air > Bomb arms; ONE target click;
//   2. the mission frame goes out with an id;
//   3. the reply to it (ack) carries that same id - PB-172's server half;
//   4. the page's socket is killed and allowed to reconnect, which is exactly what flushes orderQueue;
//   5. after the reconnect there is NO second mission frame with that id, no "inactive for" error
//      frame, and no refusal toast;
//   6. no "No answer yet for your mission" line appears after the mission.
//
// On pre-PB-172 code the same leg reports the defect: two mission frames sharing one id, an ack with
// id null, an error frame, and the queued line. The leg does not decide which tree it is on - it
// prints the observed frames and grades the ACs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb172")));
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

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay-local/node_modules/playwright/index.mjs",
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "playwright" && !existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      void err;
    }
  }
  return import("playwright");
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb172-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE + " (sha " + (process.env.GIT_SHA || "working tree") + ")");
  } else {
    const v = await fetch(BASE + "/api/version").then((r) => r.json()).catch(() => null);
    mark("the given host answers /api/version", Boolean(v), JSON.stringify(v));
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  // Raw frame capture: every outbound and inbound frame with its id. The page's own __chq.wire()
  // is a label log and cannot answer "same id or different id".
  await context.addInitScript(() => {
    window.__frames = [];
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          try {
            const m = JSON.parse(event.data);
            window.__frames.push({ dir: "in", op: m.op, id: m.id === undefined ? null : m.id, error: m.error || null, events: (m.events || []).length, duplicate: m.duplicate === true });
          } catch (err) { void err; }
        });
      }
      send(data) {
        try {
          const m = JSON.parse(data);
          window.__frames.push({ dir: "out", op: m.op, id: m.id === undefined ? null : m.id, mode: m.mode || null, piece: m.piece || null });
        } catch (err) { void err; }
        return super.send(data);
      }
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const note = () => page.evaluate(() => window.__chq.note());
  const frames = () => page.evaluate(() => window.__frames.slice());
  const socketState = () => page.evaluate(() => window.__chq.socketState());

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
  const name = "e2e-pb172-" + Date.now().toString(36).slice(-8);
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
  mark("the clock is held for the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

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
    const pick = (cells || []).find((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y));
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
  mark("one aircraft is bought and placed", true, planeId + " at " + bought.cell.x + "," + bought.cell.y);

  async function airBomb() {
    await page.click('.navbtn[data-dialog="air"]');
    await page.waitForSelector("#dialogBody button", { timeout: 8000 });
    const hit = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#dialogBody button")];
      const el = buttons.find((b) => (b.textContent || "").trim() === "Bomb");
      if (!el) return null;
      el.click();
      return el.textContent.trim();
    });
    if (!hit) return { error: "the Air dialog has no Bomb button" };
    await sleep(400);
    return { ok: true };
  }

  // Targets from the page's own view: an enemy city or base. Visibility is the page's, so a target
  // that turns out to be occupied is a refusal and the leg tries the next one; a landed run (the
  // plane leaves `ready`) ends the search.
  function candidateTargets(view) {
    return (view.sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
  }

  const armed = await airBomb();
  if (armed.error) throw new Error(armed.error);
  let target = null;
  let beforeClickCount = 0;
  for (const candidate of candidateTargets(await room()).slice(0, 6)) {
    const pre = (await frames()).length;
    await clickCell({ x: candidate.x, y: candidate.y });
    await page.waitForFunction((id) => {
      const r = window.__chq.room();
      const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
      return p && p.ready === false;
    }, planeId, { timeout: 8000, polling: 100 }).catch(() => {});
    const now = await room();
    const brief = ((now.seat && now.seat.air) || []).find((p) => String(p.id) === String(planeId));
    const sent = (await frames()).slice(pre).filter((f) => f.dir === "out" && f.op === "mission");
    if (sent.length && brief && brief.ready === false) {
      target = candidate;
      beforeClickCount = sent.length;
      break;
    }
    // A refusal means the cursor stayed armed; re-arm before the next candidate.
    if (sent.length && !(brief && brief.ready === false)) await airBomb();
  }
  if (!target) throw new Error("no enemy city accepted a bombing run (" + JSON.stringify(pageErrors.slice(0, 2)) + ")");
  mark("one target click lands the run", true, target.name + " at " + target.x + "," + target.y);

  const allFrames = await frames();
  const missionOut = allFrames.filter((f) => f.dir === "out" && f.op === "mission");
  const missionIds = [...new Set(missionOut.map((f) => f.id))];
  const firstId = missionOut.length ? missionOut[missionOut.length - 1].id : null;
  mark("the mission frame carries an order id", Boolean(firstId), "out ids " + JSON.stringify(missionOut.map((f) => f.id)));
  mark("one target click sends ONE mission frame", beforeClickCount === 1, beforeClickCount + " frame(s) in this click");

  const acksForMission = allFrames.filter((f) => f.dir === "in" && f.op === "ack");
  const exactAck = acksForMission.find((f) => f.id === firstId);
  mark("the mission ack echoes the order id", Boolean(exactAck), "acks " + JSON.stringify(acksForMission.map((f) => ({ id: f.id, events: f.events }))));

  // The claim that comes with the replay: an order that never settles also makes the page say so.
  // Measured BEFORE the socket is dropped, because the refusal toast would overwrite this line.
  await sleep(2400);
  const lateBeforeDrop = (await note()) + " " + (await toast());
  const queuedLine = /no answer yet/i.test(lateBeforeDrop);

  // ---- the reconnect: this is the path that replays the queue ------------------------------
  // A mission whose ack never settled it stays in orderQueue; the page flushes the queue on every
  // socket open, so this is the replay the report is about. On fixed code the queue is empty here.
  const beforeDrop = (await frames()).length;
  await page.evaluate(() => window.__chq.dropSocket());
  await page.waitForFunction(() => window.__chq.socketState() === "open", null, { timeout: 15000, polling: 100 }).catch(() => {});
  await sleep(2500);
  const afterDrop = (await frames()).slice(beforeDrop);
  const replayed = afterDrop.filter((f) => f.dir === "out" && f.op === "mission" && f.id === firstId);
  const refusals = afterDrop.filter((f) => f.dir === "in" && f.op === "error" && /inactive for/i.test(String(f.error || "")));
  const lateLine = /no answer yet/i.test((await note()) + " " + (await toast()));
  void lateLine;
  mark("no 'No answer yet' line after a mission (2.4 s after the click)", !queuedLine, JSON.stringify(lateBeforeDrop.slice(0, 160)));
  console.log("frames after the reconnect: " + JSON.stringify(afterDrop.filter((f) => f.op === "mission" || f.op === "error" || f.op === "ack").slice(0, 8)));

  mark("a reconnect does NOT replay the mission frame", replayed.length === 0, replayed.length + " replayed frame(s) with id " + firstId);
  mark("a replay never surfaces as an 'inactive for' refusal", refusals.length === 0, JSON.stringify(refusals.slice(0, 2)));
  mark("no 'No answer yet' line after a mission", !lateLine, JSON.stringify({ note: (await note()).slice(0, 120), toast: (await toast()).slice(0, 120) }));
  mark("no page error during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

  await page.screenshot({ path: path.join(OUT, "pb172-mission-replay.png") });
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
  writeFileSync(path.join(OUT, "pb172-mission-replay.json"), JSON.stringify({ base: BASE, failed, evidence }, null, 2));
  console.log("pb172 mission replay: " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  process.exit(failed ? 1 : 0);
}
