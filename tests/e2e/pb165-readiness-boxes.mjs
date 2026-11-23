// PB-165 page leg: does the page receive and PAINT the original's three readiness-box states off
// the readiness timer, and does the rule still refuse anything but the ready state?
//
//   node tests/e2e/pb165-readiness-boxes.mjs                      # starts its own server from this tree
//   node tests/e2e/pb165-readiness-boxes.mjs --url=<base>          # use a running server
//   node tests/e2e/pb165-readiness-boxes.mjs --expect=<sha>        # require that sha at /api/version
//
// Method. A real page on a real socket against the real server: legalCells() carries `box` 1/2/3
// straight off the server's placement mask; the board's own pixels are classified against the
// three VGA 16 inks the original paints (FUN_2c85_1022 @ 2c85:1022 and FUN_2c85_1254 @ 2c85:1254:
// palette 10 #55ff55 green / 14 #ffff55 yellow / 12 #ff5555 red); a soon cell is refused with the
// round it comes back; the timer decays one state per round (long -> soon -> green).
//
// Reference-pixel rule (the defect this tracked version fixes). The gate harness sampled ONE
// arbitrary box-1 cell for its "green ready ink" reference and got rgba 17,32,30 — dark, unpainted,
// so its yellow-vs-green check compared yellow against a dark sample and proved nothing. Here the
// green reference is the first box-1 cell that actually classifies GREEN by hue, the sample is the
// most saturated pixel of a 3x3 probe around the cell centre, and the ready ink is asserted on its
// own check instead of being assumed. A cell that is not painted cannot become the reference.
//
// The "sample the reference from the city's own cell right after placement" shape was measured and
// does not work on the live renderer: that cell's centre is the city glyph (rgba 27,63,143, hue 221
// blue), and a ring probe at +-8 px reaches the adjacent cell's box. Both readings are printed by
// this leg; the reference stays on a painted box-1 cell.
//
// Same-cell clause (room 8246 ruling, 2026-11-23). "pxReady from the city's own cell at placement"
// was refused as measured: that cell's centre is the city glyph (27,63,143) and a ring probe at +-8 px
// reads a neighbouring cell's box. The clause is therefore "assert rgba 61,185,65 on the same cell when
// it becomes ready", and it is asserted on ONE cell by coordinate - the cell that reads box 3 (red) is
// the cell that reads box 2 (yellow) is the cell that reads box 1 and paints 61,185,65. The yellow
// check's reference stays a separately measured green cell (hue 120), plus an assertion that the built
// cell is NOT green.
//
// Lives in tests/e2e/, not web/test/nodes/: run.mjs imports every nodes/*.mjs as {name, run(ctx)}
// and counts it inside the 137-test suite, so a browser leg parked there would either join the suite
// (Chromium in every gate run) or need a skip hook. Every other tracked page leg (pb169, pb170,
// pb172, pb179) lives here. Tracked either way, so a re-base costs a re-run.
//
// The server is pinned: OPENCHQ_COMMIT is set from this tree's HEAD (main.mjs versionInfo precedence
// env > railway > build.json > git), so /api/version reports the sha being graded, not the stamp
// left in web/data/build.json by whoever built the tree last.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

let HEAD_SHA = "";
try {
  HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch (err) { void err; }

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = argOf("era", "1986");
const EXPECT = argOf("expect", HEAD_SHA ? HEAD_SHA.slice(0, 7) : "");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb165")));
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
    const env = {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
      ...(HEAD_SHA ? { OPENCHQ_COMMIT: HEAD_SHA } : {}),
    };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 8000);
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

// Playwright comes from ./playwright.mjs (PB-176). This leg carried its own two-path candidate
// list until a re-cut reverted it; without PLAYWRIGHT_MODULE it fell through to bare
// `import("playwright")` and threw CANNOT_FIND_PACKAGE from a clean worktree.

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  writeFileSync(path.join(OUT, "pb165-page-leg.json"), JSON.stringify(evidence, null, 2));
  return Boolean(ok);
}

// The three inks, in hue terms: red 0, yellow 60, green 120. Blending with the dark board keeps the
// hue and drops the value, so classification is hue + saturation, never an exact triple.
function classifyInPage() {
  window.__chqClassify = (px) => {
    const [r, g, b] = px;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    if (max < 40 || sat < 0.12) return { ink: "unpainted", h: null, s: +sat.toFixed(2), v: max };
    const d = max - min;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    const ink = h < 30 || h > 330 ? "red" : h < 80 ? "yellow" : h < 170 ? "green" : "other";
    return { ink, h: Math.round(h), s: +sat.toFixed(2), v: max };
  };
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb165-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE + " (tree HEAD " + (HEAD_SHA || "unknown") + ")");
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(classifyInPage);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const legal = () => page.evaluate(() => window.__chq.legalCells(6000));
  const counts = (cells) => cells.reduce((m, c) => ((m[c.box] = (m[c.box] || 0) + 1), m), {});
  const classify = (px) => page.evaluate((p) => window.__chqClassify(p), px);

  // Most saturated pixel of a 3x3 probe: the box ink is a thin ring, so the centre pixel alone can
  // land on the terrain between strokes and read dark — the exact failure the gate harness hit.
  async function sample(cell) {
    return page.evaluate(({ x, y }) => {
      const centre = window.__chq.cellToScreen(x, y);
      const cv = document.getElementById("board");
      const rect = cv.getBoundingClientRect();
      const g = cv.getContext("2d");
      let best = [0, 0, 0, 0];
      let bestSat = -1;
      for (let dx = -2; dx <= 2; dx += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          const px = g.getImageData(
            Math.round((centre.x + dx - rect.left) * (cv.width / rect.width)),
            Math.round((centre.y + dy - rect.top) * (cv.height / rect.height)),
            1, 1,
          ).data;
          const max = Math.max(px[0], px[1], px[2]);
          const min = Math.min(px[0], px[1], px[2]);
          const sat = max ? (max - min) / max : 0;
          if (sat > bestSat && max > 40) {
            bestSat = sat;
            best = [px[0], px[1], px[2], px[3]];
          }
        }
      }
      return best;
    }, cell);
  }

  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(250);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(600);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(600);
    return true;
  }

  async function arm(kind) {
    await page.click('#nav button[data-dialog="buy"]');
    await sleep(250);
    await page.click('button.buyrow[data-kind="' + kind + '"]');
    await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
    await sleep(350);
    return legal();
  }

  async function waitRound(target, timeout = 120000) {
    await page.waitForFunction((t) => window.__chq.room() && Number(window.__chq.room().round) >= t, target, { timeout, polling: 100 });
    await sleep(300);
  }

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()).catch(() => null));
  mark("the page is served " + (EXPECT || "any sha"), Boolean(version) && (!EXPECT || version.short === EXPECT),
    JSON.stringify(version));

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    await page.fill("#register input[name=username]", "pb165" + Date.now().toString(36).slice(-7));
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((w) => window.__chq.room() && String(window.__chq.room().era) === w, ERA, { timeout: 20000, polling: 100 });
  const r0 = await room();
  mark("1986 blue match open", Boolean(r0 && r0.id), "id " + (r0 && r0.id) + " round " + (r0 && r0.round));

  // --- 1. a fresh board: every legal cell is state 1 -------------------------------------------
  const inf = await arm("infantry");
  const h = counts(inf);
  mark("legalCells carries the mask's box byte", inf.length > 0 && Object.keys(h).every((k) => ["1", "2", "3"].includes(String(k))),
    JSON.stringify(h));
  mark("a fresh board is all state 1", (h[1] || 0) > 0 && !h[2] && !h[3], JSON.stringify(h));

  // The green reference is a cell that is actually painted green, not the first cell in the list.
  let pxReady = null;
  let readyCell = null;
  let tried = 0;
  for (const cell of inf.filter((c) => c.box === 1).slice(0, 40)) {
    tried += 1;
    const px = await sample(cell);
    const ink = await classify(px);
    if (ink.ink === "green") {
      pxReady = px;
      readyCell = cell;
      break;
    }
  }
  mark("a ready cell carries the green box ink (VGA 10 #55ff55)", Boolean(pxReady),
    pxReady ? "rgba " + pxReady.join(",") + " on cell " + readyCell.x + "," + readyCell.y + " after " + tried + " probes"
      : "no green classification in " + tried + " box-1 probes");

  // --- 2. one infantry build: it places, and the radius goes to the LONG state (22 rounds) -----
  const before = ((await room()).pieces || []).length;
  if (readyCell) await clickCell(readyCell);
  await sleep(1000);
  const bought = ((await room()).pieces || []).length;
  mark("a ready cell places the piece", bought === before + 1, "pieces " + before + " -> " + bought);

  // The placed city's OWN cell, sampled the instant the piece lands. It is not a green reference:
  // the city it just created is 22 rounds out, so the same cell that was box 1 a moment ago now
  // paints the long-wait ink. Recorded here so the reference claim is tied to the placement and not
  // to a cell that happened to be green by accident.
  // FACT, measured twice: the built cell's centre is the city's own glyph (rgba 27,63,143, hue 221),
  // so it is NOT a green reference and CANNOT become one — the box ink on that cell survives only in
  // its ring, which reads red. That is why the reference in this leg is a painted box-1 cell instead.
  const pxCity = readyCell ? await sample(readyCell) : [0, 0, 0, 0];
  const inkCity = await classify(pxCity);
  mark("the built cell's centre is the city's own ink, not the box ink",
    inkCity.ink !== "green" && inkCity.h !== null,
    "rgba " + pxCity.join(",") + " -> " + JSON.stringify(inkCity));
  // A ring probe at +-8 px was tried and is not usable here: the default zoom puts adjacent cells
  // inside that radius, so the probe reads a neighbour's box (measured: rgba 46,151,66, hue 131
  // green) and cannot isolate the built cell's own stroke. The reference therefore comes from a
  // distinct painted box-1 cell, which is measured rather than assumed.

  const inf3 = await arm("infantry");
  const h3 = counts(inf3);
  mark("the built city's radius reads the long-wait state (3)", (h3[3] || 0) > 0, JSON.stringify(h3));
  const longCell = inf3.find((c) => c.box === 3);
  // Same-cell pin (room 8246 ruling, 2026-11-23): one cell, held by coordinate, from the red read
  // through the yellow read to the ready read. Without it each read takes the first cell carrying
  // its box byte, so "the same cell" is an ordering coincidence, not an assertion.
  const cell = longCell ? { x: longCell.x, y: longCell.y } : null;
  const pxLong = longCell ? await sample(longCell) : [0, 0, 0, 0];
  const inkLong = await classify(pxLong);
  mark("a long-wait cell paints RED (VGA 12 #ff5555)", inkLong.ink === "red",
    "rgba " + pxLong.join(",") + " -> " + JSON.stringify(inkLong));

  const blueTired = ((await room()).sites || []).filter((s) => s.owner === "blue" && Number(s.readyRound) >= 21);
  mark("the server says that radius is >= 21 rounds out", blueTired.length > 0,
    blueTired.map((s) => s.name + " readyRound " + s.readyRound).slice(0, 4).join(", "));
  const siteLong = blueTired[0];
  await page.screenshot({ path: path.join(OUT, "pb165-red-box.png") });

  // --- 3. run the clock: the same cell decays to yellow, and yellow is still refused -----------
  const clockState = (await room()).clock;
  if (clockState === "held" || clockState === "paused") {
    await page.click("#clockBtn");
    await sleep(400);
  }
  await page.click("#speedUp").catch(() => {});
  await sleep(120);
  mark("the clock is running", (await room()).clock === "running",
    clockState + " -> " + (await room()).clock + " speed " + (await room()).speed);

  await waitRound(3);
  const inf2 = await arm("infantry");
  const h2 = counts(inf2);
  mark("the same radius reads the soon state (2) as the timer decays", (h2[2] || 0) > 0,
    "round " + (await room()).round + " " + JSON.stringify(h2));
  const soonCell = inf2.find((c) => cell && c.x === cell.x && c.y === cell.y);
  mark("the same cell is the one that decays to the soon state (2)", Boolean(soonCell) && soonCell.box === 2,
    "cell " + (cell ? cell.x + "," + cell.y : "none") + " box " + (soonCell ? soonCell.box : "absent")
      + " frame " + JSON.stringify(h2));
  const pxSoon = soonCell ? await sample(soonCell) : [0, 0, 0, 0];
  const inkSoon = await classify(pxSoon);
  const greenRef = pxReady ? await classify(pxReady) : { ink: "none", h: null };
  mark("a soon cell paints YELLOW against the green ready ink (VGA 14 #ffff55)",
    inkSoon.ink === "yellow" && inkSoon.h !== null && greenRef.h !== null
      && Math.abs(inkSoon.h - 60) <= 15 && Math.abs(greenRef.h - 120) <= 20 && Math.abs(inkSoon.h - greenRef.h) >= 30,
    "soon " + JSON.stringify(inkSoon) + " / green reference rgba " + (pxReady ? pxReady.join(",") : "none")
      + " " + JSON.stringify(greenRef));

  const beforeRefusal = ((await room()).pieces || []).length;
  if (soonCell) await clickCell(soonCell);
  const note = await page.evaluate(() => [
    window.__chq.toast ? window.__chq.toast() : "",
    document.getElementById("boardNote") ? document.getElementById("boardNote").textContent : "",
  ].join(" | "));
  const afterRefusal = ((await room()).pieces || []).length;
  mark("a soon cell places nothing", afterRefusal === beforeRefusal, "pieces " + beforeRefusal + " -> " + afterRefusal);
  mark("the refusal names the round", /isn't ready/.test(note) && /ready at round/.test(note),
    note.slice(0, 180).replace(/\s+/g, " "));
  await page.screenshot({ path: path.join(OUT, "pb165-yellow-box.png") });

  // --- 4. run to the ready round: the box returns to green ------------------------------------
  const readyAt = Number(siteLong && siteLong.readyRound) || 0;
  await waitRound(readyAt);
  const inf4 = await arm("infantry");
  const h4 = counts(inf4);
  mark("the long-wait cells are gone once their round arrives", !h4[3],
    "round " + (await room()).round + " " + JSON.stringify(h4));
  const backCell = inf4.find((c) => cell && c.x === cell.x && c.y === cell.y);
  const pxBack = backCell ? await sample(backCell) : [0, 0, 0, 0];
  const inkBack = await classify(pxBack);
  // The clause's pixel, asserted rather than printed: the ready ink on the SAME cell is 61,185,65.
  // +-10 per channel absorbs the probe's edge pixel, not the colour.
  const nearInk = (px, want) => px.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= 10);
  mark("the same cell is back to the ready ink rgba 61,185,65",
    Boolean(backCell) && backCell.box === 1 && inkBack.ink === "green" && nearInk(pxBack, [61, 185, 65]),
    "cell " + (cell ? cell.x + "," + cell.y : "none") + " box " + (backCell ? backCell.box : "absent")
      + " rgba " + pxBack.join(",") + " -> " + JSON.stringify(inkBack));

  mark("the page raised no script error", pageErrors.length === 0, pageErrors.join(" ; ").slice(0, 300));
} catch (err) {
  mark("leg threw", false, err && err.message ? err.message : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
  writeFileSync(path.join(OUT, "pb165-page-leg.json"), JSON.stringify(evidence, null, 2));
  const passed = evidence.filter((r) => r.ok).length;
  console.log("pb165 page leg: " + passed + " passed, " + (evidence.length - passed) + " failed, " + evidence.length + " checks");
  process.exit(failed === 0 && evidence.length >= 14 ? 0 : 1);
}
