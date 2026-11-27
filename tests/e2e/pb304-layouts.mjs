// PB-304 page leg: Layout Armies and Saved Layouts through a real page, a real socket and a real
// server at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb304-layouts.mjs                # starts its own server
//   node tests/e2e/pb304-layouts.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb304-layouts.mjs --out=<dir>
//
// Manual p.16 l.417 and p.37 l.1151-1164. Per viewport:
//   1. "Lay Out Armies" refuses a 1942 lobby with a sentence and opens a 1986 sandbox;
//   2. the sandbox strip shows Save Setup and hides the war controls (clock, Save, Resign, New);
//   3. a real board click moves a unit inside friendly territory ("Transfer."), and a click on an
//      enemy city is refused with "neutral or enemy territory";
//   4. Save Setup names the layout, lists it with a unit count and no raw piece ids, and the second
//      save on the same name asks to Overwrite;
//   5. Quit, then Play a bot on 1986 asks standard vs saved layout, and the saved row opens the war
//      with the layout's unit count;
//   6. the panels and their buttons sit inside the viewport at both widths.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
const OUT = evidenceDir("pb304-layouts", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];

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
    }, 10000);
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb304-e2e-"));
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

  for (const viewport of VIEWPORTS) {
    const tag = viewport.width + "x" + viewport.height;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });

    const room = () => page.evaluate(() => window.__chq.room());
    const toast = () => page.evaluate(() => document.querySelector("#flash")?.textContent || "");
    const note = () => page.evaluate(() => window.__chq.note());
    const texts = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => String(el.textContent || "").trim()), selector);
    const visible = (selector) => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, selector);
    const boxes = (selectors) => page.evaluate((list) => {
      const out = {};
      for (const sel of list) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        out[sel] = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom, visible: rect.width > 0 && rect.height > 0 };
      }
      return out;
    }, selectors);
    async function shot(name) {
      const file = path.join(OUT, name + "-" + tag + ".png");
      await page.screenshot({ path: file });
      return file;
    }
    async function waitRoomMode(mode, deadline = 25000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await room();
        if (cur && cur.mode === mode) return cur;
        await sleep(100);
      }
      return null;
    }
    async function waitToast(pattern, deadline = 12000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const line = await toast();
        if (pattern.test(String(line))) return String(line);
        await sleep(80);
      }
      return null;
    }
    async function clickCell(x, y) {
      const point = await page.evaluate(([cx, cy]) => window.__chq.cellToScreen(cx, cy), [x, y]);
      await page.mouse.click(point.x, point.y);
      return point;
    }

    // ---- sign in --------------------------------------------------------------------------
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const name = "e2e-pb304-" + tag + "-" + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });

    // ---- 1. the door is 1986-only -----------------------------------------------------------
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.click("#layoutBtn");
    const refused = await waitToast(/1986 wars only/);
    mark(tag + ": Lay Out Armies refuses a 1942 lobby with a sentence", Boolean(refused), String(refused));
    mark(tag + ": the refusal left the lobby, not a match", (await room()) === null);
    await shot("01-1942-refused");

    await page.selectOption('#launch select[name="era"]', "1986");
    await page.click("#layoutBtn");
    let cur = await waitRoomMode("layout");
    mark(tag + ": Lay Out Armies opens the 1986 sandbox", Boolean(cur), cur ? "mode " + cur.mode + " clock " + cur.clock : "no room");
    if (!cur) throw new Error("pb304: the sandbox never opened at " + tag);
    mark(tag + ": the sandbox clock is held at round 0", cur.clock !== "running" && Number(cur.round) === 0,
      "clock " + cur.clock + " round " + cur.round);
    mark(tag + ": the sandbox offers no intel or aid", (cur.tools || []).length === 0, JSON.stringify(cur.tools));

    // ---- 2. the strip in layout mode --------------------------------------------------------
    mark(tag + ": Save Setup is on the strip in layout mode", await visible("#layoutSaveBtn"));
    mark(tag + ": the war controls are hidden in layout mode",
      !(await visible("#clockBtn")) && !(await visible("#saveBtn")) && !(await visible("#resignBtn")) && !(await visible("#newBtn")),
      JSON.stringify({ clock: await visible("#clockBtn"), save: await visible("#saveBtn"), resign: await visible("#resignBtn"), next: await visible("#newBtn") }));
    // The banner and the speed suffix are war furniture. A pregame sandbox has no war to pause and no
    // clock to hold, so neither may be painted here - asserted, not screenshotted, so it survives a
    // re-cut (frodo 10033 / pm 10035 item 3).
    const furniture = await page.evaluate(() => {
      const banner = document.getElementById("pauseBanner");
      const readout = document.getElementById("speedReadout");
      const ink = banner ? getComputedStyle(banner).visibility : null;
      return {
        paused: banner ? banner.classList.contains("paused") : null,
        ink,
        bannerHidden: banner ? banner.classList.contains("hidden") : null,
        readout: readout ? readout.textContent : null,
        mode: document.body.classList.contains("in-match") ? "in-match" : "lobby",
      };
    });
    mark(tag + ": the pause banner is not painted in layout mode",
      furniture.paused === false && furniture.ink === "hidden",
      JSON.stringify(furniture));
    mark(tag + ": the speed strip carries no held suffix in layout mode",
      !/\u00b7\s*held/.test(String(furniture.readout || "")),
      String(furniture.readout));
    await shot("02-sandbox");

    // ---- 3. a real board move, and the hostile refusal --------------------------------------
    const blueLand = (cur.pieces || []).find((p) => p.side === cur.you && p.domain === "land");
    if (!blueLand) throw new Error("pb304: the sandbox has no land unit to move at " + tag);
    await clickCell(blueLand.x, blueLand.y);
    await sleep(250);
    let moved = null;
    for (const [dx, dy] of DIRS) {
      const to = { x: blueLand.x + dx, y: blueLand.y + dy };
      await page.evaluate(() => { const el = document.querySelector("#flash"); if (el) el.textContent = ""; });
      await clickCell(to.x, to.y);
      const line = await waitToast(/Transfer\.|refus|territory|water|wasteland|already|holds/i, 2500);
      const now = await room();
      const piece = now && (now.pieces || []).find((p) => p.id === blueLand.id);
      if (piece && Number(piece.x) === Number(to.x) && Number(piece.y) === Number(to.y)) {
        moved = { to, line };
        break;
      }
      // A refusal clears the selection, so re-select before the next attempt.
      await clickCell(blueLand.x, blueLand.y);
      await sleep(150);
    }
    mark(tag + ": a click moves a unit inside friendly territory", Boolean(moved), moved ? JSON.stringify(moved.to) : "no friendly neighbour accepted a transfer");
    if (!moved) throw new Error("pb304: no friendly move landed on the page at " + tag);

    const redSite = (cur.sites || []).find((site) => site.owner === "red");
    if (!redSite) throw new Error("pb304: the board carries no red site at " + tag);
    const movedPiece = (await room()).pieces.find((p) => p.id === blueLand.id);
    await clickCell(movedPiece.x, movedPiece.y);
    await sleep(200);
    await page.evaluate(() => { const el = document.querySelector("#flash"); if (el) el.textContent = ""; });
    await clickCell(redSite.x, redSite.y);
    const hostileLine = await waitToast(/neutral or enemy territory/, 6000);
    const after = (await room()).pieces.find((p) => p.id === blueLand.id);
    mark(tag + ": an enemy city is refused with the territory sentence", Boolean(hostileLine), String(hostileLine));
    mark(tag + ": the refused unit did not move", after && Number(after.x) === Number(movedPiece.x) && Number(after.y) === Number(movedPiece.y),
      JSON.stringify({ from: [movedPiece.x, movedPiece.y], now: after && [after.x, after.y] }));
    await shot("03-hostile-refused");

    // ---- 4. Save Setup ----------------------------------------------------------------------
    await page.click("#layoutSaveBtn");
    await page.waitForSelector("#layoutSavePanel:not(.hidden)", { timeout: 8000 });
    const panelBox = (await boxes(["#layoutSavePanel", "#layoutGo", "#layoutName"]));
    const inside = (box) => box && box.visible && box.x >= 0 && box.y >= 0 && box.right <= viewport.width + 0.5 && box.bottom <= viewport.height + 0.5;
    mark(tag + ": the Save Setup panel and its controls sit inside the viewport",
      inside(panelBox["#layoutSavePanel"]) && inside(panelBox["#layoutGo"]) && inside(panelBox["#layoutName"]),
      JSON.stringify(panelBox));
    await page.fill("#layoutName", "Page Line");
    await page.click("#layoutGo");
    const savedLine = await waitToast(/Saved layout "Page Line" with \d+ units?/);
    mark(tag + ": Save Setup writes a named layout", Boolean(savedLine), String(savedLine));
    const unitsSaved = Number((String(savedLine).match(/with (\d+) units?/) || [])[1] || 0);
    const savedTitles = await texts("#layoutExisting .slottitle");
    const savedMeta = await texts("#layoutExisting .slotmeta");
    mark(tag + ": the layout is listed on the account", savedTitles.includes("Page Line"), JSON.stringify(savedTitles));
    mark(tag + ": no layout line carries a raw piece id", !savedTitles.concat(savedMeta).some((line) => /(blue|red):[a-z]/.test(line)),
      JSON.stringify(savedMeta));
    await shot("04-layout-saved");

    // The overwrite confirmation (the panel closed on the successful save).
    await page.click("#layoutSaveBtn");
    await page.waitForSelector("#layoutSavePanel:not(.hidden)", { timeout: 8000 });
    await page.fill("#layoutName", "page line");
    await page.click("#layoutGo");
    await page.waitForSelector("#layoutConfirm:not(.hidden)", { timeout: 8000 });
    const confirmText = String(await page.textContent("#layoutConfirmText"));
    mark(tag + ": a duplicate layout name asks before overwriting", /already exists/.test(confirmText), confirmText);
    await shot("05-layout-overwrite-confirm");
    await page.click("#layoutOverwrite");
    const overLine = await waitToast(/Overwrote saved layout "page line" with \d+ units?/);
    mark(tag + ": Overwrite replaces the same layout", Boolean(overLine), String(overLine));
    const panelClosed = await page.evaluate(() => document.querySelector("#layoutSavePanel").classList.contains("hidden"));
    mark(tag + ": the Save Setup panel closes on success", panelClosed);

    // ---- 5. Quit, then the 1986 setup question ---------------------------------------------
    await page.click("#quitBtn");
    mark(tag + ": Quit asks before leaving the layout", dialogs.some((line) => /Quit this game/.test(line)), JSON.stringify(dialogs));
    await page.waitForFunction(() => window.__chq.room() === null, null, { timeout: 12000 });
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForSelector("#setupPanel:not(.hidden)", { timeout: 12000 });
    const setupTitle = await texts("#setupList .slottitle");
    mark(tag + ": a new 1986 war asks standard vs saved layout", (await visible("#setupStandard")) && setupTitle.some((line) => line.toLowerCase() === "page line"),
      JSON.stringify(setupTitle));
    const setupBox = (await boxes(["#setupPanel", "#setupStandard"]));
    mark(tag + ": the setup question sits inside the viewport", inside(setupBox["#setupPanel"]) && inside(setupBox["#setupStandard"]), JSON.stringify(setupBox));
    await shot("06-setup-question");
    await page.click('#setupList .slotrow');
    cur = await waitRoomMode("bot");
    mark(tag + ": the saved layout opens the 1986 war", Boolean(cur), cur ? "mode " + cur.mode : "no room");
    if (cur) {
      const blueCount = (cur.pieces || []).filter((p) => p.side === "blue" && p.domain !== "sat").length;
      mark(tag + ": the war opens with the layout's units", blueCount === unitsSaved,
        JSON.stringify({ blueCount, unitsSaved, note: cur.note }));
      mark(tag + ": the war seats a computer opponent", Boolean(cur.bot && cur.bot.level), JSON.stringify(cur.bot));
      mark(tag + ": the strip's war controls are back", await visible("#clockBtn") && await visible("#saveBtn"));
    }
    await shot("07-layout-war");

    mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
    await context.close();
  }

  console.log("pb304 page leg: " + evidence.filter((row) => row.ok).length + " passed / " + failed + " failed");
  const verdict = { name: "pb304-layouts", base: BASE, mode: GIVEN ? "url" : "self-hosted", viewports: VIEWPORTS, failed, checks: evidence };
  await import("node:fs").then((fs) => fs.writeFileSync(path.join(OUT, "pb304-verdict" + (GIVEN ? "-url" : "") + ".json"), JSON.stringify(verdict, null, 2)));
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
  }
  process.exitCode = failed ? 1 : 0;
}
