// PB-250 page leg: a HUMAN proposes a cease fire to the BOT seat, and the page reads the answer.
//
//   node tests/e2e/pb250-bot-ceasefire.mjs                # starts its own server from this tree
//   node tests/e2e/pb250-bot-ceasefire.mjs --url=<base>   # a running server
//
// What the PM saw: propose at round ~1, and nothing - no accept, no decline, no line - through
// round 55. This leg asserts the human surface, at 1280x800, with real clicks:
//   1. the proposal toast appears ("until they do, the war continues");
//   2. the bot answers inside three rounds, and the SEAT frame the page reads carries it;
//   3. PB-251: the answer REPLACES that proposal sentence - the stale line is gone, not sitting
//      under a board that has already moved;
//   4. the log carries the seat's own line for the answer;
//   5. on an accept (the 1986 board gives blue 38 cities, red 17, so the bot is behind) the peace
//      is the shipped one: strip says cease-fire, the enemy is invisible, and the match is not over.
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
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb250", (process.argv.find((v) => v.startsWith("--out=")) || "").slice(6));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + detail);
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

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb250-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 20000) {
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
  const name = "e2e-pb250-" + Date.now().toString(36).slice(-6);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
    null, { timeout: 25000, polling: 100 });
  await sleep(500);
  const opened = await page.evaluate(() => ({
    era: String(window.__chq.room().era),
    seats: [window.__chq.room().blue && window.__chq.room().blue.kind, window.__chq.room().red && window.__chq.room().red.kind],
    cities: (window.__chq.room().seat && window.__chq.room().seat.cityCount) ?? null,
  }));
  mark("the room is a 1986 human-vs-bot match", opened.era === "1986" && opened.seats[1] === "bot", JSON.stringify(opened));

  // The clock must run: a tool is refused while the clock is held ("Start the clock first").
  await page.click("#clockBtn");
  await page.waitForFunction(() => window.__chq.room().clock === "running", null, { timeout: 15000, polling: 100 });
  const beforeRound = await page.evaluate(() => Number(window.__chq.room().round));
  mark("the clock is running", true, "round " + beforeRound);

  // The KIT dialog carries the tool row (dialogs.mjs: id "kit", label "Kit"); War carries the
  // seats, the clock and Begin Hostilities. The cease fire lives in the kit.
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll(".navbtn")].find((b) => /^kit$/i.test((b.textContent || "").trim()));
    if (nav) nav.click();
  });
  await page.waitForSelector("#dialogBody button", { timeout: 10000 });
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#dialogBody button")].find((b) => /^cease[ -]?fire$/i.test((b.textContent || "").trim()));
    if (!btn) return { found: false, labels: [...document.querySelectorAll("#dialogBody button")].map((b) => b.textContent) };
    const disabled = btn.disabled;
    btn.click();
    return { found: true, disabled };
  });
  mark("the Kit offers an enabled Cease-fire button", clicked.found === true && clicked.disabled === false, JSON.stringify(clicked).slice(0, 240));
  await sleep(600);
  const proposed = await page.evaluate(() => ({
    toast: window.__chq.toast(),
    status: (window.__chq.room().seat.ceasefire || {}).status,
  }));
  mark("PB-250: the proposal is on screen while it waits",
    /propose/i.test(proposed.toast) && proposed.status === "pending", JSON.stringify(proposed));
  await page.screenshot({ path: path.join(OUT, "pb250-proposed-1280x800.png") });

  // The bot answers at the next round boundary; three rounds is the card's bound, allow 4 x 5 s.
  await page.waitForFunction(() => {
    const truce = window.__chq.room().seat.ceasefire;
    return truce && truce.status !== "pending";
  }, null, { timeout: 30000, polling: 100 }).catch(() => {});
  const answer = await page.evaluate(() => {
    const room = window.__chq.room();
    const truce = room.seat.ceasefire || {};
    return {
      status: truce.status,
      by: truce.by,
      yours: truce.yours,
      round: room.round,
      toast: window.__chq.toast(),
      peace: room.peace,
      over: Boolean(room.over),
      strip: (document.getElementById("stripInfo") || {}).textContent || "",
      enemyPieces: (room.pieces || []).filter((p) => p.side === "red").length,
      log: window.__chq.log().slice(-4).map((line) => line.text || ""),
    };
  });
  mark("PB-250 AC1: the bot answered (status left pending)", answer.status === "declined" || answer.status === "accepted",
    "status=" + answer.status + " at round " + answer.round);
  mark("PB-250 AC1: the answer arrived inside three rounds", Number(answer.round) - Number(beforeRound) <= 3,
    beforeRound + " -> " + answer.round);
  // PB-251: the proposal sentence must NOT survive the answer.
  mark("PB-251: the stale proposal sentence is replaced, not left standing",
    !/until they do/i.test(answer.toast) && new RegExp(answer.status === "accepted" ? "agreed|peace" : "declined", "i").test(answer.toast),
    "toast=" + JSON.stringify(answer.toast));
  mark("PB-250 AC2: the seat's own log carries the answer",
    answer.log.some((line) => new RegExp(answer.status === "accepted" ? "agreed" : "declined", "i").test(line)),
    answer.log.join(" | ").slice(0, 240));
  if (answer.status === "accepted") {
    mark("PB-250 AC3: acceptance is a PEACE, not an ending",
      Boolean(answer.peace && answer.peace.active) && answer.over === false, JSON.stringify(answer.peace));
    mark("PB-250 AC3: the strip prints the cease fire, and the enemy is invisible",
      /cease-fire/i.test(answer.strip) && answer.enemyPieces === 0,
      "strip=" + answer.strip.replace(/\s+/g, " ").slice(0, 120) + " enemy pieces=" + answer.enemyPieces);
  } else {
    mark("PB-250 AC3: a decline leaves the war running and starts no peace",
      !(answer.peace && answer.peace.active), JSON.stringify(answer.peace));
  }
  await page.screenshot({ path: path.join(OUT, "pb250-answered-1280x800.png") });

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  writeFileSync(path.join(OUT, "pb250-bot-ceasefire.json"),
    JSON.stringify({ base: BASE, opened, beforeRound, proposed, answer, evidence }, null, 2) + "\n");
  console.log("EVIDENCE " + path.join(OUT, "pb250-bot-ceasefire.json"));
  await context.close();
  await browser.close();
  if (child) child.kill("SIGTERM");
  console.log("PB250_E2E " + (failed === 0 ? "OK" : "FAILED " + failed));
  if (failed !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("PB250_E2E THREW " + (err && err.message ? err.message : err));
  process.exit(1);
});
