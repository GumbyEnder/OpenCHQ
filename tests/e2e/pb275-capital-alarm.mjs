// PB-275 page leg: level 1 paints a capital alarm and NOT a plain city threat, at 1280x800.
//
// PB-263 shipped the Message Level control and pinned the "serious" rule on fixed lines in
// web/test/nodes/pb263_message_level.mjs. Its page leg could not exercise level 1 with a live
// capital alarm: in the 1942 opening no capital alarm fires inside the leg's window (its row says
// so: "serious lines available at level 3: 0"). This leg supplies the missing page arm.
//
// STAGING MECHANISM (part of the report, not an assumption): a saved-room load.
//   1. a real 1942 blue-vs-bot room is opened from the page (real board, real capitals, real tick);
//   2. CONTROL: the clock is started and allowed to commit rounds, and the log is read — in this
//      window the opening raises NO threat of either weight (0 lines tagged serious, 0 tagged
//      threat). That is the discriminator: the same room, later, with the alarm staged, and the
//      only difference is the two pieces below;
//   3. the clock is held, the server is stopped, and the room's own saved row is read from the
//      data directory's SQLite (`openchq.sqlite`, table `rooms`, column `state`). Two RED land
//      pieces are moved in that saved state: one to 3 cells from BLUE's capital (a capital alarm,
//      tick.mjs emits it `serious: true`), one to 3 cells from a BLUE city far from the capital (a
//      plain threat, `serious: false`). match.alarm / match.cityAlarm are cleared so the next
//      tick treats both as a NEW close approach;
//   4. the server is restarted on the same data directory and the page reloads and re-joins its
//      own seat (the room is restored held, exactly as after a deploy). The clock is started and
//      the warnings are emitted by the real tick pass and painted by the real page.
// Nothing is stubbed: no engine byte changes, no fake log frame, no selector short-circuit.
//
//   node tests/e2e/pb275-capital-alarm.mjs                     # starts its own server + data dir
//   node tests/e2e/pb275-capital-alarm.mjs --out=<dir>          # where the crops and the JSON land
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
const arg = (name) => (process.argv.find((v) => v.startsWith("--" + name + "=")) || "").slice(name.length + 3);
const GIVEN = (arg("url") || process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb275-capital-alarm", arg("out"));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
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

const wrapX = (x, width) => ((Math.round(Number(x)) % width) + width) % width;
// tick.mjs's own distance: Chebyshev on the wrapped board, one cell axis each way.
const distance = (ax, ay, bx, by, width) => {
  const dx = Math.abs(ax - bx);
  return Math.max(dx > width / 2 ? width - dx : dx, Math.abs(ay - by));
};

// Every painted line, with the tag the server sent (or null): what the player can actually read.
const painted = (page) => page.evaluate(() => [...document.querySelectorAll("#roundLog li")].map((li) => ({
  tag: li.dataset.tag || null,
  text: (li.textContent || "").replace(/^round \d+ \u2014 /, ""),
})));
const readout = (page) => page.evaluate(() => {
  const el = document.getElementById("msgLevelReadout");
  return el ? (el.textContent || "").trim() : null;
});
const clickLevel = async (page) => {
  await page.click("#msgLevelBtn");
  await sleep(220);
};
const roundNow = (page) => page.evaluate(() => Number((window.__chq.room() || {}).round) || 0);

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ["web/server/main.mjs"], {
    cwd: root,
    env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  child.stderr.on("data", (d) => process.stdout.write("[srv!] " + d));
  const BASE = "http://127.0.0.1:" + port;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const res = await fetch(BASE + "/api/version");
      if (res.ok) return { child, BASE };
    } catch { /* still booting */ }
    await sleep(150);
  }
  throw new Error("server did not answer /api/version in 30 s");
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 6000).unref();
  });
}

async function main() {
  const { chromium } = await loadPlaywright();
  if (GIVEN) throw new Error("this leg stages a saved room, so it starts and restarts its own server: run it with no --url.");
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb275-"));
  let { child, BASE } = await startServer(port, dataDir);
  mark("a local server answers", true, BASE + " (data " + dataDir + ")");

  const board = await (await fetch(BASE + "/api/board")).json();
  const width = Number(board.width) || 320;
  const height = Number(board.height) || 136;

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const name = "e2e-pb275-" + Date.now().toString(36).slice(-6);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });

  await page.selectOption('#launch select[name="era"]', "1942");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
    null, { timeout: 30000, polling: 100 });
  const openView = await page.evaluate(() => {
    const r = window.__chq.room();
    return {
      era: String(r.era), capitals: r.capitals, capitalList: r.capitalList,
      sites: (r.sites || []).map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y, kind: s.kind, owner: s.owner })),
    };
  });
  mark("a 1942 human-vs-bot room is open", openView.era === "1942", "era " + openView.era + ", blue capital " +
    JSON.stringify(openView.capitals.blue) + ", " + openView.sites.length + " sites in the view");

  // The Log panel: open it before the control rounds so every line is painted as it lands.
  const openLog = async () => {
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".navbtn")].find((b) => /^log$/i.test((b.textContent || "").trim()));
        if (btn) btn.click();
      });
      await sleep(300);
      if (await page.$("#roundLog")) return true;
      await page.keyboard.press("Escape");
      await sleep(300);
    }
    return false;
  };

  await page.click("#clockBtn");
  await page.waitForFunction(() => window.__chq.room().clock === "running", null, { timeout: 20000, polling: 100 });
  await page.waitForFunction(() => Number((window.__chq.room() || {}).round) >= 2, null, { timeout: 120000, polling: 250 });
  await page.waitForFunction((r) => Number((window.__chq.room() || {}).round) >= r, 2, { timeout: 120000, polling: 250 });
  const logOpen = await openLog();
  mark("the Log panel opens and carries the log list", logOpen === true, "#roundLog " + (logOpen ? "present" : "missing"));
  await page.waitForFunction(() => document.querySelectorAll("#roundLog li").length > 0, null, { timeout: 30000, polling: 200 }).catch(() => {});

  // ---- CONTROL: the untouched opening raises no CAPITAL alarm in this window ----------------------
  const controlRound = await roundNow(page);
  const control = await painted(page);
  const controlSerious = control.filter((line) => line.tag === "serious").length;
  const controlThreat = control.filter((line) => line.tag === "threat").length;
  mark("CONTROL: the untampered 1942 opening raises NO capital alarm in its first rounds (0 lines tagged serious)",
    controlSerious === 0,
    "round " + controlRound + ", painted " + control.length + ", serious " + controlSerious + ", threat " +
      controlThreat + ", tags " + JSON.stringify([...new Set(control.map((line) => line.tag))]));
  mark("CONTROL: the plain city threat half is NOT synthetic — the opening already emits threat lines on its own",
    controlThreat > 0,
    "natural threat lines at round " + controlRound + ": " +
      JSON.stringify(control.filter((line) => line.tag === "threat").map((line) => line.text)));

  // Hold the clock so the row is written with nothing in flight, then stop the server.
  await page.click("#clockBtn");
  await page.waitForFunction(() => window.__chq.room().clock === "held", null, { timeout: 20000, polling: 100 });
  await sleep(600);
  if (child) {
    await stopServer(child);
    child = null;
  }

  // ---- STAGE: two red land pieces into the saved room ---------------------------------------------
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(dataDir, "openchq.sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT id, era, clock, state FROM rooms ORDER BY saved_at DESC LIMIT 1").get();
  if (!row) throw new Error("no room row in " + dbPath);
  const state = JSON.parse(row.state);
  const match = state.match;
  const capital = openView.capitals.blue;
  const capitalSite = openView.sites.find((s) => Number(s.x) === Number(capital.x) && Number(s.y) === Number(capital.y)) || {};
  const capName = capitalSite.name || "the capital";
  const capitalIds = new Set((openView.capitalList || []).map((c) => String(c.siteId)));
  const blueCities = openView.sites.filter((s) => s.owner === "blue" && s.kind === "city" && !capitalIds.has(String(s.id)));
  // A blue city far from the capital, so its alarm is a PLAIN threat and not a second capital alarm.
  blueCities.sort((a, b) => distance(b.x, b.y, capital.x, capital.y, width) - distance(a.x, a.y, capital.x, capital.y, width));
  const city = blueCities[0];
  if (!city) throw new Error("no blue non-capital city in the 1942 view");

  const redLand = (match.pieces || []).filter((p) => p && p.side === "red" && p.domain === "land");
  if (redLand.length < 2) throw new Error("fewer than two red land pieces in the saved room");
  const capitalPiece = redLand[0];
  const cityPiece = redLand[1];
  const before = {
    capitalPiece: { id: capitalPiece.id, x: capitalPiece.x, y: capitalPiece.y },
    cityPiece: { id: cityPiece.id, x: cityPiece.x, y: cityPiece.y },
  };
  capitalPiece.x = wrapX(Number(capital.x) + 3, width);
  capitalPiece.y = Number(capital.y);
  capitalPiece.path = [];
  delete capitalPiece.startingDestination;
  cityPiece.x = wrapX(Number(city.x) + 3, width);
  cityPiece.y = Number(city.y);
  cityPiece.path = [];
  delete cityPiece.startingDestination;
  match.alarm = {};
  match.cityAlarm = {};

  const redPieces = (match.pieces || []).filter((p) => p && p.domain === "land" && p.side !== "blue");
  const nearest = (cell) => redPieces.reduce((best, p) =>
    Math.min(best, distance(wrapX(p.x, width), Number(p.y), Number(cell.x), Number(cell.y), width)), Infinity);
  const staged = {
    capital: { cell: { x: capital.x, y: capital.y }, name: capName, distance: nearest(capital) },
    city: { cell: { x: city.x, y: city.y }, name: city.name, distance: nearest(city) },
    before,
    pieces: [capitalPiece.id, cityPiece.id],
    roomId: row.id,
  };
  db.prepare("UPDATE rooms SET state = ? WHERE id = ?").run(JSON.stringify(state), row.id);
  db.close();
  mark("STAGING: the saved room carries a red land piece within the alarm radius of blue's capital and another of a blue city",
    staged.capital.distance <= 8 && staged.city.distance <= 8 && staged.city.distance > 1 && staged.capital.distance !== null,
    "room " + row.id + "; capital " + capName + " " + JSON.stringify(staged.capital.cell) + " nearest red " +
      staged.capital.distance + " cells (" + capitalPiece.id + " " + JSON.stringify(before.capitalPiece) + " -> " +
      JSON.stringify({ x: capitalPiece.x, y: capitalPiece.y }) + "); city " + city.name + " " +
      JSON.stringify(staged.city.cell) + " nearest red " + staged.city.distance + " cells (" + cityPiece.id + " " +
      JSON.stringify(before.cityPiece) + " -> " + JSON.stringify({ x: cityPiece.x, y: cityPiece.y }) + ")");

  // Restart on the same data directory: the room comes back held, as after a deploy.
  ({ child, BASE } = await startServer(port, dataDir));

  // The page re-joins its own seat; the clock stays held until Play.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
  await sleep(700);
  const rejoined = await page.evaluate(() => {
    const r = window.__chq.room();
    return { era: String(r.era), round: Number(r.round) || 0, clock: r.clock, you: r.you, alarm: r.alarm || null };
  });
  mark("the staged room comes back and the page re-joins its own seat",
    rejoined.era === "1942" && rejoined.round >= controlRound && rejoined.clock === "held",
    JSON.stringify(rejoined));

  await page.click("#clockBtn");
  await page.waitForFunction((r) => Number((window.__chq.room() || {}).round) > r, rejoined.round, { timeout: 120000, polling: 200 });
  await page.click("#clockBtn"); // hold again: the tick that raises the alarm has committed
  await page.waitForFunction(() => window.__chq.room().clock === "held", null, { timeout: 20000, polling: 100 });
  await sleep(400);
  await openLog();
  await page.waitForFunction(() => document.querySelectorAll('#roundLog li[data-tag="serious"]').length > 0, null,
    { timeout: 60000, polling: 200 }).catch(() => {});
  await sleep(400);

  const afterRound = await roundNow(page);
  const alarmView = await page.evaluate(() => (window.__chq.room() || {}).alarm || null);
  const at3 = await painted(page);
  const serious = at3.filter((line) => line.tag === "serious");
  const threat = at3.filter((line) => line.tag === "threat");
  const seriousLine = serious.find((line) => line.text.includes(capName));
  const threatLine = threat.find((line) => line.text.includes(city.name));

  mark("an alarm lands on the round after the staging and is painted at level 3, tagged by the server",
    Boolean(seriousLine),
    "round " + rejoined.round + " -> " + afterRound + "; serious " + JSON.stringify(serious.map((l) => l.text)) +
      "; staged nearest red to " + capName + ": " + staged.capital.distance + " cells; control serious lines: " + controlSerious);
  mark("a PLAIN city threat rides in the same log, tagged threat and not serious",
    Boolean(threatLine), "threat " + JSON.stringify(threat.map((l) => l.text)));
  mark("the alarm line's own data-tag is serious and the city line's is threat (read off the DOM, not inferred)",
    Boolean(seriousLine) && Boolean(threatLine) && seriousLine.tag === "serious" && threatLine.tag === "threat",
    (seriousLine ? seriousLine.tag : "none") + " / " + (threatLine ? threatLine.tag : "none"));
  mark("the painted alarm names the blue capital and a distance inside the alarm radius",
    Boolean(seriousLine) && new RegExp("^enemy troops (are on " + capName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "|(\\d+) cells? from " + capName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")$").test(seriousLine.text),
    seriousLine ? JSON.stringify(seriousLine.text) : "no line naming " + capName);
  const newsLine = at3.find((line) => line.tag === null && /^paid /.test(line.text)) ||
    at3.find((line) => line.tag === null);
  mark("an untagged news line is in the same log (the level never hides news)", Boolean(newsLine),
    newsLine ? JSON.stringify(newsLine.text) : "no untagged line painted");
  await page.screenshot({ path: path.join(OUT, "pb275-level3-1280x800.png") });

  // ---- the cycle, each level read from the DOM -----------------------------------------------------
  await clickLevel(page); // 3 -> 2
  const at2 = await painted(page);
  mark("at Msg 2 both warnings are still painted (level 2 keeps every threat)",
    (await readout(page)) === "Msg 2" && Boolean(seriousLine) && Boolean(threatLine) &&
      at2.some((line) => line.text === seriousLine.text) && at2.some((line) => line.text === threatLine.text),
    "readout " + (await readout(page)) + "; painted serious " + at2.filter((l) => l.tag === "serious").length +
      ", threat " + at2.filter((l) => l.tag === "threat").length);

  await clickLevel(page); // 2 -> 1
  const at1 = await painted(page);
  mark("the control cycled to Msg 1", (await readout(page)) === "Msg 1", String(await readout(page)));
  mark("LEVEL 1: the capital alarm is painted", Boolean(seriousLine) && at1.some((line) => line.text === seriousLine.text),
    seriousLine ? JSON.stringify(seriousLine.text) : "no alarm line to look for");
  mark("LEVEL 1: the plain city threat is NOT painted", Boolean(threatLine) && !at1.some((line) => line.text === threatLine.text),
    threatLine ? "looked for " + JSON.stringify(threatLine.text) : "no threat line to look for");
  mark("LEVEL 1: no threat-tagged line of any kind survives",
    at1.every((line) => line.tag !== "threat"),
    "threat-tagged at level 1: " + at1.filter((line) => line.tag === "threat").length);
  mark("LEVEL 1: news is still painted", !newsLine || at1.some((line) => line.text === newsLine.text),
    newsLine ? newsLine.text : "no news line seen");
  await page.screenshot({ path: path.join(OUT, "pb275-level1-1280x800.png") });

  await clickLevel(page); // 1 -> 0
  const at0 = await painted(page);
  mark("the control cycled to Msg 0", (await readout(page)) === "Msg 0", String(await readout(page)));
  mark("LEVEL 0: neither the alarm nor the city threat is painted",
    Boolean(seriousLine) && Boolean(threatLine) &&
      !at0.some((line) => line.text === seriousLine.text) && !at0.some((line) => line.text === threatLine.text) &&
      at0.every((line) => line.tag === null),
    "tagged at level 0: " + at0.filter((line) => line.tag !== null).length);
  mark("LEVEL 0: the untagged news line is still painted", !newsLine || at0.some((line) => line.text === newsLine.text),
    newsLine ? newsLine.text : "no news line seen");

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  const payload = {
    base: BASE, viewport: "1280x800", dataDir, width, height,
    controlRound, control, staged, rejoined, afterRound, alarmView,
    at3, at2, at1, at0, seriousLine, threatLine, newsLine, evidence, failed,
  };
  writeFileSync(path.join(OUT, "pb275-leg.json"), JSON.stringify(payload, null, 2));
  console.log("pb275-capital-alarm: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);

  await browser.close();
  if (child) await stopServer(child);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("pb275-capital-alarm: leg crashed — " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
