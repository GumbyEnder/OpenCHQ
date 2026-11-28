// PB-340 page leg: the signed-out landing paints no match controls — no clock (▶), no speed group,
// no round readout — at 1024, 1280 and 1440; a match still shows all three, and signing out of that
// match hides them again with no reload.
//
//   node tests/e2e/pb340-signedout-controls.mjs                 # starts its own server from this tree
//   node tests/e2e/pb340-signedout-controls.mjs --url=<base>    # a running server
//   node tests/e2e/pb340-signedout-controls.mjs --out=<dir>
//
// The defect (PM play-test 01:10 ET, live eceac31): the header is one element that is the lobby's
// masthead before a match and the strip during one, and every match command on it is hidden until
// `body.in-match` except the clock, which had no default `display` rule. So the signed-out landing
// showed a lone ▶ over the page — a control for a war that does not exist.
//
// Per width (1024x768, 1280x800, 1440x900), one browser context, in this order:
//   (a) with NO session the landing shows no clock, no speed group and no round readout, Debug is
//       still painted, and nothing overflows sideways;
//   (a2) the same is true of a signed-in lobby with no match — one producer (`body.in-match`), not a
//       second predicate for "signed out";
//   (b-enter) Play a bot paints the clock (▶/❚❚), the speed group with its readout, and the round
//       readout, whole and inside the window;
//   (b-signout) Sign out from inside that match hides all three again with no reload (a JS marker
//       set before the click is still there after it);
//   (e) no page errors.
//
// Mutant this leg is the grader for: M1 removes the clock's default `display: none` (it is visible
// while signed out again) — every (a) and (a2) arm reds by name at every width.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb340-signedout-controls", argOf("out"));

const PASSWORD = "pb340-right-pass";
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;

function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 1400) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb340-signedout-controls.json"), JSON.stringify({ evidence }, null, 2));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

// One frame: is each match control painted, what does it say, and where is it?
const snapshot = (page) => page.evaluate(() => {
  const rr = (n) => Math.round(n * 100) / 100;
  const paint = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      x: rr(r.x), y: rr(r.y), right: rr(r.right), bottom: rr(r.bottom), w: rr(r.width), h: rr(r.height),
      display: cs.display, visibility: cs.visibility,
      visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0,
    };
  };
  const clock = document.getElementById("clockBtn");
  const speed = document.querySelector(".speedctl");
  const readout = document.getElementById("speedReadout");
  const info = document.getElementById("stripInfo");
  const debug = document.getElementById("debugToggle");
  return {
    inMatch: document.body.classList.contains("in-match"),
    booting: document.body.classList.contains("booting"),
    gateHidden: document.getElementById("gate").classList.contains("hidden"),
    clock: paint(clock),
    clockText: clock ? String(clock.textContent || "") : "",
    speed: paint(speed),
    speedText: readout ? String(readout.textContent || "") : "",
    info: paint(info),
    infoText: info ? String(info.textContent || "").trim() : "",
    debug: paint(debug),
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    marker: Boolean(window.__pb340Stay),
  };
});

const booted = (page) => page.waitForFunction(() => !document.body.classList.contains("booting"),
  null, { timeout: 30000, polling: 60 });

const inMatch = (page) => page.waitForFunction(() => {
  const info = document.getElementById("stripInfo");
  return document.body.classList.contains("in-match") && info && info.textContent.trim().length > 0;
}, null, { timeout: 30000, polling: 60 });

const signedOut = (page) => page.waitForFunction(() => {
  const gate = document.getElementById("gate");
  return gate && !gate.classList.contains("hidden") && !document.body.classList.contains("in-match");
}, null, { timeout: 30000, polling: 60 });

let BASE = GIVEN;
let child = null;

async function main() {
  const { chromium } = await loadPlaywright();
  if (!BASE) {
    const port = await freePort();
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        OPENCHQ_WEB_HOST: "127.0.0.1",
        OPENCHQ_WEB_PORT: String(port),
        OPENCHQ_WEB_DATA: mkdtempSync(path.join(tmpdir(), "pb340-")),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* booting */ }
      await sleep(120);
    }
  }
  console.log("served", (await (await fetch(BASE + "/api/version")).text()).trim());
  // The fix is in the stylesheet, so the served stylesheet — not only app.js — has to be this tree.
  const digest = (buf) => createHash("md5").update(buf).digest("hex");
  for (const asset of ["app.js", "app.css"]) {
    const treeDigest = digest(readFileSync(path.join(root, "web", "public", asset)));
    const servedDigest = digest(Buffer.from(await (await fetch(BASE + "/" + asset)).arrayBuffer()));
    mark("PB340 port: the server serves this tree's " + asset, treeDigest === servedDigest,
      JSON.stringify({ treeDigest, servedDigest }));
  }
  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    const at = " @" + viewport.width + "x" + viewport.height;
    const tag = "P34" + Date.now().toString(36).slice(-6) + viewport.width;
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    // (a) No session: the landing is the gate under the masthead, and the masthead carries no match
    // command. The round readout is empty, not merely hidden behind overflow.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await booted(page);
    let snap = await snapshot(page);
    const clearOfMatchControls = !snap.inMatch &&
      !(snap.clock && snap.clock.visible) &&
      !(snap.speed && snap.speed.visible) &&
      !(snap.info && (snap.info.visible || snap.infoText.length > 0));
    mark("PB340 (a)" + at + ": the signed-out landing paints no clock, speed group or round readout",
      clearOfMatchControls,
      JSON.stringify({ inMatch: snap.inMatch, clock: snap.clock, clockText: snap.clockText,
        speed: snap.speed, speedText: snap.speedText, info: snap.info, infoText: snap.infoText }));
    // AC (c): Debug stays, and the gate itself must not overflow.
    mark("PB340 (a-debug)" + at + ": Debug stays and the gate does not scroll sideways",
      Boolean(snap.debug && snap.debug.visible) && snap.docScrollWidth <= snap.innerWidth,
      JSON.stringify({ debug: snap.debug, docScrollWidth: snap.docScrollWidth, innerWidth: snap.innerWidth }));
    await page.screenshot({ path: path.join(OUT, "pb340-" + viewport.width + "-signed-out.png"),
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } });

    // Register: the page is now signed in, on the lobby, with no match yet.
    await page.fill("#register input[name=username]", tag);
    await page.fill("#register input[name=password]", PASSWORD);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });

    // (a2) Same producer: a signed-in lobby has no match, so it has no match controls either.
    snap = await snapshot(page);
    mark("PB340 (a2)" + at + ": the signed-in lobby with no match paints no match controls",
      !snap.inMatch && !(snap.clock && snap.clock.visible) && !(snap.speed && snap.speed.visible) &&
        !(snap.info && (snap.info.visible || snap.infoText.length > 0)),
      JSON.stringify({ inMatch: snap.inMatch, clock: snap.clock, clockText: snap.clockText,
        speed: snap.speed, info: snap.info, infoText: snap.infoText }));

    // (b-enter) A real match on a real clock paints all three, whole.
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await inMatch(page);
    snap = await snapshot(page);
    const shown = snap.inMatch && snap.clock && snap.clock.visible && /^[\u25B6\u275A]{1,2}$/.test(snap.clockText) &&
      snap.speed && snap.speed.visible && /^Speed [0-6]/.test(snap.speedText) &&
      snap.info && snap.info.visible && snap.infoText.length > 0 &&
      snap.clock.right <= snap.innerWidth + 0.51;
    mark("PB340 (b-enter)" + at + ": entering a match paints the clock, the speed group and the round readout",
      shown,
      JSON.stringify({ inMatch: snap.inMatch, clock: snap.clock, clockText: snap.clockText,
        speed: snap.speed, speedText: snap.speedText, info: snap.info, infoText: snap.infoText,
        innerWidth: snap.innerWidth }));
    await page.screenshot({ path: path.join(OUT, "pb340-" + viewport.width + "-in-match.png"),
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } });

    // (b-signout) Out of the match from the strip's own Sign out, no reload: hide again.
    await page.evaluate(() => { window.__pb340Stay = true; });
    await page.getByRole("button", { name: "Sign out" }).click();
    await signedOut(page);
    snap = await snapshot(page);
    mark("PB340 (b-signout)" + at + ": signing out hides them again without a reload",
      !snap.inMatch && snap.marker && !(snap.clock && snap.clock.visible) &&
        !(snap.speed && snap.speed.visible) && !(snap.info && (snap.info.visible || snap.infoText.length > 0)),
      JSON.stringify({ inMatch: snap.inMatch, marker: snap.marker, clock: snap.clock,
        speed: snap.speed, info: snap.info, infoText: snap.infoText }));
    await page.screenshot({ path: path.join(OUT, "pb340-" + viewport.width + "-signed-out-again.png"),
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } });

    // (e) No page errors on the whole course.
    mark("PB340 (e)" + at + ": no page error", errors.length === 0, JSON.stringify(errors));

    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");
  const passed = evidence.length - failed;
  console.log("pb340 page leg: " + passed + " passed / " + failed + " failed; evidence " + OUT);
  if (failed > 0) {
    console.log("PB340_CONTROLS_RED");
    process.exit(1);
  }
  console.log("PB340_CONTROLS_OK");
}

main().catch((err) => {
  if (child) child.kill("SIGTERM");
  console.error(err && err.stack ? err.stack : err);
  console.log("PB340_CONTROLS_RED");
  process.exit(1);
});
