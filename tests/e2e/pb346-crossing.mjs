// PB-346 page leg: a crossing is acknowledged as a crossing, and its loss names the unit ordered.
//
//   node tests/e2e/pb346-crossing.mjs                 # starts its own server from this tree
//   node tests/e2e/pb346-crossing.mjs --url=<base>    # a running server (live after a ship)
//   node tests/e2e/pb346-crossing.mjs --out=<dir>
//
// The node pin (web/test/nodes/pb346_crossing.mjs) proves the strings from planOrder/issueOrder and
// logLines. This leg proves them through the running product: a real 1942 bot match opened the way
// a player opens it, the order given by canvas clicks, the ack read off the Log the page wrote, and
// the loss read off room().log after the clock ran it.
//
// Arms:
//   1. the order ack (the row the page writes when the server answers `ordered`) says the plan
//      crosses, names its sea steps, and warns that the unit is cargo - and does NOT say "to walk";
//   2. the piece that was ordered is the one that disappears (same id), from a water cell;
//   3. the loss row names the ordered unit AND the hull, and no row in the room reads
//      "lost a transport" for it;
//   4. in the round the loss lands, every sighting/threat row sits AFTER the loss row.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", mkdtempSync(path.join(tmpdir(), "openchq-pb346-"))));
mkdirSync(OUT, { recursive: true });
const SELF_MD5 = createHash("md5").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");

const ERA = "1942";
const START = { x: 267, y: 39 };   // Vladivostok: the opening's first blue infantry
const NAGOYA = { x: 270, y: 46 };  // empty red city across the water
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 20000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb346-data-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("a given server answers", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const name = "e2e-pb346-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + name);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  await sleep(400);

  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click("#launch button[type=submit]");
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot",
    null, { timeout: 40000, polling: 150 });
  await sleep(700);

  const room = () => page.evaluate(() => window.__chq.room());
  const logOf = () => page.evaluate(() => window.__chq.log());

  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(300);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(180);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(180);
    return true;
  }

  let cur = await room();
  if (cur && cur.clock === "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
    cur = await room();
  }
  mark("(setup) a 1942 bot match is open with the clock held",
    Boolean(cur && cur.era === ERA && cur.mode === "bot" && cur.clock !== "running"),
    { era: cur && cur.era, mode: cur && cur.mode, clock: cur && cur.clock, round: cur && cur.round });

  const unit = (cur.pieces || []).find((p) => p.side === cur.you && p.x === START.x && p.y === START.y);
  mark("(setup) the opening infantry is on Vladivostok (267,39) in the seat view", Boolean(unit),
    unit ? { id: unit.id, kind: unit.kind } : (cur.pieces || []).slice(0, 3));
  if (!unit) throw new Error("no opening infantry to order");

  const before = (await logOf()).length;
  await clickCell({ x: unit.x, y: unit.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 8000 }).catch(() => {});
  const selected = await page.evaluate(() => window.__chq.state().selected);
  mark("(order) the click selected the infantry", String(selected) === String(unit.id), { selected, want: unit.id });
  await clickCell(NAGOYA);
  await page.waitForFunction(() => {
    const r = window.__chq.room();
    const p = (r.pieces || []).find((q) => q.id === window.__chq.state().selected);
    return p && Array.isArray(p.path) && p.path.length > 0;
  }, null, { timeout: 8000, polling: 100 }).catch(() => {});
  await sleep(500);

  const ackRows = (await logOf()).slice(before);
  const ackText = ackRows.map((r) => String(r.text));
  const ack = ackText.find((t) => /^Order sent\./.test(t)) || "";
  mark("(ack) the order was acknowledged", ack.length > 0, ackText.slice(-4));
  mark("(ack) the ack says the order CROSSES, with its sea steps",
    /to cross - \d+ steps? are by sea/.test(ack), ack);
  mark("(ack) the ack warns the unit becomes cargo", /cargo/.test(ack) && /one hit sinks it/.test(ack), ack);
  mark("(ack) the ack does not call a crossing a walk", !/to walk/.test(ack), ack);
  await page.screenshot({ path: path.join(OUT, "pb346-ack.png") });

  cur = await room();
  const ordered = (cur.pieces || []).find((p) => p.id === unit.id);
  mark("(order) the server stored the crossing plan", Boolean(ordered && ordered.path && ordered.path.length > 0),
    ordered ? { path: ordered.path.length, transport: ordered.transport === true } : null);

  // ---- run the clock until the ordered piece is gone (or past the crossing) -----------------
  const walk = [];
  await page.click("#clockBtn").catch(() => {});
  let died = null;
  let lostRound = null;
  for (let i = 0; i < 60; i++) {
    await sleep(600);
    const now = await room();
    const piece = (now.pieces || []).find((p) => p.id === unit.id);
    const row = { round: now.round, clock: now.clock, present: Boolean(piece),
      at: piece ? piece.x + "," + piece.y : null, transport: piece ? piece.transport === true : null };
    if (!walk.length || walk[walk.length - 1].round !== row.round) walk.push(row);
    if (!piece) { died = now.round; break; }
    if (now.round >= 10) break;
  }
  await page.click("#clockBtn").catch(() => {});
  await sleep(400);
  mark("(crossing) the ordered infantry went to sea (transport flag seen)", walk.some((r) => r.transport === true),
    walk.slice(0, 4));
  mark("(crossing) the ordered piece disappeared, and it is the SAME id", Boolean(died), { diedAtRound: died, walk });

  const all = await logOf();
  const cargoRow = all.find((r) => /^lost your \w+ - it was cargo on a transport/.test(String(r.text))) || null;
  const hullOnly = all.filter((r) => /^lost (a |your )?transport\b/.test(String(r.text)));
  mark("(loss) the loss row names the ordered unit and the cargo crossing",
    Boolean(cargoRow) && String(cargoRow.text).indexOf(String(unit.kind)) >= 0, cargoRow && cargoRow.text);
  mark("(loss) no row reads 'lost a transport' for the drowned piece", hullOnly.length === 0,
    hullOnly.map((r) => r.text));
  if (cargoRow) {
    lostRound = cargoRow.round;
    const same = all.filter((r) => r.round === lostRound);
    const at = same.indexOf(cargoRow);
    const firstWarn = same.findIndex((r) => r.tag === "spotted" || r.tag === "threat");
    mark("(loss) the round keeps the loss ahead of its sightings", firstWarn < 0 || firstWarn > at,
      same.map((r) => ({ text: r.text, tag: r.tag || null })));
    mark("(loss) the loss line carries no raw piece id",
      !String(cargoRow.text).includes(String(unit.id)), cargoRow.text);
  } else {
    mark("(loss) the round keeps the loss ahead of its sightings", false, "no cargo row to measure");
    mark("(loss) the loss line carries no raw piece id", false, "no cargo row to measure");
  }
  await page.screenshot({ path: path.join(OUT, "pb346-loss.png") });

  mark("(page) no uncaught page error", pageErrors.length === 0, pageErrors.slice(0, 3));

  const summary = { base: BASE, era: ERA, tree: root, legMd5: SELF_MD5, unit: unit.id,
    walk, lostRound, evidence };
  writeFileSync(path.join(OUT, "pb346-summary.json"), JSON.stringify(summary, null, 2));
  console.log("\nPB-346 " + (failed ? "RED" : "GREEN") + " — " + evidence.filter((e) => e.ok).length +
    " pass, " + failed + " fail; base " + BASE + "; leg md5 " + SELF_MD5 + "; evidence " + OUT);
  if (failed) process.exitCode = 1;
} catch (err) {
  console.error("PB-346 leg failed: " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill("SIGTERM");
      setTimeout(() => { try { server.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 6000).unref();
    });
  }
}
