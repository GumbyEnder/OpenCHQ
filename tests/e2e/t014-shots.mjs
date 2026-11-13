// T-014 evidence shots: the same 1942 round-0 board, twice, at the whole-world fit and zoomed in,
// with the hover tooltip up and the Kit legend open.
//
//   node t014-shots.mjs --url=http://127.0.0.1:8107 --out=/mnt/nas/projects/OpenCHQ/local/t014-shots --tag=after
//
// The screenshots are written outside the repo on purpose: they are board pixels of a live match.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
};
const BASE = (arg("url", "") || "").replace(/\/+$/, "");
const OUT = arg("out", "/mnt/nas/projects/OpenCHQ/local/t014-shots");
const TAG = arg("tag", "after");
const ERA = arg("era", "1942");
if (!BASE) { console.error("usage: node t014-shots.mjs --url=<base> --out=<dir> --tag=<label>"); process.exit(2); }

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch {}
  }
  return await import("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const name = "t014" + Date.now().toString(36).slice(-8);
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
  await page.waitForFunction(() => (window.__chq.room().pieces || []).length > 0, null, { timeout: 30000, polling: 100 });

  const shots = [];
  const shot = async (name, note) => {
    const file = path.join(OUT, TAG + "-" + name + ".png");
    await page.screenshot({ path: file });
    shots.push({ name, file, note });
    return file;
  };

  const counts = await page.evaluate(() => {
    const r = window.__chq.room();
    return { round: r.round, pieces: r.pieces.length, own: r.pieces.filter((p) => p.side === r.you).length,
      kinds: [...new Set(r.pieces.map((p) => p.kind || "untyped"))] };
  });

  // --- whole-world fit ------------------------------------------------------
  await page.evaluate(() => document.getElementById("camFit").click());
  await sleep(250);
  await shot("fit", "1942 round 0, whole-world fit");
  const footer = await page.evaluate(() => document.getElementById("boardNote").textContent);

  // --- hover a piece --------------------------------------------------------
  const target = await page.evaluate(() => {
    const r = window.__chq.room();
    const mine = r.pieces.filter((p) => p.side === r.you);
    const piece = mine.find((p) => p.strength !== undefined) || mine[0];
    const at = window.__chq.cellToScreen(piece.x, piece.y);
    return { id: piece.id, kind: piece.kind || null, x: Math.round(at.x), y: Math.round(at.y) };
  });
  await page.mouse.move(target.x, target.y);
  await sleep(250);
  const tip = await page.evaluate(() => {
    const el = document.getElementById("badgeTip");
    return el ? { text: el.textContent, hidden: el.classList.contains("hidden") } : null;
  });
  await shot("hover", "hover tooltip on " + String(target.kind || target.id));

  // --- zoomed in ------------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => document.getElementById("camIn").click());
    await sleep(80);
  }
  await page.mouse.move(10, 10);
  await sleep(200);
  await shot("zoom", "1942 round 0, close zoom");

  // --- the Kit legend -------------------------------------------------------
  await page.evaluate(() => document.getElementById("camFit").click());
  await sleep(150);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__chq && window.__chq_kit ? null : null);
  await page.keyboard.press("b"); // make sure no dialog is open, then close it
  await sleep(150);
  await page.keyboard.press("Escape");
  await sleep(100);
  // The Kit panel is a nav button in the dialog bar.
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Kit");
    if (!button) return false;
    button.click();
    return true;
  });
  await sleep(300);
  if (opened) await shot("kit-legend", "Kit panel with the unit legend");

  const summary = { url: BASE, tag: TAG, era: ERA, counts, footer, tip, target, shots,
    pageErrors: errors, at: new Date().toISOString() };
  writeFileSync(path.join(OUT, TAG + "-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

main().catch((error) => { console.error("FAIL " + (error && error.stack ? error.stack : error)); process.exit(1); });
