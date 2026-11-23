// PB-083 camera leg: drag pans, the wheel anchors at the cursor, and a pan is not an order.
//
//   node tests/e2e/pb083-camera.mjs --url=http://127.0.0.1:8114 --out=local/pb083-shots
//
// The node pin (web/test/nodes/camera_zoom.mjs) grades the zoom arithmetic; this leg grades the
// HAND: pointer events on a real canvas, in a real match, with the room's socket open. Nothing
// here reads a constant the page also reads - every number is a camera the page reported.
//
//   1. WHEEL ANCHOR: one notch in at a point a third of the way across the map leaves the cell
//      under that point unchanged (screenToCell before == after).
//   2. WHEEL OUT FROM A PINCHED SCALE MOVES: one notch out from the zoomed scale goes down by one.
//   3. WHEEL OUT AT THE FLOOR HOLDS: at the fit the same notch is a no-op, not a jump.
//   4. DRAG PANS, three buttons: primary (the only one a trackpad has), middle and right. The
//      camera moves the way the pointer moved.
//   5. TRACKING: the pan is the drag in canvas pixels (client px * board.width / rect.width),
//      within 2 px - a drag that moves the map at half speed is the dpr-2 defect.
//   6. A PAN IS NOT AN ORDER: after a primary drag over the map, the selection is unchanged.
//   7. CONTROL: a primary CLICK still selects a piece, so the swallow is exactly one click.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/pb083-camera.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb083", "shots")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
let failed = 0;
function mark(step, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
let version = null;
try {
  version = await (await fetch(BASE + "/api/version")).json();
} catch (err) {
  version = { error: String(err) };
}

// One landing per device pixel ratio: the camera is in device pixels, so a drag that tracks the
// pointer at dpr 1 and lags at dpr 2 is the defect this leg exists for.
for (const dpr of [1, 2]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const signedIn = await page.evaluate(() => Boolean(window.__chq && window.__chq.me && window.__chq.me()));
  if (!signedIn) {
    const user = "cam" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", user);
    await page.fill("#register input[name=password]", "pw-" + user);
    await page.click("#register button[type=submit]");
  }
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  await page.selectOption('#launch select[name="era"]', "1942");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click("#launch button[type=submit]");
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1942", null, { timeout: 20000, polling: 100 });
  // A held clock: the frame under the camera must not move while the hand does.
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await sleep(350);

  const cam = () => page.evaluate(() => window.__chq.state().camera);
  const cellAt = (x, y) => page.evaluate(([px, py]) => window.__chq.screenToCell(px, py), [x, y]);
  const geom = await page.evaluate(() => {
    const el = document.getElementById("board");
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, backing: el.width };
  });
  const ratio = geom.backing / geom.width;
  const wx = Math.round(geom.left + geom.width * 0.3);
  const wy = Math.round(geom.top + geom.height * 0.35);

  const wheel = async (dir) => page.evaluate(([x, y, delta]) => {
    document.getElementById("board").dispatchEvent(new WheelEvent("wheel", {
      deltaY: delta, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
  }, [wx, wy, dir < 0 ? 100 : -100]);

  // 1. anchor
  {
    const before = await cam();
    const cellBefore = await cellAt(wx, wy);
    await wheel(1);
    await sleep(200);
    const after = await cam();
    const cellAfter = await cellAt(wx, wy);
    mark("dpr" + dpr + " wheel-in moves one scale step", after.scale > before.scale, { before: before.scale, after: after.scale });
    mark("dpr" + dpr + " wheel-in anchors at the cursor",
      cellBefore.x === cellAfter.x && cellBefore.y === cellAfter.y,
      { at: [wx, wy], cellBefore, cellAfter });
  }
  // 2/3. the collapse arm at the page level
  {
    const mid = await cam();
    await wheel(-1);
    await sleep(200);
    const down = await cam();
    mark("dpr" + dpr + " wheel-out from the zoomed scale moves down", down.scale < mid.scale, { from: mid.scale, to: down.scale });
    await page.click("#camFit");
    await sleep(250);
    const fit = await cam();
    await wheel(-1);
    await sleep(200);
    const held = await cam();
    mark("dpr" + dpr + " wheel-out at the fit is a hold", held.scale === fit.scale, { fit: fit.scale, held: held.scale });
  }

  // 4/5. drag pans, three buttons
  const drag = async (button, dx, dy) => {
    const before = await cam();
    await page.mouse.move(wx, wy);
    await page.mouse.down({ button });
    const steps = 6;
    for (let i = 1; i <= steps; i++) await page.mouse.move(wx + Math.round(dx * i / steps), wy + Math.round(dy * i / steps));
    await page.mouse.up({ button });
    await sleep(200);
    const after = await cam();
    return { before, after, pan: [after.left - before.left, after.top - before.top] };
  };
  for (const button of ["left", "middle", "right"]) {
    const r = await drag(button, 120, 60);
    const want = [120 * ratio, 60 * ratio];
    const ok = Math.abs(r.pan[0] - want[0]) <= 2 && Math.abs(r.pan[1] - want[1]) <= 2;
    mark("dpr" + dpr + " " + button + "-drag pans with the pointer", ok, { pan: r.pan, want: want.map((v) => Math.round(v * 100) / 100), ratio });
  }

  // 6. a pan is not an order: drag with a piece selected over the map
  {
    // The fit first: a piece that is off-canvas cannot be clicked, and a click that lands nowhere
    // would make this control pass for the wrong reason.
    await page.click("#camFit");
    await sleep(250);
    const pick = await page.evaluate(() => {
      const room = window.__chq.room();
      const rect = document.getElementById("board").getBoundingClientRect();
      const mine = (room.pieces || []).filter((p) => p.side === room.you);
      for (const p of mine) {
        const pt = window.__chq.cellToScreen(p.x, p.y);
        if (pt.x > rect.left + 4 && pt.x < rect.right - 4 && pt.y > rect.top + 4 && pt.y < rect.bottom - 4) {
          return { id: p.id, x: p.x, y: p.y, point: pt };
        }
      }
      return null;
    });
    if (!pick) {
      mark("dpr" + dpr + " a pan is not an order", false, "no own piece is on the canvas at the fit");
    } else {
      await page.mouse.click(pick.point.x, pick.point.y);
      await sleep(350);
      const selectedBefore = await page.evaluate(() => window.__chq.state().selected);
      const r = await drag("left", 90, 40);
      const selectedAfter = await page.evaluate(() => window.__chq.state().selected);
      mark("dpr" + dpr + " a pan is not an order",
        selectedBefore === pick.id && selectedAfter === selectedBefore && r.pan[0] !== 0,
        { piece: pick.id, selectedBefore, selectedAfter, pan: r.pan });
      // 7. control: a click still selects after a pan (the swallow is exactly one click)
      await page.click("#camFit");
      await sleep(250);
      const p2 = await page.evaluate(([x, y]) => {
        const pt = window.__chq.cellToScreen(x, y);
        const rect = document.getElementById("board").getBoundingClientRect();
        const inside = pt.x > rect.left + 4 && pt.x < rect.right - 4 && pt.y > rect.top + 4 && pt.y < rect.bottom - 4;
        return { ...pt, inside };
      }, [pick.x, pick.y]);
      if (p2.inside) {
        await page.mouse.click(p2.x, p2.y);
        await sleep(350);
        const again = await page.evaluate(() => window.__chq.state().selected);
        mark("dpr" + dpr + " a click after a pan still selects", again === pick.id, { piece: pick.id, selected: again, at: p2 });
      } else {
        mark("dpr" + dpr + " a click after a pan still selects", false, "the piece is off the canvas at " + JSON.stringify(p2));
      }
    }
  }

  const shot = path.join(OUT, "pb083-dpr" + dpr + ".png");
  await page.screenshot({ path: shot });
  mark("dpr" + dpr + " page errors", pageErrors.length === 0, pageErrors);
  await context.close();
  evidence.push({ shot, dpr, ratio });
}

await browser.close();
writeFileSync(path.join(OUT, "pb083-camera.json"), JSON.stringify({ version, evidence }, null, 2));
console.log("");
console.log("PB083 camera leg against " + BASE + " build " + (version && version.short ? version.short : "UNKNOWN"));
console.log("  " + (evidence.filter((e) => e.ok).length) + " passed, " + failed + " failed, " + evidence.length + " checks");
console.log("  shots: " + OUT);
process.exit(failed ? 1 : 0);
