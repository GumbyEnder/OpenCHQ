// PB-242 AC2 leg: the ground a refused aim read, on a real page.
//
//   node tests/e2e/pb242-refusal-ground.mjs              # starts its own server from this tree
//   node tests/e2e/pb242-refusal-ground.mjs --url=<base> # a running server; it MUST have nukes on
//
// The defect this leg exists for: `lobby.toolOp` rebuilt every tool refusal as `{ error }`, so
// `reason` and `terrain` - which `late.useTool` and `nukestrike.nukeTarget` already returned - died
// one layer under the wire. A player aiming at a lake and a player aiming at the open sea read the
// same sentence and could not tell which ground they had hit. The node suites pin the frame and the
// text functions; this leg pins the thing the ticket actually asks for: what the PAGE SAYS.
//
// What is measured, all of it from the page's own view (window.__chq):
//   1. the Kit arms a nuke picker (one click, no charge) - the door a player uses;
//   2. a lake aim is refused with the server's sentence AND names its ground on the same line;
//   3. an ocean aim on the SAME page is accepted, so arm 2 cannot pass by the tool being broken;
//   4. the armed/refused aim never charged the pool (the refusal sits above the price).
//
// Screenshot: a refusal at 1280x800 is written to --out (default ~/agents/game/notes/pb242).
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
const OUT = evidenceDir("pb242", argOf("out"));
mkdirSync(OUT, { recursive: true });

const LAKE = { x: 73, y: 34 };   // NO_REGION lake, outside both capital rings
const SEA = { x: 25, y: 3 };     // NO_REGION ocean, outside both capital rings

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

// The shipped config keeps nukes off (PB-233 flips it), so this leg turns the block on in a
// throwaway copy and points the server at it. The tree is not edited.
function nukeConfig() {
  const base = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
  base.nukes = { ...(base.nukes || {}), enabled: true };
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb242-cfg-"));
  const file = path.join(dir, "game.json");
  writeFileSync(file, JSON.stringify(base, null, 2));
  return file;
}

function startServer(port, dataDir, configFile) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
      OPENCHQ_CONFIG: configFile,
      OPENCHQ_DEBUG: "1",
    };
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb242-e2e-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir, nukeConfig());
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers with nukes on", true, BASE);
  } else {
    mark("using the given host", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  // say() paints the flash line; window.__chq.toast() is that element - the line a player reads.
  const said = () => page.evaluate(() => window.__chq.toast());

  async function clickCell(cell) {
    let point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(300);
      point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    }
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await sleep(220);
    return true;
  }

  async function openKit() {
    if (!(await page.isVisible("div.shop.tools button.buy"))) {
      await page.click('.navbtn[data-dialog="kit"]').catch(() => {});
      await page.waitForSelector("div.shop.tools button.buy", { timeout: 8000 }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb242-" + Date.now().toString(36).slice(-8);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  mark("a throwaway player registers", true, name);

  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  let cur = await room();
  mark("Play a bot opens a 1986 match", Boolean(cur && cur.seat), "round " + (cur && cur.round));

  // A tool is spent in a running match (a held clock refuses), so the clock stays running.
  async function setClock(want) {
    for (let i = 0; i < 6; i++) {
      const now = await room();
      if (!now) return false;
      if ((now.clock === "running" ? "running" : "held") === want) return true;
      await page.click("#clockBtn").catch(() => {});
      await page.waitForFunction((w) => {
        const r = window.__chq.room();
        return Boolean(r) && (r.clock === "running" ? "running" : "held") === w;
      }, want, { timeout: 8000, polling: 100 }).catch(() => {});
      await sleep(150);
    }
    return false;
  }

  const running = await setClock("running");
  mark("the clock runs, so the aim is not refused for the pause", running, "clock " + (await room()).clock);

  await openKit();
  const nuke = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("div.shop.tools button.buy"));
    const el = buttons.find((button) => button.textContent.trim() === "Nuke");
    return el ? { disabled: Boolean(el.disabled), text: el.textContent.trim() } : null;
  });
  mark("the Kit row carries the Nuke button", Boolean(nuke && !nuke.disabled), JSON.stringify(nuke));

  // ---------------------------------------------------------------- 1. arm, no charge
  const cash0 = Number((await room()).seat.cash);
  await page.click("div.shop.tools button.buy:has-text('Nuke')");
  await sleep(250);
  const armedNote = await said();
  const cash1 = Number((await room()).seat.cash);
  mark("the Nuke button arms a picker instead of spending", /pick the ground you want to hit/i.test(armedNote), armedNote);
  mark("arming does not charge the pool", cash1 === cash0, "cash " + cash0 + " -> " + cash1);

  // ---------------------------------------------------------------- 2. a lake names its ground
  const clickedLake = await clickCell(LAKE);
  mark("the lake cell is clickable", clickedLake, JSON.stringify(LAKE));
  await sleep(300);
  const lakeLine = await said();
  const cash2 = Number((await room()).seat.cash);
  mark("a lake aim is refused with the server's sentence", /did not resolve/i.test(lakeLine), lakeLine);
  mark("the refusal names the ground the aim read", /Ground: lake\./.test(lakeLine), lakeLine);
  mark("a refused aim costs nothing", cash2 === cash0, "cash " + cash0 + " -> " + cash2);
  await page.screenshot({ path: path.join(OUT, "pb242-lake-refusal-1280x800.png") });
  mark("captured the refusal at 1280x800", true, path.join(OUT, "pb242-lake-refusal-1280x800.png"));

  // ---------------------------------------------------------------- 3. the same page, a sea aim
  await openKit();
  await page.click("div.shop.tools button.buy:has-text('Nuke')").catch(() => {});
  await sleep(200);
  const clickedSea = await clickCell(SEA);
  mark("the sea cell is clickable", clickedSea, JSON.stringify(SEA));
  await sleep(500);
  const seaLine = await said();
  mark(
    "a sea aim on the same page is accepted, not refused",
    !/did not resolve|Ground:/.test(seaLine),
    seaLine,
  );

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  writeFileSync(path.join(OUT, "pb242-refusal-ground.json"), JSON.stringify({ base: BASE, lake: LAKE, sea: SEA, lakeLine, armedNote, evidence }, null, 2) + "\n");
  console.log("EVIDENCE " + path.join(OUT, "pb242-refusal-ground.json"));
  console.log("PB242_E2E " + (failed === 0 ? "OK" : "FAILED " + failed));
} catch (err) {
  failed += 1;
  console.error("FAIL leg threw: " + (err && err.message ? err.message : err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill("SIGTERM");
    await sleep(200);
    try { server.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
process.exit(failed === 0 ? 0 : 1);
