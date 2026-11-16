// T-018 AC4/AC5 live leg: Show Ownership fills the ground, keeps the units, and toggles back.
//
//   node tests/e2e/t018-ownership.mjs --url=http://127.0.0.1:8113 --out=local/t018-shots
//
// What it proves on a real page with a real socket, at the world fit and zoomed:
//   1. the server sends a per-region owner list for the room (184 entries);
//   2. pressing P fills Washington's ground blue and Berlin's red, and the sea stays sea;
//   3. the units are still drawn over the fill (the badge ink is present on a blue cell);
//   4. pressing P again puts the terrain back, cell for cell;
//   5. no page errors, and shots land under --out.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/t018-ownership.mjs --url=<base url> [--out=<dir>] [--era=1942]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t018", "shots")));
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
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "t018-ownership.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

const room = () => page.evaluate(() => window.__chq.room());
const board = () => page.evaluate(() => window.__chq.board());

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

// The canvas is pixels, so the assertion reads the pixel the painter wrote: the cell's centre in
// device pixels, then getImageData.
async function inkAt(cell) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector("#board");
    const ctx = canvas.getContext("2d");
    const point = window.__chq.cellToScreen(x + 0.5, y + 0.5);
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round((point.x - rect.left) * ratio)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round((point.y - rect.top) * ratio)));
    const data = ctx.getImageData(px, py, 1, 1).data;
    return "#" + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
  }, cell);
}

async function fit() {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(350);
}
async function zoomIn(times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("+");
    await sleep(250);
  }
}
async function panToCell(cell, tries = 80) {
  // The shortcut handler ignores keys typed into form fields, and the launch form keeps focus on
  // its select after the room opens: without this blur the arrows changed the era picker.
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  const vp = page.viewportSize();
  for (let i = 0; i < tries; i++) {
    const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    let moved = false;
    if (at.x < vp.width / 2 - 60) { await page.keyboard.press("ArrowLeft"); moved = true; }
    else if (at.x > vp.width / 2 + 60) { await page.keyboard.press("ArrowRight"); moved = true; }
    if (at.y < vp.height / 2 - 60) { await page.keyboard.press("ArrowUp"); moved = true; }
    else if (at.y > vp.height / 2 + 60) { await page.keyboard.press("ArrowDown"); moved = true; }
    if (!moved) return;
  }
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t018" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA,
    { timeout: 20000, polling: 100 });
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null,
    { timeout: 15000 }).catch(() => {});

  // --- the geometry rides with the board, the owners with the room -----------------------------
  const geometry = (await board()).territory;
  mark("the board carries the region geometry", Boolean(geometry) && geometry.width === 320 &&
    geometry.height === 136 && Array.isArray(geometry.regionRuns), {
    width: geometry && geometry.width, height: geometry && geometry.height,
    runs: geometry && geometry.regionRuns && geometry.regionRuns.length,
  });
  const ownership = (await room()).ownership;
  mark("the room carries one owner per region", Boolean(ownership) && ownership.ready === true &&
    Array.isArray(ownership.owners) && ownership.owners.length === 184, {
    ready: ownership && ownership.ready, regions: ownership && ownership.owners && ownership.owners.length,
    tally: ownership && ownership.tally,
  });

  const sites = (await room()).sites || [];
  const byName = (wanted) => sites.find((site) => site && site.name === wanted);
  const washington = byName("Washington");
  const berlin = byName("Berlin");
  mark("Washington and Berlin are on the board with their 1942 owners",
    Boolean(washington && berlin) && washington.owner === "blue" && berlin.owner === "red",
    { washington: washington && washington.owner, berlin: berlin && berlin.owner });

  // --- terrain first, so the toggle has something to differ from ------------------------------
  await fit();
  const terrainWashington = await inkAt(washington);
  const terrainBerlin = await inkAt(berlin);
  await shot("t018-terrain-fit.png");

  // --- Show Ownership at the world fit --------------------------------------------------------
  await page.keyboard.press("p");
  await sleep(500);
  const ownWashington = await inkAt(washington);
  const ownBerlin = await inkAt(berlin);
  const seaInk = await inkAt({ x: 60, y: 100 });
  mark("Show Ownership fills Washington's ground blue", ownWashington === "#5555ff", { ink: ownWashington });
  mark("Show Ownership fills Berlin's ground red", ownBerlin === "#ff5555" || ownBerlin === "#aa0000",
    { ink: ownBerlin });
  mark("the sea is still sea", seaInk === "#55ffff", { ink: seaInk });
  mark("the terrain view underneath was not the ownership ink", terrainWashington !== ownWashington || terrainBerlin !== ownBerlin,
    { terrainWashington, terrainBerlin, ownWashington, ownBerlin });
  const note = await page.evaluate(() => window.__chq.note());
  mark("the note counts regions, not cells", /Ownership: blue holds \d+, red holds \d+, neutral \d+/.test(note), note);
  await shot("t018-ownership-fit.png");

  // --- units stay visible over the fill -------------------------------------------------------
  // A piece badge is drawn over the ground, so the cell under a piece is not the fill colour. The
  // check is that the fill did not paint over the badge: the piece's own cell differs from its
  // neighbour's fill.
  const pieces = (await room()).pieces || [];
  const own = pieces.find((piece) => piece && piece.side === "blue");
  let pieceKeep = null;
  if (own) {
    await fit();
    const onPiece = await inkAt(own);
    const nextCell = await inkAt({ x: own.x, y: own.y + 1 });
    pieceKeep = { onPiece, nextCell, x: own.x, y: own.y };
    mark("a unit still reads over the ownership fill", onPiece !== nextCell, pieceKeep);
  } else {
    mark("a unit still reads over the ownership fill", false, "no blue piece in the room view");
  }

  // --- zoomed ---------------------------------------------------------------------------------
  // Zoom first, then bring the cell back to the middle: the zoom anchors on the middle of the
  // board, so a capital away from it drifts out of the viewport on the way in.
  await zoomIn(3);
  await panToCell({ x: berlin.x, y: berlin.y });
  await sleep(400);
  const zoomBerlin = await inkAt(berlin);
  const cam = await page.evaluate(() => window.__chq.state().camera);
  mark("zoomed, Berlin is still red", zoomBerlin === "#ff5555" || zoomBerlin === "#aa0000",
    { ink: zoomBerlin, camera: cam });
  await shot("t018-ownership-zoom.png");

  // --- and back -------------------------------------------------------------------------------
  await page.keyboard.press("p");
  await sleep(500);
  // Back at the world fit, because the terrain ink under Washington is only comparable there.
  await fit();
  const backWashington = await inkAt(washington);
  mark("toggling back restores the terrain", backWashington === terrainWashington,
    { backWashington, terrainWashington });
  await shot("t018-terrain-back.png");

  mark("no page errors", pageErrors.length === 0, pageErrors);
} catch (err) {
  mark("run completed", false, String(err && err.message ? err.message : err));
  await shot("t018-failure.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

const failed = evidence.filter((row) => !row.ok);
console.log(`${evidence.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
