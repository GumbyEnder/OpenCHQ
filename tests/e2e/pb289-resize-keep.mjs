// PB-289 page leg: a window resize keeps the camera the player set up; Fit is the only thing that drops it.
//
// The reported behaviour (game 9794, PM 9799 s3): at 1280x800, Alt+5 stores a view at zoom 18 on a
// 960x408 canvas; resize the window to 1024x768 and the map snapped back to the whole-world fit,
// centre 160,68. The resize listener called refit(), and refit() is the Fit control - it clears
// userCamera and rebuilds the whole-world camera - so the resize was running Fit behind the player.
// PB-280's leg and PB-281's leg both stayed green through it: neither resizes the WINDOW after
// setting a camera (PB-280 moves the canvas box through the stage).
//
// This leg measures, on a real page, real keys, a real server and a real window resize:
//   1. preset 1 opens at zoom 18 on the 960x408 canvas at 1280x800 (the repro's precondition);
//   2. Alt+5 stores it: 53.333 by 22.667 cells at zoom 18, centre 164.5,34;
//   3. 0 (Fit) returns the whole world at zoom 3 without changing the canvas;
//   4. 5 recalls at zoom 18 on the stored centre;
//   5. RESIZE the window to 1024x768 (the canvas grid does not change at that size, so the control
//      still drops the camera - the flag is what this arm tests), then to 800x600, where the canvas
//      really rebuilds and sizeCanvas' keeping branch (PB-280's inverse) is the code under test: the
//      camera is STILL on the stored centre, at 18 on the unchanged canvas and at the largest zoom that
//      holds the span (12) once the canvas really shrinks;
//   6. a camera the player never set - Fit at the small window, then resize back to 1280x800 - still
//      lands on the whole-world fit of the new canvas, so keeping did not become "never fit";
//   7. no page error.
//
//   node tests/e2e/pb289-resize-keep.mjs                  # starts its own server from this tree
//   node tests/e2e/pb289-resize-keep.mjs --url=<base>     # a running server
//   node tests/e2e/pb289-resize-keep.mjs --out=<dir>      # evidence dir (default: a fresh temp dir)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", mkdtempSync(path.join(tmpdir(), "openchq-pb289-"))));
mkdirSync(OUT, { recursive: true });
// The leg names its own instrument, so a gate row's count points at the code that produced it.
const SELF_MD5 = createHash("md5").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");

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

const stateOf = (page) => page.evaluate(() => window.__chq.state());
const toastOf = (page) => page.evaluate(() => window.__chq.toast());
const slotsOf = (page) => page.evaluate(() => {
  try {
    const raw = localStorage.getItem("openchq.macros");
    return raw ? (JSON.parse(raw).slots || {}) : {};
  } catch (err) {
    return {};
  }
});
// The cell under the middle of the canvas: cell i draws at left + (i + 0.5) * scale.
const centreOf = (camera) => ({ x: (camera.viewW / 2 - camera.left) / camera.scale, y: (camera.viewH / 2 - camera.top) / camera.scale });
const brief = (camera) => (camera ? "zoom " + camera.scale + " left " + camera.left + " top " + camera.top
  + " canvas " + camera.viewW + "x" + camera.viewH : "no camera");
// The whole-world fit for a canvas, derived here from the canvas the page reports - not read out of
// the module's own expression - so the leg cannot agree with a wrong fit by construction.
const fitZoom = (w, h) => Math.max(1, Math.min(64, Math.floor(Math.min(w / 320, h / 136)) || 1));

async function focusBoard(page) {
  const box = await page.locator("#board").boundingBox();
  await page.mouse.click(box ? box.x + box.width / 2 : 640, box ? box.y + box.height / 2 : 400);
  await sleep(80);
}
async function geometry(page) {
  return page.evaluate(() => ({
    stage: Math.round(document.getElementById("mapStage").getBoundingClientRect().height),
    canvasW: document.getElementById("board").width,
    canvasH: document.getElementById("board").height,
  }));
}
async function resizeTo(page, width, height, oldCanvasW) {
  await page.setViewportSize({ width, height });
  // Poll the canvas box from Node rather than waitForFunction: the page rebuilds it inside the
  // resize handler, and an in-page predicate that outlives a navigation reads as a timeout, not a
  // measurement.
  const started = Date.now();
  let changed = false;
  while (Date.now() - started < 8000) {
    const w = await page.evaluate(() => document.getElementById("board").width);
    if (w !== oldCanvasW) { changed = true; break; }
    await sleep(80);
  }
  await sleep(250);
  return changed;
}

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb289-srv-"));
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

  const user = "e2e-pb289-" + Date.now().toString(36).slice(-6);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", user);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  await page.selectOption('#launch select[name="era"]', "1942");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
  await sleep(600);
  mark("a 1942 human-vs-bot room is open", await page.evaluate(() => String(window.__chq.room().era) === "1942"),
    "era read from the room frame");

  // ---- 1. the repro's precondition ------------------------------------------------------------
  await focusBoard(page);
  await page.keyboard.press("1");
  await sleep(400);
  const atPreset = await stateOf(page);
  const atPresetGeo = await geometry(page);
  mark("preset 1 opens at zoom 18 on the 960x408 canvas at 1280x800",
    Boolean(atPreset.camera) && atPreset.camera.scale === 18 && atPresetGeo.canvasW === 960 && atPresetGeo.canvasH === 408,
    brief(atPreset.camera) + "; stage " + atPresetGeo.stage);

  // ---- 2. Alt+5 stores the view ---------------------------------------------------------------
  await page.keyboard.press("Alt+5");
  await sleep(300);
  const storeToast = await toastOf(page);
  const stored = (await slotsOf(page))["5"] || null;
  mark("Alt+5 stores the view at zoom 18", /Macro 5 stored/.test(storeToast) && /cells at zoom 18/.test(storeToast)
    && Boolean(stored) && stored.scale === 18, storeToast);
  const storedCentre = stored ? { x: stored.cx, y: stored.cy } : null;

  // ---- 3. Fit returns the whole world without changing the canvas ------------------------------
  await page.keyboard.press("0");
  await sleep(300);
  const atFit = await stateOf(page);
  mark("0 (Fit) returns the whole world at zoom 3", Boolean(atFit.camera) && atFit.camera.scale === 3, brief(atFit.camera));

  // ---- 4. recall at the stored zoom ------------------------------------------------------------
  await page.keyboard.press("5");
  await sleep(350);
  const recalled = await stateOf(page);
  const recalledCentre = recalled.camera ? centreOf(recalled.camera) : null;
  mark("5 recalls at zoom 18 on the stored centre",
    Boolean(recalled.camera) && recalled.camera.scale === 18 && Boolean(recalledCentre && storedCentre)
      && Math.abs(recalledCentre.x - storedCentre.x) <= 0.5 && Math.abs(recalledCentre.y - storedCentre.y) <= 0.5,
    brief(recalled.camera) + " centre " + (recalledCentre ? recalledCentre.x.toFixed(3) + "," + recalledCentre.y.toFixed(3) : "?"));
  await page.screenshot({ path: path.join(OUT, "pb289-before-resize-1280x800.png") });

  // ---- 5. THE ARM: resize the window; the camera must survive ---------------------------------
  // 5a. The AC's own resize, 1280x800 -> 1024x768. The page's canvas is a whole number of cells, so
  // this window leaves the 960x408 canvas UNCHANGED - which is exactly why the arm discriminates:
  // the control (refit on resize) drops the camera to the whole-world fit with no canvas change at
  // all, so a camera that survives here proves the FLAG is honoured, not that sizeCanvas ran.
  const shrunk = false;
  await page.setViewportSize({ width: 1024, height: 768 });
  await sleep(400);
  const afterResizeGeo = await geometry(page);
  const afterResize = await stateOf(page);
  const afterCentre = afterResize.camera ? centreOf(afterResize.camera) : null;
  await page.screenshot({ path: path.join(OUT, "pb289-after-resize-1024x768.png") });
  mark("the 1024x768 window leaves the 960x408 canvas (cells are whole, so the grid does not change)",
    !shrunk && afterResizeGeo.canvasW === atPresetGeo.canvasW && afterResizeGeo.canvasH === atPresetGeo.canvasH,
    "canvas " + atPresetGeo.canvasW + "x" + atPresetGeo.canvasH + " -> " + afterResizeGeo.canvasW + "x" + afterResizeGeo.canvasH);
  mark("a window resize keeps the recalled zoom 18, not the whole-world fit",
    Boolean(afterResize.camera) && afterResize.camera.scale === 18,
    brief(afterResize.camera) + " (the control, refit-on-resize, reads " + fitZoom(afterResizeGeo.canvasW, afterResizeGeo.canvasH) + ")");
  mark("a window resize keeps the stored centre 164.5,34 within 0.5 cell",
    Boolean(afterCentre && storedCentre)
      && Math.abs(afterCentre.x - storedCentre.x) <= 0.5 && Math.abs(afterCentre.y - storedCentre.y) <= 0.5,
    afterCentre && storedCentre
      ? "centre " + afterCentre.x.toFixed(3) + "," + afterCentre.y.toFixed(3)
        + " vs stored " + storedCentre.x.toFixed(3) + "," + storedCentre.y.toFixed(3)
      : "no centre");

  // 5b. A window small enough that the canvas really rebuilds: the keeping branch of sizeCanvas is
  // then the code under test (PB-280's centre-cell inverse), not just the absent refit.
  const rebuilt = await resizeTo(page, 800, 600, afterResizeGeo.canvasW);
  const rebuiltGeo = await geometry(page);
  const afterRebuild = await stateOf(page);
  const rebuiltCentre = afterRebuild.camera ? centreOf(afterRebuild.camera) : null;
  await page.screenshot({ path: path.join(OUT, "pb289-after-resize-800x600.png") });
  mark("an 800x600 window rebuilds a smaller canvas",
    rebuilt && rebuiltGeo.canvasW < afterResizeGeo.canvasW && rebuiltGeo.canvasH < afterResizeGeo.canvasH,
    "canvas " + afterResizeGeo.canvasW + "x" + afterResizeGeo.canvasH + " -> " + rebuiltGeo.canvasW + "x" + rebuiltGeo.canvasH);
  // PB-281's rule applied to the window the camera shows now: the span 53.333 x 22.667 cells has to
  // fit 640x272, so the largest zoom that holds it is 12 - derived here from the stored box and the
  // canvas, not copied from the module.
  const spanW = stored ? stored.w : 0;
  const spanH = stored ? stored.h : 0;
  let cappedFit = 1;
  if (stored) {
    const holds = (zoom) => spanW * zoom <= rebuiltGeo.canvasW + 1 && spanH * zoom <= rebuiltGeo.canvasH + 1;
    while (holds(cappedFit + 1)) cappedFit += 1;
  }
  mark("the rebuilt canvas takes the largest zoom that holds the span (PB-281's rule, not a no-op)",
    Boolean(afterRebuild.camera) && afterRebuild.camera.scale === cappedFit && afterRebuild.camera.scale === 12
      && Boolean(rebuiltCentre && storedCentre)
      && Math.abs(rebuiltCentre.x - storedCentre.x) <= 0.5 && Math.abs(rebuiltCentre.y - storedCentre.y) <= 0.5,
    brief(afterRebuild.camera) + " (640x272 / span " + spanW.toFixed(3) + "x" + spanH.toFixed(3) + " -> " + cappedFit + ") centre "
      + (rebuiltCentre ? rebuiltCentre.x.toFixed(3) + "," + rebuiltCentre.y.toFixed(3) : "?"));

  // ---- 6. a camera the player never set still fits ---------------------------------------------
  await page.keyboard.press("0");
  await sleep(300);
  const fitSmall = await stateOf(page);
  const smallGeo = await geometry(page);
  mark("Fit at the smaller window is the whole world for that canvas",
    Boolean(fitSmall.camera) && fitSmall.camera.scale === fitZoom(smallGeo.canvasW, smallGeo.canvasH),
    brief(fitSmall.camera) + " (fit for " + smallGeo.canvasW + "x" + smallGeo.canvasH + " is " + fitZoom(smallGeo.canvasW, smallGeo.canvasH) + ")");
  const grownAgain = await resizeTo(page, 1280, 800, smallGeo.canvasW);
  const growGeo = await geometry(page);
  const afterGrow = await stateOf(page);
  mark("a resize with no user camera still lands on the whole-world fit",
    grownAgain && Boolean(afterGrow.camera) && afterGrow.camera.scale === fitZoom(growGeo.canvasW, growGeo.canvasH)
      && Math.abs(centreOf(afterGrow.camera).x - 160) <= 0.5 && Math.abs(centreOf(afterGrow.camera).y - 68) <= 1,
    brief(afterGrow.camera) + "; centre " + (afterGrow.camera ? centreOf(afterGrow.camera).x.toFixed(2) + "," + centreOf(afterGrow.camera).y.toFixed(2) : "?"));

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  const payload = {
    base: BASE,
    leg: { file: "tests/e2e/pb289-resize-keep.mjs", md5: SELF_MD5 },
    viewport: "1280x800 -> 1024x768 -> 1280x800",
    atPreset: atPreset.camera,
    atPresetGeo,
    storeToast,
    stored,
    atFit: atFit.camera,
    recalled: recalled.camera,
    recalledCentre,
    afterResize: afterResize.camera,
    afterResizeGeo,
    afterCentre,
    fitSmall: fitSmall.camera,
    smallGeo,
    afterGrow: afterGrow.camera,
    growGeo,
    evidence,
    failed,
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "pb289-resize-keep.json"), JSON.stringify(payload, null, 2));
  console.log("pb289: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);

  await browser.close();
  if (child) child.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("pb289: leg crashed — " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
