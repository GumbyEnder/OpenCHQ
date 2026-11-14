// T-021 AC4: the move marker and the route line are thinner, and still legible at the world fit
// and zoomed in. Run the SAME script against a pre-T-021 build and the branch (--label=before /
// --label=after) so the two sets are the same scene, not two different matches.
//
//   node tests/e2e/t021-marker-shots.mjs --url=http://127.0.0.1:8201 --label=before --out=.../local/t021-shots
//   node tests/e2e/t021-marker-shots.mjs --url=http://127.0.0.1:8200 --label=after  --out=.../local/t021-shots
//
// Every step goes through the page's own pointer path: click a friendly piece to select it, move
// the pointer to a destination (the page paints the preview line and its end diamond), then click
// to send the order (the page paints the real route). Nothing here writes to the canvas.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const LABEL = argOf("label", "after");
if (!BASE) {
  console.error("usage: node tests/e2e/t021-marker-shots.mjs --url=<base url> --label=before|after [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "worktrees", "t021", "local", "t021-shots")));
mkdirSync(OUT, { recursive: true });
const ERA = argOf("era", "1942");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "playwright" && !existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      void err;
    }
  }
  return import("playwright");
}

const evidence = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "t021-marker-" + LABEL + ".json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

const room = () => page.evaluate(() => window.__chq.room());
const state = () => page.evaluate(() => window.__chq.state());
const note = () => page.$eval("#boardNote", (el) => el.textContent || "");

async function shot(name) {
  const file = path.join(OUT, "t021-" + LABEL + "-" + name + ".png");
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

async function fit() {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0");
  await sleep(350);
  return (await state()).camera;
}

async function zoomIn(times = 2) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("+");
    await sleep(220);
  }
  return (await state()).camera;
}

async function panToCell(cell, tries = 80) {
  const vp = page.viewportSize();
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  for (let i = 0; i < tries; i++) {
    const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    let moved = false;
    if (at.x < cx - 40) { await page.keyboard.press("ArrowLeft"); moved = true; }
    else if (at.x > cx + 40) { await page.keyboard.press("ArrowRight"); moved = true; }
    if (at.y < cy - 40) { await page.keyboard.press("ArrowUp"); moved = true; }
    else if (at.y > cy + 40) { await page.keyboard.press("ArrowDown"); moved = true; }
    if (!moved) return at;
  }
  return page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
}

// A blue piece with a legal-looking destination: the page's own #boardNote says "Route: …" when the
// pointer is over a cell the server would accept, and a refusal sentence when it would not. The
// offsets are tried in order and the first accepted one is the scene for both runs.
async function pickScene(preferDomain) {
  const pieces = ((await room()).pieces || [])
    .filter((p) => String(p.side) === "blue" && String(p.domain) === preferDomain)
    .slice(0, 6);
  for (const piece of pieces) {
    await panToCell({ x: Number(piece.x), y: Number(piece.y) });
    const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), { x: Number(piece.x), y: Number(piece.y) });
    const vp = page.viewportSize();
    if (at.x < 20 || at.y < 20 || at.x > vp.width - 20 || at.y > vp.height - 20) continue;
    await page.mouse.click(at.x, at.y);
    await sleep(300);
    if (!(await state()).selected) continue;
    for (const [dx, dy] of [[5, 0], [4, 1], [3, 3], [0, 4], [-4, 0], [2, -3], [6, 2], [-5, 2]]) {
      const dest = { x: Number(piece.x) + dx, y: Number(piece.y) + dy };
      const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), dest);
      const inside = point.x > 8 && point.y > 8 && point.x < vp.width - 8 && point.y < vp.height - 8;
      if (!inside) continue;
      await page.mouse.move(point.x, point.y);
      await sleep(300);
      const text = await note();
      if (/^Route: /.test(text)) return { piece, dest, point, text, pieceScreen: at };
    }
  }
  return null;
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), { label: LABEL, version });

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "mk" + LABEL + Date.now().toString(36).slice(-8);
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
  // A running clock would move the piece out from under the shot between the preview and the click.
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null, { timeout: 15000 }).catch(() => {});
  mark("the clock is held so the scene cannot move between shots", (await room()).clock === "held", { round: (await room()).round });

  // ---- world fit ---------------------------------------------------------------------------
  const fitCam = await fit();
  const fitScene = await pickScene("land");
  mark("a land piece with a legal destination at the world fit", Boolean(fitScene),
    fitScene ? { piece: fitScene.piece.id, from: { x: fitScene.piece.x, y: fitScene.piece.y }, to: fitScene.dest } : null);
  if (!fitScene) throw new Error("no legal land destination at the fit");
  const fitPreview = await shot("marker-preview-world-fit");
  await page.mouse.click(fitScene.point.x, fitScene.point.y);
  await sleep(600);
  const fitPath = await shot("marker-path-world-fit");
  const ordered = ((await room()).pieces || []).find((p) => String(p.id) === String(fitScene.piece.id));
  mark("the order sent and the route is painted", Boolean(ordered && Array.isArray(ordered.path) && ordered.path.length > 0),
    { piece: fitScene.piece.id, pathSteps: ordered && ordered.path ? ordered.path.length : 0, note: await note(),
      scale: fitCam && fitCam.scale, shots: [fitPreview, fitPath] });

  // ---- zoomed in ---------------------------------------------------------------------------
  const zoomCam = await zoomIn(2);
  const zoomScene = await pickScene("sea");
  mark("a sea piece with a legal destination when zoomed", Boolean(zoomScene),
    zoomScene ? { piece: zoomScene.piece.id, from: { x: zoomScene.piece.x, y: zoomScene.piece.y }, to: zoomScene.dest } : null);
  if (zoomScene) {
    const zoomPreview = await shot("marker-preview-zoomed");
    await page.mouse.click(zoomScene.point.x, zoomScene.point.y);
    await sleep(600);
    const zoomPath = await shot("marker-path-zoomed");
    const sent = ((await room()).pieces || []).find((p) => String(p.id) === String(zoomScene.piece.id));
    mark("the zoomed order sent and its route is painted", Boolean(sent && Array.isArray(sent.path) && sent.path.length > 0),
      { piece: zoomScene.piece.id, pathSteps: sent && sent.path ? sent.path.length : 0, note: await note(),
        scale: zoomCam && zoomCam.scale, shots: [zoomPreview, zoomPath] });
  }

  mark("no page error", pageErrors.length === 0, { errors: pageErrors.slice(0, 4) });

  const failed = evidence.filter((row) => !row.ok);
  console.log("\n" + evidence.length + " checks, " + (evidence.length - failed.length) + " passed, " + failed.length + " failed");
  writeFileSync(path.join(OUT, "t021-marker-" + LABEL + ".md"),
    "# T-021 move marker, " + LABEL + " (" + (version && version.short) + ")\n\n" +
    evidence.map((row) => "- " + (row.ok ? "PASS" : "FAIL") + " " + row.step + " :: `" + JSON.stringify(row.detail) + "`").join("\n") + "\n");
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error("ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  await browser.close();
}
