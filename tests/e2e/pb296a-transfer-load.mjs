// PB-296a page leg: the player picks an infantry, then a destination, and the loaded transfer
// carries both. The pixels and the wire frame, not just the payload.
//
//   node tests/e2e/pb296a-transfer-load.mjs                # starts its own server
//   node tests/e2e/pb296a-transfer-load.mjs --url=<base>   # a running server (the base tree: red)
//   node tests/e2e/pb296a-transfer-load.mjs --out=<dir>
//
// PM 9855 §4: "The UI needs a page leg for both: Air panel, then pick the infantry, then the
// destination." Manual printed p.25: a loaded transfer needs infantry within 3 spaces of the plane's
// START and entrenched, with the destination a friendly city or base inside the restricted radius.
// The server half is pinned in web/test/nodes/pb296a_transfer_load.mjs; this leg pins the DOOR:
//
//   1. an infantry and an aircraft are bought in the cold war at New York (readiness is not charged
//      at peace, so both belong to one city);
//   2. the war begins, the infantry marches onto dig-in ground within 3 cells of the city, and the
//      Kit door digs it in - entrenched is read back from the server;
//   3. Air > Transfer arms the transfer; clicking the INFANTRY sends nothing, and the toast says the
//      loader is aboard;
//   4. clicking the destination cell (Boston, a friendly city 2 cells away, inside the restricted
//      radius) puts exactly ONE mission frame on the wire, with mode=transfer and to.load = the
//      infantry's id;
//   5. the server's room shows both pieces on Boston and the aircraft away for
//      config air.transferRounds.
//
// At the base tree (3231d2a) step 3 fails: the page has no loader stage, so the infantry click is
// itself a transfer order and the frame carries no load. That is the red receipt the leg is for.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { terrainNameAt } from "../../web/server/move.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb296a-page")));
mkdirSync(OUT, { recursive: true });

const CONFIG = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
const AIR = CONFIG.air || {};
const TRANSFER_ROUNDS = Number(AIR.transferRounds);
const RESTRICTED = Number(AIR.restrictedReach);
const LOAD_CELLS = 3; // the printed page's radius; air.mjs carries the same constant

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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + ": " + log));
    });
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb296a-"));
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

  async function setClock(want) {
    for (let i = 0; i < 6; i++) {
      const cur0 = await room();
      if (!cur0) return false;
      const now = cur0.clock === "running" ? "running" : "held";
      if (now === want) return true;
      await page.click("#clockBtn").catch(() => {});
      await page.waitForFunction((w) => {
        const r = window.__chq.room();
        return Boolean(r) && (r.clock === "running" ? "running" : "held") === w;
      }, want, { timeout: 8000, polling: 100 }).catch(() => {});
      await sleep(150);
    }
    return false;
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
      await sleep(160);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(200);
    return true;
  }

  // Selecting a PIECE, not the city it stands on: the first click on an occupied cell may inspect
  // the site (PB-163), so the selection is read from the page's own state and the click repeated.
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
  const name = "e2e-pb296a-" + Date.now().toString(36).slice(-8);
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
  await setClock("held");
  cur = await room();
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));
  mark("the cold war is on at the bell (p.31), so production does not tire the cities",
    Boolean(cur && cur.peace && cur.peace.active), JSON.stringify(cur && cur.peace));

  // ---------------------------------------------------------------- the friendly strips
  const sites = (cur && cur.sites) || [];
  const strips = sites.filter((s) => s.owner === "blue" && ["city", "capital", "base"].includes(String(s.kind)));
  const awayOn = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(BOARD_W - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };
  // Home: the friendly strip closest to another friendly strip inside the restricted radius, so the
  // leg can always name a legal destination for a LOADED transfer (p.25).
  let home = null;
  let dest = null;
  for (const a of strips) {
    for (const b of strips) {
      if (a === b) continue;
      const d = awayOn(a, b);
      if (d < 1 || d > RESTRICTED) continue;
      if (!home || d < awayOn(home, dest)) { home = a; dest = b; }
    }
  }
  mark("the board has a friendly city pair inside the restricted radius", Boolean(home && dest),
    home && dest ? home.name + " -> " + dest.name + " (" + awayOn(home, dest) + " cells, r" + RESTRICTED + ")" : "no pair within " + RESTRICTED);

  // ---------------------------------------------------------------- buy the infantry, then the plane
  async function buyAt(kind, anchor, want, tries = 12) {
    const before = new Set(((await room()).pieces || []).map((p) => p.id));
    await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
    await sleep(250);
    const row = await page.evaluate((k) => {
      const el = document.querySelector('button.buyrow[data-kind="' + k + '"]');
      return el ? { disabled: Boolean(el.disabled), text: el.textContent.trim().slice(0, 90) } : null;
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
    if (!scored.length) return { error: "no free legal cell within 2 of " + anchor.name + " (legal " + (cells || []).length + ")" };
    for (const cell of scored.slice(0, tries)) {
      await clickCell(cell);
      await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id) && p.kind !== undefined), [...before], { timeout: 6000, polling: 100 })
        .catch(() => {});
      const after = await room();
      const piece = (after.pieces || []).find((p) => !before.has(p.id) && p.kind === kind);
      if (piece) return { piece, cell, row: row.text };
      // a refused placement leaves the buy armed; click again on the next candidate
      const stillArmed = await page.evaluate(() => window.__chq.state().placement === true);
      if (!stillArmed) return { error: "the " + kind + " purchase was refused: " + (await noteText()) };
    }
    return { error: "the " + kind + " never appeared on the board" };
  }

  const boughtInf = await buyAt("infantry", home);
  if (boughtInf.error) throw new Error(boughtInf.error);
  const infId = boughtInf.piece.id;
  mark("an infantry is bought at the home city in the cold war", true,
    infId + " at " + boughtInf.cell.x + "," + boughtInf.cell.y + " (" + boughtInf.row + ")");

  const boughtAir = await buyAt("aircraft", home);
  if (boughtAir.error) throw new Error(boughtAir.error);
  const planeId = boughtAir.piece.id;
  mark("an aircraft is bought at the same city, still at peace (no readiness charge)", true,
    planeId + " at " + boughtAir.cell.x + "," + boughtAir.cell.y);

  // ---------------------------------------------------------------- begin hostilities, march, dig in
  const warSent = await page.evaluate(() => {
    const hit = [...document.querySelectorAll("button")].find((b) => /begin hostilities/i.test(b.textContent || ""));
    if (hit) { hit.click(); return "button"; }
    return null;
  });
  if (!warSent) await send({ op: "resume_war" });
  await sleep(600);
  cur = await room();
  mark("the war begins (the mandatory window is 0 rounds for 1986)", Boolean(cur && (!cur.peace || cur.peace.active !== true)),
    "peace " + JSON.stringify(cur && cur.peace) + (warSent ? " via " + warSent : " via resume_war"));

  // A dig-in cell: the printed page's loader must be ENTRENCHED, and entrench() refuses a city,
  // base or capital. So the infantry walks out to plain/forest/desert within the 3-cell radius.
  const DIG = new Set(["plain", "forest", "desert"]);
  const occupied = new Set(((await room()).pieces || []).map((p) => p.x + "," + p.y));
  let digCell = null;
  for (let r = 1; r <= LOAD_CELLS - 1 && !digCell; r += 1) {
    for (let dy = -r; dy <= r && !digCell; dy += 1) {
      for (let dx = -r; dx <= r && !digCell; dx += 1) {
        const x = ((Number(home.x) + dx) % BOARD_W + BOARD_W) % BOARD_W;
        const y = Number(home.y) + dy;
        if (y < 0 || y > 135) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const key = x + "," + y;
        if (occupied.has(key)) continue;
        if (!DIG.has(String(terrainNameAt(x, y)))) continue;
        digCell = { x, y };
      }
    }
  }
  mark("a dig-in cell stands within the loader's radius of the city", Boolean(digCell),
    digCell ? digCell.x + "," + digCell.y + " " + terrainNameAt(digCell.x, digCell.y) : "none within " + (LOAD_CELLS - 1));

  const infSelected = await selectPiece(boughtInf.cell, infId);
  mark("the infantry is selected by its own cell, not the city under it", infSelected,
    "selected " + JSON.stringify(await page.evaluate(() => window.__chq.state().selected)));
  // The march is SETUP, not the thing under test: an adjacent-cell click can land on the aircraft's
  // own marker at this zoom (the plane is drawn across the cell edge), so the walk is the same order
  // the page would send, on the wire, with the page's own op shape.
  await send({ op: "order", piece: infId, to: digCell });
  await send({ op: "speed", speed: 6 });
  await send({ op: "run" });
  const arrived = await page.waitForFunction(({ id, cell }) => {
    const p = (window.__chq.room().pieces || []).find((piece) => piece.id === id);
    return Boolean(p) && Number(p.x) === cell.x && Number(p.y) === cell.y && (!p.path || p.path.length === 0);
  }, { id: infId, cell: digCell }, { timeout: 40000, polling: 150 }).then(() => true).catch(() => false);
  await send({ op: "hold" });
  await sleep(300);
  cur = await room();
  const walked = (cur.pieces || []).find((p) => p.id === infId) || null;
  mark("the infantry marches onto the dig-in cell", arrived && Boolean(walked) && walked.x === digCell.x && walked.y === digCell.y,
    walked ? "at " + walked.x + "," + walked.y + (arrived ? "" : " (never arrived)") : "infantry gone");
  mark("the loader is within the printed 3 cells of the aircraft's start",
    Boolean(walked && Number(boughtAir.piece.x) >= 0) && awayOn(walked || digCell, boughtAir.piece) <= LOAD_CELLS,
    "loader->plane " + (walked ? awayOn(walked, boughtAir.piece) : "?"));

  // Dig in through the Kit door.
  await selectPiece(digCell, infId);
  await page.click('.navbtn[data-dialog="kit"]').catch(() => {});
  await page.waitForSelector("#dialogBody button", { timeout: 8000 }).catch(() => {});
  const dug = await page.evaluate(() => {
    const hit = [...document.querySelectorAll("#dialogBody button.buy")].find((b) => /dig in/i.test(b.textContent || ""));
    if (!hit) return { clicked: false };
    if (hit.disabled) return { clicked: false, disabled: true, title: hit.title };
    hit.click();
    return { clicked: true };
  });
  await sleep(600);
  if (!dug.clicked) await send({ op: "entrench", piece: infId });
  await sleep(500);
  cur = await room();
  const entrenched = (cur.pieces || []).find((p) => p.id === infId) || null;
  mark("the Kit door digs the loader in (entrenched read from the server)",
    Boolean(entrenched) && entrenched.entrenched === true, JSON.stringify(dug) + " entrenched=" + (entrenched && entrenched.entrenched));
  await page.keyboard.press("Escape").catch(() => {});
  const dugShot = await shot("pb296a-1-loader-entrenched");

  // ---------------------------------------------------------------- Air > Transfer: loader, then destination
  const airSelected = await selectPiece(boughtAir.cell, planeId);
  mark("the aircraft is selected for the Air door", airSelected,
    "selected " + JSON.stringify(await page.evaluate(() => window.__chq.state().selected)));
  await page.click('.navbtn[data-dialog="air"]').catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 })
    .catch(() => {});
  const armedTransfer = await page.evaluate((id) => {
    const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
    const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || (c.textContent || "").trim()) === String(id); });
    if (!row) return { clicked: false, missing: true };
    const button = [...row.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Transfer");
    if (!button) return { clicked: false, noTransfer: true };
    if (button.disabled) return { clicked: false, disabled: true };
    const title = button.title || "";
    button.click();
    return { clicked: true, title };
  }, planeId);
  await sleep(400);
  mark("the Air door arms Transfer for the plane", Boolean(armedTransfer.clicked), JSON.stringify(armedTransfer));
  mark("the Transfer door names the loader rule before the player aims",
    /infantry/i.test(String(armedTransfer.title || "")) && /entrench/i.test(String(armedTransfer.title || "")),
    JSON.stringify(String(armedTransfer.title || "").slice(0, 200)));

  const framesBefore = (await sentFrames()).length;
  await clickCell(digCell); // the loader
  // The route request a hover makes is not an order: only an op that moves a piece would spend the
  // click, and none may.
  const afterLoader = (await sentFrames()).slice(framesBefore)
    .filter((line) => /"(op)"\s*:\s*"(mission|order|transfer)"/.test(String(line)));
  await sleep(250);
  const armedLoad = await page.evaluate(() => window.__chq.state().armedLoad);
  mark("clicking the infantry sends NO order (it is the loader, not the destination)", afterLoader.length === 0,
    "orders " + afterLoader.length + ": " + afterLoader.join(" | ").slice(0, 200));
  mark("the page holds the infantry as the armed load", String(armedLoad) === String(infId),
    "armedLoad " + JSON.stringify(armedLoad));
  const loaderShot = await shot("pb296a-2-loader-picked");

  await clickCell(dest); // the destination city
  const afterDest = (await sentFrames()).slice(framesBefore)
    .filter((line) => /"op"\s*:\s*"mission"/.test(String(line)));
  let frame = null;
  try { frame = afterDest.length === 1 ? JSON.parse(afterDest[0]) : null; } catch (err) { frame = null; }
  mark("exactly one mission frame goes on the wire for the loaded transfer", afterDest.length === 1,
    "frames " + afterDest.length + ": " + afterDest.join(" | ").slice(0, 240));
  mark("that frame is a transfer carrying to.load = the infantry id",
    Boolean(frame) && String(frame.mode) === "transfer" && String(frame.to && frame.to.load) === String(infId),
    frame ? "mode " + frame.mode + " to " + JSON.stringify(frame.to) : "no frame");

  await page.waitForFunction(({ plane, inf, dest }) => {
    const pieces = window.__chq.room().pieces || [];
    const p = pieces.find((x) => x.id === plane);
    const i = pieces.find((x) => x.id === inf);
    return Boolean(p && i) && Number(p.x) === dest.x && Number(p.y) === dest.y &&
      Number(i.x) === dest.x && Number(i.y) === dest.y;
  }, { plane: planeId, inf: infId, dest }, { timeout: 12000, polling: 150 }).catch(() => {});
  cur = await room();
  const planeEnd = (cur.pieces || []).find((p) => p.id === planeId) || null;
  const infEnd = (cur.pieces || []).find((p) => p.id === infId) || null;
  mark("the aircraft lands on the destination city", Boolean(planeEnd) && planeEnd.x === dest.x && planeEnd.y === dest.y,
    planeEnd ? planeEnd.x + "," + planeEnd.y : "gone");
  mark("the infantry rides with it (p.25: a loaded transfer carries the infantry)",
    Boolean(infEnd) && infEnd.x === dest.x && infEnd.y === dest.y, infEnd ? infEnd.x + "," + infEnd.y : "gone");
  const line = ((cur.seat && cur.seat.air) || []).find((p) => p.id === planeId) || null;
  mark("the aircraft is unready for the transfer's own rounds (p.25/p.22)",
    Boolean(line) && line.ready === false && Number(line.roundsLeft) === TRANSFER_ROUNDS,
    line ? "ready " + line.ready + ", roundsLeft " + line.roundsLeft + " (config " + TRANSFER_ROUNDS + ")" : "not in the briefing");
  const landedShot = await shot("pb296a-3-loaded-transfer-landed");
  mark("evidence: arm, loader and landed screenshots", true, [dugShot, loaderShot, landedShot].join(" + "));

  mark("no page error", pageErrors.length === 0, pageErrors.join(" | "));
  await context.close();
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGKILL");
  writeFileSync(path.join(OUT, "pb296a-page.json"), JSON.stringify({ base: BASE, evidence }, null, 2));
  console.log("");
  console.log("pb296a page leg: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);
  process.exit(failed ? 1 : 0);
}
