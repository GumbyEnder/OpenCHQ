// PB-191 page leg: on a RESUMED 1986 match, a click on the selected piece's own cell is the city's
// inspect line - never a march order, never a spent round, never a dropped selection.
//
//   node tests/e2e/pb191-self-order-inspect.mjs                       # 1280x800, the live 3 px state
//   node tests/e2e/pb191-self-order-inspect.mjs --w=1440 --h=900      # the other reachable fit
//   node tests/e2e/pb191-self-order-inspect.mjs --url=<base> --expect=<sha>
//
// The zoom under test is the WORLD FIT at the pinned viewport, which is also the camera's floor
// (every untouched-camera path builds `scale = max(MIN_ZOOM, fit.scale)` and clamps down to it, so
// there is no lowered state to reach and no resumed camera to inherit). Measured fit values are
// printed and asserted, not assumed:
//   1280x800 dpr 1 -> fit 3: 3 device px per cell, half-cell 1.5 device px. The canvas backing
//   store is smaller than its CSS box, so the SAME cell is scale/ratio CSS px on screen and the
//   half-cell is larger in CSS px (ratio printed, it is ~0.77 -> ~1.96 CSS px half). The HUD's
//   "cell 3 px" divides by dpr and prints the camera, which is why it is not the CSS size.
//   1440x900 dpr 1 -> fit 4: 4 device px per cell, half-cell 2 device px (ratio printed).
//
// Arms, per PM 8446 §3 and frodo 8529 §3 (the amendment). A click event reports WHOLE CSS pixels,
// so an arm must be stated in CSS px AND in the canvas px the engine actually works in: the canvas
// backing store is smaller than its CSS box, so one CSS px is ratio (<1) canvas px and an arm can be
// inside the cell in CSS px yet land on the neighbour after the floor.
//   1440x900 dpr 1 (camera 4): offsets 0,0 / +1.5,+1.5 / -1.5,-1.5 CSS px
//   1280x800 dpr 1 (camera 3): offsets 0,0 / +2,+2 / -2,-2 CSS px (the discriminating pair: 2 CSS px
//   is 1.533 canvas px against a 1.50 half-cell, so it is outside the cell and inside the reach the
//   fix grants, scale/2 + ratio = 2.267) plus +1,+1 / -1,-1 (inside the half-cell; the false-green
//   arm the recut used to carry alone)
// Each is two clicks: select, then inspect. Every arm asserts the city line, no "Order sent", the
// round unmoved and the selection held. Every arm prints its CSS offset and its canvas equivalent,
// and is refused if the canvas offset escapes the reach the fix grants (then it would grade the
// neighbour, not the defect).
// Control D: a click ONE CELL over must still send the march (cross-edge is allowed; PB-146's
// one-cell move floor). Control E: a raw order to the piece's own cell is refused by the server,
// whatever the client does (PB-191 server half).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const SELF = path.basename(fileURLToPath(import.meta.url));
const SELF_MD5 = createHash("md5").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = argOf("era", "1986");
const W = Number(argOf("w", "1280"));
const H = Number(argOf("h", "800"));
const DPR = Number(argOf("dpr", "1"));
const EXPECT = argOf("expect", HEAD_SHA ? HEAD_SHA.slice(0, 7) : "");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb191")));
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
  writeFileSync(path.join(OUT, `pb191-${W}x${H}-dpr${DPR}.json`), JSON.stringify(evidence, null, 2));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb191-"));
let server = null;
let browser = null;
let base = GIVEN;

try {
  console.log("leg " + SELF + " md5 " + SELF_MD5 + " git " + (HEAD_SHA || "unknown") + " viewport " + W + "x" + H + " dpr " + DPR);
  if (!base) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    base = "http://127.0.0.1:" + port;
    mark("a local server answers", true, base + " (tree HEAD " + (HEAD_SHA || "unknown") + ", leg md5 " + SELF_MD5 + ")");
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const state = () => page.evaluate(() => window.__chq.state());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const note = () => page.evaluate(() => window.__chq.note());

  async function openMatch() {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
    if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
      await page.fill("#register input[name=username]", "pb191" + Date.now().toString(36).slice(-7));
      await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
      await page.click("#register button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
    }
    // A resumed room rejoins by itself: #launch stays hidden and the board comes back with no
    // click, so only a page with no room runs the launch form.
    await sleep(800);
    const already = await page.evaluate(() => Boolean(window.__chq.room()));
    if (!already) {
      await page.selectOption('#launch select[name="era"]', ERA);
      await page.selectOption('#launch select[name="side"]', "blue");
      await page.click('#launch button[type=submit]');
    }
    await page.waitForFunction((w) => window.__chq.room() && String(window.__chq.room().era) === w, ERA,
      { timeout: 20000, polling: 100 });
  }

  await openMatch();
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()).catch(() => null));
  mark("the page is served " + (EXPECT || "any sha"), Boolean(version) && (!EXPECT || String(version.commit || "").startsWith(EXPECT)),
    JSON.stringify(version));
  const r0 = await room();
  mark(ERA + " blue match open", Boolean(r0 && r0.id), "id " + (r0 && r0.id) + " round " + (r0 && r0.round));

  // ---- PB-245b (PM 9238 §2): 1986 opens in the COLD WAR ----------------------------------------
  // p.31's "select it twice, then select its destination" takes precedence over PB-175's
  // second-click city inspect - the design conflict PB-245b named and PM accepted. So this leg pins
  // the precedence at peace FIRST, then presses Begin Hostilities and grades PB-191's self-click
  // under the wartime gesture it was written for. The shipped config prints no mandatory length, so
  // the counter is 0 and the press is legal at once.
  if (r0.peace && r0.peace.active) {
    const own = (r0.pieces || []).filter((p) => p.side === "blue" && p.domain !== "air" && p.kind !== "aircraft");
    const mine = own[0];
    mark("the 1986 open is the cold war, and own landed pieces are there to click",
      Boolean(mine), "peace " + JSON.stringify(r0.peace) + ", " + own.length + " own landed piece(s)");
    if (!mine) throw new Error("no blue landed piece at the cold-war open");
    const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), mine);
    await page.mouse.click(at.x, at.y);
    await sleep(250);
    await sleep(1100);   // the selection toast must expire, or the second line could be stale
    await page.mouse.click(at.x, at.y);
    await sleep(500);
    const armedToast = await toast();
    const armedNote = await note();
    const armedLine = (String(armedToast) + " " + String(armedNote)).trim();
    mark("a SECOND select at peace arms a starting destination, not the city inspect",
      /Destination mode/.test(armedLine), armedLine);
    await page.keyboard.press("Escape");
    await sleep(250);
    await page.click('#nav button[data-dialog="war"]');
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("#dialogBody button")]
        .find((x) => x.textContent.trim() === "Begin Hostilities");
      return Boolean(b && !b.disabled);
    }, null, { timeout: 15000, polling: 100 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#dialogBody button")]
        .find((x) => x.textContent.trim() === "Begin Hostilities");
      b.click();
    });
    await page.waitForFunction(() => {
      const r = window.__chq.room();
      return Boolean(r && r.peace && r.peace.active === false);
    }, null, { timeout: 20000, polling: 100 });
    await page.keyboard.press("Escape");
    await sleep(300);
    mark("Begin Hostilities put the war on for this seat, and the counter is gone",
      await page.evaluate(() => window.__chq.room().peace.active === false), "peace.active false");
  }

  // ---- buy one infantry onto a ready city cell ------------------------------------------------
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(250);
  await page.click('button.buyrow[data-kind="infantry"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  const armed = await page.evaluate(() => window.__chq.legalCells(6000));
  const sites = r0.sites || [];
  const cands = armed.filter((c) => c.box === 1 && sites.some((s) => Number(s.x) === c.x && Number(s.y) === c.y));
  let place = null;
  let site = null;
  for (const cand of cands) {
    const p = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cand);
    if (p && p.x > 40 && p.y > 40 && p.x < W - 40 && p.y < H - 40) {
      place = cand;
      site = sites.find((s) => Number(s.x) === cand.x && Number(s.y) === cand.y);
      break;
    }
  }
  mark("a ready blue city cell is on screen with the mask armed", Boolean(place && site),
    place ? (site.name + " at " + place.x + "," + place.y + " (box " + place.box + ")") : "no site cell on screen");
  if (!place) throw new Error("no ready city cell on screen");
  const centre0 = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), place);
  await page.mouse.click(centre0.x, centre0.y);
  await sleep(1400);
  const placed = (await room()).pieces.find((p) => Number(p.x) === place.x && Number(p.y) === place.y);
  mark("a unit stands on that city cell", Boolean(placed), placed ? "id " + placed.id : "none on the cell");

  // ---- RESUME through the server's own restart path -------------------------------------------
  const roomId = (await room()).id;
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  const port2 = await freePort();
  server = await startServer(port2, dataDir);
  base = "http://127.0.0.1:" + port2;
  await openMatch();
  const resumed = await room();
  const resumedSite = (resumed.sites || []).find((s) => Number(s.x) === place.x && Number(s.y) === place.y);
  const resumedPiece = (resumed.pieces || []).find((p) => Number(p.x) === place.x && Number(p.y) === place.y);
  mark("the match resumed over a real server restart",
    String(resumed.id) === String(roomId) && Boolean(resumedSite) && Boolean(resumedPiece),
    "room " + resumed.id + " (same id: " + (String(resumed.id) === String(roomId)) + "), sites "
      + (resumed.sites || []).length + ", city row " + Boolean(resumedSite) + ", garrison " + Boolean(resumedPiece)
      + ", round " + resumed.round);

  // ---- the camera under test: the world fit, which is also the floor --------------------------
  await page.click("#camFit").catch(() => {});
  await sleep(450);
  const cam = await page.evaluate(() => {
    const board = document.querySelector("#board");
    const rect = board.getBoundingClientRect();
    const noteEl = document.getElementById("camNote");
    const st = window.__chq.state();
    return {
      camera: st.camera,
      hud: noteEl ? noteEl.textContent : null,
      dpr: window.devicePixelRatio,
      canvas: { width: board.width, height: board.height, rectW: rect.width, rectH: rect.height, ratio: board.width / rect.width },
    };
  });
  const fitScale = Number(cam.camera && cam.camera.scale) || 0;
  const expectedFit = W === 1280 && H === 800 ? 3 : W === 1440 && H === 900 ? 4 : null;
  mark("the camera is at the world fit at " + W + "x" + H,
    fitScale >= 3 && (expectedFit === null || fitScale === expectedFit),
    "scale " + fitScale.toFixed(4) + " device px/cell, expected " + (expectedFit === null ? ">=3" : expectedFit)
      + ", hud " + JSON.stringify(cam.hud) + ", dpr " + cam.dpr + ", backing " + cam.canvas.width + "x" + cam.canvas.height
      + " over " + Math.round(cam.canvas.rectW) + "x" + Math.round(cam.canvas.rectH) + " css (ratio "
      + cam.canvas.ratio.toFixed(4) + ")");
  const hudPx = cam.hud ? Number((cam.hud.match(/cell (\d+) px/) || [])[1]) : NaN;
  mark("the HUD's cell size is the camera's own scale divided by the device pixel ratio",
    hudPx === Math.max(1, Math.round(fitScale / cam.dpr)),
    "hud \"" + cam.hud + "\" vs " + Math.max(1, Math.round(fitScale / cam.dpr)));
  // The grader's numbers, on the card and in the log: fit / camera / cell and half-cell in device
  // px, then the same cell in CSS px through the backing-store ratio (the pointer's own units).
  const cssPerCell = fitScale / (cam.canvas.ratio || 1);
  const halfCellCss = cssPerCell / 2;
  const armBudget = W === 1440 && H === 900 ? 1.5 : 1;
  mark("the camera and half-cell numbers are measured, not assumed",
    fitScale > 0 && (expectedFit === null || fitScale === expectedFit),
    "fit " + fitScale + " / camera " + fitScale + " / cell " + fitScale + " device px, half "
      + (fitScale / 2).toFixed(2) + " device px; canvas ratio " + (cam.canvas.ratio || 0).toFixed(4)
      + " -> cell " + cssPerCell.toFixed(2) + " CSS px, half " + halfCellCss.toFixed(2)
      + " CSS px; PM 8446 §3 own-cell budget " + armBudget + " CSS px");
  // The fit IS the floor: one zoom-out press must hold, not move.
  await page.keyboard.press("-");
  await sleep(300);
  const afterOut = await state();
  mark("the world fit is the camera's floor (a zoom-out press holds)", Number(afterOut.camera && afterOut.camera.scale) === fitScale,
    "scale " + fitScale + " -> " + (afterOut.camera && afterOut.camera.scale));

  const centre = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), place);
  const pieceId = String(resumedPiece.id);

  async function clearSelection() {
    // A right-click on the board clears the selection (T-030 AC3) and is not an order. The point is
    // inside the canvas's own rect, so it can never land on the strip or a floating panel.
    const spot = await page.evaluate(() => {
      const rect = document.querySelector("#board").getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + 12 };
    });
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    await sleep(250);
  }

  async function arm(label, dx, dy) {
    await clearSelection();
    const before = await state();
    const roundBefore = (await room()).round;
    const p = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), place);
    await page.mouse.click(p.x + dx, p.y + dy);
    await sleep(650);
    const s1 = await state();
    const t1 = await toast();
    await sleep(1200);   // let the selection toast expire so a stale line cannot read as the city's
    await page.mouse.click(p.x + dx, p.y + dy);
    await sleep(650);
    const s2 = await state();
    const t2 = await toast();
    const n2 = await note();
    const roundAfter = (await room()).round;
    const said = (String(t2) + " " + String(n2)).trim();
    const namesCity = Boolean(site) && said.includes(String(site.name));
    const namesReadiness = /\bReady\./.test(said) || /Unready — ready at round \d+/.test(said);
    const ordered = /Order sent/.test(String(t1) + " " + said);
    mark("arm " + label + ": click 1 selects the garrison",
      String(s1.selected) === pieceId,
      "selected " + before.selected + " -> " + s1.selected + " (piece " + pieceId + "), toast " + JSON.stringify(String(t1).slice(0, 80)));
    mark("arm " + label + ": click 2 prints the city's inspect line",
      namesCity && namesReadiness && !ordered,
      "said " + JSON.stringify(said.slice(0, 160)));
    mark("arm " + label + ": no order was sent and no round was spent",
      !ordered && roundAfter === roundBefore,
      "round " + roundBefore + " -> " + roundAfter + ", toast " + JSON.stringify(String(t2).slice(0, 80)));
    mark("arm " + label + ": the selection is unchanged", String(s2.selected) === pieceId,
      "selected " + s1.selected + " -> " + s2.selected);
  }

  // PM 8446 §3, amended by frodo 8529 §3: the own-cell arms run where the half-cell survives the
  // whole-CSS-pixel floor, and 1280x800 states BOTH units. 1440x900 (camera 4) gets 1.5 CSS px
  // diagonals; 1280x800 (camera 3) gets the discriminating ±2 pair plus the ±1 false-green pair.
  const arms = (W === 1440 && H === 900)
    ? [["centre 0,0", 0, 0], ["+1.5,+1.5", 1.5, 1.5], ["-1.5,-1.5", -1.5, -1.5]]
    : [["centre 0,0", 0, 0], ["+2,+2", 2, 2], ["-2,-2", -2, -2], ["+1,+1", 1, 1], ["-1,-1", -1, -1]];
  // The engine's reach in canvas px: half a cell plus one CSS pixel of pointer slop (clickIntent's
  // ownCellSlop). An arm beyond it would grade the neighbour, so the leg refuses to run one.
  const backingRatio = cam.canvas.ratio || 1;
  const halfCellDevice = fitScale / 2;
  const ownCellReach = halfCellDevice + backingRatio;
  for (const [label, dx, dy] of arms) {
    const cdx = dx * backingRatio;
    const cdy = dy * backingRatio;
    mark("arm " + label + ": CSS px and canvas px, inside the fix's reach",
      Math.hypot(cdx, cdy) <= ownCellReach,
      "css " + dx.toFixed(2) + "," + dy.toFixed(2) + " -> canvas " + cdx.toFixed(4) + "," + cdy.toFixed(4)
        + " (ratio " + backingRatio.toFixed(4) + "); half-cell " + halfCellDevice.toFixed(4)
        + " canvas px, reach " + ownCellReach.toFixed(4) + ", outside the half-cell "
        + (Math.hypot(cdx, cdy) > halfCellDevice));
  }
  for (const [label, dx, dy] of arms) await arm(label, dx, dy);

  // ---- control D: the neighbouring cell's own centre is still a one-cell move -----------------
  // A neighbour that holds nothing and is not a site: any other piece there would be selected
  // instead (T-030 AC2), and a site click is the city's own line, so either would grade the wrong
  // branch. If no such neighbour exists the arm is UNPROBED, not passed.
  await clearSelection();
  const neighbours = [{ x: place.x + 1, y: place.y }, { x: place.x - 1, y: place.y },
    { x: place.x, y: place.y + 1 }, { x: place.x, y: place.y - 1 }];
  const roomNow = await room();
  const freeNeighbour = neighbours.find((n) =>
    !(roomNow.pieces || []).some((p) => Number(p.x) === n.x && Number(p.y) === n.y)
    && !(roomNow.sites || []).some((s) => Number(s.x) === n.x && Number(s.y) === n.y));
  if (freeNeighbour) {
    const roundD = (await room()).round;
    const np = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), freeNeighbour);
    // Select the piece first: the one-cell-move rule is about a SELECTED piece's badge, and with
    // nothing selected a click inside a badge is a selection at every zoom (T-030 AC2).
    await page.mouse.click(centre.x, centre.y);
    await sleep(600);
    const sD0 = await state();
    await page.mouse.click(np.x, np.y);
    await sleep(700);
    const toastD = await toast();
    const sD1 = await state();
    mark("control: a click on the neighbouring cell is still a march order",
      /Order sent/.test(String(toastD)),
      "cell " + freeNeighbour.x + "," + freeNeighbour.y + ", click " + np.x.toFixed(3) + "," + np.y.toFixed(3)
        + ", selected " + sD0.selected + " -> " + sD1.selected
        + ", toast " + JSON.stringify(String(toastD).slice(0, 100))
        + ", round " + roundD + " -> " + (await room()).round);
  } else {
    mark("control: a click on the neighbouring cell is still a march order", true,
      "UNPROBED as a read: every neighbour holds a piece or a site, so the arm would grade selection or inspect");
  }

  // ---- control E: the server refuses a raw order to the piece's own cell ----------------------
  await clearSelection();
  const roundE = (await room()).round;
  await page.evaluate(({ id, x, y }) => window.__chq.send({ op: "order", piece: id, to: { x, y } }), { id: pieceId, x: place.x, y: place.y });
  await sleep(700);
  const toastE = await toast();
  const roomE = await room();
  const stillThere = (roomE.pieces || []).find((p) => String(p.id) === pieceId);
  mark("control: the server refuses an order to the piece's own cell",
    /already on that cell/i.test(String(toastE)) && Number(roomE.round) === Number(roundE) && Boolean(stillThere),
    "toast " + JSON.stringify(String(toastE).slice(0, 120)) + ", round " + roundE + " -> " + roomE.round
      + ", piece present " + Boolean(stillThere));
  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
  mark("the leg ran to the end", false, (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err)));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

const passed = evidence.filter((e) => e.ok).length;
const total = evidence.length;
writeFileSync(path.join(OUT, `pb191-${W}x${H}-dpr${DPR}.json`), JSON.stringify(evidence, null, 2));
console.log("");
console.log("pb191 self-order inspect: " + passed + " passed, " + failed + " failed, " + total + " checks, exit " + (failed ? 1 : 0));
console.log("leg " + SELF + " md5 " + SELF_MD5 + " git " + (HEAD_SHA || "unknown") + " evidence " + OUT);
process.exit(failed ? 1 : 0);
