// PB-279 page leg: the chat field must not sit on the caption line under the legend.
//
// In a two-human room #chatBar was `position: fixed; left: 12px; bottom: 12px`, so at 1280x800 its
// box (12..411, 747..788) landed on top of #boardNote (10..1270, 746..762) and hid the left ~400 px
// of the map's caption ("Cell grid from the map extract ... round 0 - clock held"). The leg reads
// the two boxes and asks the browser whether they intersect, at both shipping widths.
//
// What this leg does, with nothing stubbed:
//   1. two seats register, blue invites red to a 1986 two-player war, red accepts;
//   2. both pages show the chat field (the server's own room.chatOpen) and a caption line;
//   3. at 1280x800 and at 1024x768: #boardNote's box does not intersect #chatBar's box, both are
//      inside the viewport, and the caption carries text;
//   4. the bar keeps its bottom-left place (its left edge is still the panel's left edge) and the
//      strip is untouched: #chrome is 56 px and #stripInfo starts at y=8, the same numbers the
//      shipped build prints today.
//
//   node tests/e2e/pb279-caption-vs-chat.mjs                # starts its own server from this tree
//   node tests/e2e/pb279-caption-vs-chat.mjs --url=<base>   # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = path.resolve((process.argv.find((v) => v.startsWith("--out=")) || "").slice(6) ||
  mkdtempSync(path.join(tmpdir(), "openchq-pb279-")));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function signIn(page, BASE, name) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
}

// The four boxes this ticket is about, plus the strip the fix must not move.
const boxes = (page) => page.evaluate(() => {
  const rect = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      shown: !el.classList.contains("hidden") && getComputedStyle(el).display !== "none" };
  };
  return {
    bar: rect("chatBar"),
    note: rect("boardNote"),
    chrome: rect("chrome"),
    strip: rect("stripInfo"),
    noteText: ((document.getElementById("boardNote") || {}).textContent || "").trim(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
});
const intersects = (a, b) => Boolean(a && b) &&
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb279-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch { /* still booting */ }
      await sleep(150);
    }
    mark("a local server answers", true, BASE);
  } else {
    mark("using the given host", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctxBlue = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxRed = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blue = await ctxBlue.newPage();
  const red = await ctxRed.newPage();
  const pageErrors = [];
  blue.on("pageerror", (err) => pageErrors.push(String(err)));
  red.on("pageerror", (err) => pageErrors.push(String(err)));

  const tag = Date.now().toString(36).slice(-6);
  const redName = "CapRed" + tag;
  await signIn(blue, BASE, "CapBlue" + tag);
  await signIn(red, BASE, redName);

  await blue.selectOption('#launch select[name="era"]', "1986");
  await blue.selectOption('#launch select[name="side"]', "blue");
  await blue.waitForSelector("li.person", { timeout: 25000 });
  await blue.evaluate((name) => {
    const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
    row.querySelector("button").click();
  }, redName);
  await red.waitForSelector("#invites .invite button", { timeout: 25000 });
  await red.evaluate(() => document.querySelector("#invites .invite button").click());
  await blue.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "human",
    null, { timeout: 25000, polling: 100 });
  const roomId = await blue.evaluate(() => window.__chq.room().id);
  await red.waitForFunction((id) => window.__chq.room() && window.__chq.room().id === id, roomId,
    { timeout: 25000, polling: 100 });
  await sleep(600);
  mark("a two-human room is open and the chat field is up", await blue.evaluate(() =>
    Boolean(window.__chq.room() && window.__chq.room().chatOpen)), "room " + roomId);

  const readings = {};
  for (const width of [1280, 1024]) {
    await blue.setViewportSize({ width, height: width === 1280 ? 800 : 768 });
    await sleep(700);
    const b = await boxes(blue);
    readings[width] = b;
    const label = width + "x" + (width === 1280 ? 800 : 768);
    mark(label + ": the chat bar is shown", Boolean(b.bar) && b.bar.shown, JSON.stringify(b.bar));
    mark(label + ": the caption line is shown and carries text",
      Boolean(b.note) && b.note.shown && /^Cell grid/.test(b.noteText),
      JSON.stringify(b.note) + " " + JSON.stringify(b.noteText.slice(0, 60)));
    mark(label + ": the caption's box does not intersect the chat bar's box", !intersects(b.note, b.bar),
      "note " + JSON.stringify(b.note) + " bar " + JSON.stringify(b.bar));
    mark(label + ": both boxes are inside the viewport",
      b.note.y + b.note.h <= b.viewport.h && b.bar.y + b.bar.h <= b.viewport.h &&
      b.note.x >= 0 && b.bar.x >= 0,
      "viewport " + b.viewport.w + "x" + b.viewport.h);
    mark(label + ": the bar keeps its bottom-left place", b.bar.x <= 40, "bar x " + b.bar.x);
    mark(label + ": the strip is untouched (#chrome 56 px, #stripInfo at y=8)",
      b.chrome.h === 56 && b.strip.y === 8, "chrome " + b.chrome.h + ", strip y " + b.strip.y);
    await blue.screenshot({ path: path.join(OUT, "pb279-" + label + ".png") });
  }

  // The second seat has the same footer row; a fix that only works for the inviter is not the fix.
  await red.setViewportSize({ width: 1024, height: 768 });
  await sleep(700);
  const rb = await boxes(red);
  mark("the red seat at 1024x768 has the same non-intersecting row", !intersects(rb.note, rb.bar),
    "note " + JSON.stringify(rb.note) + " bar " + JSON.stringify(rb.bar));

  mark("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

  writeFileSync(path.join(OUT, "pb279-caption.json"), JSON.stringify({
    base: BASE, roomId, readings, red: rb, evidence, failed, at: new Date().toISOString(),
  }, null, 2));
  console.log((failed ? "FAIL " : "PASS ") + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  console.log("evidence " + path.join(OUT, "pb279-caption.json"));
  await ctxBlue.close();
  await ctxRed.close();
  await browser.close();
  if (child) child.kill();
  if (failed) process.exit(1);
}

await main();
