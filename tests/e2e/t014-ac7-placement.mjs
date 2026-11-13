// T-014 AC7: the placement wash (cyan ready / amber unready) and the city squares stay readable
// while badges are on the board (PB-029).
//
//   node t014-ac7-placement.mjs --url=http://127.0.0.1:8107 --out=/mnt/nas/projects/OpenCHQ/local/t014-shots
//
// Arming a Buy row is the player's own path: the page sends {op:"placement"}, the server answers with
// a mask, and paintPlacement paints it. Nothing here fakes a state.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = (arg("url", "") || "").replace(/\/+$/, "");
const OUT = arg("out", "/mnt/nas/projects/OpenCHQ/local/t014-shots");
const TAG = arg("tag", "ac7");
const ERA = arg("era", "1942");
if (!BASE) { console.error("usage: node t014-ac7-placement.mjs --url=<base> --out=<dir> [--tag=ac7]"); process.exit(2); }

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch {}
  }
  return await import("playwright");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Grab the whole canvas, so the same pixel can be read again after a state change. The camera does
// not move when a Buy row arms (paintPlacement uses the live view and the wash a deliberate no-pan
// rule), so a pixel coordinate taken at the fit is the same cell before and after.
const GRAB = () => {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  window.__beforeShot = { data: img.data, width: img.width, height: img.height };
  return { width: img.width, height: img.height };
};

// Sample the canvas at each legal cell's screen point, and diff against the grab.
const SAMPLE_LEGAL = () => {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = canvas.width / Math.max(1, rect.width);
  const before = window.__beforeShot;
  const out = [];
  for (const cell of window.__chq.legalCells(400)) {
    const at = window.__chq.cellToScreen(cell.x, cell.y);
    const px = Math.round((at.x - rect.left) * ratio);
    const py = Math.round((at.y - rect.top) * ratio);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    const now = ctx.getImageData(px, py, 1, 1).data;
    const i = (py * before.width + px) * 4;
    const was = [before.data[i], before.data[i + 1], before.data[i + 2]];
    const changed = Math.abs(now[0] - was[0]) + Math.abs(now[1] - was[1]) + Math.abs(now[2] - was[2]);
    out.push({ x: cell.x, y: cell.y, ready: cell.ready, px, py, before: was, after: [now[0], now[1], now[2]], changed });
  }
  return out;
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "ac7" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e, ERA,
    { timeout: 30000, polling: 100 });
  await page.waitForFunction(() => (window.__chq.room().pieces || []).length > 0, null, { timeout: 30000, polling: 100 });

  await page.evaluate(() => document.getElementById("camFit").click());
  await sleep(250);
  const shots = [];
  const shot = async (name, note) => {
    const file = path.join(OUT, TAG + "-" + name + ".png");
    await page.screenshot({ path: file });
    shots.push({ name, file, note });
  };

  // Baseline pixels with no wash armed, at the fit.
  const grab = await page.evaluate(GRAB);
  await shot("no-wash-fit", "full-map fit, no placement armed (control)");

  // Arm the first row the server will actually sell: a land unit, so the wash lands on cities.
  const armed = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Buy");
    if (!button) return { ok: false, why: "no Buy button" };
    button.click();
    return { ok: true };
  });
  await sleep(300);
  const row = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".buytable .buyrow:not(.head)")].filter((r) => !r.disabled);
    const land = rows.find((r) => {
      const kind = r.dataset.kind || "";
      return !/sub|carrier|cruiser|ship|hull/i.test(kind);
    });
    const pick = land || rows[0];
    if (!pick) return { ok: false, rows: document.querySelectorAll(".buytable .buyrow").length };
    pick.click();
    return { ok: true, kind: pick.dataset.kind || null, rows: document.querySelectorAll(".buytable .buyrow").length };
  });
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000, polling: 100 });
  await sleep(300);
  const legal = await page.evaluate(() => window.__chq.legalCells(400));
  const readyCells = legal.filter((c) => c.ready);
  const unreadyCells = legal.filter((c) => c.unready);
  const samples = await page.evaluate(SAMPLE_LEGAL);
  const changedCells = samples.filter((s) => s.changed > 12);
  await shot("wash-fit", "full-map fit, land unit armed: cyan/amber wash over badges and cities");

  // Put a badge on a legal cell the player's own way: buy the armed unit onto one of the cells the
  // server just offered. After the purchase `buying` clears, so the next click is a map click again.
  const target = readyCells[0] || legal[0] || null;
  let placed = null;
  let closeShot = null;
  if (target) {
    const at = await page.evaluate((c) => window.__chq.cellToScreen(c.x, c.y), target);
    await page.mouse.click(Math.round(at.x), Math.round(at.y));
    await page.waitForFunction((c) => {
      const r = window.__chq.room();
      return (r.pieces || []).some((p) => p.side === r.you && p.x === c.x && p.y === c.y);
    }, target, { timeout: 20000, polling: 100 });
    placed = await page.evaluate((c) => {
      const r = window.__chq.room();
      const piece = (r.pieces || []).find((p) => p.side === r.you && p.x === c.x && p.y === c.y);
      const at = piece ? window.__chq.cellToScreen(piece.x, piece.y) : null;
      return piece ? { id: piece.id, kind: piece.kind || null, strength: piece.strength,
        x: Math.round(at.x), y: Math.round(at.y) } : null;
    }, target);
  }

  // Zoom in, then pan the cell to the middle with the arrow keys the page already binds (8 cells a
  // press). Reset to the fit first so the zoom always starts from the same camera: the same call
  // reproduces the same frame, which is what makes the armed/unarmed pair comparable.
  const frameCell = async (cell) => {
    await page.evaluate(() => document.getElementById("camFit").click());
    await sleep(200);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => document.getElementById("camIn").click());
      await sleep(80);
    }
    await sleep(200);
    for (let attempt = 0; attempt < 12; attempt++) {
      const where = await page.evaluate((c) => {
        const rect = document.getElementById("board").getBoundingClientRect();
        const at = window.__chq.cellToScreen(c.x, c.y);
        return { x: at.x, y: at.y, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
      }, cell);
      const offX = where.cx - where.x, offY = where.cy - where.y;
      if (Math.abs(offX) < 20 && Math.abs(offY) < 20) break;
      const key = Math.abs(offX) > Math.abs(offY)
        ? (offX > 0 ? "ArrowLeft" : "ArrowRight")
        : (offY > 0 ? "ArrowUp" : "ArrowDown");
      await page.keyboard.press(key);
      await sleep(90);
    }
    await page.mouse.move(8, 8);
    await sleep(200);
  };
  if (target) await frameCell(target);

  // Re-arm: the same row, so the wash comes back while the badge sits on a legal city cell.
  const rearmed = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Buy");
    if (!button) return false;
    button.click();
    return true;
  });
  await sleep(250);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".buytable .buyrow:not(.head)")].filter((r) => !r.disabled);
    const land = rows.find((r) => !/sub|carrier|cruiser|ship|hull/i.test(r.dataset.kind || ""));
    (land || rows[0]).click();
  });
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000, polling: 100 });

  // The wash is painted after the pieces, so the honest question is what it does to the badge it
  // lands on. Grab the canvas with the wash up, then buy a second unit on another legal cell (which
  // ends the armed state without moving the camera) and grab the same frame again.
  const washAtZoom = await page.evaluate(() => {
    const canvas = document.getElementById("board");
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    window.__washShot = { data: img.data, width: img.width, height: img.height };
    return { width: img.width, height: img.height };
  });
  const camState = await page.evaluate((c) => {
    const at = c ? window.__chq.cellToScreen(c.x, c.y) : null;
    const canvas = document.getElementById("board").getBoundingClientRect();
    return { state: window.__chq.state(), cellScreen: at, canvas: { left: canvas.left, top: canvas.top, w: canvas.width, h: canvas.height } };
  }, target);
  await shot("wash-zoom", "close zoom: badge on a legal city cell under the cyan ready wash");
  if (placed) {
    closeShot = await page.evaluate((c) => {
      const canvas = document.getElementById("board");
      const ctx = canvas.getContext("2d");
      const at = window.__chq.cellToScreen(c.x, c.y);
      const rect = canvas.getBoundingClientRect();
      const ratio = canvas.width / Math.max(1, rect.width);
      const px = Math.round((at.x - rect.left) * ratio);
      const py = Math.round((at.y - rect.top) * ratio);
      const inside = px >= 0 && py >= 0 && px < canvas.width && py < canvas.height;
      const d = inside ? ctx.getImageData(px, py, 1, 1).data : [null, null, null];
      return { cell: c, at: [px, py], inside, rgb: [d[0], d[1], d[2]] };
    }, target);
  }
  // Does the mask still offer the cell the badge now stands on? That decides whether the wash and a
  // badge can ever share a cell in this build, which is the AC7 question stated properly.
  const overlap = await page.evaluate((c) => {
    const legal = window.__chq.legalCells(400);
    const hit = legal.find((l) => l.x === c.x && l.y === c.y);
    return { cell: c, offered: Boolean(hit), maskValue: hit ? (hit.unready ? 2 : 1) : 0, offeredCount: legal.length };
  }, target);

  // Disarm without moving the camera: buy one more unit on a different legal cell.
  const second = legal.find((c) => !(placed && c.x === target.x && c.y === target.y)) || null;
  let disarmed = null;
  if (second) {
    await page.evaluate(() => document.getElementById("camFit").click());
    await sleep(250);
    const at2 = await page.evaluate((c) => window.__chq.cellToScreen(c.x, c.y), second);
    await page.mouse.click(Math.round(at2.x), Math.round(at2.y));
    await page.waitForFunction(() => window.__chq.state().placement === false, null, { timeout: 20000, polling: 100 });
    await sleep(350);
    await frameCell(target);
    await shot("no-wash-zoom", "same frame, armed state over: the control for the wash diff");
    disarmed = await page.evaluate((c) => {
      const canvas = document.getElementById("board");
      const ctx = canvas.getContext("2d");
      const rect = canvas.getBoundingClientRect();
      const ratio = canvas.width / Math.max(1, rect.width);
      const at = window.__chq.cellToScreen(c.x, c.y);
      const px = Math.round((at.x - rect.left) * ratio);
      const py = Math.round((at.y - rect.top) * ratio);
      const before = window.__washShot;
      const span = 9;
      let changed = 0, total = 0;
      const box = [];
      for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
          const now = ctx.getImageData(x, y, 1, 1).data;
          const i = (y * before.width + x) * 4;
          const was = [before.data[i], before.data[i + 1], before.data[i + 2]];
          const delta = Math.abs(now[0] - was[0]) + Math.abs(now[1] - was[1]) + Math.abs(now[2] - was[2]);
          total++;
          if (delta > 12) changed++;
          if ((dy === 0 && dx === 0) || (dy === -span && dx === 0)) box.push({ dx, dy, wash: was, clean: [now[0], now[1], now[2]], delta });
        }
      }
      return { cell: c, at: [px, py], span, total, changed, samples: box };
    }, target);
  }
  await page.evaluate(() => document.getElementById("camFit").click());
  await sleep(300);
  await shot("wash-fit", "full-map fit: badges with the cyan ready wash over the held cities");

  const summary = {
    url: BASE, tag: TAG, era: ERA, canvas: grab, armedRow: row, armed: armed.ok,
    placementCells: legal.length, readyCells: readyCells.length, unreadyCells: unreadyCells.length,
    washOnCells: { sampled: samples.length, changed: changedCells.length,
      sample: samples.slice(0, 3).map((s) => ({ x: s.x, y: s.y, before: s.before, after: s.after, changed: s.changed })) },
    target, placed, camState, closeShot, washAtZoom, overlap, disarmed,
    shots, pageErrors: errors, at: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, TAG + "-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

main().catch((e) => { console.error("FAIL " + (e && e.stack ? e.stack : e)); process.exit(1); });
