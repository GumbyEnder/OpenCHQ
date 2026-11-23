// PB-148: a wheel gesture belongs to the surface it began on.
//
//   PLAYWRIGHT_MODULE=<pw> node tests/e2e/pb148-wheel-latch.mjs --url=<base> [--out=<dir>]
//
// Drives real Chromium wheel input at 1920x1072 (the viewport the defect was reported at) through
// page.mouse.wheel at coordinates — a synthetic WheelEvent cannot prove hit-testing, which is how
// this ticket looked un-reproducible from the DOM.
//
//   A  green pin at base: every panel pixel under the wheel scrolls only the panel, in both
//      directions, at the list's first and last line; the camera readout is identical across the
//      sweep. (Already true at 2d67e76; this is the regression pin.)
//   B  RED at base: a gesture that starts on the panel and drifts 40 px onto the map keeps the
//      panel: the camera must not move, and the list keeps scrolling. At 2d67e76 this reads
//      `LI, LI, board, board` and the camera steps 5 -> 8 px.
//   C  the converse: a gesture that starts on the map keeps zooming about the cursor after it
//      drifts over an open panel, the cell under the cursor stays put, and the panel does not
//      scroll. At 2d67e76 the zoom continues but the panel scrolls too (log 120 -> 0).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/pb148-wheel-latch.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb148")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
let failed = 0;
function mark(step, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "pb148-wheel-latch.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1072 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
page.on("dialog", (dialog) => dialog.accept());

// Every wheel the page sees, recorded at the document so the target is the browser's own hit test.
const spy = () => page.evaluate(() => {
  if (window.__pb148) return;
  window.__pb148 = { events: [], logScrolls: 0 };
  document.addEventListener("wheel", (event) => {
    const t = event.target;
    window.__pb148.events.push({
      target: t && (t.id || String(t.className || "").split(" ")[0] || t.nodeName),
      x: event.clientX, y: event.clientY, dY: event.deltaY,
    });
  }, { capture: true, passive: true });
  // Scroll does not bubble, so count the list's own scroll events at the document in the capture
  // phase. The final scrollTop cannot tell four notches from two when the list clamps at its end.
  document.addEventListener("scroll", (event) => {
    if (event.target && event.target.id === "roundLog") window.__pb148.logScrolls += 1;
  }, { capture: true, passive: true });
});

const read = () => page.evaluate(() => {
  const l = document.getElementById("roundLog");
  const cam = window.__chq.state().camera;
  return {
    camNote: document.getElementById("camNote").textContent.replace(/\s+/g, " ").trim(),
    scale: cam ? cam.scale : null,
    left: cam ? cam.left : null,
    top: cam ? cam.top : null,
    logTop: l ? Math.round(l.scrollTop) : null,
    logMax: l ? Math.max(0, l.scrollHeight - l.clientHeight) : null,
    events: window.__pb148.events.length,
    logScrolls: window.__pb148.logScrolls,
    lastEvents: window.__pb148.events.slice(-8),
  };
});

// The world point under a client pixel, from the page's own camera — the same arithmetic
// `screenPoint()` and `zoomAt()` use, so "the cell under the cursor stays put" is measured, not
// eyeballed.
const worldUnder = (x, y) => page.evaluate(({ cx, cy }) => {
  const canvas = document.getElementById("board");
  const rect = canvas.getBoundingClientRect();
  const cam = window.__chq.state().camera;
  const sx = (cx - rect.left) * (canvas.width / Math.max(1, rect.width));
  const sy = (cy - rect.top) * (canvas.height / Math.max(1, rect.height));
  return { x: (sx - cam.left) / cam.scale, y: (sy - cam.top) / cam.scale };
}, { cx: x, cy: y });

async function gesture(steps) {
  for (const [x, y, dY] of steps) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, dY);
    await sleep(140);
  }
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "pb148" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  await page.selectOption('#launch select[name="era"]', "1986");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1986",
    null, { timeout: 20000, polling: 100 });
  await page.click("#clockBtn");
  await page.waitForFunction(() => Number((document.querySelector("#stripInfo").textContent.match(/round (\d+)/) || [0, 0])[1]) >= 20,
    null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => [...document.querySelectorAll("#nav .navbtn")].find((b) => b.textContent.trim() === "Log").click());
  await page.waitForSelector("#roundLog li");
  // The panel is only a scroll surface once the round buffer outruns 46vh of lines; wait for that
  // rather than assuming a round number is enough (round 12 carried 0 px of scroll at 1920x1072).
  await page.waitForFunction(() => {
    const l = document.getElementById("roundLog");
    return l && l.scrollHeight - l.clientHeight > 80;
  }, null, { timeout: 120000, polling: 250 });
  await sleep(500);
  await spy();

  const box = await page.evaluate(() => {
    const d = document.getElementById("dialog").getBoundingClientRect();
    const list = document.getElementById("roundLog").getBoundingClientRect();
    const body = document.getElementById("dialogBody").getBoundingClientRect();
    const hint = document.getElementById("dialogHint").getBoundingClientRect();
    const title = document.getElementById("dialogTitle").getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
      dialog: { x: d.x, y: d.y, w: d.width, h: d.height },
      list: { x: list.x, y: list.y, w: list.width, h: list.height },
      body: { x: body.x, y: body.y, w: body.width, h: body.height },
      hint: { x: hint.x, y: hint.y, w: hint.width, h: hint.height },
      title: { x: title.x, y: title.y, w: title.width, h: title.height },
    };
  });
  mark("viewport is 1920x1072 with the Log panel open over the map",
    box.viewport[0] === 1920 && box.viewport[1] === 1072 && box.dialog.w > 400,
    { ...box.viewport, dpr: box.dpr, dialog: box.dialog });
  mark("the list is scrollable, so the panel has somewhere to scroll",
    (await read()).logMax > 40, { logMax: (await read()).logMax });

  // --- A: the regression pin, green at base -------------------------------------------------
  const A_POINTS = [
    ["list", box.list.x + box.list.w / 2, box.list.y + Math.min(120, box.list.h / 2)],
    ["title", box.title.x + box.title.w / 2, box.title.y + box.title.h / 2],
    ["hint", box.hint.x + box.hint.w / 2, box.hint.y + box.hint.h / 2],
    ["body-below-list", box.body.x + box.body.w / 2, box.body.y + box.body.h - 5],
    ["2px inside the left border", box.dialog.x + 2, box.list.y + 80],
  ];
  for (const [name, x, y] of A_POINTS) {
    for (const dir of [-1, 1]) {
      const before = await read();
      await gesture([[x, y, dir * 120], [x, y, dir * 120]]);
      const after = await read();
      const panelScrolled = after.logTop !== before.logTop;
      mark(`A: wheel ${dir < 0 ? "up" : "down"} over the panel's ${name} moves no camera`,
        after.camNote === before.camNote && after.scale === before.scale,
        { before: before.camNote, after: after.camNote, panelScrolled });
      mark(`A: wheel ${dir < 0 ? "up" : "down"} over the panel's ${name} has no board target`,
        after.lastEvents.every((e) => e.target !== "board"), after.lastEvents);
    }
  }
  // The list's first and last line: the chain has nowhere to go, and the camera still must not move.
  for (const [edge, atTop] of [["first", true], ["last", false]]) {
    await page.evaluate((top) => {
      const l = document.getElementById("roundLog");
      l.scrollTop = top ? 0 : l.scrollHeight;
    }, atTop);
    await sleep(150);
    const before = await read();
    await gesture([[A_POINTS[0][1], A_POINTS[0][2], atTop ? -120 : 120],
      [A_POINTS[0][1], A_POINTS[0][2], atTop ? -120 : 120]]);
    const after = await read();
    mark(`A: a wheel past the list's ${edge} line moves no camera`,
      after.scale === before.scale && after.camNote === before.camNote,
      { before: before.camNote, after: after.camNote, logTop: after.logTop });
  }

  // --- A2: the report's own numbers — 5 notches at (957,300) and (739,64) -------------------
  for (const [name, x, y] of [["list", 957, 300], ["title", 739, 64]]) {
    for (const dir of [-1, 1]) {
      const before = await read();
      await gesture([[x, y, dir * 120], [x, y, dir * 120], [x, y, dir * 120], [x, y, dir * 120], [x, y, dir * 120]]);
      const after = await read();
      mark(`A2: 5 notches ${dir < 0 ? "up" : "down"} at (${x},${y}) over the ${name} move no camera`,
        after.scale === before.scale && after.camNote === before.camNote,
        { before: before.camNote, after: after.camNote, logTop: [before.logTop, after.logTop],
          targets: after.lastEvents.map((e) => e.target) });
    }
  }

  // --- B: RED at base — the panel keeps the gesture it started ------------------------------
  // Start at the list's end and wheel UP, so the panel has room to keep scrolling in the direction
  // the drifted notches take; a list already at the bottom would read "no scroll" for both trees.
  await page.evaluate(() => { const l = document.getElementById("roundLog"); l.scrollTop = l.scrollHeight; });
  await sleep(150);
  let before = await read();
  // 60 px a notch: two notches must not carry the list all the way to its top, or the drifted
  // pair would read "no scroll" on both trees.
  await gesture([
    [box.list.x + box.list.w / 2, box.list.y + 120, -60],
    [box.list.x + box.list.w / 2, box.list.y + 120, -60],
    [box.dialog.x - 40, box.list.y + 120, -60],
    [box.dialog.x - 40, box.list.y + 120, -60],
  ]);
  let after = await read();
  mark("B (RED at base): a gesture that starts on the panel and drifts onto the map leaves the camera alone",
    after.scale === before.scale && after.camNote === before.camNote,
    { before: before.camNote, after: after.camNote, scaleBefore: before.scale, scaleAfter: after.scale,
      targets: after.lastEvents.map((e) => e.target) });
  mark("B: the panel keeps the drifted notches (all four notches scroll the list, not two)",
    after.logScrolls - before.logScrolls >= 4,
    { logScrollsBefore: before.logScrolls, logScrollsAfter: after.logScrolls,
      logTopBefore: before.logTop, logTopAfter: after.logTop });

  // --- C: the converse — a map gesture keeps zooming over the panel ------------------------
  const mapPoint = await page.evaluate(() => {
    const c = document.getElementById("board").getBoundingClientRect();
    return { x: c.x + 60, y: c.y + c.height - 80 };
  });
  const panelPoint = { x: box.list.x + box.list.w / 2, y: box.list.y + 120 };
  await page.evaluate(() => { document.getElementById("roundLog").scrollTop = 120; });
  await sleep(150);

  before = await read();
  await gesture([[mapPoint.x, mapPoint.y, -120], [mapPoint.x, mapPoint.y, -120]]);
  const mid = await read();
  const worldMid = await worldUnder(panelPoint.x, panelPoint.y);
  await gesture([[panelPoint.x, panelPoint.y, -120], [panelPoint.x, panelPoint.y, -120]]);
  after = await read();
  const worldAfter = await worldUnder(panelPoint.x, panelPoint.y);
  mark("C: a map gesture keeps zooming after it drifts over the open panel",
    mid.scale > before.scale && after.scale > mid.scale,
    { scale: [before.scale, mid.scale, after.scale] });
  mark("C: the cell under the cursor stays put through the drifted notches",
    Math.abs(worldAfter.x - worldMid.x) <= 1.5 && Math.abs(worldAfter.y - worldMid.y) <= 1.5,
    { worldMid, worldAfter });
  mark("C (RED at base): the drifted notches do not scroll the panel",
    after.logTop === 120, { logTopBefore: 120, logTopAfter: after.logTop });

  await page.screenshot({ path: path.join(OUT, "pb148-wheel-latch.png") });
  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 5));
} finally {
  await browser.close();
}

console.log(failed === 0 ? "PB148_OK" : `PB148_FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
