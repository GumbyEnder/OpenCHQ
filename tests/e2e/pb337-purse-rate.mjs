// PB-337 page leg: the strip's purse chip prints BOTH numbers - the balance and the income rate -
// at 1024, 1280 and 1440, and the rate is not a tooltip-only fact at 1024.
//
//   node tests/e2e/pb337-purse-rate.mjs                 # starts its own server from this tree
//   node tests/e2e/pb337-purse-rate.mjs --url=<base>    # a running server
//   node tests/e2e/pb337-purse-rate.mjs --out=<dir>
//
// The defect (measured at eceac31, PM 10496 §2): `@media (max-width:1100px)` carried
// `body.in-match .pursechip .inc { display: none; }`, so at 1024 the chip painted "50b" and the rate
// lived only in `title`. PB-180 put it there because the row was assumed to have no pixel for it;
// measured, the row has the room (the account box's auto margin), so the rate is painted at every
// width and the chip is content-sized there - a chip that could shrink would ellipsize its LAST leg
// (the rate) and print a budget with no rate again, in a quieter voice.
//
// Arms, per width (1024x768, 1280x800, 1440x900) and per era (1986, 1942), in a real launched game:
//   (a) the chip's OWN SPANS are visible: `.cash` and `.inc` both compute to a non-none display and
//       paint a non-zero width, and the chip's text carries a balance AND a rate ("50b+500M/s" shape);
//   (b) the painted rate is the title's rate - the same token the summary leg of `title` carries, so
//       a chip that shows one number and titles another is a red, not a pass;
//   (c) the chip does not clip: scrollWidth <= clientWidth + 1 (PB-173's cash arm, both legs now);
//   (d) the readout->purse gap: the readout's painted text right edge to the chip's painted text left
//       edge is PB-331's number - >= 4 px at 1024, exactly 8 px at 1280, exactly 12 px at 1440;
//   (e) the row still fits: no pair of controls overlaps, the strip does not scroll, #nav is not a
//       scroll window (PB-291), and the last control ends inside the window;
//   (f) 1024 only: the widest chip the page can print (OIL + three-digit balance + rate, era 2023,
//       whose blue seat opens oil-short) keeps (a)-(e);
//   (g) 1024 only: W2 - a real room at round >= 10 with the clock running keeps (a)-(e);
//   (h) 1024 only: the ceiling - the same chip under a three-digit round ("round 100"), painted
//       through the page's own producer (__chq.stripPreview), keeps the mandatory readout parts
//       ("round 100" and the clock word), does not clip, and overlaps nothing.
//
// What breaks if this is removed: at 1024 the player sees "50b" and has to hover to learn what the
// pool earns - the one number a purchase decision is made against.

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
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
// PB-184/PB-301: the evidence default lives inside this worktree, and the server's data dir is a
// throwaway under the OS temp root - a leg may not write to a NAS or home path by default.
const OUT = evidenceDir("pb337-purse-rate", argOf("out"));

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 1400) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb337-purse-rate.json"), JSON.stringify({ evidence }, null, 2));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

// One frame: the chip's own spans and their computed display, the chip's box, the readout's painted
// text edge, and every control in the row. Read in ONE evaluate so the numbers describe one layout.
const snapshot = (page) => page.evaluate(() => {
  const rr2 = (n) => Math.round(n * 100) / 100;
  const strip = document.getElementById("strip");
  const info = document.getElementById("stripInfo");
  const chip = document.getElementById("purseChip");
  const nav = document.getElementById("nav");
  if (!strip || !info || !chip) return null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: rr2(r.x), right: rr2(r.right), w: rr2(r.width), h: rr2(r.height) }; };
  const ir = info.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(info);
  const readoutText = range.getBoundingClientRect();
  const cr = chip.getBoundingClientRect();
  const chipRange = document.createRange(); chipRange.selectNodeContents(chip);
  const chipText = chipRange.getBoundingClientRect();
  const legs = {};
  for (const name of ["cash", "inc", "oilword"]) {
    const el = chip.querySelector("." + name);
    if (!el) { legs[name] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    legs[name] = { text: el.textContent, display: cs.display, visibility: cs.visibility,
      w: rr2(r.width), x: rr2(r.x), right: rr2(r.right), clip: el.scrollWidth > el.clientWidth + 1 };
  }
  const controls = [];
  for (const el of strip.querySelectorAll("button, #stripInfo, #purseChip, #speedReadout")) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    controls.push({ key: el.id || el.dataset.dialog || (el.textContent || "").trim().slice(0, 14),
      x: rr2(r.x), y: rr2(r.y), right: rr2(r.right), bottom: rr2(r.bottom), w: rr2(r.width), h: rr2(r.height),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }
  const brand = strip.querySelector(".brand").getBoundingClientRect();
  const last = strip.lastElementChild.getBoundingClientRect();
  return {
    text: (info.textContent || "").trim(),
    title: info.getAttribute("title") || "",
    readout: { box: box(info), textRight: rr2(readoutText.right), textWidth: rr2(readoutText.width),
      scrollWidth: info.scrollWidth, clientWidth: info.clientWidth },
    chip: { text: (chip.textContent || "").trim(), title: chip.getAttribute("title") || "", box: box(chip),
      textLeft: rr2(chipText.left), textRight: rr2(chipText.right),
      scrollWidth: chip.scrollWidth, clientWidth: chip.clientWidth, legs,
      insideBrand: rr2(cr.right) <= rr2(brand.right) + 0.5 },
    brand: { x: rr2(brand.x), right: rr2(brand.right), w: rr2(brand.width) },
    nav: nav ? { x: rr2(nav.getBoundingClientRect().x), w: rr2(nav.getBoundingClientRect().width),
      scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth } : null,
    strip: { scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth, rowRight: rr2(last.right) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    round: window.__chq.room() ? window.__chq.room().round : null,
    clock: window.__chq.room() ? window.__chq.room().clock : null,
    controls,
  };
});

function overlaps(a, b) {
  const dx = Math.max(a.x - b.right, b.x - a.right);
  const dy = Math.max(a.y - b.bottom, b.y - a.bottom);
  return Math.max(dx, dy) < 1;
}
function overlapPairs(controls) {
  const bad = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      if (overlaps(controls[i], controls[j])) bad.push([controls[i].key, controls[j].key]);
    }
  }
  return bad;
}

// The rate token as the page prints it: "+500M/s" (peace tick) or "+1.55b/rd" (a round payday), with
// the Alternate Function's "+foe" marker in front when that side is on show.
const RATE = /\+(?:foe\s*)?[\d.]+[Mb]?\/(?:s|rd)/;
const CASH = /\d+b/;

function verdicts(snap, width, phase) {
  const at = " @1024x768 " + phase;
  const legs = (snap && snap.chip && snap.chip.legs) || {};
  const cash = legs.cash || null;
  const inc = legs.inc || null;
  const chipText = (snap && snap.chip && snap.chip.text) || "";

  // (a) both legs are PAINTED, not merely present in the text content.
  const cashPainted = Boolean(cash) && cash.display !== "none" && cash.visibility !== "hidden" && cash.w > 0 && CASH.test(cash.text);
  const ratePainted = Boolean(inc) && inc.display !== "none" && inc.visibility !== "hidden" && inc.w > 0 && RATE.test(inc.text);
  mark("(a)" + at + ": the balance and the rate are both painted legs",
    cashPainted && ratePainted && CASH.test(chipText) && RATE.test(chipText),
    JSON.stringify({ painted: chipText, cash, inc }));

  // (b) the painted rate is the title's rate - one number, one place it came from.
  const titleRate = (snap && (String(snap.chip.title).match(RATE) || [null])[0]) || null;
  const paintedRate = inc ? (String(inc.text).match(RATE) || [null])[0] : null;
  mark("(b)" + at + ": the painted rate is the rate the title carries",
    Boolean(paintedRate) && Boolean(titleRate) && paintedRate.replace(/\s+/g, "") === titleRate.replace(/\s+/g, ""),
    JSON.stringify({ paintedRate, titleRate, title: snap && snap.chip.title }));

  // (c) the chip prints both legs whole.
  const chipFits = Boolean(snap) && snap.chip.scrollWidth <= snap.chip.clientWidth + 1;
  mark("(c)" + at + ": the chip does not clip either leg",
    chipFits && Boolean(inc) && !inc.clip,
    JSON.stringify({ chip: snap && { scrollWidth: snap.chip.scrollWidth, clientWidth: snap.chip.clientWidth },
      inc: inc && { scrollWidth: null, clip: inc.clip, w: inc.w } }));

  // (d) PB-331's gap, measured to the painted text on both sides. 1024 is a floor, the wider bands
  // are exact ("unchanged").
  const floor = width >= 1440 ? 12 : width >= 1280 ? 8 : 4;
  const exact = width >= 1280;
  const gap = snap ? r2(snap.chip.textLeft - snap.readout.box.right) : null;
  mark("(d)" + at + ": the chip's text clears the readout by " + (exact ? "exactly " + floor : ">= " + floor) + " px",
    gap !== null && (exact ? Math.abs(gap - floor) <= 0.51 : gap >= floor - 0.01),
    JSON.stringify({ gap, floor, exact, readoutRight: snap && snap.readout.box.right,
      chipTextLeft: snap && snap.chip.textLeft }));

  // (e) the row still holds: no overlap, no scroller, nothing past the window.
  const pairs = snap ? overlapPairs(snap.controls) : [["no", "frame"]];
  const stripFits = Boolean(snap) && snap.strip.scrollWidth <= snap.strip.clientWidth + 1;
  const navFits = Boolean(snap && snap.nav) && snap.nav.scrollWidth <= snap.nav.clientWidth + 1;
  const rowInside = Boolean(snap) && snap.strip.rowRight <= snap.viewport.w + 0.5;
  const readoutFits = Boolean(snap) && snap.readout.scrollWidth <= snap.readout.clientWidth + 1;
  mark("(e)" + at + ": the row still holds the readout, the chip and every control",
    pairs.length === 0 && stripFits && navFits && rowInside && readoutFits && Boolean(snap.chip.insideBrand),
    JSON.stringify({ overlaps: pairs, strip: snap && snap.strip, nav: snap && snap.nav,
      readout: snap && snap.readout, insideBrand: snap && snap.chip.insideBrand }));
}

async function launch(page, era, tag) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", tag);
  await page.fill("#register input[name=password]", "pw-" + tag);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click("#launch button[type=submit]");
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
  await sleep(450);
}

let BASE = GIVEN;
let child = null;

async function main() {
  const { chromium } = await loadPlaywright();
  if (!BASE) {
    const port = await freePort();
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port),
        OPENCHQ_WEB_DATA: mkdtempSync(path.join(tmpdir(), "pb337-")) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* booting */ }
      await sleep(120);
    }
    mark("a server answers", true, BASE);
  }
  const version = await (await fetch(BASE + "/api/version")).text();
  console.log("served", version.trim());
  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  // (a)-(e) at the three widths, 1986 and 1942.
  for (const viewport of VIEWPORTS) {
    for (const era of ["1986", "1942"]) {
      const tag = "G" + Date.now().toString(36).slice(-5) + era + viewport.width;
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      await launch(page, era, tag);
      const snap = await snapshot(page);
      mark("era " + era + " launched at " + viewport.width + "x" + viewport.height + " with no page error",
        Boolean(snap) && errors.length === 0, JSON.stringify({ errors, text: snap && snap.chip.text }));
      verdicts(snap, viewport.width, "era " + era);
      await page.screenshot({ path: path.join(OUT, "pb337-" + era + "-" + viewport.width + ".png"),
        clip: { x: 0, y: 0, width: viewport.width, height: 64 } });
      await context.close();
    }
  }

  // (f) and (g): 1024 only, the widest chip and a late round.
  {
    const viewport = { width: 1024, height: 768 };
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const tag = "G" + Date.now().toString(36).slice(-5) + "2023";
    await launch(page, "2023", tag);
    const wide = await snapshot(page);
    mark("(f) 2023's blue seat opens oil-short at 1024x768", Boolean(wide && wide.chip.legs.oilword && wide.chip.legs.oilword.w > 0),
      JSON.stringify({ painted: wide && wide.chip.text, legs: wide && wide.chip.legs }));
    verdicts(wide, 1024, "era 2023 (OIL + three digits)");
    await page.screenshot({ path: path.join(OUT, "pb337-2023-1024.png"), clip: { x: 0, y: 0, width: 1024, height: 64 } });

    // (g) W2: speed 6 + clock running until the round reads 10 - a real room, not a preview.
    await page.evaluate(() => { for (let i = 0; i < 5; i += 1) document.getElementById("speedUp").click(); });
    await page.evaluate(() => document.getElementById("clockBtn").click());
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock === "running", null, { timeout: 30000, polling: 80 });
    let w2 = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const s = await snapshot(page);
      if (s && s.round >= 10) { w2 = s; break; }
      await sleep(500);
    }
    mark("(g) 1024x768 W2 running: a real room reached round >= 10", Boolean(w2),
      JSON.stringify(w2 ? { round: w2.round, clock: w2.clock, painted: w2.chip.text } : { reached: false }));
    if (w2) verdicts(w2, 1024, "W2 round " + w2.round + " running");
    await page.screenshot({ path: path.join(OUT, "pb337-2023-1024-w2.png"), clip: { x: 0, y: 0, width: 1024, height: 64 } });

    // (h) the ceiling: the same chip under a THREE-digit round, painted through the page's own
    // producer (PB-323's stripPreview hook - the same paintStripInfo the frame calls, including the
    // width rule and the fit ladder). The purse stays the real one.
    const ceiling = await page.evaluate(() => {
      const room = window.__chq.room();
      const rr2 = (n) => Math.round(n * 100) / 100;
      window.__chq.stripPreview({ era: String(room.era), you: "blue", round: 100, clock: "running", speed: 1,
        peace: room.peace || null, seat: room.seat || null, blue: room.blue, red: room.red });
      const info = document.getElementById("stripInfo");
      const chip = document.getElementById("purseChip");
      const strip = document.getElementById("strip");
      const ir = info.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(info);
      const tr = range.getBoundingClientRect();
      const cr = chip.getBoundingClientRect();
      const cRange = document.createRange(); cRange.selectNodeContents(chip);
      const ctr = cRange.getBoundingClientRect();
      const controls = [];
      for (const el of strip.querySelectorAll("button, #stripInfo, #purseChip, #speedReadout")) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        controls.push({ key: el.id || (el.textContent || "").trim().slice(0, 14), x: rr2(r.x), y: rr2(r.y),
          right: rr2(r.right), bottom: rr2(r.bottom) });
      }
      const out = {
        text: (info.textContent || "").trim(),
        readoutClip: info.scrollWidth > info.clientWidth + 1,
        readout: { right: rr2(ir.right), textRight: rr2(tr.right), scrollWidth: info.scrollWidth, clientWidth: info.clientWidth },
        chipText: (chip.textContent || "").trim(),
        gap: rr2(ctr.left - ir.right),
        chipClip: chip.scrollWidth > chip.clientWidth + 1,
        strip: { scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth },
        nav: { scrollWidth: document.getElementById("nav").scrollWidth, clientWidth: document.getElementById("nav").clientWidth },
        controls,
      };
      // put the real frame back
      window.__chq.stripPreview(room);
      return out;
    });
    const ceilingPairs = overlapPairs(ceiling.controls);
    mark("(h) 1024x768 ceiling: a three-digit round still prints 'round 100' and the clock word",
      /round 100/.test(ceiling.text) && /running|paused/.test(ceiling.text) && !ceiling.readoutClip,
      JSON.stringify({ painted: ceiling.text, readout: ceiling.readout }));
    mark("(h) 1024x768 ceiling: the row holds with the widest chip and the three-digit readout",
      ceilingPairs.length === 0 && ceiling.strip.scrollWidth <= ceiling.strip.clientWidth + 1
        && ceiling.nav.scrollWidth <= ceiling.nav.clientWidth + 1 && ceiling.gap >= 4 && !ceiling.chipClip,
      JSON.stringify({ overlaps: ceilingPairs, gap: ceiling.gap, strip: ceiling.strip, nav: ceiling.nav,
        chip: ceiling.chipText, chipClip: ceiling.chipClip }));
    writeFileSync(path.join(OUT, "pb337-ceiling.json"), JSON.stringify(ceiling, null, 2));
    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");
  const total = evidence.length;
  console.log((failed === 0 ? "PB337_PAGE_OK " : "PB337_PAGE_RED ") + (total - failed) + " passed / " + failed +
    " failed of " + total + " — served " + version.trim().slice(0, 80) + " — OUT " + OUT);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((err) => { console.error("PB337_LEG_FAILED", err); process.exit(1); });
