// PB-311 page leg: a layout's header strip must not describe a cold war, at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb311-layout-strip.mjs                # starts its own server
//   node tests/e2e/pb311-layout-strip.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb311-layout-strip.mjs --out=<dir>
//
// PM 10093 item 2: on live 50758d6 a layout's #stripInfo read
//     1986 · blue · round 0 · held · cold war, war may resume
// Per viewport:
//   1. Lay Out Armies opens a 1986 sandbox and #stripInfo names the layout;
//   2. it carries no "cold war", "cease-fire", "war may resume" and no peace counter;
//   3. no raw piece id appears in the line;
//   4. the positive control: a real 1986 war at round 0 keeps the pre-fix line BYTE FOR BYTE,
//      so the layout arm is the only one that changed;
//   5. no page errors at either width.

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
const OUT = evidenceDir("pb311-layout-strip", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

// The painted line at 1280 and 1024 after PB-323b (PM 10334 §2): the head is full and the cold war
// suffix is painted short; the full "cold war, war may resume" lives in the readout's title. This
// used to pin the pre-fix sentence, and a short form correctly redressed that arm - so it is amended
// in the same commit as the strip change, never loosened.
const WAR_ROUND0 = "1986 · blue · round 0 · held · cold war";
const FORBIDDEN = /cold war|cease-fire|war may resume|rounds? left/i;

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
    }, 15000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
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
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "").slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + String(detail).slice(0, 300) : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb311-e2e-"));
let server = null;
let browser = null;
let BASE = GIVEN;

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
}

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
    const run = Date.now().toString(36).slice(-6);
    const pageErrors = [];
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
    const shot = (name) => page.screenshot({ path: path.join(OUT, name + "-" + tag + ".png") });
    const strip = () => page.evaluate(() => String(document.getElementById("stripInfo")?.textContent || "").trim());
    const stripTitle = () => page.evaluate(() => String(document.getElementById("stripInfo")?.getAttribute("title") || ""));

    async function waitMode(mode, deadline = 25000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await page.evaluate(() => window.__chq.room());
        if (cur && cur.mode === mode) return cur;
        await sleep(100);
      }
      return null;
    }

    // ---- 1. the layout sandbox ---------------------------------------------------------
    await signIn(page, "e2e-pb311-" + tag + "-" + run, "pw-" + run + "-a");
    await page.click("#layoutBtn");
    const layout = await waitMode("layout");
    if (!mark(tag + ": Lay Out Armies opens a 1986 sandbox", Boolean(layout), layout ? JSON.stringify({ era: layout.era, clock: layout.clock, round: layout.round }) : "no room")) {
      throw new Error("pb311: no layout at " + tag);
    }
    await sleep(250);
    const layoutLine = await strip();
    mark(tag + ": the strip names the layout", /\blayout\b/.test(layoutLine), layoutLine);
    mark(tag + ": the strip carries no cold war, cease-fire, war-may-resume or counter",
      !FORBIDDEN.test(layoutLine), layoutLine);
    mark(tag + ": the layout line is the shipped shape", layoutLine === "1986 · blue · layout · round 0 · held", layoutLine);
    mark(tag + ": the line carries no raw piece id", !/(blue|red):[a-z]+:/.test(layoutLine), layoutLine);
    mark(tag + ": the pre-fix live line is gone", layoutLine !== WAR_ROUND0, layoutLine);
    await shot("01-layout-strip");

    // ---- 2. leave the sandbox ----------------------------------------------------------
    await page.click('.navbtn[data-dialog="war"]');
    await sleep(220);
    const leave = await page.evaluate(() => {
      const button = [...document.querySelectorAll("#dialogBody button")].find((el) => /leave/i.test(el.textContent || ""));
      if (!button) return false;
      button.click();
      return true;
    });
    mark(tag + ": the War panel still offers Leave in a layout", leave, String(leave));
    await page.waitForFunction(() => window.__chq.room() === null, null, { timeout: 12000 }).catch(() => {});
    mark(tag + ": Leave returns to the lobby", (await page.evaluate(() => window.__chq.room())) === null, "room null");

    // ---- 3. POSITIVE CONTROL: the same strip in a real 1986 war, byte for byte ----------
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    // 1986 opens straight onto the standard setup in this build (measured); the setup panel only
    // appears when the era asks for a choice, so wait for the room, not for a panel.
    await sleep(500);
    const setupShown = await page.evaluate(() => {
      const panel = document.getElementById("setupPanel");
      return Boolean(panel && !panel.classList.contains("hidden") && getComputedStyle(panel).display !== "none");
    });
    if (setupShown) await page.click("#setupStandard");
    const war = await waitMode("bot");
    if (!mark(tag + ": a 1986 bot war opens on the standard setup", Boolean(war), war ? "mode bot" : "no room")) {
      throw new Error("pb311: the control war never opened at " + tag);
    }
    await sleep(400);
    const warLine = await strip();
    mark(tag + ": the control war paints the ruled short form byte for byte", warLine === WAR_ROUND0, warLine);
    mark(tag + ": the control war still carries the peace copy", FORBIDDEN.test(warLine), warLine);
    const warTitle = await stripTitle();
    mark(tag + ": the full cold-war suffix is in the readout's title", /cold war,\s*war may resume/i.test(warTitle), warTitle);
    await shot("02-war-strip");

    mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
    await context.close();
  }

  console.log("pb311 page leg: " + evidence.filter((row) => row.ok).length + " passed / " + failed + " failed");
  const verdict = { name: "pb311-layout-strip", base: BASE, mode: GIVEN ? "url" : "self-hosted", viewports: VIEWPORTS, failed, checks: evidence };
  await import("node:fs").then((fs) => fs.writeFileSync(path.join(OUT, "pb311-verdict" + (GIVEN ? "-url" : "") + ".json"), JSON.stringify(verdict, null, 2)));
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
  }
  process.exitCode = failed ? 1 : 0;
}
