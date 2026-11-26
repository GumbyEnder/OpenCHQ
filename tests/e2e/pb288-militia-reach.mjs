// PB-288 page leg: the city militia lands on a piece standing on the city's own cells and on
// nothing outside them.
//
// The node pin (web/test/nodes/pb288_militia_reach.mjs) proves the rule by importing resolve().
// This leg proves it through the running product: a real server process, a real room row, a real
// socket, a real page, the real clock - and the SAME leg file against the pre-fix tree, because a
// count from one tree is not a control.
//
// Fixture (Berlin, board site id 11, footprint 160..162 x 29..31; red owns the city):
//   inside  - red infantry on the anchor (161,30), blue infantry on a footprint cell (160,30)
//   outside - red infantry on the anchor (161,30), blue infantry one cell west of the block (159,30)
// In both, the red defender is "on its own city" by every reading, the blue piece is inside land
// engage range, and the two exchange shots. The only difference the fix can make is whether the
// militia pays the blue piece for being there.
//
//   node tests/e2e/pb288-militia-reach.mjs                       # this tree only
//   node tests/e2e/pb288-militia-reach.mjs --control=<tree>      # this tree + the pre-fix tree
//   node tests/e2e/pb288-militia-reach.mjs --tree=<dir> --out=<dir>
//
// What is asserted, per tree:
//   1. the page restored the seeded room: both pieces on their cells at full strength, clock held;
//   2. one click of the clock runs exactly ONE round;
//   3. inside: one "City militia." line in that round and the blue piece is short by the exchange
//      AND the militia;
//   4. outside: no militia line, and the blue piece is short by the exchange only.
// With --control, the outside arms of the two trees are compared: the fixed tree must read exactly
// militiaDamage higher, and the inside arms must agree, so the exchange itself is the control's own
// measurement rather than a number copied into this file.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TREE = path.resolve(argOf("tree", root));
const CONTROL = argOf("control", "") ? path.resolve(argOf("control", "")) : "";
const OUT = path.resolve(argOf("out", mkdtempSync(path.join(tmpdir(), "openchq-pb288-"))));
mkdirSync(OUT, { recursive: true });
const SELF_MD5 = createHash("md5").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");

const CITY_ID = 11;          // Berlin
const ANCHOR = { x: 161, y: 30 };
const INSIDE = { x: 160, y: 30 };
const OUTSIDE = { x: 159, y: 30 };
const MAX = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}

function militiaDamage(tree) {
  const cfg = JSON.parse(readFileSync(path.join(tree, "config", "game.json"), "utf8"));
  return Number(cfg.combat.militiaDamage.value ?? cfg.combat.militiaDamage);
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

async function startServer(tree, port, dataDir) {
  const child = spawn(process.execPath, [path.join(tree, "web", "server", "main.mjs")], {
    cwd: tree,
    env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk.toString(); });
  child.stderr.on("data", (chunk) => { log += chunk.toString(); });
  const base = "http://127.0.0.1:" + port;
  const started = Date.now();
  while (Date.now() - started < 25000) {
    try {
      const res = await fetch(base + "/api/version");
      if (res.ok) return { child, base, log: () => log };
    } catch { /* still booting */ }
    await sleep(150);
  }
  child.kill("SIGKILL");
  throw new Error("server did not answer: " + log);
}

function stopServer(server) {
  return new Promise((resolve) => {
    const child = server.child;
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 8000).unref();
  });
}

const piece = (id, side, x, y) => ({
  id, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1, facing: null,
  fighting: null, shots: 0, strength: MAX, maxStrength: MAX,
});

// Put the fixture into the room the page just created. The row's match is packed (sites are a
// per-side list of ids), so ownership of Berlin is a list edit; pieces travel as-is.
function seedRoom(dataDir, username, blueCell) {
  const db = new DatabaseSync(path.join(dataDir, "openchq.sqlite"));
  try {
    const rows = db.prepare("SELECT id, state FROM rooms").all();
    if (rows.length !== 1) throw new Error("expected one room, found " + rows.length);
    const row = rows[0];
    const state = JSON.parse(row.state);
    state.seats = { blue: { username, kind: "human" }, red: { username: "pb288-absent", kind: "human" } };
    state.speed = 1;
    const match = state.match || {};
    match.clock = "held";
    match.round = 5;
    match.foughtRound = -1;
    match.pieces = [piece("blue:infantry:1", "blue", blueCell.x, blueCell.y), piece("red:infantry:2", "red", ANCHOR.x, ANCHOR.y)];
    const owners = match.siteOwners && typeof match.siteOwners === "object" ? match.siteOwners : { blue: [], red: [] };
    const without = (list) => (Array.isArray(list) ? list : []).filter((id) => String(id) !== String(CITY_ID));
    match.siteOwners = { ...owners, blue: without(owners.blue), red: without(owners.red).concat([CITY_ID]) };
    state.match = match;
    db.prepare("UPDATE rooms SET state = ?, clock = 'held' WHERE id = ?").run(JSON.stringify(state), row.id);
    return row.id;
  } finally {
    db.close();
  }
}

async function openPage(browser, base, mode, username, password) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#" + mode + " input[name=username]", username);
  await page.fill("#" + mode + " input[name=password]", password);
  await page.click("#" + mode + " button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  return { page, context, errors };
}

// One click of the clock runs the room for one round; the second click holds it before the next
// round can start (roundSeconds is 5 at speed 1, so the poll has most of a round to react).
async function oneRound(page, before) {
  await page.click("#clockBtn");
  const started = Date.now();
  let after = before;
  while (Date.now() - started < 20000) {
    after = await page.evaluate(() => Number(window.__chq.room() && window.__chq.room().round) || 0);
    if (after > before) break;
    await sleep(80);
  }
  await page.click("#clockBtn");
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock === "held", null, { timeout: 20000, polling: 100 });
  return after;
}

async function scenario(browser, tree, label, blueCell, militia) {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb288-srv-"));
  const user = "e2e-pb288-" + label + "-" + Date.now().toString(36).slice(-5);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);

  let server = await startServer(tree, port, dataDir);
  const first = await openPage(browser, server.base, "register", user, password);
  await first.page.selectOption('#launch select[name="era"]', "1942");
  await first.page.selectOption('#launch select[name="side"]', "blue");
  await first.page.click('#launch button[type=submit]');
  await first.page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
  await first.context.close();
  await stopServer(server);

  seedRoom(dataDir, user, blueCell);

  server = await startServer(tree, port, dataDir);
  const { page, context, errors } = await openPage(browser, server.base, "login", user, password);
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
  await page.waitForFunction(() => {
    const pieces = (window.__chq.room() || {}).pieces || [];
    return pieces.some((p) => p.id === "blue:infantry:1") && pieces.some((p) => p.id === "red:infantry:2");
  }, null, { timeout: 20000, polling: 100 });
  await sleep(400);

  const read = () => page.evaluate(() => {
    const room = window.__chq.room() || {};
    const at = (id) => (room.pieces || []).find((p) => p.id === id) || null;
    return {
      round: Number(room.round) || 0,
      clock: room.clock,
      blue: at("blue:infantry:1"),
      red: at("red:infantry:2"),
      log: window.__chq.log().slice(-40),
    };
  });
  const before = await read();
  mark(label + ": the page restored the seeded room — " + blueCell.x + ",30 vs 161,30, full strength, clock held",
    Boolean(before.blue && before.red) && before.blue.x === blueCell.x && before.blue.y === 30
      && before.red.x === ANCHOR.x && before.red.y === ANCHOR.y
      && before.blue.strength === MAX && before.red.strength === MAX && before.clock === "held",
    "round " + before.round + " clock " + before.clock + " blue " + JSON.stringify(before.blue && { x: before.blue.x, y: before.blue.y, s: before.blue.strength })
      + " red " + JSON.stringify(before.red && { x: before.red.x, y: before.red.y, s: before.red.strength }));

  const after = await oneRound(page, before.round);
  await sleep(400);
  const post = await read();
  const roundLines = post.log.filter((line) => Number(line.round) === after);
  const militiaLines = roundLines.filter((line) => /militia/i.test(String(line.text)));
  const blueAfter = post.blue ? post.blue.strength : null;
  const redAfter = post.red ? post.red.strength : null;

  mark(label + ": one click of the clock ran exactly one round (" + before.round + " -> " + after + ")",
    after === before.round + 1 && post.clock === "held", "round " + post.round + " clock " + post.clock);

  console.log("  " + label + ": blue " + blueAfter + " red " + redAfter + " militia lines " + militiaLines.length
    + " :: " + JSON.stringify(roundLines.map((line) => line.text).slice(0, 6)));

  await page.screenshot({ path: path.join(OUT, "pb288-" + label + ".png") });
  mark(label + ": no page error", errors.length === 0, errors.join(" | "));

  await context.close();
  await stopServer(server);
  return { label, tree, blueAfter, redAfter, militia: militiaLines.length, militiaDamage: militia, round: after };
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const m = militiaDamage(TREE);
  let reads = [];
  try {
    reads.push(await scenario(browser, TREE, "tip-inside", INSIDE, m));
    reads.push(await scenario(browser, TREE, "tip-outside", OUTSIDE, m));
    if (CONTROL) {
      const cm = militiaDamage(CONTROL);
      reads.push(await scenario(browser, CONTROL, "control-inside", INSIDE, cm));
      reads.push(await scenario(browser, CONTROL, "control-outside", OUTSIDE, cm));
    }
  } finally {
    await browser.close();
  }

  const of = (label) => reads.find((r) => r.label === label);
  const tipIn = of("tip-inside"), tipOut = of("tip-outside");
  if (tipIn) mark("tip inside: the militia paid the occupier", tipIn.militia === 1, "militia lines " + tipIn.militia);
  if (tipOut) mark("tip outside: the militia did NOT reach a piece one cell outside the block", tipOut.militia === 0,
    "militia lines " + tipOut.militia + ", strength " + tipOut.blueAfter);
  if (tipIn && tipOut) {
    mark("tip: inside pays the occupation militia, outside pays none — " + tipIn.militia + " vs " + tipOut.militia + " militia lines",
      tipIn.militia === 1 && tipOut.militia === 0, "inside " + tipIn.blueAfter + " outside " + tipOut.blueAfter + " militiaDamage " + m);
  }
  if (CONTROL) {
    const cIn = of("control-inside"), cOut = of("control-outside");
    if (cIn && cOut) {
      const exchangeOutside = MAX - cOut.blueAfter - cOut.militiaDamage;
      mark("control (pre-fix tree): the militia DID reach the outside piece", cOut.militia === 1
        && cOut.blueAfter === MAX - exchangeOutside - cOut.militiaDamage,
        "militia lines " + cOut.militia + ", strength " + cOut.blueAfter);
      if (tipOut) {
        mark("the fix is the militia payment and nothing else: same outside fixture reads +" + m + " against the control, inside unchanged",
          tipOut.blueAfter === cOut.blueAfter + cOut.militiaDamage && tipIn && tipIn.blueAfter === cIn.blueAfter,
          "outside " + cOut.blueAfter + " -> " + tipOut.blueAfter + ", inside " + cIn.blueAfter + " -> " + (tipIn && tipIn.blueAfter));
      }
    }
  }

  writeFileSync(path.join(OUT, "pb288-live-leg.json"), JSON.stringify({ md5: SELF_MD5, tree: TREE, control: CONTROL || null, reads, evidence }, null, 2));
  console.log("");
  console.log("pb288 live leg: " + (evidence.length - failed) + " passed / " + failed + " failed; leg md5 " + SELF_MD5 + "; evidence " + OUT);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("pb288 live leg crashed: " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
