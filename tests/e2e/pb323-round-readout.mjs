// PB-323 page leg: the strip's round readout is visible at every width.
//
//   node tests/e2e/pb323-round-readout.mjs                 # starts its own server
//   node tests/e2e/pb323-round-readout.mjs --url=<base>    # a running server
//   node tests/e2e/pb323-round-readout.mjs --out=<dir>
//
// The defect (measured at live 2e7b2ed, game row 10209): `#stripInfo` painted "1942 · blue ·" at
// 1280x800 and 1024x768 - the round number and the clock word were behind an ellipsis - and at
// 1440x900 it was 10 px narrower than its own text. PM 10211 §2 makes the round number and the
// clock word mandatory at every width and lets era/side shorten; frodo 10223 §2 fixes the assertion
// shape (substring presence in priority order, never textContent equality) and adds the fractional
// arm because clientWidth rounds while scrollWidth ceils.
//
// Arms, per viewport (1440x900, 1280x800, 1024x768), in each clock state (held, running):
//   (a)  the readout's text contains "round <n>" and the clock word, and its box does not clip:
//        scrollWidth <= clientWidth + 1;
//   (a') the Range arm: the text's own right edge <= the element's right edge + 0.5, and the
//        fractional text width <= the box's content width + 0.5. The detail prints range.right,
//        el.right, delta, scrollWidth, clientWidth and the text, so a red names the arm that fired;
//   (b)  a pairwise rect matrix over every control in the strip row: no overlap, >= 1 px apart,
//        with Clock x purseChip named explicitly at 1280 (0.72 px there before the fix);
//   (d)  Paths and Satellites are reachable in one click at every width, and toggle back;
//   (e)  a clock-word change moves no control (x/y within 1 px), and the strip stays one row.
//
// What breaks if this is removed: at 1024x768 the player is shown the era and the side of a war whose
// round number and clock state are off the edge of the row - the two facts the original puts on its
// monitor line.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
const OUT = evidenceDir("pb323-round-readout", argOf("out"));
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 1200) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb323-round-readout.json"), JSON.stringify({ evidence }, null, 2));
}

let BASE = "";
let child = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

// One snapshot: the readout's text and both fit measures, plus every control's rect in the strip.
// Read in ONE evaluate so the numbers describe a single frame.
const snapshot = (page) => page.evaluate(() => {
  const round2 = (n) => Math.round(n * 100) / 100;
  const strip = document.getElementById("strip");
  const info = document.getElementById("stripInfo");
  if (!strip || !info) return null;
  const ir = info.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(info);
  const rr = range.getBoundingClientRect();
  const cs = getComputedStyle(info);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const controls = [];
  for (const el of strip.querySelectorAll("button, #stripInfo, #purseChip, #speedReadout")) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    controls.push({
      key: el.id || el.dataset.dialog || (el.textContent || "").trim().slice(0, 14),
      x: round2(r.x), y: round2(r.y), right: round2(r.right), bottom: round2(r.bottom),
      w: round2(r.width), h: round2(r.height),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    });
  }
  const nav = document.getElementById("nav");
  const nr = nav ? nav.getBoundingClientRect() : null;
  return {
    text: (info.textContent || "").trim(),
    box: { x: round2(ir.x), y: round2(ir.y), right: round2(ir.right), bottom: round2(ir.bottom), w: round2(ir.width), h: round2(ir.height) },
    range: { left: round2(rr.left), right: round2(rr.right), width: round2(rr.width) },
    scrollWidth: info.scrollWidth,
    clientWidth: info.clientWidth,
    contentWidth: round2(ir.width - pad),
    overflow: cs.overflow,
    whitespace: cs.whiteSpace,
    strip: { x: round2(strip.getBoundingClientRect().x), right: round2(strip.getBoundingClientRect().right), h: round2(strip.getBoundingClientRect().height) },
    nav: nav ? { x: round2(nr.x), right: round2(nr.right), scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth } : null,
    controls,
    clock: window.__chq.room() ? window.__chq.room().clock : null,
    speed: window.__chq.room() ? window.__chq.room().speed : null,
    round: window.__chq.room() ? window.__chq.room().round : null,
  };
});

// (a) + (a') as one verdict pair, with every number a red needs to name the arm.
function readoutFit(snap) {
  const integerOk = Boolean(snap) && snap.scrollWidth <= snap.clientWidth + 1;
  const rangeOk = Boolean(snap) &&
    snap.range.right <= snap.box.right + 0.5 &&
    snap.range.width <= snap.contentWidth + 0.5;
  return { integerOk, rangeOk };
}

function overlaps(a, b) {
  const dx = Math.max(a.x - b.right, b.x - a.right);
  const dy = Math.max(a.y - b.bottom, b.y - a.bottom);
  return { dx: round2(dx), dy: round2(dy), clear: Math.max(dx, dy) >= 1 };
}

// (b) the pairwise matrix. Names every colliding pair, not the first one.
function rectMatrix(controls) {
  const bad = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const gap = overlaps(controls[i], controls[j]);
      if (!gap.clear) bad.push({ a: controls[i].key, b: controls[j].key, dx: gap.dx, dy: gap.dy });
    }
  }
  return bad;
}

const pairGap = (controls, ka, kb) => {
  const a = controls.find((c) => c.key === ka);
  const b = controls.find((c) => c.key === kb);
  if (!a || !b) return null;
  return overlaps(a, b);
};

const movedControls = (before, after, tol = 1) => {
  const byKey = new Map(after.map((c) => [c.key, c]));
  const moved = [];
  for (const a of before) {
    const b = byKey.get(a.key);
    if (!b) { moved.push({ key: a.key, why: "gone" }); continue; }
    if (Math.abs(a.x - b.x) > tol || Math.abs(a.y - b.y) > tol) {
      moved.push({ key: a.key, dx: round2(b.x - a.x), dy: round2(b.y - a.y) });
    }
  }
  return moved;
};

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

async function pressClock(page, want) {
  await page.evaluate(() => {
    const button = document.getElementById("clockBtn");
    if (button) button.click();
  });
  await page.waitForFunction((state) => {
    const room = window.__chq.room();
    return Boolean(room) && room.clock === state;
  }, want, { timeout: 25000, polling: 80 });
  await sleep(350);
}

async function main() {
  const { chromium } = await loadPlaywright();

  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb323-page-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* still booting */ }
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    const tag = Date.now().toString(36).slice(-5) + viewport.width;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    const at = " @" + viewport.width + "x" + viewport.height;

    await signIn(page, "P323" + tag, "pw-323-" + tag);
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot",
      null, { timeout: 30000, polling: 100 });
    await sleep(400);
    mark("a solo 1942 war is open" + at, true, await page.evaluate(() => "room " + window.__chq.room().id));

    // ---- held state ---------------------------------------------------------------------------
    const held = await snapshot(page);
    const heldFit = readoutFit(held);
    mark("(a) held: the readout names the round" + at, /round\s+\d+/.test(held.text), JSON.stringify(held.text));
    mark("(a) held: the readout names the clock word" + at, /\b(held|running|paused)\b/.test(held.text), JSON.stringify(held.text));
    mark("(a) held: no clip (scrollWidth <= clientWidth + 1)" + at, heldFit.integerOk,
      JSON.stringify({ scrollWidth: held.scrollWidth, clientWidth: held.clientWidth, text: held.text }));
    mark("(a') held: the text ends inside the box (fractional arm)" + at, heldFit.rangeOk,
      JSON.stringify({ rangeRight: held.range.right, elRight: held.box.right, delta: round2(held.range.right - held.box.right), rangeWidth: held.range.width, contentWidth: held.contentWidth, scrollWidth: held.scrollWidth, clientWidth: held.clientWidth, text: held.text }));
    const heldBad = rectMatrix(held.controls);
    mark("(b) held: every control in the row is >= 1 px clear of every other" + at, heldBad.length === 0,
      JSON.stringify({ controls: held.controls.length, collisions: heldBad.slice(0, 6) }));
    if (viewport.width === 1280) {
      const gap = pairGap(held.controls, "clockBtn", "purseChip");
      mark("(b) Clock x purseChip at 1280" + at, Boolean(gap) && gap.clear, JSON.stringify(gap));
    }
    mark("(a) held: the command cluster is not a scroll window" + at,
      Boolean(held.nav) && held.nav.scrollWidth <= held.nav.clientWidth + 1,
      JSON.stringify(held.nav));

    // ---- (d) Paths and Satellites, one click each ---------------------------------------------
    for (const label of ["Paths", "Satellites"]) {
      const found = await page.evaluate((want) => {
        const button = Array.from(document.querySelectorAll("#nav button"))
          .find((el) => (el.textContent || "").trim().startsWith(want));
        if (!button) return null;
        const r = button.getBoundingClientRect();
        return { text: (button.textContent || "").trim(), x: Math.round(r.x), w: Math.round(r.width), pressed: button.getAttribute("aria-pressed") };
      }, label);
      mark("(d) the " + label + " control is on screen" + at, Boolean(found) && found.w > 8, JSON.stringify(found));
      const toggled = await page.evaluate((want) => {
        const button = Array.from(document.querySelectorAll("#nav button"))
          .find((el) => (el.textContent || "").trim().startsWith(want));
        if (!button) return null;
        button.click();
        return button.getAttribute("aria-pressed");
      }, label);
      await sleep(260);
      const after = await page.evaluate((want) => {
        const button = Array.from(document.querySelectorAll("#nav button"))
          .find((el) => (el.textContent || "").trim().startsWith(want));
        return button ? button.getAttribute("aria-pressed") : null;
      }, label);
      mark("(d) one click toggles " + label + " on" + at, toggled === "true" && after === "true",
        JSON.stringify({ clicked: toggled, settled: after }));
      await page.evaluate((want) => {
        const button = Array.from(document.querySelectorAll("#nav button"))
          .find((el) => (el.textContent || "").trim().startsWith(want));
        if (button) button.click();
      }, label);
      await sleep(200);
      const back = await page.evaluate((want) => {
        const button = Array.from(document.querySelectorAll("#nav button"))
          .find((el) => (el.textContent || "").trim().startsWith(want));
        return button ? button.getAttribute("aria-pressed") : null;
      }, label);
      mark("(d) one more click toggles " + label + " off" + at, back === "false", JSON.stringify(back));
    }

    // ---- running state: (a), (a'), (e) --------------------------------------------------------
    const beforePlay = await snapshot(page);
    await pressClock(page, "running");
    const running = await snapshot(page);
    const runFit = readoutFit(running);
    mark("(a) running: the readout names the round" + at, /round\s+\d+/.test(running.text), JSON.stringify(running.text));
    mark("(a) running: the clock word is \"running\"" + at, /\brunning\b/.test(running.text), JSON.stringify(running.text));
    mark("(a) running: no clip (scrollWidth <= clientWidth + 1)" + at, runFit.integerOk,
      JSON.stringify({ scrollWidth: running.scrollWidth, clientWidth: running.clientWidth, text: running.text }));
    mark("(a') running: the text ends inside the box (fractional arm)" + at, runFit.rangeOk,
      JSON.stringify({ rangeRight: running.range.right, elRight: running.box.right, delta: round2(running.range.right - running.box.right), rangeWidth: running.range.width, contentWidth: running.contentWidth, scrollWidth: running.scrollWidth, clientWidth: running.clientWidth, text: running.text }));
    const runBad = rectMatrix(running.controls);
    mark("(b) running: every control in the row is >= 1 px clear of every other" + at, runBad.length === 0,
      JSON.stringify({ controls: running.controls.length, collisions: runBad.slice(0, 6) }));
    const moved = movedControls(beforePlay.controls, running.controls);
    mark("(e) the clock-word change moved no control (x/y within 1 px)" + at, moved.length === 0,
      JSON.stringify({ moved }));
    mark("(e) the strip stayed one row of the same height" + at,
      Math.abs(running.strip.h - beforePlay.strip.h) <= 1 && Math.abs(running.box.y - beforePlay.box.y) <= 1,
      JSON.stringify({ held: { h: beforePlay.strip.h, y: beforePlay.box.y }, running: { h: running.strip.h, y: running.box.y } }));

    // ---- paused state (speed 0 with the clock running prints "paused") -----------------------
    mark("(a) the clock read read back as running" + at, running.clock === "running", JSON.stringify(running.clock));

    // ---- (a) also the longest era the strip can print ---------------------------------------
    // A Concealed-year war is the widest line the strip ever shows ("Concealed" is 9 characters
    // where "1942" is 4). It is not a graded state on its own; it is the margin check that the fix
    // is a row budget and not a 1942-sized slot.
    const concealed = await page.evaluate(() => {
      const info = document.getElementById("stripInfo");
      if (!info) return null;
      const room = window.__chq.room();
      if (typeof window.__chq.stripPreview !== "function") return { skipped: true };
      // The page's own producer with a Concealed room: the same parts, the same DOM shape, the same
      // slot. The restore call is the frame's own path, not a string kept from before.
      window.__chq.stripPreview({ ...room, era: "9999", round: 12 });
      const now = document.getElementById("stripInfo");
      const range = document.createRange();
      range.selectNodeContents(now);
      const rr = range.getBoundingClientRect();
      const ir = now.getBoundingClientRect();
      const out = { text: (now.textContent || "").trim(), rangeWidth: Math.round(rr.width * 100) / 100, right: Math.round(rr.right * 100) / 100, boxRight: Math.round(ir.right * 100) / 100, scrollWidth: now.scrollWidth, clientWidth: now.clientWidth };
      window.__chq.stripPreview(room);
      return out;
    });
    if (concealed && !concealed.skipped) {
      mark("(a) the widest era line also fits (Concealed, running)" + at,
        concealed.scrollWidth <= concealed.clientWidth + 1 && concealed.right <= concealed.boxRight + 0.5,
        JSON.stringify(concealed));
    } else {
      mark("(a) the widest era line was sampled through the page's own producer" + at, false,
        "the page exposes no stripPreview hook; the leg refuses to grade a string it composed itself");
    }

    mark("no page error was raised" + at, errors.length === 0, JSON.stringify(errors.slice(0, 4)));
    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");

  const total = evidence.length;
  console.log("");
  console.log("checks: " + total + ", failed: " + failed);
  console.log(failed === 0 ? "PB323_PAGE_OK" : "PB323_PAGE_RED");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log("FAIL the leg threw — " + String(err && err.stack || err));
  process.exit(1);
});
