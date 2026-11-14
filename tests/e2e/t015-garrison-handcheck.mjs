// T-015 AC6: the live hand-check. One tank, one dig-in garrison, on the deployed build.
//
// What a player does, through the real page and the real socket: buy a tank beside an enemy-held
// capital, order it onto the capital's own cell, run the clock, and watch. The check is not "no
// error" - it is the two facts T-015 exists for:
//   1. the capital's garrison is dug in and ordered to hold (pinned/entrenched, path 0), and
//   2. the lone tank does not take the capital: the attacker dies, the capital stays red.
//
// Every number comes out of window.__chq.room(); nothing is stubbed and no server state is read
// from a debug endpoint.
//
//   node tests/e2e/t015-garrison-handcheck.mjs --url=https://openchq-web-production.up.railway.app
//   node tests/e2e/t015-garrison-handcheck.mjs --url=http://127.0.0.1:8101 --out=/mnt/nas/.../local/t015-shots
//
// Screenshots and the JSON evidence land in --out (default /mnt/nas/projects/OpenCHQ/local/t015-shots).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) { console.error("usage: node t015-garrison-handcheck.mjs --url=<base url>"); process.exit(2); }
const ERA = argOf("era", "1942");
const OUT = path.resolve(argOf("out", "/mnt/nas/projects/OpenCHQ/local/t015-shots"));
const CAPITAL = argOf("capital", "");           // default: the first enemy-held capital
const MAX_ROUNDS = Number(argOf("rounds", "60")) || 60;
const SPEED = Number(argOf("speed", "6")) || 6;

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const rows = [];
const summary = { base: BASE, era: ERA, startedAt: new Date().toISOString(), checks: rows };
function mark(ok, label, detail = "") {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const room = () => page.evaluate(() => window.__chq.room());
const dist = (a, b) => {
  const raw = Math.abs(Number(a.x) - Number(b.x));
  return Math.max(Math.min(raw, 320 - raw), Math.abs(Number(a.y) - Number(b.y)));
};
async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}
async function clickCell(cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const vp = page.viewportSize();
  if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
    await page.click("#camFit").catch(() => {});
    await sleep(250);
    const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    if (!again || again.x < 2 || again.y < 2 || again.x > vp.width - 2 || again.y > vp.height - 2) return false;
    await page.mouse.click(again.x, again.y);
    await sleep(160);
    return true;
  }
  await page.mouse.click(point.x, point.y);
  await sleep(160);
  return true;
}
async function clockIs(want) {
  const cur = await room();
  if (cur && cur.clock === want) return true;
  await page.click("#clockBtn").catch(() => {});
  await page.waitForFunction((w) => { const r = window.__chq.room(); return r && r.clock === w; }, want, { timeout: 8000, polling: 100 }).catch(() => {});
  const after = await room();
  return Boolean(after && after.clock === want);
}
async function setSpeed(want) {
  for (let i = 0; i < 10; i++) {
    const cur = Number((await room()).speed);
    if (cur === want) break;
    await page.click(cur < want ? "#speedUp" : "#speedDown").catch(() => {});
    await sleep(200);
  }
  return Number((await room()).speed);
}
async function orderTo(pieceId, cell) {
  const cur = await room();
  const me = (cur.pieces || []).find((p) => p.id === pieceId);
  if (!me) return { ok: false, why: "piece not in the view" };
  await clickCell({ x: me.x, y: me.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 6000 }).catch(() => {});
  const selected = await page.evaluate(() => window.__chq.state().selected);
  if (String(selected) !== String(pieceId)) return { ok: false, why: "not selected" };
  await clickCell(cell);
  await page.waitForFunction((id) => {
    const r = window.__chq.room();
    const p = (r.pieces || []).find((x) => x.id === id);
    return p && Array.isArray(p.path) && p.path.length > 0;
  }, pieceId, { timeout: 6000, polling: 100 }).catch(() => {});
  const piece = ((await room()).pieces || []).find((p) => p.id === pieceId);
  return { ok: Boolean(piece && Array.isArray(piece.path) && piece.path.length > 0), path: piece ? piece.path.length : 0 };
}
async function buyNear(kind, target, standoff = 4) {
  await page.click('#nav button[data-dialog="buy"]').catch(() => {});
  await sleep(200);
  const price = await page.evaluate((k) => {
    const row = document.querySelector('button.buyrow[data-kind="' + k + '"]');
    return row ? { disabled: Boolean(row.disabled), text: row.textContent.trim().slice(0, 60) } : null;
  }, kind);
  if (!price || price.disabled) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  summary.tankPrice = price.text;
  await page.click('button.buyrow[data-kind="' + kind + '"]').catch(() => {});
  const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 4000, polling: 100 })
    .then(() => true).catch(() => false);
  if (!armed) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  const cur = await room();
  const cells = await page.evaluate(() => window.__chq.legalCells(6000));
  const taken = new Set((cur.pieces || []).map((p) => p.x + "," + p.y));
  const enemySite = new Set((cur.sites || []).filter((s) => s.owner && s.owner !== cur.you).map((s) => s.x + "," + s.y));
  const had = new Set((cur.pieces || []).map((p) => p.id));
  const pick = cells
    .filter((c) => !taken.has(c.x + "," + c.y) && !enemySite.has(c.x + "," + c.y) && dist(c, target) >= standoff)
    .sort((a, b) => dist(a, target) - dist(b, target))[0];
  if (!pick) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  if (!(await clickCell(pick))) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  await page.waitForFunction((n) => window.__chq.room().pieces.some((p) => !n.includes(p.id)), [...had], { timeout: 15000 }).catch(() => {});
  const after = await room();
  const fresh = (after.pieces || []).find((p) => !had.has(p.id));
  if (!fresh) return null;
  // Name the site the tank was bought from, not just where it landed. The post calls it "the
  // ready site nearest Paris"; an artifact that records only (133,14) cannot back that name, so
  // the nearest own land site to the placement cell is recorded with its own label and distance.
  const landSites = new Set(["city", "capital", "base", "facility"]);
  const near = (after.sites || [])
    .filter((s) => s.owner === after.you && landSites.has(String(s.kind)))
    .map((s) => ({ ...s, cellsFromTank: dist(s, pick) }))
    .sort((a, b) => a.cellsFromTank - b.cellsFromTank)[0];
  return {
    ...fresh,
    placedAt: pick,
    readySite: near ? { id: near.id, name: near.name, x: near.x, y: near.y, kind: near.kind, cellsFromTank: near.cellsFromTank } : null,
  };
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  summary.version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark(Boolean(summary.version && summary.version.short), "live build", summary.version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "gh" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    summary.user = name;
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
  const you = r.you;
  summary.seat = you;
  summary.room = r.id;
  const capitals = (r.sites || []).filter((s) => Number(s.type) === 1 || Number(s.type) === 2);
  const foeCaps = capitals.filter((c) => c.owner && c.owner !== you);
  if (!foeCaps.length) throw new Error("no enemy-held capital in the room view");
  // A capital that carries a garrison is the case T-015 is about: not every 1942 capital starts
  // manned (Berlin and Washington open empty in this era's setup), and bombing an empty one proves
  // nothing about a dug-in hold.
  const mannedCaps = foeCaps.filter((c) => (r.pieces || []).some((p) => p.side !== you && Number(p.x) === Number(c.x) && Number(p.y) === Number(c.y)));
  const target = CAPITAL
    ? foeCaps.find((c) => c.name === CAPITAL) || mannedCaps[0] || foeCaps[0]
    : (mannedCaps[0] || foeCaps[0]);
  summary.capital = { name: target.name, x: target.x, y: target.y, owner: target.owner };
  summary.mannedCapitals = mannedCaps.map((c) => c.name);
  summary.unmannedCapitals = foeCaps.filter((c) => !mannedCaps.includes(c)).map((c) => c.name);
  console.log("manned enemy capitals: " + JSON.stringify(summary.mannedCapitals) + " empty: " + JSON.stringify(summary.unmannedCapitals));

  // The dug-in garrison, as the seat sees it: a piece of the owner's on the capital's own cell.
  const garrisonOf = (now) => (now.pieces || []).find((p) => p.side !== you && Number(p.x) === Number(target.x) && Number(p.y) === Number(target.y));
  const g0 = garrisonOf(r);
  summary.garrisonAtStart = g0 ? { id: g0.id, kind: g0.kind, strength: g0.strength, entrenched: g0.entrenched, pinned: g0.pinned, path: (g0.path || []).length } : null;
  mark(Boolean(g0), "an enemy piece stands on the capital's own cell", summary.garrisonAtStart);
  mark(Boolean(g0 && g0.entrenched), "that garrison is dug in (entrenched)", g0 && { entrenched: g0.entrenched, path: (g0.path || []).length });
  await shot("t015-garrison-at-start.png");

  await clockIs("held");
  await setSpeed(SPEED);
  const tank = await buyNear("tank", target, 4);
  summary.buySite = tank ? tank.readySite : null;
  mark(Boolean(tank), "a tank was bought beside the capital",
    tank && { id: tank.id, at: tank.placedAt, strength: tank.strength, readySite: tank.readySite });
  if (!tank) throw new Error("could not buy a tank");

  const order = await orderTo(tank.id, { x: target.x, y: target.y });
  mark(order.ok, "the tank is ordered onto the capital's own cell", order);
  if (!order.ok) throw new Error("the tank would not accept an order at the capital");

  // Play, and read both strengths until the tank is gone or the rounds run out.
  await clockIs("running");
  const trace = [];
  let lastRound = -1, contactShot = null, attackShot = null, tankFate = null;
  const deadline = Date.now() + MAX_ROUNDS * 12000 + 60000;
  while (Date.now() < deadline) {
    const now = await room();
    if (!now) break;
    const round = Number(now.round);
    const foe = garrisonOf(now);
    const mine = (now.pieces || []).find((p) => p.id === tank.id);
    if (round !== lastRound) {
      lastRound = round;
      trace.push({
        round, clock: now.clock,
        tank: mine ? { x: mine.x, y: mine.y, strength: mine.strength, path: (mine.path || []).length, fighting: mine.fighting ?? null } : null,
        garrison: foe ? { x: foe.x, y: foe.y, strength: foe.strength, entrenched: foe.entrenched, pinned: foe.pinned } : null,
        capitalOwner: ((now.sites || []).find((s) => Number(s.x) === Number(target.x) && Number(s.y) === Number(target.y)) || {}).owner ?? null,
      });
      console.log("R" + round + " " + JSON.stringify(trace[trace.length - 1]));
      if (mine && mine.fighting != null && !contactShot) contactShot = await shot("t015-tank-engages-garrison.png");
      if (!mine) { tankFate = "destroyed on round " + round; break; }
      if (Number(round) > MAX_ROUNDS) break;
      // Screenshot mid-fight, once there are losses to see.
      const garrisonHurt = foe && typeof foe.strength === "number" && typeof (summary.garrisonAtStart || {}).strength === "number"
        && foe.strength < summary.garrisonAtStart.strength;
      if ((garrisonHurt || (mine && mine.strength < tank.strength)) && !attackShot) attackShot = await shot("t015-garrison-strength-delta.png");
    }
    await sleep(400);
  }

  const fin = await room();
  const garrisonNow = garrisonOf(fin);
  const capNow = (fin.sites || []).find((s) => Number(s.x) === Number(target.x) && Number(s.y) === Number(target.y));
  const tankNow = (fin.pieces || []).find((p) => p.id === tank.id);
  summary.trace = trace;
  summary.final = {
    round: fin.round, tank: tankNow ? { strength: tankNow.strength, fighting: tankNow.fighting ?? null } : null,
    garrison: garrisonNow ? { strength: garrisonNow.strength, entrenched: garrisonNow.entrenched } : null,
    capitalOwner: capNow ? capNow.owner : null,
  };
  summary.shots = { start: path.join(OUT, "t015-garrison-at-start.png"), contact: contactShot, delta: attackShot };
  await shot("t015-after-the-attack.png");

  mark(String(capNow && capNow.owner) === String(target.owner), "the capital is still held by its owner", { was: target.owner, now: capNow && capNow.owner });
  mark(!tankNow, "the lone tank did not survive", tankNow ? { strength: tankNow.strength } : "destroyed");
  mark(trace.length > 0 && trace.some((t) => t.tank && typeof t.tank.strength === "number" && t.tank.strength < tank.strength),
    "the tank lost strength to the garrison (the exchange happened)", trace.filter((t) => t.tank).slice(-1)[0] || null);
  mark(errors.length === 0, "no page error during the hand-check", errors.slice(0, 3));
} catch (err) {
  mark(false, "the hand-check threw", String(err && err.message ? err.message : err));
} finally {
  summary.endedAt = new Date().toISOString();
  summary.errors = errors;
  const file = path.join(OUT, "t015-garrison-handcheck.json");
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log("summary " + file);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(failed ? `HANDCHECK_FAILED rows=${failed}` : `HANDCHECK_OK rows=${rows.length}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
}
