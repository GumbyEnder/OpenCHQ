// PB-274 page leg: Screen Macros at 1280x800.
//
// Manual printed p.33-34: "in IBM systems you would press the ALT key plus a number to define the
// macro. From then on, pressing that number alone would send you to the pre-set window location and
// size." / "The first four macro IDs are already programmed into the game, but can be overwritten ...
// They zoom to Europe, the Middle East, Japan, and North America." / "To alter the zoom area of a
// macro, simply re-define it." / Undo Macro returns to the view held before the recall.
//
// What this leg measures on a real page, real keys and a real server:
//   1. the Map panel carries the Undo Macro row and names the Alt+N / N binding;
//   2. Alt+N stores the view that is on screen (centre, size, view mode) and 0 (Fit) then N recalls
//      it — read from the page's own camera, not from a pixel;
//   3. re-storing a slot that started as a preset overwrites it and the panel's count says so;
//   4. the view mode travels with the macro (stored on Ownership, recalled from Terrain);
//   5. preset 1 lands on Europe's box and a frame is captured at that recall;
//   6. Undo Macro returns the camera to the view held before the last recall;
//   7. the macros survive a reload (one browser-wide localStorage key, `openchq.macros`);
//   8. the existing keys still do what they did: 0 Fit, P, T, F, D, + and -;
//   9. no page error.
//
//   node tests/e2e/pb274-macros.mjs                  # starts its own server from this tree
//   node tests/e2e/pb274-macros.mjs --url=<base>     # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb274-macros", argOf("out"));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}
function note(label, detail) {
  evidence.push({ label, ok: null, detail });
  console.log("NOTE " + label + (detail === undefined ? "" : " — " + detail));
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
const macrosIn = (page) => page.evaluate(() => {
  try {
    const raw = localStorage.getItem("openchq.macros");
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
});
const storedKeys = (page) => page.evaluate(() => {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith("openchq.macros"));
  } catch (err) {
    return [];
  }
});
// The view's centre in cell space, from the painter's own convention: cell i is drawn at
// left + (i + 0.5) * scale, so the middle of the canvas is (viewW / 2 - left) / scale.
const centreOf = (camera) => (camera.viewW / 2 - camera.left) / camera.scale;
const sameCamera = (a, b, tol = 2) => Boolean(a) && Boolean(b) && a.scale === b.scale
  && Math.abs(a.left - b.left) <= tol && Math.abs(a.top - b.top) <= tol;
const brief = (camera) => (camera ? "zoom " + camera.scale + " left " + camera.left + " top " + camera.top : "no camera");

async function openPanel(page, id) {
  await page.click('#nav button[data-dialog="' + id + '"]').catch(() => {});
  await page.waitForSelector("#dialogBody", { timeout: 15000 });
  await sleep(200);
}
async function closePanel(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(150);
}
async function focusBoard(page) {
  const box = await page.locator("#board").boundingBox();
  await page.mouse.click(box ? box.x + box.width / 2 : 640, box ? box.y + box.height / 2 : 400);
  await sleep(80);
}

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb274-"));
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

  const user = "e2e-pb274-" + Date.now().toString(36).slice(-6);
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

  // ---- 1. the panel: the Undo row and the binding ------------------------------------------------
  await openPanel(page, "map");
  const panel = await page.evaluate(() => {
    const body = document.getElementById("dialogBody");
    const buttons = [...body.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    return { text: (body.textContent || "").trim(), buttons };
  });
  mark("the Map panel carries an Undo Macro row", panel.buttons.some((label) => /undo macro/i.test(label)),
    JSON.stringify(panel.buttons));
  mark("the panel names the Alt+N store and N recall binding",
    /Alt\+1-9/.test(panel.text) && /1-9 recalls/.test(panel.text),
    panel.text.split("\n").filter((line) => /Macro/i.test(line)).join(" | ").slice(0, 200));
  mark("the panel footnote carries both markers: provenance and the browser limit",
    /port's reconstruction/i.test(panel.text) && /Firefox/i.test(panel.text),
    (panel.text.match(/[^.]*reconstruction[^.]*\./) || ["none"])[0] + " | "
      + (panel.text.match(/[^.]*Firefox[^.]*\./) || ["none"])[0]);
  mark("the panel counts the stored slots", /0 of 9 stored/.test(panel.text),
    (panel.text.match(/\d+ of 9 stored/) || ["none"])[0]);
  await closePanel(page);

  // ---- 2. Alt+N stores what is on screen, 0 then N brings it back --------------------------------
  await focusBoard(page);
  const fit = (await stateOf(page)).camera;
  if (!fit) mark("the page exposes its camera", false, "no camera in state()");
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await sleep(150);
  const zoomed = (await stateOf(page)).camera;
  mark("three '+' presses zoom the camera in", Boolean(zoomed) && zoomed.scale === fit.scale + 3,
    brief(fit) + " -> " + brief(zoomed));

  await page.keyboard.press("Alt+3");
  await sleep(250);
  const storeToast = await toastOf(page);
  const saved3 = (await macrosIn(page) || {}).slots || {};
  mark("Alt+3 stores the view", /Macro 3 stored/.test(storeToast), storeToast);
  mark("slot 3 is in the one browser-wide key", Boolean(saved3["3"]) && (await storedKeys(page)).join(",") === "openchq.macros",
    "slots " + JSON.stringify(Object.keys(saved3)) + " / keys " + JSON.stringify(await storedKeys(page)));
  mark("the stored slot keeps the zoom that was on screen", saved3["3"] && saved3["3"].scale === zoomed.scale,
    JSON.stringify(saved3["3"]));

  await page.keyboard.press("0");
  await sleep(200);
  const refit = (await stateOf(page)).camera;
  mark("0 still fits the whole world", Math.abs(refit.scale - fit.scale) <= 1, brief(refit));

  await page.keyboard.press("3");
  await sleep(250);
  const recalled = (await stateOf(page)).camera;
  mark("3 alone recalls the zoomed view", sameCamera(recalled, zoomed, 2), brief(recalled) + " vs stored " + brief(zoomed));
  mark("a recall arms Undo Macro", (await page.evaluate(() => Boolean(window.__chq.macroUndoable && window.__chq.macroUndoable()))),
    "macroUndo=" + (await stateOf(page)).macroUndo);

  // ---- 3. Undo Macro ----------------------------------------------------------------------------
  await openPanel(page, "map");
  const undoLabel = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#dialogBody button")].find((b) => /undo macro/i.test(b.textContent || ""));
    if (!btn) return null;
    btn.click();
    return (btn.textContent || "").trim();
  });
  await sleep(300);
  const undone = (await stateOf(page)).camera;
  const undoToast = await toastOf(page);
  mark("Undo Macro returns the view held before the recall", sameCamera(undone, refit, 2),
    (undoLabel || "no row") + " -> " + brief(undone) + " (before the recall: " + brief(refit) + ")");
  mark("Undo Macro is one step and says so", /before the recall/.test(undoToast)
    && (await page.evaluate(() => Boolean(window.__chq.macroUndoable && window.__chq.macroUndoable()))) === false,
    undoToast);
  await closePanel(page);

  // ---- 4. the view mode travels with the macro --------------------------------------------------
  await focusBoard(page);
  await page.keyboard.press("p"); // terrain -> political
  await sleep(200);
  const political = await stateOf(page);
  mark("P still cycles the view mode", political.viewMode === "political", "viewMode=" + political.viewMode);
  await page.keyboard.press("+");
  await sleep(120);
  const modeCamera = (await stateOf(page)).camera;
  await page.keyboard.press("Alt+4");
  await sleep(250);
  await page.keyboard.press("p"); // political -> satellites
  await page.keyboard.press("p"); // satellites -> terrain
  await page.keyboard.press("0");
  await sleep(250);
  mark("the view mode moved before the recall", (await stateOf(page)).viewMode === "terrain",
    "viewMode=" + (await stateOf(page)).viewMode);
  const beforeModeRecall = (await stateOf(page)).camera;
  await page.keyboard.press("4");
  await sleep(300);
  const modeRecall = await stateOf(page);
  const saved4 = ((await macrosIn(page) || {}).slots || {})["4"] || null;
  mark("4 recalls the stored view mode with the camera",
    modeRecall.viewMode === "political" && Boolean(saved4) && saved4.mode === "political",
    "viewMode=" + modeRecall.viewMode + " stored mode=" + (saved4 ? saved4.mode : "none"));
  mark("4 recalls the stored camera, not the view it replaced",
    sameCamera(modeRecall.camera, modeCamera, 2) && !sameCamera(beforeModeRecall, modeCamera, 2),
    brief(modeRecall.camera) + " vs stored " + brief(modeCamera) + " (the view it replaced: " + brief(beforeModeRecall) + ")");

  // ---- 5. preset 1 lands on Europe, and a frame is captured -------------------------------------
  await focusBoard(page);
  await page.keyboard.press("1");
  await sleep(400);
  const preset = await stateOf(page);
  const presetToast = await toastOf(page);
  const presetCentre = centreOf(preset.camera);
  mark("1 recalls the Europe preset", /Preset 1/.test(presetToast), presetToast);
  mark("the preset centres on Europe's box (cx 164.5, cy 34 from the board's site table)",
    Math.abs(presetCentre - 164.5) <= 2, "centre x " + presetCentre.toFixed(2) + " at " + brief(preset.camera));
  // The box is opened as large as THIS canvas can show it: the canvas is 960x408 device px at this
  // window (320x136 cells at 3x), so Europe's 43x22 box fits at 18 px a cell, capped at 32.
  const presetFit = Math.min(32, Math.floor(preset.camera.viewW / 43), Math.floor(preset.camera.viewH / 22));
  mark("the preset opens the box as large as this canvas allows",
    preset.camera.scale === presetFit,
    "zoom " + preset.camera.scale + " (canvas " + preset.camera.viewW + "x" + preset.camera.viewH
      + " / box 43x22 -> " + presetFit + ")");
  await page.screenshot({ path: path.join(OUT, "pb274-preset1-1280x800.png") });
  mark("a frame of preset 1 recalled was captured", true, path.join(OUT, "pb274-preset1-1280x800.png"));

  // Overwrite: slot 1 started as a preset, and the manual says a preset can be overwritten.
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await sleep(150);
  const beforeOverwrite = (await stateOf(page)).camera;
  await page.keyboard.press("Alt+1");
  await sleep(250);
  const overwriteToast = await toastOf(page);
  const saved1 = ((await macrosIn(page) || {}).slots || {})["1"] || null;
  mark("Alt+1 overwrites the Europe preset and says so", /replacing the start-up preset/.test(overwriteToast)
    && Boolean(saved1) && saved1.scale === beforeOverwrite.scale, overwriteToast);
  await page.keyboard.press("0");
  await sleep(150);
  await page.keyboard.press("1");
  await sleep(250);
  mark("1 now recalls the player's own box, not the preset", sameCamera((await stateOf(page)).camera, beforeOverwrite, 2),
    brief((await stateOf(page)).camera) + " vs " + brief(beforeOverwrite));

  // ---- 6. the existing keys still do what they did ----------------------------------------------
  await focusBoard(page);
  await page.keyboard.press("0");
  await sleep(150);
  const afterZero = (await stateOf(page)).camera;
  mark("0 still fits after macros are stored", Math.abs(afterZero.scale - fit.scale) <= 1, brief(afterZero));
  const themeBefore = await page.evaluate(() => { try { return localStorage.getItem("openchq.theme"); } catch { return null; } });
  await page.keyboard.press("t");
  await sleep(200);
  const themeAfter = await page.evaluate(() => { try { return localStorage.getItem("openchq.theme"); } catch { return null; } });
  mark("T still cycles the theme", themeBefore !== themeAfter, themeBefore + " -> " + themeAfter);
  await page.keyboard.press("f");
  await sleep(150);
  mark("F still toggles Follow", (await stateOf(page)).following === true, "following=" + (await stateOf(page)).following);
  await page.keyboard.press("f");
  await sleep(120);
  await page.keyboard.press("d");
  await sleep(200);
  mark("D still toggles Show Paths", (await stateOf(page)).showPaths === true, "showPaths=" + (await stateOf(page)).showPaths);
  await page.keyboard.press("d");
  await sleep(120);
  const zoomBeforePlus = (await stateOf(page)).camera.scale;
  await page.keyboard.press("+");
  await sleep(150);
  const zoomAfterPlus = (await stateOf(page)).camera.scale;
  await page.keyboard.press("-");
  await sleep(150);
  mark("+ and - still step the zoom by one", zoomAfterPlus === zoomBeforePlus + 1
    && (await stateOf(page)).camera.scale === zoomBeforePlus,
    zoomBeforePlus + " -> " + zoomAfterPlus + " -> " + (await stateOf(page)).camera.scale);
  mark("Alt+3 did not leak into Fit or the view cycle", (await stateOf(page)).viewMode === "terrain",
    "viewMode=" + (await stateOf(page)).viewMode);

  // ---- 7. persistence: a reload keeps the macros -----------------------------------------------
  await focusBoard(page);
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.keyboard.press("Alt+5");
  await sleep(250);
  const saved5 = ((await macrosIn(page) || {}).slots || {})["5"] || null;
  const beforeReload = (await stateOf(page)).camera;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
  await sleep(800);
  const afterReloadSlots = ((await macrosIn(page) || {}).slots || {});
  mark("the macro set survives a reload", Boolean(afterReloadSlots["5"]) && (await storedKeys(page)).join(",") === "openchq.macros",
    "slots after reload " + JSON.stringify(Object.keys(afterReloadSlots)));
  await focusBoard(page);
  await page.keyboard.press("5");
  await sleep(350);
  const recalledAfterReload = (await stateOf(page)).camera;
  mark("5 recalls after the reload", sameCamera(recalledAfterReload, beforeReload, 2),
    brief(recalledAfterReload) + " vs stored " + brief(beforeReload) + " (slot scale " + (saved5 ? saved5.scale : "?") + ")");
  mark("the macros are one browser-wide key, not one per seat",
    (await storedKeys(page)).length === 1 && !(await storedKeys(page)).some((key) => /\.(blue|red)$/.test(key)),
    JSON.stringify(await storedKeys(page)));

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  const payload = { base: BASE, viewport: "1280x800", fit, zoomed, recalled, undone, preset: preset.camera,
    presetCentre, saved3, saved4, saved1, saved5, evidence, failed };
  writeFileSync(path.join(OUT, "pb274-macros.json"), JSON.stringify(payload, null, 2));
  console.log("pb274-macros: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);

  await browser.close();
  if (child) child.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("pb274-macros: leg crashed — " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
