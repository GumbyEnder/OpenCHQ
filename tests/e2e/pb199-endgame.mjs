// PB-199 page leg: the end of a match is readable, and dead, at 1280 and 1024 - before AND after a
// reload.
//
//   node tests/e2e/pb199-endgame.mjs                 # starts its own server
//   node tests/e2e/pb199-endgame.mjs --url=<base>    # a running server
//   node tests/e2e/pb199-endgame.mjs --out=<dir>
//
// The defect (re-measured on live 235a77a, game row 10363; PM 10369 §1):
//   (a) after Resign a reload replaced the result line with "Both seats are present. The clock is
//       still held." - the note was rewritten by holdRoom/seatView - and a resignation carried the
//       capitals list although it names no capital;
//   (b) no Log line recorded the end of the match;
//   (c) Resign stayed lit, and the ▶ was OBEYED on a finished match (held -> running);
//   (d) War > "Leave the match" ended the room on one click, with no confirm.
//
// Arms per viewport (1280x800, 1024x768):
//   (a1) after the resign the result line is "You resigned. Red wins." and names no capital;
//   (a2) the room's note is the same sentence (result.reason/result.by drive the page, not the note);
//   (b1) exactly one Log line carries that sentence, visible to the seat that resigned;
//   (c1) Resign and the strip's ▶ are disabled, and the clock is still held;
//   (a3/a4/b2/c2) after a RELOAD: the line, the note, the one Log line and both disabled controls
//        survive; the clock is still held;
//   (c3) the ▶ handler itself refuses on the over frame even when the disabled attribute is removed
//        (the client half of the server's "The match is already over."), clock unchanged;
//   (d1) War > Leave the match with the confirm DISMISSED leaves the match running;
//   (d2) with the confirm ACCEPTED it leaves, and the lobby comes back.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb199-endgame", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const SENTENCE = "Blue resigned. Red wins.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 1200) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb199-endgame.json"), JSON.stringify({ evidence }, null, 2));
}

let BASE = "";
let child = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

// One read of everything the arms grade, in ONE evaluate so the numbers describe one frame.
const snapshot = (page) => page.evaluate(() => {
  const room = window.__chq.room();
  const log = window.__chq.log();
  const clockBtn = document.getElementById("clockBtn");
  const resignBtn = document.getElementById("resignBtn");
  return {
    id: room ? room.id : null,
    over: room ? Boolean(room.over) : null,
    clock: room ? room.clock : null,
    note: room ? room.note : null,
    result: room && room.result ? { reason: room.result.reason, by: room.result.by ?? null, winner: room.result.winner ?? null } : null,
    line: window.__chq.result(),
    logTexts: log.map((line) => String(line && line.text || "")),
    clockDisabled: clockBtn ? clockBtn.disabled : null,
    clockTitle: clockBtn ? clockBtn.title : null,
    resignDisabled: resignBtn ? resignBtn.disabled : null,
    resignTitle: resignBtn ? resignBtn.title : null,
    lobbyVisible: !document.getElementById("play")?.classList.contains("hidden"),
  };
});

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

async function openMatch(page, era) {
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click("#launch button[type=submit]");
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
  await sleep(400);
}

// A reload is a socket close plus a fresh connect: holdRoom then seatView. The page boots, then the
// welcome frame carries the room back.
async function reload(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.waitForFunction(() => Boolean(window.__chq.room()), null, { timeout: 30000, polling: 120 });
  await sleep(700);
}

async function waitClock(page, state, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const now = await page.evaluate(() => (window.__chq.room() ? window.__chq.room().clock : null));
    if (now === state) return true;
    await sleep(60);
  }
  return false;
}

async function main() {
  const { chromium } = await loadPlaywright();

  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb199-page-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* still booting */ }
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    const tag = Date.now().toString(36).slice(-5) + viewport.width;
    const at = " @" + viewport.width + "x" + viewport.height;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    await signIn(page, "P199" + tag, "pw-199-" + tag);
    await openMatch(page, "1942");
    const fresh = await snapshot(page);
    mark("a solo 1942 war is open" + at, Boolean(fresh.id) && fresh.over === false, JSON.stringify({ id: fresh.id, clock: fresh.clock }));

    // ---- resign ---------------------------------------------------------------------------
    page.once("dialog", (dialog) => dialog.accept());
    await page.evaluate(() => document.getElementById("resignBtn").click());
    const overOk = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 12000) {
        const snap = await snapshot(page);
        if (snap.over) return snap;
        await sleep(120);
      }
      return null;
    })();
    mark("(a1) the resign reaches the over frame" + at, Boolean(overOk), overOk ? overOk.line : "no over frame within 12 s");
    const after = overOk || await snapshot(page);
    mark("(a1) the result line names the resignation" + at, after.line === "You resigned. Red wins.", JSON.stringify(after.line));
    mark("(a1) the resignation names no capital" + at, !/Capitals/i.test(after.line), JSON.stringify(after.line));
    mark("(a2) the room's note is the same sentence" + at, after.note === SENTENCE, JSON.stringify(after.note));
    mark("(a2) the result carries the resigning side" + at,
      after.result && after.result.reason === "resignation" && after.result.by === "blue" && after.result.winner === "red",
      JSON.stringify(after.result));
    mark("(b1) one Log line records the end" + at,
      after.logTexts.filter((text) => text === SENTENCE).length === 1,
      JSON.stringify(after.logTexts.slice(-4)));
    mark("(c1) Resign and the clock are disabled" + at, after.clockDisabled === true && after.resignDisabled === true,
      JSON.stringify({ clock: after.clockDisabled, resign: after.resignDisabled, titles: [after.clockTitle, after.resignTitle] }));
    mark("(c1) the clock is still held" + at, after.clock === "held", JSON.stringify(after.clock));

    // ---- reload ---------------------------------------------------------------------------
    await reload(page);
    const reloaded = await snapshot(page);
    mark("(a3) the result line survives the reload" + at, reloaded.line === "You resigned. Red wins.", JSON.stringify(reloaded.line));
    mark("(a4) the note survives the reload" + at, reloaded.note === SENTENCE, JSON.stringify(reloaded.note));
    mark("(b2) the Log line survives the reload" + at,
      reloaded.logTexts.filter((text) => text === SENTENCE).length === 1,
      JSON.stringify(reloaded.logTexts.slice(-4)));
    mark("(c2) both controls are still disabled after the reload" + at,
      reloaded.clockDisabled === true && reloaded.resignDisabled === true,
      JSON.stringify({ clock: reloaded.clockDisabled, resign: reloaded.resignDisabled }));
    mark("(c2) the clock is still held after the reload" + at, reloaded.clock === "held", JSON.stringify(reloaded.clock));

    // ---- the client half of the clock refusal ----------------------------------------------
    await page.evaluate(() => {
      const button = document.getElementById("clockBtn");
      button.disabled = false; // reach the handler as if the attribute were never set
      button.click();
      button.disabled = true;
    });
    await sleep(700);
    const afterClick = await snapshot(page);
    mark("(c3) the ▶ handler refuses on the over frame" + at,
      afterClick.clock === "held" && afterClick.over === true,
      JSON.stringify({ clock: afterClick.clock, wireTail: await page.evaluate(() => window.__chq.wire().slice(-2)) }));

    // ---- (d) War > Leave the match asks first -----------------------------------------------
    await page.click('#nav .navbtn[data-dialog="war"]');
    await page.waitForSelector('#dialogBody button', { timeout: 8000 });
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("#dialogBody button")].find((b) => /Leave the match/.test(b.textContent || ""));
      if (button) button.click();
    });
    await sleep(600);
    const kept = await snapshot(page);
    mark("(d1) a dismissed Leave confirm keeps the match" + at, Boolean(kept.id) && kept.over === true,
      JSON.stringify({ id: kept.id, over: kept.over }));

    page.once("dialog", (dialog) => dialog.accept());
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("#dialogBody button")].find((b) => /Leave the match/.test(b.textContent || ""));
      if (button) button.click();
    });
    const left = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 9000) {
        const snap = await snapshot(page);
        if (!snap.id) return snap;
        await sleep(120);
      }
      return null;
    })();
    mark("(d2) an accepted Leave confirm leaves the match" + at, Boolean(left), left ? JSON.stringify({ id: left.id, lobby: left.lobbyVisible }) : "still in a room after 9 s");

    mark("no page errors" + at, errors.length === 0, JSON.stringify(errors));
    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");

  console.log(failed === 0 ? "PB199_PAGE_OK " + evidence.length + "/0/" + evidence.length : "PB199_PAGE_RED " + failed + "/" + evidence.length);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
