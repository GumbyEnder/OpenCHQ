// PB-308 page leg: a layout sandbox must not offer War as the way out, at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb308-layout-copy.mjs                # starts its own server
//   node tests/e2e/pb308-layout-copy.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb308-layout-copy.mjs --out=<dir>
//
// After PB-307 the wire refuses `resume_war` in a layout ("This is a layout, not a war. Save the
// setup or leave it."). This leg measures the page copy and control visibility on the real page:
//   1. Lay Out Armies opens a 1986 sandbox;
//   2. the lobby's Resume Saved War is unreachable there (lobby display:none, #resumeWarBtn 0x0,
//      #slotsPanel hidden) - measured, not assumed;
//   3. the War panel paints no Begin Hostilities, no Run/Hold clock, no cold-war row, no Peacetime
//      paragraph, and its hint names no clock and no way out; the readout and Leave remain;
//   4. Save Setup still writes the layout, and Leave still returns to the lobby;
//   5. the same War panel in a real 1986 war still paints Begin Hostilities and the clock (the
//      absence in a layout is the fix, not a broken panel).

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
const OUT = evidenceDir("pb308-layout-copy", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const LAYOUT_HINT = "Who holds which side in this layout.";

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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb308-e2e-"));
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
    const texts = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => String(el.textContent || "").trim()), selector);
    const waitTexts = async (selector, deadline = 2500) => {
      const start = Date.now();
      let seen = [];
      while (Date.now() - start < deadline) {
        seen = await texts(selector);
        if (seen.length) return seen;
        await sleep(50);
      }
      return seen;
    };
    const waitToast = async (pattern, deadline = 12000) => {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const line = await toast();
        if (pattern.test(String(line))) return String(line);
        await sleep(80);
      }
      return null;
    };
    const waitRoomMode = async (mode, deadline = 25000) => {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await room();
        if (cur && cur.mode === mode) return cur;
        await sleep(100);
      }
      return null;
    };
    async function shot(name) {
      const file = path.join(OUT, name + "-" + tag + ".png");
      await page.screenshot({ path: file });
      return file;
    }
    async function warPanel() {
      await page.click('.navbtn[data-dialog="war"]');
      await page.waitForSelector("#dialog:not(.hidden)", { timeout: 8000 });
      await sleep(150);
      return page.evaluate(() => {
        const body = document.getElementById("dialogBody");
        return {
          title: document.getElementById("dialogTitle").textContent,
          hint: document.getElementById("dialogHint").textContent,
          bodyText: String(body.textContent || ""),
          buttons: [...body.querySelectorAll("button")].map((b) => ({ label: b.textContent, disabled: b.disabled, title: b.title })),
          rows: [...body.querySelectorAll("dt")].map((d) => d.textContent),
        };
      });
    }
    async function closeDialog() {
      await page.keyboard.press("Escape");
      await sleep(150);
    }

    // ---- sign in --------------------------------------------------------------------------
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const name = "e2e-pb308-" + tag + "-" + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });

    // ---- 1. open the layout sandbox -------------------------------------------------------
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.click("#layoutBtn");
    let cur = await waitRoomMode("layout");
    mark(tag + ": Lay Out Armies opens the 1986 sandbox", Boolean(cur),
      cur ? "mode " + cur.mode + " clock " + cur.clock + " round " + cur.round : "no room");
    if (!cur) throw new Error("pb308: the sandbox never opened at " + tag);
    mark(tag + ": the sandbox clock is held at round 0", cur.clock !== "running" && Number(cur.round) === 0,
      "clock " + cur.clock + " round " + cur.round);

    // ---- 2. Resume Saved War is unreachable from a layout (measured) ----------------------
    const reach = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { absent: true };
        const rect = el.getBoundingClientRect();
        return { w: rect.width, h: rect.height, display: getComputedStyle(el).display };
      };
      return {
        lobby: box("#lobby"),
        resume: box("#resumeWarBtn"),
        slots: box("#slotsPanel"),
        lobbyCopyOffered: [...document.querySelectorAll("#lobby button, #lobby .fine")].some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }),
      };
    });
    mark(tag + ": the lobby offers nothing while a layout is open",
      reach.lobby.display === "none" && reach.lobbyCopyOffered === false, JSON.stringify(reach));
    mark(tag + ": Resume Saved War is not clickable in a layout",
      reach.resume.w === 0 && reach.resume.h === 0 && reach.resume.display !== "none", JSON.stringify(reach.resume));
    mark(tag + ": the slots panel stays closed in a layout",
      reach.slots.display === "none", JSON.stringify(reach.slots));
    await shot("01-layout");

    // ---- 3. the War panel offers no war ------------------------------------------------
    let panel = await warPanel();
    mark(tag + ": the War panel opens in the sandbox", panel.title === "War" && panel.hint === LAYOUT_HINT,
      JSON.stringify({ title: panel.title, hint: panel.hint }));
    mark(tag + ": the War panel paints no Begin Hostilities",
      !/Begin Hostilities/.test(panel.bodyText) && !panel.buttons.some((b) => /Begin Hostilities/.test(b.label)),
      JSON.stringify(panel.buttons));
    mark(tag + ": the War panel paints no Run/Hold clock",
      !/Run the clock|Hold the clock/.test(panel.bodyText) && !panel.buttons.some((b) => /clock/.test(b.label)),
      JSON.stringify(panel.buttons));
    mark(tag + ": the War panel paints no cold-war/cease-fire row and no Peacetime paragraph",
      !/Cold war|Cease-fire|Peacetime/.test(panel.bodyText), panel.bodyText);
    mark(tag + ": the War hint names no clock and no way out",
      !/way out|hostilit|resume|the clock/i.test(panel.hint), panel.hint);
    mark(tag + ": the War panel keeps the side readout and Leave",
      ["Blue", "Red", "You", "Era", "Clock", "Round"].every((row) => panel.rows.includes(row))
        && panel.buttons.length === 1 && panel.buttons[0].label === "Leave the match",
      JSON.stringify({ rows: panel.rows, buttons: panel.buttons }));
    mark(tag + ": the War panel carries no raw piece id",
      !/(blue|red):[a-z]/.test(panel.bodyText), "");
    await shot("02-war-panel-layout");
    await closeDialog();

    // ---- 4. Save Setup and Leave still work ---------------------------------------------
    await page.click("#layoutSaveBtn");
    await page.waitForSelector("#layoutSavePanel:not(.hidden)", { timeout: 8000 });
    await page.fill("#layoutName", "PB308 Line");
    await page.click("#layoutGo");
    const savedLine = await waitToast(/Saved layout "PB308 Line" with \d+ units?/);
    mark(tag + ": Save Setup still writes the layout", Boolean(savedLine), String(savedLine));
    const titles = await waitTexts("#layoutExisting .slottitle");
    mark(tag + ": the saved layout is listed", titles.includes("PB308 Line"), JSON.stringify(titles));

    panel = await warPanel();
    await page.click('#dialogBody button');
    await page.waitForFunction(() => window.__chq.room() === null, null, { timeout: 12000 });
    mark(tag + ": Leave returns to the lobby", true, "room null");
    const lobbyBack = await page.evaluate(() => {
      const el = document.getElementById("lobby");
      const rect = el.getBoundingClientRect();
      return { display: getComputedStyle(el).display, w: rect.width, h: rect.height };
    });
    mark(tag + ": the lobby is offered again after leaving", lobbyBack.display !== "none" && lobbyBack.w > 0,
      JSON.stringify(lobbyBack));

    // ---- 5. the control: the same panel in a real 1986 war offers both --------------------
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForSelector("#setupPanel:not(.hidden)", { timeout: 12000 });
    await page.click("#setupStandard");
    cur = await waitRoomMode("bot");
    mark(tag + ": a 1986 bot war opens on the standard setup", Boolean(cur), cur ? "mode " + cur.mode : "no room");
    if (!cur) throw new Error("pb308: the control war never opened at " + tag);
    panel = await warPanel();
    mark(tag + ": the control war still offers Begin Hostilities and the clock",
      /Begin Hostilities/.test(panel.bodyText) && /Run the clock|Hold the clock/.test(panel.bodyText)
        && panel.hint === "Who holds which side, the clock, and the way out.",
      JSON.stringify({ hint: panel.hint, buttons: panel.buttons }));
    await shot("03-war-panel-war");

    mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
    await context.close();
  }

  console.log("pb308 page leg: " + evidence.filter((row) => row.ok).length + " passed / " + failed + " failed");
  const verdict = { name: "pb308-layout-copy", base: BASE, mode: GIVEN ? "url" : "self-hosted", viewports: VIEWPORTS, failed, checks: evidence };
  await import("node:fs").then((fs) => fs.writeFileSync(path.join(OUT, "pb308-verdict" + (GIVEN ? "-url" : "") + ".json"), JSON.stringify(verdict, null, 2)));
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
  }
  process.exitCode = failed ? 1 : 0;
}
