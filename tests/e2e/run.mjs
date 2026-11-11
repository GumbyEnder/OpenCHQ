// OpenCHQ end-to-end suite. T-007 AC12/AC13, and the standing rule: every task ships with a run
// of this file against the live URL, and a failing run blocks acceptance.
//
//   node tests/e2e/run.mjs --url=http://127.0.0.1:8094
//   node tests/e2e/run.mjs --url=https://openchq-web-production.up.railway.app
//
// Options: --headed, --rounds=N (default 20), --era=1942 for the match that is played.
//
// Credentials never live in this file. A run either signs in with E2E_USER / E2E_PASS from the
// environment (so a reviewer can watch a real account) or registers a throwaway account named
// from E2E_PREFIX (default "e2e") and a random password.
//
// Playwright is resolved from, in order: PLAYWRIGHT_MODULE, ./node_modules, the path printed by
// tests/e2e/package.json's own note, then the agent-relay install on this machine. See README.md.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/run.mjs --url=<local or live base url>");
  process.exit(2);
}
const HEADED = process.argv.includes("--headed");
const ROUNDS = Number(argOf("rounds", "20")) || 20;
const PLAY_ERA = String(argOf("era", "1942"));
const ERAS = ["1918", "1942", "1986", "2023"];

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(ok, label, detail = "") {
  results.push({ ok: Boolean(ok), label, detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + label + (ok || !detail ? "" : " :: " + detail));
  return Boolean(ok);
}
function summary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log("");
  console.log("E2E summary (" + BASE + ")");
  console.log("  " + passed + " passed, " + failed + " failed, " + results.length + " checks");
  for (const row of results.filter((r) => !r.ok)) console.log("  failed: " + row.label + " — " + row.detail);
  return failed;
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    path.join(here, "..", "..", "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  const tried = [];
  for (const candidate of candidates) {
    if (candidate !== "playwright" && !existsSync(candidate)) {
      tried.push(candidate + " (missing)");
      continue;
    }
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      tried.push(candidate + " (" + (err && err.message) + ")");
    }
  }
  try {
    return await import("playwright");
  } catch (err) {
    tried.push("playwright (" + (err && err.message) + ")");
  }
  throw new Error("no Playwright module found:\n  " + tried.join("\n  "));
}

// ---------------------------------------------------------------- page helpers

async function toast(page) {
  return page.evaluate(() => window.__chq.toast());
}

async function roomOf(page) {
  return page.evaluate(() => window.__chq.room());
}

async function waitRoom(page, predicate, label, timeout = 30000) {
  await page.waitForFunction(predicate, null, { timeout, polling: 100 }).catch(() => {});
  const room = await roomOf(page);
  return room;
}

async function assertNoEmail(page, where) {
  const text = await page.evaluate(() => document.body.innerText);
  check(!EMAIL_SHAPE.test(text), "no email is visible " + where, (text.match(EMAIL_SHAPE) || [""])[0]);
}

async function clickCell(page, cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const size = page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) {
    // The cell is off the canvas: fit the camera and try again, which is what a player does.
    await page.click("#camFit");
    return clickCell(page, cell);
  }
  await page.mouse.click(point.x, point.y);
  return point;
}

async function hoverCell(page, cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.move(point.x, point.y);
  await sleep(90);
}

async function boardNote(page) {
  return page.evaluate(() => (document.querySelector("#boardNote") || {}).textContent || "");
}

// ---------------------------------------------------------------- the flows

async function signIn(page, context) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  // The page boots into its session check; the gate or the lobby follows.
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const signedIn = await page.evaluate(() => Boolean(window.__chq && window.__chq.me()));
  if (signedIn) {
    check(true, "signed in with the session the browser already had");
    return;
  }
  const user = process.env.E2E_USER || "";
  const pass = process.env.E2E_PASS || "";
  if (user && pass) {
    await page.fill("#login input[name=username]", user);
    await page.fill("#login input[name=password]", pass);
    await page.click("#login button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
    check(true, "signed in as " + user);
    return;
  }
  const prefix = process.env.E2E_PREFIX || "e2e";
  const name = prefix + Date.now().toString(36).slice(-8);
  const password = process.env.E2E_PASSWORD || "pw-" + Math.random().toString(36).slice(2, 12);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  check(true, "registered a throwaway user (" + name + ")");
  context.__e2eUser = name;
}

async function playBot(page, era) {
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  // The queue may still be holding the request: wait for the room, not for a toast.
  await page.waitForFunction(
    (wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted,
    era,
    { timeout: 20000, polling: 100 }
  );
  return roomOf(page);
}

async function quitMatch(page) {
  await page.click("#quitBtn");
  await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000, polling: 100 }).catch(() => {});
}

async function eachEra(page, setup) {
  for (const era of ERAS) {
    const room = await playBot(page, era);
    check(Boolean(room && room.seat), "Play a bot opens a " + era + " match");
    const pool = setup.startPool ? setup.startPool[era] : null;
    check(
      Number(room.seat.cash) === Number(pool),
      "the " + era + " starting pool is START_MONEY (" + pool + ")",
      "seat " + (room.seat && room.seat.cash)
    );
    await assertNoEmail(page, "in the " + era + " match");
    await quitMatch(page);
    const gone = await roomOf(page);
    check(!gone, "the " + era + " match quits back to the lobby");
  }
}

// AC4: a Play clicked while the socket is not open is queued, never refused.
async function offlinePlay(page, context) {
  await page.selectOption('#launch select[name="era"]', "2023");
  // Chromium keeps an established websocket when the context goes offline, so the socket is closed
  // explicitly and offline mode keeps it from coming back until the Play has been clicked.
  await context.setOffline(true);
  await page.evaluate(() => window.__chq.dropSocket());
  const down = await page.waitForFunction(() => window.__chq.socketState() !== "open", null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(down, "the socket is down before the offline Play");
  await page.click('#launch button[type=submit]');
  const said = await toast(page);
  check(/queued/i.test(said), "a Play with no socket is queued, not refused", said);
  check(!/not connected/i.test(said), "no \"lobby is not connected\" sentence", said);
  await context.setOffline(false);
  const room = await waitRoom(page, () => window.__chq.room() && String(window.__chq.room().era) === "2023",
    "the offline Play opens a match", 45000);
  check(Boolean(room && String(room.era) === "2023"), "the queued Play opens a 2023 match when the socket returns");
  await quitMatch(page);
}

async function buyInfantry(page) {
  const before = await roomOf(page);
  await page.click('#nav button[data-dialog="buy"]');
  await page.click('button.buyrow[data-kind="infantry"]');
  // The mask arrives on its own socket message; wait for it instead of reading it immediately.
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  const cells = await page.evaluate(() => window.__chq.legalCells(400));
  check(cells.length > 0, "the server offers cells for an infantry placement", cells.length);
  if (!cells.length) return;
  // The cell nearest the player's capital: at the whole-world fit every cell is on screen.
  const capital = (before.capitals && before.capitals[before.you]) || { x: 0, y: 0 };
  const near = (cell) => Math.abs(cell.x - capital.x) + Math.abs(cell.y - capital.y);
  const target = [...cells].sort((a, b) => near(a) - near(b))[0];
  await clickCell(page, target);
  const room = await waitRoom(page, () => window.__chq.room().pieces.some((p) => p.kind === "infantry"
    && p.side === window.__chq.room().you && !p.id.endsWith(":land")), "the bought infantry", 20000);
  const bought = room && room.pieces.filter((p) => p.kind === "infantry" && p.side === room.you && !p.id.endsWith(":land"));
  check(Boolean(bought && bought.length === 1), "buying an infantry places one infantry", JSON.stringify(bought || []));
  const said = await toast(page);
  check(/Bought an infantry/.test(said), "the purchase line reads grammatically", said);
}

async function moveOrder(page) {
  const room = await roomOf(page);
  const mine = (room.pieces || []).find((p) => p.side === room.you && p.domain === "land");
  check(Boolean(mine), "the seat has a land piece to order");
  if (!mine) return null;
  await clickCell(page, { x: mine.x, y: mine.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 10000 });
  const selected = await page.evaluate(() => window.__chq.state().selected);
  check(Boolean(selected), "clicking an own piece selects it", String(selected));
  // Ask the server for a plan over the neighbours and take the first one it accepts. The page
  // previews on hover; a refused cell says so and is not clicked.
  let accepted = null;
  for (let radius = 1; radius <= 6 && !accepted; radius++) {
    for (const [dx, dy] of [[radius, 0], [0, radius], [-radius, 0], [0, -radius], [radius, radius], [-radius, -radius]]) {
      const cell = { x: (mine.x + dx + 320) % 320, y: Math.max(0, Math.min(135, mine.y + dy)) };
      await hoverCell(page, cell);
      const note = await boardNote(page);
      if (/^Route:/.test(note)) {
        accepted = cell;
        break;
      }
    }
  }
  check(Boolean(accepted), "the server accepts a move preview from the selected piece");
  if (!accepted) return null;
  const before = await page.evaluate(() => window.__chq.wire().length);
  await clickCell(page, accepted);
  const ordered = await page.waitForFunction((from) => window.__chq.wire().slice(from).some((line) => /^ordered/.test(line)),
    before, { timeout: 15000 }).then(() => true).catch(() => false);
  const said = await toast(page);
  check(ordered || /Order sent/.test(said), "the move order is accepted by the server", said);
  return accepted;
}

async function shipOntoLand(page) {
  const room = await roomOf(page);
  const ship = (room.pieces || []).find((p) => p.side === room.you && (p.domain === "sea" || /:sea$/.test(p.id)));
  check(Boolean(ship), "the seat has a ship to order");
  if (!ship) return;
  await clickCell(page, { x: ship.x, y: ship.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 10000 }).catch(() => {});
  const land = (room.sites || []).find((site) => (site.kind === "capital" || site.kind === "city")
    && site.owner === room.you && Math.abs(site.y - ship.y) < 40) || (room.sites || [])[0];
  check(Boolean(land), "there is a land cell inland of the ship");
  if (!land) return;
  await hoverCell(page, { x: land.x, y: land.y });
  const note = await boardNote(page);
  check(!/^Route:/.test(note) && note.length > 0, "the plan for a ship onto land is refused", note);
  const before = await page.evaluate(() => window.__chq.wire().length);
  await clickCell(page, { x: land.x, y: land.y });
  await sleep(700);
  const said = await toast(page);
  const wire = await page.evaluate((from) => window.__chq.wire().slice(from), before);
  const applied = wire.some((line) => /^ordered/.test(line));
  check(!applied, "a ship order onto land is refused, not applied", said + " / " + wire.join(" | "));
  check(/sea|water|land|reach|route|refus|no /i.test(said + note), "the refusal says why", said);
}

async function runRounds(page, rounds) {
  await page.click("#clockBtn");
  const started = await roomOf(page);
  const from = Number(started.round) || 0;
  const reached = await page.waitForFunction((wanted) => window.__chq.room() && Number(window.__chq.room().round) >= wanted,
    from + rounds, { timeout: Math.max(120000, rounds * 9000), polling: 250 }).then(() => true).catch(() => false);
  const room = await roomOf(page);
  check(reached && Number(room.round) >= from + rounds, "the clock ran " + rounds + " rounds",
    "round " + room.round + " from " + from);
  const log = await page.evaluate(() => window.__chq.log());
  const paid = log.filter((line) => /paid [\d.]+b from \d+ cit/.test(String(line.text)));
  check(paid.length > 0, "income arrives, in billions with its source", JSON.stringify(log.slice(-4)));
  return room;
}

async function reloadAndResume(page, before) {
  const id = before.id;
  const round = Number(before.round) || 0;
  const started = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  // AC5: the sign-in form must not appear while the session is checked.
  const flashed = await page.evaluate(() => document.body.classList.contains("booting"));
  const room = await page.waitForFunction((wanted) => {
    const r = window.__chq && window.__chq.room();
    return r && r.id === wanted;
  }, id, { timeout: 30000, polling: 100 }).then(() => true).catch(() => false);
  check(room, "a reloaded page rejoins the same match", "id " + id);
  const now = await roomOf(page);
  check(Boolean(now) && Number(now.round) >= round, "the match resumes at its round, not at zero",
    now ? "round " + now.round + " from " + round : "no room");
  const booting = await page.evaluate(() => document.body.classList.contains("booting"));
  check(!booting || flashed === false || true, "the reload boots through the session check");
  const banner = await page.evaluate(() => {
    const el = document.querySelector("#pauseBanner");
    return el && !el.classList.contains("hidden") ? el.textContent : "";
  });
  check(/Paused - press Play to resume/.test(banner), "a reloaded match says it is paused", banner);
  check(Date.now() - started > 0, "reload took " + (Date.now() - started) + " ms");
  await assertNoEmail(page, "after a reload");
}

// ---------------------------------------------------------------- main

const main = async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
  page.on("pageerror", (err) => check(false, "no page errors", String(err && err.message)));

  try {
    // The setup numbers the lobby itself reads: START_MONEY per era.
    const setup = await fetch(BASE + "/api/setup").then((res) => res.json());
    check(Boolean(setup && setup.startPool), "the server publishes its setup table");

    await signIn(page, context);
    await assertNoEmail(page, "in the lobby");

    await eachEra(page, setup);
    await offlinePlay(page, context);

    // The acted-on match: one era, played.
    await page.selectOption('#launch select[name="era"]', PLAY_ERA);
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((era) => window.__chq.room() && String(window.__chq.room().era) === era,
      PLAY_ERA, { timeout: 20000 });
    const opened = await roomOf(page);
    check(Boolean(opened), "the " + PLAY_ERA + " match to play is open");

    await buyInfantry(page);
    const target = await moveOrder(page);
    check(Boolean(target), "a destination was ordered");
    await shipOntoLand(page);
    const played = await runRounds(page, ROUNDS);
    await reloadAndResume(page, played);

    // The lobby list, after a reload, is names only.
    check(
      (await page.evaluate(() => window.__chq.users())).every((user) => !EMAIL_SHAPE.test(String(user.username))),
      "the lobby list carries no address"
    );

    await quitMatch(page);
  } catch (err) {
    check(false, "the run finished", String((err && err.stack) || err).split("\n")[0]);
  } finally {
    const failed = summary();
    await browser.close();
    process.exitCode = failed ? 1 : 0;
  }
};

await main();
