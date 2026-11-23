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
//         ABOVE the capital marker (and, by the paint order, the city labels too - the pixel probe
//         only discriminates the capital, so the pin is named for what it measures). Checked by the
//         ring's own edge pixels.
// Item 4  AC4 note: while a selection exists the board note keeps naming it, whatever the cursor did
//         last (route hover and leave, political view, an unscreened transport).
// Item 5  PB-052 residue: a refused destination says why and keeps the selection.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

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
// How many CSS px one cell is on screen, measured now (the camera can be at a fractional fit).
async function cellWidth(cell) {
  const a = await pointOf(cell.x, cell.y);
  const b = await pointOf(cell.x + 1, cell.y);
  return Math.abs(b.x - a.x);
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
  // Provenance, not a pin: /api/version cannot fail while the page has loaded, so it is printed
  // and never counted. Identity is proven where it can be measured - the served-file md5 versus
  // the git blob at the gate sha, in the run-gate log.
  const version = await ev(() => fetch("/api/version").then((r) => r.json()));
  console.log("served version " + JSON.stringify(version));
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
    // click a whole pixel off the centre is still ON the badge and must not order. One pixel, not
    // three: the ring is capped at 0.6 cell (2.3-2.65 px at the fit, where a cell is ~4 px), which is
    // exactly the two-sided constraint - it must absorb a pointer miss on the badge AND leave the
    // neighbouring cell's icon centre a destination (room 5641 item 3; the whole-pixel flooring case
    // is pinned in web/test/nodes/selection_hit.mjs). A 2-3 px miss at the fit is a destination, and
    // the hover note ("Route: N rounds. Click to send the order.") names that before the click.
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
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
    mark("item 1 a re-click on the badge (1 px off centre) never orders and keeps the selection",
      stray.length === 0, { offsets, stray });

    // The other half of the PM's ruling (room 5765): at the fit the one-cell move wins. A cell is
    // 4.41 px there and the ring is 2.65 px, so a miss past the ring is in the neighbouring cell and
    // must send the order, not reselect. The offset is 4 px, not 3, because the pointer is reported
    // in whole CSS pixels and this fit phase truncates 364.79 + 3 to clientX 367, i.e. 2.0 canvas px
    // - still inside the ring. 4 px floors to 2.7-3.6 canvas px, always outside it and always in the
    // neighbouring cell. Under the old `scale - 0.5` cap (ring 3.91 px) this click reselected and
    // nothing reached the wire.
    await page.keyboard.press("Escape");
    await sleep(140);
    await clickCell(cell);
    before = await wireLen();
    await clickCell(cell, 4, 0);
    const fitMissWire = await wireFrom(before);
    const fitMissState = await state();
    mark("item 1 at the fit a 4 px miss is a one-cell move, not a reselect",
      orders(fitMissWire).length > 0 && /^Order sent/.test(await toast()),
      { missPx: 4, wire: fitMissWire, toast: await toast(), selected: fitMissState.selected });
    await page.keyboard.press("Escape");
    await sleep(140);

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

    // Room 5765's rule at z2 and up, in the words the PM used: a cell is 8 px or more there, so a
    // 1-2 px miss on the badge is forgiven - the click stays a selection and sends nothing. This leg
    // is green under the 1 px ring mutant too, and that is honest rather than a hole: a 2 px miss at
    // a 8.8 px cell is inside the piece's OWN cell, so the own-cell clause keeps the selection
    // whatever the ring does. The ring's own share of the forgiveness is the half-cell leg below.
    {
      await fit();
      await clickCell(cell);
      let dx = await cellWidth(cell);
      for (let i = 0; i < 8 && dx < 8; i++) {
        await page.keyboard.press("+");
        await sleep(170);
        dx = await cellWidth(cell);
      }
      await centreOn(cell);
      dx = await cellWidth(cell);
      const zScale = (await state()).camera.scale;
      before = await wireLen();
      await clickCell(cell, 2, 0);
      const zWire = await wireFrom(before);
      const zState = await state();
      mark("item 1 a 2 px miss on the badge is forgiven at z" + zScale.toFixed(2),
        orders(zWire).length === 0 && String(zState.selected) === String(piece.id),
        { cellPx: Number(dx.toFixed(3)), missPx: 2, scale: zScale, wire: zWire,
          toast: await toast(), selected: zState.selected });
      await page.keyboard.press("Escape");
      await sleep(140);
    }

    // The ring's own forgiveness when zoomed: a miss past HALF a cell means the pointer's cell is the
    // neighbour, so the own-cell clause no longer saves it - the 0.6 cell reserved radius does. At a
    // 32 px cell that window is 16-19.2 px; 0.53 cell is inside it. Shrinking the ring to 1 px (M7)
    // turns this click into a destination, which is what makes this leg the ring's witness.
    {
      await fit();
      await clickCell(cell);
      let dx = await cellWidth(cell);
      for (let i = 0; i < 20 && dx < 26; i++) {
        await page.keyboard.press("+");
        await sleep(170);
        dx = await cellWidth(cell);
      }
      await centreOn(cell);
      dx = await cellWidth(cell);
      const off = Math.round(dx * 0.53);
      const hcScale = (await state()).camera.scale;
      before = await wireLen();
      await clickCell(cell, off, 0);
      const hcWire = await wireFrom(before);
      const hcState = await state();
      mark("item 1 a half-cell miss on the badge is forgiven when zoomed (z" + hcScale + ")",
        orders(hcWire).length === 0 && String(hcState.selected) === String(piece.id),
        { cellPx: Number(dx.toFixed(3)), missPx: off, scale: hcScale, wire: hcWire,
          toast: await toast(), selected: hcState.selected });
      await page.keyboard.press("Escape");
      await sleep(140);
    }

    // The PM's own repro (shot 05-escape): a click the player read as a selection, then Escape
    // before the ack lands. The order must never be on the wire, so nothing can overwrite the clear.
    //
    // Two zooms, because the two-sided constraint has no room at the fit: the ring must absorb a
    // pointer miss on the badge AND leave the neighbouring cell's icon centre a destination, and at
    // the fit those are 2.2 px and 4.4 px apart. So the fit leg uses a 1 px miss (the largest miss
    // that is unambiguously on the badge at a 4 px cell) and the x4 leg uses a half-cell miss -
    // 17 px inside a badge whose half is 22.5 px. That x4 leg is also the one that is RED at
    // e9a8bfa: base had no ring, so anything past half a cell (16 px at x4) fell through to a
    // destination and its ack repainted the clear with "Order sent. N rounds to walk.".
    await fit();
    const cellDx = async () => {
      const a = await pointOf(cell.x, cell.y);
      const b = await pointOf(cell.x + 1, cell.y);
      return Math.abs(b.x - a.x);
    };
    const missSeen = [];
    for (const leg of [0, 1]) {
      await fit();
      await clickCell(cell);
      let dx = await cellDx();
      // Leg 2: zoom until a cell is at least 26 px. That is the smallest cell where the two sides of
      // the constraint are more than a pixel apart ON SCREEN: the ring is 0.6 cell (15.6 px), base's
      // own-cell clause is 0.5 cell (13 px), and a pointer click floors by up to 1 px, so a 14 px
      // miss reselects at the head and still fell through to a destination at e9a8bfa.
      if (leg === 1) {
        for (let i = 0; i < 20 && dx < 26; i++) {
          await page.keyboard.press("+");
          await sleep(170);
          dx = await cellDx();
        }
        await centreOn(cell);
        dx = await cellDx();
      }
      const off = leg === 0 ? 1 : Math.round(dx * 0.54);
      const scale = (await state()).camera.scale;
      before = await wireLen();
      const p = await pointOf(cell.x, cell.y);
      await page.mouse.move(p.x - off, p.y);
      await sleep(60);
      await page.mouse.click(p.x - off, p.y);
      await page.keyboard.press("Escape");
      await sleep(1200);
      const legWire = await wireFrom(before);
      const legToast = await toast();
      missSeen.push({ leg, cellPx: Number(dx.toFixed(3)), offPx: off, scale, orders: orders(legWire),
        toast: legToast, wire: legWire, selected: (await state()).selected });
    }
    mark("item 1 a badge click immediately followed by Escape puts no order on the wire",
      missSeen.every((m) => m.orders.length === 0 && /^Selection cleared\.$/.test(m.toast) && m.selected === null),
      { legs: missSeen });
    await fit();

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
    mark("item 3 the ring is drawn above the capital marker (its top edge is unbroken)",
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
