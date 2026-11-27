// PB-316 page leg: a strike ordered at speed 0 prints its line in the seat's Log AT THE ORDER, the
// round readout stays 0, and one round later the line is still exactly one line (manual p.25, p.32).
//
//   node tests/e2e/pb316-mission-log-at-order.mjs                  # starts its own server
//   node tests/e2e/pb316-mission-log-at-order.mjs --url=<base>     # a running server
//   node tests/e2e/pb316-mission-log-at-order.mjs --out=<dir>
//
// What breaks if this is removed: at speed 0 a war runs no round, so the mission's events sat in
// `pendingEvents` and neither seat's Log ever printed the strike. The page showed the target lose
// half its strength with no line saying why. Measured RED at 7ba897d: no #roundLog line carries
// "an aircraft flew a strike" while the round is 0.
//
// Read from the page, not the store: the painted rows of #roundLog (the dialog the player opens),
// the War panel's Round row (the round readout on screen), and the room frame's own air briefing.
// The order itself is sent through the page's own socket (`window.__chq.send`) after the seat has
// bought the aircraft through the same socket - the two controls this leg is not about - and every
// assertion after that is a read of what the page paints.

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
const OUT = evidenceDir("pb316-mission-log-at-order", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const STRIKE_LINE = "an aircraft flew a strike";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 300)));
  writeFileSync(path.join(OUT, "pb316-mission-log-at-order.json"), JSON.stringify({ evidence }, null, 2));
}

let BASE = "";

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

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

// The painted Log: each row's own round prefix and its text, exactly as the player reads them.
const paintedLog = (page) => page.evaluate(() => [...document.querySelectorAll("#roundLog li")].map((li) => {
  const text = (li.textContent || "").trim();
  const hit = /^round (\d+) \u2014 /.exec(text);
  return { round: hit ? Number(hit[1]) : null, text: hit ? text.slice(hit[0].length) : text };
}));

// The on-screen round readout: the War panel's own Round row.
async function warRound(page) {
  await page.evaluate(() => {
    const button = document.querySelector('#nav button[data-dialog="war"]');
    if (button) button.click();
  });
  await sleep(220);
  const value = await page.evaluate(() => {
    for (const row of document.querySelectorAll("#dialogBody dl")) {
      const terms = [...row.querySelectorAll("dt")];
      for (const dt of terms) {
        if ((dt.textContent || "").trim() === "Round") {
          const dd = dt.nextElementSibling;
          if (dd) return (dd.textContent || "").trim();
        }
      }
    }
    return null;
  });
  await page.evaluate(() => {
    const button = document.querySelector('#nav button[data-dialog="log"]');
    if (button) button.click();
  });
  await sleep(220);
  return value;
}

const strikeLines = async (page) => (await paintedLog(page)).filter((row) => row.text === STRIKE_LINE);

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb316-page-"));
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
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    const tag = Date.now().toString(36).slice(-6) + viewport.width;
    const ctxBlue = await browser.newContext({ viewport });
    const ctxRed = await browser.newContext({ viewport });
    const blue = await ctxBlue.newPage();
    const red = await ctxRed.newPage();
    const errors = [];
    blue.on("pageerror", (err) => errors.push("blue: " + String(err)));
    red.on("pageerror", (err) => errors.push("red: " + String(err)));
    const blueName = "P316Blue" + tag;
    const redName = "P316Red" + tag;
    const at = " @" + viewport.width + "x" + viewport.height;

    await signIn(blue, blueName, "pw-blue-" + tag);
    await signIn(red, redName, "pw-red-" + tag);

    // A two-human 1942 war: 1986 opens in the cold war, where the peace beat drains the queue and the
    // defect this leg pins cannot appear (the 1986 trap).
    await blue.selectOption('#launch select[name="era"]', "1942");
    await blue.selectOption('#launch select[name="side"]', "blue");
    await blue.waitForSelector("li.person", { timeout: 25000 });
    await blue.evaluate((name) => {
      const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
      row.querySelector("button").click();
    }, redName);
    await red.waitForSelector("#invites .invite button", { timeout: 25000 });
    await red.evaluate(() => document.querySelector("#invites .invite button").click());
    await blue.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "human",
      null, { timeout: 25000, polling: 100 });
    const roomId = await blue.evaluate(() => window.__chq.room().id);
    await red.waitForFunction((id) => window.__chq.room() && window.__chq.room().id === id, roomId,
      { timeout: 25000, polling: 100 });
    await sleep(300);
    mark("a two-human 1942 room is open" + at, true, blueName + " / " + redName + " room " + roomId);

    // ---- the clock runs at speed 0: a war with no round ------------------------------------------
    await blue.evaluate(() => document.getElementById("clockBtn").click());
    await blue.waitForFunction(() => window.__chq.room() && window.__chq.room().clock === "running",
      null, { timeout: 10000, polling: 80 });
    for (let i = 0; i < 6; i += 1) {
      const speed = await blue.evaluate(() => Number(window.__chq.room().speed));
      if (speed <= 0) break;
      await blue.evaluate(() => document.getElementById("speedDown").click());
      await sleep(220);
    }
    await blue.waitForFunction(() => window.__chq.room() && Number(window.__chq.room().speed) === 0,
      null, { timeout: 10000, polling: 80 });
    const atZero = await blue.evaluate(() => {
      const room = window.__chq.room();
      return { round: room.round, clock: room.clock, speed: room.speed };
    });
    mark("the clock runs at speed 0 with the round still 0" + at,
      Number(atZero.round) === 0 && atZero.clock === "running" && Number(atZero.speed) === 0,
      JSON.stringify(atZero));

    // ---- a blue city the aircraft can be bought at ----------------------------------------------
    const bought = await blue.evaluate(async () => {
      const room = window.__chq.room();
      const cities = (room.sites || []).filter((site) => site.owner === "blue" &&
        ["city", "capital", "base"].includes(String(site.kind)));
      const before = new Set((room.pieces || []).map((piece) => String(piece.id)));
      for (const city of cities) {
        window.__chq.send({ op: "buy", kind: "aircraft", x: city.x, y: city.y });
        for (let i = 0; i < 40; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          const now = window.__chq.room();
          const plane = (now.pieces || []).find((piece) => piece.side === "blue" &&
            piece.kind === "aircraft" && !before.has(String(piece.id)));
          if (plane) return { plane: { id: plane.id, x: plane.x, y: plane.y }, city: { x: city.x, y: city.y } };
        }
      }
      return { error: "no aircraft bought", cities: cities.length };
    });
    if (bought.error) {
      mark("the seat bought an aircraft" + at, false, JSON.stringify(bought));
      await ctxBlue.close(); await ctxRed.close();
      continue;
    }
    mark("the seat bought an aircraft" + at, true, JSON.stringify(bought));

    // ---- the strike, at speed 0, with the round at 0 --------------------------------------------
    const target = { x: (bought.city.x + 2) % 320, y: bought.city.y };
    await blue.evaluate((args) => window.__chq.send({
      op: "mission", piece: args.piece, mode: "strike", to: args.to, id: "pb316-page-" + Date.now(),
    }), { piece: bought.plane.id, to: target });

    await blue.evaluate(() => {
      const button = document.querySelector('#nav button[data-dialog="log"]');
      if (button) button.click();
    });
    await sleep(400);
    let lines = await strikeLines(blue);
    if (!lines.length) {
      // The dialog repaint is driven by the next frame; give it one settle, then read again.
      await sleep(600);
      lines = await strikeLines(blue);
    }
    mark("the strike's line is in the Log while the round readout stays 0" + at,
      lines.length === 1 && lines[0].round === 0,
      "lines=" + JSON.stringify(lines) + " room=" + JSON.stringify(await blue.evaluate(() => window.__chq.room().round)));
    const roundRow = await warRound(blue);
    mark("the War panel's Round row reads 0 with the line on screen" + at, roundRow === "0", "Round=" + JSON.stringify(roundRow));
    const air = await blue.evaluate((id) => {
      const room = window.__chq.room();
      const briefing = (room.seat && room.seat.air ? room.seat.air : []).find((piece) => String(piece.id) === String(id)) || {};
      return { ready: briefing.ready, roundsLeft: briefing.roundsLeft };
    }, bought.plane.id);
    mark("the aircraft reads ready:false / 8 at the order" + at,
      air.ready === false && Number(air.roundsLeft) === 8, JSON.stringify(air));

    // ---- one round at speed 1: still exactly one line --------------------------------------------
    await blue.evaluate(() => document.getElementById("speedUp").click());
    await blue.waitForFunction(() => window.__chq.room() && Number(window.__chq.room().round) >= 1,
      null, { timeout: 25000, polling: 120 });
    await sleep(400);
    await blue.evaluate(() => {
      const button = document.querySelector('#nav button[data-dialog="log"]');
      if (button) button.click();
    });
    await sleep(400);
    const after = await strikeLines(blue);
    const roundNow = await blue.evaluate(() => window.__chq.room().round);
    mark("the line does not become two lines after one round" + at,
      after.length === 1 && Number(roundNow) >= 1, "count=" + after.length + " round=" + roundNow);
    mark("the attack reads with no page errors" + at, errors.length === 0, errors.join(" | "));

    await ctxBlue.close();
    await ctxRed.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");
  console.log((failed ? "FAILED " : "PASSED ") + (evidence.length - failed) + "/" + evidence.length);
  console.log("EVIDENCE " + path.join(OUT, "pb316-mission-log-at-order.json"));
  if (failed) process.exitCode = 1;
  else console.log("PB316_E2E PASSED " + evidence.length);
}

main().catch((err) => {
  console.error("PB316_E2E ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
