// T-030 - selection feedback and reselect (PB-051, PB-052, PB-053).
//
//   node tests/e2e/t030-selection-feedback.mjs --url=http://127.0.0.1:8097 --out=.../local/t030-shots
//   node tests/e2e/t030-selection-feedback.mjs --url=https://openchq-web-production.up.railway.app --out=...
//
// AC1  a selected piece carries a visible mark at the world fit and both zooms, and in the second
//      map mode this build has (political). The check is PIXELS: the accent ink #ffe066 is sampled
//      out of the canvas around the badge, and the same sample after a clear must be empty.
// AC2  with A selected, clicking own B selects B and sends no order (the wire log is the witness).
// AC3  Escape and a right-click each clear the selection without an order.
// AC4  toast and board note never claim different selection states (select, reselect, clear, order).
// AC5  five long sea routes, at least one across the x seam, each drawn with no hop longer than half
//      the map (the page's own routeSpan, the same function the painter draws from).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { badgePx } from "../../web/public/badges.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/t030-selection-feedback.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "worktrees", "t030", "local", "t030-shots")));
mkdirSync(OUT, { recursive: true });
const ERA = argOf("era", "1942");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
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
let reds = 0;
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  if (!ok) reds += 1;
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail === undefined ? null : detail));
  writeFileSync(path.join(OUT, "t030-selection.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

const room = () => page.evaluate(() => window.__chq.room());
const state = () => page.evaluate(() => window.__chq.state());
const toast = () => page.evaluate(() => window.__chq.toast());
const note = () => page.evaluate(() => window.__chq.note());
const screenOf = (x, y) => page.evaluate(({ x: cx, y: cy }) => window.__chq.cellToScreen(cx, cy), { x, y });
const wireFrom = (from) => page.evaluate((f) => window.__chq.wire().slice(f), from);
const wireLen = () => page.evaluate(() => window.__chq.wire().length);

async function shot(name) {
  const file = path.join(OUT, "t030-" + name + ".png");
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

async function fit() {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(250);
  return (await state()).camera;
}

async function zoomPresses(times) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("+");
    await sleep(160);
  }
  return (await state()).camera;
}

async function panToCell(cell, tries = 160) {
  const vp = page.viewportSize();
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  for (let i = 0; i < tries; i++) {
    const at = await screenOf(cell.x, cell.y);
    let moved = false;
    if (at.x < cx - 40) { await page.keyboard.press("ArrowLeft"); moved = true; }
    else if (at.x > cx + 40) { await page.keyboard.press("ArrowRight"); moved = true; }
    if (at.y < cy - 40) { await page.keyboard.press("ArrowUp"); moved = true; }
    else if (at.y > cy + 40) { await page.keyboard.press("ArrowDown"); moved = true; }
    if (!moved) return at;
  }
  return screenOf(cell.x, cell.y);
}

async function clickAt(pt) {
  await page.mouse.click(pt.x, pt.y);
  await sleep(220);
}

async function clickCell(cell) {
  const pt = await panToCell(cell);
  return clickAt(pt);
}

async function hoverCell(cell) {
  const pt = await panToCell(cell);
  await page.mouse.move(pt.x, pt.y);
  await sleep(140);
}

// The accent ink the mark is drawn in, counted in the canvas around the piece. Device pixels: the
// rect ratio converts a CSS point into the canvas's own frame.
async function accentPixelsAt(cell) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const spot = window.__chq.cellToScreen(x, y);
    const px = (spot.x - rect.left) * ratio;
    const py = (spot.y - rect.top) * ratio;
    const ctx = canvas.getContext("2d");
    const span = Math.round(46 * ratio);
    const x0 = Math.max(0, Math.round(px) - span);
    const y0 = Math.max(0, Math.round(py) - span);
    const w = Math.min(canvas.width - x0, span * 2);
    const h = Math.min(canvas.height - y0, span * 2);
    const data = ctx.getImageData(x0, y0, w, h).data;
    // The mark's accent ink is opaque #ffe066. Match it exactly: a loose yellow threshold also
    // counted desert terrain, which made the "no mark after a clear" sample read 16 instead of 0.
    let accent = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 255 && data[i + 1] === 224 && data[i + 2] === 102) accent += 1;
    }
    return { accent, x0, y0, w, h };
  }, { x: cell.x, y: cell.y });
}

// What a line says about the selection. "none" is the page telling the player to select something,
// "selected" is a piece or a route being named, "neutral" is neither (an order ack, a clock line).
// A contradiction is one surface at "none" while the other is at "selected" - that is PB-053.
function selectionView(text) {
  const value = String(text || "");
  if (/Select one of your pieces/i.test(value)) return "none";
  if (/\bselected\b/i.test(value) || /Pick a destination/i.test(value) || /^Route:/i.test(value)) return "selected";
  return "neutral";
}
function contradictory(a, b) {
  return (selectionView(a) === "none" && selectionView(b) === "selected")
    || (selectionView(a) === "selected" && selectionView(b) === "none");
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), { version });

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t30" + Date.now().toString(36).slice(-6);
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

  const current = await room();
  const mine = (current.pieces || []).filter((p) => String(p.side) === current.you);
  const isolated = mine.find((piece) => !mine.some((other) => other.id !== piece.id
    && Math.abs(Number(other.x) - Number(piece.x)) <= 2 && Math.abs(Number(other.y) - Number(piece.y)) <= 2));
  const other = mine.find((piece) => piece.id !== (isolated && isolated.id) && piece.domain === (isolated && isolated.domain));
  mark("the match opened with two own pieces", Boolean(isolated && other), { isolated: isolated && isolated.id, other: other && other.id });
  if (!isolated || !other) throw new Error("no pair to test selection with");

  // ---- AC1: the mark is pixels, at the fit and both zooms ------------------------------------
  await fit();
  await clickCell(isolated);
  const selectedNow = (await state()).selected;
  mark("AC1 selecting the piece selects it", String(selectedNow) === String(isolated.id), { selected: selectedNow });
  const pulseA = await page.evaluate(() => window.__chq.selectPulse());
  await sleep(300);
  const pulseB = await page.evaluate(() => window.__chq.selectPulse());
  mark("AC1 the mark breathes (pulse advances while selected)", pulseA !== pulseB, { pulseA, pulseB });

  for (const [label, presses] of [["fit", 0], ["zoom1", 2], ["zoom2", 3]]) {
    await fit();
    if (presses) await zoomPresses(presses);
    await panToCell({ x: isolated.x, y: isolated.y });
    await clickCell(isolated);
    await sleep(200);
    const px = await accentPixelsAt({ x: isolated.x, y: isolated.y });
    mark("AC1 the selected mark is on screen at " + label, px.accent > 20, { camera: (await state()).camera, ...px });
    await shot("select-" + label);
  }

  // The second map mode this build has: political colours the same board. The mark does not depend
  // on the palette (casing + accent), and the sample has to survive the recolour.
  await fit();
  await page.keyboard.press("p");
  await sleep(250);
  await clickCell(isolated);
  const pxPolitical = await accentPixelsAt({ x: isolated.x, y: isolated.y });
  mark("AC1 the selected mark is on screen in the political view", pxPolitical.accent > 20, pxPolitical);
  await shot("select-political");
  await page.keyboard.press("p");
  await sleep(200);

  // Clearing removes it: the same sample goes empty.
  await page.keyboard.press("Escape");
  await sleep(250);
  const pxClear = await accentPixelsAt({ x: isolated.x, y: isolated.y });
  mark("AC1 the mark is gone after a clear", pxClear.accent === 0, pxClear);
  await shot("select-cleared");

  // ---- AC2: reselect sends no order -----------------------------------------------------------
  await fit();
  await clickCell(isolated);
  await clickCell(other);
  const afterReselect = await state();
  mark("AC2 clicking another own piece selects it", String(afterReselect.selected) === String(other.id),
    { selected: afterReselect.selected, wanted: other.id });
  const wireReselect = await wireFrom(0);
  const orders = wireReselect.filter((line) => /^ordered/.test(line) || /^order /.test(line));
  mark("AC2 the reselect sent no order", orders.length === 0, { orders: orders.slice(0, 4), wire: wireReselect.slice(-4) });

  // ---- AC3: Escape and right-click clear, no order --------------------------------------------
  const cancelWireFrom = await wireLen();
  await page.keyboard.press("Escape");
  await sleep(200);
  const afterEscape = await state();
  mark("AC3 Escape clears the selection", afterEscape.selected === null, { selected: afterEscape.selected, toast: await toast() });
  const wireCancel = await wireFrom(cancelWireFrom);
  mark("AC3 Escape sent no order", wireCancel.filter((line) => /^ordered/.test(line)).length === 0, { wire: wireCancel });

  await clickCell(other);
  const beforeRight = await wireLen();
  const canvasBox = await page.evaluate(() => {
    const rect = document.querySelector("canvas").getBoundingClientRect();
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 };
  });
  await page.mouse.click(canvasBox.x, canvasBox.y, { button: "right" });
  await sleep(250);
  const afterRight = await state();
  mark("AC3 right-click clears the selection", afterRight.selected === null, { selected: afterRight.selected, toast: await toast() });
  const wireRight = await wireFrom(beforeRight);
  mark("AC3 right-click sent no order", wireRight.filter((line) => /^ordered/.test(line)).length === 0, { wire: wireRight });

  // ---- AC4: toast and board note agree --------------------------------------------------------
  const pair = async (label) => {
    const t = await toast();
    const n = await note();
    const ok = !contradictory(t, n);
    mark("AC4 toast and note agree " + label, ok,
      { toast: t, note: n, views: [selectionView(t), selectionView(n)] });
    return ok;
  };
  await clickCell(isolated);
  await pair("after select");
  await clickCell(other);
  await pair("after reselect");
  await page.keyboard.press("Escape");
  await sleep(200);
  await pair("after clear");
  await clickCell(isolated);
  await hoverCell({ x: (Number(isolated.x) + 2) % 320, y: isolated.y });
  const orderWire = await wireLen();
  const dest = { x: (Number(isolated.x) + 2) % 320, y: isolated.y };
  await clickCell(dest);
  await sleep(600);
  const wireOrder = await wireFrom(orderWire);
  mark("AC4 an order was actually sent for the note check", wireOrder.some((line) => /^ordered|^error/.test(line)), { wire: wireOrder });
  await pair("after an order");

  // ---- One cell out still orders a move, at the fit and at zoom 2 and zoom 4 (PM 5641 item 3) --
  // The selected badge is wider than its cell, so a neighbour's centre sits INSIDE the selected
  // icon; the reserved-radius rule is what keeps that click a destination instead of a re-selection.
  // This is a real pointer click at each zoom, and the witness is the wire: an "ordered" frame for a
  // neighbour the page itself has previewed as a legal route. Numbers are printed for the report.
  const oneCellOut = [];
  // "zoom 2" and "zoom 4" are the second and fourth user-facing zoom steps (the + key / the
  // Cam + button), because the page has continuous zoom and no numbered levels. The measured cell
  // size is printed for each, and the node pin selection_hit covers literal 2 px and 4 px cells.
  for (const target of [0, 2, 4]) {
    await fit();
    if (target) await zoomPresses(target);
    const cam = (await state()).camera;
    const cellPx = Math.max(1, Math.round(cam.scale));
    const half = badgePx(cellPx, 14) / 2;
    await clickCell({ x: isolated.x, y: isolated.y });
    const selectedNow2 = (await state()).selected;
    if (String(selectedNow2) !== String(isolated.id)) {
      mark("one cell out: the piece could not be selected at " + (target || "fit"), false, { selected: selectedNow2 });
      continue;
    }
    // The eight neighbours, in order; the first one the page previews as a legal route is the
    // destination. A hover that says "Route:" is the server's own answer, not the test's guess.
    let picked = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const cell = { x: (Number(isolated.x) + dx + 320) % 320, y: Math.max(0, Math.min(135, Number(isolated.y) + dy)) };
      await hoverCell(cell);
      const span = await page.evaluate(() => window.__chq.previewSpan());
      const wanted = await note();
      if (span.has && /^Route:/.test(wanted)) { picked = { cell, dx, dy, rounds: span.rounds }; break; }
    }
    if (!picked) {
      mark("one cell out at cell " + cellPx + " px: a legal neighbour was previewed", false,
        { camera: cam, half, tried: "8 neighbours" });
      continue;
    }
    const inside = Math.max(Math.abs(picked.dx), Math.abs(picked.dy)) * cellPx <= half;
    const before = await wireLen();
    await clickAt(await panToCell(picked.cell));
    await sleep(600);
    const lines = await wireFrom(before);
    const ordered = lines.filter((line) => /^ordered/.test(line));
    const selectedAfter = (await state()).selected;
    mark("one cell out at cell " + cellPx + " px (badge half " + half + " px, click inside the icon: " + inside + ")"
      + " orders a move", ordered.length === 1 && selectedAfter === null,
      { camera: cam, cellPx, half, offset: [picked.dx, picked.dy], target: picked.cell, rounds: picked.rounds,
        wire: lines, selectedAfter });
    oneCellOut.push({ label: target || "fit", cellPx, half, inside, dx: picked.dx, dy: picked.dy,
      target: picked.cell, rounds: picked.rounds, ordered: ordered.length });
    await shot("one-cell-out-" + (target ? "zoom" + target : "fit"));
  }
  mark("one cell out ordered a move at the fit, zoom 2 and zoom 4",
    oneCellOut.length === 3 && oneCellOut.every((r) => r.ordered === 1), { measured: oneCellOut });

  // ---- AC5: five long sea routes, one across the seam -----------------------------------------
  const ships = mine.filter((p) => p.domain === "sea");
  await fit();
  const routes = [];
  for (const ship of ships.slice(0, 4)) {
    await clickCell(ship);
    for (let i = 1; i <= 10; i++) {
      const target = {
        x: (Number(ship.x) + i * 31) % 320,
        y: Math.max(2, Math.min(133, Math.round(Number(ship.y) + ((i % 3) - 1) * 12))),
      };
      await hoverCell(target);
      const span = await page.evaluate(() => window.__chq.previewSpan());
      const wanted = await note();
      if (span.has && span.points > 1 && /^Route:/.test(wanted)) {
        routes.push({ ship: ship.id, target, rounds: span.rounds, points: span.points, maxCells: span.maxCells, crossing: span.crossing });
      }
    }
  }
  routes.sort((a, b) => b.rounds - a.rounds);
  const sample = routes.slice(0, Math.max(5, Math.min(8, routes.length)));
  mark("AC5 at least five long sea routes were sampled", sample.length >= 5, { found: routes.length, sample: sample.map((r) => [r.ship, r.target.x, r.target.y, r.rounds]) });
  const overHalf = sample.filter((r) => !(r.maxCells <= 160));
  mark("AC5 no sampled route hops more than half the map", overHalf.length === 0,
    { worst: sample.map((r) => r.maxCells), offenders: overHalf });
  mark("AC5 a sampled route crosses the x seam", sample.some((r) => r.crossing), { sample: sample.map((r) => r.crossing) });
  if (sample.length) {
    const best = sample.find((r) => r.crossing) || sample[0];
    const shipPiece = mine.find((p) => p.id === best.ship);
    if (shipPiece) {
      await clickCell({ x: shipPiece.x, y: shipPiece.y });
      await hoverCell(best.target);
      await shot("route-preview");
    }
  }
  mark("no page errors", pageErrors.length === 0, { pageErrors });
} catch (err) {
  mark("the script ran to the end", false, { error: String(err && err.stack ? err.stack : err), pageErrors });
} finally {
  await browser.close();
  const passed = evidence.filter((e) => e.ok).length;
  console.log("");
  console.log("t030 summary (" + BASE + "): " + passed + " passed, " + reds + " failed, " + evidence.length + " checks");
  process.exit(reds ? 1 : 0);
}
