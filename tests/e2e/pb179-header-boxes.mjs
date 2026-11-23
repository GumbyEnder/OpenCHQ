// PB-179 leg: the strip's controls never overlap, and New asks before it abandons a match.
//
//   node tests/e2e/pb179-header-boxes.mjs                 # starts its own server
//   node tests/e2e/pb179-header-boxes.mjs --url=<base>    # use a running server
//
// The defect: `body.in-match .nav` kept `flex-shrink: 1`, so the container shrank UNDER its own
// buttons; the buttons overflowed that box and the next sibling (.gamebtns) started at the shrunken
// edge. At 1280x800 the measured rects were New 1028-1074 and Log 1010-1052 — a click meant for Log
// could land on New, which abandons the game.
//
// This leg reads real bounding boxes off a real page in a real match at the three widths the card
// names, and it never counts a parent/child pair as an overlap (Sign out is a child of #account).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb179")));
console.log("out dir: " + OUT + " (pass --out=<dir> or --out <dir> to move it)");
const WIDTHS = (argOf("widths", "1280x800,1440x900,1024x768")).split(",").map((s) => {
  const [w, h] = s.split("x").map(Number);
  return { w, h, label: s };
});
mkdirSync(OUT, { recursive: true });
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
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 8000);
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
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb179-"));
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
    const v = await fetch(BASE + "/api/version").then((r) => r.json()).catch(() => null);
    mark("the given host answers /api/version", Boolean(v), JSON.stringify(v));
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb179-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && document.body.classList.contains("in-match"), null, { timeout: 25000, polling: 100 });
  await sleep(600);
  const opened = await page.evaluate(() => window.__chq.room());
  mark("a 1986 match is open", Boolean(opened && opened.id), String(opened && opened.id));

  // Every element the player can press in the strip, plus the two readouts that are not buttons.
  // Parent/child pairs are excluded below: #account contains the Sign out button.
  const readBoxes = () => page.evaluate(() => {
    const items = [];
    const push = (label, el) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      items.push({ label, x: +rect.x.toFixed(2), y: +rect.y.toFixed(2), w: +rect.width.toFixed(2), h: +rect.height.toFixed(2),
        parent: el.parentElement ? (el.parentElement.id || el.parentElement.className || el.parentElement.tagName) : null });
    };
    push("New", document.getElementById("newBtn"));
    push("Resign", document.getElementById("resignBtn"));
    push("Quit", document.getElementById("quitBtn"));
    push("Clock", document.getElementById("clockBtn"));
    push("speed-", document.getElementById("speedDown"));
    push("speed+", document.getElementById("speedUp"));
    push("speedReadout", document.getElementById("speedReadout"));
    for (const b of document.querySelectorAll("#nav .navbtn")) push("nav:" + (b.textContent || "").trim(), b);
    for (const b of document.querySelectorAll("#strip .whoami button")) push("whoami:" + (b.textContent || "").trim().slice(0, 12), b);
    for (const el of document.querySelectorAll("#strip .brand .stripinfo, #strip .brand .pursechip")) {
      push((el.id || "brand"), el);
    }
    const strip = document.getElementById("strip");
    const sr = strip.getBoundingClientRect();
    return { items, strip: { x: +sr.x.toFixed(2), w: +sr.width.toFixed(2), h: +sr.height.toFixed(2) }, scrollW: strip.scrollWidth, clientW: strip.clientWidth };
  });

  const overlapPairs = (items) => {
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        // A nested element cannot "overlap" its own container: that is one control inside another.
        if (a.parent === b.label || b.parent === a.label) continue;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0.5 && oy > 0.5) pairs.push({ a: a.label, b: b.label, ox: +ox.toFixed(2), oy: +oy.toFixed(2) });
      }
    }
    return pairs;
  };

  for (const { w, h, label } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(450);
    const boxes = await readBoxes();
    const pairs = overlapPairs(boxes.items);
    mark("no strip control overlaps at " + label, pairs.length === 0, JSON.stringify(pairs));
    const rightmost = Math.max(...boxes.items.map((it) => it.x + it.w));
    mark("no strip control runs past the window at " + label, rightmost <= w + 0.5, "rightmost=" + rightmost.toFixed(1) + " window=" + w);
    const purse = boxes.items.find((it) => it.label === "purseChip");
    mark("the purse chip still shows at " + label, Boolean(purse && purse.w > 20), JSON.stringify(purse || null));
    await page.screenshot({ path: path.join(OUT, "pb179-" + label + ".png") });
  }

  // New must ask before it abandons the match, and a dismissed prompt must leave the match alone.
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(300);
  const before = await page.evaluate(() => window.__chq.room());
  let seenDialog = null;
  page.once("dialog", async (dialog) => {
    seenDialog = { type: dialog.type(), message: dialog.message() };
    await dialog.dismiss().catch(() => {});
  });
  await page.click("#newBtn").catch(() => {});
  await sleep(700);
  mark("New asks before it abandons a match", Boolean(seenDialog && seenDialog.type === "confirm"), JSON.stringify(seenDialog));
  mark("the prompt says the game is abandoned", Boolean(seenDialog && /abandon/i.test(seenDialog.message || "")), JSON.stringify(seenDialog && seenDialog.message));
  const after = await page.evaluate(() => window.__chq.room());
  mark("a dismissed prompt leaves the match running", Boolean(after && before && String(after.id) === String(before.id)), JSON.stringify({ before: before && before.id, after: after && after.id }));
  mark("no page error during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} catch (err) {
  failed += 1;
  evidence.push({ step: "leg threw", ok: false, detail: String(err && err.stack ? err.stack : err) });
  console.error("FAIL leg threw — " + String(err && err.message ? err.message : err));
} finally {
  try { if (browser) await browser.close(); } catch (err) { void err; }
  try { if (server) server.kill("SIGKILL"); } catch (err) { void err; }
  writeFileSync(path.join(OUT, "pb179-header-boxes.json"), JSON.stringify({ base: BASE, failed, evidence }, null, 2));
  console.log("pb179 header boxes: " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  process.exit(failed ? 1 : 0);
}
