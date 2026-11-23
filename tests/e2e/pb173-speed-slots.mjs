// PB-173 + PB-180 leg: no strip box may change width when the clock is toggled, and the strip's
// readouts must show their whole string at the widths the cards name.
//
//   node tests/e2e/pb173-speed-slots.mjs                 # starts its own server
//   node tests/e2e/pb173-speed-slots.mjs --url=<base>    # use a running server
//
// PB-173: three boxes in the strip are content-sized, so toggling the clock changes their width and
// the speed control can walk with them (#stripInfo -10.65 px, #purseChip +9.25 px, #clockBtn
// -9.78 px, row -11.18 px on live eea6834). PB-180: at 1280x800 #stripInfo rendered 50 of 151 px
// and #purseChip 182 of 548 px, both ellipsized.
//
// This leg reads real bounding boxes off a real page in a real match at every named width, and it
// toggles the clock at each width — a slot that holds at 1440 and breaks at 1280 is not a slot.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb173")));
const WIDTHS = (argOf("widths", "1440x900,1280x800,1024x768")).split(",").map((s) => {
  const [w, h] = s.split("x").map(Number);
  return { w, h, label: s };
});
const TOL = 0.05;
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
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
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
const near = (a, b) => Math.abs(a - b) <= TOL;
const d2 = (a, b) => (a == null || b == null ? null : +(b - a).toFixed(2));

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb173-"));
let server = null;
let browser = null;
let BASE = GIVEN;
const series = [];

const BOXES = [
  ["stripInfo", "#stripInfo"],
  ["phase", "#stripInfo .phase"],
  ["purseChip", "#purseChip"],
  ["clockBtn", "#clockBtn"],
  ["speedctl", ".speedctl"],
  ["speedDown", "#speedDown"],
  ["speedUp", "#speedUp"],
];
// The row itself: every control the player can press, for the overlap and overflow arms.
const ROW = [
  ["New", "#newBtn"], ["Resign", "#resignBtn"], ["Quit", "#quitBtn"], ["Clock", "#clockBtn"],
  ["speed-", "#speedDown"], ["speed+", "#speedUp"], ["speedReadout", "#speedReadout"],
  ["stripInfo", "#stripInfo"], ["purseChip", "#purseChip"],
];

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
  const context = await browser.newContext({ viewport: { width: WIDTHS[0].w, height: WIDTHS[0].h } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb173-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && document.body.classList.contains("in-match"), null, { timeout: 25000, polling: 100 });
  await sleep(600);
  mark("a 1986 match is open", Boolean(await page.evaluate(() => window.__chq.room()?.id)));

  const snap = (label) => page.evaluate(({ boxes, row, label }) => {
    const rows = {};
    for (const [key, sel] of boxes) {
      const el = document.querySelector(sel);
      if (!el) { rows[key] = null; continue; }
      const r = el.getBoundingClientRect();
      rows[key] = { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
        scrollW: el.scrollWidth, clientW: el.clientWidth, text: (el.textContent || "").trim() };
    }
    const items = [];
    for (const [key, sel] of row) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      items.push({ label: key, x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) });
    }
    const strip = document.getElementById("strip");
    const room = window.__chq.room() || {};
    return { label, rows, items,
      clock: room.clock || null, speed: Number(room.speed),
      readout: (document.getElementById("speedReadout")?.textContent || "").trim(),
      strip: { scrollW: strip.scrollWidth, clientW: strip.clientWidth },
      viewport: { w: window.innerWidth, h: window.innerHeight } };
  }, { boxes: BOXES, row: ROW, label });

  const clockRunning = async () => (await page.evaluate(() => (window.__chq.room() || {}).clock)) === "running";
  const setSpeed = async (want) => {
    for (let i = 0; i < 10; i++) {
      const s = await page.evaluate(() => Number((window.__chq.room() || {}).speed));
      if (s === want) return true;
      await page.click(s < want ? "#speedUp" : "#speedDown");
      await sleep(160);
    }
    return false;
  };

  const overlapPairs = (items) => {
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0.5 && oy > 0.5) pairs.push({ a: a.label, b: b.label, ox: +ox.toFixed(2) });
      }
    }
    return pairs;
  };

  for (const { w, h, label } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(500);
    if (!(await clockRunning())) { await page.click("#clockBtn"); await sleep(400); }
    await setSpeed(1);
    await sleep(400);

    const run = await snap("running-" + label);
    await page.click("#clockBtn");
    await sleep(600);
    const held = await snap("held-" + label);
    series.push(run, held);
    mark("the clock reads held at " + label, held.clock === "held", JSON.stringify({ clock: held.clock, stripInfo: held.rows.stripInfo?.text }));
    await page.click("#clockBtn");
    await sleep(500);
    mark("the clock is back to running at " + label, await clockRunning());

    // THE CARD: nothing in the row may change width or move for a clock toggle.
    for (const key of ["stripInfo", "phase", "purseChip", "clockBtn"]) {
      const a = run.rows[key], b = held.rows[key];
      mark("#" + key + " keeps its width across the toggle at " + label,
        Boolean(a && b) && near(a.w, b.w),
        JSON.stringify({ running: a && a.w, held: b && b.w, dW: a && b ? d2(a.w, b.w) : null, textA: a && a.text, textB: b && b.text }));
    }
    for (const key of ["speedctl", "speedDown", "speedUp"]) {
      const a = run.rows[key], b = held.rows[key];
      mark(key + " does not move across the toggle at " + label,
        Boolean(a && b) && near(a.x, b.x),
        JSON.stringify({ running: a && a.x, held: b && b.x, dL: a && b ? d2(a.x, b.x) : null }));
    }

    // PB-180: both readouts show their whole string, no ellipsis.
    for (const key of ["stripInfo", "purseChip"]) {
      const el = run.rows[key];
      mark("#" + key + " shows its whole string at " + label,
        Boolean(el) && el.clientW > 0 && el.scrollW <= el.clientW,
        JSON.stringify({ text: el && el.text, scrollW: el && el.scrollW, clientW: el && el.clientW, w: el && el.w }));
    }
    // PB-179's floor: nothing overlaps and nothing runs past the window.
    const pairs = overlapPairs(run.items);
    mark("no strip control overlaps at " + label, pairs.length === 0, JSON.stringify(pairs));
    mark("no strip control runs past the window at " + label,
      Math.max(...run.items.map((it) => it.x + it.w)) <= w + 0.5,
      "rightmost=" + Math.max(...run.items.map((it) => it.x + it.w)).toFixed(1) + " window=" + w);
    mark("the strip does not overflow at " + label, run.strip.scrollW <= run.strip.clientW, JSON.stringify(run.strip));
    await page.screenshot({ path: path.join(OUT, "pb173-" + label + ".png") });
  }

  // The speed axis, at the widest viewport: 1 -> 0 ("paused") -> 6 must not move the control either.
  await page.setViewportSize({ width: WIDTHS[0].w, height: WIDTHS[0].h });
  await sleep(400);
  await setSpeed(1);
  await sleep(400);
  const base1 = await snap("speed1");
  series.push(base1);
  await setSpeed(0);
  await sleep(600);
  const s0 = await snap("speed0");
  series.push(s0);
  mark("speed 0 reads paused in the strip", s0.speed === 0 && /paused/.test(s0.rows.stripInfo?.text || ""), JSON.stringify({ speed: s0.speed, stripInfo: s0.rows.stripInfo?.text }));
  await setSpeed(6);
  await sleep(600);
  const s6 = await snap("speed6");
  series.push(s6);
  mark("speed 6 is reachable", s6.speed === 6, JSON.stringify({ speed: s6.speed, readout: s6.readout }));
  for (const [label, snap2] of [["speed 0", s0], ["speed 6", s6]]) {
    for (const key of ["stripInfo", "phase", "purseChip", "clockBtn"]) {
      const a = base1.rows[key], b = snap2.rows[key];
      mark("#" + key + " keeps its width at " + label, Boolean(a && b) && near(a.w, b.w),
        JSON.stringify({ at1: a && a.w, now: b && b.w, dW: a && b ? d2(a.w, b.w) : null, text: b && b.text }));
    }
    for (const key of ["speedctl", "speedDown", "speedUp"]) {
      const a = base1.rows[key], b = snap2.rows[key];
      mark(key + " does not move at " + label, Boolean(a && b) && near(a.x, b.x),
        JSON.stringify({ at1: a && a.x, now: b && b.x, dL: a && b ? d2(a.x, b.x) : null }));
    }
  }

  mark("no page error during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} catch (err) {
  failed += 1;
  evidence.push({ step: "leg threw", ok: false, detail: String(err && err.stack ? err.stack : err) });
  console.error("FAIL leg threw — " + String(err && err.message ? err.message : err));
} finally {
  try { if (browser) await browser.close(); } catch (err) { void err; }
  try { if (server) server.kill("SIGKILL"); } catch (err) { void err; }
  writeFileSync(path.join(OUT, "pb173-speed-slots.json"), JSON.stringify({ base: BASE, failed, evidence, series }, null, 2));
  console.log("pb173 speed slots: " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  process.exit(failed ? 1 : 0);
}
