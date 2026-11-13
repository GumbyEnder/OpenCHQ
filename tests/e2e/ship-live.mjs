// T-010 AC4 / PB-004: a warship ordered across open sea on the LIVE build, and arriving.
//
//   node tests/e2e/ship-live.mjs --url=https://openchq-web-production.up.railway.app
//
// A 1942 blue seat buys a cruiser, orders it to a sea cell roughly twenty cells away, and the run
// reads the server's own path: every step must be water on the board payload (no dry cell, no jump),
// and the piece must arrive on the cell it was sent to. Screenshots: the order with its route drawn,
// the crossing, and the arrival.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = (arg("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) { console.error("usage: node ship-live.mjs --url=<live base>"); process.exit(2); }
const ERA = arg("era", "1942");
const OUT = path.join(here, "t010-ship-" + new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const summary = { base: BASE, era: ERA, startedAt: new Date().toISOString() };
const mark = (ok, label, detail = "") => {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
};
const W = 320;
const wrapX = (x) => ((x % W) + W) % W;
const dist = (a, b) => {
  const raw = Math.abs(a.x - b.x);
  return Math.max(Math.min(raw, W - raw), Math.abs(a.y - b.y));
};

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err.message)));
const room = () => page.evaluate(() => window.__chq.room());
async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}
async function clickCell(cell) {
  // The board is at fit zoom for this run, so every cell of the world is on the canvas: no pan is
  // needed and the click is on the cell the server named.
  await page.click("#camFit").catch(() => {});
  await sleep(150);
  const pt = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.click(pt.x, pt.y);
  return true;
}
async function orderTo(pieceId, cell) {
  const cur = await room();
  const me = (cur.pieces || []).find((p) => p.id === pieceId);
  if (!me) return { ok: false, why: "piece not in the view" };
  await clickCell({ x: me.x, y: me.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 6000 }).catch(() => {});
  const selected = await page.evaluate(() => window.__chq.state().selected);
  if (String(selected) !== String(pieceId)) return { ok: false, why: "not selected" };
  const pt = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.move(pt.x, pt.y);
  await sleep(300);
  const note = await page.evaluate(() => (document.querySelector("#boardNote") || {}).textContent || "");
  await clickCell(cell);
  await page
    .waitForFunction(
      (id) => {
        const r = window.__chq.room();
        const p = (r.pieces || []).find((x) => x.id === id);
        return p && Array.isArray(p.path) && p.path.length > 0;
      },
      pieceId,
      { timeout: 8000, polling: 100 }
    )
    .catch(() => {});
  const after = await room();
  const piece = (after.pieces || []).find((p) => p.id === pieceId);
  return { ok: Boolean(piece && Array.isArray(piece.path) && piece.path.length > 0), note: note.slice(0, 160), path: piece ? piece.path.length : 0 };
}
// Frame the ship: the fit view is the whole world at ~5 px a cell, which is honest for the route
// but unreadable for a marker. Zoom in and follow the selected piece, the way a player would.
async function focusShip() {
  await page.click("#camIn").catch(() => {});
  await sleep(150);
  await page.click("#camIn").catch(() => {});
  await sleep(150);
  await page.click("#camFollow").catch(() => {});
  await sleep(400);
}
async function setClock(want) {
  for (let i = 0; i < 20; i++) {
    if (String((await room()).clock) === want) return true;
    await page.click("#clockBtn").catch(() => {});
    await sleep(250);
  }
  return String((await room()).clock) === want;
}
async function setSpeed(want) {
  for (let i = 0; i < 40; i++) {
    if (Number((await room()).speed) === want) break;
    await page.click(Number((await room()).speed) < want ? "#speedUp" : "#speedDown").catch(() => {});
    await sleep(200);
  }
  return Number((await room()).speed);
}

let shipId = null;
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  summary.version = version;
  mark(Boolean(version && version.short), "live build", version);

  const name = "sh" + Date.now().toString(36).slice(-8);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  summary.user = name;
  mark(true, "registered a throwaway user", name);

  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e, ERA, { timeout: 30000, polling: 100 });
  await page.click("#camFit").catch(() => {});
  await setSpeed(6);
  mark(Number((await room()).speed) === 6, "speed 6", Number((await room()).speed));

  // Buy a cruiser as near the open Atlantic as the mask allows: the western third of the board is
  // water and no land unit can contest it, so the crossing is a sea leg and nothing else.
  // Arm a cruiser the way a player does, retrying the click while the strip settles: the nav and
  // the Buy rows are built after the room frame, and a click that lands too early does nothing.
  await page.click('#clockBtn').catch(() => {});
  let armed = false;
  for (let attempt = 0; attempt < 6 && !armed; attempt++) {
    await page.waitForSelector('#nav button[data-dialog="buy"]', { timeout: 15000 }).catch(() => {});
    await page.click('#nav button[data-dialog="buy"]').catch(() => {});
    await sleep(400);
    await page.click('button.buyrow[data-kind="cruiser"]').catch(() => {});
    armed = await page
      .waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
      .then(() => true)
      .catch(() => false);
    if (!armed) await sleep(1000);
  }
  mark(armed, "the cruiser row armed a placement", { armed, cash: (await room()).seat.cash });
  const cells = await page.evaluate(() => window.__chq.legalCells(6000));
  const cur = await room();
  const taken = new Set((cur.pieces || []).map((p) => p.x + "," + p.y));
  const site = new Set((cur.sites || []).map((s) => s.x + "," + s.y));
  const pick = cells
    .filter((c) => !taken.has(c.x + "," + c.y) && !site.has(c.x + "," + c.y) && c.x < 120)
    .sort((a, b) => a.x - b.x)[0] || cells[0];
  mark(Boolean(pick), "a cruiser is armed and the mask names a legal sea cell", pick);
  const had = new Set((cur.pieces || []).map((p) => p.id));
  await clickCell(pick);
  await page.waitForFunction((n) => window.__chq.room().pieces.some((p) => !n.includes(p.id)), [...had], { timeout: 20000 }).catch(() => {});
  const after = await room();
  const ship = (after.pieces || []).find((p) => !had.has(p.id));
  mark(Boolean(ship && ship.domain === "sea" && ship.transport !== true), "the bought piece is a warship", ship && { id: ship.id, kind: ship.kind, domain: ship.domain, transport: ship.transport, x: ship.x, y: ship.y });
  shipId = ship && ship.id;
  await page.keyboard.press("Escape").catch(() => {});

  // Destination: a water cell about twenty cells away, preferring a different sea area. The board
  // payload's cells are the authority on what is water, so the ship is never sent onto land.
  const board = await page.evaluate(() => window.__chq.board());
  const water = (x, y) => {
    const id = board.cells[y * W + wrapX(x)];
    return id === 0 || id === 2;
  };
  const start = { x: Number(ship.x), y: Number(ship.y) };
  const candidates = [];
  for (let y = 4; y < 130; y++) {
    for (let x = 0; x < W; x++) {
      if (!water(x, y)) continue;
      const d = dist(start, { x, y });
      if (d >= 18 && d <= 30) candidates.push({ x, y, d });
    }
  }
  candidates.sort((a, b) => b.d - a.d);
  const target = candidates[0];
  mark(Boolean(target), "a sea destination ~20 cells away exists", target);
  summary.ship = { id: shipId, start, target };

  const ordered = await orderTo(shipId, target);
  mark(ordered.ok, "the cruiser accepted an order across open sea", ordered);
  // Hold the clock the moment the order lands, or the route is eaten one cell per round before it
  // can be read back (speed 6 is 0.6 s a round): the path is the evidence, not a screenshot alone.
  await setClock("held");
  await focusShip();
  await shot("01-ordered-with-route.png");

  // The path itself: every step is water, and no step is a jump.
  const withPath = (await room()).pieces.find((p) => p.id === shipId);
  const steps = (withPath && withPath.path) || [];
  const dry = steps.filter((s) => !water(s.x, s.y));
  const jumps = steps.filter((s, i) => {
    const prev = i === 0 ? start : steps[i - 1];
    return dist(prev, s) > 1;
  });
  summary.path = { steps: steps.length, dry: dry.length, jumps: jumps.length };
  mark(steps.length > 0, "the server's route has steps", steps.length);
  mark(dry.length === 0, "every step of the sea route is water", dry.slice(0, 5));
  mark(jumps.length === 0, "the route never jumps a cell", jumps.slice(0, 5));

  // Sail it: watch until the piece arrives on the target with an empty path.
  await setClock("running");
  const deadline = Date.now() + 240000;
  let arrived = false;
  let midShot = false;
  while (Date.now() < deadline) {
    const now = (await room()).pieces.find((p) => p.id === shipId);
    if (!now) break;
    if (!midShot && dist(start, { x: now.x, y: now.y }) >= 8) {
      midShot = true;
      await setClock("held");
      await focusShip();
      await shot("02-crossing.png");
      summary.crossingAt = { x: now.x, y: now.y, round: (await room()).round, left: (now.path || []).length };
      await setClock("running");
    }
    if (now.x === target.x && now.y === target.y && (!now.path || now.path.length === 0)) { arrived = true; break; }
    await sleep(300);
  }
  const fin = (await room()).pieces.find((p) => p.id === shipId);
  summary.arrival = fin && { x: fin.x, y: fin.y, path: (fin.path || []).length, round: (await room()).round };
  mark(arrived, "the cruiser arrived on the sea cell it was sent to", summary.arrival);
  await focusShip();
  await shot("03-arrived.png");
  mark(errors.length === 0, "no page error during the crossing", errors);
} catch (err) {
  mark(false, "run threw", String(err && err.message ? err.message : err));
  summary.error = String(err && err.stack ? err.stack : err);
} finally {
  summary.rows = rows;
  summary.failed = rows.filter((x) => !x.ok).length;
  summary.endedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("summary " + path.join(OUT, "summary.json"));
  console.log(summary.failed === 0 ? "SHIP_OK" : "SHIP_FAILED rows=" + summary.failed);
  await browser.close();
  process.exit(0);
}
