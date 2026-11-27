// PB-312 page leg: a game against "No Opponent", at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb312-no-opponent.mjs                # starts its own server
//   node tests/e2e/pb312-no-opponent.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb312-no-opponent.mjs --out=<dir>
//
// Manual p.35 l.1126-1137: Switch Sides "only works in a solo game or a game against 'no opponent'".
//
// Per viewport:
//   1. the lobby's Opponent select offers NO OPPONENT (served from the config table, never typed);
//   2. choosing it disables the opponent's starting-money spinner - nobody to give it to;
//   3. the war opens with an EMPTY other seat, the header says so, and no seat reads "Bot";
//   4. the clock runs rounds and the empty seat stays empty (no bot line appears);
//   5. Switch Sides works twice, and the seat left behind reads "No opponent", not "Bot";
//   6. Toggle Show-Who works in this game (PB-310) - Normal, Common, Normal;
//   7. the visible copy carries no raw piece id, and there are no page errors at either width.

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
const OUT = evidenceDir("pb312-no-opponent", argOf("out"));
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb312-e2e-"));
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

const noRawId = (value) => !/(blue|red):[a-z]+:/.test(String(value));

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

    const room = () => page.evaluate(() => window.__chq.room());
    const toast = () => page.evaluate(() => String(document.getElementById("flash")?.textContent || ""));
    const texts = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => String(el.textContent || "").trim()), selector);
    const shot = (name) => page.screenshot({ path: path.join(OUT, name + "-" + tag + ".png") });
    async function waitToast(pattern, deadline = 12000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const line = await toast();
        if (pattern.test(String(line))) return String(line);
        await sleep(80);
      }
      return null;
    }
    async function waitRoom(pred, deadline = 25000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await room();
        if (cur && pred(cur)) return cur;
        await sleep(100);
      }
      return null;
    }
    async function openWar() {
      await page.click('.navbtn[data-dialog="war"]');
      await sleep(220);
    }
    async function closeWar() {
      await page.click("#dialogClose");
      await sleep(120);
    }
    // A pre-fix tree has no such control, and a click on a missing selector throws before the leg
    // reaches its summary (PB-309's crash taught this). Find the button by its own text, say so, and
    // soft-continue.
    async function clickButton(pattern) {
      const hit = await page.evaluate((source) => {
        const re = new RegExp(source, "i");
        const button = [...document.querySelectorAll("#dialogBody button")].find((b) => re.test(String(b.textContent || "")));
        if (!button) return false;
        button.click();
        return true;
      }, pattern);
      await sleep(150);
      return hit;
    }

    await signIn(page, "e2e-pb312-" + tag + "-" + run, "pw-" + run + "-a");

    // ---- 1. the lobby offers it --------------------------------------------------------------
    const options = await page.evaluate(() => [...document.querySelectorAll('#launch select[name="level"] option')]
      .map((option) => ({ value: option.value, text: String(option.textContent || "").trim() })));
    const noneOption = options.find((option) => /no opponent/i.test(option.text));
    mark(tag + ": the Opponent select offers NO OPPONENT", Boolean(noneOption),
      options.map((option) => option.value + ":" + option.text).join(" | "));
    if (!noneOption) {
      mark(tag + ": the war opens with an empty seat", false, "no option to choose");
      mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
      await context.close();
      continue;
    }
    await page.selectOption('#launch select[name="level"]', noneOption.value);
    await sleep(200);
    const spinner = await page.evaluate(() => {
      const input = document.querySelector('#launch input[name="handicap"]');
      return { disabled: Boolean(input && input.disabled), value: input ? input.value : null };
    });
    mark(tag + ": choosing it disables the opponent's starting money", spinner.disabled === true,
      JSON.stringify(spinner));

    // ---- 2. the room: an empty other seat, and the page says so -------------------------------
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    const setupShown = await page.evaluate(() => {
      const panel = document.getElementById("setupPanel");
      return Boolean(panel && !panel.classList.contains("hidden") && getComputedStyle(panel).display !== "none");
    });
    if (setupShown) await page.click("#setupStandard");
    const opened = await waitRoom((r) => r.mode === "bot" && r.you === "blue");
    if (!mark(tag + ": a no-opponent 1942 war opened with the player blue", Boolean(opened), opened ? opened.id : "no room")) {
      throw new Error("pb312: no room at " + tag);
    }
    mark(tag + ": the other seat is empty (kind none)", Boolean(opened.red && opened.red.kind === "none"),
      JSON.stringify({ blue: opened.blue, red: opened.red }));
    mark(tag + ": no seat reads Bot", !/bot/i.test(String(opened.blue.username) + String(opened.red.username)),
      JSON.stringify({ blue: opened.blue.username, red: opened.red.username }));
    mark(tag + ": the room note names the empty seat in words", /no opponent/i.test(String(opened.note || "")),
      String(opened.note || "").slice(0, 200));
    await shot("01-no-opponent-room");

    // ---- 3. the clock runs, and no bot line appears ------------------------------------------
    await openWar();
    const warText = await page.evaluate(() => String(document.getElementById("dialogBody")?.textContent || ""));
    mark(tag + ": the War panel names the empty seat in words", /no opponent/i.test(warText), warText.slice(0, 200));
    mark(tag + ": the War panel shows no seat held by a Bot", !/\bBot\b/.test(warText), warText.slice(0, 200));
    const warButtons = await texts("#dialogBody button");
    mark(tag + ": the War panel offers Switch Sides", warButtons.includes("Switch Sides"), warButtons.join(" | "));
    const ran = await clickButton("Run the clock");
    mark(tag + ": the War panel offers Run the clock", ran, warButtons.join(" | "));
    const running = await waitRoom((r) => r.clock === "running", 8000);
    mark(tag + ": the clock runs", Boolean(running), running ? "running" : "still held");
    const advanced = await waitRoom((r) => Number(r.round) >= 2, 30000);
    mark(tag + ": rounds advance with nobody at the other seat", Boolean(advanced),
      advanced ? "round " + advanced.round : "no round");
    await clickButton("Hold the clock");
    await sleep(400);
    const botLines = await page.evaluate(() => String(document.getElementById("roundLog")?.textContent || ""));
    mark(tag + ": no bot order line in the round log", !/\bbot\b/i.test(botLines), botLines.slice(0, 200));
    await shot("02-clock-running");
    await closeWar();

    // ---- 4. Switch Sides, both ways, with an empty seat left behind ---------------------------
    await openWar();
    await page.click("#switchSidesBtn");
    const flipped = await waitRoom((r) => r.you === "red" && r.blue && r.blue.kind === "none");
    mark(tag + ": the player now holds the red side, blue empty", Boolean(flipped),
      flipped ? JSON.stringify({ you: flipped.you, blue: flipped.blue, red: flipped.red }) : "no flip");
    const flipToast = await waitToast(/now the red side/i);
    mark(tag + ": the player reads the server's own sentence", Boolean(flipToast), String(flipToast));
    mark(tag + ": the sentence says no opponent plays the side left behind", /no opponent plays blue/i.test(String(flipToast)),
      String(flipToast));
    mark(tag + ": the sentence carries no raw piece id", noRawId(flipToast), String(flipToast));
    await closeWar();
    await openWar();
    await page.click("#switchSidesBtn");
    const backRoom = await waitRoom((r) => r.you === "blue" && r.red && r.red.kind === "none");
    mark(tag + ": Switch Sides works back to blue", Boolean(backRoom),
      backRoom ? JSON.stringify({ you: backRoom.you, red: backRoom.red }) : "no flip back");
    await shot("03-switched-back");

    // ---- 5. Toggle Show-Who in this game (PB-310) --------------------------------------------
    const hasToggle = await page.evaluate(() => Boolean(document.getElementById("showCommonBtn")));
    mark(tag + ": the War panel offers Toggle Show-Who", hasToggle, "");
    if (hasToggle) {
      await page.click("#showCommonBtn");
      const common = await waitRoom((r) => r.showCommon && r.showCommon.on === true);
      mark(tag + ": Common turns on in a no-opponent war", Boolean(common),
        common ? JSON.stringify(common.showCommon).slice(0, 200) : "no frame");
      const label = await texts("#dialogBody button");
      mark(tag + ": the label says Common", label.some((b) => /Toggle Show-Who:\s*Common/.test(b)), label.join(" | "));
      await shot("04-show-common");
      await page.click("#showCommonBtn");
      const normal = await waitRoom((r) => !r.showCommon);
      mark(tag + ": turning it off puts Normal back", Boolean(normal), normal ? "field absent" : "still on");
    }
    await closeWar();

    const copy = await page.evaluate(() => String(document.body.innerText || ""));
    mark(tag + ": the visible page carries no raw piece id", noRawId(copy.slice(0, 4000)), "");
    mark(tag + ": no page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    await context.close();
  }

  console.log("pb312 page leg: " + evidence.filter((row) => row.ok).length + " passed / " + failed + " failed");
  const verdict = { name: "pb312-no-opponent", base: BASE, mode: GIVEN ? "url" : "self-hosted", viewports: VIEWPORTS, failed, checks: evidence };
  const fs = await import("node:fs");
  fs.writeFileSync(path.join(OUT, "pb312-verdict" + (GIVEN ? "-url" : "") + ".json"), JSON.stringify(verdict, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
  }
  process.exitCode = failed ? 1 : 0;
}
