// PB-333 page leg: the Air dialog's help line is player-facing, and the config-language is gone.
//
// The defect (PM 10375 §4, frozen): the Air panel's footer read
//   "A mission puts the aircraft out of action for its own number of rounds; that number is the
//    config's, not this page's."
// — a sentence about the implementation, not the game. The replacement, and only the replacement:
//   "A mission takes the aircraft out of action for the rounds shown."
// PB-333 changes COPY ONLY: mission duration behaviour (the Away cell, the rounds a mission costs)
// is untouched, and arm (d) pins that the row still renders "ready" or "<n> rounds".
//
//   node tests/e2e/pb333-air-help.mjs                    # starts its own server on this checkout
//   node tests/e2e/pb333-air-help.mjs --url=<base>        # a running server (live leg)
//   node tests/e2e/pb333-air-help.mjs --mutant=old-copy   # the old sentence planted back: expects RED
//   node tests/e2e/pb333-air-help.mjs --out=<dir>
//
// Arms, per viewport (1280x800 and 1024x768), in a real 1986 match with a bought-and-berthed aircraft:
//   (a)  the Air panel draws with the plane's row (the control: the leg is inside the right panel);
//   (b)  the new sentence is VISIBLE in the panel body, exactly once, and it is the footer that sits
//        under the aircraft table — not somewhere else on the page;
//   (c)  the old wording is gone: no visible text in the panel contains "config's"; the page's whole
//        text carries no "not this page's"; and the SERVED app.js source no longer contains the old
//        sentence (the panel's other "config's" strings are code comments, so the source probe is
//        sentence-specific on purpose);
//   (d)  mission duration behaviour is untouched: the Away cell still reads "ready" or "<n> rounds";
//   (e)  no page error.
//
// --mutant=old-copy serves a COPY of this tree with the old sentence restored; (b) and (c) must go
// RED BY NAME. A leg that only ever ran against the fix proves the fix "renders", never that the arm
// can see the defect.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const MUTANT = argOf("mutant", "");
const ERA = "1986";
const OUT = evidenceDir("pb333-air-help", argOf("out"));
mkdirSync(OUT, { recursive: true });

const NEW_SENTENCE = "A mission takes the aircraft out of action for the rounds shown.";
const OLD_SENTENCE = "A mission puts the aircraft out of action for its own number of rounds; that number is the config's, not this page's.";
const OLD_FRAGMENT = "not this page's";
const CONFIG_WORD = "config's";
const VIEWPORTS = [[1280, 800], [1024, 768]];
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

// The mutant is planted in a COPY of the tree so the checkout under test is never written.
function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb333-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const appPath = path.join(dir, "web", "public", "app.js");
  const before = readFileSync(appPath, "utf8");
  let after = before;
  if (kind === "old-copy") {
    after = before.replace(NEW_SENTENCE, OLD_SENTENCE);
  } else {
    throw new Error("unknown mutant: " + kind);
  }
  if (after === before) throw new Error("the mutant could not be planted: the fixed source shape moved");
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb333-"));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());

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
    await sleep(160);
    return true;
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb333-" + Date.now().toString(36).slice(-8);
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
  if (cur && cur.clock === "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
    cur = await room();
  }
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

  // ---------------------------------------------------------------- buy and berth an aircraft
  const board0 = await page.evaluate(() => (window.__chq.boardWidth ? window.__chq.boardWidth() : 320)).catch(() => 320);
  const WIDTH = Number(board0) || 320;
  const awayOn = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(WIDTH - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };
  const before = new Set(((await room()).pieces || []).map((p) => p.id));
  await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
  await sleep(250);
  await page.click('button.buyrow[data-kind="aircraft"]');
  const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
    .then(() => true).catch(() => false);
  if (!armed) throw new Error("the aircraft purchase did not arm a placement");
  {
    const view = await room();
    const mine = new Set(((view.sites || []).filter((s) => s.owner === "blue")).map((s) => s.x + "," + s.y));
    const taken = new Set((view.pieces || []).map((p) => p.x + "," + p.y));
    const ports = (view.sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
    const cells = await page.evaluate(() => window.__chq.legalCells(8000));
    const scored = (cells || [])
      .filter((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y))
      .map((c) => ({ c, near: ports.length ? Math.min(...ports.map((s) => awayOn(c, s))) : 999 }));
    const inside = scored.filter((s) => s.near <= 6).sort((a, b) => b.near - a.near || b.c.x - a.c.x);
    const berth = inside[0] || scored.sort((a, b) => a.near - b.near)[0] || null;
    if (!berth) throw new Error("no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")");
    await clickCell(berth.c);
  }
  await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
    .catch(() => {});
  const plane = ((await room()).pieces || []).find((p) => !before.has(p.id));
  if (!plane) throw new Error("the aircraft never appeared on the board");
  const planeId = String(plane.id);
  mark("an aircraft is bought and berthed", true, "plane " + planeId);

  async function openAir() {
    await page.evaluate(() => {
      const el = document.querySelector("#dialogClose");
      if (el) el.click();
    }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(120);
    await page.click('.navbtn[data-dialog="air"]').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 })
      .catch(() => {});
    await sleep(150);
  }

  // What the player can actually read inside the Air panel, plus where the footer sits.
  function readPanel() {
    return page.evaluate(() => {
      const body = document.querySelector("#dialogBody");
      if (!body) return { panel: false };
      const table = body.querySelector(".airtable");
      const foots = [...body.querySelectorAll("p.dialogfoot")];
      const leaves = [...body.querySelectorAll("*")].filter((el) => el.children.length === 0
        && el.tagName !== "SCRIPT" && el.tagName !== "STYLE");
      const visible = leaves.filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const footAfterTable = foots.filter((el) => {
        if (!table) return false;
        const a = table.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        return b.top >= a.bottom - 1;
      });
      const rows = [...(table ? table.querySelectorAll(".buyrow") : [])].filter((r) => !r.classList.contains("head"));
      const away = rows.map((r) => String((r.children[2] || {}).textContent || "").trim());
      return {
        panel: true,
        hasTable: Boolean(table),
        visibleTexts: visible.map((el) => String(el.textContent || "").trim()).filter(Boolean),
        footTexts: foots.map((el) => String(el.textContent || "").trim()),
        footAfterTableCount: footAfterTable.length,
        footAfterTableFirst: footAfterTable.length ? String(footAfterTable[0].textContent || "").trim() : "",
        away,
        rowCount: rows.length,
        bodyText: String(body.textContent || ""),
      };
    });
  }

  const servedSource = await fetch(BASE + "/app.js").then((r) => r.text()).catch(() => "");
  mark("the served app.js was read", servedSource.length > 1000, servedSource.length + " chars");

  for (const [w, h] of VIEWPORTS) {
    const at = " @" + w + "x" + h;
    await page.setViewportSize({ width: w, height: h });
    await sleep(200);
    await openAir();
    const m = await readPanel();

    // (a) control: the panel drew with the berthed plane's row.
    mark("(a) the Air panel draws the aircraft table with a row" + at,
      Boolean(m.panel && m.hasTable && m.rowCount > 0),
      JSON.stringify({ hasTable: m.hasTable, rowCount: m.rowCount }));

    // (b) the new sentence, visible, exactly once, as the footer under the table.
    const newHits = (m.visibleTexts || []).filter((t) => t === NEW_SENTENCE).length;
    mark("(b) the help copy is the new sentence, visible once under the table" + at,
      newHits === 1 && m.footAfterTableFirst === NEW_SENTENCE,
      JSON.stringify({ newHits, footAfterTableFirst: m.footAfterTableFirst, want: NEW_SENTENCE }));

    // (c) the old wording is gone from what the player reads, and from the served source.
    const configInPanel = (m.visibleTexts || []).filter((t) => t.includes(CONFIG_WORD));
    const oldInPanel = (m.visibleTexts || []).filter((t) => t.includes("not this page's") || t === OLD_SENTENCE);
    mark("(c) the old wording is gone (panel text and served app.js)" + at,
      configInPanel.length === 0 && oldInPanel.length === 0
        && !m.bodyText.includes("not this page's")
        && !servedSource.includes(OLD_SENTENCE),
      JSON.stringify({ configInPanel, oldInPanel, servedSourceHasOld: servedSource.includes(OLD_SENTENCE) }));

    // (d) behaviour untouched: the Away cell still renders ready | "<n> rounds".
    const awayOk = m.away.length > 0 && m.away.every((t) => t === "ready" || /^\d+(\s|-to-)?\s?rounds?$/.test(t));
    mark("(d) the Away cell still reads ready or N rounds (behaviour untouched)" + at, awayOk, JSON.stringify(m.away));

    // (e) no page error.
    mark("(e) no page error was raised" + at, pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 4)));

    await page.screenshot({ path: path.join(OUT, "air-" + w + ".png") });
  }

  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

writeFileSync(path.join(OUT, "pb333-air-help.json"), JSON.stringify({
  base: BASE,
  tree: MUTANT ? "mutant(" + MUTANT + ")" : serverTree,
  mutant: MUTANT,
  viewports: VIEWPORTS,
  checks: evidence.length,
  failed,
  evidence,
}, null, 2));

const passes = evidence.filter((e) => e.ok).length;
console.log("");
console.log("checks: " + evidence.length + ", passed: " + passes + ", failed: " + failed + "; tree " + (MUTANT ? "mutant(" + MUTANT + ")" : serverTree));
if (MUTANT) {
  // A mutant is proved only by an arm going RED BY NAME; a leg that fails to boot also exits 1.
  const redByCopy = evidence.filter((e) => !e.ok && /^\((b|c)\)/.test(e.step));
  if (!redByCopy.length) {
    console.log("PB333_MUTANT_NOT_PROVED: the planted " + MUTANT + " red no help-copy arm");
    process.exit(1);
  }
  console.log("PB333_MUTANT_PROVED: " + redByCopy.length + " help-copy arm(s) RED by name under mutant(" + MUTANT + ")");
  process.exit(0);
}
console.log(failed === 0 ? "PB333_AIR_HELP_OK" : "PB333_AIR_HELP_RED");
process.exit(failed === 0 ? 0 : 1);
