// PB-281 page leg: a macro recalled at the viewport it was stored at keeps its stored zoom.
//
// The reported page behaviour at 1280x800: Alt+5 stored "53 by 23 cells at zoom 18", 0 (Fit), then
// 5, and the camera came back at 17 px a cell although the viewport had not changed. The stored
// window is fractional on purpose (PB-274 keeps 53.333 x 22.667 cells so a re-store is not a zoom
// step short), and captureMacro rounds it to three decimals, so 408 / 22.667 is 17.9997: the
// "does the box still fit" test floors to 17 and the recall silently loses one zoom step.
//
// This leg measures, on a real page, real keys and a real server:
//   1. preset 1 opens at zoom 18 with a 960x408 canvas at 1280x800 (the repro's precondition);
//   2. Alt+5 stores that view: 53.333 by 22.667 cells at zoom 18;
//   3. 0 (Fit) returns the whole world and does NOT change the canvas;
//   4. 5 recalls at zoom 18 - the stored zoom, not 17 - with the same centre cell, at the same
//      viewport (canvas and stage boxes compared before and after);
//   5. a genuinely smaller canvas still caps the recall to the zoom that fits the box (640x272 ->
//      zoom 12), so the fix widens the exact-fit tolerance and not the cap itself;
//   6. no page error.
//
//   node tests/e2e/pb281-macro-zoom-recall.mjs                  # starts its own server from this tree
//   node tests/e2e/pb281-macro-zoom-recall.mjs --url=<base>     # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
// PB-278's rule: no --out writes evidence into a fresh temp dir, never one operator's home path.
const OUT = path.resolve(argOf("out", mkdtempSync(path.join(tmpdir(), "openchq-pb281-"))));
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
// The cell under the middle of the canvas, from the painter's own convention: cell i is drawn at
// left + (i + 0.5) * scale, so the middle pixel is (viewW / 2 - left) / scale.
const centreOf = (camera) => ({ x: (camera.viewW / 2 - camera.left) / camera.scale, y: (camera.viewH / 2 - camera.top) / camera.scale });
const brief = (camera) => (camera ? "zoom " + camera.scale + " left " + camera.left + " top " + camera.top
  + " canvas " + camera.viewW + "x" + camera.viewH : "no camera");

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

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb281-srv-"));
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

  const user = "e2e-pb281-" + Date.now().toString(36).slice(-6);
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
  mark("a 1942 human-vs-bot room is open", await page.evaluate(() => String(window.__chq.room().era) === "1942"),
    "era read from the room frame");
  await sleep(600);

  // ---- 1. the repro's precondition: preset 1 opens at zoom 18 on a 960x408 canvas -----------------
  await focusBoard(page);
  await page.keyboard.press("1"); // Europe preset: box 43x22 cells, opened as large as this canvas allows
  await sleep(400);
  const atPreset = await stateOf(page);
  const atPresetGeo = await geometry(page);
  mark("preset 1 opens at zoom 18 on the 1280x800 canvas",
    Boolean(atPreset.camera) && atPreset.camera.scale === 18 && atPresetGeo.canvasW === 960 && atPresetGeo.canvasH === 408,
    brief(atPreset.camera) + "; stage " + atPresetGeo.stage);

  // ---- 2. Alt+5 stores the view exactly as the toast describes it ---------------------------------
  await page.keyboard.press("Alt+5");
  await sleep(300);
  const storeToast = await toastOf(page);
  const stored = (await slotsOf(page))["5"] || null;
  mark("Alt+5 stores the zoomed view and says the cell size and the zoom", /Macro 5 stored/.test(storeToast)
    && /cells at zoom 18/.test(storeToast), storeToast);
  mark("the stored box is the fractional window, not a rounded 53 by 23",
    Boolean(stored) && stored.scale === 18
      && Math.abs(stored.w - 53.333) <= 0.002 && Math.abs(stored.h - 22.667) <= 0.002,
    stored ? JSON.stringify({ w: stored.w, h: stored.h, scale: stored.scale, cx: stored.cx, cy: stored.cy }) : "no slot 5");
  const storedCentre = stored ? { x: stored.cx, y: stored.cy } : null;

  // ---- 3. 0 (Fit) returns the whole world and leaves the viewport alone ---------------------------
  await page.keyboard.press("0");
  await sleep(300);
  const atFit = await stateOf(page);
  const atFitGeo = await geometry(page);
  mark("0 (Fit) returns the whole world", Boolean(atFit.camera) && atFit.camera.scale === 3, brief(atFit.camera));
  mark("Fit does not shrink the canvas that stored the macro",
    atFitGeo.canvasW === atPresetGeo.canvasW && atFitGeo.canvasH === atPresetGeo.canvasH
      && atFitGeo.stage === atPresetGeo.stage,
    "stage/canvas before " + JSON.stringify(atPresetGeo) + " after " + JSON.stringify(atFitGeo));

  // ---- 4. 5 recalls at the stored zoom, at the same viewport -------------------------------------
  await page.keyboard.press("5");
  await sleep(350);
  const recalled = await stateOf(page);
  const recalledGeo = await geometry(page);
  const recalledCentre = recalled.camera ? centreOf(recalled.camera) : null;
  await page.screenshot({ path: path.join(OUT, "pb281-recall-1280x800.png") });
  mark("5 recalls at the stored zoom 18, not the 17 the fit test floors to",
    Boolean(recalled.camera) && recalled.camera.scale === 18, brief(recalled.camera) + " (stored zoom " + (stored ? stored.scale : "?") + ")");
  mark("the recalled centre is the stored centre within 0.5 cell",
    Boolean(recalledCentre && storedCentre)
      && Math.abs(recalledCentre.x - storedCentre.x) <= 0.5 && Math.abs(recalledCentre.y - storedCentre.y) <= 0.5,
    recalledCentre && storedCentre
      ? "centre " + recalledCentre.x.toFixed(3) + "," + recalledCentre.y.toFixed(3)
        + " vs stored " + storedCentre.x.toFixed(3) + "," + storedCentre.y.toFixed(3)
      : "no centre");
  mark("the viewport did not change between the store and the recall",
    recalledGeo.canvasW === atPresetGeo.canvasW && recalledGeo.canvasH === atPresetGeo.canvasH
      && recalledGeo.stage === atPresetGeo.stage,
    "stage/canvas at store " + JSON.stringify(atPresetGeo) + " at recall " + JSON.stringify(recalledGeo));

  // ---- 5. a genuinely smaller canvas still caps the recall to the zoom that fits -------------------
  await page.keyboard.press("0");
  await sleep(200);
  const stageAfter = await page.evaluate(() => {
    const stage = document.getElementById("mapStage");
    stage.style.flex = "0 0 400px";
    return Math.round(stage.getBoundingClientRect().height);
  });
  // The page sizes the canvas from inside the frame (viewForCanvas -> sizeCanvas), so the layout
  // change alone rebuilds nothing: this is the page's own paint entry, the same call PB-280's leg
  // drives, not a stub of sizeCanvas.
  await page.evaluate(() => window.__chq.paint());
  const shrank = await page.waitForFunction((oldW) => document.getElementById("board").width !== oldW,
    atPresetGeo.canvasW, { timeout: 8000, polling: 60 }).then(() => true).catch(() => false);
  const smallGeo = await geometry(page);
  const smallCanvas = { w: smallGeo.canvasW, h: smallGeo.canvasH };
  await page.keyboard.press("5");
  await sleep(350);
  const capped = await stateOf(page);
  const cappedCentre = capped.camera ? centreOf(capped.camera) : null;
  // What "the zoom that fits the box" means here, read in pixels: the largest whole zoom whose
  // stored box lands inside the 640x272 canvas (1 px of slack for captureMacro's 1/1000-cell
  // rounding, which is 4/1000 of a pixel at zoom 12). Derived in the leg, not copied from the
  // module's own fit expression, so the leg cannot agree with a wrong floor by construction.
  let fitZoom = 1;
  if (stored) {
    const fitsAt = (zoom) => stored.w * zoom <= smallCanvas.w + 1 && stored.h * zoom <= smallCanvas.h + 1;
    while (fitsAt(fitZoom + 1)) fitZoom += 1;
  }
  mark("the stage losing its flex share rebuilds the canvas (no window resize)",
    shrank && smallGeo.canvasW === 640 && smallGeo.canvasH === 272,
    "stage 400 -> canvas " + smallGeo.canvasW + "x" + smallGeo.canvasH);
  mark("a smaller canvas caps the recall to the zoom that fits the stored box",
    Boolean(capped.camera) && capped.camera.scale === fitZoom && capped.camera.scale === 12,
    brief(capped.camera) + " (640x272 / box " + (stored ? stored.w + "x" + stored.h : "?") + " -> " + fitZoom + ")");
  mark("the capped recall keeps the stored centre within 0.5 cell",
    Boolean(cappedCentre && storedCentre)
      && Math.abs(cappedCentre.x - storedCentre.x) <= 0.5 && Math.abs(cappedCentre.y - storedCentre.y) <= 0.5,
    cappedCentre && storedCentre ? "centre " + cappedCentre.x.toFixed(3) + "," + cappedCentre.y.toFixed(3) : "no centre");
  await page.evaluate(() => { document.getElementById("mapStage").style.flex = ""; });
  await page.evaluate(() => window.__chq.paint());
  await sleep(200);

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  const payload = {
    base: BASE,
    viewport: "1280x800",
    atPreset: atPreset.camera,
    atPresetGeo,
    storeToast,
    stored,
    atFit: atFit.camera,
    recalled: recalled.camera,
    recalledCentre,
    recalledGeo,
    smallCanvas,
    capped: capped.camera,
    cappedCentre,
    evidence,
    failed,
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "pb281-macro-zoom.json"), JSON.stringify(payload, null, 2));
  console.log("pb281: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);

  await browser.close();
  if (child) child.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("pb281: leg crashed — " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
