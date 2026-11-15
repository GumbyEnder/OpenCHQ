// T-030 AC8 fix round - the five items the PM reopened on e9a8bfa, each pinned with real input.
//
//   node tests/e2e/t030-ac8-fix.mjs --url=http://127.0.0.1:8097 --out=.../local/t030-fix-shots
//
// Item 1  AC3 Escape: a click that is visually a SELECTION (on the badge) never orders, and a real
//         Escape keydown leaves the wire clean and the toast saying "Selection cleared." - and it
//         still says that a full second later (no late ack repaints it).
// Item 2  T-021 AC / PB-042: an accepted order keeps a thin path and a destination marker on the
//         map until it arrives, at the fit and zoomed. Checked as INK, not as a screenshot.
// Item 3  AC1 visibility: the ring is at least 3 cells (or the badge + 4 px) across and it is drawn
//         ABOVE the city labels and the hover ring. Checked by the ring's own edge pixels.
// Item 4  AC4 note: while a selection exists the board note keeps naming it, whatever the cursor did
//         last (route hover and leave, political view, an unscreened transport).
// Item 5  PB-052 residue: a refused destination says why and keeps the selection.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function argOf(name, fallback = "") {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/t030-ac8-fix.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(here, "..", "..", "local", "t030-fix-shots")));
mkdirSync(OUT, { recursive: true });
const ERA = argOf("era", "1942");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch (err) { void err; }
  }
  return import("playwright");
}

const evidence = [];
let reds = 0;
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  if (!ok) reds += 1;
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail === undefined ? null : detail));
  writeFileSync(path.join(OUT, "t030-fix.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));

const ev = (fn, arg) => page.evaluate(fn, arg);
const room = () => ev(() => window.__chq.room());
const state = () => ev(() => window.__chq.state());
const toast = () => ev(() => window.__chq.toast());
const note = () => ev(() => window.__chq.note());
const wireLen = () => ev(() => window.__chq.wire().length);
const wireFrom = (n) => ev((n) => window.__chq.wire().slice(n), n);
// The pending orders are read off the room frame, which is the payload the painter draws from: no
// debug-only getter, so this check means the same thing before and after the fix.
const pending = async () => {
  const r = await room();
  return (r && Array.isArray(r.pieces) ? r.pieces : [])
    .filter((p) => Array.isArray(p.path) && p.path.length)
    .map((p) => ({ id: p.id, path: p.path.map((s) => ({ x: s.x, y: s.y, pace: s.pace })) }));
};
// Always measure the point right before the input: the page's own toast/note text changes the
// layout, and a stale point on a 4 px cell is a click on the neighbouring cell.
const pointOf = (x, y) => ev(({ x, y }) => window.__chq.cellToScreen(x, y), { x, y });

async function shot(name) {
  const file = path.join(OUT, "t030-" + name + ".png");
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}
async function fit() {
  await ev(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(250);
}
async function clickCell(cell, dx = 0, dy = 0) {
  const p = await pointOf(cell.x, cell.y);
  await page.mouse.move(p.x + dx, p.y + dy);
  await sleep(120);
  await page.mouse.click(p.x + dx, p.y + dy);
  await sleep(260);
}
async function hoverCell(cell, dx = 0, dy = 0) {
  const p = await pointOf(cell.x, cell.y);
  await page.mouse.move(p.x + dx, p.y + dy);
  await sleep(220);
}
// Zooming is about the viewport centre, so a piece can leave the screen. Arrow-pan until the cell is
// near the middle, or a pixel sample measures an empty canvas.
async function centreOn(cell) {
  const centre = { x: 720, y: 450 };
  for (let i = 0; i < 200; i++) {
    const at = await pointOf(cell.x, cell.y);
    let moved = false;
    if (at.x < centre.x - 60) { await page.keyboard.press("ArrowLeft"); moved = true; }
    else if (at.x > centre.x + 60) { await page.keyboard.press("ArrowRight"); moved = true; }
    if (at.y < centre.y - 60) { await page.keyboard.press("ArrowUp"); moved = true; }
    else if (at.y > centre.y + 60) { await page.keyboard.press("ArrowDown"); moved = true; }
    if (!moved) break;
  }
  await sleep(220);
}
function orders(lines) {
  return lines.filter((line) => /^ordered/.test(line) || /^order /.test(line));
}

// Gold ink, loosely: a 1.6 px stroke over terrain is antialiased, so an exact colour count misses
// the line at the world fit. The control cells (see the item 2 check) cancel terrain that happens to
// be sand-coloured.
async function goldNear(cells, radius = 5) {
  return ev(({ cells, radius }) => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    let hits = 0;
    for (const cell of cells) {
      const spot = window.__chq.cellToScreen(cell.x, cell.y);
      const px = Math.round((spot.x - rect.left) * ratio);
      const py = Math.round((spot.y - rect.top) * ratio);
      const r = Math.round(radius * ratio);
      const x0 = Math.max(0, px - r);
      const y0 = Math.max(0, py - r);
      const w = Math.min(canvas.width - x0, r * 2 + 1);
      const h = Math.min(canvas.height - y0, r * 2 + 1);
      const data = canvas.getContext("2d").getImageData(x0, y0, w, h).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] >= 200 && data[i + 1] >= 150 && data[i + 1] <= 235 && data[i + 2] <= 170) hits += 1;
      }
    }
    return hits;
  }, { cells, radius });
}

// ---- pixel helpers -------------------------------------------------------------------------
// Every readback is in the canvas's own device pixels; CSS points convert by the rect ratio.
async function inkNear(cell, color, radius = 6) {
  return ev(({ cell, color, radius }) => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const spot = window.__chq.cellToScreen(cell.x, cell.y);
    const px = Math.round((spot.x - rect.left) * ratio);
    const py = Math.round((spot.y - rect.top) * ratio);
    const r = Math.round(radius * ratio);
    const x0 = Math.max(0, px - r);
    const y0 = Math.max(0, py - r);
    const w = Math.min(canvas.width - x0, r * 2 + 1);
    const h = Math.min(canvas.height - y0, r * 2 + 1);
    const data = canvas.getContext("2d").getImageData(x0, y0, w, h).data;
    let hit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - color[0]) <= 8 && Math.abs(data[i + 1] - color[1]) <= 8
        && Math.abs(data[i + 2] - color[2]) <= 8) hit += 1;
    }
    return hit;
  }, { cell, color, radius });
}

// The accent ring's bounding box around a cell, and how much of each edge is accent ink. The edge
// coverage is what "drawn above the city label and the hover circle" means in pixels: a label
// painted over the ring breaks the edge into label ink.
async function ringBox(cell, span = 60) {
  return ev(({ cell, span }) => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const spot = window.__chq.cellToScreen(cell.x, cell.y);
    const px = Math.round((spot.x - rect.left) * ratio);
    const py = Math.round((spot.y - rect.top) * ratio);
    const s = Math.round(span * ratio);
    const x0 = Math.max(0, px - s);
    const y0 = Math.max(0, py - s);
    const w = Math.min(canvas.width - x0, s * 2 + 1);
    const h = Math.min(canvas.height - y0, s * 2 + 1);
    const data = canvas.getContext("2d").getImageData(x0, y0, w, h).data;
    const isAccent = (i) => data[i] === 255 && data[i + 1] === 224 && data[i + 2] === 102;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isAccent((y * w + x) * 4)) continue;
        total += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (total === 0) return { total: 0, width: 0, height: 0, ratio, topEdge: 0, leftEdge: 0, rightEdge: 0 };
    // Coverage of an edge: accent pixels in the 3 px band inside the box edge over the edge length.
    const edge = (fx, fy, len) => {
      let hit = 0;
      for (let t = 0; t < len; t++) {
        for (let d = 0; d < 3; d++) {
          const x = fx(t), y = fy(t, d);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (isAccent((y * w + x) * 4)) { hit += 1; break; }
        }
      }
      return hit / Math.max(1, len);
    };
    return {
      total,
      ratio,
      px: { x: px, y: py },
      x: minX + x0, y: minY + y0,
      width: maxX - minX + 1, height: maxY - minY + 1,
      dir: { left: minX, right: maxX, top: minY, bottom: maxY },
      topEdge: edge((t) => minX + t, (t, d) => minY + d, maxX - minX + 1),
      leftEdge: edge((t) => minX + t, (t, d) => minY + d, maxY - minY + 1),
    };
  }, { cell, span });
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await ev(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), { version });
  if (!(await ev(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t30f" + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  }
  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((era) => window.__chq.room() && String(window.__chq.room().era) === era, ERA, { timeout: 30000 });
  await sleep(600);
  // A held clock is the only state in which a click's effect can be read after the click.
  await ev(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null, { timeout: 15000 }).catch(() => {});
  await fit();

  const current = await room();
  const caps = await ev(() => window.__chq.capitalLabels());
  const wash = caps && caps.find((c) => /washington/i.test(c.name));
  const mine = (current.pieces || []).filter((p) => String(p.side) === current.you);
  // The stack the PM tested: an own land piece on or beside Washington. Prefer a cell that holds
  // more than one own piece, so the reselect path (and PB-056) is what is under the pointer.
  const countAt = new Map();
  for (const p of mine) {
    const k = p.x + ":" + p.y;
    countAt.set(k, (countAt.get(k) || 0) + 1);
  }
  const anchor = wash
    ? mine.filter((p) => Math.abs(p.x - wash.x) <= 2 && Math.abs(p.y - wash.y) <= 2)
    : mine;
  const pool = anchor.length ? anchor : mine;
  const piece = pool.slice().sort((a, b) => (countAt.get(b.x + ":" + b.y) || 0) - (countAt.get(a.x + ":" + a.y) || 0))[0];
  mark("a Washington piece is on the board", Boolean(piece), piece ? { id: piece.id, kind: piece.kind, at: { x: piece.x, y: piece.y }, capital: wash } : null);
  if (!piece) throw new Error("no own piece to test with");
  const cell = { x: Number(piece.x), y: Number(piece.y) };

  // ==== Item 1: Escape, and the click that must not be an order ==============================
  {
    await fit();
    let before = await wireLen();
    await clickCell(cell);
    const st = await state();
    const selectWire = await wireFrom(before);
    mark("item 1 a real click on the badge selects and sends no order",
      String(st.selected) === String(piece.id) && orders(selectWire).length === 0,
      { selected: st.selected, toast: await toast(), orders: orders(selectWire) });

    // The gesture the PM's hand-check made and called "re-click keeps the selection": a second
    // click a couple of pixels off the centre is still ON the badge and must not order.
    const offsets = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [0, 3]];
    const stray = [];
    for (const [dx, dy] of offsets) {
      await page.keyboard.press("Escape");
      await sleep(140);
      await clickCell(cell);
      before = await wireLen();
      await clickCell(cell, dx, dy);
      const lines = await wireFrom(before);
      const after = await state();
      const bad = orders(lines).length > 0 || String(after.selected) !== String(piece.id);
      if (bad) stray.push({ dx, dy, orders: orders(lines), selected: after.selected, toast: await toast() });
    }
    mark("item 1 a re-click on the badge (2-3 px off centre) never orders and keeps the selection",
      stray.length === 0, { offsets, stray });

    // A one-cell move must still be possible (the regression T-028 shipped had no one-cell move at
    // all): clicking the neighbouring cell's own centre, one cell out, is a destination.
    await page.keyboard.press("Escape");
    await sleep(140);
    await clickCell(cell);
    before = await wireLen();
    await clickCell({ x: (cell.x + 1) % 320, y: cell.y });
    const oneCellWire = await wireFrom(before);
    mark("item 1 a one-cell move is still a destination, not a reselect",
      orders(oneCellWire).length > 0, { wire: oneCellWire, toast: await toast() });

    // The reserved radius is capped below one cell, so the neighbouring cell's centre is a
    // destination at every zoom a player uses, not only at the fit (PM 5641(3), ruled in 5677:
    // a pin or numbers, their hand-check repeats it after deploy). Measured at ~x2 and ~x4.
    for (const presses of [2, 4]) {
      await fit();
      await clickCell(cell);
      for (let i = 0; i < presses; i++) {
        await page.keyboard.press("+");
        await sleep(160);
      }
      await centreOn(cell);
      const zoomScale = (await state()).camera.scale;
      const target = { x: (cell.x + 1) % 320, y: cell.y };
      const tp = await pointOf(target.x, target.y);
      before = await wireLen();
      await page.mouse.move(tp.x, tp.y);
      await sleep(120);
      await page.mouse.click(tp.x, tp.y);
      await sleep(320);
      const zoomWire = await wireFrom(before);
      mark("item 1 a one-cell move still orders at x" + zoomScale.toFixed(2),
        orders(zoomWire).length > 0,
        { presses, scale: zoomScale, wire: zoomWire, toast: await toast() });
    }

    // The PM's own repro (shot 05-escape): a click the player read as a selection, then Escape
    // before the ack lands. The order must never be on the wire, so nothing can overwrite the clear.
    // Refit first: at x15 a 2 px miss is still the same cell, so the ambiguity this pin is about
    // only exists at the fit (the zoom loop above leaves the camera there).
    await fit();
    await page.keyboard.press("Escape");
    await sleep(140);
    await clickCell(cell);
    before = await wireLen();
    const p = await pointOf(cell.x, cell.y);
    await page.mouse.move(p.x - 2, p.y);
    await sleep(60);
    await page.mouse.click(p.x - 2, p.y);
    await page.keyboard.press("Escape");
    await sleep(1200);
    const lateWire = await wireFrom(before);
    const lateToast = await toast();
    mark("item 1 a badge click immediately followed by Escape puts no order on the wire",
      orders(lateWire).length === 0 && /^Selection cleared\.$/.test(lateToast) && (await state()).selected === null,
      { wire: lateWire, toast: lateToast, selected: (await state()).selected });

    // The Escape contract itself, with a real keydown.
    await page.keyboard.press("Escape");
    await sleep(220);
    before = await wireLen();
    const logLen = (await ev(() => window.__chq.log())).length;
    await clickCell(cell);
    await sleep(120);
    const beforeEscape = await wireLen();
    await page.keyboard.press("Escape");
    await sleep(220);
    const afterEscape = await state();
    const escToast = await toast();
    const escWire = await wireFrom(beforeEscape);
    mark("item 1 Escape clears the selection with no order on the wire",
      afterEscape.selected === null && orders(escWire).length === 0 && /^Selection cleared\.$/.test(escToast),
      { selected: afterEscape.selected, toast: escToast, wire: escWire });
    // A late ack must not repaint the clear with "Order sent".
    await sleep(1300);
    const laterToast = await toast();
    const laterLog = await ev(() => window.__chq.log());
    mark("item 1 the clear still reads as a clear a second later (no late order ack)",
      /^Selection cleared\.$/.test(laterToast) && laterLog.length === logLen,
      { toast: laterToast, logAdded: laterLog.slice(logLen) });
    void before;
  }

  // ==== Item 2: the pending order stays drawn ================================================
  let orderPath = null;
  {
    await fit();
    await clickCell(cell);
    const dest = { x: (cell.x + 6) % 320, y: cell.y };
    await hoverCell(dest);
    const span = await ev(() => window.__chq.previewSpan());
    const hoverNote = await note();
    const before = await wireLen();
    await clickCell(dest);
    await sleep(900);
    const lines = await wireFrom(before);
    const pendingNow = await pending();
    orderPath = pendingNow && pendingNow.length ? pendingNow[pendingNow.length - 1] : null;
    mark("item 2 the order was accepted by the server",
      orders(lines).length > 0 && /^Order sent/.test(await toast()),
      { toast: await toast(), wire: lines });
    mark("item 2 the room frame carries the pending path",
      Boolean(orderPath && Array.isArray(orderPath.path) && orderPath.path.length > 1),
      { pending: orderPath, previewHas: span.has, hoverNote });

    const colour = [255, 209, 102];
    const samples = orderPath ? orderPath.path : [];
    // The first step sits under the selection ring's casing while the mark is up, so the sample
    // starts one step out: what is under test is that the ORDER's own path is painted.
    const picks = samples.length > 1
      ? [samples[1], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]]
      : samples;
    const inks = [];
    for (const step of picks) inks.push({ at: step, ink: await inkNear(step, colour, 5) });
    // The line itself, against three control cells in the same terrain band: the exact-colour count
    // above only catches the opaque destination marker at the world fit, because a 1.6 px stroke is
    // antialiased over the terrain.
    const controls = picks.map((step) => ({ x: step.x, y: step.y + 4 }));
    const pathGold = await goldNear(picks);
    const controlGold = await goldNear(controls);
    mark("item 2 the pending path is drawn at the world fit",
      (inks.length > 0 && inks.every((row) => row.ink > 0)) || pathGold > controlGold + 5,
      { inks, pathGold, controlGold, controls });
    await shot("marker-fit");

    await page.keyboard.press("+");
    await sleep(200);
    await page.keyboard.press("+");
    await sleep(200);
    await page.keyboard.press("+");
    await sleep(300);
    await centreOn(picks[0] || cell);
    const zoomInks = [];
    for (const step of picks) zoomInks.push({ at: step, ink: await inkNear(step, colour, 4) });
    mark("item 2 the pending path is drawn when zoomed", zoomInks.length > 0 && zoomInks.every((row) => row.ink > 0),
      { inks: zoomInks, camera: (await state()).camera });
    await shot("marker-zoom");
    await fit();
  }

  // ==== Item 3: the ring is big enough and on top ===========================================
  {
    await fit();
    await clickCell(cell);
    const scale = (await state()).camera.scale;
    const boxFit = await ringBox(cell, Math.max(14, Math.ceil(scale * 6)));
    const want = Math.max(scale * 3, 14 + 4);
    mark("item 3 the ring is at least 3 cells (or the badge + 4 px) across at the fit",
      boxFit.width > 0 && boxFit.width >= want * boxFit.ratio * 0.9,
      { scale, wantPx: want, ring: { width: boxFit.width, height: boxFit.height }, ratio: boxFit.ratio });
    mark("item 3 the ring is drawn above the capital marker and the city labels (its top edge is unbroken)",
      boxFit.topEdge >= 0.9 && boxFit.leftEdge >= 0.9,
      { topEdge: Number(boxFit.topEdge.toFixed(2)), leftEdge: Number(boxFit.leftEdge.toFixed(2)) });
    await shot("ring-fit");

    await page.keyboard.press("+");
    await sleep(200);
    await page.keyboard.press("+");
    await sleep(200);
    await page.keyboard.press("+");
    await sleep(300);
    // Zooming is about the viewport centre, so the piece can leave the screen: pan it back into
    // view before sampling, or the check measures an empty canvas.
    const centre = { x: 720, y: 450 };
    for (let i = 0; i < 200; i++) {
      const at = await pointOf(cell.x, cell.y);
      let moved = false;
      if (at.x < centre.x - 60) { await page.keyboard.press("ArrowLeft"); moved = true; }
      else if (at.x > centre.x + 60) { await page.keyboard.press("ArrowRight"); moved = true; }
      if (at.y < centre.y - 60) { await page.keyboard.press("ArrowUp"); moved = true; }
      else if (at.y > centre.y + 60) { await page.keyboard.press("ArrowDown"); moved = true; }
      if (!moved) break;
    }
    await sleep(250);
    const zoomScale = (await state()).camera.scale;
    const boxZoom = await ringBox(cell, Math.max(20, Math.ceil(zoomScale * 6)));
    const wantZoom = Math.max(zoomScale * 3, 14 + 4);
    mark("item 3 the ring grows with the cell size",
      boxZoom.width > 0 && boxZoom.width >= wantZoom * boxZoom.ratio * 0.9 && boxZoom.width >= boxFit.width * 1.2,
      { fitWidth: boxFit.width, zoomWidth: boxZoom.width, fitScale: scale, zoomScale, wantPx: wantZoom });
    await shot("ring-zoom");
    await fit();
  }

  // ==== Item 4: the note keeps naming the selection =========================================
  {
    await fit();
    await clickCell(cell);
    const dest = { x: (cell.x + 4) % 320, y: cell.y };
    await hoverCell(dest);
    const routeNote = await note();
    // Leaving the canvas is what the PM did: the route hover ends, the selection does not.
    await page.mouse.move(4, 4);
    await sleep(300);
    const afterLeave = { note: await note(), selected: (await state()).selected };
    mark("item 4 the note names the selection after a route hover is left",
      String(afterLeave.selected) === String(piece.id) && /selected/i.test(afterLeave.note),
      { routeNote, ...afterLeave });

    await page.keyboard.press("p");
    await sleep(250);
    await page.mouse.move(4, 4);
    await sleep(250);
    const political = { note: await note(), selected: (await state()).selected };
    mark("item 4 the note names the selection in the political view",
      String(political.selected) === String(piece.id) && /selected/i.test(political.note), political);
    await page.keyboard.press("p");
    await sleep(200);
    await shot("note-selected");
  }

  // ==== Item 5: a refused destination says why and keeps the selection ======================
  {
    await fit();
    const board = await ev(() => window.__chq.board());
    const cells = board && Array.isArray(board.cells) ? board.cells : null;
    // A ship ordered onto land is the server's own refusal ("A ship cannot end on land."): a
    // destination that says why and keeps the selection is the PB-052 residue. Wasteland is the
    // other outright refusal and the 1942 board carries none of it.
    const ship = mine.find((p) => p.domain === "sea");
    const TAKEN = new Set((current.pieces || []).map((p) => Number(p.x) + ":" + Number(p.y)));
    const waterIds = new Set([0, 2, 3]);
    let landCell = null;
    if (cells && ship) {
      for (let y = 20; y < 130 && !landCell; y++) {
        for (let x = 2; x < 318 && !landCell; x++) {
          const terrain = Number(cells[y * (board.width || 320) + x]);
          if (!waterIds.has(terrain) && !TAKEN.has(x + ":" + y)
            && Math.abs(x - ship.x) + Math.abs(y - ship.y) > 8) landCell = { x, y };
        }
      }
    }
    let refusal = null;
    if (ship && landCell) {
      await clickCell({ x: ship.x, y: ship.y });
      const before = await wireLen();
      await clickCell(landCell);
      await sleep(500);
      const lines = await wireFrom(before);
      refusal = {
        ship: ship.id,
        cell: landCell,
        toast: await toast(),
        note: await note(),
        selected: (await state()).selected,
        wire: lines,
      };
      mark("item 5 a refused destination says why and keeps the selection",
        orders(lines).length === 0
        && String(refusal.selected) === String(ship.id)
        && !/Select one of your pieces/i.test(refusal.toast)
        && /refus|cannot|No route|No sea|lane|Wasteland|holds that cell/i.test(refusal.toast),
        refusal);
      await shot("refusal");
    } else {
      mark("item 5 a refused destination says why and keeps the selection", false,
        { error: ship ? "no land cell found to refuse" : "no own ship on the board" });
    }
    await page.keyboard.press("Escape");
    await sleep(150);

    // The PB-052 residue itself: a plain land cell near the piece, while selected, must order or
    // refuse - never drop the selection with the hint, and an accepted order must SAY it cleared the
    // selection. Pre-fix the ack was a bare "Order sent", so the next click answered
    // "Select one of your pieces." to a player who had been told nothing.
    await fit();
    await clickCell(cell);
    const plain = { x: cell.x + 2, y: cell.y + 1 };
    const before = await wireLen();
    await clickCell(plain);
    await sleep(500);
    const plainOut = { toast: await toast(), wire: await wireFrom(before) };
    const dropped = /Select one of your pieces/i.test(plainOut.toast)
      && orders(plainOut.wire).length === 0 && !/refus|cannot|No route/i.test(plainOut.toast);
    mark("item 5 a plain land cell near Washington never drops the selection with the hint",
      !dropped, plainOut);
    mark("item 5 an accepted order says the selection it cleared",
      orders(plainOut.wire).length === 0 || /Selection cleared\./.test(plainOut.toast),
      { toast: plainOut.toast, orders: orders(plainOut.wire) });
  }

  mark("no page errors", pageErrors.length === 0, { pageErrors });
} catch (err) {
  mark("the script ran to the end", false, { error: String(err && err.stack ? err.stack : err), pageErrors });
} finally {
  await browser.close();
  const passed = evidence.filter((e) => e.ok).length;
  console.log("");
  console.log("t030 ac8 fix summary (" + BASE + "): " + passed + " passed, " + reds + " failed, " + evidence.length + " checks");
  process.exit(reds ? 1 : 0);
}
