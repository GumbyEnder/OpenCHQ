// T-021 AC2/AC3: a hull is bought by clicking a friendly coastal city or base, and the click is
// forgiving in the T-017 way (1 / 3 / 6 px off still buys). The hull lands on the water beside the
// site, docks first; an inland city still refuses a ship.
//
//   node tests/e2e/t021-coastal-placement.mjs --url=http://127.0.0.1:8200 --out=.../local/t021-shots
//
// The berth rule is D-025, a deliberate deviation (the original allows ships only on docks,
// manual printed p.28): the write-up for the gate records it as a remake choice, not an original
// rule. Everything below is driven through the page's own send() path, like a player.
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
  console.error("usage: node tests/e2e/t021-coastal-placement.mjs --url=<base url> [--out=<dir>] [--era=1942]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "worktrees", "t021", "local", "t021-shots")));
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
  writeFileSync(path.join(OUT, "t021-coastal-placement.json"), JSON.stringify(evidence, null, 2));
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

async function fit() {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(350);
  return (await state()).camera;
}

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
  const row = await page.$('button.buyrow[data-kind="' + kind + '"]');
  if (!row) return { error: "no " + kind + " row in the buy dialog", cells: [] };
  const disabled = await row.evaluate((el) => el.disabled || el.classList.contains("off"));
  if (disabled) return { error: "the " + kind + " row is disabled", cells: [] };
  await page.click('button.buyrow[data-kind="' + kind + '"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(250);
  return { cells: await page.evaluate(() => window.__chq.legalCells(6000)) };
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
    const name = "t021" + Date.now().toString(36).slice(-8);
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
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null, { timeout: 15000 }).catch(() => {});
  mark("the clock is held so a readiness window cannot expire mid-run", (await room()).clock === "held", { round: (await room()).round });

  const cam = await fit();
  mark("the map is at the world fit", Number(cam && cam.scale) >= 1, { camera: cam });

  // ---- the board, as the page has it, so "coastal" is the page's own terrain ---------------
  const board = await page.evaluate(() => {
    const b = window.__chq.board();
    return { width: b.width, height: b.height, cells: b.cells };
  });
  const W = Number(board.width);
  const H = Number(board.height);
  const terrain = (x, y) => {
    const cx = ((Number(x) % W) + W) % W;
    if (y < 0 || y >= H) return null;
    return Number(board.cells[y * W + cx]);
  };
  const ADJ = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const waterIds = (x, y) => ADJ
    .map(([dx, dy]) => ({ x: ((x + dx) % W + W) % W, y: y + dy }))
    .filter((c) => c.y >= 0 && c.y < H && terrain(c.x, c.y) !== null && terrain(c.x, c.y) <= 2);

  let armed = await arm("cruiser");
  mark("the buy dialog offers a cruiser", !armed.error, { error: armed.error || null });
  let cells = armed.cells || [];
  const snap = (await state()).placementSnap;
  mark("the page received the T-017 snap with the hull mask", Boolean(snap) && Number(snap.px) === 12, { snap });
  const sites = (await room()).sites || [];
  const siteAt = (c) => sites.find((s) => Number(s.x) === Number(c.x) && Number(s.y) === Number(c.y));
  const settlement = (c) => {
    const s = siteAt(c);
    return Boolean(s) && ["city", "capital", "base", "facility"].includes(String(s.kind));
  };
  const coastal = cells.filter((c) => c.ready && settlement(c) && waterIds(c.x, c.y).length > 0);
  mark("the mask highlights friendly coastal cities or bases, not only docks", coastal.length > 0,
    { legal: cells.length, coastal: coastal.length, first: coastal.slice(0, 3).map((c) => ({ cell: c, name: (siteAt(c) || {}).name })) });

  // ---- AC2/AC3: 1, 3 and 6 px off still buys, and the hull lands on the water beside -------
  const bought = [];
  for (const offset of [1, 3, 6]) {
    armed = await arm("cruiser");
    if (armed.error) { mark("the cruiser row is still buyable for the " + offset + " px click", false, armed); break; }
    cells = armed.cells || [];
    const used = new Set(bought.map((b) => b.x + "," + b.y));
    const target = cells.filter((c) => c.ready && settlement(c) && waterIds(c.x, c.y).length > 0 && !used.has(c.x + "," + c.y))[0];
    if (!target) { mark("a fresh ready coastal site for the " + offset + " px offset", false, { used: [...used] }); break; }
    // Count BLUE cruisers, not pieces: the bot opponent keeps buying while the clock is held, so
    // a total-piece delta is not this purchase (the first run failed on a 6 px click whose hull
    // had in fact landed, because the opponent's three buys moved the total by four).
    const before = ((await room()).pieces || []).filter((p) => String(p.side) === "blue" && String(p.kind) === "cruiser").length;
    const at = await clickCellOffset(target, offset, 0);
    await page.waitForFunction((n) => {
      const hulls = (window.__chq.room().pieces || []).filter((p) => String(p.side) === "blue" && String(p.kind) === "cruiser");
      return hulls.length > n;
    }, before, { timeout: 20000 }).catch(() => {});
    await settle();
    const after = (await room()).pieces || [];
    const hulls = after.filter((p) => String(p.side) === "blue" && String(p.kind) === "cruiser");
    const landed = hulls[hulls.length - 1];
    const gained = hulls.length - before;
    const berths = waterIds(target.x, target.y);
    const onBerth = Boolean(landed) && berths.some((c) => Number(c.x) === Number(landed.x) && Number(c.y) === Number(landed.y));
    const dockBerth = berths.find((c) => terrain(c.x, c.y) === 1);
    const dockFirst = !dockBerth || (Boolean(landed) && Number(landed.x) === dockBerth.x && Number(landed.y) === dockBerth.y);
    const site = siteAt(target);
    mark("a click " + offset + " px off a coastal site buys a hull on the water beside it",
      Boolean(landed) && onBerth && gained === 1 && dockFirst,
      { site: site ? site.name : null, clickedCell: target, clickAt: at, berthCell: landed ? { x: landed.x, y: landed.y } : null,
        berthTerrain: landed ? terrain(landed.x, landed.y) : null, dockBerth, dockFirst, toast: await toast(),
        blueCruisersBefore: before, blueCruisersAfter: hulls.length, gained, piecesTotal: after.length });
    if (landed && onBerth) bought.push({ ...target, name: site ? site.name : null, offset, berth: { x: landed.x, y: landed.y } });
  }
  mark("clicks 1-6 px off a coastal city buy a hull each time", bought.length === 3, { purchases: bought });

  // ---- an inland city still refuses a ship ------------------------------------------------
  const inland = sites.find((s) => {
    if (!["city", "capital", "base", "facility"].includes(String(s.kind))) return false;
    if (String(s.owner) !== "blue") return false;
    if (waterIds(Number(s.x), Number(s.y)).length) return false;
    const at = { x: Number(s.x), y: Number(s.y) };
    return !cells.some((c) => Number(c.x) === at.x && Number(c.y) === at.y);
  });
  if (!inland) {
    mark("an inland friendly city exists to refuse", false, { why: "1942 blue holds no inland settlement" });
  } else {
    armed = await arm("cruiser");
    const blueCruisers = async () => ((await room()).pieces || [])
      .filter((p) => String(p.side) === "blue" && String(p.kind) === "cruiser").length;
    const before = await blueCruisers();
    const at = await clickCellOffset({ x: Number(inland.x), y: Number(inland.y) }, 0, 0);
    await sleep(500);
    const text = await toast();
    const after = await blueCruisers();
    mark("a click on an inland city buys no hull and says why", after === before && /not a valid place|is inland|Ships go/.test(text),
      { city: inland.name, cell: { x: inland.x, y: inland.y }, clickAt: at, toast: text, blueCruisersBefore: before, blueCruisersAfter: after });
    await settle();
  }

  // ---- the exhibit --------------------------------------------------------------------------
  armed = await arm("cruiser");
  await fit();
  const fitShot = await shot("t021-hull-mask-world-fit.png");
  const look = (armed.cells || []).filter((c) => c.ready && settlement(c))[0] || (armed.cells || [])[0];
  if (look) {
    await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), look);
    await page.keyboard.press("+");
    await sleep(250);
    await page.keyboard.press("+");
    await sleep(250);
  }
  const zoomShot = await shot("t021-hull-mask-zoomed.png");
  mark("hull mask photographed at the fit and zoomed", Boolean(fitShot) && Boolean(zoomShot), { fitShot, zoomShot });

  mark("no page error", pageErrors.length === 0, { errors: pageErrors.slice(0, 4) });

  const failed = evidence.filter((row) => !row.ok);
  console.log("\n" + evidence.length + " checks, " + (evidence.length - failed.length) + " passed, " + failed.length + " failed");
  writeFileSync(path.join(OUT, "t021-coastal-placement.md"),
    "# T-021 coastal hull placement on " + (version && version.short) + "\n\n" +
    evidence.map((row) => "- " + (row.ok ? "PASS" : "FAIL") + " " + row.step + " :: `" + JSON.stringify(row.detail) + "`").join("\n") + "\n");
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  await browser.close();
}
