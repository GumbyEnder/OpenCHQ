// T-018 AC4/AC5 live leg: Show Ownership fills the ground, keeps the units, and toggles back.
//
//   node tests/e2e/t018-ownership.mjs --url=http://127.0.0.1:8113 --out=local/t018-shots
//
// PB-091: the leg used to hard-code the Classic (D) inks — #5555ff blue, #ff5555 red, #55ffff sea,
// #ffffff neutral — and went 13/5 on the default Dark tactical (C) theme (D-022). Every ownership
// assertion below reads a per-theme table, and the whole ownership block runs on BOTH themes,
// switched by clicking the in-match theme control (the path a player has, PB-078), never by a saved
// preference. The evidence JSON records the sha the page served.
//
// What it proves on a real page with a real socket, on each theme:
//   1. the server sends a per-region owner list for the room (184 entries);
//   2. pressing P fills blue-held and red-held ground in that theme's own inks, and the sea stays sea;
//   3. the two themes are distinguishable — C's measured fill is NOT D's ink (a hard-coded table fails);
//   4. the units and the capitals are drawn OVER the fill — counted by the badge's own face ink,
//      which no ownership shade can produce (T-018 AC4: the fill used to cover them all);
//   5. Greenland reads the theme's unheld neutral, as the 1942 capture measures it;
//   6. zoomed, held ground is still the theme's fill and the badge still draws over it;
//   7. pressing P again puts the terrain back, cell for cell;
//   8. no page errors, and shots land under --out.
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

// One row per shipped theme, mirroring web/public/themes.mjs (DARK_OWNERSHIP / CLASSIC_OWNERSHIP).
// The leg reads pixels, so the table it compares against has to be the shipped one. A palette that
// moves without this table moving goes red — that is the pin PB-091 was missing: it was the other
// way round, a D-only table grading a C page (13/5 live at a3cad05).
const THEME_INKS = {
  C: {
    label: "Dark tactical",
    blue: "#1b3f66",
    red: ["#5a232a", "#ff5a5a"],
    sea: "#05080f",
    neutral: "#2a2f36",
    side: ["#1b3f66", "#35d0ff", "#5a232a", "#ff5a5a"],
    // The site marks paintSiteTicks restamps over the fill, from the theme's terrain table.
    city: "#eef4ff",
    capital: "#ffd166",
  },
  D: {
    label: "Classic",
    blue: "#5555ff",
    red: ["#ff5555", "#aa0000"],
    sea: "#55ffff",
    neutral: "#ffffff",
    side: ["#5555ff", "#0000aa", "#ff5555", "#aa0000"],
    city: "#000000",
    capital: "#ffff55",
  },
};
const THEME_ORDER = ["C", "D"];

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
let served = null;
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "t018-ownership.json"),
    JSON.stringify({
      served,
      checks: evidence.length,
      passed: evidence.filter((r) => r.ok).length,
      failed: evidence.filter((r) => !r.ok).length,
      evidence,
    }, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

const room = () => page.evaluate(() => window.__chq.room());
const board = () => page.evaluate(() => window.__chq.board());
const themeLabel = () => page.evaluate(() => (document.getElementById("themeToggle") || {}).textContent || "");

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

// Every pixel in a box around a cell's centre, as a colour histogram. The badge's own inks
// (#f2f5fb land / #cfe3f6 sea interior, #1b3f8f blue frame, #8f1b1b red frame) are in neither
// ownership palette, so a non-zero count here cannot come from a fill or from an owner's edge.
async function boxInks(cell, cssSize) {
  return page.evaluate(({ x, y, cssSize }) => {
    const canvas = document.querySelector("#board");
    const ctx = canvas.getContext("2d");
    const point = window.__chq.cellToScreen(x + 0.5, y + 0.5);
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const cx = Math.round((point.x - rect.left) * ratio);
    const cy = Math.round((point.y - rect.top) * ratio);
    const half = Math.max(1, Math.round((cssSize * ratio) / 2));
    const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
    const w = Math.min(canvas.width - x0, half * 2), h = Math.min(canvas.height - y0, half * 2);
    const data = ctx.getImageData(x0, y0, w, h).data;
    const hist = {};
    for (let i = 0; i < data.length; i += 4) {
      const ink = "#" + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      hist[ink] = (hist[ink] || 0) + 1;
    }
    return { box: { x0, y0, w, h, ratio }, hist };
  }, { x: cell.x, y: cell.y, cssSize });
}

// The cells of one baked region, read from the geometry the page draws from, and the ink the page
// actually rendered on each of them. Used for Greenland: unheld ground is the theme's neutral.
async function regionInks(rid) {
  return page.evaluate((wanted) => {
    const board = window.__chq.board();
    const geo = board && board.territory;
    if (!geo || !Array.isArray(geo.regionRuns)) return { error: "no geometry" };
    const W = geo.width, H = geo.height, NO = geo.noRegion ?? 255;
    const grid = new Uint8Array(W * H).fill(NO);
    let at = 0;
    for (const [id, count] of geo.regionRuns) { grid.fill(id, at, at + count); at += count; }
    const canvas = document.querySelector("#board");
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const hist = {};
    let onScreen = 0, offscreen = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== wanted) continue;
      const x = i % W, y = Math.floor(i / W);
      const point = window.__chq.cellToScreen(x + 0.5, y + 0.5);
      if (point.x < rect.left || point.x >= rect.right || point.y < rect.top || point.y >= rect.bottom) {
        offscreen += 1;
        continue;
      }
      const px = Math.max(0, Math.min(canvas.width - 1, Math.round((point.x - rect.left) * ratio)));
      const py = Math.max(0, Math.min(canvas.height - 1, Math.round((point.y - rect.top) * ratio)));
      const d = ctx.getImageData(px, py, 1, 1).data;
      const ink = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      hist[ink] = (hist[ink] || 0) + 1;
      onScreen += 1;
    }
    return { rid: wanted, onScreen, offscreen, hist };
  }, rid);
}

// A cell deep inside ground one side holds, away from every piece and every site (the capital
// marker and a garrison both paint over their cell now that they are drawn on top of the fill).
// The fill pin samples THIS, not a capital's centre: at a zoomed scale the capital's own name plate
// covers that centre, and reading a label as "not red" is reading a label, not a fill.
async function groundCell(owner) {
  return page.evaluate((wanted) => {
    const board = window.__chq.board();
    const room = window.__chq.room();
    const geo = board && board.territory;
    const owners = room && room.ownership && Array.isArray(room.ownership.owners)
      ? room.ownership.owners : null;
    if (!geo || !owners) return null;
    const W = geo.width, H = geo.height, NO = geo.noRegion ?? 255;
    const grid = new Uint8Array(W * H).fill(NO);
    let at = 0;
    for (const [id, count] of geo.regionRuns) { grid.fill(id, at, at + count); at += count; }
    const blocker = [...(room.pieces || []), ...(room.sites || [])];
    const water = new Set(["ocean", "lake"]);
    const ownerAt = (x, y) => {
      if (y < 0 || y >= H) return null;
      const cx = ((x % W) + W) % W;
      const rid = grid[y * W + cx];
      return rid === NO ? null : owners[rid];
    };
    for (let i = 0; i < grid.length; i++) {
      if (owners[grid[i]] !== wanted) continue;
      const x = i % W, y = Math.floor(i / W);
      // Interior only: a border cell reads the owner's edge shade, not the fill.
      if (ownerAt(x - 1, y) !== wanted || ownerAt(x + 1, y) !== wanted
        || ownerAt(x, y - 1) !== wanted || ownerAt(x, y + 1) !== wanted) continue;
      if (blocker.some((b) => Math.max(Math.abs(Number(b.x) - x), Math.abs(Number(b.y) - y)) <= 4)) continue;
      const cellId = board.cells ? board.cells[i] : null;
      const name = board.terrain && cellId !== null ? board.terrain[cellId] : null;
      if (water.has(name)) continue;
      return { x, y, terrain: name };
    }
    return null;
  }, owner);
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

// Press P only if the page is not already in the requested view. The painter reports its own layer
// list, so the view is a fact the page states, not an assumption about key state.
async function setView(wanted) {
  for (let i = 0; i < 3; i++) {
    const report = await page.evaluate(() => window.__chq.paintReport());
    const inOwnership = Boolean(report && Array.isArray(report.layers) && report.layers.includes("ownership"));
    if (inOwnership === (wanted === "ownership")) return true;
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await page.keyboard.press("p");
    await sleep(450);
  }
  return false;
}

// Switch by clicking the control the player has (PB-078). A click on the wrong element silently
// leaves the theme where it was, so the label is read back and a mismatch is a failure.
async function setTheme(id) {
  for (let i = 0; i < 3; i++) {
    if ((await themeLabel()) === "Map: " + THEME_INKS[id].label) return true;
    await page.click("#themeToggle");
    await sleep(450);
  }
  return (await themeLabel()) === "Map: " + THEME_INKS[id].label;
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  served = version || null;
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

  // --- the geometry rides with the board, the owners with the room (theme-independent) ----------
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

  const blueGround = await groundCell("blue");
  const redGround = await groundCell("red");
  mark("the board offers open held ground to sample on both sides",
    Boolean(blueGround && redGround), { blueGround, redGround });

  const pieces = (await room()).pieces || [];
  const own = pieces.find((piece) => piece && piece.side === "blue");
  const badgeSize = (scale) => Math.max(14, Math.ceil(scale * 3)) + 6;

  // PB-098 count, not a spot check: every non-capital city that is on screen and not crowded by a
  // piece (a badge would sit on it), counted in Terrain and again in Show Ownership. A theme whose
  // city ink equals the fill scores 0 in Ownership and the two counts stop matching.
  const isCity = (site) => Boolean(site && site.name) && !(Number(site.type) === 1 || Number(site.type) === 2);
  const nearPiece = (site) => pieces.some((piece) => Math.abs(Number(piece.x) - Number(site.x)) <= 2 &&
    Math.abs(Number(piece.y) - Number(site.y)) <= 2);
  const onScreen = (site) => page.evaluate(({ x, y }) => {
    const point = window.__chq.cellToScreen(x + 0.5, y + 0.5);
    const rect = document.querySelector("#board").getBoundingClientRect();
    return point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
  }, { x: site.x, y: site.y });
  async function countCityMarks(list, ink) {
    let found = 0;
    const missed = [];
    for (const site of list) {
      const box = await boxInks({ x: site.x, y: site.y }, 7);
      if ((box.hist || {})[ink]) found += 1;
      else missed.push(site.name);
    }
    return { found, missed };
  }
  const probeCities = [];
  for (const site of sites.filter(isCity).filter((site) => !nearPiece(site))) {
    if (await onScreen(site)) probeCities.push(site);
    if (probeCities.length >= 30) break;
  }

  const measured = {};
  for (const themeId of THEME_ORDER) {
    const inks = THEME_INKS[themeId];
    const tag = "theme " + themeId + " (" + inks.label + ")";
    const themeSet = await setTheme(themeId);
    mark(tag + " is the theme on the board", themeSet, { label: await themeLabel() });
    await fit();
    await setView("terrain");

    // --- terrain first, so the toggle has something to differ from -----------------------------
    const terrainBlue = await inkAt(blueGround);
    const terrainRed = await inkAt(redGround);
    const terrainCities = await countCityMarks(probeCities, inks.city);
    await shot("t018-" + themeId + "-terrain-fit.png");

    // --- Show Ownership at the world fit --------------------------------------------------------
    const inOwnership = await setView("ownership");
    mark(tag + ": P puts the page in Show Ownership", inOwnership,
      (await page.evaluate(() => window.__chq.paintReport())).layers);
    const ownBlue = await inkAt(blueGround);
    const ownRed = await inkAt(redGround);
    const seaInk = await inkAt({ x: 60, y: 100 });
    measured[themeId] = { ownBlue, ownRed, seaInk, terrainBlue, terrainRed };
    mark(tag + ": Show Ownership fills blue-held ground in this theme's blue", ownBlue === inks.blue,
      { ink: ownBlue, wanted: inks.blue, cell: blueGround });
    mark(tag + ": Show Ownership fills red-held ground in this theme's red", inks.red.includes(ownRed),
      { ink: ownRed, wanted: inks.red, cell: redGround });
    mark(tag + ": the sea is still sea", seaInk === inks.sea, { ink: seaInk, wanted: inks.sea });
    mark(tag + ": the terrain view underneath was not the ownership ink",
      terrainBlue !== ownBlue || terrainRed !== ownRed, { terrainBlue, terrainRed, ownBlue, ownRed });
    const note = await page.evaluate(() => window.__chq.note());
    mark(tag + ": the note counts regions, not cells",
      /Ownership: blue holds \d+, red holds \d+, neutral \d+/.test(note), note);
    await shot("t018-" + themeId + "-ownership-fit.png");

    // --- units, city marks and capitals stay visible over the fill ------------------------------
    // The old check compared a piece's cell with its neighbour's. On a blue owner's edge the
    // neighbour reads the edge ink, the same shade as a blue badge's silhouette, so it went green
    // with every unit covered (caught by the PM's hand-check on f1268d1). This one counts the
    // badge's OWN face inks inside the badge box: #f2f5fb (land) and #cfe3f6 (sea) are in neither
    // ownership palette, so no fill and no owner's edge can produce them.
    if (own) {
      const camera = await page.evaluate(() => window.__chq.state().camera);
      const box = await boxInks(own, badgeSize(Number(camera && camera.scale) || 1));
      const face = (box.hist["#f2f5fb"] || 0) + (box.hist["#cfe3f6"] || 0);
      mark(tag + ": a unit badge is drawn over the ownership fill (badge face ink, not an edge)", face >= 20,
        { x: own.x, y: own.y, face, box: box.box });
      const markPixel = await boxInks({ x: washington.x, y: washington.y }, badgeSize(Number(camera && camera.scale) || 1));
      const capitalInk = (markPixel.hist["#3d7ec9"] || 0) + (markPixel.hist["#c4473a"] || 0)
        + (markPixel.hist["#f2f7ff"] || 0);
      mark(tag + ": a capital mark is drawn over the ownership fill", capitalInk > 0,
        { x: washington.x, y: washington.y, capitalInk });
    } else {
      mark(tag + ": a unit badge is drawn over the ownership fill (badge face ink, not an edge)", false,
        "no blue piece in the room view");
    }

    // --- every on-screen city is still visible in Show Ownership, and the count matches Terrain
    // (PB-098 AC a+b). The fill covers the ground the terrain view drew cities on, so the only thing
    // that makes a town findable here is paintSiteTicks' restamp. At 0764ff9 that restamp used
    // Classic's black whatever the theme, and in C a black square on #2a2f36 / #1b3f66 was invisible.
    const ownershipCities = await countCityMarks(probeCities, inks.city);
    // The count that matters is ownership-vs-terrain, not probe count: a city under a badge or a
    // name plate can be unreadable in BOTH views, and that is not an ownership regression. A city
    // that Terrain shows and Ownership loses is.
    mark(tag + ": Show Ownership keeps the city marks Terrain draws (count matches)",
      probeCities.length > 0 && ownershipCities.found === terrainCities.found && ownershipCities.found > 0,
      { terrain: terrainCities.found, ownership: ownershipCities.found, probed: probeCities.length,
        ink: inks.city, missedOwnership: ownershipCities.missed, missedTerrain: terrainCities.missed });

    // --- Greenland is the theme's unheld neutral, as the 1942 capture has it --------------------
    // Region 125 is the Greenland quad; the capture paints it unheld. In D that is #ffffff with
    // #55ffff sea around it; in C white islands read as fog at night, so the neutral is a shade of
    // the sea (#2a2f36). Either way: no side's colour, and every on-screen cell is neutral or sea.
    const greenland = await regionInks(125);
    const greenSide = inks.side.reduce((sum, ink) => sum + ((greenland.hist || {})[ink] || 0), 0);
    const greenUnheld = ((greenland.hist || {})[inks.neutral] || 0) + ((greenland.hist || {})[inks.sea] || 0);
    mark(tag + ": Greenland is unheld neutral, not a side's colour", !greenland.error &&
      greenland.onScreen > 0 && greenSide === 0 && greenUnheld === greenland.onScreen,
      { rid: greenland.rid, onScreen: greenland.onScreen, greenSide, greenUnheld, hist: greenland.hist });

    // --- zoomed ---------------------------------------------------------------------------------
    // Zoom first, then bring the cell back to the middle: the zoom anchors on the middle of the
    // board, so a cell away from it drifts out of the viewport on the way in.
    await zoomIn(3);
    await panToCell(redGround);
    await sleep(400);
    const zoomRed = await inkAt(redGround);
    const cam = await page.evaluate(() => window.__chq.state().camera);
    mark(tag + ": zoomed, held ground is still this theme's red", inks.red.includes(zoomRed),
      { ink: zoomRed, wanted: inks.red, cell: redGround, camera: cam });
    await shot("t018-" + themeId + "-ownership-zoom.png");

    // Zoomed badges too: pan onto the own piece and count its face ink again at this scale.
    if (own) {
      await panToCell({ x: own.x, y: own.y });
      await sleep(400);
      const zoomCam = await page.evaluate(() => window.__chq.state().camera);
      const zoomBox = await boxInks(own, badgeSize(Number(zoomCam && zoomCam.scale) || 1));
      const zoomFace = (zoomBox.hist["#f2f5fb"] || 0) + (zoomBox.hist["#cfe3f6"] || 0);
      mark(tag + ": zoomed, the unit badge is still drawn over the fill", zoomFace >= 20,
        { x: own.x, y: own.y, face: zoomFace, camera: zoomCam });
      await shot("t018-" + themeId + "-ownership-zoom-unit.png");
    }

    // --- zoomed: a city mark is still there at scale --------------------------------------------
    if (probeCities.length) {
      const zoomCity = probeCities[0];
      await panToCell({ x: zoomCity.x, y: zoomCity.y });
      await sleep(400);
      const zoomCityBox = await boxInks({ x: zoomCity.x, y: zoomCity.y }, 9);
      mark(tag + ": zoomed, a city mark is still visible over the fill (" + zoomCity.name + ")",
        ((zoomCityBox.hist || {})[inks.city] || 0) > 0,
        { site: zoomCity.name, ink: inks.city, count: (zoomCityBox.hist || {})[inks.city] || 0 });
    }

    // --- and back --------------------------------------------------------------------------------
    const terrainBack = await setView("terrain");
    await fit();
    const backBlue = await inkAt(blueGround);
    mark(tag + ": toggling back restores the terrain", terrainBack && backBlue === terrainBlue,
      { backBlue, terrainBlue });
    await shot("t018-" + themeId + "-terrain-back.png");
  }

  // --- the tables are two tables, not one hard-coded ink ----------------------------------------
  // A leg that compares both themes against a single expectation cannot see a palette that never
  // moved. This is the assertion a D-only table fails on a C page (PB-091's 13/5, inverted).
  const cBlue = measured.C && measured.C.ownBlue;
  const dBlue = measured.D && measured.D.ownBlue;
  mark("C and D fill blue-held ground with different inks (the table is per theme)",
    Boolean(cBlue && dBlue) && cBlue !== dBlue && cBlue === THEME_INKS.C.blue && dBlue === THEME_INKS.D.blue,
    { C: cBlue, D: dBlue });

  mark("no page errors", pageErrors.length === 0, pageErrors);
} catch (err) {
  mark("run completed", false, String(err && err.message ? err.message : err));
  await shot("t018-failure.png").catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

const failed = evidence.filter((row) => !row.ok);
console.log(`${evidence.length - failed.length} passed, ${failed.length} failed · served ${served && served.short}`);
if (failed.length) process.exit(1);
