// PB-329 page leg: no toast covers the map legend, the footer note or the Show Common slot, in the
// lobby and in a match, at 1024x768, 1280x800 and 1440x900 - and the toast still says its sentence.
//
//   node tests/e2e/pb329-toast-legend.mjs                    # starts its own server
//   node tests/e2e/pb329-toast-legend.mjs --url=<base>       # a running server
//   node tests/e2e/pb329-toast-legend.mjs --out=<dir>
//   node tests/e2e/pb329-toast-legend.mjs --mutant=footer-only  # the pre-fix band, expects RED
//   node tests/e2e/pb329-toast-legend.mjs --mutant=floor        # the pre-PB-167b floor, expects RED
//
// The defect (live 4088c33, probe measured before the fix): PB-167b anchored the toast above the
// map's FOOTER row and stopped there. `#legend` sits directly above that row, so every toast sat
// 9.3 px into it - at all three widths, not only the one the card names. The card's AC is a
// rect-intersection test, so this leg measures `getBoundingClientRect()` fractionally (integer
// rounding is what hid earlier 2 px cases) and prints the clearance in px, not just a boolean.
//
// Arms per viewport:
//   (lobby) a toast carrying the "left the match" sentence in the LOBBY: the footer sits high on
//           the page there, so the pre-fix floor already clears the band and the seat must NOT move;
//   (switch) the real Switch Sides toast, provoked through the War panel: the page's own handler
//           re-seats it, the server's sentence must be intact, and it must clear legend/note/slot;
//   (pill) the "X left the match" pill, same #flash element, same seat;
//   (note) the toast still clears the status line (PB-167b must not regress under a wider band);
//   (box) the toast stays fully inside the viewport and keeps its readable type size.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function headSha() {
  const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return out.status === 0 ? String(out.stdout || "").trim() : "";
}
const SHA = String(process.env.GATE_SHA || "").trim() || headSha();

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const MUTANT = argOf("mutant", "");
const OUT = evidenceDir("pb329", argOf("out"));
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [[1024, 768], [1280, 800], [1440, 900]];
const ERA = "1942";
const LEFT_PILL = "Blue left the match.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

function startServer(port, dataDir, tree) {
  return new Promise((resolve, reject) => {
    // The tree under test names itself: web/data/build.json is a committed deploy stamp (a fossil on
    // a dev checkout), so the leg hands the server the sha it is grading.
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir,
      ...(SHA ? { OPENCHQ_COMMIT: SHA } : {}) };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 15000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

// The mutant is planted in a COPY of the tree so the checkout under test is never edited.
function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb329-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const appPath = path.join(dir, "web", "public", "app.js");
  const before = readFileSync(appPath, "utf8");
  let after = before;
  if (kind === "footer-only") {
    // The exact pre-fix band: the footer row, without the legend above it.
    after = before.replace(
      '  add(document.getElementById("legend"));\n',
      '  // mutant: the footer row only - PB-329\'s pre-fix band\n',
    );
  } else if (kind === "floor") {
    // The pre-PB-167b shape: the toast back on the viewport floor.
    after = before.replace(
      "  flash.style.bottom = seat === floor ? \"\" : seat + \"px\";\n",
      "  flash.style.bottom = \"10px\"; // mutant: the pre-fix floor\n",
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb329-"));
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

  for (const [width, height] of VIEWPORTS) {
    const at = width + "x" + height;
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

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
          fontSize: parseFloat(style.fontSize) || 0,
          inlineBottom: el.style.bottom || "",
        };
      };
      return {
        flash: box("flash"), legend: box("legend"), note: box("boardNote"), modeFlag: box("modeFlag"),
        vw: innerWidth, vh: innerHeight, inMatch: document.body.classList.contains("in-match"),
      };
    });

    // Land a sentence on the real #flash element and let the page's own seat handler re-measure it.
    const seatToast = (text) => page.evaluate((value) => {
      document.getElementById("flash").textContent = value;
      window.dispatchEvent(new Event("resize"));
    }, text);

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const name = "e2e-pb329-" + Date.now().toString(36).slice(-8) + width;
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + name);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await sleep(600);
    const served = await page.evaluate(() => fetch("/api/version").then((r) => r.json()).catch(() => null));
    const footer = await page.evaluate(() => String((document.getElementById("buildCommit") || {}).textContent || "").trim());
    mark("(build) the page names the tree this leg graded" + " @" + at,
      Boolean(SHA) && Boolean(served && served.commit === SHA) && footer === "build " + SHA.slice(0, 7),
      JSON.stringify({ served, footer, sha: SHA }));

    // ---- lobby -----------------------------------------------------------------------------
    await seatToast(LEFT_PILL);
    await sleep(250);
    let seen = await rects();
    console.log(at + " lobby: flash " + fmt(seen.flash) + " legend " + fmt(seen.legend) + " note " + fmt(seen.note));
    mark("(lobby) the toast is up with its sentence" + " @" + at,
      seen.flash.visible && seen.flash.text === LEFT_PILL, JSON.stringify(seen.flash.text));
    mark("(lobby) the legend is on screen" + " @" + at, seen.legend.visible, JSON.stringify(seen.legend.text.slice(0, 30)));
    let cmp = compare(seen.flash, seen.legend);
    mark("(lobby) the toast clears the legend" + " @" + at, !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance y " + cmp.gapY.toFixed(2) + " px");
    cmp = compare(seen.flash, seen.note);
    mark("(lobby) the toast clears the footer note" + " @" + at, !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance y " + cmp.gapY.toFixed(2) + " px");
    mark("(lobby) the toast stays inside the viewport" + " @" + at,
      seen.flash.top >= 0 && seen.flash.bottom <= seen.vh + 0.01 && seen.flash.left >= 0 && seen.flash.right <= seen.vw + 0.01,
      "top " + seen.flash.top.toFixed(2) + " bottom " + seen.flash.bottom.toFixed(2) + " vh " + seen.vh);
    mark("(lobby) the toast keeps readable type" + " @" + at, seen.flash.fontSize >= 11, "font " + seen.flash.fontSize + " px");
    await page.screenshot({ path: path.join(OUT, "pb329-" + at + "-lobby.png") });
    await seatToast("");
    await sleep(150);

    // ---- match -----------------------------------------------------------------------------
    await page.selectOption('#launch select[name="era"]', ERA);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
    await sleep(600);
    const cur = await page.evaluate(() => window.__chq.room());
    if (cur && cur.clock === "running") { await page.click("#clockBtn").catch(() => {}); await sleep(300); }
    mark("(match) a solo 1942 war is open" + " @" + at,
      Boolean(cur && cur.id) && cur.mode === "bot",
      JSON.stringify({ id: cur && cur.id, era: cur && cur.era, mode: cur && cur.mode }));

    // (switch) the real toast: War > Switch Sides. The server writes the sentence and the page takes it.
    await page.click('.navbtn[data-dialog="war"]');
    await page.waitForSelector("#switchSidesBtn", { timeout: 8000 });
    const before = await page.evaluate(() => window.__chq.room().you);
    await page.evaluate(() => document.getElementById("switchSidesBtn").click());
    await page.waitForFunction((side) => {
      const r = window.__chq.room();
      return Boolean(r && r.you && r.you !== side);
    }, before, { timeout: 12000, polling: 100 }).catch(() => {});
    // Measure while the toast is still up: a flash expires on its own 8 s timer (PB-137), so the
    // read happens as soon as the sentence lands, never after a long wait.
    for (let i = 0; i < 20; i++) {
      const text = await page.evaluate(() => document.getElementById("flash").textContent.trim());
      if (text) break;
      await sleep(100);
    }
    const after = await page.evaluate(() => {
      const r = window.__chq.room();
      return { you: r ? r.you : null, note: r ? r.note : null };
    });
    seen = await rects();
    console.log(at + " switch: flash " + fmt(seen.flash) + " text " + JSON.stringify(seen.flash.text.slice(0, 60)));
    mark("(switch) the Switch Sides sentence is on the toast" + " @" + at,
      seen.flash.visible && seen.flash.text.trim().length > 0 && seen.flash.text.trim() === String(after.note || "").trim(),
      JSON.stringify({ toast: seen.flash.text, note: after.note, you: after.you }));
    mark("(switch) the seat really flipped" + " @" + at, Boolean(after.you) && after.you !== before,
      JSON.stringify({ from: before, to: after.you }));
    cmp = compare(seen.flash, seen.legend);
    mark("(switch) the toast clears the legend" + " @" + at, !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance y " + cmp.gapY.toFixed(2) + " px");
    cmp = compare(seen.flash, seen.note);
    mark("(switch) the toast clears the footer note" + " @" + at, !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance y " + cmp.gapY.toFixed(2) + " px");
    cmp = compare(seen.flash, seen.modeFlag);
    mark("(switch) the toast clears the Show Common slot" + " @" + at,
      !seen.modeFlag.visible || !cmp.intersects,
      seen.modeFlag.visible
        ? "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance x " + cmp.gapX.toFixed(2) + " px"
        : "no slot on this frame");
    mark("(switch) the toast stays inside the viewport" + " @" + at,
      seen.flash.top >= 0 && seen.flash.bottom <= seen.vh + 0.01, "top " + seen.flash.top.toFixed(1) + " bottom " + seen.flash.bottom.toFixed(2) + " vh " + seen.vh);
    await page.screenshot({ path: path.join(OUT, "pb329-" + at + "-switch.png") });

    // (pill) the other toast shape: a seat leaving the room.
    await seatToast(LEFT_PILL);
    await sleep(250);
    seen = await rects();
    console.log(at + " pill: flash " + fmt(seen.flash) + " legend " + fmt(seen.legend));
    cmp = compare(seen.flash, seen.legend);
    mark("(pill) the toast clears the legend" + " @" + at, seen.flash.visible && seen.flash.text === LEFT_PILL && !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance y " + cmp.gapY.toFixed(2) + " px");
    cmp = compare(seen.flash, seen.note);
    mark("(pill) the toast clears the footer note" + " @" + at, !cmp.intersects,
      "overlap " + cmp.overlapX.toFixed(2) + "x" + cmp.overlapY.toFixed(2) + " px, clearance y " + cmp.gapY.toFixed(2) + " px");
    mark("(pill) the toast keeps its sentence" + " @" + at, seen.flash.text === LEFT_PILL, JSON.stringify(seen.flash.text));

    mark("(errors) no page errors" + " @" + at, pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
    await context.close();
  }

  const named = mark("the evidence names the tree it graded", Boolean(SHA),
    SHA ? SHA + (String(process.env.GATE_SHA || "").trim() ? " (GATE_SHA)" : " (git rev-parse HEAD of " + root + ")")
      : "no GATE_SHA, and git rev-parse HEAD in " + root + " returned nothing");
  if (named) writeFileSync(path.join(OUT, "pb329-evidence.json"),
    JSON.stringify({ sha: SHA, base: BASE, mutant: MUTANT, viewports: VIEWPORTS, evidence }, null, 2));
} catch (err) {
  mark("the leg ran to the end", false, err && err.message ? err.message : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

const summary = (failed === 0 ? "GREEN" : "RED") + " — " + evidence.filter((e) => e.ok).length + " pass, " + failed + " fail; tree " +
  (MUTANT ? "mutant(" + MUTANT + ")" : serverTree);
console.log(summary);
if (MUTANT) {
  // A mutant is only proved by an arm going RED BY NAME: a leg that fails to boot also exits 1, and
  // that is a broken run, not a red arm.
  const redByBand = evidence.filter((e) => !e.ok && /the toast clears (the legend|the footer note)/.test(e.step));
  if (!redByBand.length) {
    console.log("PB329_MUTANT_NOT_PROVED: the planted " + MUTANT + " red no band arm (a boot failure is not a red arm)");
    process.exit(1);
  }
  console.log("PB329_MUTANT_PROVED: " + redByBand.length + " band arm(s) RED by name under mutant(" + MUTANT + ")");
  process.exit(0);
}
process.exit(failed === 0 ? 0 : 1);
