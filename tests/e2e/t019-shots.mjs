// T-019 shot matrix (AC2 / AC5 / T-030 extra), corrected by the PM in room 6107 item 2, and
// re-based by room 6250 item 1: every in-match control is PRESSED, never typed at.
//
//   node tests/e2e/t019-shots.mjs --url=http://127.0.0.1:8113 --out=local/t019-shots
//
// The matrix is exact, because a shot of the wrong scenario proves nothing:
//
//   * FOG shots: New game -> Era Concealed (9999), side blue, ROUND 0, one per theme (C and D) and
//     one per view (terrain and Show Ownership). Fog is era-gated: it only draws in 9999.
//   * ONE 1942 shot per theme, terrain, no fog expected. A missing fog in 1942 is NOT a fail: the
//     1942/1918 openings show the whole map and hide only enemy pieces the seat cannot see.
//   * Every shot records the painter's own layer list and fog rect count (window.__chq.paintReport()), so
//     the ownership shots also hold the fill-under-fog order (PB-071) instead of a re-order pass.
//
// PB-078 (room 6240 item 3): the six map controls used to live in a `.matchhead` the in-match
// stylesheet hid, so zoom/view/theme were keyboard-only in a match. This leg measures all six - a
// non-zero box, inside the viewport, and elementFromPoint landing on the button - and then CLICKS
// them for every camera and view step below. No "0"/"+"/"-"/"p"/"t" key is pressed anywhere in this
// file; the keyboard path keeps its own pin (web/test/nodes/camera_zoom.mjs). A theme switch inside a
// live match is shot and pinned too, so the theme button is proven by its own click.
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
  console.error("usage: node tests/e2e/t019-shots.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t019", "shots")));
mkdirSync(OUT, { recursive: true });
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

const THEMES = [
  { id: "C", label: "Dark tactical" },
  { id: "D", label: "Classic" },
];

const CONTROLS = ["themeToggle", "viewToggle", "camIn", "camOut", "camFit", "camFollow"];

const evidence = [];
const failures = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  if (!ok) failures.push(step);
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "t019-shots.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
// Quit and New game both confirm(); a silently dismissed dialog is a click that never happened.
page.on("dialog", (dialog) => dialog.accept().catch(() => {}));

const paint = () => page.evaluate(() => window.__chq.paintReport());

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

// Every control, as the browser lays it out: a real box, inside the window, and the element a
// pointer would actually hit at its centre. A button under the fixed strip or an overlay fails here
// even when CSS calls it visible.
async function controlBoxes() {
  return page.evaluate((ids) => ids.map((id) => {
    const element = document.getElementById(id);
    if (!element) return { id, found: false };
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
    return {
      id,
      found: true,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      hitSelf: Boolean(hit && (hit === element || element.contains(hit))),
      hit: hit ? (hit.id || hit.tagName) : null,
    };
  }), CONTROLS);
}

// A click Playwright refuses (covered, zero-sized, detached) throws here instead of measuring
// nothing, which is the whole point of PB-078.
async function pressControl(id) {
  await page.click("#" + id, { timeout: 5000 });
  await sleep(500);
}

async function useTheme(id) {
  // The preference is client-side (localStorage, key openchq.theme) and the switch is cosmetic.
  // Setting it before the match opens is the honest way to capture a named theme; the one-click
  // in-match switch has its own test (T-019 AC1/AC4).
  await page.evaluate((theme) => localStorage.setItem("openchq.theme", theme), id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__chq && window.__chq.me()), null, { timeout: 30000 });
}

async function quitRoom() {
  if (await page.evaluate(() => Boolean(window.__chq.room()))) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
}

async function newGame(era) {
  await quitRoom();
  // The quit toast outlives the room frame; a shot taken through it reads as a live event.
  await page.waitForFunction(() => !window.__chq.toast(), null, { timeout: 12000 }).catch(() => {});
  // Leaving a match returns to the in-match nav; the launch form comes back from "New game".
  if (!(await page.evaluate(() => { const l = document.querySelector("#launch"); return Boolean(l && l.offsetParent); }))) {
    await page.click("#newBtn");
  }
  await page.waitForFunction(() => {
    const l = document.querySelector("#launch");
    return Boolean(l && l.offsetParent);
  }, null, { timeout: 15000 });
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, era,
    { timeout: 20000, polling: 100 });
  // Hold the clock at once: every shot in this matrix is the round 0 opening frame.
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null,
    { timeout: 15000 }).catch(() => {});
  await pressControl("camFit"); // world fit, by the button (PB-078)
  const room = await page.evaluate(() => window.__chq.room());
  return room;
}

async function setView(wanted) {
  // #viewToggle flips terrain <-> Show Ownership. Read the mode from the paint report, not from a
  // guess, and stop as soon as it agrees.
  for (let i = 0; i < 4; i++) {
    const now = await paint();
    const political = (now && now.layers || []).includes("ownership");
    if ((wanted === "ownership") === political) return now;
    await pressControl("viewToggle");
  }
  return paint();
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.commit), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t019" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  for (const theme of THEMES) {
    await useTheme(theme.id);
    const label = await page.evaluate(() => document.getElementById("themeToggle")?.textContent || "");
    mark("theme " + theme.id + " is on before the match", label.includes(theme.label), { label });

    // --- one 1942 shot per theme, terrain, no fog expected --------------------------------
    const r1942 = await newGame("1942");
    const inMatch = await page.evaluate(() => document.body.classList.contains("in-match"));
    const boxes = await controlBoxes();
    // PB-078, measured in the state a player is in: a live match, all six on screen and hittable.
    mark("all six match controls have a box, sit in the window, and are their own hit target (PB-078)",
      boxes.every((box) => box.found && box.w > 0 && box.h > 0 && box.inside && box.hitSelf) && inMatch,
      { inMatch, controls: boxes });
    const p1942 = await setView("terrain");
    const file1942 = await shot("t019-" + theme.id + "-1942-terrain.png");
    mark("1942 " + theme.id + " shot is the round 0 opening",
      String(r1942.round) === "0" && String(r1942.clock) === "held",
      { round: r1942.round, clock: r1942.clock, file: file1942 });
    mark("1942 " + theme.id + " shows the whole map (no fog required)",
      p1942 && p1942.layers && !p1942.layers.includes("fog") && !(p1942.fogged > 0),
      { layers: p1942 && p1942.layers, fogged: p1942 && p1942.fogged, file: file1942 });

    // --- item 3 (PM 6093): the zoom floor is the world fit, and one press is one whole cell ---
    if (theme.id === "C") {
      // --- PB-078: the theme button, pressed inside a live match -----------------------------
      const themeBefore = await page.evaluate(() => document.getElementById("themeToggle")?.textContent || "");
      await pressControl("themeToggle");
      const themeAfter = await page.evaluate(() => document.getElementById("themeToggle")?.textContent || "");
      const fileThemeD = await shot("t019-D-1942-terrain-from-theme-click.png");
      mark("the in-match theme button switches to D on a click",
        themeBefore.includes("Dark tactical") && themeAfter.includes("Classic"),
        { before: themeBefore, after: themeAfter, file: fileThemeD });
      await pressControl("themeToggle");
      const themeBack = await page.evaluate(() => document.getElementById("themeToggle")?.textContent || "");
      mark("the in-match theme button returns to C on a second click", themeBack.includes("Dark tactical"),
        { back: themeBack });

      await pressControl("camFit"); // refit: the floor is the fit (PB-066/067)
      const fitCam = await page.evaluate(() => window.__chq.state().camera);
      await pressControl("camOut");
      const minusCam = await page.evaluate(() => window.__chq.state().camera);
      const fileZoomFloor = await shot("t019-C-zoom-floor-at-fit.png");
      mark("- at fit does not shrink the map (zoom floor = fit)",
        Boolean(fitCam && minusCam) && minusCam.scale === fitCam.scale
          && minusCam.left === fitCam.left && minusCam.top === fitCam.top,
        { fit: fitCam, afterMinus: minusCam, file: fileZoomFloor });
      await pressControl("camIn");
      const plusCam = await page.evaluate(() => window.__chq.state().camera);
      const fileZoomOne = await shot("t019-C-zoom-plus-one-step.png");
      mark("+ from fit is one whole cell of zoom, not a clamp",
        Boolean(fitCam && plusCam) && plusCam.scale === fitCam.scale + 1,
        { fit: fitCam, afterPlus: plusCam, file: fileZoomOne });
      await pressControl("camFit");
    }

    // --- fog shots: Concealed 9999, blue, round 0, both views -----------------------------
    const rFog = await newGame("9999");
    mark("Concealed " + theme.id + " is the round 0 opening",
      String(rFog.round) === "0" && String(rFog.clock) === "held" && String(rFog.era) === "9999",
      { era: rFog.era, round: rFog.round, clock: rFog.clock });

    const terrainFog = await setView("terrain");
    const fileFogTerrain = await shot("t019-" + theme.id + "-concealed-round0-terrain.png");
    mark("Concealed " + theme.id + " terrain draws fog at round 0",
      terrainFog && terrainFog.fogged > 0 && terrainFog.layers && terrainFog.layers.includes("fog"),
      { fogged: terrainFog && terrainFog.fogged, layers: terrainFog && terrainFog.layers, file: fileFogTerrain });

    const ownershipFog = await setView("ownership");
    const fileFogOwn = await shot("t019-" + theme.id + "-concealed-round0-ownership.png");
    const layers = (ownershipFog && ownershipFog.layers) || [];
    mark("Concealed " + theme.id + " Show Ownership draws fog at round 0",
      ownershipFog && ownershipFog.fogged > 0 && layers.includes("ownership") && layers.includes("fog"),
      { fogged: ownershipFog && ownershipFog.fogged, layers, file: fileFogOwn });
    mark("Concealed " + theme.id + " keeps the fill UNDER the fog (PB-071)",
      layers.indexOf("ownership") >= 0 && layers.indexOf("fog") > layers.indexOf("ownership"),
      { layers });
  }

  // --- item 1 (PM 6093 / D-022): a fresh profile with no saved preference opens on C ---------
  const freshContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const freshPage = await freshContext.newPage();
  const freshErrors = [];
  freshPage.on("pageerror", (err) => freshErrors.push(String(err && err.message ? err.message : err)));
  freshPage.on("dialog", (dialog) => dialog.accept().catch(() => {}));
  try {
    await freshPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await freshPage.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    const savedPreference = await freshPage.evaluate(() => localStorage.getItem("openchq.theme"));
    if (!(await freshPage.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
      const name = "t019f" + Date.now().toString(36).slice(-7);
      await freshPage.fill("#register input[name=username]", name);
      await freshPage.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
      await freshPage.click("#register button[type=submit]");
      await freshPage.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    }
    // The label is painted from resolveTheme() at boot, so it is the page's own reading, not markup.
    const freshLabel = await freshPage.evaluate(() => document.getElementById("themeToggle")?.textContent || "");
    const fileFresh = path.join(OUT, "t019-fresh-profile-default.png");
    await freshPage.screenshot({ path: fileFresh });
    console.log("shot " + fileFresh);
    mark("a fresh profile with no saved theme opens on C (D-022)",
      savedPreference === null && freshLabel.includes("Dark tactical"),
      { savedPreference, label: freshLabel, file: fileFresh, pageErrors: freshErrors });
  } finally {
    await freshContext.close();
  }

  mark("no page errors", pageErrors.length === 0, pageErrors);
} finally {
  writeFileSync(path.join(OUT, "t019-shots.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
}

const failed = evidence.filter((row) => !row.ok);
console.log("t019-shots: " + (evidence.length - failed.length) + " passed, " + failed.length + " failed, shots in " + OUT);
if (failed.length) process.exit(1);
