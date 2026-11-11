// OpenCHQ soak: T-007 AC6. One live bot match, thirty minutes of wall clock, a screenshot of the
// round counter at the start and at the end, and every "Connection lost" toast counted on the way.
//
//   node tests/e2e/soak.mjs --url=https://openchq-web-production.up.railway.app
//   node tests/e2e/soak.mjs --url=http://127.0.0.1:8094 --minutes=2      # a short rehearsal
//
// Options: --minutes=N (default 30), --era=1942, --headed, --out=DIR.
// Credentials never live in this file: E2E_USER / E2E_PASS when both are set, otherwise a
// throwaway account from E2E_PREFIX (default "soak") plus a timestamp.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/soak.mjs --url=<local or live base url> [--minutes=30]");
  process.exit(2);
}
const MINUTES = Number(argOf("minutes", "30")) || 30;
const ERA = String(argOf("era", "1942"));
const HEADED = process.argv.includes("--headed");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve(argOf("out", path.join(here, "soak-" + STAMP)));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOST = /connection lost|lost the connection|reconnecting/i;

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    path.join(here, "..", "..", "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  const tried = [];
  for (const candidate of candidates) {
    if (candidate !== "playwright" && !existsSync(candidate)) {
      tried.push(candidate + " (missing)");
      continue;
    }
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      tried.push(candidate + " (" + (err && err.message) + ")");
    }
  }
  try {
    return await import("playwright");
  } catch (err) {
    tried.push("playwright (" + (err && err.message) + ")");
  }
  throw new Error("no Playwright module found:\n  " + tried.join("\n  "));
}

const roomOf = (page) => page.evaluate(() => window.__chq.room());
const shot = async (page, name) => {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
};

const main = async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message)));

  const run = {
    base: BASE, era: ERA, minutes: MINUTES, startedAt: new Date().toISOString(),
    lostSeen: [], samples: [], pageErrors, outcome: "incomplete",
  };

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });

    const user = process.env.E2E_USER || "";
    const pass = process.env.E2E_PASS || "";
    if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
      if (user && pass) {
        await page.fill("#login input[name=username]", user);
        await page.fill("#login input[name=password]", pass);
        await page.click("#login button[type=submit]");
        run.account = user;
      } else {
        const name = (process.env.E2E_PREFIX || "soak") + Date.now().toString(36).slice(-8);
        const password = process.env.E2E_PASSWORD || "pw-" + Math.random().toString(36).slice(2, 12);
        await page.fill("#register input[name=username]", name);
        await page.fill("#register input[name=password]", password);
        await page.click("#register button[type=submit]");
        run.account = name;
      }
      await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    } else {
      run.account = "session";
    }

    await page.selectOption('#launch select[name="era"]', ERA);
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((era) => window.__chq.room() && String(window.__chq.room().era) === era, ERA,
      { timeout: 25000 });
    const opened = await roomOf(page);
    run.roundAtStart = Number(opened.round) || 0;
    run.poolAtStart = opened.cash === undefined ? null : opened.cash;
    run.screenshotStart = await shot(page, "soak-start-round-" + run.roundAtStart + ".png");
    console.log("start: era " + ERA + " at round " + run.roundAtStart + " -> " + run.screenshotStart);

    await page.click("#clockBtn");
    const deadline = Date.now() + MINUTES * 60 * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      tick += 1;
      const sample = await page.evaluate(() => {
        const room = window.__chq.room();
        return {
          round: room ? Number(room.round) : null,
          toast: window.__chq.toast(),
          socket: window.__chq.socketState(),
          outbox: window.__chq.outbox(),
        };
      });
      if (LOST.test(String(sample.toast))) {
        run.lostSeen.push({ at: new Date().toISOString(), round: sample.round, toast: sample.toast });
        console.log("CONNECTION LOST toast at round " + sample.round + ": " + sample.toast);
      }
      if (sample.socket !== "open") {
        run.samples.push({ at: new Date().toISOString(), ...sample });
      }
      if (tick % 60 === 0) {
        const left = Math.max(0, Math.round((deadline - Date.now()) / 60000));
        console.log("  round " + sample.round + ", socket " + sample.socket + ", " + left + " min left");
      }
    }

    const ended = await roomOf(page);
    run.roundAtEnd = Number(ended.round) || 0;
    run.screenshotEnd = await shot(page, "soak-end-round-" + run.roundAtEnd + ".png");
    console.log("end: round " + run.roundAtEnd + " -> " + run.screenshotEnd);

    await page.click("#quitBtn").catch(() => {});
    run.outcome = "finished";
  } catch (err) {
    run.outcome = "error";
    run.error = String((err && err.stack) || err).split("\n")[0];
  } finally {
    run.finishedAt = new Date().toISOString();
    run.roundsPlayed = (run.roundAtEnd || 0) - (run.roundAtStart || 0);
    run.lostCount = run.lostSeen.length;
    writeFileSync(path.join(OUT, "soak.json"), JSON.stringify(run, null, 2));
    await browser.close();
  }

  const ok = run.outcome === "finished" && run.lostCount === 0 && run.roundsPlayed > 0 && run.pageErrors.length === 0;
  console.log("");
  console.log("SOAK summary (" + BASE + ")");
  console.log("  minutes: " + MINUTES + ", era " + ERA + ", rounds " + run.roundAtStart + " -> " + run.roundAtEnd + " (" + run.roundsPlayed + ")");
  console.log("  \"Connection lost\" toasts: " + run.lostCount);
  console.log("  socket samples not open: " + run.samples.length);
  console.log("  page errors: " + run.pageErrors.length);
  console.log("  screenshots: " + run.screenshotStart + " , " + run.screenshotEnd);
  console.log("  json: " + path.join(OUT, "soak.json"));
  console.log(ok ? "  SOAK_OK" : "  SOAK_FAILED " + (run.error || ""));
  process.exitCode = ok ? 0 : 1;
};

await main();
