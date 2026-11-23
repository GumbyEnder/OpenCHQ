// PB-126 live leg: only the era's own capitals are drawn in capital ink.
//
//   node tests/e2e/pb126-era-capital-ink.mjs --url=http://127.0.0.1:8116 --out=local/pb126-shots
//
// The node pin (web/test/nodes/pb126_capital_ink.mjs) proves the painter's ink per era from the
// real payload. This leg proves the PIXELS on a real page with a real socket, in the era the defect
// was reported in (a fresh 1918 room):
//
//   1. a fresh 1918 room labels London, Berlin and Paris and neither fixed seat (PB-120 control);
//   2. the whole 1918 canvas carries ZERO pixels of the theme's capital ink, scanned at the fit
//      camera, where the whole board is on screen - so the scan cannot miss an off-screen cell;
//   3. CONTROL: 2023, whose capitals ARE the two fixed seats, carries capital ink, and labels
//      Washington and Moscow - so the zero above is not a dead sampler or a missing layer.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/pb126-era-capital-ink.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb126", "shots")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
let failed = 0;
function mark(step, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "pb126-era-capital-ink.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
page.on("dialog", (dialog) => dialog.accept());

const room = () => page.evaluate(() => window.__chq.room());
const labels = () => page.evaluate(() => window.__chq.capitalLabels());

// Theme C's capital ink is #ffd166 and no other terrain uses it; Classic (D) paints desert the same
// yellow, which is exactly why the page is pinned to C before the first scan.
const CAPITAL_INKS = ["#ffd166"];
const CITY_INKS = ["#eef4ff"];
const inkCounts = (inks) => page.evaluate((wanted) => {
  const canvas = document.querySelector("#board");
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const counts = {};
  const wants = wanted.map((hex) => [hex, [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))]);
  for (const [hex] of wants) counts[hex] = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (const [hex, want] of wants) {
      if (data[i] === want[0] && data[i + 1] === want[1] && data[i + 2] === want[2]) counts[hex] += 1;
    }
  }
  return { counts, canvas: { w: canvas.width, h: canvas.height } };
}, inks);

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
  await page.keyboard.press("0"); // fit: the whole board, so a scan misses no cell
  await sleep(400);
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "pb126" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  // --- the reported era: 1918 --------------------------------------------------------------
  await launch("1918");
  const fresh = await room();
  mark("era 1918 opens held at round 0",
    String(fresh.era) === "1918" && Number(fresh.round) === 0 && fresh.clock === "held",
    { era: fresh.era, round: fresh.round, clock: fresh.clock });
  // Frodo's check (room 6732): the subtype the client RECEIVES must already be 4 (city) for 62/63.
  // Anything else and the era mapping is the defect, not the painter.
  const pair = (Array.isArray(fresh.sites) ? fresh.sites : [])
    .filter((site) => Number(site.id) === 62 || Number(site.id) === 63)
    .map((site) => ({ id: site.id, type: site.type, kind: site.kind, owner: site.owner, x: site.x, y: site.y }));
  mark("the client receives 62/63 as type 4 (city), owned, at (79,44)/(183,25)",
    pair.length === 2 && pair.every((site) => Number(site.type) === 4)
      && pair.every((site) => ["blue", "red"].includes(site.owner)),
    pair);
  // And the terrain cell the painter reads for those cells: if it says 4 (capital) the amber is the
  // era-less grid, not a subtype the page invented.
  const payload = await page.evaluate(() => window.__chq.board());
  const cellOf = (site) => payload.cells[site.y * payload.width + ((site.x % payload.width) + payload.width) % payload.width];
  mark("both cells carry terrain id 4 (capital) in the era-less board payload",
    pair.length === 2 && pair.every((site) => Number(cellOf(site)) === 4),
    pair.map((site) => ({ id: site.id, cell: cellOf(site), terrain: payload.terrain[cellOf(site)] })));

  const marks1918 = await labels();
  const names1918 = marks1918.map((m) => String(m.name)).sort();
  mark("the 1918 frame labels its three capitals only",
    names1918.join(",") === "Berlin,London,Paris", names1918);
  const ink1918 = await inkCounts(CAPITAL_INKS);
  mark("no capital ink anywhere in the fresh 1918 frame",
    Object.values(ink1918.counts).reduce((a, b) => a + b, 0) === 0, ink1918);
  await page.screenshot({ path: path.join(OUT, "pb126-1918-fit.png") });

  // --- CONTROL: 2023's capitals are the two fixed seats ------------------------------------
  await launch("2023");
  const marks2023 = await labels();
  const names2023 = marks2023.map((m) => String(m.name)).sort();
  mark("the 2023 frame labels the two fixed seats", names2023.join(",") === "Moscow,Washington", names2023);
  const ink2023 = await inkCounts(CAPITAL_INKS);
  const capital2023 = Object.values(ink2023.counts).reduce((a, b) => a + b, 0);
  mark("the 2023 frame carries capital ink (the 1918 zero is not a dead sampler)", capital2023 > 0, ink2023);
  await page.screenshot({ path: path.join(OUT, "pb126-2023-fit.png") });

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 5));
} finally {
  await browser.close();
}

console.log(failed === 0 ? "PB126_OK" : `PB126_FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
