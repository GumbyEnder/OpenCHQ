// PB-280 page leg: a canvas-size change that is NOT a window resize must not move the camera's
// centre cell.
//
// sizeCanvas()'s resize branch keeps a zoomed camera "on the same cell" when the backing store is
// rebuilt at a new cell size. It used midX = (old.left + old.viewW / 2) / old.scale, but
// cellToPixel (render.mjs:134) reads pixel = left + cell * scale, so the cell under the centre
// pixel is (viewW / 2 - left) / scale. The sign error re-centred the camera by 2 * left / scale
// cells - at zoom 18 that is hundreds of cells.
//
// What this leg does, through the page and nothing stubbed:
//   1. a 1942 human-vs-bot room is opened at 1280x800 and the canvas is sized;
//   2. the camera is zoomed to exactly 18 with the page's own '+' key (zoomStep, one whole cell
//      per press), and the centre cell is read off the live camera;
//   3. #mapStage's height is cut by 200 px WITHOUT touching the window - the same layout event a
//      band row or a panel taking height produces - and the leg waits for the backing store to
//      change size (that is the branch under test);
//   4. the centre cell is read again and must stay within 0.5 cell in x and y;
//   5. the stage height is restored and the same reading is taken a third time.
//
//   node tests/e2e/pb280-canvas-recentre.mjs                # starts its own server from this tree
//   node tests/e2e/pb280-canvas-recentre.mjs --url=<base>   # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = path.resolve((process.argv.find((v) => v.startsWith("--out=")) || "").slice(6) ||
  mkdtempSync(path.join(tmpdir(), "openchq-pb280-")));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// The camera's centre in continuous cell coordinates, straight off cellToPixel's inverse.
const centreOf = (page) => page.evaluate(() => {
  const cam = (window.__chq.state() || {}).camera;
  if (!cam) return null;
  return {
    x: (cam.viewW / 2 - cam.left) / cam.scale,
    y: (cam.viewH / 2 - cam.top) / cam.scale,
    scale: cam.scale,
    left: cam.left,
    top: cam.top,
    viewW: cam.viewW,
    viewH: cam.viewH,
    boardW: Number((window.__chq.board() || {}).width) || 320,
    canvas: { w: document.getElementById("board").width, h: document.getElementById("board").height },
  };
});

const wrapDelta = (a, b, width) => {
  const d = Math.abs(a - b) % width;
  return Math.min(d, width - d);
};

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb280-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch { /* still booting */ }
      await sleep(150);
    }
    mark("a local server answers", true, BASE);
  } else {
    mark("using the given host", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const name = "e2e-pb280-" + Date.now().toString(36).slice(-6);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });

  await page.selectOption('#launch select[name="era"]', "1942");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
    null, { timeout: 30000, polling: 100 });
  await page.waitForFunction(() => {
    const cam = (window.__chq.state() || {}).camera;
    return Boolean(cam && cam.viewW > 0);
  }, null, { timeout: 20000, polling: 100 });
  mark("a 1942 human-vs-bot room is open and the canvas is sized", true,
    JSON.stringify((await centreOf(page)).canvas));

  // ---- zoom to exactly 18 with the page's own '+' key ---------------------------------------------
  await page.click("#board", { position: { x: 40, y: 40 } });
  let zoomed = null;
  for (let i = 0; i < 60; i++) {
    zoomed = await centreOf(page);
    if (zoomed && zoomed.scale >= 18) break;
    await page.keyboard.press("=");
    await sleep(60);
  }
  zoomed = await centreOf(page);
  mark("the camera reaches zoom 18 through the page's zoom-in key", Boolean(zoomed) && zoomed.scale === 18,
    zoomed ? "scale " + zoomed.scale : "no camera");

  const before = zoomed;
  const stageBefore = await page.evaluate(() => Math.round(document.getElementById("mapStage").getBoundingClientRect().height));

  // ---- a canvas-size change that is NOT a window resize -------------------------------------------
  // The stage is `flex: 1 1 auto` in a match, so an inline `height` is ignored. Its FLEX BASIS is
  // what a band row arriving, a panel taking space or an on-screen keyboard actually changes, and
  // that is the layout event this branch must survive: same window, new canvas size.
  const stageAfter = await page.evaluate(() => {
    const stage = document.getElementById("mapStage");
    stage.style.flex = "0 0 400px";
    return Math.round(stage.getBoundingClientRect().height);
  });
  // The page sizes the canvas from inside the frame (viewForCanvas -> sizeCanvas), so nothing runs
  // until a frame is drawn. This is the page's own paint entry, the same call T-014 times - not a
  // stub of sizeCanvas.
  await page.evaluate(() => window.__chq.paint());
  const changed = await page.waitForFunction((oldW) => document.getElementById("board").width !== oldW, before.canvas.w,
    { timeout: 8000, polling: 60 }).then(() => true).catch(() => false);
  const mid = await centreOf(page);
  mark("the stage losing its flex share rebuilds the canvas at a new cell size (no window resize)",
    changed && mid && (mid.canvas.w !== before.canvas.w || mid.canvas.h !== before.canvas.h),
    "stage " + stageBefore + " -> " + stageAfter + "; canvas " + before.canvas.w + "x" + before.canvas.h + " -> " +
    (mid ? mid.canvas.w + "x" + mid.canvas.h : "?"));

  mark("the zoomed camera keeps its zoom across the size change",
    Boolean(mid) && mid.scale === before.scale, mid ? "scale " + before.scale + " -> " + mid.scale : "no camera");

  const dx = mid ? wrapDelta(before.x, mid.x, before.boardW) : Infinity;
  const dy = mid ? Math.abs(before.y - mid.y) : Infinity;
  mark("the centre cell holds within 0.5 cell in x", dx <= 0.5,
    "centre x " + before.x.toFixed(2) + " -> " + (mid ? mid.x.toFixed(2) : "?") + " (dx " + (Number.isFinite(dx) ? dx.toFixed(2) : "inf") + ")");
  mark("the centre cell holds within 0.5 cell in y", dy <= 0.5,
    "centre y " + before.y.toFixed(2) + " -> " + (mid ? mid.y.toFixed(2) + " (dy " + dy.toFixed(2) + ")" : "?"));

  // ---- and back, so the branch is exercised in both directions ------------------------------------
  await page.evaluate(() => { document.getElementById("mapStage").style.flex = ""; });
  await page.evaluate(() => window.__chq.paint());
  const restored = await page.waitForFunction((oldW) => document.getElementById("board").width !== oldW, mid ? mid.canvas.w : -1,
    { timeout: 8000, polling: 60 }).then(() => true).catch(() => false);
  const after = await centreOf(page);
  const dx2 = after ? wrapDelta(before.x, after.x, before.boardW) : Infinity;
  const dy2 = after ? Math.abs(before.y - after.y) : Infinity;
  mark("restoring the stage height rebuilds the canvas again", Boolean(restored) && Boolean(after) &&
    after.canvas.w === before.canvas.w, after ? "canvas " + after.canvas.w + "x" + after.canvas.h : "no camera");
  mark("the centre cell holds within 0.5 cell after the second size change", dx2 <= 0.5 && dy2 <= 0.5,
    after ? "centre " + after.x.toFixed(2) + "," + after.y.toFixed(2) + " vs " + before.x.toFixed(2) + "," + before.y.toFixed(2)
      : "no camera");

  await page.screenshot({ path: path.join(OUT, "pb280-zoom18-1280x800.png") });
  mark("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

  const payload = {
    base: BASE,
    seat: name,
    at: new Date().toISOString(),
    before, mid, after,
    stageBefore,
    evidence,
    failed,
  };
  writeFileSync(path.join(OUT, "pb280-recentre.json"), JSON.stringify(payload, null, 2));
  console.log((failed ? "FAIL " : "PASS ") + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  console.log("evidence " + path.join(OUT, "pb280-recentre.json"));
  await context.close();
  await browser.close();
  if (child) child.kill();
  if (failed) process.exit(1);
}

await main();
