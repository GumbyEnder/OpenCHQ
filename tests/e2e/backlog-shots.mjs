// T-010 AC5/AC6: the backlog screenshots a live player can take, driven through the real page.
//
//   node tests/e2e/backlog-shots.mjs --url=https://openchq-web-production.up.railway.app
//
//   PB-022 (AC6)  1918 capitals on live are era-correct: London, Berlin, Paris - and no
//                 Washington/Moscow anywhere in the capital rows. Screenshot of the map plus a
//                 clipped shot of the capitals region.
//   PB-005         the steel readout's "non-original (D-003)" disclosure: shot of the Economy
//                 dialog's Stock list, plus the reading of whether that label is visible prose or
//                 only a hover title (a title cannot appear in a screenshot - say which).
//   PB-007         a dialog open with the clock running: two Economy shots N seconds apart with
//                 the room's own round numbers, so the counter moved while the dialog was up.
//   PB-006         "That is not a valid place for <unit>": a cruiser clicked inland, the refusal
//                 text read off #flash, and a shot of the message on screen.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = (arg("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) { console.error("usage: node backlog-shots.mjs --url=<live base>"); process.exit(2); }
const ERA = arg("era", "1918");
const OUT = path.join(here, "t010-backlog-" + new Date().toISOString().replace(/[:.]/g, "-"));

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const summary = { base: BASE, era: ERA, startedAt: new Date().toISOString() };
const mark = (ok, label, detail = "") => {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
};

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
let page = await context.newPage();
const room = () => page.evaluate(() => window.__chq.room());
async function shot(name, clip) {
  const file = path.join(OUT, name);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log("shot " + file);
  return file;
}
async function clickCell(cell) {
  const vp = page.viewportSize();
  let point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
    await page.click("#camFit").catch(() => {});
    await sleep(250);
    point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  }
  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  await sleep(220);
  return true;
}

try {
  mkdirSync(OUT, { recursive: true });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  summary.version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark(true, "live build", summary.version);
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "sw" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    summary.user = name;
    mark(true, "registered a throwaway user", name);
  }
  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e, ERA, { timeout: 30000, polling: 100 });
  await page.click("#camFit").catch(() => {});
  let r = await room();
  summary.room = r.id;
  summary.seat = r.you;

  // ---- PB-022: the era's own capitals --------------------------------------
  const caps = (r.sites || []).filter((s) => Number(s.type) === 1 || Number(s.type) === 2);
  const names = caps.map((c) => c.name);
  summary.capitals1918 = caps.map((c) => ({ name: c.name, x: c.x, y: c.y, owner: c.owner }));
  const wrong = names.filter((n) => /washington|moscow/i.test(String(n)));
  mark(wrong.length === 0, "PB-022: no Washington/Moscow in the capital rows", names);
  // The rows are not the frame: paintCapitals labels whatever capitalMarkers returns, so the test
  // reads that same call. The fixed-seat fallback used to label Washington/Moscow on every board.
  const labels = await page.evaluate(() => window.__chq.capitalLabels());
  summary.capitalLabels = labels.map((c) => c.name);
  mark(!labels.some((c) => /washington|moscow/i.test(c.name)),
    "PB-022: the labels the painter draws name no Washington/Moscow", summary.capitalLabels);
  mark(labels.length === names.length,
    "PB-022: the painter labels exactly the era's capital rows", { rows: names, labels: summary.capitalLabels });
  mark(names.includes("London") && names.includes("Berlin") && names.includes("Paris"),
    "PB-022: the 1918 capitals are London, Berlin and Paris", names);
  summary.washingtonSites = (r.sites || []).filter((s) => /washington/i.test(String(s.name)));
  summary.moscowSites = (r.sites || []).filter((s) => /moscow/i.test(String(s.name)));
  await shot("pb022-1918-board.png");
  const p1 = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), { x: 140, y: 24 });
  const p2 = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), { x: 172, y: 44 });
  const clip = {
    x: Math.max(0, Math.min(p1.x, p2.x) - 40),
    y: Math.max(0, Math.min(p1.y, p2.y) - 40),
    width: Math.min(760, Math.abs(p2.x - p1.x) + 80),
    height: Math.min(560, Math.abs(p2.y - p1.y) + 80),
  };
  await shot("pb022-1918-capitals-closeup.png", clip);
  summary.capitalsClip = clip;

  // ---- PB-007 + PB-005: a dialog open with the clock running ----------------
  const clockState = async () => (await room()).clock;
  if ((await clockState()) !== "running") {
    await page.click("#clockBtn");
    await page.waitForFunction(() => { const x = window.__chq.room(); return x && x.clock === "running"; }, null, { timeout: 10000, polling: 100 }).catch(() => {});
  }
  const navs = await page.evaluate(() => [...document.querySelectorAll("#nav button")].map((b) => ({ key: b.dataset.dialog || b.dataset.command || b.textContent.trim(), label: b.textContent.trim() })));
  summary.nav = navs;
  const ecoKey = (navs.find((n) => /econom|reserve|stock/i.test(n.key + " " + n.label)) || {}).key;
  mark(Boolean(ecoKey), "the strip has an economy dialog", ecoKey || navs);
  await page.click('#nav button[data-dialog="' + ecoKey + '"]');
  await sleep(400);
  const roundA = (await room()).round;
  const clockA = (await room()).clock;
  const dialogOpen = await page.evaluate(() => !document.querySelector("#dialog").classList.contains("hidden"));
  await shot("pb007-005-dialog-clock-running-a.png");
  await sleep(8000);
  const roundB = (await room()).round;
  const clockB = (await room()).clock;
  await shot("pb007-005-dialog-clock-running-b.png");
  mark(dialogOpen && clockA === "running" && clockB === "running" && roundB > roundA,
    "PB-007: dialog open while the clock ran and the round advanced", { dialogOpen, roundA, roundB, clockA, clockB });

  const readStocks = () => page.evaluate(() => {
    const list = [...document.querySelectorAll("#dialogBody .reserves li")];
    return list.map((li) => ({ text: li.textContent.trim(), title: li.title || null }));
  });
  let stocks = await readStocks();
  summary.stocks = stocks;
  let steel = stocks.find((s) => /steel/i.test(s.text));
  if (!steel) {
    // Steel is gated to 1942 and 1986: the 1918 seat has a fuel meter only, so the readout has to be
    // read in an era that carries it rather than reported missing.
    console.log("no steel meter in " + ERA + " (stocks: " + JSON.stringify(stocks) + "); opening 1942 for it");
    // A second match in another era is a second session: a fresh page and a throwaway account. The
    // page reloaded in place leaves the lobby in a state where the launch form is not reachable, and
    // the point here is the readout, not fighting the shell.
    await page.close();
    // A fresh context, not just a fresh page: the session cookie would otherwise sign the second
    // page in and the register form would be hidden.
    const steelContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await steelContext.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    const steelUser = "pb" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", steelUser);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1942", null, { timeout: 30000, polling: 100 });
    summary.steelEra = "1942";
    if ((await room()).clock !== "running") {
      await page.click("#clockBtn");
      await page.waitForFunction(() => { const x = window.__chq.room(); return x && x.clock === "running"; }, null, { timeout: 10000, polling: 100 }).catch(() => {});
    }
    await page.click('#nav button[data-dialog="' + ecoKey + '"]');
    await sleep(500);
    await shot("pb005-steel-readout-1942.png");
    stocks = await readStocks();
    summary.stocks1942 = stocks;
    steel = stocks.find((s) => /steel/i.test(s.text));
  }
  mark(Boolean(steel), "PB-005: a steel readout exists in the Stock list", stocks);
  mark(Boolean(steel && steel.title && /non-original/i.test(steel.title)),
    "PB-005: the non-original label is a hover title, not visible prose (records the gap)", steel);
  summary.steelVisibleProse = Boolean(steel && /non-original|D-003/i.test(steel.text));
  mark(summary.steelVisibleProse, "PB-005: the non-original note appears in the text a screenshot can show", steel && steel.text);

  // ---- PB-006: the refusal message ----------------------------------------
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  await page.click('#nav button[data-dialog="buy"]').catch(() => {});
  await sleep(300);
  const kinds = await page.evaluate(() => [...document.querySelectorAll("button.buyrow[data-kind]")].map((b) => b.dataset.kind));
  summary.buyKinds = kinds;
  await page.click('button.buyrow[data-kind="cruiser"]').catch(() => {});
  await sleep(400);
  const legal = await page.evaluate(() => window.__chq.legalCells(6000));
  const legalSet = new Set(legal.map((c) => c.x + "," + c.y));
  // An inland cell: far from any legal coastal cell, in the middle of a continent.
  const inland = [];
  for (let y = 20; y < 70; y++) for (let x = 130; x < 240; x++) if (!legalSet.has(x + "," + y)) inland.push({ x, y });
  const cell = inland[Math.floor(inland.length / 2)] || { x: 200, y: 45 };
  await clickCell(cell);
  await sleep(900);
  const flash = await page.evaluate(() => (document.querySelector("#flash") || {}).textContent || "");
  summary.refusal = { cell, flash };
  mark(/not a valid place for/i.test(flash), "PB-006: the refusal names the unit and the rule", { cell, flash });
  await shot("pb006-not-a-valid-place.png");
  await page.keyboard.press("Escape").catch(() => {});

  const errors = [];
  void errors;
} catch (err) {
  mark(false, "run threw", String(err && err.message ? err.message : err));
  summary.error = String(err && err.stack ? err.stack : err);
} finally {
  summary.rows = rows;
  summary.failed = rows.filter((x) => !x.ok).length;
  summary.endedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("summary " + path.join(OUT, "summary.json"));
  console.log(summary.failed === 0 ? "BACKLOG_SHOTS_OK" : "BACKLOG_SHOTS_FAILED rows=" + summary.failed);
  await browser.close();
  process.exit(0);
}
