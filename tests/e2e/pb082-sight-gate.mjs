// PB-082 live leg: the sight gate on a real page, and sayNotes proven from room.notes.
//
//   node tests/e2e/pb082-sight-gate.mjs --url=http://127.0.0.1:8118 --out=local/pb082-shots
//
// The node pin (web/test/nodes/pb082_sight_gate.mjs) proves the painter's rule with a hand-built
// table. This leg proves the page: that app.js builds the gate from the fog it passes to the
// painter, that the marker layers actually lose their ink on unknown ground, and that the server's
// "Moscow has not been found." reaches the screen because app.js reads room.notes.
//
// Arms:
//   1. 9999 blue at the fit: room.notes is the server's line, and the flash carries it exactly once
//      (a second copy would be the "said per frame" bug this line is at risk of);
//   2. the gate is live: __chq.sight() reports an unknown majority, and the political view's site
//      ticks are exactly the sites the gate lets through (the painter's own count against the
//      page's own gate - no screenshot is read back);
//   3. capitals: exactly the capitals the gate allows are ringed (round 0: Washington only);
//   4. 1942 control: no fog, no gate, every city and both capitals drawn, and the note line gone -
//      which is also the clear arm for sayNotes (the line is keyed to the room's notes, not to a
//      one-time announcement).
//   5. four shots: 9999 terrain fit, 9999 terrain at label zoom, 9999 political, 1942 political.
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
  console.error("usage: node tests/e2e/pb082-sight-gate.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb082", "shots")));
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

const evidence = [];
let failed = 0;
function mark(step, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "pb082-sight-gate.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
page.on("dialog", (dialog) => dialog.accept());

const room = () => page.evaluate(() => window.__chq.room());
const toast = () => page.evaluate(() => window.__chq.toast());
const report = () => page.evaluate(() => window.__chq.paintReport());
const sight = () => page.evaluate(() => window.__chq.sight());
// The page's own gate, cell by cell: the same table the painters read.
const gateAt = (sites) => page.evaluate((list) => list.map((s) => window.__chq.sightCell(s.x, s.y)), sites);

async function launch(era) {
  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.evaluate(() => { try { localStorage.setItem("openchq.theme", "C"); } catch (err) { void err; } });
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, era,
    { timeout: 20000, polling: 100 });
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null,
    { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0"); // fit
  await sleep(500);
}

async function shot(file) {
  const target = path.join(OUT, file);
  await page.locator("#board").screenshot({ path: target });
  return target;
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const name = "pb082" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });

  // ---- arm 1: 9999, the line is on the screen --------------------------------------------
  await launch("9999");
  const first = await room();
  const line = "Moscow has not been found.";
  mark("9999 room.notes carries the server's line",
    JSON.stringify(first.notes) === JSON.stringify([line]), first.notes);
  const said = await toast();
  mark("the flash prints it", said === line, said);
  // Said once per change, not once per frame: hold a beat so frames pass, then read it again.
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await sleep(1200);
  const again = await toast();
  mark("the line is said once, not accumulated per frame",
    again === line && (again.match(/has not been found/g) || []).length === 1, again);

  const seen = await sight();
  mark("the gate is live: the unknown majority is reported",
    Boolean(seen) && seen.unknown > seen.lit && seen.lit > 0, seen);
  const f1 = await shot("pb082-f1-9999-terrain-fit.png");

  // ---- arm 2/3: the painter's counts against the page's own gate ------------------------
  const mySites = (first.sites || []).map((s) => ({ x: s.x, y: s.y }));
  const levels = await gateAt(mySites);
  const allowed = levels.filter((level) => level !== 0).length;
  // Show Ownership ticks every site that is on screen, which is all of them at the fit.
  await page.click("#viewToggle");
  await sleep(500);
  const political = await report();
  mark("9999 political: only the sites the gate allows carry a tick",
    political.siteTicks === allowed, { drawn: political.siteTicks, gateAllows: allowed, sites: mySites.length });
  const caps = Object.entries(first.capitals || {}).filter(([, c]) => c && Number.isFinite(Number(c.x)));
  const capLevels = await gateAt(caps.map(([, c]) => ({ x: c.x, y: c.y })));
  const capsAllowed = capLevels.filter((level) => level !== 0).length;
  mark("9999: only the capitals the gate allows are ringed",
    political.capitals === capsAllowed, { drawn: political.capitals, gateAllows: capsAllowed, named: caps.map(([side]) => side) });
  mark("9999 at the fit: no city names are drawn", political.labels === 0, political.labels);
  const f3 = await shot("pb082-f3-9999-political-fit.png");

  // ---- arm 2b: at label zoom the names that survive are the sighted ones ---------------
  await page.click("#viewToggle"); // back to terrain
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("+");
  await sleep(700);
  const zoomed = await report();
  const zoomSites = (first.sites || []).map((s) => ({ x: s.x, y: s.y }));
  const zoomLevels = await gateAt(zoomSites);
  const zoomAllowed = zoomLevels.filter((level) => level !== 0).length;
  mark("no name is drawn on unknown ground at label zoom",
    zoomed.labels === 0, { drawn: zoomed.labels, gateAllows: zoomAllowed, scale: zoomed.mode });
  const f2 = await shot("pb082-f2-9999-terrain-zoom.png");

  // ---- arm 4: the control, and the clear -------------------------------------------------
  await launch("1942");
  const open = await room();
  mark("1942 room.notes is empty", JSON.stringify(open.notes) === "[]", open.notes);
  const controlToast = await toast();
  mark("the note line is cleared when the room stops needing it",
    !/has not been found/.test(controlToast), controlToast);
  const noGate = await sight();
  mark("1942 has no gate at all", noGate === null, noGate);
  const cSites = (open.sites || []).map((s) => ({ x: s.x, y: s.y }));
  const cLevels = await gateAt(cSites);
  mark("1942: every city is in sight", cLevels.every((level) => level === 2), cLevels.length);
  await page.click("#viewToggle");
  await sleep(500);
  const cReport = await report();
  mark("1942 political: every site carries a tick",
    cReport.siteTicks === cSites.length, { drawn: cReport.siteTicks, sites: cSites.length });
  mark("1942: every capital the page names is ringed",
    cReport.capitals === (await page.evaluate(() => window.__chq.capitalLabels().length)),
    { drawn: cReport.capitals });
  const f4 = await shot("pb082-f4-1942-political-control.png");
  // The same zoom on a map with no fog: names must be there, so the zero above is the gate and
  // not a label layer that never draws.
  await page.click("#viewToggle");
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("+");
  await sleep(700);
  const cZoomed = await report();
  mark("1942 at the same zoom draws city names", cZoomed.labels > 0, cZoomed.labels);

  mark("no page errors", pageErrors.length === 0, pageErrors);

  writeFileSync(path.join(OUT, "pb082-shots.json"), JSON.stringify({ f1, f2, f3, f4 }, null, 2));
  console.log("shots: " + [f1, f2, f3, f4].join(" "));
} catch (err) {
  mark("the run finished", false, String((err && err.stack) || err).split("\n")[0]);
} finally {
  await browser.close();
  const summary = evidence.filter((row) => !row.ok).length;
  console.log("pb082 summary: " + (evidence.length - summary) + " passed, " + summary + " failed");
  process.exitCode = failed ? 1 : 0;
}
