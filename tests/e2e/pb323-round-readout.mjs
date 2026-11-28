// PB-323 page leg: the strip's round readout is visible at every width, in every era it can print.
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
// PB-323b (frodo 10324 §1): this leg used to launch era "1942" only at every viewport, so no 3-wide
// era line was ever sampled by the width arms, and its one "widest era line" arm previewed the 9999
// "Concealed" string instead. The 1986 cold-war line is the widest the strip actually prints
// ("1986 · blue · round 0 · held · cold war, war may resume", 318.88 px) and it clipped at 1280 and
// 1024 on live 30a4275. So EVERY width arm now LAUNCHES 1986 in a real game, and 1942 rides beside
// it as the narrow control. The 9999 preview arm is deleted: a preview of a string the page cannot
// be in is not coverage. The full sentence stays in the element's title on every tier, and arm (f)
// grades that, so a line that shortens to fit is distinguishable from one that lost information.
//
// Arms, per era (1986, 1942) and per viewport (1440x900, 1280x800, 1024x768), in each clock state
// (held, running):
//   (a)  the readout's text contains "round <n>" and the clock word, names the era first and the
//        side second, and its box does not clip: scrollWidth <= clientWidth + 1;
//   (a') the Range arm: the text's own right edge <= the element's right edge + 0.5, and the
//        fractional text width <= the box's content width + 0.5;
//   (b)  a pairwise rect matrix over every control in the strip row: no overlap, >= 1 px apart,
//        with Clock x purseChip named explicitly at 1280;
//   (d)  Paths and Satellites are reachable in one click at every width, and toggle back;
//   (e)  a clock-word change moves no control (x/y within 1 px), and the strip stays one row;
//   (f)  the full sentence is in the title (title covers text; 1986's title keeps "war may resume"
//        at every width, and the painted line still names "cold war" there).
//   (h)  PB-331: the purse text clears the readout's right edge by the width's own gap - >= 4 px at
//        1024, exactly 8 px at 1280 and exactly 12 px at 1440 ("unchanged" for the two wider bands) -
//        in W1 (round 0) and W2 (round >= 10), held and running, in every era. The defect was 2.00 px
//        at 1024 in every era and both clock states, which is why the strip read "cold war50b".
//
// What breaks if this is removed: at 1024x768 the player is shown the era and the side of a war whose
// round number and clock state are off the edge of the row - the two facts the original puts on its
// monitor line - and a 1986 player in the cold war loses the clause that tells them the war can start.

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
// PM 10334 §4: Concealed is LAUNCHED for real at 1280 and 1024 (an era-9999 room carries no peace
// block, so it cannot print a cold-war suffix; the old preview arm graded a string the page could
// not be in). 1440 is covered by 1986 and 1942 - Concealed is not graded there.
const ERAS = [
  ["1986", VIEWPORTS],
  ["1942", VIEWPORTS],
  ["9999", VIEWPORTS.filter((v) => v.width !== 1440)],
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

// One snapshot: the readout's text, its title, both fit measures, plus every control's rect in the
// strip. Read in ONE evaluate so the numbers describe a single frame.
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
  // PB-331: the purse's own text edge, so the gap is measured to the TEXT and not only to a box
  // that may be wider than what it paints.
  const pu = document.getElementById("purseChip");
  let purse = null;
  if (pu) {
    const pr = pu.getBoundingClientRect();
    const prange = document.createRange();
    prange.selectNodeContents(pu);
    const ptx = prange.getBoundingClientRect();
    purse = { left: round2(pr.left), textLeft: round2(ptx.left), w: round2(pr.width),
      text: (pu.textContent || "").trim(), clipped: pu.scrollWidth > pu.clientWidth + 1 };
  }
  return {
    text: (info.textContent || "").trim(),
    title: info.getAttribute("title") || "",
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
    purse,
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

// PB-331 (PM 10362 §2, 10426 §2): the gap between the readout's right edge and the purse's TEXT.
// The row's own numbers are 4 px at 1024, 8 px at 1280 and 12 px at 1440. The two wider bands are
// graded EXACT because the AC says "unchanged"; the 1024 band is a floor (>= 4) because that row is
// packed to the pixel and a future reclaim may only ever widen it.
function purseGap(snap, width) {
  const floor = width >= 1440 ? 12 : width >= 1280 ? 8 : 4;
  const exact = width >= 1280;
  const gap = snap && snap.purse ? round2(snap.purse.textLeft - snap.box.right) : null;
  const ok = gap !== null && (exact ? Math.abs(gap - floor) <= 0.51 : gap >= floor - 0.01);
  return { ok, gap, floor, exact, purse: snap ? snap.purse || null : null, text: snap ? snap.text : "" };
}

function markPurse(snap, width, phase, at) {
  const g = purseGap(snap, width);
  const want = g.exact ? g.floor + " px (exact, unchanged)" : ">= " + g.floor + " px";
  mark("(h) " + phase + ": the purse text clears the readout by " + want + at, g.ok,
    JSON.stringify({ gap: g.gap, floor: g.floor, exact: g.exact, readoutRight: snap ? snap.box.right : null,
      purseTextLeft: g.purse ? g.purse.textLeft : null, purse: g.purse, painted: g.text }));
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

// PM 10342 §2(c) / PM 10348: hand a room to the page's own paintStripInfo (the tier ladder and the
// real row box at THIS viewport), read what it painted, and read the producer's own floor-tier parts
// from the same room. Labelled a producer arm because a capital win needs twelve rounds and cannot be
// reached inside a gate run.
async function probeStrip(page, preview) {
  return page.evaluate((room) => {
    const r2 = (n) => Math.round(n * 100) / 100;
    window.__chq.stripPreview(room);
    const strip = document.getElementById("strip");
    const info = document.getElementById("stripInfo");
    const box = info.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(info);
    const rr = range.getBoundingClientRect();
    const cs = getComputedStyle(info);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const controls = [];
    for (const el of strip.querySelectorAll("button, #stripInfo, #purseChip, #speedReadout")) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      controls.push({ key: el.id || el.dataset.dialog || (el.textContent || "").trim().slice(0, 14),
        x: r2(r.x), y: r2(r.y), right: r2(r.right), bottom: r2(r.bottom),
        w: r2(r.width), h: r2(r.height), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
    const nav = document.getElementById("nav");
    // Real headroom: #stripInfo is a flex item that sizes to its text, so its own box width equals
    // its text width whenever it fits and "rangeRight == boxRight" is true by construction — that
    // is not a measurement of slack. The row gives the element a parent (the brand slot) whose width
    // is what the rest of the row leaves, so the slack is (parent right - info left - text width).
    const parentBox = info.parentElement ? info.parentElement.getBoundingClientRect() : box;
    const out = { text: (info.textContent || "").trim(), title: info.getAttribute("title") || "",
      scrollWidth: info.scrollWidth, clientWidth: info.clientWidth,
      rangeRight: r2(rr.right), boxRight: r2(box.right),
      rangeWidth: r2(rr.width), contentWidth: r2(box.width - pad), controls,
      headroom: r2(parentBox.right - box.left - rr.width),
      nav: nav ? { scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth } : null };
    out.floorParts = (window.__chq.stripParts(room, { width: window.innerWidth, tier: 4 }) || []).map((p) => p.text);
    const real = window.__chq.room();
    if (real) window.__chq.stripPreview(real);
    return out;
  }, preview);
}

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

  for (const [era, viewports] of ERAS) {
    for (const viewport of viewports) {
      const tag = Date.now().toString(36).slice(-5) + era + viewport.width;
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      const at = " @era" + era + " " + viewport.width + "x" + viewport.height;
      const warEra = era === "9999" ? "Concealed" : era;

      await signIn(page, "P323" + tag, "pw-323-" + tag);
      await page.selectOption('#launch select[name="era"]', era);
      await page.selectOption('#launch select[name="side"]', "blue");
      await page.click("#launch button[type=submit]");
      await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot",
        null, { timeout: 30000, polling: 100 });
      await sleep(400);
      mark("a solo " + era + " war is open" + at, true, await page.evaluate(() => "room " + window.__chq.room().id));

      // ---- held state ---------------------------------------------------------------------------
      const held = await snapshot(page);
      const heldFit = readoutFit(held);
      const heldParts = held.text.split(" · ");
      mark("(a) held: the readout names the round" + at, /round\s+\d+/.test(held.text), JSON.stringify(held.text));
      mark("(a) held: the readout names the clock word" + at, /\b(held|running|paused)\b/.test(held.text), JSON.stringify(held.text));
      mark("(a) held: the era is the first part" + at, heldParts[0] === warEra, JSON.stringify(heldParts));
      mark("(a) held: the side is the second part (full or initial)" + at,
        heldParts[1] === "blue" || heldParts[1] === "B", JSON.stringify(heldParts));
      mark("(a) held: the round precedes the clock word" + at,
        heldParts.findIndex((p) => /^round\s+\d+$/.test(p)) < heldParts.findIndex((p) => /^(held|running|paused)$/.test(p)),
        JSON.stringify(heldParts));
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
      // (f) the full sentence is never lost - only its painted copy may shorten to fit.
      mark("(f) held: the title carries the full sentence" + at,
        held.title.length >= held.text.length && (era !== "1986" || held.title.includes("war may resume")),
        JSON.stringify({ title: held.title, text: held.text }));
      if (era === "1986") {
        // The cold war is the state this war is in; the row must still say so after any compaction.
        mark("(f) held: the painted line still names the cold war" + at, held.text.includes("cold war"),
          JSON.stringify(held.text));
      }
      if (era === "1942") {
        // The narrow control: a line that fits must not be compacted by the ladder.
        mark("(f) held: a line that fits is painted whole" + at,
          held.text === "1942 · blue · round 0 · held" && held.title === held.text,
          JSON.stringify({ text: held.text, title: held.title }));
      }

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

      // ---- (h) the purse gap, W1 (round 0) and W2 (round >= 10) --------------------------------
      // PB-331: W1 is the launched round-0 line (widest PAINTED text), W2 is round >= 10 (widest
      // HEAD). Both are real rooms, held and running; the floor is the width's own number.
      markPurse(held, viewport.width, "W1 held", at);
      markPurse(running, viewport.width, "W1 running", at);

      // W2 is reached by playing: speed 6 and the clock running until the round reads 10.
      await page.evaluate(() => { for (let i = 0; i < 5; i += 1) document.getElementById("speedUp").click(); });
      let w2 = null;
      for (const t0 = Date.now(); Date.now() - t0 < 60000;) {
        const s = await snapshot(page);
        if (s && s.round >= 10 && s.clock === "running") { w2 = s; break; }
        await sleep(250);
      }
      mark("(h) W2 running: a real room reached round 10" + at, Boolean(w2),
        JSON.stringify(w2 ? { round: w2.round, speed: w2.speed, painted: w2.text } : { reached: false }));
      if (w2) markPurse(w2, viewport.width, "W2 running", at);
      await page.evaluate(() => document.getElementById("clockBtn").click());
      await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock === "held", null,
        { timeout: 25000, polling: 80 });
      await sleep(350);
      const w2Held = await snapshot(page);
      if (w2Held) markPurse(w2Held, viewport.width, "W2 held", at);
      // The screenshot the AC asks for: 1024, the width whose row is packed to the pixel.
      if (viewport.width === 1024 && era === "1986") {
        const shot = path.join(OUT, "pb331-1024x768-purse.png");
        await page.screenshot({ path: shot });
        mark("(h) the 1024 screenshot was written" + at, true, shot);
      }

      // ---- (g) the win line: producer arm -------------------------------------------------------
      // PM 10342 §2(c): the head plus the result is painted whole, the capital detail is what the
      // ladder may drop, and the full sentence stays in the title. PM 10348: BOTH outcomes are
      // graded at 1024 in every era, seen from the blue seat — "lost" is wider than "won", so it is
      // measured, not assumed. A spectator has no seat the result can be read from, so that case
      // paints the winner's name and is only graded for no clip at 1440 and 1280 (no floor ruled).
      const winCases = [
        { key: "blue win, blue seat", room: { winner: "blue" }, floor: "won",
          title: warEra + " · blue · round 12 · running · blue won (Moscow, round 12)" },
        { key: "red win, blue seat", room: { winner: "red" }, floor: "lost",
          title: warEra + " · blue · round 12 · running · red won (Moscow, round 12)" },
      ];
      if (viewport.width >= 1280) {
        winCases.push({ key: "blue win, spectator", room: { you: "", winner: "blue" }, floor: "blue won",
          title: warEra + " · round 12 · running · blue won (Moscow, round 12)" });
        winCases.push({ key: "red win, spectator", room: { you: "", winner: "red" }, floor: "red won",
          title: warEra + " · round 12 · running · red won (Moscow, round 12)" });
      }
      for (const winCase of winCases) {
        const winRoom = { era: era, you: "blue", round: 12, clock: "running", speed: 1,
          over: true, winner: "blue", result: { lastCapital: { name: "Moscow", round: 12 } }, ...winCase.room };
        const gAt = at + " [" + winCase.key + "]";
        const winSnap = await probeStrip(page, winRoom);
        const winFit = {
          integerOk: winSnap.scrollWidth <= winSnap.clientWidth + 1,
          rangeOk: winSnap.rangeRight <= winSnap.boxRight + 0.5 && winSnap.rangeWidth <= winSnap.contentWidth + 0.5,
        };
        const winParts = winSnap.text.split(" · ");
        const lastPart = winParts[winParts.length - 1] || "";
        const namedWon = lastPart === winCase.room.winner + " won" || lastPart.startsWith(winCase.room.winner + " won (");
        const floorWon = lastPart === winCase.floor || lastPart.startsWith(winCase.floor + " (");
        mark("(g) " + winCase.key + ": the head is painted whole, era first" + gAt, winParts[0] === warEra, JSON.stringify(winParts));
        mark("(g) " + winCase.key + ": round 12 and the clock word are painted" + gAt,
          winSnap.text.includes("round 12") && winSnap.text.includes("running"), JSON.stringify(winSnap.text));
        mark("(g) " + winCase.key + ": the result names the winner, or the floor reads the viewer's side" + gAt,
          namedWon || floorWon, JSON.stringify({ last: lastPart, want: winCase.floor, text: winSnap.text }));
        mark("(g) " + winCase.key + ": the floor tier paints \"" + winCase.floor + "\"" + gAt,
          (winSnap.floorParts[winSnap.floorParts.length - 1] || "") === winCase.floor, JSON.stringify(winSnap.floorParts));
        mark("(g) " + winCase.key + ": no clip (scrollWidth <= clientWidth + 1)" + gAt, winFit.integerOk,
          JSON.stringify({ scrollWidth: winSnap.scrollWidth, clientWidth: winSnap.clientWidth, text: winSnap.text }));
        mark("(g) " + winCase.key + ": the text ends inside the box (fractional arm)" + gAt, winFit.rangeOk,
          JSON.stringify({ rangeRight: winSnap.rangeRight, boxRight: winSnap.boxRight, delta: round2(winSnap.rangeRight - winSnap.boxRight), rangeWidth: winSnap.rangeWidth, contentWidth: winSnap.contentWidth }));
        mark("(g) " + winCase.key + ": the line keeps >= 8 px of headroom in the row" + gAt, winSnap.headroom >= 8,
          JSON.stringify({ headroom: winSnap.headroom, rangeWidth: winSnap.rangeWidth, text: winSnap.text }));
        mark("(g) " + winCase.key + ": the title carries the full sentence" + gAt, winSnap.title === winCase.title,
          JSON.stringify({ title: winSnap.title, want: winCase.title }));
        const winBad = rectMatrix(winSnap.controls);
        mark("(g) " + winCase.key + ": every control in the row is >= 1 px clear of every other" + gAt, winBad.length === 0,
          JSON.stringify({ controls: winSnap.controls.length, collisions: winBad.slice(0, 6) }));
        mark("(g) " + winCase.key + ": the command cluster is not a scroll window" + gAt,
          Boolean(winSnap.nav) && winSnap.nav.scrollWidth <= winSnap.nav.clientWidth + 1, JSON.stringify(winSnap.nav));
      }

      // ---- paused state (speed 0 with the clock running prints "paused") -----------------------
      mark("(a) the clock read back as running" + at, running.clock === "running", JSON.stringify(running.clock));

      mark("no page error was raised" + at, errors.length === 0, JSON.stringify(errors.slice(0, 4)));
      await context.close();
    }
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
