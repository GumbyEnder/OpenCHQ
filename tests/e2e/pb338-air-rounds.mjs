// PB-338 page leg: every mission button in the Air dialog shows the aircraft's away rounds in
// VISIBLE text ("Strike · 8"), the figure is the seat payload's own missions[].rounds, and the
// widest cluster still fits the Missions column at 1024, 1280 and 1440.
//
// The defect (PM 10488 §2, base 8c7f624): the dialog's footer promises "the rounds shown", but the
// Air door printed the mission NAME only - the duration lived in the hover title - and Paradrop's
// title is the rule's sentence, so its button carried no duration anywhere on screen.
//
//   node tests/e2e/pb338-air-rounds.mjs                # starts its own server from this tree
//   node tests/e2e/pb338-air-rounds.mjs --url=<base>   # a running server (the base control: RED)
//   node tests/e2e/pb338-air-rounds.mjs --out=<dir>
//
// Measured through a real page, a real socket, a real server, in a launched 1986 bot match with a
// bought, berthed aircraft, at each of 1024x768, 1280x800 and 1440x900:
//   (a) parity: for EVERY mission the seat payload lists, the button's visible text is exactly
//       "<label> · <rounds>" - the number read off room().seat.air[plane].missions, not off config
//       and not off this file. A door that prints a different number, or drops one, reds by name;
//   (b) the number is PAINTED, not titled: the button's own box has width and height, its
//       computed display/visibility are not none/hidden, and the trailing digit group is text
//       content (so a title-only figure cannot pass);
//   (c) Paradrop specifically: its visible rounds figure is the drop's own missions[].rounds AND is
//       the same number its hover sentence names ("goes unready for N rounds"), and equals config's
//       air.strikeRounds - a hard-coded 8 would agree only by luck and reds against the 4 of a CAP
//       in (a);
//   (d) no clipping: each button's scrollWidth <= clientWidth + 1, its rect lies inside the
//       Missions cell to 0.5 px, no two buttons overlap, the cell is not a scroll window, and the
//       Air table / dialog body do not scroll horizontally - the row grows in WRAPPED PILLS;
//   (e) each pill is ONE line (height below a single line's ceiling), so the duration cannot be
//       split onto a second line inside its own pill and read as a different control.
//
// A screenshot of the dialog and a 1:1 crop of the plane's row are written per viewport.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const OUT = evidenceDir("pb338-air-rounds", argOf("out"));
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [[1024, 768], [1280, 800], [1440, 900]];
const MARK = " \u00b7 ";
const INSIDE_TOLERANCE = 0.5;
// One 11 px pill: ~15 px line box + 2 px padding + 2 px border. 26 is comfortably one line and
// comfortably under the ~34 px a two-line label needs.
const ONE_LINE_CEILING = 26;

const AIR = JSON.parse(readFileSync(path.join(root, "config/game.json"), "utf8")).air;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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

const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail).slice(0, 1600) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 420)));
  writeFileSync(path.join(OUT, "pb338-air-rounds.json"), JSON.stringify({ evidence }, null, 2));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb338-"));
let server = null;
let browser = null;
let BASE = GIVEN;

async function main() {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("a given server answers", true, BASE);
  }
  const version = (await (await fetch(BASE + "/api/version")).text()).trim();
  console.log("served", version);

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());

  async function shot(name, clip) {
    const file = path.join(OUT, name + ".png");
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
    return file;
  }

  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (point && point.x >= 2 && point.y >= 2 && point.x <= vp.width - 2 && point.y <= vp.height - 2) {
      await page.mouse.click(point.x, point.y);
      await sleep(160);
      return true;
    }
    await page.click("#camFit").catch(() => {});
    await sleep(250);
    const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    if (!again) return false;
    await page.mouse.click(again.x, again.y);
    await sleep(160);
    return true;
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const name = "e2e-pb338-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 30000, polling: 100 });
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
  const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 8000, polling: 100 })
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
  await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 25000, polling: 100 }).catch(() => {});
  const afterBuy = await room();
  const plane = (afterBuy.pieces || []).find((p) => !before.has(p.id));
  if (!plane) throw new Error("the aircraft never appeared on the board");
  const planeId = plane.id;
  const briefAtBuy = ((afterBuy.seat || {}).air || []).find((p) => String(p.id) === String(planeId)) || null;
  mark("an aircraft is bought and berthed (READY) with its missions[] briefing", Boolean(briefAtBuy) && briefAtBuy.ready === true,
    JSON.stringify(briefAtBuy && { id: briefAtBuy.id, ready: briefAtBuy.ready, missions: briefAtBuy.missions.map((m) => m.mode + ":" + m.rounds) }));

  // ---------------------------------------------------------------- the Air menu, measured
  async function openAirMenu() {
    await page.evaluate(() => { const el = document.querySelector("#dialogClose"); if (el) el.click(); }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(140);
    await page.click('.navbtn[data-dialog="air"]').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 10000, polling: 100 }).catch(() => {});
    await sleep(140);
  }

  // One read of the frame: the seat's missions[] for THIS plane beside the row as painted.
  async function measure() {
    return page.evaluate((id) => {
      const rr2 = (n) => Math.round(n * 100) / 100;
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { left: rr2(r.left), right: rr2(r.right), top: rr2(r.top), bottom: rr2(r.bottom), width: rr2(r.width), height: rr2(r.height) };
      };
      const seat = (window.__chq.room().seat || {}).air || [];
      const briefing = seat.find((p) => String(p.id) === String(id)) || null;
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || "") === String(id); });
      const dialogBody = document.getElementById("dialogBody");
      const table = document.querySelector("#dialogBody .airtable");
      if (!row) return { briefing, row: null, dialogBody: dialogBody ? { scrollWidth: dialogBody.scrollWidth, clientWidth: dialogBody.clientWidth } : null };
      const away = row.children[2] || null;
      const cellEl = row.children[3] || null;
      const cell = cellEl ? rectOf(cellEl) : null;
      const buttons = [...(cellEl ? cellEl.querySelectorAll("button") : [])].map((b) => {
        const cs = getComputedStyle(b);
        const r = rectOf(b);
        const range = document.createRange();
        range.selectNodeContents(b);
        const text = range.getBoundingClientRect();
        return {
          text: (b.textContent || "").trim(),
          title: b.getAttribute("title") || "",
          disabled: Boolean(b.disabled),
          rect: r,
          textWidth: rr2(text.width),
          display: cs.display,
          visibility: cs.visibility,
          scrollWidth: b.scrollWidth,
          clientWidth: b.clientWidth,
          inside: Boolean(cell) && r.left >= cell.left - 0.5 && r.right <= cell.right + 0.5 && r.top >= cell.top - 0.5 && r.bottom <= cell.bottom + 0.5,
          spillLeft: cell ? rr2(Math.max(0, cell.left - r.left)) : null,
        };
      });
      return {
        briefing: briefing ? { id: briefing.id, ready: briefing.ready, rounded: briefing.roundsLeft,
          missions: briefing.missions.map((m) => ({ mode: m.mode, label: m.label, rounds: m.rounds })) } : null,
        row: { rect: rectOf(row) },
        cell,
        cellScrollWidth: cellEl ? cellEl.scrollWidth : null,
        cellClientWidth: cellEl ? cellEl.clientWidth : null,
        away: away ? (away.textContent || "").trim() : null,
        buttons,
        table: table ? { scrollWidth: table.scrollWidth, clientWidth: table.clientWidth } : null,
        dialogBody: dialogBody ? { scrollWidth: dialogBody.scrollWidth, clientWidth: dialogBody.clientWidth } : null,
        footer: (() => {
          const ps = [...document.querySelectorAll("#dialogBody .dialogfoot")];
          return ps.length ? String(ps[ps.length - 1].textContent || "").trim() : "";
        })(),
      };
    }, planeId);
  }

  for (const [w, h] of VIEWPORTS) {
    const tag = w + "x" + h;
    await page.setViewportSize({ width: w, height: h });
    await sleep(220);
    await openAirMenu();
    const m = await measure();
    const at = " [" + tag + "]";
    const dialogShot = await shot("pb338-" + tag + "-air-dialog");
    const rowCrop = await shot("pb338-" + tag + "-row", { x: 0, y: Math.max(0, (m.row ? m.row.rect.top : 0) - 6), width: w, height: 120 });
    mark("(0)" + at + " the Air dialog paints this plane's row with no page error",
      Boolean(m && m.row && m.buttons.length > 0) && pageErrors.length === 0,
      JSON.stringify({ row: Boolean(m && m.row), buttons: m && m.buttons.length, errors: pageErrors }));
    if (!m || !m.row || !m.buttons.length) continue;

    const missions = (m.briefing && m.briefing.missions) || [];
    // (a) parity: every mission the seat payload lists, in the seat payload's order, printed as
    // "<label> · <rounds>" - the visible text carries THAT mission's own figure.
    const want = missions.map((mission) => mission.label + MARK + mission.rounds);
    const got = m.buttons.map((b) => b.text);
    mark("(a)" + at + " every mission button prints '<label> · <rounds>' from the seat payload's missions[]",
      want.length > 0 && want.length === got.length && want.every((text, i) => got[i] === text),
      JSON.stringify({ want, got, modes: missions.map((x) => x.mode) }));

    // (b) the figure is painted text, not a title: the pill has a box, is not display:none, and its
    // own text range covers the numbers it claims.
    const unpainted = m.buttons.filter((b) => !(b.rect.width > 0 && b.rect.height > 0) || b.display === "none" || b.visibility === "hidden");
    mark("(b)" + at + " every mission pill is painted (a box, not a display:none or hidden span)",
      unpainted.length === 0, JSON.stringify(unpainted.map((b) => ({ text: b.text, display: b.display, visibility: b.visibility, w: b.rect.width }))));

    // (c) Paradrop: the visible figure is the drop's own missions[].rounds, and it is the same
    // number its hover sentence names. Config's air.strikeRounds is quoted as the value the server
    // charged, so a page literal and a config change cannot both pass.
    const drop = missions.find((x) => x.mode === "drop") || null;
    const dropButton = m.buttons.find((b) => /^Paradrop\b/.test(b.text)) || null;
    const dropShown = dropButton ? Number((dropButton.text.split("\u00b7")[1] || "").trim()) : NaN;
    const dropTitled = dropButton ? Number((String(dropButton.title).match(/goes unready for (\d+)/i) || [])[1]) : NaN;
    mark("(c)" + at + " Paradrop's visible rounds are its missions[].rounds, and its title names the same number",
      Boolean(drop) && Boolean(dropButton) && dropShown === Number(drop.rounds) && dropTitled === Number(drop.rounds)
        && dropShown === Number(AIR.strikeRounds),
      JSON.stringify({ drop, visible: dropButton && dropButton.text, dropShown, dropTitled, configStrikeRounds: AIR.strikeRounds,
        title: dropButton && String(dropButton.title).slice(0, 180) }));

    // (d) nothing clips and nothing spills: the pills fit their own text, sit inside the Missions
    // cell, do not overlap, and neither the cell, the table nor the dialog body scrolls sideways.
    const clipped = m.buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.text + " " + b.scrollWidth + ">" + b.clientWidth);
    const outside = m.buttons.filter((b) => !b.inside).map((b) => b.text + " spill-left " + b.spillLeft);
    const overlaps = [];
    for (let i = 0; i < m.buttons.length; i += 1) {
      for (let j = i + 1; j < m.buttons.length; j += 1) {
        const a = m.buttons[i].rect;
        const b = m.buttons[j].rect;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 0.5 && oy > 0.5) overlaps.push(m.buttons[i].text + "/" + m.buttons[j].text + " " + r2(ox) + "x" + r2(oy));
      }
    }
    const cellFits = m.cellScrollWidth === null || m.cellScrollWidth <= m.cellClientWidth + 1;
    const tableFits = Boolean(m.table) && m.table.scrollWidth <= m.table.clientWidth + 1;
    const bodyFits = Boolean(m.dialogBody) && m.dialogBody.scrollWidth <= m.dialogBody.clientWidth + 1;
    mark("(d)" + at + " no pill clips its own label, spills out of the Missions cell, or overlaps a neighbour",
      clipped.length === 0 && outside.length === 0 && overlaps.length === 0,
      JSON.stringify({ clipped, outside, overlaps, cell: m.cell }));
    mark("(d)" + at + " the row overflows nothing: the cell, the table and the dialog body do not scroll sideways",
      cellFits && tableFits && bodyFits,
      JSON.stringify({ cell: { scrollWidth: m.cellScrollWidth, clientWidth: m.cellClientWidth }, table: m.table, dialogBody: m.dialogBody }));

    // (e) one line per pill: the duration cannot be split onto a second row inside its own pill.
    const tall = m.buttons.filter((b) => b.rect.height > ONE_LINE_CEILING).map((b) => b.text + " h=" + b.rect.height);
    mark("(e)" + at + " each pill reads as ONE line (height <= " + ONE_LINE_CEILING + " px)",
      tall.length === 0, JSON.stringify({ tall, heights: m.buttons.map((b) => ({ text: b.text, h: b.rect.height })) }));

    // The footer's promise, now true: the dialog says the rounds are shown, and they are.
    mark("(f)" + at + " the dialog's own footer ('the rounds shown') is satisfied by the painted rows",
      /rounds shown/i.test(m.footer) && m.buttons.every((b) => /(\d+)\s*$/.test(b.text)),
      JSON.stringify({ footer: m.footer, painted: got }));

    mark("evidence" + at, true, dialogShot + " + " + rowCrop);
  }

  await browser.close();
  browser = null;
  if (server) server.kill("SIGTERM");
  const total = evidence.length;
  console.log((failed === 0 ? "PB338_AIR_ROUNDS_OK " : "PB338_AIR_ROUNDS_RED ") + (total - failed) + " passed / " + failed +
    " failed of " + total + " — served " + version.slice(0, 80) + " — OUT " + OUT);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("PB338_LEG_FAILED", err);
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  if (server) server.kill("SIGKILL");
  process.exit(1);
});
