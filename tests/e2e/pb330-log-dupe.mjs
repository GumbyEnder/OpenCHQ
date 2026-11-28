// PB-330 page leg: one order, one Log row - in the mover's own Log, at both widths.
//
//   node tests/e2e/pb330-log-dupe.mjs                  # starts its own server
//   node tests/e2e/pb330-log-dupe.mjs --url=<base>      # a running server
//   node tests/e2e/pb330-log-dupe.mjs --out=<dir>
//   node tests/e2e/pb330-log-dupe.mjs --mutant=echo     # the client echo put back, expects RED
//
// The defect (live 1743651): the page wrote its own echo into the round Log ("Transferred. The unit
// is in its new location this round", "Starting destination set: 2 rounds of walking...") and the
// server delivered the same act as its own line ("a unit transferred", "a destination is set..."),
// so an order the player just gave read as two near-identical rows. The client echo is gone; the
// server's line is the single row - the one that also survives a reload, because it lives in
// room.log - and for a starting destination it now carries the round count the echo used to carry.
//
// Arms per width, on a 1986 war (it opens at peace, which is the only state where both doors exist):
//   (transfer) a click on a unit, then a click on a destination cell: one row, and it is the
//              delivered sentence, not a second copy of the toast;
//   (destination) select the unit twice, then its destination: one row, carrying the walk's round
//              count, and it says it moves when war begins;
//   (reload) after a reload the Log still shows exactly the same single row for the last act;
//   (ids) no raw piece id and no bare cell coordinate in either row.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function headSha() {
  const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return out.status === 0 ? String(out.stdout || "").trim() : "";
}
const SHA = String(process.env.GATE_SHA || "").trim() || headSha();

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const MUTANT = argOf("mutant", "");
const OUT = evidenceDir("pb330", argOf("out"));
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [[1280, 800], [1024, 768]];
const ERA = "1986";
const TRANSFER_ECHO = "Transferred. The unit is in its new location this round";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

function startServer(port, dataDir, tree) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir,
      ...(SHA ? { OPENCHQ_COMMIT: SHA } : {}) };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 15000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

// The mutant is planted in a COPY of the tree so the checkout under test is never edited: the
// client echo is put back into the transfer ack, which is exactly what PB-330 removed.
function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb330-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const appPath = path.join(dir, "web", "public", "app.js");
  const before = readFileSync(appPath, "utf8");
  // The pre-fix shape exactly: the echo written WITHOUT the act key, so the server's delivered line
  // for the same act is no longer recognised as the same row and lands beside it.
  const keyed = '        key: actKey("transfer", message.piece, message.to),\n';
  let after = before;
  if (kind === "echo") {
    after = before.replace(keyed, "");
  } else {
    throw new Error("unknown mutant: " + kind);
  }
  if (after === before) throw new Error("the mutant could not be planted: the transfer ack moved");
  writeFileSync(appPath, after);
  return dir;
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

async function clickCell(page, cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const size = page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) {
    await page.click("#camFit");
    return clickCell(page, cell);
  }
  await page.mouse.click(point.x, point.y);
  return point;
}

const logOf = (page) => page.evaluate(() => window.__chq.log());

// The newest rows a click produced, so a line the round wrote later is never read as the echo.
async function rowsSince(page, count) {
  const all = await logOf(page);
  return all.slice(count);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb330-"));
let server = null;
let browser = null;
let BASE = GIVEN;
let serverTree = root;

try {
  if (!BASE) {
    const tree = MUTANT ? mutantTree(MUTANT) : root;
    serverTree = tree;
    const port = await freePort();
    server = await startServer(port, dataDir, tree);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE + " tree=" + (MUTANT ? "mutant(" + MUTANT + ")" : "the checkout"));
  } else {
    mark("a given server answers", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });

  for (const [width, height] of VIEWPORTS) {
    const at = width + "x" + height;
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const name = "e2e-pb330-" + Date.now().toString(36).slice(-8) + width;
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + name);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await sleep(500);

    await page.selectOption('#launch select[name="era"]', ERA);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
    await sleep(800);
    let room = await page.evaluate(() => window.__chq.room());
    const openedAtPeace = Boolean(room && room.peace && room.peace.active === true);
    mark("(setup) the 1986 war opens at peace" + " @" + at, openedAtPeace,
      JSON.stringify({ era: room && room.era, round: room && room.round, peace: room && room.peace }));
    if (room && room.clock === "running") await page.click("#clockBtn").catch(() => {});
    await sleep(250);

    // One gesture, one op: at peace a click on the unit and a click on a cell is a TRANSFER; the
    // same unit selected TWICE then a cell is a starting DESTINATION (manual printed p.31). Each
    // door is entered from a FRESH page: a leftover selection is the second click of the arming
    // gesture, and that is how a transfer arm can silently become a destination arm.
    const landPieces = (room.pieces || []).filter((p) => p.side === room.you
      && String(p.domain || "land") === "land" && p.kind !== "aircraft" && p.transport !== true);
    const targetFor = (piece, dx, dy) => ({ x: (Number(piece.x) + dx + 320) % 320,
      y: Math.max(0, Math.min(199, Number(piece.y) + dy)) });
    const walkOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, -2]];

    const freshPage = async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__chq && window.__chq.room && window.__chq.room(), null, { timeout: 25000, polling: 200 }).catch(() => {});
      await sleep(800);
      return page.evaluate(() => window.__chq.room());
    };
    const orderAt = async (piece, target, arm) => {
      await clickCell(page, { x: piece.x, y: piece.y });
      await sleep(170);
      if (arm) { await clickCell(page, { x: piece.x, y: piece.y }); await sleep(280); }
      await clickCell(page, target);
      await sleep(750);
    };
    const walkOff = async (arm) => {
      const before = (await logOf(page)).length;
      const at0 = await page.evaluate(() => window.__chq.room());
      const list = (at0.pieces || []).filter((p) => p.side === at0.you
        && String(p.domain || "land") === "land" && p.kind !== "aircraft" && p.transport !== true);
      for (const piece of list.slice(0, 10)) {
        for (const [dx, dy] of walkOffsets) {
          await orderAt(piece, targetFor(piece, dx, dy), arm);
          const rows = (await logOf(page)).slice(before);
          if (rows.length) return { piece, rows };
          // A refused attempt leaves the selection armed: reset before the next gesture.
          await freshPage();
        }
      }
      return null;
    };

    // ---- (transfer) -----------------------------------------------------------------------
    let landed = await walkOff(false);
    if (!landed) mark("(transfer) the click transfer landed" + " @" + at, false, "no row for any land unit");
    else {
      const rows = landed.rows;
      const text = rows.length === 1 ? rows[0].text : "";
      mark("(transfer) the click transfer landed" + " @" + at, /Transferred|a unit transferred/.test(text),
        JSON.stringify(text));
      mark("(transfer) one order writes ONE Log row" + " @" + at, rows.length === 1,
        rows.length + " rows: " + JSON.stringify(rows.map((r) => r.text)));
      mark("(transfer) the row is the mover's own sentence, once" + " @" + at,
        text === TRANSFER_ECHO, JSON.stringify(text));
      mark("(transfer) the row carries no raw piece id or cell" + " @" + at,
        rows.every((r) => !String(r.text).includes(landed.piece.id) && !/\b\d{1,3},\d{1,3}\b/.test(String(r.text))),
        JSON.stringify(rows.map((r) => r.text)));
    }
    await freshPage();
    const afterTransferReload = await logOf(page);
    const transferRows = afterTransferReload.filter((row) => /transferred/i.test(String(row && row.text)));
    mark("(transfer) the act is still one row after a reload" + " @" + at, transferRows.length === 1,
      JSON.stringify({ rows: afterTransferReload.map((r) => r.text).slice(-4) }));

    // ---- (destination) --------------------------------------------------------------------
    let destination = await walkOff(true);
    if (!destination) mark("(destination) the click destination landed" + " @" + at, false, "no row for any land unit");
    else {
      const rows = destination.rows;
      const text = rows.length === 1 ? rows[0].text : "";
      mark("(destination) the click destination landed" + " @" + at, /destination/i.test(text), JSON.stringify(text));
      mark("(destination) one order writes ONE Log row" + " @" + at, rows.length === 1,
        rows.length + " rows: " + JSON.stringify(rows.map((r) => r.text)));
      mark("(destination) the row keeps the walk's round count" + " @" + at,
        /\b\d+ round(s)? of walking\b/.test(text), JSON.stringify(text));
      mark("(destination) the row says it waits for the war" + " @" + at,
        /war begins/i.test(text) && /destination/i.test(text), JSON.stringify(text));
      mark("(destination) the row carries no raw piece id or cell" + " @" + at,
        rows.every((r) => !String(r.text).includes(destination.piece.id) && !/\b\d{1,3},\d{1,3}\b/.test(String(r.text))),
        JSON.stringify(rows.map((r) => r.text)));
      await page.screenshot({ path: path.join(OUT, "pb330-" + at + "-destination.png") });
    }
    await freshPage();
    const afterReload = await logOf(page);
    const actRows = afterReload.filter((row) => /destination\b/i.test(String(row && row.text)));
    mark("(reload) the act is still ONE row after a reload" + " @" + at, actRows.length === 1,
      JSON.stringify({ rows: afterReload.map((r) => r.text).slice(-4) }));
    mark("(errors) no page errors" + " @" + at, pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
    await context.close();
  }

  const named = mark("the evidence names the tree it graded", Boolean(SHA),
    SHA ? SHA + (String(process.env.GATE_SHA || "").trim() ? " (GATE_SHA)" : " (git rev-parse HEAD of " + root + ")")
      : "no GATE_SHA and git rev-parse HEAD in " + root + " returned nothing");
  if (named) writeFileSync(path.join(OUT, MUTANT ? "pb330-evidence-" + MUTANT + ".json" : "pb330-evidence.json"),
    JSON.stringify({ sha: SHA, base: BASE, mutant: MUTANT, viewports: VIEWPORTS, evidence }, null, 2));
} catch (err) {
  mark("the leg ran to the end", false, err && err.message ? err.message : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGKILL");
  console.log((failed ? "RED" : "GREEN") + " — " + evidence.filter((e) => e.ok).length + " pass, " + failed + " fail; tree " + (MUTANT ? "mutant(" + MUTANT + ")" : serverTree));
  process.exit(failed ? 1 : 0);
}
