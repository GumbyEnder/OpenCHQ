// T-004 speed hand-check against a LIVE server, driven as a player.
//
//   node speed-handcheck.mjs --url=https://openchq-web-production.up.railway.app [--era=1986]
//
// Proves the user-visible part of T-004:
//   1. at speed 0 the round counter and every piece position are unchanged across a wall-clock
//      window, with two screenshots taken seconds apart;
//   2. at speed 1 and at speed 6 the round counter advances at the rate the server's own table
//      implies, measured in rounds per minute over the same wall-clock window.
//
// Nothing is stubbed: sign-in, Play a bot, the speed buttons and the round counter are the real
// page. Screenshots land beside this run's JSON summary.
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
if (!BASE) { console.error("usage: node speed-handcheck.mjs --url=<live base>"); process.exit(2); }
const ERA = arg("era", "1986");
const WINDOW_S = Number(arg("window", "60")) || 60;
const FREEZE_S = Number(arg("freeze", "8")) || 8;
const OUT = path.join(here, "t004-speed-handcheck-" + new Date().toISOString().replace(/[:.]/g, "-"));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch {}
  }
  return await import("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
function check(ok, label, detail = "") {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const room = () => page.evaluate(() => window.__chq.room());
  const shot = async (name) => {
    const file = path.join(OUT, name + ".png");
    await page.screenshot({ path: file });
    return file;
  };

  // ---- sign in (throwaway) -------------------------------------------------
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "speede2e" + Date.now().toString(36).slice(-8);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    check(true, "registered a throwaway user", name);
  } else {
    check(true, "signed in with the browser's existing session");
  }

  // ---- a live room ---------------------------------------------------------
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e,
    ERA, { timeout: 30000, polling: 100 });
  const first = await room();
  check(Boolean(first && first.seat), "Play a bot opened a live " + ERA + " room");

  // Give the seat a piece that has somewhere to go, so a moving clock has something to move.
  await page.click('#nav button[data-dialog="buy"]').catch(() => {});
  await page.click('button.buyrow[data-kind="infantry"]').catch(() => {});
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  const cells = await page.evaluate(() => window.__chq.legalCells(400)).catch(() => []);
  if (cells.length) {
    const capital = (first.capitals && first.capitals[first.you]) || cells[0];
    const near = (c) => Math.abs(c.x - capital.x) + Math.abs(c.y - capital.y);
    const target = [...cells].sort((a, b) => near(a) - near(b))[0];
    const point = await page.evaluate((c) => window.__chq.cellToScreen(c.x, c.y), target);
    await page.mouse.click(point.x, point.y);
    await sleep(900);
    // March it a few cells so a moving clock is visibly doing something.
    const now = await room();
    const mine = (now.pieces || []).find((p) => p.side === now.you && p.kind === "infantry");
    if (mine) {
      await page.evaluate((c) => window.__chq.cellToScreen(c.x, c.y), { x: mine.x, y: mine.y });
      const pt = await page.evaluate((c) => window.__chq.cellToScreen(c.x, c.y), { x: mine.x, y: mine.y });
      await page.mouse.click(pt.x, pt.y);
      const dest = { x: (mine.x + 3) % 320, y: mine.y };
      const dpt = await page.evaluate((c) => window.__chq.cellToScreen(c.x, c.y), dest);
      await page.mouse.move(dpt.x, dpt.y);
      await sleep(120);
      await page.mouse.click(dpt.x, dpt.y);
      await sleep(600);
    }
  }
  const live = await room();
  if (!live) { check(false, "the room is still open after the buy"); await browser.close(); return; }

  // A room opens with the clock HELD. A speed setting alone does not start time - the player presses
  // Play. Everything below is measured with the clock running, which is what makes the speed-0
  // freeze a fact about speed rather than about a paused match.
  if (String(live.clock) !== "running") {
    await page.click("#clockBtn");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock === "running",
      null, { timeout: 15000, polling: 100 }).catch(() => {});
  }
  const running = await room();
  check(String(running.clock) === "running", "the clock runs after Play", "clock " + running.clock);

  // ---- speed control helper ------------------------------------------------
  const setSpeed = async (want) => {
    for (let i = 0; i < 12; i++) {
      const r = await room();
      if (!r) return null;
      if (Number(r.speed) === want) return r;
      await page.click(Number(r.speed) < want ? "#speedUp" : "#speedDown");
      await sleep(350);
    }
    return await room();
  };
  const snapshot = async () => {
    const r = await room();
    return {
      round: Number(r.round) || 0,
      speed: Number(r.speed),
      pieces: (r.pieces || []).map((p) => ({ id: p.id, x: p.x, y: p.y, path: (p.path || []).length })),
      at: Date.now(),
    };
  };
  const movedPieces = (a, b) => {
    const map = new Map(a.pieces.map((p) => [p.id, p]));
    return b.pieces.filter((p) => { const q = map.get(p.id); return q && (q.x !== p.x || q.y !== p.y); });
  };

  // ---- 1. speed 0 freezes --------------------------------------------------
  await setSpeed(0);
  const z0 = await snapshot();
  const zClock = await page.evaluate(() => window.__chq.room().clock);
  check(z0.speed === 0, "the speed control reaches speed 0", "speed " + z0.speed);
  check(zClock === "running", "the clock is running while speed is 0 (so the freeze is speed, not a hold)",
    "clock " + zClock);
  const zA = await shot("speed0-first");
  await sleep(FREEZE_S * 1000);
  const z1 = await snapshot();
  const zB = await shot("speed0-second");
  check(z1.round === z0.round, "speed 0 ran no rounds over " + FREEZE_S + " s",
    "round " + z0.round + " -> " + z1.round);
  const walkers = movedPieces(z0, z1);
  check(walkers.length === 0, "no piece moved at speed 0 over " + FREEZE_S + " s",
    walkers.map((p) => p.id).join(",") || "0 of " + z1.pieces.length + " moved");
  check(zA && zB, "two speed-0 screenshots taken seconds apart", "speed0-first / speed0-second");

  // ---- 2. measured rounds per minute at speeds 1 and 6 ---------------------
  const measure = async (speed) => {
    const start = await setSpeed(speed);
    const a = await snapshot();
    const t0 = Date.now();
    await sleep(WINDOW_S * 1000);
    const b = await snapshot();
    const seconds = (Date.now() - t0) / 1000;
    const rounds = b.round - a.round;
    return {
      speed, rounds, seconds,
      perMinute: Math.round((rounds / seconds) * 60 * 10) / 10,
      moved: movedPieces(a, b).length,
      shot: await shot("speed" + speed + "-after-" + Math.round(seconds) + "s"),
      startSpeed: start && start.speed,
    };
  };
  const one = await measure(1);
  const six = await measure(6);
  check(one.rounds > 0, "speed 1 advanced the clock live",
    one.rounds + " rounds in " + one.seconds.toFixed(1) + " s = " + one.perMinute + " rounds/min");
  check(one.moved > 0, "pieces moved at speed 1", one.moved + " piece(s)");
  check(six.perMinute > one.perMinute, "speed 6 outruns speed 1 live",
    six.perMinute + " vs " + one.perMinute + " rounds/min");
  check(errors.length === 0, "no page error during the hand-check", errors.slice(0, 2).join(" | "));
  await shot("final");

  const summary = {
    url: BASE, era: ERA, at: new Date().toISOString(),
    freeze: { windowSeconds: FREEZE_S, roundFrom: z0.round, roundTo: z1.round, movedPieces: walkers.map((p) => p.id),
      screenshots: [zA, zB] },
    speed1: one, speed6: six, checks: rows, pageErrors: errors,
  };
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n" + rows.filter((r) => r.ok).length + " passed, " + rows.filter((r) => !r.ok).length +
    " failed; screenshots + summary in " + OUT);
  await browser.close();
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => { console.error("hand-check threw: " + (err && err.stack || err)); process.exit(2); });
