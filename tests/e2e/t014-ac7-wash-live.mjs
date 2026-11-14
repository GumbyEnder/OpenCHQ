// T-014 AC7 live shot: the cyan placement wash, with unit badges on the board, captured on the
// production URL while the mask is actually armed. No camera move between arm and capture, so the
// frame the player sees is the frame in the PNG.
//
//   node t014-ac7-wash-live.mjs --url=https://openchq-web-production.up.railway.app \
//        --out=/mnt/nas/projects/OpenCHQ/local/t014-shots --tag=live-ac7
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = (arg("url", "") || "").replace(/\/+$/, "");
const OUT = arg("out", "/mnt/nas/projects/OpenCHQ/local/t014-shots");
const TAG = arg("tag", "live-ac7");
const ERA = arg("era", "1942");
const ZOOM = Number(arg("zoom", "2"));
if (!BASE) { console.error("usage: node t014-ac7-wash-live.mjs --url=<base> --out=<dir> [--tag=live-ac7]"); process.exit(2); }

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch {}
  }
  return await import("playwright");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GRAB = () => {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  window.__beforeShot = { data: img.data, width: img.width, height: img.height };
  return { width: img.width, height: img.height };
};

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
    out.push({ x: cell.x, y: cell.y, ready: cell.ready, unready: cell.unready, px, py,
      before: was, after: [now[0], now[1], now[2]], changed });
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
    const name = "ac7w" + Date.now().toString(36).slice(-8);
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
  const version = await page.evaluate(async () => (await fetch("/api/version")).json());

  await page.evaluate(() => document.getElementById("camFit").click());
  await sleep(400);
  const shots = [];
  const shot = async (name, note) => {
    const file = path.join(OUT, TAG + "-" + name + ".png");
    await page.screenshot({ path: file });
    shots.push({ name, file, note });
    return file;
  };

  const badgesBefore = await page.evaluate(() => {
    const r = window.__chq.room();
    return { pieces: r.pieces.length, own: r.pieces.filter((p) => p.side === r.you).length,
      kinds: [...new Set(r.pieces.map((p) => p.kind || "untyped"))] };
  });
  const grab = await page.evaluate(GRAB);
  await shot("wash-off-fit", "live, 1942 round 0, full-map fit, no placement armed (control)");

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Buy");
    button.click();
  });
  await sleep(350);
  const row = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".buytable .buyrow:not(.head)")].filter((r) => !r.disabled);
    const land = rows.find((r) => !/sub|carrier|cruiser|ship|hull/i.test(r.dataset.kind || ""));
    const pick = land || rows[0];
    if (!pick) return { ok: false };
    pick.click();
    return { ok: true, kind: pick.dataset.kind || null };
  });
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000, polling: 100 });
  // Let one full draw land, then measure and capture without touching the camera.
  await sleep(500);
  // A leg that samples nothing has measured nothing: it must fail, never print as a pass.
  const measure = (label, snap) => {
    const hot = snap.filter((s) => s.changed > 12);
    if (!snap.length) throw new Error(label + " sampled 0 legal cells — nothing was measured, so this is not a pass");
    if (!hot.length) throw new Error(label + " sampled " + snap.length + " legal cells but none changed — the wash is not on screen");
    return hot;
  };
  const samples = await page.evaluate(SAMPLE_LEGAL);
  const changed = measure("wash-fit", samples);
  const armedShot = await shot("wash-fit", "live, full-map fit, infantry armed: cyan ready wash over held city cells, unit badges still drawn");

  // Zoom while still armed; the mask repaints under the camera, so the same wash is measured again.
  // Two steps, not four: four lands past the legal cells and the leg samples nothing (T-014a proof fix).
  // --zoom=<n> exists so the 0-sample guard can be demonstrated: node ... --zoom=6 must exit 1.
  for (let i = 0; i < ZOOM; i++) { await page.evaluate(() => document.getElementById("camIn").click()); await sleep(90); }
  await page.mouse.move(8, 8);
  await sleep(500);
  const zoomSamples = await page.evaluate(SAMPLE_LEGAL);
  const zoomChanged = measure("wash-zoom", zoomSamples);
  const zoomShot = await shot("wash-zoom-armed", "live, close zoom, still armed: wash on the offered city cells with badges on the board");

  const summary = {
    url: BASE, version, tag: TAG, era: ERA, canvas: grab, armedRow: row, badges: badgesBefore,
    placementCells: samples.length,
    readyCells: samples.filter((s) => s.ready).length,
    unreadyCells: samples.filter((s) => s.unready).length,
    washFit: { sampled: samples.length, changed: changed.length,
      cells: samples.slice(0, 5).map((s) => ({ x: s.x, y: s.y, before: s.before, after: s.after, changed: s.changed })) },
    washZoom: { sampled: zoomSamples.length, changed: zoomChanged.length,
      cells: zoomSamples.slice(0, 5).map((s) => ({ x: s.x, y: s.y, before: s.before, after: s.after, changed: s.changed })) },
    shots, pageErrors: errors, at: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, TAG + "-wash-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

main().catch((e) => { console.error("FAIL " + (e && e.stack ? e.stack : e)); process.exit(1); });
