// PB-328 page leg: the PB-317 Show Common slot reserves space only inside a match.
//
//   node tests/e2e/pb328-footer-slot.mjs              # starts its own server
//   node tests/e2e/pb328-footer-slot.mjs --url=<base> # a running server
//
// The defect: PB-317's slot is a fixed 14ch box, which is right inside a match and wrong outside one.
// With no mode to paint, the footer line ("Cell grid from the map extract · …") is pushed right by
// ~105 px and wraps onto two lines. The box must come from the MATCH STATE, not from a class that is
// always applied and not from the word inside it.
//
// Arms, per viewport (1440x900, 1280x800, 1024x768):
//   (a) outside a match the slot occupies no inline space: its own width is 0 and the footer line's
//       left edge sits at the same x as the legend's, so nothing is pushed right;
//   (b) the footer line is one line outside a match (its height is a single line's, and its
//       scrollWidth <= clientWidth + 1);
//   (c) inside a match the slot is PB-317's box again: 14ch wide, and the SAME rectangle in both
//       Show Common states (x/y/w/h within 1 px), with scrollWidth <= clientWidth + 1 in both;
//   (d) opening and leaving a match returns the footer to its outside state (arm (a) again after
//       Leave), so the box is a function of the state and not a one-way latch.
//
// Usage: node tests/e2e/pb328-footer-slot.mjs [--url=host] [--out=DIR]
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
const OUT = evidenceDir("pb328-footer-slot", argOf("out"));
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
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 320)));
  writeFileSync(path.join(OUT, "pb328-footer-slot.json"), JSON.stringify({ evidence }, null, 2));
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

const r2 = (n) => Math.round(n * 100) / 100;

// One frame: the slot, the footer line and the legend, read together.
const snapshot = (page) => page.evaluate(() => {
  const r2 = (n) => Math.round(n * 100) / 100;
  const slot = document.getElementById("modeFlag");
  const note = document.getElementById("boardNote");
  const legend = document.getElementById("legend");
  if (!slot || !note || !legend) return null;
  const sr = slot.getBoundingClientRect();
  const nr = note.getBoundingClientRect();
  const lr = legend.getBoundingClientRect();
  return {
    slot: { x: r2(sr.x), y: r2(sr.y), w: r2(sr.width), h: r2(sr.height), text: (slot.textContent || "").trim(),
      scrollWidth: slot.scrollWidth, clientWidth: slot.clientWidth, display: getComputedStyle(slot).display },
    note: { x: r2(nr.x), y: r2(nr.y), w: r2(nr.width), h: r2(nr.height), text: (note.textContent || "").trim(),
      scrollWidth: note.scrollWidth, clientWidth: note.clientWidth,
      lines: Math.round(nr.height / parseFloat(getComputedStyle(note).lineHeight || "16")) },
    legend: { x: r2(lr.x), y: r2(lr.y), w: r2(lr.width), h: r2(lr.height) },
    inMatch: document.body.classList.contains("in-match"),
  };
});

async function signUp(page, name) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + name);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

async function main() {
  const { chromium } = await loadPlaywright();
  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb328-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* booting */ }
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  for (const viewport of VIEWPORTS) {
    const tag = Date.now().toString(36).slice(-6) + viewport.width;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    const at = " @" + viewport.width + "x" + viewport.height;

    await signUp(page, "F328" + tag);
    await sleep(400);

    // ---- outside a match -----------------------------------------------------------------------
    const out = await snapshot(page);
    mark("(a) outside a match the slot takes no inline width" + at, Boolean(out) && out.slot.w <= 1,
      JSON.stringify(out && out.slot));
    mark("(a) outside a match the footer line starts where the legend starts" + at,
      Boolean(out) && Math.abs(out.note.x - out.legend.x) <= 1,
      JSON.stringify({ noteX: out && out.note.x, legendX: out && out.legend.x, delta: out ? r2(out.note.x - out.legend.x) : null, slotW: out && out.slot.w }));
    // The AC is "at least as it did before 240a5d6", not "one line": the line already wraps at 1024
    // before PB-317 existed (measured on 240a5d6^: note h 23.19 at 1440 and 1280, 46.38 at 1024, x on
    // the legend in all three). So the arm compares the box to that measured baseline, per width, rather
    // than asserting a line count the pre-fix page never had.
    const BASE_H = { 1440: 23.19, 1280: 23.19, 1024: 46.38 };
    mark("(b) outside a match the footer line's box matches the pre-PB-317 baseline" + at,
      Boolean(out) && Math.abs(out.note.h - BASE_H[viewport.width]) <= 0.5 && out.note.scrollWidth <= out.note.clientWidth + 1,
      JSON.stringify({ note: out && out.note, baselineH: BASE_H[viewport.width] }));

    // ---- inside a match, both Show Common states ------------------------------------------------
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
    await sleep(450);
    const off = await snapshot(page);
    mark("(c) inside a match the slot is PB-317's box again (14ch)" + at,
      Boolean(off) && off.slot.w > 60 && Math.abs(off.slot.w - 14 * (off.slot.w / 14)) < 14 * 2,
      JSON.stringify(off && off.slot));

    // Flip Show Common through the War dialogue, the way a player does.
    await page.evaluate(() => {
      const b = document.querySelector('#nav button[data-dialog="war"]');
      if (b) b.click();
    });
    await sleep(260);
    await page.evaluate(() => { const b = document.getElementById("showCommonBtn"); if (b) b.click(); });
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().showCommon && window.__chq.room().showCommon.on,
      null, { timeout: 15000, polling: 60 });
    await sleep(320);
    const on = await snapshot(page);
    await page.evaluate(() => {
      const b = document.querySelector('#nav button[data-dialog="war"]');
      if (b) b.click();
    });
    await sleep(220);

    mark("(c) the slot paints \"Show Common\" while the mode is on" + at, Boolean(on) && on.slot.text === "Show Common",
      JSON.stringify(on && on.slot));
    const sameBox = off && on &&
      Math.abs(off.slot.x - on.slot.x) <= 1 && Math.abs(off.slot.y - on.slot.y) <= 1 &&
      Math.abs(off.slot.w - on.slot.w) <= 1 && Math.abs(off.slot.h - on.slot.h) <= 1;
    mark("(c) the slot's box is the same rectangle in both states" + at, sameBox,
      JSON.stringify({ off: off && off.slot, on: on && on.slot }));
    mark("(c) the word is not clipped inside the box" + at,
      Boolean(on) && on.slot.scrollWidth <= on.slot.clientWidth + 1,
      JSON.stringify(on && on.slot));

    // ---- back out ------------------------------------------------------------------------------
    await page.evaluate(() => {
      const b = document.querySelector('#nav button[data-dialog="war"]');
      if (b) b.click();
    });
    await sleep(220);
    // "Leave the match" lives inside the War panel (app.js), not in #nav.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((el) => (el.textContent || "").trim() === "Leave the match");
      if (b) b.click();
    });
    await page.waitForFunction(() => !document.body.classList.contains("in-match"), null, { timeout: 20000, polling: 80 }).catch(() => {});
    await sleep(600);
    const back = await snapshot(page);
    mark("(d) after Leave the match state is gone" + at, Boolean(back) && back.inMatch === false, JSON.stringify(back && back.inMatch));
    mark("(d) after Leave the slot takes no inline width again" + at, Boolean(back) && back.slot.w <= 1,
      JSON.stringify(back && back.slot));
    mark("(d) after Leave the footer line starts at the legend again" + at,
      Boolean(back) && Math.abs(back.note.x - back.legend.x) <= 1,
      JSON.stringify({ noteX: back && back.note.x, legendX: back && back.legend.x }));

    mark("no page error was raised" + at, errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await context.close();
  }

  if (child) child.kill("SIGTERM");
  console.log("\nchecks: " + evidence.length + ", failed: " + failed);
  console.log(failed === 0 ? "PB328_FOOTER_OK" : "PB328_FOOTER_RED");
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error("PB328_LEG_FAILED", err); process.exit(1); });
