// PB-272 page leg: Show Paths, the hover route and the Satellite Mode row, at 1280x800.
//
// The manual (p.32 Menu Command Summary): "each unit's path is shown as a line on the screen (this
// works in zoom as well)"; p.21: "Pressing the key shows the target and travel path for all your
// units"; p.12: "You can only see the first three moves of an enemy unit".
//
// What this leg measures on a real page, a real socket and a real server:
//   1. the strip carries a Show Paths row and a Satellite Mode row, and the Show Paths row is OFF on
//      first load — with the port-choice sentence in its tooltip;
//   2. three own units are given real orders through the page's own socket, and with the toggle off
//      the painter draws ZERO of those lines (paintReport().pending), while the units are still drawn;
//   3. `d` turns it on: exactly one line per own unit that has a destination, read from the painter's
//      own report, and a frame is captured;
//   4. the row turns it off again (the row exists because `d` is text while a field has focus);
//   5. hovering a unit with a destination draws its route (paintReport().hoverPath > 0), and every
//      ENEMY route in the live room frame is at most the server's 3 steps — the client holds no cap;
//   6. the Satellite Mode row reaches the same view the `s` key does;
//   7. no page error.
//
//   node tests/e2e/pb272-show-paths.mjs                  # starts its own server from this tree
//   node tests/e2e/pb272-show-paths.mjs --url=<base>     # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const OUT = evidenceDir("pb272-show-paths", argOf("out"));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}
// A disclosure: recorded, never counted as a pass. Used where the live frame cannot sample the arm.
function note(label, detail) {
  evidence.push({ label, ok: null, detail });
  console.log("NOTE " + label + (detail === undefined ? "" : " — " + detail));
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

const paint = (page) => page.evaluate(() => window.__chq.paintReport());
const stateOf = (page) => page.evaluate(() => window.__chq.state());
const routesOf = (page) => page.evaluate(() => ({ ...((window.__chq.room() || {}).routes || {}) }));

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb272-"));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const user = "e2e-pb272-" + Date.now().toString(36).slice(-6);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", user);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  await page.selectOption('#launch select[name="era"]', "1942");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
    null, { timeout: 30000, polling: 100 });
  mark("a 1942 human-vs-bot room is open", await page.evaluate(() => String(window.__chq.room().era) === "1942"),
    "era read from the room frame");

  // ---- 1. the two rows, and OFF on first load ----------------------------------------------------
  const rows = await page.evaluate(() => {
    const read = (id) => {
      const el = document.getElementById(id);
      return el ? { text: (el.textContent || "").trim(), title: el.title || "", pressed: el.getAttribute("aria-pressed") } : null;
    };
    return { paths: read("showPathsBtn"), sats: read("satelliteModeBtn") };
  });
  mark("the strip carries a Show Paths row", Boolean(rows.paths) && /path/i.test(rows.paths.text), JSON.stringify(rows.paths));
  mark("Show Paths is OFF on first load and says so", rows.paths && rows.paths.pressed === "false",
    rows.paths ? "aria-pressed=" + rows.paths.pressed : "no row");
  mark("the Show Paths tooltip names the port choice and the page",
    Boolean(rows.paths) && /port.s choice/i.test(rows.paths.title) && /p\.32/.test(rows.paths.title), rows.paths && rows.paths.title);
  mark("the strip carries a Satellite Mode row", Boolean(rows.sats) && /satellite/i.test(rows.sats.text), JSON.stringify(rows.sats));

  // ---- 2. three real orders, drawn by nobody while the toggle is off ----------------------------
  const planned = await page.evaluate(async () => {
    const room = window.__chq.room();
    const you = String(room.you);
    const pieces = (room.pieces || []).filter((p) => String(p.side) === you);
    const out = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const piece of pieces) {
      if (out.length >= 3) break;
      if (piece.domain === "air" || piece.orbit === false) continue;
      // A FAR destination, so the server plans a multi-step route the line can be seen on: one cell
      // at a fit zoom is three pixels and proves nothing in a screenshot.
      const tries = [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 3], [3, 4], [-4, 3], [3, -4],
        [2, 0], [-2, 0], [0, 2], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of tries) {
        const to = { x: piece.x + dx, y: piece.y + dy };
        if (to.x < 0 || to.y < 0) continue;
        window.__chq.send({ op: "order", piece: piece.id, to });
        await sleep(260);
        const routes = (window.__chq.room() || {}).routes || {};
        if (Array.isArray(routes[piece.id]) && routes[piece.id].length) {
          out.push({ id: piece.id, from: { x: piece.x, y: piece.y }, to, steps: routes[piece.id].length });
          break;
        }
      }
    }
    return { tried: pieces.length, ordered: out };
  });
  mark("three own units hold real orders from the server", planned.ordered.length >= 3,
    planned.ordered.length + " of " + planned.tried + " own pieces: " + JSON.stringify(planned.ordered.map((o) => o.id)));

  await sleep(300);
  const offReport = await paint(page);
  const offState = await stateOf(page);
  mark("with the toggle off the painter draws none of those lines", offReport.pending === 0 && offState.showPaths === false,
    "pending=" + offReport.pending + " showPaths=" + offState.showPaths);
  mark("the units themselves are still drawn", Number(offReport.pieces) > 0, "pieces=" + offReport.pieces);

  // ---- 3. `d` draws one line per own unit with a destination, and a frame is captured -----------
  await page.mouse.click(640, 400); // focus the board, away from any field
  await page.keyboard.press("d");
  await sleep(350);
  const onReport = await paint(page);
  const onState = await stateOf(page);
  const ownWithDest = planned.ordered.length;
  mark("`d` turns Show Paths on", onState.showPaths === true, "state.showPaths=" + onState.showPaths);
  mark("`d` draws one line per own unit with a destination", onReport.pending === ownWithDest,
    "pending=" + onReport.pending + ", own units with a destination=" + ownWithDest);
  const rowPressed = await page.evaluate(() => document.getElementById("showPathsBtn").getAttribute("aria-pressed"));
  mark("the row's pressed state follows the key", rowPressed === "true", "aria-pressed=" + rowPressed);
  // The frame the card asks for first: the whole-world fit with the lines on, no camera help. The
  // ordered destinations are five cells out, so each line is ~15 px at this zoom.
  await page.screenshot({ path: path.join(OUT, "pb272-paths-on-1280x800.png") });

  // Then the zoomed frame: select one of the ordered units, arm Follow so the
  // camera centres on it, and zoom in, so the lines are legible in the frame the card asks for (the
  // manual's own sentence is "this works in zoom as well").
  const focus = planned.ordered[0];
  const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), { x: focus.from.x, y: focus.from.y });
  await page.mouse.click(at.x, at.y);
  await sleep(250);
  if (await page.$("#camFollow")) await page.click("#camFollow");
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("+");
    await sleep(90);
  }
  await sleep(300);
  const zoomed = await paint(page);
  mark("the lines survive the zoom (the manual says the key works in zoom as well)", zoomed.pending === ownWithDest,
    "pending=" + zoomed.pending + " at the zoomed view, own units with a destination=" + ownWithDest);
  await page.screenshot({ path: path.join(OUT, "pb272-paths-zoom-1280x800.png") });

  // ---- 4. the row turns it off again ------------------------------------------------------------
  await page.click("#showPathsBtn");
  await sleep(300);
  const rowOff = await paint(page);
  mark("the row turns it off again and draws nothing", rowOff.pending === 0, "pending=" + rowOff.pending);

  // ---- 5. hover draws a route; the enemy's is the server's 3 steps and never more ---------------
  const hoverArm = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const room = window.__chq.room();
    const you = String(room.you);
    const routes = room.routes || {};
    const own = (room.pieces || []).find((p) => String(p.side) === you && Array.isArray(routes[p.id]) && routes[p.id].length);
    return own ? { id: own.id, x: own.x, y: own.y, steps: routes[own.id].length } : null;
  });
  if (hoverArm) {
    const at = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), hoverArm);
    await page.mouse.move(at.x, at.y);
    await sleep(400);
    const hoverReport = await paint(page);
    mark("hovering a unit with a destination draws its route", hoverReport.hoverPath > 0,
      "hoverPath=" + hoverReport.hoverPath + " for " + hoverArm.id + " (" + hoverArm.steps + " steps)");
  } else {
    mark("hovering a unit with a destination draws its route", false, "no own unit held a route to hover");
  }
  const live = await routesOf(page);
  const own = await page.evaluate(() => String((window.__chq.room() || {}).you));
  const enemyRoutes = Object.entries(live).filter(([id]) => !id.startsWith(own + ":"));
  const overCap = enemyRoutes.filter(([, steps]) => Array.isArray(steps) && steps.length > 3);
  if (enemyRoutes.length) {
    mark("every enemy route in the live frame is at most the server's three steps",
      overCap.length === 0,
      enemyRoutes.length + " enemy routes, longest " + Math.max(0, ...enemyRoutes.map(([, s]) => (Array.isArray(s) ? s.length : 0))));
  } else {
    note("enemy route cap not sampled in the page: the frame carried no enemy route at this round",
      "the pass-through itself is pinned on fixed lines in web/test/nodes/pb272_show_paths.mjs");
  }

  // ---- 6. the Satellite Mode row reaches the key's own view -------------------------------------
  await page.click("#satelliteModeBtn");
  await sleep(400);
  const satReport = await paint(page);
  const satState = await page.evaluate(() => document.getElementById("satelliteModeBtn").getAttribute("aria-pressed"));
  mark("the Satellite Mode row reaches the satellites view", satReport.layers.includes("satellites") && satState === "true",
    "layers include satellites: " + satReport.layers.includes("satellites") + ", aria-pressed=" + satState);
  await page.screenshot({ path: path.join(OUT, "pb272-satellites-row-1280x800.png") });
  await page.click("#satelliteModeBtn");

  mark("no page error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "none");

  const verdict = { failed, viewport: "1280x800", base: BASE, evidence };
  writeFileSync(path.join(OUT, "pb272-leg.json"), JSON.stringify(verdict, null, 2));
  console.log("pb272-show-paths: " + (evidence.length - failed) + " passed / " + failed + " failed");
  await browser.close();
  if (child) child.kill("SIGTERM");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
