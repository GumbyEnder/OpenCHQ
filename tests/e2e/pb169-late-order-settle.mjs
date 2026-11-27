// PB-169 leg: does the late-order warning come down when ITS OWN order is answered?
//
//   node tests/e2e/pb169-late-order-settle.mjs                 # starts its own server from this tree
//   node tests/e2e/pb169-late-order-settle.mjs --url=<base>     # use a running server
//
// Why the suite could not answer this (frodo 8213): pb169_late_order_line pins the module
// boundaries, and deleting settleOrder's clear call site (app.js:136) leaves the node suite at
// exit 0 / 0 red arms. The wiring is only visible from the page, so this leg is the instrument.
//
// Method. The page's real socket is wrapped (addInitScript), not the app: the first outbound `buy`
// frame is captured and deliberately NEVER released during the run, so the page really goes past
// its 2 s ack deadline and really paints "No answer yet for your infantry...". The answer is then
// delivered as an inbound frame on that same socket instance (`window.__inject`), which runs the
// page's own message handler and therefore the real settleOrder call the node suite cannot see.
// Injected frames are labelled as injected in the evidence; everything they exercise is page code.
//
// A real buy answer is NOT used for the grade on purpose: `bought` and `ordered` both call say()
// with their own sentence, which overwrites the late line on pre-PB-169 trees too. The claim under
// test is the clear-on-settle wiring, and only a silent answer isolates it.
//
// Graded, in this order:
//   1. a buy order goes out with an id and gets no answer (held off the wire the whole run);
//   2. >2 s of silence paints the queued sentence on the flash line;
//   3. an ack for a DIFFERENT id does not take that line down (owner tracking, from the page);
//   4. an ack for the order's own id does -- before the 6 s flash timer could have expired it;
//   5. the held frame really is the page's own armed buy order;
//   6. no page error during the run.
//
// On pre-PB-169 code (6d4ecd3) step 4 reports the defect: the sentence is still on the line after
// its own ack. The leg does not decide which tree it is on; it prints the line and grades it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = argOf("era", "1986");
const OUT = evidenceDir("pb169", argOf("out"));
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb169-"));
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
  // The wire is wrapped, not the app: the first outbound buy frame is captured and never sent, and
  // inbound frames can be injected on the same socket instance so the page's own handler runs.
  await context.addInitScript(() => {
    window.__frames = [];
    window.__hold = { armed: true, heldId: null, heldAt: 0 };
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...args) {
        super(...args);
        window.__sock = this;
        this.addEventListener("message", (event) => {
          try {
            const m = JSON.parse(event.data);
            window.__frames.push({ dir: "in", op: m.op, id: m.id === undefined ? null : m.id, injected: Boolean(m.__injected) });
          } catch (err) { void err; }
        });
      }
      send(data) {
        let m = null;
        try { m = JSON.parse(data); } catch (err) { void err; }
        window.__frames.push({ dir: "out", op: m && m.op ? m.op : null, id: m && m.id !== undefined ? m.id : null, kind: m && m.kind ? m.kind : null });
        if (m && m.op === "buy" && window.__hold.armed) {
          window.__hold.armed = false;
          window.__hold.heldId = m.id;
          window.__hold.heldAt = Date.now();
          return; // held: no answer for this id can arrive from the server
        }
        return super.send(data);
      }
    };
    // An inbound frame, delivered through the page's real socket listener.
    window.__inject = (message) => window.__sock.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ ...message, __injected: true }) }),
    );
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const flash = () => page.evaluate(() => window.__chq.toast());
  const frames = () => page.evaluate(() => window.__frames.slice());
  const held = () => page.evaluate(() => ({ ...window.__hold }));
  const inject = (message) => page.evaluate((m) => window.__inject(m), message);

  async function holdClock() {
    for (let i = 0; i < 6; i++) {
      const cur = await room();
      if (!cur) return false;
      if (cur.clock !== "running") return true;
      await page.click("#clockBtn").catch(() => {});
      await sleep(300);
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

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb169-" + Date.now().toString(36).slice(-8);
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
  await holdClock();
  const cur = await room();
  mark("Play a bot opens a " + ERA + " match on a held clock", Boolean(cur && cur.seat && cur.clock !== "running"), "round " + (cur && cur.round));

  // ---------------------------------------------------------------- a real armed buy, held on the wire
  await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
  await sleep(300);
  const row = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("button.buyrow[data-kind]")];
    const el = rows.find((b) => !b.disabled && !/^use this now/i.test(b.title || ""));
    return el ? { kind: el.dataset.kind, title: el.title, text: el.textContent.trim().slice(0, 60) } : null;
  });
  if (!row) throw new Error("no affordable placed unit in the Buy table");
  await page.click('button.buyrow[data-kind="' + row.kind + '"]');
  const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
    .then(() => true).catch(() => false);
  if (!armed) throw new Error("buying " + row.kind + " did not arm a placement");
  const view = await room();
  const mine = new Set(((view.sites || []).filter((s) => s.owner === "blue")).map((s) => s.x + "," + s.y));
  const taken = new Set((view.pieces || []).map((p) => p.x + "," + p.y));
  const cells = await page.evaluate(() => window.__chq.legalCells(8000));
  const pick = (cells || []).find((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y));
  if (!pick) throw new Error("no free friendly city/base cell for " + row.kind + " (legal " + (cells || []).length + ")");
  mark("the Buy table arms " + row.kind + " and the mask offers " + (cells || []).length + " cells", true, row.text);

  await clickCell(pick);

  // 1. the order went out and is held off the wire
  const identified = await page.waitForFunction(() => window.__hold.heldId !== null, null, { timeout: 8000, polling: 100 })
    .then(() => true).catch(() => false);
  const hold = await held();
  mark("a buy order carries an id and is held off the wire", identified, "id " + hold.heldId);

  // 2. >2 s with no answer paints the queued sentence
  const late = await page.waitForFunction(() => /no answer yet/i.test(window.__chq.toast()), null, { timeout: 6000, polling: 100 })
    .then(() => true).catch(() => false);
  const lateLine = await flash();
  mark("the unanswered order paints the queued sentence", late, JSON.stringify(lateLine));

  // 3. an ack for a DIFFERENT id must not take this order's line down
  await inject({ op: "ack", id: "o-not-this-order", events: [] });
  await sleep(600);
  const afterForeign = await flash();
  mark("an ack for another id leaves the line up", afterForeign === lateLine, JSON.stringify(afterForeign));

  // 4. an ack for the order's OWN id takes it down, well before the 6 s flash timer expires
  const t0 = Date.now();
  await inject({ op: "ack", id: hold.heldId, events: [] });
  const cleared = await page.waitForFunction(() => !/no answer yet/i.test(window.__chq.toast()), null, { timeout: 2000, polling: 50 })
    .then(() => true).catch(() => false);
  const settledLine = await flash();
  mark("its own ack takes the queued sentence off the line", cleared,
    "after " + (Date.now() - t0) + " ms the line reads " + JSON.stringify(settledLine));

  // 5. the held order was real: a buy frame with a kind and a cell, off a placement mask
  const outFrames = (await frames()).filter((f) => f.dir === "out" && f.op === "buy");
  const buyFrame = outFrames.find((f) => f.id === hold.heldId);
  mark("the held frame is the page's own armed buy order", Boolean(buyFrame) && String(buyFrame.kind) === String(row.kind),
    JSON.stringify(outFrames));

  mark("no page error during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

  await page.screenshot({ path: path.join(OUT, "pb169-late-order-settle.png") });
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
  writeFileSync(path.join(OUT, "pb169-late-order-settle.json"), JSON.stringify({ base: BASE, era: ERA, failed, evidence }, null, 2));
  console.log("pb169 late-order settle: " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  process.exit(failed ? 1 : 0);
}
