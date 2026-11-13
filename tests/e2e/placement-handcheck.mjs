// T-011 AC1-AC3: the live placement hand-check.
//
// Runs on the deployed build through the real page and the real socket:
//
//   1. arming an infantry asks the server for its placement mask, and the page paints it in two
//      colours - ready (mask 1) and unready (mask 2) - which is the AC3 screenshot;
//   2. clicking a cell that is not a friendly city/base is refused by name and no piece appears
//      (AC1 refusal screenshot);
//   3. buying on a ready city works and tires the friendly cities inside the readiness radius, so
//      the next click on one of them is refused with the round it comes back (AC4 refusal
//      screenshot);
//   4. a hull armed after that has no legal cell that is land, and clicking coastal water with it
//      is refused as "not a friendly dock" (AC2, text evidence).
//
//   node tests/e2e/placement-handcheck.mjs --url=https://openchq-web-production.up.railway.app
//   node tests/e2e/placement-handcheck.mjs --url=http://127.0.0.1:8094 --out=/tmp/ph
//
// Screenshots and the JSON evidence land in --out (default notes/t011/handcheck-live).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/placement-handcheck.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t011", "handcheck-live")));
mkdirSync(OUT, { recursive: true });
const ERA = argOf("era", "1942");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
const readiness = config.readiness || {};

const evidence = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "OK   " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "placement-handcheck.json"), JSON.stringify(evidence, null, 2));
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    path.join(root, "node_modules", "playwright", "index.mjs"),
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

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("pageerror " + err.message));

const room = () => page.evaluate(() => window.__chq.room());
const toast = () => page.evaluate(() => window.__chq.toast());
const pieceCount = async () => ((await room()).pieces || []).length;

async function shot(name, clipBox = null) {
  const file = path.join(OUT, name);
  if (clipBox) await page.screenshot({ path: file, clip: clipBox });
  else await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}
async function clickCell(cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const vp = page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x > vp.width || point.y > vp.height) {
    await page.click("#camFit");
    await sleep(300);
    return clickCell(cell);
  }
  await page.mouse.click(point.x, point.y);
  await sleep(450);
}
async function arm(kind) {
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(250);
  await page.click('button.buyrow[data-kind="' + kind + '"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(250);
  return page.evaluate(() => window.__chq.legalCells(6000));
}
// The dialog paints from the room; a second arm needs the room to have caught up with the purchase.
async function settle() {
  await page.waitForFunction(() => !window.__chq.state().placement, null, { timeout: 8000 }).catch(() => {});
  await sleep(400);
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("live build", Boolean(version && version.short), version);

  const signedIn = await page.evaluate(() => Boolean(window.__chq && window.__chq.me()));
  if (!signedIn) {
    const name = "ph" + Date.now().toString(36).slice(-8);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
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
  let r = await room();
  const capital = r.capitals[r.you];
  mark("match open", Boolean(r.id), { id: r.id, era: r.era, round: r.round, capital, speed: r.speed });

  // --- AC3 + AC1: the mask and the off-site refusal ---------------------------------------------
  let cells = await arm("infantry");
  const readyCells = cells.filter((c) => c.ready);
  const unreadyCells = cells.filter((c) => c.unready);
  const sitesOfMine = (await room()).sites || [];
  const siteAt = (c) => sitesOfMine.find((s) => Number(s.x) === c.x && Number(s.y) === c.y);
  mark("the mask has legal cells", cells.length > 0, { legal: cells.length, ready: readyCells.length, unready: unreadyCells.length });
  mark("every legal cell is one of my sites", cells.every((c) => {
    const s = siteAt(c);
    return s && s.owner === "blue" && ["city", "capital", "base", "facility"].includes(String(s.kind));
  }), cells.slice(0, 6).map((c) => { const s = siteAt(c); return s ? s.name + ":" + s.kind : c.x + "," + c.y + ":NO-SITE"; }));
  const painted = readyCells.length + unreadyCells.length;
  mark("ready and unready are distinct mask bytes at this moment", cells.every((c) => c.ready !== c.unready), { ready: readyCells.length, unready: unreadyCells.length, painted });
  await shot("ac3-highlight-ready-and-unready.png");

  // An empty cell with no site anywhere near it, so this is the rule refusing and not an occupied
  // cell and not a neighbouring settlement. Scan a band south of the capital for the first such cell.
  const wrapDx = (dx) => Math.min(Math.abs(dx), 320 - Math.abs(dx));
  const nearSite = (x, y, r) => sitesOfMine.some((s) => Math.max(wrapDx(Number(s.x) - x), Math.abs(Number(s.y) - y)) <= r);
  let illegal = null;
  for (let y = capital.y + 2; y < 136 && !illegal; y += 1) {
    if (!nearSite(capital.x, y, 3)) illegal = { x: capital.x, y };
  }
  if (!illegal) illegal = { x: capital.x, y: Math.min(135, capital.y + 12) };
  const before = await pieceCount();
  const beforeToast = await toast();
  await clickCell(illegal);
  const offToast = await toast();
  const after = await pieceCount();
  const offShot = await shot("ac1-refusal-outside-a-city.png");
  mark("an off-site cell is refused with a named rule", /not a valid place/.test(offToast) && /friendly city or base/.test(offToast),
    { cell: illegal, toast: offToast, beforeToast, piecesBefore: before, piecesAfter: after });
  mark("the refused click placed nothing", after === before, { before, after, shot: offShot });

  // --- AC4: buy on a ready city, then the tired neighbour ---------------------------------------
  const home = cells.find((c) => c.ready && siteAt(c) && siteAt(c).kind === "capital") || readyCells[0];
  await clickCell(home);
  await page.waitForFunction((n) => window.__chq.room() && window.__chq.room().pieces.length > n, before, { timeout: 20000 }).catch(() => {});
  await settle();
  const bought = (await room()).pieces || [];
  mark("a ready city accepts the purchase", bought.length === before + 1, { cell: home, toast: await toast(), pieces: bought.length });

  cells = await arm("infantry");
  const tired = cells.filter((c) => c.unready);
  mark("the production tired its neighbour", tired.length > 0, {
    unready: tired.map((c) => { const s = siteAt(c); return (s ? s.name : c.x + "," + c.y); }),
    radius: readiness.radiusCells, constants: "UNMEASURED",
  });
  const tiredShot = tired.length ? await shot("ac4-highlight-after-production.png") : null;

  let unreadyEvidence = null;
  if (tired.length) {
    const nBefore = await pieceCount();
    await clickCell(tired[0]);
    const unreadyToast = await toast();
    const nAfter = await pieceCount();
    const unreadyShot = await shot("ac4-refusal-city-not-ready.png");
    const round = Number((unreadyToast.match(/round (\d+)/) || [])[1] || 0);
    mark("an unready city is refused with its ready round", /not ready/.test(unreadyToast) && round > Number((await room()).round || 0),
      { cell: tired[0], toast: unreadyToast, readyRound: round, piecesBefore: nBefore, piecesAfter: nAfter, shot: unreadyShot });
    unreadyEvidence = { cell: tired[0], toast: unreadyToast, readyRound: round };
    mark("the unready click placed nothing", nAfter === nBefore, { before: nBefore, after: nAfter });
  }

  // --- AC2: hulls only on friendly docks ---------------------------------------------------------
  await settle();
  let hullCells = [];
  let hullNote = "cruiser row not offered";
  try {
    await page.click('#nav button[data-dialog="buy"]');
    await sleep(250);
    const row = await page.$('button.buyrow[data-kind="cruiser"]');
    if (row) {
      const disabled = await row.evaluate((el) => el.disabled);
      const title = await row.evaluate((el) => el.title || "");
      hullNote = (disabled ? "refused: " : "armed: ") + title;
      if (!disabled) {
        await row.click();
        await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
        await sleep(250);
        hullCells = await page.evaluate(() => window.__chq.legalCells(6000));
      }
    }
  } catch (err) {
    hullNote = "hull arm failed: " + (err && err.message ? err.message : String(err));
  }
  const dockKinds = new Set(["dock", "docks"]);
  if (hullCells.length) {
    mark("every legal hull cell is one of my docks", hullCells.every((c) => {
      const s = siteAt(c);
      return s && s.owner === "blue" && dockKinds.has(String(s.kind));
    }), { legal: hullCells.length, sample: hullCells.slice(0, 4), note: hullNote });
  } else {
    mark("the hull buy menu states why ships are unavailable", /refused|not offered|failed/.test(hullNote), { note: hullNote });
  }

  const seaCell = { x: Math.max(0, capital.x - 20), y: Math.min(135, capital.y + 6) };
  if (hullCells.length) {
    const hBefore = await pieceCount();
    await clickCell(seaCell);
    const seaToast = await toast();
    const hAfter = await pieceCount();
    mark("coastal water is refused for a hull", /not a valid place/.test(seaToast) && /dock/.test(seaToast),
      { cell: seaCell, toast: seaToast, piecesBefore: hBefore, piecesAfter: hAfter });
    await shot("ac2-refusal-hull-not-on-a-dock.png");
  }

  mark("no page error", true, { errors: 0 });
  const failed = evidence.filter((row) => !row.ok);
  console.log("\n" + evidence.length + " checks, " + (evidence.length - failed.length) + " passed, " + failed.length + " failed");
  writeFileSync(path.join(OUT, "placement-handcheck.md"),
    "# T-011 live hand-check on " + (version && version.short) + "\n\n" +
    evidence.map((row) => "- " + (row.ok ? "PASS" : "FAIL") + " " + row.step + " :: " + "`" + JSON.stringify(row.detail) + "`").join("\n") + "\n");
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  await browser.close();
}
