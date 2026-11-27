// PB-167b page leg: no toast ever covers the status line, at 1280x800 and 1024x768.
//
//   node tests/e2e/pb167b-toast-status.mjs                     # starts its own server
//   node tests/e2e/pb167b-toast-status.mjs --url=<base>        # a running server (the base tree: RED)
//   node tests/e2e/pb167b-toast-status.mjs --out=<dir>
//   node tests/e2e/pb167b-toast-status.mjs --mutant=floor      # planted overlap, expects RED
//
// The last ungraded mark of the 2026-11-22 economy play-test (PB-167 mark 4, carved to this card):
// "a toast covers the status line". The toast is `#flash` (position: fixed, centred, `bottom: 10px`
// in a match); the status line is `#boardNote` in the map's footer row. Measured on 8a88611, at
// 1024x768: flash x 408.0-616.1, y 718.8-758.0; note x 10-514.4, y 714.1-730.0 - the toast's lower
// half sits ON the line. At 1280x800 the short "Select one of your pieces." box (208 px) stops 22 px
// short of the note, but the toast is width-capped at 720 px and centred, so any refusal wider than
// ~250 px reaches the note: the defect is latent, not absent.
//
// So the leg measures TWO toasts per viewport, both real shapes of the element:
//   1. a provoked toast: a click on an empty cell with nothing selected fires the page's own
//      "Select one of your pieces." through the same `say()` path a refusal uses;
//   2. the widest refusal the page can emit: the loaded-transfer sentence, lifted out of app.js by
//      this leg (so the string cannot drift from the page's own source) and laid out by the same
//      CSS rule. A defect that only shows on a long sentence is still a defect a player sees.
//
// The comparison is fractional (getBoundingClientRect, no rounding): PB-291b's lesson is that
// integer rounding is exactly what hid the 2 px case. The leg also prints the pixel gap so a
// reviewer can see the slack, not just a boolean.
//
// --mutant=floor re-anchors the toast to the viewport floor (`bottom: 10px`, the pre-fix shape) in a
// copy of the tree. Both viewports must then go red; if they stay green the leg cannot see the
// defect and exits 1.
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
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb167b")));
mkdirSync(OUT, { recursive: true });

// The longest refusal the economy slice emits, read from the page's own source: if the sentence is
// ever reworded, this leg reads the new one instead of grading a fossil.
const APP_SOURCE = readFileSync(path.join(root, "web", "public", "app.js"), "utf8");
const LONG_REFUSAL = (APP_SOURCE.match(/say\("(A carrier-based aircraft[^"]+)"/) || [])[1] || "";
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
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb167b-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const appPath = path.join(dir, "web", "public", "app.js");
  const before = readFileSync(appPath, "utf8");
  let after = before;
  if (kind === "floor") {
    // Put the toast back on the viewport floor: the fixed 10 px offset the CSS still defaults to.
    after = before.replace(
      "  flash.style.bottom = inMatch ? flashBottom + \"px\" : \"\";\n",
      "  flash.style.bottom = inMatch ? \"10px\" : \"\"; // mutant: the pre-fix floor anchor\n",
    );
  } else {
    throw new Error("unknown mutant: " + kind);
  }
  if (after === before) throw new Error("the mutant could not be planted: the anchored write moved");
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

// Fractional intersection, then the gap along the axis that saves it. Positive gap = clear.
function compare(a, b) {
  const xOver = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const yOver = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const gapX = Math.max(b.left - a.right, a.left - b.right);
  const gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
  return { intersects: xOver > 0 && yOver > 0, overlapX: xOver, overlapY: yOver, gapX, gapY };
}

const fmt = (r) => "[" + r.left.toFixed(2) + "," + r.top.toFixed(2) + " " + r.width.toFixed(2) + "x" + r.height.toFixed(2) + "]";

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb167b-"));
let server = null;
let browser = null;
let BASE = GIVEN;
let serverTree = root;

try {
  if (!LONG_REFUSAL) throw new Error("the long refusal sentence is no longer in app.js; re-point this leg before trusting it");

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
  const name = "e2e-pb167b-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });

  // A round, then hold the clock: the status line must read a real round, and nothing may move
  // under the measurement.
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
  mark("a 1986 match is at round 1+ with the clock held", Boolean(cur && cur.round >= 1 && cur.clock !== "running"),
    "round " + (cur && cur.round) + " clock " + (cur && cur.clock));

  const rects = () => page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        visible: style.display !== "none" && style.visibility !== "hidden" && r.width > 0 && r.height > 0,
        text: String(el.textContent || ""),
        bottomStyle: el.style.bottom || "",
      };
    };
    return {
      flash: box("flash"),
      note: box("boardNote"),
      result: box("result"),
      vw: innerWidth,
      vh: innerHeight,
    };
  });

  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await sleep(700);
    const at = width + "x" + height;

    // Arm 1: the page's own refusal toast, through the click path a player uses.
    const point = await page.evaluate(() => window.__chq.cellToScreen(2, 2));
    if (!point) throw new Error("the empty cell (2,2) is not on screen at " + at);
    await page.mouse.click(point.x, point.y);
    await sleep(250);
    let seen = await rects();
    console.log(at + " provoked: flash " + fmt(seen.flash) + " note " + fmt(seen.note));
    mark(at + ": a toast is on screen", seen.flash.visible && seen.flash.text.trim().length > 0, JSON.stringify(seen.flash.text));
    mark(at + ": the note is the status line, not a selection line",
      /^Cell grid from the map extract/.test(seen.note.text), JSON.stringify(seen.note.text.slice(0, 60)));
    mark(at + ": the status line is on screen", seen.note.visible, JSON.stringify(seen.note.text.slice(0, 40)));
    let cmp = compare(seen.flash, seen.note);
    mark(at + ": the provoked toast does not cover the status line", !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance " +
      "x " + cmp.gapX.toFixed(2) + " / y " + cmp.gapY.toFixed(2) + " px");
    const shot1 = path.join(OUT, "pb167b-" + at + "-provoked.png");
    await page.screenshot({ path: shot1 });
    console.log("shot: " + shot1);

    // Arm 2: the widest refusal the page can emit, laid out by the page's own CSS.
    await page.evaluate((text) => { document.getElementById("flash").textContent = text; }, LONG_REFUSAL);
    await sleep(200);
    seen = await rects();
    console.log(at + " long: flash " + fmt(seen.flash) + " note " + fmt(seen.note));
    mark(at + ": the long refusal lays out at the same anchor", seen.flash.visible, JSON.stringify(seen.flash.text.slice(0, 40)));
    cmp = compare(seen.flash, seen.note);
    mark(at + ": the widest refusal does not cover the status line", !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance " +
      "x " + cmp.gapX.toFixed(2) + " / y " + cmp.gapY.toFixed(2) + " px");
    const shot2 = path.join(OUT, "pb167b-" + at + "-long.png");
    await page.screenshot({ path: shot2 });
    console.log("shot: " + shot2);

    // The finished-match line shares the same column: it must clear the note too, or a toast
    // pushed above the result would simply trade one cover for another.
    await page.evaluate(() => { document.getElementById("flash").textContent = ""; });
  }

  mark("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  writeFileSync(path.join(OUT, "pb167b-evidence.json"),
    JSON.stringify({ sha: process.env.GATE_SHA || "", base: BASE, mutant: MUTANT, longRefusal: LONG_REFUSAL, evidence }, null, 2));
} catch (err) {
  mark("the leg ran to the end", false, err && err.message ? err.message : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

const summary = (failed === 0 ? "GREEN" : "RED") + " — " + evidence.filter((e) => e.ok).length + " pass, " + failed + " fail; tree " +
  (MUTANT ? "mutant(" + MUTANT + ")" : serverTree);
console.log(summary);
if (MUTANT && failed === 0) {
  console.log("MUTANT SURVIVED: the planted " + MUTANT + " did not red any arm");
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
