// PB-182 page leg: with a unit armed and NEVER re-armed, do the placement highlights follow the
// readiness timer as the rounds pass, so one cell walks long(RED) -> soon(YELLOW) -> ready(GREEN)?
//
//   node tests/e2e/pb182-armed-decay.mjs                    # starts its own server from this tree
//   node tests/e2e/pb182-armed-decay.mjs --url=<base>       # use a running server
//   node tests/e2e/pb182-armed-decay.mjs --expect=<sha>     # require that sha at /api/version
//
// The defect this leg was cut for (PM 8247 §2): `placement` in web/public/app.js is a SNAPSHOT
// taken once when the row is armed. Only the arm click ever asked the server for the mask, so a
// unit kept armed across a round boundary painted its arm-time boxes forever: every cell stayed
// yellow from r70 to r77, while inspect said "Ready." The PB-165 leg missed it because it re-armed
// at every read (arm() before each legalCells call), which re-took the snapshot at the new round.
//
// Method. ONE arm click, then place an infantry on a ready cell and leave the cursor armed. The
// placed city comes back 22 rounds out, so the cell the piece stands on and the cells around it
// carry mask box 3 (long) at first sight. Every round after that this leg reads legalCells() and
// samples the SAME coordinates — no arm() call, no disarm, nothing that could re-take the mask —
// and asserts the box byte and the painted ink decay together. The fixed page re-requests the mask
// on every round delta (applyDelta); the mutant arm (that one line removed) keeps the arm-time
// mask, never shows a box 3, and reds at the first decay check.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb182")));
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


const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  writeFileSync(path.join(OUT, "pb182-page-leg.json"), JSON.stringify(evidence, null, 2));
  return Boolean(ok);
}

// The three inks, in hue terms: red 0, yellow 60, green 120 (VGA 12/14/10, PB-165). Blending with
// the dark board keeps the hue and drops the value, so classification is hue + saturation.
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb182-"));
let server = null;
let browser = null;
let BASE = GIVEN;
let armClicks = 0;

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

  // Most saturated pixel of a 3x3 probe around the cell centre: the box ink is a thin ring and the
  // centre pixel can land on terrain between strokes (the PB-165 reference failure).
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

  async function onScreen(cell) {
    return page.evaluate(({ x, y }) => {
      const p = window.__chq.cellToScreen(x, y);
      const vp = { w: window.innerWidth, h: window.innerHeight };
      return Boolean(p) && p.x > 3 && p.y > 3 && p.x < vp.w - 3 && p.y < vp.h - 3;
    }, cell);
  }

  let boardClicks = 0;
  async function clickCell(cell) {
    boardClicks += 1;
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
    await page.fill("#register input[name=username]", "pb182" + Date.now().toString(36).slice(-7));
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

  // --- the only arm click in this leg ---
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(250);
  await page.click('button.buyrow[data-kind="infantry"]');
  armClicks += 1;
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(350);
  const armed = await legal();
  const hArmed = counts(armed);
  mark("one arm click paints the mask", armed.length > 0, JSON.stringify(hArmed));

  // A green reference: a box-1 cell inside the viewport that classifies green. Cells off screen
  // read zeros from getImageData and would look unpainted, so visibility is filtered first.
  let pxGreenRef = null;
  let placeCell = null;
  let greenTried = 0;
  for (const cell of armed.filter((c) => c.box === 1).slice(0, 60)) {
    if (greenTried >= 12) break;
    if (!(await onScreen(cell))) continue;
    greenTried += 1;
    const px = await sample(cell);
    const ink = await classify(px);
    if (ink.ink === "green") { pxGreenRef = px; placeCell = cell; break; }
  }
  mark("a ready cell carries the green box ink", Boolean(pxGreenRef),
    pxGreenRef ? "rgba " + pxGreenRef.join(",") + " on cell " + placeCell.x + "," + placeCell.y : "no green probe");

  // --- place one infantry. The purchase ends the arm (the server's ack clears it), so re-arm ONCE
  // here; that is the snapshot the decay read starts from, and it is the last arm click in the leg. ---
  const before = ((await room()).pieces || []).length;
  let bought = before;
  for (let attempt = 1; attempt <= 3 && bought !== before + 1; attempt += 1) {
    if (placeCell) await clickCell(placeCell);
    await sleep(1200);
    bought = ((await room()).pieces || []).length;
    // PB-185: a loaded live host can swallow the first placement click (measured: pieces 2 -> 2,
    // arm still true). Retry on the SAME cell — a board click, not a re-arm.
    if (bought !== before + 1) await sleep(500);
  }
  mark("a ready cell places the piece", bought === before + 1, "pieces " + before + " -> " + bought);
  const armedAfterBuy = await page.evaluate(() => window.__chq.state());
  mark("the purchase ends the arm, so the snapshot is re-taken once", armedAfterBuy.buying === null && armedAfterBuy.placement === false,
    JSON.stringify(armedAfterBuy));

  await page.click('#nav button[data-dialog="buy"]');
  await sleep(250);
  await page.click('button.buyrow[data-kind="infantry"]');
  armClicks += 1;
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(350);
  const armed2 = await legal();
  const hArmed2 = counts(armed2);
  mark("the re-armed snapshot carries the built city's long-wait radius (box 3)", (hArmed2[3] || 0) > 0,
    JSON.stringify(hArmed2));

  // Run the clock at speed 6 (0.6 s/round in config/game.json) after the track cell is chosen.

  // --- the decay read: NO arm() from here to the end of the leg ---
  // Pick the cell to track from the re-armed snapshot's box-3 list, then read the SAME coordinate
  // every round. The tracked cell is a neighbour of the built city (its own centre is the city
  // glyph, PB-165), so it starts long and decays with that city's ready round. Only cells inside
  // the canvas viewport are probed: getImageData outside it reads zeros and would look unpainted.
  const placedRound = Number((await room()).round) || 0;
  const sites = ((await room()).sites || []).filter((s) => s.owner === "blue" && Number(s.readyRound) > 0);
  const latest = sites.sort((a, b) => Number(b.readyRound) - Number(a.readyRound))[0];
  const readyAt = Number(latest && latest.readyRound) || 0;

  let track = null;
  let pxLong = null;
  let box3Seen = hArmed2[3] || 0;
  const visible = [];
  for (const cand of armed2.filter((c) => c.box === 3)) {
    if (visible.length >= 12) break;
    if (await onScreen(cand)) visible.push(cand);
  }
  if (!visible.length) {
    await page.click("#camFit").catch(() => {});
    await sleep(300);
    for (const cand of armed2.filter((c) => c.box === 3)) {
      if (visible.length >= 12) break;
      if (await onScreen(cand)) visible.push(cand);
    }
  }
  for (const cand of visible) {
    const px = await sample(cand);
    const ink = await classify(px);
    if (ink.ink === "red") {
      track = { x: cand.x, y: cand.y };
      pxLong = px;
      break;
    }
  }
  mark("the arm-time snapshot is replaced: a long-wait cell appears with NO re-arm", Boolean(track) && box3Seen > 0,
    "box3 count " + box3Seen + ", " + visible.length + " on screen"
      + (track ? " at " + track.x + "," + track.y + " round " + placedRound : " (no red among them)"));
  if (track) {
    const inkLong = await classify(pxLong);
    mark("that cell paints RED while its wait is long", inkLong.ink === "red",
      "rgba " + pxLong.join(",") + " -> " + JSON.stringify(inkLong));
  }
  mark("the server names a ready round for the built city", readyAt > placedRound,
    (latest ? latest.name + " readyRound " + latest.readyRound : "none") + ", now round " + placedRound);

  // PB-185: the BEFORE state comes from the arm-time snapshot, never from the first read of the loop.
  // The speed ramp (held clock -> speed 6) costs one or two rounds at 0.6 s/round, so on a live board
  // the loop's first sample can land after this cell's two-round box-3 window; `series` then holds no
  // box-3 row and the transition was asserted against a state the leg never saw — while the two
  // checks above had already passed ON that box 3. The mask row for the tracked cell at placedRound
  // is box 3 by construction: the cell was picked out of armed2's box-3 list.
  const armBox = track
    ? (armed2.find((c) => c.x === track.x && c.y === track.y) || {}).box
    : null;

  // Start the clock only now, so the decay happens under the read loop at speed 6 (0.6 s/round).
  const clock0 = (await room()).clock;
  if (clock0 === "held" || clock0 === "paused") {
    await page.click("#clockBtn");
    await sleep(400);
  }
  for (let i = 0; i < 24; i += 1) {
    if (Number((await room()).speed) >= 6) break;
    // A disabled #speedUp makes Playwright wait out its actionability timeout (30 s of rounds);
    // cap it so a leg failure is a check, not half a minute of unwatched clock. PB-185: the ramp
    // also gets more attempts — a loaded live host dropped clicks and left the clock at speed 2.
    await page.click("#speedUp", { timeout: 800 }).catch(() => {});
    await sleep(180);
  }
  await sleep(400);
  const speedState = await room();
  mark("the clock is running at speed 6", speedState.clock === "running" && Number(speedState.speed) === 6,
    clock0 + " -> " + speedState.clock + " speed " + speedState.speed);

  const startRound = Number((await room()).round) || 0;
  console.log("decay read begins at round " + placedRound + " (arm-time snapshot); first clock read at round "
    + startRound + ", readyAt " + readyAt + ", speed " + speedState.speed);
  const series = [];
  let armStateBroken = null;
  const clicksAtDecayStart = boardClicks;
  // ONE evaluate per sample, so the round, the mask byte and the pixel are read at the same instant
  // and the loop is cheap enough to see every round at speed 6 (0.6 s/round). Before PB-185 this was
  // five separate evaluates per iteration; on the live host a single slow reply stretched an
  // iteration past a round (measured: rounds 9 -> 24 in one step, 15 rounds unobserved), and the
  // crossing check then red against a correct page because the sampler, not the page, had skipped.
  const snapshot = () => page.evaluate(({ cell, name, activeName, width }) => {
    const r = window.__chq.room();
    const cells = window.__chq.legalCells(6000);
    const hit = cell ? cells.find((c) => c.x === cell.x && c.y === cell.y) : null;
    const st = window.__chq.state();
    let px = [0, 0, 0, 0];
    if (cell) {
      const centre = window.__chq.cellToScreen(cell.x, cell.y);
      const cv = document.getElementById("board");
      const rect = cv.getBoundingClientRect();
      const g = cv.getContext("2d");
      let bestSat = -1;
      for (let dx = -2; dx <= 2; dx += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          const d = g.getImageData(
            Math.round((centre.x + dx - rect.left) * (cv.width / rect.width)),
            Math.round((centre.y + dy - rect.top) * (cv.height / rect.height)),
            1, 1,
          ).data;
          const max = Math.max(d[0], d[1], d[2]);
          const min = Math.min(d[0], d[1], d[2]);
          const sat = max ? (max - min) / max : 0;
          if (sat > bestSat && max > 40) { bestSat = sat; px = [d[0], d[1], d[2], d[3]]; }
        }
      }
    }
    const ink = window.__chqClassify(px);
    const site = (r.sites || []).find((s) => s.name === (name || activeName));
    return { round: Number(r.round) || 0, box: hit ? hit.box : null, ink: ink.ink, h: ink.h,
      rgba: px.join(","), readyRound: site ? Number(site.readyRound) : null, clock: r.clock,
      speed: r.speed, buying: st.buying, placement: st.placement };
  }, { cell: track, name: latest && latest.name, activeName: latest && latest.name, width: 320 });

  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const s = await snapshot();
    if (s.buying !== "infantry" || s.placement !== true) armStateBroken = { round: s.round, state: s };
    const last = series[series.length - 1];
    if (!last || s.round !== last.round) {
      series.push({ round: s.round, box: s.box, ink: s.ink, h: s.h, rgba: s.rgba,
        readyRound: s.readyRound, clock: s.clock, speed: s.speed });
      writeFileSync(path.join(OUT, "pb182-decay-series.json"), JSON.stringify({ track, readyAt, series }, null, 2));
    }
    if (s.round >= readyAt + 3) break;
    await sleep(60);
  }

  const firstBox = series.find((row) => row.box === 3)
    || (armBox === 3 ? { round: placedRound, box: 3, fromArm: true } : null);
  const firstSoon = series.find((row) => row.box === 2);
  const firstReady = series.find((row) => row.box === 1 && row.round > (firstBox ? firstBox.round : 0));
  const yellow = series.find((row) => row.ink === "yellow");
  const green = series.find((row) => row.ink === "green");
  mark("the cell leaves the long state on its own (box 3 -> 2)", Boolean(firstBox && firstSoon) && firstSoon.round > firstBox.round,
    "box3 at " + (firstBox && firstBox.round) + (firstBox && firstBox.fromArm ? " (arm-time)" : "")
      + ", box2 at " + (firstSoon && firstSoon.round));
  mark("the cell reaches the ready state (box 2 -> 1)", Boolean(firstSoon && firstReady) && firstReady.round >= firstSoon.round,
    "box1 at " + (firstReady && firstReady.round) + " (readyRound " + readyAt + ")");
  mark("the paint follows the box: a YELLOW read with no re-arm", Boolean(yellow) && yellow.ink === "yellow"
    && Math.abs(Number(yellow.h) - 60) <= 15,
    yellow ? "round " + yellow.round + " h" + yellow.h + " rgba " + yellow.rgba : "no yellow in " + series.length + " rounds");
  mark("the paint follows the box: a GREEN read with no re-arm", Boolean(green)
    && Math.abs(Number(green.h) - 120) <= 20,
    green ? "round " + green.round + " h" + green.h + " rgba " + green.rgba : "no green in " + series.length + " rounds");

  // AC (b): no read may paint ready before the server's readyRound, none may still paint soon after
  // it, and the first ready read carries that readyRound in the SAME read. PB-185: the old form also
  // demanded firstReady.round === readyAt, which is a property of the sampler, not of the page — on a
  // loaded live host a stalled iteration skips rounds (measured: rounds 9 -> 24 in one step), so the
  // first sight of box 1 can legitimately land at 24 on a page that turned at 22.
  const earlyReady = series.filter((row) => row.box === 1 && Number(row.round) < readyAt);
  // The boundary round itself may still carry byte 2: the mask is re-requested on the round delta, so
  // a read taken at round 22 before that delta lands sees round 22 with round-21's mask. Past the
  // boundary round, a 2 is a real disagreement.
  const lateSoon = series.filter((row) => row.box === 2 && Number(row.round) > readyAt);
  mark("no read paints ready before the server's readyRound, and the first ready read carries it",
    Boolean(firstReady) && Number(firstReady.readyRound) === readyAt
      && Number(firstReady.round) >= readyAt && earlyReady.length === 0 && lateSoon.length === 0,
    firstReady ? "first box 1 at round " + firstReady.round + ", server readyRound " + firstReady.readyRound
      + ", card " + readyAt + "; ready-painted before the mask " + earlyReady.length
      + " times, soon-painted after it " + lateSoon.length + " times"
      : "no crossing read");

  // AC (c): the reference is the cell's OWN green at the moment it turns, not a different cell and
  // not a dark pixel (rgba 17,32,30 was the wrong instrument once already). The exact rgba is not
  // pinned: the ready ink reads 61,185,65 on an idle board and 74,223,76 under a live cursor, both
  // h121-122 and both lit, so the assertion is the green family on this coordinate.
  const ownGreen = firstReady ? series.find((row) => row.round === firstReady.round) : null;
  const ownGreenPx = ownGreen ? ownGreen.rgba.split(",").map(Number) : [];
  const ownGreenLit = ownGreenPx.length === 4 && Math.max(ownGreenPx[0], ownGreenPx[1], ownGreenPx[2]) >= 100;
  const hueGap = Boolean(yellow && ownGreen) ? Math.abs(Number(yellow.h) - Number(ownGreen.h)) : 0;
  mark("the YELLOW is measured against the cell's own green at the crossing",
    Boolean(yellow && ownGreen) && hueGap >= 30 && ownGreenLit
      && Number(ownGreen.h) >= 100 && Number(ownGreen.h) <= 140,
    ownGreen ? "yellow h" + (yellow && yellow.h) + " vs own green h" + ownGreen.h
      + " rgba " + ownGreen.rgba + ", gap " + hueGap : "no own-green read");

  // AC (d): the delta arm — the round counter moved under a running clock with no board click.
  const roundsSpanned = series.length ? Number(series[series.length - 1].round) - Number(series[0].round) : 0;
  mark("the round counter advanced 20+ rounds while armed with no board click", roundsSpanned >= 20
    && boardClicks === clicksAtDecayStart && series.every((row) => row.clock === "running"),
    "rounds " + series[0]?.round + ".." + series[series.length - 1]?.round + " (" + roundsSpanned + "), board clicks during decay "
      + (boardClicks - clicksAtDecayStart) + ", clock held " + series.every((row) => row.clock === "running"));
  mark("two arm clicks total: one to place, one snapshot for the decay, none during it", armClicks === 2, "arm clicks " + armClicks);
  mark("the cursor stayed armed through every round", armStateBroken === null,
    armStateBroken ? JSON.stringify(armStateBroken) : "buying infantry, placement true throughout");
  mark("the page raised no script error", pageErrors.length === 0, pageErrors.join(" ; ").slice(0, 300));
  console.log("decay series: " + JSON.stringify(series));
} catch (err) {
  mark("leg threw", false, err && err.message ? err.message : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
  writeFileSync(path.join(OUT, "pb182-page-leg.json"), JSON.stringify(evidence, null, 2));
  const passed = evidence.filter((r) => r.ok).length;
  console.log("pb182 page leg: " + passed + " passed, " + (evidence.length - passed) + " failed, " + evidence.length + " checks");
  process.exit(failed === 0 && evidence.length >= 12 ? 0 : 1);
}