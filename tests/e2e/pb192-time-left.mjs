// PB-192 page leg: the player-visible TIME LEFT box says its label once, its two figures apart, and
// never invents PAY NOW for a seat that reports no payday.
//
//   node tests/e2e/pb192-time-left.mjs                     # starts its own server
//   node tests/e2e/pb192-time-left.mjs --url=<base>        # a running server (the base tree: red)
//   node tests/e2e/pb192-time-left.mjs --out=<dir>
//   node tests/e2e/pb192-time-left.mjs --mutant=old-compose # planted defect, expects RED
//
// The report the fix answers (PM 8789 / 9932 s2): the box read "TIME LEFT / TIME LEFT", and
// "PAY IN 1" and "12S ROUND" ran together as "1 2S" because the join was two spaces and HTML
// collapses them. The node pin (web/test/nodes/chrome.mjs) grades the composed string; AC #1 is
// what the player SEES, so this leg grades the live chrome through a real page at 1280x800 and
// 1024x768:
//
//   1. the chrome is up (a round has begun) and the box's visible label writers number exactly one:
//      the span `#timeLabel` OR its canvas twin `#timeLabelArt` (ink present), never both;
//   2. the box's visible text carries TIME LEFT exactly once across label + figures — the count that
//      read 2 before the fix;
//   3. the figures line is exactly "<PAY IN n|PAY NOW> · <n>S ROUND": the separator is a visible
//      middle dot, not collapsed whitespace, and neither figure is glued to the other;
//   4. PAY NOW appears only when the seat's own payIn is 0. The leg reads payIn off the room frame,
//      so the arm is the server's number, not a guess;
//   5. the served module composes no PAY NOW (and no label) for a null, undefined, missing or
//      absent seat: the same `chrome.mjs` the page just imported, called in the page's own realm.
//
// --mutant=old-compose serves a copy of the tree whose `chrome.mjs` is the pre-fix shape (label in
// the text, two-space join, Number(null) = 0). The leg's negative arms must then go red; if they
// stay green the mutant survived and the leg exits 1, because a red that has never been seen is the
// cheapest false green in the repo.
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
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb192-page")));
mkdirSync(OUT, { recursive: true });

const SEP = " \u00b7 ";
const FIGURES = new RegExp("^(PAY IN [0-9]+|PAY NOW) \\u00b7 [0-9]+S ROUND$");
const VIEWPORTS = [[1280, 800], [1024, 768]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pre-fix composition, verbatim from eb2fc36:web/public/chrome.mjs. The mutant restores it.
const OLD_COMPOSE = `
export function timeLeftText(seat, roundSeconds) {
  const parts = [TIME_LEFT];
  const payIn = Number(seat && seat.payIn);
  if (Number.isFinite(payIn) && payIn >= 0) {
    parts.push(payIn === 0 ? "PAY NOW" : "PAY IN " + payIn);
  }
  const length = Number(roundSeconds);
  if (Number.isFinite(length) && length > 0) {
    parts.push(Math.round(length) + "S ROUND");
  }
  return parts.join("  ");
}
`;

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
    }, 12000);
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

function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb192-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const chromePath = path.join(dir, "web", "public", "chrome.mjs");
  const before = readFileSync(chromePath, "utf8");
  let after = before;
  if (kind === "old-compose") {
    // Replace the whole exported function: the fixed body's comments make a surgical edit brittle.
    after = before.replace(/export function timeLeftText\(seat, roundSeconds\) \{[\s\S]*?\n\}\n/, OLD_COMPOSE.replace(/^\n/, ""));
  } else {
    throw new Error("unknown mutant: " + kind);
  }
  if (after === before) throw new Error("the mutant could not be planted: the fixed source shape moved");
  writeFileSync(chromePath, after);
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb192-"));
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

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb192-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });

  // The box waits for a round (PB-136: the band keeps its box, only its ink waits), so start the
  // clock, let round 1 arrive, then hold it: the figure must not move under the measurement.
  let cur = await room();
  if (cur && cur.clock !== "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
  }
  await page.waitForFunction(() => Number(window.__chq.room().round) >= 1, null, { timeout: 25000, polling: 100 });
  cur = await room();
  if (cur && cur.clock === "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
  }
  cur = await room();
  mark("a round has begun and the clock is held", Boolean(cur && cur.round >= 1 && cur.clock !== "running"),
    "round " + (cur && cur.round) + " clock " + (cur && cur.clock));

  // ---------------------------------------------------------------- the served module, page realm
  const composed = await page.evaluate(async () => {
    const mod = await import("/chrome.mjs");
    return {
      nullSeat: mod.timeLeftText({ payIn: null }, 12),
      undefPay: mod.timeLeftText({ payIn: undefined }, 12),
      noSeat: mod.timeLeftText({}, 12),
      absent: mod.timeLeftText(null, 12),
      zero: mod.timeLeftText({ payIn: 0 }, 12),
      two: mod.timeLeftText({ payIn: 2 }, 12),
    };
  });
  console.log("served module: " + JSON.stringify(composed));
  for (const key of ["nullSeat", "undefPay", "noSeat", "absent"]) {
    mark("no payday (" + key + ") invents no PAY NOW and no label",
      !/PAY NOW/.test(composed[key]) && !/TIME LEFT/.test(composed[key]),
      JSON.stringify(composed[key]));
  }
  mark("payIn 0 says PAY NOW once, after the separator", composed.zero === "PAY NOW" + SEP + "12S ROUND", JSON.stringify(composed.zero));
  mark("payIn 2 says PAY IN 2 once", composed.two === "PAY IN 2" + SEP + "12S ROUND", JSON.stringify(composed.two));

  // ---------------------------------------------------------------- the rendered box, both viewports
  async function readChrome() {
    return page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const label = document.getElementById("timeLabel");
      const art = document.getElementById("timeLabelArt");
      const box = document.getElementById("timebox");
      const figures = document.getElementById("timeText");
      let artInk = null;
      if (art && visible(art)) {
        const data = art.getContext("2d").getImageData(0, 0, art.width, art.height).data;
        artInk = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) artInk += 1;
      }
      const frame = window.__chq.room() || {};
      const rect = box && box.getBoundingClientRect();
      return {
        boxVisible: visible(box),
        box: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        labelVisible: visible(label),
        labelText: label ? label.textContent : null,
        artVisible: visible(art),
        artInk,
        figuresText: figures ? figures.textContent : null,
        boxText: box ? box.innerText : null,
        payIn: frame.seat ? frame.seat.payIn : null,
        round: frame.round,
      };
    });
  }

  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await sleep(700);
    const at = width + "x" + height;
    const seen = await readChrome();
    console.log("chrome at " + at + ": " + JSON.stringify(seen));

    mark(at + ": the time box is on screen", seen.boxVisible, JSON.stringify(seen.box));

    // Exactly one writer of the label is visible, and the box's visible text says TIME LEFT once.
    const labelWriters = (seen.labelVisible ? 1 : 0) + (seen.artVisible ? 1 : 0);
    mark(at + ": exactly one visible label writer (span xor canvas twin)", labelWriters === 1,
      "span " + seen.labelVisible + " canvas " + seen.artVisible);
    if (seen.artVisible) mark(at + ": the canvas label has ink, so it is not a blank twin", Number(seen.artInk) > 0, "ink " + seen.artInk);
    if (seen.labelVisible) mark(at + ": the visible span reads TIME LEFT", seen.labelText === "TIME LEFT", JSON.stringify(seen.labelText));

    const figureHits = (String(seen.figuresText || "").match(/TIME LEFT/g) || []).length;
    const boxHits = (String(seen.boxText || "").match(/TIME LEFT/g) || []).length;
    mark(at + ": the figures line carries no label of its own", figureHits === 0, JSON.stringify(seen.figuresText));
    mark(at + ": the visible box says TIME LEFT exactly once", boxHits === 1, "count " + boxHits + " in " + JSON.stringify(seen.boxText));

    // The separator is a rendered middle dot, not whitespace the DOM collapsed.
    const figures = String(seen.figuresText || "");
    mark(at + ": the figures read as two words with a visible separator", FIGURES.test(figures), JSON.stringify(figures));
    mark(at + ": the separator is the rendered middle dot", figures.includes(SEP), JSON.stringify(figures));

    // PAY NOW only when the seat's own payIn is 0.
    const payIn = seen.payIn;
    if (Number(payIn) === 0) {
      mark(at + ": a seat with payIn 0 reads PAY NOW", figures.startsWith("PAY NOW" + SEP), JSON.stringify(figures));
    } else {
      mark(at + ": a seat with payIn " + JSON.stringify(payIn) + " never reads PAY NOW", !/PAY NOW/.test(figures), JSON.stringify(figures));
      mark(at + ": a seat with payIn " + JSON.stringify(payIn) + " counts that many rounds",
        figures.startsWith("PAY IN " + Number(payIn) + SEP), JSON.stringify(figures));
    }

    const shot = path.join(OUT, "pb192-" + at + ".png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log("shot: " + shot);
  }

  mark("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  writeFileSync(path.join(OUT, "pb192-evidence.json"), JSON.stringify({ sha: process.env.GATE_SHA || "", base: BASE, mutant: MUTANT, evidence }, null, 2));
} catch (err) {
  mark("the leg ran to the end", false, err && err.message ? err.message : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

const summary = (failed === 0 ? "GREEN" : "RED") + " — " + evidence.filter((e) => e.ok).length + " pass, " + failed + " fail; tree " + (MUTANT ? "mutant(" + MUTANT + ")" : serverTree);
console.log(summary);
// A mutant run is a NEGATIVE arm: the planted defect must show up as a failure. Green under a
// mutant means the leg never sees the defect, which is a leg failure, not a pass.
if (MUTANT && failed === 0) {
  console.log("MUTANT SURVIVED: the planted " + MUTANT + " did not red any arm");
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
