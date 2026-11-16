// T-018 AC4/AC5 live leg: Show Ownership fills the ground, keeps the units, and toggles back.
//
//   node tests/e2e/t018-ownership.mjs --url=http://127.0.0.1:8113 --out=local/t018-shots
//
// What it proves on a real page with a real socket, at the world fit and zoomed:
//   1. the server sends a per-region owner list for the room (184 entries);
//   2. pressing P fills blue-held and red-held ground, and the sea stays sea;
//   3. the units and the capitals are drawn OVER the fill — counted by the badge's own face ink,
//      which no ownership shade can produce (T-018 AC4: the fill used to cover them all);
//   4. Greenland reads white, as docs/captures/era-1942-blue-ownership.png measures it;
//   5. pressing P again puts the terrain back, cell for cell;
//   6. no page errors, and shots land under --out.
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

// Every pixel in a box around a cell's centre, as a colour histogram. The badge's own inks
// (#f2f5fb land / #cfe3f6 sea interior, #1b3f8f blue frame, #8f1b1b red frame) are not in the
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
// actually rendered on each of them. Used for Greenland: the capture paints it white.
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
// The fill pin samples THIS, not a capital's centre: sampling the capital there was sampling a
// badge, which is how the old ownership pin went green over a covered unit.
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
  // Sampled on open ground of each side, not on a capital's centre: the capital marker and any
  // garrison are painted over their cell, which is the behaviour this task is about.
  const blueGround = await groundCell("blue");
  const redGround = await groundCell("red");
  mark("the board offers open held ground to sample on both sides",
    Boolean(blueGround && redGround), { blueGround, redGround });
  await fit();
  const terrainBlue = await inkAt(blueGround);
  const terrainRed = await inkAt(redGround);
  await shot("t018-terrain-fit.png");

  // --- Show Ownership at the world fit --------------------------------------------------------
  await page.keyboard.press("p");
  await sleep(500);
  const ownBlue = await inkAt(blueGround);
  const ownRed = await inkAt(redGround);
  const seaInk = await inkAt({ x: 60, y: 100 });
  mark("Show Ownership fills blue-held ground blue", ownBlue === "#5555ff", { ink: ownBlue, cell: blueGround });
  mark("Show Ownership fills red-held ground red", ownRed === "#ff5555" || ownRed === "#aa0000",
    { ink: ownRed, cell: redGround });
  mark("the sea is still sea", seaInk === "#55ffff", { ink: seaInk });
  mark("the terrain view underneath was not the ownership ink", terrainBlue !== ownBlue || terrainRed !== ownRed,
    { terrainBlue, terrainRed, ownBlue, ownRed });
  const note = await page.evaluate(() => window.__chq.note());
  mark("the note counts regions, not cells", /Ownership: blue holds \d+, red holds \d+, neutral \d+/.test(note), note);
  await shot("t018-ownership-fit.png");

  // --- units, city marks and capitals stay visible over the fill -------------------------------
  // The old check compared a piece's cell with its neighbour's. On a blue owner's edge the
  // neighbour reads #0000aa, the same ink as a blue badge's silhouette, so it went green with every
  // unit covered (caught by the PM's hand-check on f1268d1). This one counts the badge's OWN face
  // inks inside the badge box: #f2f5fb (land) and #cfe3f6 (sea) are not in the ownership palette,
  // so no fill and no owner's edge can produce them.
  const pieces = (await room()).pieces || [];
  const own = pieces.find((piece) => piece && piece.side === "blue");
  const badgeSize = (scale) => Math.max(14, Math.ceil(scale * 3)) + 6;
  if (own) {
    await fit();
    const camera = await page.evaluate(() => window.__chq.state().camera);
    const box = await boxInks(own, badgeSize(Number(camera && camera.scale) || 1));
    const face = (box.hist["#f2f5fb"] || 0) + (box.hist["#cfe3f6"] || 0);
    mark("a unit badge is drawn over the ownership fill (badge face ink, not an edge)", face >= 20,
      { x: own.x, y: own.y, face, box: box.box, inkHistogram: box.hist });
    const markPixel = await boxInks({ x: washington.x, y: washington.y }, badgeSize(Number(camera && camera.scale) || 1));
    const capitalInk = (markPixel.hist["#3d7ec9"] || 0) + (markPixel.hist["#c4473a"] || 0)
      + (markPixel.hist["#f2f7ff"] || 0);
    mark("a capital mark is drawn over the ownership fill", capitalInk > 0,
      { x: washington.x, y: washington.y, capitalInk, inkHistogram: markPixel.hist });
  } else {
    mark("a unit badge is drawn over the ownership fill (badge face ink, not an edge)", false,
      "no blue piece in the room view");
  }

  // --- Greenland is white, as the 1942 capture has it ------------------------------------------
  // Region 125 is the Greenland quad; the capture paints it #ffffff (unheld) with sea around it.
  // A blue reading was reported as a live defect, so the page's own pixels pin the answer.
  const greenland = await regionInks(125);
  const greenBlue = ((greenland.hist || {})["#5555ff"] || 0) + ((greenland.hist || {})["#0000aa"] || 0)
    + ((greenland.hist || {})["#ff5555"] || 0) + ((greenland.hist || {})["#aa0000"] || 0);
  mark("Greenland is unheld white, not a side's colour", !greenland.error && greenland.onScreen > 0 &&
    greenBlue === 0 && ((greenland.hist["#ffffff"] || 0) + (greenland.hist["#55ffff"] || 0) === greenland.onScreen),
    greenland);

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

  // Zoomed badges too: pan onto the own piece and count its face ink again at this scale.
  if (own) {
    await panToCell({ x: own.x, y: own.y });
    await sleep(400);
    const zoomCam = await page.evaluate(() => window.__chq.state().camera);
    const zoomBox = await boxInks(own, badgeSize(Number(zoomCam && zoomCam.scale) || 1));
    const zoomFace = (zoomBox.hist["#f2f5fb"] || 0) + (zoomBox.hist["#cfe3f6"] || 0);
    mark("zoomed, the unit badge is still drawn over the fill", zoomFace >= 20,
      { x: own.x, y: own.y, face: zoomFace, camera: zoomCam, inkHistogram: zoomBox.hist });
    await shot("t018-ownership-zoom-unit.png");
  }

  // --- and back -------------------------------------------------------------------------------
  await page.keyboard.press("p");
  await sleep(500);
  // Back at the world fit, because the terrain ink under Washington is only comparable there.
  await fit();
  const backBlue = await inkAt(blueGround);
  mark("toggling back restores the terrain", backBlue === terrainBlue,
    { backBlue, terrainBlue });
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
