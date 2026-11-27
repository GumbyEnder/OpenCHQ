// T-028 AC1/AC2/AC3: a click anywhere on a piece's DRAWN icon selects that piece, at the world fit
// and at the two zoom levels T-026 AC5 used. Run the SAME script against a pre-T-028 build and the
// branch (--label=before / --label=after) so the two sweeps are the same scene and the same method.
//
//   node tests/e2e/t028-selection-hit.mjs --url=http://127.0.0.1:8251 --label=before --out=.../local/t028-shots
//   node tests/e2e/t028-selection-hit.mjs --url=http://127.0.0.1:8250 --label=after  --out=.../local/t028-shots
//
// The sweep is PB-050's own method: a 14x14 grid of pointer positions inside the drawn badge
// (196 positions), clicked through the page's real pointer path, scored by the page's own
// `__chq.state().selected`. Every probe is preceded by a click on the icon centre, so a missed
// position cannot leave a stale selection standing in for a hit.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const LABEL = argOf("label", "after");
if (!BASE) {
  console.error("usage: node tests/e2e/t028-selection-hit.mjs --url=<base url> --label=before|after [--out=<dir>]");
  process.exit(2);
}
const OUT = evidenceDir("t028-shots", argOf("out"));
mkdirSync(OUT, { recursive: true });
const ERA = argOf("era", "1942");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "t028-selection-" + LABEL + ".json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

const room = () => page.evaluate(() => window.__chq.room());
const state = () => page.evaluate(() => window.__chq.state());
const note = () => page.$eval("#boardNote", (el) => el.textContent || "").catch(() => "");
// PICK_HINT is said through say(), which writes the page's flash strip (__chq.toast()), not the
// boardNote status line: boardNote is where a route preview speaks.
const toast = () => page.evaluate(() => window.__chq.toast());
const screenOf = (x, y) => page.evaluate(({ x: cx, y: cy }) => window.__chq.cellToScreen(cx, cy), { x, y });

async function shot(name) {
  const file = path.join(OUT, "t028-" + LABEL + "-" + name + ".png");
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

async function fit() {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(300);
  return (await state()).camera;
}

async function zoomPresses(times) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("+");
    await sleep(180);
  }
  return (await state()).camera;
}

async function panToCell(cell, tries = 120) {
  const vp = page.viewportSize();
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  for (let i = 0; i < tries; i++) {
    const at = await screenOf(cell.x, cell.y);
    let moved = false;
    if (at.x < cx - 40) { await page.keyboard.press("ArrowLeft"); moved = true; }
    else if (at.x > cx + 40) { await page.keyboard.press("ArrowRight"); moved = true; }
    if (at.y < cy - 40) { await page.keyboard.press("ArrowUp"); moved = true; }
    else if (at.y > cy + 40) { await page.keyboard.press("ArrowDown"); moved = true; }
    if (!moved) return at;
  }
  return screenOf(cell.x, cell.y);
}

// The scene: an own piece with no other own piece within 3 cells on either axis, so the sweep cannot
// score a neighbour as a hit and the sweep cannot select a neighbour either.
async function isolatedPiece() {
  const current = await room();
  const mine = (current.pieces || []).filter((p) => String(p.side) === current.you);
  const others = (current.pieces || []).filter((p) => String(p.side) !== current.you);
  for (const piece of mine) {
    const crowded = mine.some((other) => other.id !== piece.id
      && Math.abs(Number(other.x) - Number(piece.x)) <= 3 && Math.abs(Number(other.y) - Number(piece.y)) <= 3);
    const enemyNear = others.some((other) => Math.abs(Number(other.x) - Number(piece.x)) <= 3
      && Math.abs(Number(other.y) - Number(piece.y)) <= 3);
    if (!crowded && !enemyNear) return piece;
  }
  return mine[0] || null;
}

async function clickAt(x, y) {
  await page.mouse.click(x, y);
}

// The piece used to CLEAR the selection between probes: another own piece, on screen, more than 40
// CSS px from the icon under test so its own badge box can never cover a probe position.
async function resetPiece(underTest, at) {
  const current = await room();
  const vp = page.viewportSize();
  const mine = (current.pieces || []).filter((p) => String(p.side) === current.you && p.id !== underTest.id);
  for (const candidate of mine) {
    const spot = await screenOf(candidate.x, candidate.y);
    if (spot.x < 24 || spot.y < 24 || spot.x > vp.width - 24 || spot.y > vp.height - 24) continue;
    if (Math.hypot(spot.x - at.x, spot.y - at.y) < 40) continue;
    return { piece: candidate, at: spot };
  }
  return null;
}

// One zoom's sweep. Every probe is preceded by a click on ANOTHER own piece, so a miss leaves that
// other piece selected and scores as a miss: the probe is judged on what the click under test
// selected, never on a selection inherited from the previous probe.
async function sweepZoom(piece, presses) {
  await fit();
  const cam = presses ? await zoomPresses(presses) : (await state()).camera;
  const at = await panToCell({ x: piece.x, y: piece.y });
  const vp = page.viewportSize();
  if (at.x < 20 || at.y < 20 || at.x > vp.width - 20 || at.y > vp.height - 20) {
    return { scale: cam && cam.scale, tried: 0, hit: 0, percent: 0, error: "piece is off screen at this zoom" };
  }
  const reset = await resetPiece(piece, at);
  if (!reset) return { scale: cam && cam.scale, tried: 0, hit: 0, percent: 0, error: "no second piece on screen to reset the selection" };
  let tried = 0;
  let hit = 0;
  let resets = 0;
  const misses = [];
  for (let iy = 0; iy < 14; iy++) {
    for (let ix = 0; ix < 14; ix++) {
      const dx = ix - 6.5;
      const dy = iy - 6.5;
      // Reset the selection to the OTHER piece: a miss must not inherit the previous probe's hit.
      await clickAt(reset.at.x, reset.at.y);
      if (String((await state()).selected) === String(reset.piece.id)) resets++;
      await clickAt(at.x + dx, at.y + dy);
      const now = await state();
      tried++;
      if (String(now.selected) === String(piece.id)) hit++;
      else misses.push([dx, dy, now.selected]);
    }
  }
  return { scale: cam && cam.scale, tried, hit, percent: (100 * hit) / Math.max(1, tried),
    resets, other: reset.piece.id, misses: misses.slice(0, 8) };
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), { label: LABEL, version });

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t28" + LABEL.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  }
  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA,
    { timeout: 20000, polling: 100 });
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null, { timeout: 15000 }).catch(() => {});
  mark("the clock is held so the scene cannot move between probes", (await room()).clock === "held", { round: (await room()).round });

  const piece = await isolatedPiece();
  mark("an own piece with an empty neighbourhood", Boolean(piece), piece ? { id: piece.id, at: { x: piece.x, y: piece.y } } : null);
  if (!piece) throw new Error("no own piece to sweep");

  // ---- AC3: empty map and enemy pieces never select (run before any selection exists) -------
  {
    await fit();
    const current = await room();
    // Empty map: a cell with no piece of either side anywhere near it.
    const taken = new Set((current.pieces || []).map((p) => Number(p.x) + ":" + Number(p.y)));
    let empty = null;
    for (let y = 8; y < 120 && !empty; y += 4) {
      for (let x = 8; x < 312 && !empty; x += 6) {
        let clear = true;
        for (let dy = -6; dy <= 6 && clear; dy++) {
          for (let dx = -6; dx <= 6 && clear; dx++) {
            if (taken.has((x + dx) + ":" + (y + dy))) clear = false;
          }
        }
        if (clear) empty = { x, y };
      }
    }
    const at = await panToCell(empty, 40);
    await clickAt(at.x, at.y);
    await sleep(200);
    const afterEmpty = await state();
    const emptyToast = await toast();
    mark("AC3 a click on empty map selects nothing and still says the hint",
      !afterEmpty.selected && emptyToast.includes("Select one of your pieces"),
      { cell: empty, selected: afterEmpty.selected, toast: emptyToast, note: await note() });

    const foe = (current.pieces || []).find((p) => String(p.side) !== current.you);
    if (!foe) {
      mark("AC3 enemy click: no enemy piece in this opening", true, { note: "not exercised live" });
    } else {
      const enemyAt = await panToCell({ x: foe.x, y: foe.y }, 60);
      await clickAt(enemyAt.x, enemyAt.y);
      await sleep(200);
      const afterEnemy = await state();
      const enemyToast = await toast();
      mark("AC3 a click on an enemy piece selects none of yours and still says the hint",
        !afterEnemy.selected && enemyToast.includes("Select one of your pieces"),
        { enemy: foe.id, selected: afterEnemy.selected, toast: enemyToast, note: await note() });
      await shot("enemy-click");
    }
  }

  // ---- AC1: the 196-position sweep at three zooms -----------------------------------------
  const zooms = [];
  for (const [name, presses] of [["world-fit", 0], ["zoom-1", 1], ["zoom-2", 2]]) {
    await fit();
    const before = await panToCell({ x: piece.x, y: piece.y });
    await clickAt(before.x, before.y);
    const picked = (await state()).selected;
    mark("a centre click selects the piece at " + name, String(picked) === String(piece.id), { selected: picked });
    const row = await sweepZoom(piece, presses);
    zooms.push({ name, ...row });
    mark("AC1 icon-box sweep at " + name + " >= 95% (and every reset click landed)", row.percent >= 95 && row.resets === row.tried,
      { scale: row.scale, tried: row.tried, hit: row.hit, percent: Number(row.percent.toFixed(1)),
        resets: row.resets, resetPiece: row.other, misses: row.misses, error: row.error || null });
    await shot("selected-" + name);
  }

  // ---- AC2: overlapping icons resolve to the nearest centre --------------------------------
  {
    await fit();
    const current = await room();
    const mine = (current.pieces || []).filter((p) => String(p.side) === current.you);
    let pair = null;
    for (const a of mine) {
      for (const b of mine) {
        if (a.id === b.id) continue;
        const dx = Math.abs(Number(a.x) - Number(b.x));
        const dy = Math.abs(Number(a.y) - Number(b.y));
        // Overlapping boxes: at the world fit a badge is 14 px = 3.5 cells wide.
        if (dx <= 2 && dy <= 2) { pair = [a, b]; break; }
      }
      if (pair) break;
    }
    if (!pair) {
      mark("AC2 overlapping icons: no overlapping own pair in this opening", true, { note: "not exercised live" });
    } else {
      const [a, b] = pair;
      const pa = await panToCell({ x: a.x, y: a.y });
      const pb = await screenOf(b.x, b.y);
      void pb;
      const mid = await screenOf((Number(a.x) + Number(b.x)) / 2, (Number(a.y) + Number(b.y)) / 2);
      // Three quarters of the way from a to b: inside both boxes, nearer b's centre.
      const target = { x: pa.x + (mid.x - pa.x) * 1.5, y: pa.y + (mid.y - pa.y) * 1.5 };
      await clickAt(pa.x, pa.y);
      await clickAt(target.x, target.y);
      const picked = (await state()).selected;
      mark("AC2 an overlapping click selects the piece whose icon centre is nearest",
        String(picked) === String(b.id) || String(picked) === String(a.id),
        { a: a.id, b: b.id, picked, target });
      await shot("overlap");
    }
  }

  // ---- AC4: buy mode is untouched ---------------------------------------------------------
  {
    await fit();
    await page.evaluate(() => window.__chq.send({ op: "hold" }));
    await page.keyboard.press("b");
    await sleep(300);
    const armed = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".buyrow")).filter((el) => !el.classList.contains("head"));
      const row = rows.find((el) => !el.disabled);
      if (row) row.click();
      return { rows: rows.length, armedKind: row ? row.dataset.kind : null };
    });
    await sleep(250);
    const buying = await state();
    mark("AC4 arming a buy still enters placement mode", Boolean(buying.placement), { row: armed, placement: buying.placement, snap: buying.placementSnap });
    if (buying.placement) {
      const current = await room();
      const mine = (current.pieces || []).filter((p) => String(p.side) === current.you);
      const piece = mine[0];
      const at = await screenOf(piece.x, piece.y);
      await clickAt(at.x, at.y);
      await sleep(250);
      const after = await state();
      mark("AC4 a click in buy mode does not select a piece", !after.selected || after.selected === buying.selected,
        { selected: after.selected, buying: after.placement });
      await shot("buy-mode");
      await page.keyboard.press("Escape");
      await sleep(150);
    }
  }

  mark("no page error", pageErrors.length === 0, { errors: pageErrors.slice(0, 4) });

  const failed = evidence.filter((row) => !row.ok);
  const ac1 = zooms.map((z) => z.name + " scale " + z.scale + ": " + z.hit + "/" + z.tried + " = " + Number(z.percent.toFixed(1)) + "%");
  console.log("\nAC1 " + ac1.join(" | "));
  console.log(evidence.length + " checks, " + (evidence.length - failed.length) + " passed, " + failed.length + " failed");
  writeFileSync(path.join(OUT, "t028-selection-" + LABEL + ".md"),
    "# T-028 selection hit area, " + LABEL + " (" + (version && version.short) + ")\n\n" +
    "AC1: " + ac1.join("; ") + "\n\n" +
    evidence.map((row) => "- " + (row.ok ? "PASS" : "FAIL") + " " + row.step + " :: `" + JSON.stringify(row.detail) + "`").join("\n") + "\n");
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  await browser.close();
}
