// T-017 AC1: the placement click is forgiving, and the rule has not moved.
//
// Runs against a real page and a real socket, at the whole-world fit (a cell is 1 px there, which
// is exactly where Shane's clicks were missing):
//
//   1. an infantry armed, then a click 1 / 3 / 6 px off a ready friendly city buys the unit ON that
//      city - the snapped cell, not the cell the pointer was over;
//   2. a click 30+ px from any legal cell is refused by the server in its own words and buys
//      nothing (the forgiveness is a target, not a licence);
//   3. a click 4 px off an unready friendly city answers with its ready-at-round sentence;
//   4. screenshots at the fit and zoomed, so the boxes are an exhibit and not a claim.
//
//   node tests/e2e/t017-placement-click.mjs --url=http://127.0.0.1:8110 --out=/mnt/nas/projects/OpenCHQ/local/t017-shots
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/t017-placement-click.mjs --url=<base url> [--out=<dir>] [--era=1942]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t017", "shots")));
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
  writeFileSync(path.join(OUT, "t017-placement-click.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

const room = () => page.evaluate(() => window.__chq.room());
const toast = () => page.evaluate(() => window.__chq.toast());
const state = () => page.evaluate(() => window.__chq.state());
const pieceCount = async () => ((await room()).pieces || []).length;

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

// A click `dx,dy` CSS pixels away from the centre of a board cell. The forgiveness is defined in
// screen pixels, so the offset is added to the point cellToScreen hands back and nothing else.
async function clickCellOffset(cell, dx, dy) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const vp = page.viewportSize();
  if (point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
    await fit();
    return clickCellOffset(cell, dx, dy);
  }
  await page.mouse.click(point.x + dx, point.y + dy);
  await sleep(450);
  return { x: point.x + dx, y: point.y + dy };
}

async function arm(kind) {
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(250);
  await page.click('button.buyrow[data-kind="' + kind + '"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(250);
  return page.evaluate(() => window.__chq.legalCells(6000));
}

// The camera buttons live in the match head, which the in-match shell hides; the keys are the
// player's own controls and do the same thing (app.js: "0" refits, "+"/"-" zoom).
async function fit() {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(350);
  return (await state()).camera;
}
async function zoomIn(times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("+");
    await sleep(200);
  }
  return (await state()).camera;
}

// Arrow keys pan (app.js: ArrowLeft adds to `left`, ArrowUp adds to `top`, each by a fixed step),
// so the camera can be walked onto a city without a synthetic drag on a canvas mid-placement.
async function panToCell(cell, tries = 80) {
  const vp = page.viewportSize();
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  for (let i = 0; i < tries; i++) {
    const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    let moved = false;
    if (at.x < cx - 40) { await page.keyboard.press("ArrowLeft"); moved = true; }
    else if (at.x > cx + 40) { await page.keyboard.press("ArrowRight"); moved = true; }
    // screen y = top + cell * scale, and ArrowUp adds to `top`, so a cell that is too high on
    // screen is brought down by ArrowUp (the first cut had this backwards and walked the camera
    // 8,000 px off the board).
    if (at.y < cy - 40) { await page.keyboard.press("ArrowUp"); moved = true; }
    else if (at.y > cy + 40) { await page.keyboard.press("ArrowDown"); moved = true; }
    if (!moved) return at;
  }
  return page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
}

async function settle() {
  await page.waitForFunction(() => !window.__chq.state().placement, null, { timeout: 8000 }).catch(() => {});
  await sleep(400);
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t017" + Date.now().toString(36).slice(-8);
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
  // The whole-world fit is the zoom the clicks were missing at: the board is as small as the
  // window allows, so a cell is a handful of screen pixels and a one-pixel miss is normal.
  // A running clock burns through a 15-round readiness window while three purchases are driven, so
  // the unready leg would find every city ready again. Hold the clock: this is about click targets.
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null, { timeout: 15000 }).catch(() => {});
  mark("the clock is held so a readiness window cannot expire mid-run", (await room()).clock === "held", { clock: (await room()).clock, round: (await room()).round });

  const cam = await fit();
  const again = await fit();
  mark("the map is at the world fit", Boolean(cam) && Number(cam.scale) >= 1 &&
    Number(cam.scale) === Number(again.scale), { camera: cam, refit: again });

  // --- the forgiveness the server sent ---------------------------------------------------------
  let cells = await arm("infantry");
  const snap = (await state()).placementSnap;
  const box = (await state()).placementBox;
  mark("the page received the snap radius from the server", Boolean(snap) && Number(snap.px) === 12 && Number(snap.cells) === 2,
    { snap, box });
  const ready = cells.filter((c) => c.ready);
  const unready = cells.filter((c) => c.unready);
  mark("the mask has ready cities to aim at", ready.length > 0, { legal: cells.length, ready: ready.length, unready: unready.length });
  const sites = (await room()).sites || [];
  const siteAt = (c) => sites.find((s) => Number(s.x) === c.x && Number(s.y) === c.y);

  // --- AC1 leg 1: 1, 3 and 6 px off a ready city buys ON that city ------------------------------
  // The three sites are chosen with a friendly city inside the readiness radius, so the purchases
  // also leave a tired neighbour for leg 3. 1942's 29 open cities are spread out: most have no
  // neighbour within 5 cells, and picking the first three ready cells left nothing unready.
  const wrapDx = (dx) => Math.min(Math.abs(dx), 320 - Math.abs(dx));
  const within = (a, b) => Math.max(wrapDx(Number(a.x) - Number(b.x)), Math.abs(Number(a.y) - Number(b.y))) <= 5;
  const hasNeighbour = (cell) => cells.some((other) => other !== cell && within(other, cell));
  const bought = [];
  for (const offset of [1, 3, 6]) {
    // Re-read the mask each time: a purchase tires its neighbours, and a cell that was ready for
    // the first click can be byte 2 for the second (measured: Toronto's purchase tired Detroit, so
    // the 3 px click was answered with the ready round instead of placing).
    if (bought.length) {
      cells = await arm("infantry");
      await sleep(200);
    }
    const used = new Set(bought.map((b) => b.x + "," + b.y));
    const target = cells.filter((c) => c.ready && !used.has(c.x + "," + c.y)).find(hasNeighbour);
    if (!target) { mark("a fresh ready city for the " + offset + " px offset", false, { used: [...used] }); break; }
    const before = await pieceCount();
    const at = await clickCellOffset(target, offset, 0);
    await page.waitForFunction((n) => window.__chq.room() && window.__chq.room().pieces.length > n, before, { timeout: 20000 }).catch(() => {});
    await settle();
    const after = (await room()).pieces || [];
    const landed = after.find((p) => String(p.side) === "blue" && Number(p.x) === target.x && Number(p.y) === target.y);
    const off = Math.hypot((await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), target)).x - at.x,
      (await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), target)).y - at.y);
    mark("a click " + offset + " px off bought on the city", Boolean(landed) && after.length === before + 1,
      { city: siteAt(target) ? siteAt(target).name : target, cell: target, clickAt: at, targetScreen: await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), target), distancePx: off, toast: await toast(), piecesBefore: before, piecesAfter: after.length });
    if (landed) bought.push({ ...target, name: siteAt(target) ? siteAt(target).name : null, offset, toast: await toast() });
  }
  mark("clicks 1-6 px off placed on the city", bought.length === 3, { purchases: bought });

  // --- AC1 leg 2: a far click is refused, in the server's words ---------------------------------
  cells = await arm("infantry");
  const far = await page.evaluate(() => {
    const legal = window.__chq.legalCells(6000);
    const vp = { width: window.innerWidth, height: window.innerHeight };
    for (let y = 2; y < 134; y += 3) {
      for (let x = 2; x < 318; x += 3) {
        const at = window.__chq.cellToScreen(x, y);
        if (at.x < 10 || at.y < 10 || at.x > vp.width - 10 || at.y > vp.height - 10) continue;
        let best = Infinity;
        for (const cell of legal) {
          const screen = window.__chq.cellToScreen(cell.x, cell.y);
          const d = Math.hypot(screen.x - at.x, screen.y - at.y);
          if (d < best) best = d;
        }
        if (best > 30) return { cell: { x, y }, at, distance: best };
      }
    }
    return null;
  });
  if (!far) {
    mark("a click far from every legal site is refused", false, { why: "no cell 30 px from every legal cell" });
  } else {
    const before = await pieceCount();
    await page.mouse.click(far.at.x, far.at.y);
    await sleep(500);
    const farToast = await toast();
    const after = await pieceCount();
    mark("a click far from every legal site is refused", /not a valid place/.test(farToast) && after === before,
      { cell: far.cell, clickAt: far.at, nearestLegalPx: far.distance, toast: farToast, piecesBefore: before, piecesAfter: after });
    await shot("t017-far-click-refused.png");
  }

  // --- AC1 leg 3: an unready city answers with its ready round ----------------------------------
  cells = await arm("infantry");
  const tired = cells.filter((c) => c.unready);
  mark("the purchase tired a neighbouring city", tired.length > 0, { unready: tired.length });
  if (tired.length) {
    const target = tired[0];
    const before = await pieceCount();
    // 4 px off: inside the forgiveness, so the click has to reach the unready city and be answered,
    // not miss it and be refused as "not a valid place".
    const at = await clickCellOffset(target, 4, 0);
    await sleep(400);
    const tiredToast = await toast();
    const after = await pieceCount();
    const round = Number((tiredToast.match(/round (\d+)/) || [])[1] || 0);
    mark("a click 4 px off an unready city answers with its ready round",
      /not ready/.test(tiredToast) && round > Number((await room()).round || 0) && after === before,
      { cell: target, clickAt: at, toast: tiredToast, readyRound: round, piecesBefore: before, piecesAfter: after });
    await shot("t017-unready-ready-round.png");
  }

  // --- AC2: the boxes, at the fit and zoomed ---------------------------------------------------
  await settle();
  cells = await arm("infantry");
  const fitCam = await fit();
  const fitShot = await shot("t017-boxes-world-fit.png");
  // Zoom in on a city so the boxes can be seen against the city squares themselves.
  const look = cells.find((c) => c.ready) || cells[0];
  const lookAt = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), look);
  mark("a city to zoom in on", Boolean(lookAt), { cell: look, at: lookAt });
  const zoomCam = await zoomIn(3);
  const centred = await panToCell(look);
  const zoomShot = await shot("t017-boxes-zoomed.png");
  mark("boxes photographed at the fit and zoomed", Boolean(fitShot) && Boolean(zoomShot),
    { fitShot, zoomShot, fitZoom: fitCam, zoomZoom: zoomCam, city: siteAt(look) ? siteAt(look).name : look, cityScreen: centred });

  mark("no page error", pageErrors.length === 0, { errors: pageErrors.slice(0, 4) });

  const failed = evidence.filter((row) => !row.ok);
  console.log("\n" + evidence.length + " checks, " + (evidence.length - failed.length) + " passed, " + failed.length + " failed");
  writeFileSync(path.join(OUT, "t017-placement-click.md"),
    "# T-017 placement click forgiveness on " + (version && version.short) + "\n\n" +
    evidence.map((row) => "- " + (row.ok ? "PASS" : "FAIL") + " " + row.step + " :: `" + JSON.stringify(row.detail) + "`").join("\n") + "\n");
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  await browser.close();
}
