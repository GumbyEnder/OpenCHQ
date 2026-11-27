// PB-296b page leg: Air > Paradrop picks the infantry, then a land cell, and the drop costs the
// infantry its loss while the plane stays home and goes unready.
//
//   node tests/e2e/pb296b-paradrop.mjs                # starts its own server
//   node tests/e2e/pb296b-paradrop.mjs --url=<base>   # a running server (the 296a tree: red)
//   node tests/e2e/pb296b-paradrop.mjs --out=<dir>
//
// PM 9855 §4 / manual printed p.25 rules 1-3. Server half: web/test/nodes/pb296b_paradrop.mjs.
// This leg pins the DOOR and the board:
//   1. an infantry and an aircraft are bought at one city in the cold war;
//   2. Air > Paradrop is offered with a price in rounds;
//   3. clicking the infantry sends NO order and arms it as the load;
//   4. clicking a land cell puts exactly ONE mission frame on the wire,
//      {mode:"drop", to:{x,y,load:<infantry>}};
//   5. the infantry lands there at 100 - 100 x combat.paradropLoss, the aircraft does not move, and
//      its AWAY cell reads the strike-priced rounds.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { terrainNameAt } from "../../web/server/move.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = evidenceDir("pb296b-page", argOf("out"));
mkdirSync(OUT, { recursive: true });

const CONFIG = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
const AIR = CONFIG.air || {};
const COMBAT = CONFIG.combat || {};
const DROP_ROUNDS = Number(AIR.strikeRounds);
const LOSS = Number(COMBAT.paradropLoss && COMBAT.paradropLoss.value !== undefined
  ? COMBAT.paradropLoss.value
  : COMBAT.paradropLoss);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb296b-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("a given server answers", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    window.__sentFrames = [];
    WebSocket.prototype.send = function (data) {
      try { window.__sentFrames.push(String(data)); } catch (err) { void err; }
      return send.call(this, data);
    };
  });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const sentFrames = () => page.evaluate(() => (window.__sentFrames || []).slice());
  const noteText = () => page.evaluate(() => {
    const el = document.querySelector("#flashLine") || document.querySelector("#boardNote");
    return el ? String(el.textContent || "") : "";
  });
  const send = (message) => page.evaluate((m) => window.__chq.send(m), message);
  const BOARD_W = await page.evaluate(() => (window.__chq.boardWidth ? window.__chq.boardWidth() : 320)).catch(() => 320);
  async function shot(name) {
    const file = path.join(OUT, name + ".png");
    await page.screenshot({ path: file });
    return file;
  }
  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(250);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(180);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(200);
    return true;
  }
  async function selectPiece(cell, id) {
    await page.keyboard.press("Escape").catch(() => {});
    for (let i = 0; i < 5; i += 1) {
      await clickCell(cell);
      const sel = await page.evaluate(() => window.__chq.state().selected);
      if (String(sel) === String(id)) return true;
      await sleep(120);
    }
    return false;
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb296b-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  let cur = await room();
  mark("Play a bot opens a 1986 match", Boolean(cur && cur.seat), "round " + (cur && cur.round));
  for (let i = 0; i < 6; i += 1) {
    const c0 = await room();
    if (!c0 || c0.clock !== "running") break;
    await page.click("#clockBtn").catch(() => {});
    await page.waitForFunction(() => (window.__chq.room().clock === "running" ? "running" : "held") === "held", null, { timeout: 8000, polling: 100 }).catch(() => {});
    await sleep(150);
  }
  cur = await room();
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

  const sites = (cur && cur.sites) || [];
  const strips = sites.filter((s) => s.owner === "blue" && ["city", "capital", "base"].includes(String(s.kind)));
  const awayOn = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(BOARD_W - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };
  const home = strips[0] || null;
  mark("the board has a friendly city to buy at", Boolean(home), home ? home.name + " @ " + home.x + "," + home.y : "none");

  async function buyAt(kind, anchor) {
    const before = new Set(((await room()).pieces || []).map((p) => p.id));
    await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
    await sleep(250);
    const row = await page.evaluate((k) => {
      const el = document.querySelector('button.buyrow[data-kind="' + k + '"]');
      return el ? { disabled: Boolean(el.disabled) } : null;
    }, kind);
    if (!row || row.disabled) return { error: "the " + kind + " row is missing or greyed: " + JSON.stringify(row) };
    await page.click('button.buyrow[data-kind="' + kind + '"]');
    const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
      .then(() => true).catch(() => false);
    if (!armed) return { error: "the " + kind + " purchase did not arm a placement" };
    const cells = await page.evaluate(() => window.__chq.legalCells(20000));
    const taken = new Set(((await room()).pieces || []).map((p) => p.x + "," + p.y));
    const scored = (cells || [])
      .filter((c) => awayOn(c, anchor) <= 2 && !taken.has(c.x + "," + c.y))
      .sort((a, b) => awayOn(a, anchor) - awayOn(b, anchor));
    for (const cell of scored.slice(0, 8)) {
      await clickCell(cell);
      await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id) && p.kind !== undefined), [...before], { timeout: 6000, polling: 100 }).catch(() => {});
      const after = await room();
      const piece = (after.pieces || []).find((p) => !before.has(p.id) && p.kind === kind);
      if (piece) return { piece, cell };
      const still = await page.evaluate(() => window.__chq.state().placement === true);
      if (!still) return { error: "the " + kind + " purchase was refused: " + (await noteText()) };
    }
    return { error: "the " + kind + " never appeared on the board" };
  }

  const boughtInf = await buyAt("infantry", home);
  if (boughtInf.error) throw new Error(boughtInf.error);
  const infId = boughtInf.piece.id;
  mark("an infantry is bought at the city", true, infId + " at " + boughtInf.cell.x + "," + boughtInf.cell.y);
  const boughtAir = await buyAt("aircraft", home);
  if (boughtAir.error) throw new Error(boughtAir.error);
  const planeId = boughtAir.piece.id;
  mark("an aircraft is bought at the same city", true, planeId + " at " + boughtAir.cell.x + "," + boughtAir.cell.y);

  // ---------------------------------------------------------------- the drop cell: land, empty, no site
  const occupied = new Set(((await room()).pieces || []).map((p) => p.x + "," + p.y));
  const siteCells = new Set(sites.map((s) => s.x + "," + s.y));
  let dropCell = null;
  for (let r = 4; r <= 9 && !dropCell; r += 1) {
    for (let dy = -r; dy <= r && !dropCell; dy += 1) {
      for (let dx = -r; dx <= r && !dropCell; dx += 1) {
        const x = ((Number(home.x) + dx) % BOARD_W + BOARD_W) % BOARD_W;
        const y = Number(home.y) + dy;
        if (y < 1 || y > 134) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (occupied.has(x + "," + y) || siteCells.has(x + "," + y)) continue;
        // Two clear cells from the aircraft: at this zoom a marker is drawn across the cell edge, and
        // a click there would hit the plane instead of the cell.
        if (awayOn({ x, y }, boughtAir.piece) < 4) continue;
        if (terrainNameAt(x, y) === null) continue;
        if ((dropCell)) break;
        if (terrainNameAt(x, y) === "ocean" || terrainNameAt(x, y) === "lake") continue;
        dropCell = { x, y };
      }
    }
  }
  mark("an empty land cell stands inside the drop's reach for this leg", Boolean(dropCell),
    dropCell ? dropCell.x + "," + dropCell.y + " " + terrainNameAt(dropCell.x, dropCell.y) : "none found");

  // ---------------------------------------------------------------- Air > Paradrop
  const airSelected = await selectPiece(boughtAir.piece, planeId);
  mark("the aircraft is selected for the Air door", airSelected,
    "selected " + JSON.stringify(await page.evaluate(() => window.__chq.state().selected)));
  await page.click('.navbtn[data-dialog="air"]').catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 }).catch(() => {});
  const armedDrop = await page.evaluate((id) => {
    const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
    const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || (c.textContent || "").trim()) === String(id); });
    if (!row) return { clicked: false, missing: true };
    const button = [...row.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Paradrop");
    if (!button) return { clicked: false, noDrop: true, labels: [...row.querySelectorAll("button")].map((b) => b.textContent.trim()) };
    if (button.disabled) return { clicked: false, disabled: true };
    const title = button.title || "";
    button.click();
    return { clicked: true, title };
  }, planeId);
  await sleep(400);
  mark("the Air door offers Paradrop for a ready plane", Boolean(armedDrop.clicked), JSON.stringify(armedDrop));
  mark("the Paradrop door names the rules before the player aims",
    /enemy city|land cell/i.test(String(armedDrop.title || "")), JSON.stringify(String(armedDrop.title || "").slice(0, 200)));

  const framesBefore = (await sentFrames()).length;
  await clickCell(boughtInf.cell);
  const afterLoader = (await sentFrames()).slice(framesBefore)
    .filter((line) => /"(op)"\s*:\s*"(mission|order|transfer)"/.test(String(line)));
  await sleep(250);
  const armedLoad = await page.evaluate(() => window.__chq.state().armedLoad);
  mark("clicking the infantry sends NO order (it is the load)", afterLoader.length === 0,
    "orders " + afterLoader.length + ": " + afterLoader.join(" | ").slice(0, 200));
  mark("the page holds the infantry as the armed load", String(armedLoad) === String(infId), "armedLoad " + JSON.stringify(armedLoad));
  const pickedShot = await shot("pb296b-1-loader-picked");

  const planeBefore = (await room()).pieces.find((p) => p.id === planeId);
  await clickCell(dropCell);
  const afterDest = (await sentFrames()).slice(framesBefore)
    .filter((line) => /"op"\s*:\s*"mission"/.test(String(line)));
  let frame = null;
  try { frame = afterDest.length === 1 ? JSON.parse(afterDest[0]) : null; } catch (err) { frame = null; }
  mark("exactly one mission frame goes on the wire for the drop", afterDest.length === 1,
    "frames " + afterDest.length + ": " + afterDest.join(" | ").slice(0, 240));
  mark("that frame is mode=drop carrying to.load = the infantry id",
    Boolean(frame) && String(frame.mode) === "drop" && String(frame.to && frame.to.load) === String(infId),
    frame ? "mode " + frame.mode + " to " + JSON.stringify(frame.to) : "no frame");

  await page.waitForFunction(({ inf, cell }) => {
    const p = (window.__chq.room().pieces || []).find((x) => x.id === inf);
    return Boolean(p) && Number(p.x) === cell.x && Number(p.y) === cell.y;
  }, { inf: infId, cell: dropCell }, { timeout: 12000, polling: 150 }).catch(() => {});
  cur = await room();
  const infEnd = (cur.pieces || []).find((p) => p.id === infId) || null;
  const planeEnd = (cur.pieces || []).find((p) => p.id === planeId) || null;
  mark("the infantry lands on the drop cell", Boolean(infEnd) && infEnd.x === dropCell.x && infEnd.y === dropCell.y,
    infEnd ? infEnd.x + "," + infEnd.y : "gone");
  const expected = Number((100 - 100 * LOSS).toFixed(2));
  mark("the drop costs config's paradropLoss (p.25 rule 3, a stand-in)",
    Boolean(infEnd) && Number(infEnd.strength) === expected,
    infEnd ? "strength " + infEnd.strength + " (100 - " + (100 * LOSS) + " = " + expected + ")" : "gone");
  mark("the aircraft stays home (p.25 rule 2)",
    Boolean(planeEnd) && planeEnd.x === planeBefore.x && planeEnd.y === planeBefore.y,
    planeEnd ? planeEnd.x + "," + planeEnd.y : "gone");
  const line = ((cur.seat && cur.seat.air) || []).find((p) => p.id === planeId) || null;
  mark("the aircraft goes unready for a mission's flight",
    Boolean(line) && line.ready === false && Number(line.roundsLeft) === DROP_ROUNDS,
    line ? "ready " + line.ready + ", roundsLeft " + line.roundsLeft + " (config air.strikeRounds " + DROP_ROUNDS + ")" : "not in the briefing");
  const landedShot = await shot("pb296b-2-dropped");
  mark("evidence: armed loader + dropped screenshots", true, [pickedShot, landedShot].join(" + "));

  mark("no page error", pageErrors.length === 0, pageErrors.join(" | "));
  await context.close();
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGKILL");
  writeFileSync(path.join(OUT, "pb296b-page.json"), JSON.stringify({ base: BASE, evidence }, null, 2));
  console.log("");
  console.log("pb296b page leg: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);
  process.exit(failed ? 1 : 0);
}
