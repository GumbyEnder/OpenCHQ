// T-014 AC5 frame-time gate: how long one full paint of the board costs, at the whole-world fit and
// at a close zoom, on a 1942 round-0 board with the original 60-piece army.
//
//   node frame-time.mjs --url=http://127.0.0.1:8106 [--samples=25] [--zoom=3]
//
// It times `window.__chq.paint()`, which calls the page's own drawMatch() and then forces the canvas
// command queue to flush with a one-pixel readback, so the number includes rasterisation and not just
// the JS that builds the frame. Nothing else is stubbed: sign-in, Play a bot and the era are the real
// page.
//
// The run prints the median and the p90 for both views and writes a JSON summary next to the run.
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
if (!BASE) { console.error("usage: node frame-time.mjs --url=<local base>"); process.exit(2); }
const SAMPLES = Math.max(5, Number(arg("samples", "25")) || 25);
const ERA = arg("era", "1942");
const ZOOM_STEPS = Math.max(1, Number(arg("zoom", "3")) || 3);
const OUT = path.join(here, "t014-frame-time-" + new Date().toISOString().replace(/[:.]/g, "-"));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch {}
  }
  return await import("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function p90(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "framee2e" + Date.now().toString(36).slice(-8);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  }

  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e,
    ERA, { timeout: 30000, polling: 100 });
  // Round 0 with the whole army on the board and nothing in flight.
  await page.waitForFunction(() => {
    const r = window.__chq.room();
    return r && Array.isArray(r.pieces) && r.pieces.length > 0;
  }, null, { timeout: 30000, polling: 100 });

  const describe = await page.evaluate(() => {
    const r = window.__chq.room();
    return { era: String(r.era), round: Number(r.round), pieces: r.pieces.length,
      own: r.pieces.filter((p) => p.side === r.you).length };
  });

  const takeSamples = async (label) => {
    const times = [];
    for (let i = 0; i < SAMPLES; i++) {
      const ms = await page.evaluate(() => window.__chq.paint());
      if (!Number.isFinite(ms)) throw new Error("paint() returned a non-number at " + label);
      times.push(ms);
      await sleep(16);
    }
    return { label, median: median(times), p90: p90(times), min: Math.min(...times), max: Math.max(...times), samples: times.length };
  };

  // ---- whole-world fit ------------------------------------------------------
  // The camera buttons are zero-width inside the in-match strip, so the click is dispatched rather
  // than pointed at: it runs the same handler the button's own listener does.
  await page.evaluate(() => document.getElementById("camFit").click());
  await page.waitForTimeout(150);
  const fitView = await page.evaluate(() => window.__chq.state().camera);
  const fit = await takeSamples("fit");

  // ---- close zoom -----------------------------------------------------------
  for (let i = 0; i < ZOOM_STEPS; i++) {
    await page.evaluate(() => document.getElementById("camIn").click());
    await page.waitForTimeout(80);
  }
  const zoomView = await page.evaluate(() => window.__chq.state().camera);
  const zoom = await takeSamples("zoomed");

  const cellsAcross = await page.evaluate(() => {
    const c = document.getElementById("board");
    return { backingW: c.width, cssW: Math.round(c.getBoundingClientRect().width) };
  });

  const summary = { url: BASE, era: describe.era, round: describe.round, pieces: describe.pieces,
    ownPieces: describe.own, fitView, zoomView, cellsAcross, samples: SAMPLES, fit, zoom,
    pageErrors: errors, at: new Date().toISOString() };
  const file = path.join(OUT, "summary.json");
  writeFileSync(file, JSON.stringify(summary, null, 2));

  console.log("era " + describe.era + " · round " + describe.round + " · " + describe.pieces +
    " pieces in sight (" + describe.own + " own)");
  console.log("canvas backing " + cellsAcross.backingW + " px, css " + cellsAcross.cssW + " px");
  console.log("fit view   scale " + fitView.scale + " dev px/cell — median " + fit.median.toFixed(2) +
    " ms, p90 " + fit.p90.toFixed(2) + " ms");
  console.log("zoomed     scale " + zoomView.scale + " dev px/cell — median " + zoom.median.toFixed(2) +
    " ms, p90 " + zoom.p90.toFixed(2) + " ms");
  if (errors.length) console.log("page errors: " + errors.join(" | "));
  console.log("summary " + file);

  await browser.close();
  return summary;
}

main().then((s) => {
  if (!s.pieces) process.exit(1);
}).catch((error) => {
  console.error("FAIL " + (error && error.message ? error.message : error));
  process.exit(1);
});
