// PB-300 page leg: every "Another piece holds that cell" refusal names the occupying piece the way
// a player reads it ("Tank 2", "Submarine"), never by its wire key ("blue:tank:2", "blue:sea").
//
// PM 9952 §4, filed from 9923/9924. PB-299 gave the Air panel a kind-based display name; the five
// holder refusals in web/server/move.mjs and web/server/air.mjs were left interpolating the raw id,
// so a refusal toast read "Another piece holds that cell (blue:infantry:1)."
//
//   node tests/e2e/pb300-refusal-labels.mjs                     # starts its own server
//   node tests/e2e/pb300-refusal-labels.mjs --url=<base>        # a running server (the shipped build)
//   node tests/e2e/pb300-refusal-labels.mjs --out=<dir>
//   node tests/e2e/pb300-refusal-labels.mjs --mutant=raw-id     # planted mutant: expects RED
//
// Measured through a real page, a real socket and a real server, at 1280x800 AND 1024x768, one
// fresh 1986 cold-war match per viewport:
//   1. five refusal toasts, each read from the rendered #flash line, each in the exact sentence the
//      server sends:
//        land transfer  move.mjs transferPiece   (a transfer onto a cell a friendly tank holds)
//        sea  transfer  move.mjs transferPiece   (a hull onto the cell the opening submarine holds)
//        land order     move.mjs planOrder       (a march onto the same friendly tank)
//        sea  order     move.mjs planOrder       (a hull onto the opening submarine)
//        paradrop       air.mjs  paradrop        (a drop onto the cell the tank holds)
//   2. the name in the parenthesis is the kind-based label PB-299 prints - the same noun, and the
//      id's own number when the id carries one - and is NOT the wire id: the toast contains no
//      "side:kind:n" shape and no "blue:"/"red:" prefix at all;
//   3. the refusals WROTE NOTHING: every piece stands where it stood before the five toasts (a
//      label test that let a refusal become an order would be a false green);
//   4. no page error.
//
// The paradrop is driven by the click path (Air > Paradrop, pick the infantry, click the tank's
// cell). The four other frames are the ones the click path composes - transferMessage/orderMessage
// in web/public/command.mjs are exactly {op,piece,to} - because at the cold-war peace a click on a
// friendly piece's cell RESELECTS that piece (the page's own rule, app.js clickIntent) rather than
// aiming an order at it, and a transfer stops being a transfer once the war is on. The frame the
// page would send is the frame this leg sends, and the toast is the server's own sentence rendered
// in the page's own #flash.
//
// --mutant=raw-id serves a COPY of the tree whose labels module hands back the raw id again (the
// defect restored). The five label assertions are expected to go red; if they stay green the mutant
// survived and the leg exits 1.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const MUTANT = argOf("mutant", "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb300-page")));
mkdirSync(OUT, { recursive: true });

const RAW_ID = /[a-z]+:[a-z]+:\d+/i;
const WIRE_PREFIX = /\b(?:blue|red):/i;
const VIEWPORTS = [[1280, 800], [1024, 768]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The label rule the AC names, written out here rather than imported: a leg that agrees with the
// server because it calls the server's own function cannot catch the server disagreeing with the
// manual. Noun from the piece's kind (PB-299's table), number from the id's own trailing segment.
const NOUNS = {
  infantry: "Infantry", armor: "Armor", tank: "Tank", artillery: "Artillery",
  aircraft: "Aircraft", carrier: "Carrier", transport: "Transport", ship: "Ship",
  submarine: "Submarine", destroyer: "Destroyer", cruiser: "Cruiser", battleship: "Battleship",
  reconSat: "ReconSat", killerSat: "KillerSat",
};
function labelOf(piece) {
  const id = String(piece && piece.id != null ? piece.id : "");
  const kind = String((piece && piece.kind) || id.split(":")[1] || "");
  const noun = NOUNS[kind] || (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "");
  const parts = id.split(":");
  let number = "";
  for (let i = parts.length - 1; i >= 1; i -= 1) if (/^\d+$/.test(parts[i])) { number = parts[i]; break; }
  return number ? noun + " " + number : noun;
}

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

function startServer(port, dataDir, tree) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"] });
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

// A mutant is served from a copy of the tree, so the leg's own checkout is never written.
function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb300-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  if (kind !== "raw-id") throw new Error("unknown mutant: " + kind);
  const file = path.join(dir, "web", "server", "labels.mjs");
  const before = readFileSync(file, "utf8");
  const after = before.replace(
    "  return number ? noun + \" \" + number : noun;",
    "  return id;",
  );
  if (after === before) throw new Error("the mutant could not be planted: the fixed source shape moved");
  writeFileSync(file, after);
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb300-"));
let server = null;
let browser = null;
let BASE = GIVEN;
let serverTree = root;

// One viewport, one cold-war match, five refusals.
async function runViewport(page, width, height) {
  const tag = "[" + width + "x" + height + "] ";
  const room = () => page.evaluate(() => window.__chq.room());
  const toast = () => page.evaluate(() => {
    const el = document.querySelector("#flash") || document.querySelector("#flashLine");
    return el ? String(el.textContent || "").trim() : "";
  });
  const clearToast = () => page.evaluate(() => {
    const el = document.querySelector("#flash") || document.querySelector("#flashLine");
    if (el) el.textContent = "";
  });
  const send = (message) => page.evaluate((m) => window.__chq.send(m), message);
  const BOARD_W = await page.evaluate(() => (window.__chq.boardWidth ? window.__chq.boardWidth() : 320)).catch(() => 320);
  const awayOn = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(BOARD_W - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };

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
    const near = (cells || [])
      .filter((c) => awayOn(c, anchor) <= 3 && !taken.has(c.x + "," + c.y))
      .sort((a, b) => awayOn(a, anchor) - awayOn(b, anchor));
    const pool = near.length ? near : (cells || [])
      .filter((c) => !taken.has(c.x + "," + c.y))
      .sort((a, b) => awayOn(a, anchor) - awayOn(b, anchor));
    for (const cell of pool.slice(0, 10)) {
      await clickCell(cell);
      await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 6000, polling: 100 }).catch(() => {});
      const after = await room();
      const piece = (after.pieces || []).find((p) => !before.has(p.id));
      if (piece) return { piece, cell };
      const still = await page.evaluate(() => window.__chq.state().placement === true);
      if (!still) return { error: "the " + kind + " purchase was refused: " + (await toast()) };
    }
    return { error: "the " + kind + " never appeared on the board" };
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.setViewportSize({ width, height });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb300-" + width + "-" + Date.now().toString(36).slice(-7);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  await sleep(700);
  let cur = await room();
  for (let i = 0; i < 6; i += 1) {
    const c0 = await room();
    if (!c0 || c0.clock !== "running") break;
    await page.click("#clockBtn").catch(() => {});
    await page.waitForFunction(() => window.__chq.room().clock !== "running", null, { timeout: 8000, polling: 100 }).catch(() => {});
    await sleep(150);
  }
  cur = await room();
  mark(tag + "a 1986 match is open and the clock is held", Boolean(cur && cur.seat && cur.clock !== "running"), "round " + (cur && cur.round) + " clock " + (cur && cur.clock));
  mark(tag + "the scenario opens in the cold-war peace, where a transfer is a legal order", Boolean(cur.peace && cur.peace.active === true), JSON.stringify(cur.peace));

  const sites = (cur.sites || []).filter((s) => s.owner === "blue");
  const home = sites.filter((s) => ["city", "capital", "base"].includes(String(s.kind)))[0] || null;
  const dock = sites.filter((s) => ["dock", "port", "city", "capital", "base"].includes(String(s.kind)))[0] || home;
  if (!home) throw new Error("no friendly city to buy at");

  // 5000b of pool: a tank (20) as the land occupant, an aircraft (20) to fly the drop, a cruiser (10).
  const tank = await buyAt("tank", home);
  if (tank.error) throw new Error(tank.error);
  const plane = await buyAt("aircraft", home);
  if (plane.error) throw new Error(plane.error);
  const hull = await buyAt("cruiser", dock);
  if (hull.error) throw new Error(hull.error);
  cur = await room();
  const opener = (cur.pieces || []).find((p) => p.kind === "infantry" && p.side === "blue");
  const sub = (cur.pieces || []).find((p) => p.kind === "submarine" && p.side === "blue");
  mark(tag + "the board carries an infantry, a tank, a plane, a hull and the opening submarine",
    Boolean(opener && sub), JSON.stringify({ infantry: opener && opener.id, tank: tank.piece.id, plane: plane.piece.id, cruiser: hull.piece.id, submarine: sub && sub.id }));

  const expected = {
    "transfer-land": labelOf(tank.piece),
    "transfer-sea": labelOf(sub),
    "order-land": labelOf(tank.piece),
    "order-sea": labelOf(sub),
    "drop": labelOf(tank.piece),
  };
  const before = new Map(((await room()).pieces || []).map((p) => [p.id, p.x + "," + p.y]));
  const toasts = {};

  async function readRefusal(key, fire) {
    await clearToast();
    await fire();
    await sleep(500);
    const text = await toast();
    toasts[key] = text;
    const shape = /^Another piece holds that cell \((.+)\)\.$/.exec(text);
    const name = shape ? shape[1] : "";
    mark(tag + key + " is the holder refusal, and it renders in #flash", Boolean(shape), "toast \"" + text + "\"");
    const holder = key.endsWith("sea") ? sub.id : tank.piece.id;
    mark(tag + key + " names the piece by label, not by wire id",
      Boolean(shape) && name === expected[key] && !RAW_ID.test(text) && !WIRE_PREFIX.test(text) && !text.includes(String(holder)),
      "name \"" + name + "\" expected \"" + expected[key] + "\"; holder " + holder);
    return text;
  }

  // 1.land transfer: the opening infantry onto the cell a friendly tank holds, at peace.
  await readRefusal("transfer-land", () => send({ op: "transfer", kind: "transfer", piece: opener.id, to: { x: tank.piece.x, y: tank.piece.y } }));
  // 2.sea transfer: the bought cruiser onto the cell the opening submarine holds.
  await readRefusal("transfer-sea", () => send({ op: "transfer", kind: "transfer", piece: hull.piece.id, to: { x: sub.x, y: sub.y } }));
  // 3.land order: the same march, as the order op composes it.
  await readRefusal("order-land", () => send({ op: "order", piece: opener.id, to: { x: tank.piece.x, y: tank.piece.y } }));
  // 4.sea order: the hull onto the submarine's cell.
  await readRefusal("order-sea", () => send({ op: "order", piece: hull.piece.id, to: { x: sub.x, y: sub.y } }));

  // 5.paradrop: the click path - select the plane, Air > Paradrop, pick the infantry, click the tank.
  const planeSelected = await selectPiece(plane.piece, plane.piece.id);
  mark(tag + "the aircraft is selected for the Air door", planeSelected, "selected " + JSON.stringify(await page.evaluate(() => window.__chq.state().selected)));
  await page.click('.navbtn[data-dialog="air"]').catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 }).catch(() => {});
  const armedDrop = await page.evaluate((id) => {
    const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
    const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || (c.textContent || "").trim()) === String(id); });
    if (!row) return { clicked: false, missing: true };
    const button = [...row.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Paradrop");
    if (!button) return { clicked: false, noDrop: true };
    if (button.disabled) return { clicked: false, disabled: true };
    button.click();
    return { clicked: true };
  }, plane.piece.id);
  mark(tag + "the Air door offers Paradrop for the plane this leg bought", Boolean(armedDrop.clicked), JSON.stringify(armedDrop));
  const loadPicked = await page.evaluate((id) => {
    const armed = String(window.__chq.state().armedLoad || "");
    return { armed, same: armed === String(id) };
  }, opener.id).catch(() => ({ armed: "", same: false }));
  // The loader is picked by clicking the infantry; then the tank's cell is the refused target.
  await clickCell({ x: opener.x, y: opener.y });
  const afterPick = await page.evaluate(() => window.__chq.state().armedLoad).catch(() => null);
  mark(tag + "clicking the infantry arms it as the drop's load", String(afterPick) === String(opener.id), "armedLoad " + JSON.stringify(afterPick) + " (was " + JSON.stringify(loadPicked.armed) + ")");
  await readRefusal("drop", () => clickCell({ x: tank.piece.x, y: tank.piece.y }));

  // ---------------------------------------------------------------- the refusals wrote nothing
  const after = new Map(((await room()).pieces || []).map((p) => [p.id, p.x + "," + p.y]));
  const moved = [];
  for (const [id, where] of before) if (after.has(id) && after.get(id) !== where) moved.push(id + " " + where + " -> " + after.get(id));
  mark(tag + "all five refusals wrote nothing: every piece stands where it stood", moved.length === 0, moved.join(" | ") || "no piece moved");
  mark(tag + "the match is still at the cold-war peace the five refusals were made in", Boolean((await room()).peace && (await room()).peace.active === true));
  await page.screenshot({ path: path.join(OUT, "pb300-refusals-" + width + "x" + height + ".png") });
  return toasts;
}

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
  const pageErrors = [];
  const all = {};
  for (const [w, h] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(w + "x" + h + ": " + String(err)));
    all[w + "x" + h] = await runViewport(page, w, h);
    mark("[" + w + "x" + h + "] no page error", pageErrors.filter((line) => line.startsWith(w + "x" + h)).length === 0,
      pageErrors.filter((line) => line.startsWith(w + "x" + h)).join(" | "));
    await context.close();
  }

  writeFileSync(path.join(OUT, MUTANT ? "pb300-page-mutant-" + MUTANT + ".json" : "pb300-page.json"), JSON.stringify({
    base: BASE, tree: serverTree, mutant: MUTANT || null, toasts: all, steps: evidence,
    passed: evidence.filter((e) => e.ok).length, failed,
  }, null, 2));
} catch (err) {
  mark("the leg ran to its end", false, String(err && err.stack || err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGKILL");
}

const passed = evidence.filter((e) => e.ok).length;
const NEGATIVES = ["names the piece by label, not by wire id"];
let verdict = failed === 0;
if (MUTANT) {
  const survived = evidence.filter((e) => e.ok && NEGATIVES.some((needle) => e.step.includes(needle)));
  const sawRed = evidence.filter((e) => !e.ok && NEGATIVES.some((needle) => e.step.includes(needle))).length;
  verdict = survived.length === 0 && sawRed >= 5;
  console.log("pb300 mutant " + MUTANT + ": " + (verdict ? "KILLED" : "SURVIVED")
    + " — label assertions red " + sawRed + "/10"
    + (survived.length ? "; still green: " + survived.map((s) => s.step).join(" | ") : ""));
} else {
  console.log("pb300 refusal labels: " + passed + " passed / " + failed + " failed");
}
console.log("evidence " + OUT);
process.exit(verdict ? 0 : 1);
