// PB-310 page leg: Toggle Show-Who in a live war, at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb310-show-common.mjs                # starts its own server
//   node tests/e2e/pb310-show-common.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb310-show-common.mjs --out=<dir>
//
// Manual p.35 l.1115-1120: "By pressing Toggle Show-Who, you can switch to 'Show Common' mode, which
// displays only those enemy units in scanning range - and only those of your units that are in the
// scanning range of an enemy!"
//
// Per viewport:
//   1. a live 1942 solo war opens and the War panel offers a control labelled Toggle Show-Who;
//   2. the label says which mode is ON, and the film bar's four views are not this control;
//   3. pressing it draws exactly the spotted own pieces (the server's set, echoed on the wire) and
//      leaves the enemy set byte-identical to Normal (AC b and d);
//   4. the reopened panel says Common;
//   5. pressing it again restores the exact own and enemy id sets (AC c);
//   6. no raw ids in the copy, and no page errors at either width.

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
const OUT = evidenceDir("pb310-show-common", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb310-e2e-"));
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
    const roomNow = () => page.evaluate(() => window.__chq.room());
    const buttons = () => page.evaluate(() => [...document.querySelectorAll("#dialogBody button")].map((b) => String(b.textContent || "").trim()));
    const toast = () => page.evaluate(() => String(document.getElementById("flash")?.textContent || ""));

    async function waitRoom(pred, deadline = 25000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await roomNow();
        if (cur && pred(cur)) return cur;
        await sleep(100);
      }
      return null;
    }
    async function openWar() {
      await page.click('.navbtn[data-dialog="war"]');
      await sleep(250);
    }
    async function closeWar() {
      await page.click("#dialogClose");
      await sleep(150);
    }

    await signIn(page, "e2e-pb310-" + tag + "-" + run, "pw-" + run + "-a");
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await sleep(500);
    const setupShown = await page.evaluate(() => {
      const panel = document.getElementById("setupPanel");
      return Boolean(panel && !panel.classList.contains("hidden") && getComputedStyle(panel).display !== "none");
    });
    if (setupShown) await page.click("#setupStandard");
    const opened = await waitRoom((r) => r.mode === "bot" && r.you === "blue");
    if (!mark(tag + ": a solo 1942 war opened with the player blue", Boolean(opened), opened ? opened.id : "no room")) {
      throw new Error("pb310: no solo room at " + tag);
    }
    const ownBefore = opened.pieces.filter((p) => p.side === "blue").map((p) => p.id).sort();
    const enemyBefore = opened.pieces.filter((p) => p.side === "red").map((p) => p.id).sort();
    mark(tag + ": Normal carries no showCommon field", !("showCommon" in opened), JSON.stringify(Object.keys(opened).filter((k) => /common/i.test(k))));

    // ---- 1. the control ------------------------------------------------------------
    await openWar();
    const list = await buttons();
    mark(tag + ": the War panel offers Toggle Show-Who", list.some((b) => /Toggle Show-Who/.test(b)), list.join(" | "));
    mark(tag + ": the label says Normal while the mode is off", list.some((b) => /Toggle Show-Who:\s*Normal/.test(b)), list.join(" | "));
    mark(tag + ": the film bar's four views are not this control", !list.some((b) => /^Show (Red|Blue|Common|Both)$/.test(b)), list.join(" | "));
    await shot("01-war-panel-normal");

    // ---- 2. press it ---------------------------------------------------------------
    // A pre-fix tree has no such control. Say so as a FAIL and move to the next width instead of
    // throwing on the click: a control leg has to reach its own summary (PB-309's crash taught this).
    const hasToggle = await page.evaluate(() => Boolean(document.getElementById("showCommonBtn")));
    if (!hasToggle) {
      mark(tag + ": the toggle can be pressed", false, "no #showCommonBtn on the War panel");
      mark(tag + ": the wire says Show Common is on", false, "never sent - there is no control");
      mark(tag + ": toggling back restores the exact own set (AC c)", false, "never sent - there is no control");
      mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
      await context.close();
      continue;
    }
    await page.click("#showCommonBtn");
    const common = await waitRoom((r) => r.showCommon && r.showCommon.on === true);
    mark(tag + ": the wire says Show Common is on", Boolean(common), common ? JSON.stringify(common.showCommon).slice(0, 200) : "no frame");
    if (!common) throw new Error("pb310: the toggle never landed at " + tag);
    const spotted = common.showCommon.spotted.slice().sort();
    const ownCommon = common.pieces.filter((p) => p.side === "blue").map((p) => p.id).sort();
    const enemyCommon = common.pieces.filter((p) => p.side === "red").map((p) => p.id).sort();
    mark(tag + ": Common draws exactly the spotted own pieces", JSON.stringify(ownCommon) === JSON.stringify(spotted),
      JSON.stringify({ drawn: ownCommon.length, spotted: spotted.length }));
    mark(tag + ": Common drops at least one own piece (the toggle bites)", ownCommon.length < ownBefore.length,
      ownCommon.length + " of " + ownBefore.length);
    mark(tag + ": the enemy set is byte-identical to Normal (AC b/d)", JSON.stringify(enemyCommon) === JSON.stringify(enemyBefore),
      JSON.stringify({ before: enemyBefore.length, common: enemyCommon.length }));
    mark(tag + ": the copy carries no raw piece id", !/(blue|red):[a-z]+:/.test(await toast()), await toast());
    await shot("02-show-common");
    await closeWar();
    await openWar();
    const commonList = await buttons();
    mark(tag + ": the reopened panel says Common", commonList.some((b) => /Toggle Show-Who:\s*Common/.test(b)), commonList.join(" | "));
    await shot("03-war-panel-common");

    // ---- 3. press again: exact restore ---------------------------------------------
    await page.click("#showCommonBtn");
    const back = await waitRoom((r) => !r.showCommon && r.pieces && r.pieces.length > 0);
    mark(tag + ": the wire drops the showCommon field on the way back", Boolean(back), back ? "field absent" : "still on");
    if (!back) throw new Error("pb310: the toggle never came back at " + tag);
    const ownAfter = back.pieces.filter((p) => p.side === "blue").map((p) => p.id).sort();
    const enemyAfter = back.pieces.filter((p) => p.side === "red").map((p) => p.id).sort();
    mark(tag + ": toggling back restores the exact own set (AC c)", JSON.stringify(ownAfter) === JSON.stringify(ownBefore),
      JSON.stringify({ before: ownBefore.length, after: ownAfter.length }));
    mark(tag + ": toggling back restores the exact enemy set", JSON.stringify(enemyAfter) === JSON.stringify(enemyBefore),
      JSON.stringify({ before: enemyBefore.length, after: enemyAfter.length }));
    await closeWar();
    await openWar();
    const backList = await buttons();
    mark(tag + ": the panel says Normal again", backList.some((b) => /Toggle Show-Who:\s*Normal/.test(b)), backList.join(" | "));

    mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
    await context.close();
  }

  console.log("pb310 page leg: " + evidence.filter((row) => row.ok).length + " passed / " + failed + " failed");
  const verdict = { name: "pb310-show-common", base: BASE, mode: GIVEN ? "url" : "self-hosted", viewports: VIEWPORTS, failed, checks: evidence };
  await import("node:fs").then((fs) => fs.writeFileSync(path.join(OUT, "pb310-verdict" + (GIVEN ? "-url" : "") + ".json"), JSON.stringify(verdict, null, 2)));
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
  }
  process.exitCode = failed ? 1 : 0;
}
