// PB-298 page leg: at READY, every mission button sits fully inside the Air table's 150 px
// Missions column, and nothing paints over the AWAY cell.
//
// The reported defect (PM 9864 §4, from game 9861): the four mission buttons overflow the
// 150 px Air column and paint over the AWAY cell. `.airmissions` is a flex row with
// `justify-content: flex-end`, so an over-budget cluster spills LEFTWARD - over the cell it
// is not allowed to touch - and a button's box is not inside its own cell any more, so a
// click at the AWAY cell's centre can land on "Scramble (CAP)".
//
//   node tests/e2e/pb298-airmissions-fit.mjs                # starts its own server
//   node tests/e2e/pb298-airmissions-fit.mjs --url=<base>   # a running server
//   node tests/e2e/pb298-airmissions-fit.mjs --out=<dir>
//
// Measured through a real page, a real socket and a real server, at 1280x800 and 1024x768:
//   1. control: the READY row lists all four missions ("Scramble (CAP)", Strike, Bomb, Transfer)
//      and all are enabled - so a short menu cannot pass this leg by rendering fewer buttons;
//   2. every button's rect lies inside the Missions cell's box (0.5 px), on all four sides;
//   3. no two button rects overlap (an overlapped pair is unclickable, not merely ugly);
//   4. the AWAY cell is the top-most element at its own centre (elementsFromPoint) - the
//      reported symptom, measured as pixels;
//   5. the buttons are not shrunk below their text: each button's scrollWidth <= clientWidth + 1,
//      so "wrap or stack" cannot be faked by squeezing the labels;
//   6. the Missions cell is not a scroll window hiding buttons (scrollWidth === clientWidth).
// A screenshot of the dialog and a 1:1 crop of the row are written per viewport.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const ERA = "1986";
const OUT = evidenceDir("pb298-page", argOf("out"));
mkdirSync(OUT, { recursive: true });

// The two viewports the AC names. The 150 px column is fixed, so both must hold.
const VIEWPORTS = [[1280, 800], [1024, 768]];
const CAP = "Scramble (CAP)";
const OTHERS = ["Strike", "Bomb", "Transfer"];
const INSIDE_TOLERANCE = 0.5;

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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb298-"));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());

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
  const name = "e2e-pb298-" + Date.now().toString(36).slice(-8);
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

  // ---------------------------------------------------------------- buy and place an aircraft
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
    const pick = berth ? berth.c : null;
    if (!pick) throw new Error("no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")");
    await clickCell(pick);
  }
  await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
    .catch(() => {});
  const afterBuy = await room();
  const plane = (afterBuy.pieces || []).find((p) => !before.has(p.id));
  if (!plane) throw new Error("the aircraft never appeared on the board");
  const planeId = plane.id;
  mark("an aircraft is bought and berthed (READY)", true, "plane " + planeId);

  // ---------------------------------------------------------------- the Air menu, measured
  async function openAirMenu() {
    // Close whatever panel is open first: the nav button opens the dialog it names, but an
    // existing dialog body would be re-rendered for another door.
    await page.evaluate(() => {
      const el = document.querySelector("#dialogClose");
      if (el) el.click();
    }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(120);
    await page.click('.navbtn[data-dialog="air"]').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 })
      .catch(() => {});
    await sleep(120);
  }

  // One read of the row: labels, then the geometry the AC names.
  async function measureRow() {
    return page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || (c.textContent || "").trim()) === String(id); });
      if (!row) return null;
      const away = row.children[2] || null;
      const cellEl = row.children[3] || null;
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const cell = cellEl ? rectOf(cellEl) : null;
      const buttons = [...(cellEl ? cellEl.querySelectorAll("button") : [])].map((b) => {
        const r = rectOf(b);
        return {
          label: (b.textContent || "").trim(),
          disabled: Boolean(b.disabled),
          rect: r,
          scrollWidth: b.scrollWidth,
          clientWidth: b.clientWidth,
          inside: Boolean(cell) &&
            r.left >= cell.left - 0.5 && r.right <= cell.right + 0.5 &&
            r.top >= cell.top - 0.5 && r.bottom <= cell.bottom + 0.5,
          spillLeft: cell ? Math.max(0, cell.left - r.left) : null,
        };
      });
      let awayTop = null;
      let awayOnTop = false;
      let awayRect = null;
      if (away) {
        const r = rectOf(away);
        awayRect = r;
        const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0] || null;
        awayTop = top ? top.tagName + (top.className ? "." + String(top.className).split(" ").join(".") : "") : null;
        awayOnTop = Boolean(top) && (top === away || away.contains(top));
      }
      return {
        rowRect: rectOf(row),
        cell,
        cellScrollWidth: cellEl ? cellEl.scrollWidth : null,
        cellClientWidth: cellEl ? cellEl.clientWidth : null,
        buttons,
        away: away ? { text: (away.textContent || "").trim(), rect: awayRect, topmost: awayTop, onTop: awayOnTop } : null,
      };
    }, planeId);
  }

  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(200);
    await openAirMenu();
    const m = await measureRow();
    const tag = w + "x" + h;
    const dialogShot = await shot("pb298-" + tag + "-air-dialog");
    mark("[" + tag + "] the Air dialog opens and the READY row renders", Boolean(m) && m.buttons.length > 0, Boolean(m) ? m.buttons.length + " buttons" : "no row");
    if (!m) continue;

    // 1. control: the full READY menu, all enabled.
    const labels = m.buttons.map((b) => b.label);
    const missing = [CAP].concat(OTHERS).filter((l) => !labels.includes(l));
    const greyed = m.buttons.filter((b) => b.disabled).map((b) => b.label);
    mark("[" + tag + "] the READY row lists all four missions", missing.length === 0, "labels " + JSON.stringify(labels));
    mark("[" + tag + "] the READY missions are all enabled (the control arm)", greyed.length === 0, "disabled " + JSON.stringify(greyed));

    // 2. every button inside its cell, 0.5 px.
    const outside = m.buttons.filter((b) => !b.inside).map((b) => b.label + " spill-left " + b.spillLeft.toFixed(2));
    mark("[" + tag + "] every mission button's rect lies inside the " + Math.round(m.cell.width) + " px Missions cell (" + INSIDE_TOLERANCE + " px)",
      outside.length === 0,
      "cell L " + m.cell.left.toFixed(2) + "..R " + m.cell.right.toFixed(2) + "; outside " + JSON.stringify(outside));

    // The reported symptom, in numbers: how far the cluster spills left of its own column.
    const worstSpill = Math.max(0, ...m.buttons.map((b) => Number(b.spillLeft) || 0));
    mark("[" + tag + "] the mission cluster does not spill left of its column", worstSpill <= INSIDE_TOLERANCE,
      "worst spill " + worstSpill.toFixed(2) + " px");

    // 3. no two button rects overlap.
    const overlaps = [];
    for (let i = 0; i < m.buttons.length; i++) {
      for (let j = i + 1; j < m.buttons.length; j++) {
        const a = m.buttons[i].rect;
        const b = m.buttons[j].rect;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 0.5 && oy > 0.5) overlaps.push(m.buttons[i].label + "/" + m.buttons[j].label + " " + ox.toFixed(2) + "x" + oy.toFixed(2));
      }
    }
    mark("[" + tag + "] no two mission buttons overlap", overlaps.length === 0, JSON.stringify(overlaps));

    // 4. the AWAY cell is the top-most element at its own centre.
    mark("[" + tag + "] the AWAY cell is the top-most element at its own centre",
      Boolean(m.away) && m.away.onTop === true,
      "away " + JSON.stringify(m.away && m.away.text) + " topmost " + JSON.stringify(m.away && m.away.topmost));

    // 5. buttons are not shrunk below their text.
    const clipped = m.buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.label + " " + b.scrollWidth + ">" + b.clientWidth);
    mark("[" + tag + "] no mission button is shrunk below its own text", clipped.length === 0, "clipped " + JSON.stringify(clipped));

    // 6. the cell is not a scroll window.
    mark("[" + tag + "] the Missions cell is not a scroll window",
      m.cellScrollWidth === null || m.cellScrollWidth <= m.cellClientWidth + 1,
      "scrollWidth " + m.cellScrollWidth + " / clientWidth " + m.cellClientWidth);

    const row = {
      x: Math.max(0, Math.floor(m.rowRect.left)),
      y: Math.max(0, Math.floor(m.rowRect.top)),
      width: Math.max(1, Math.ceil(m.rowRect.width)),
      height: Math.max(1, Math.ceil(m.rowRect.height)),
    };
    const crop = path.join(OUT, "pb298-" + tag + "-row.png");
    await page.screenshot({ path: crop, clip: row }).catch(() => {});
    mark("[" + tag + "] evidence: dialog screenshot + 1:1 row crop", true, dialogShot + " + " + crop);
  }

  mark("no page error", pageErrors.length === 0, pageErrors.join(" | "));
  await context.close();
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGKILL");
  writeFileSync(path.join(OUT, "pb298-page.json"), JSON.stringify({ base: BASE, evidence }, null, 2));
  console.log("");
  console.log("pb298 page leg: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);
  process.exit(failed ? 1 : 0);
}
