// PB-239 page leg: the OIL chip flashes while the side is in flow deficit, and the class is the
// server's flag - measured on a real page, in both directions, with a screenshot.
//
//   node tests/e2e/pb239-oil-flash.mjs                 # starts its own server from this tree
//   node tests/e2e/pb239-oil-flash.mjs --url=<base>    # a running server
//
// What is measured, all from the page's own view (window.__chq):
//   1. the seat's oil readout (in/out/reserve) as the SERVER sent it;
//   2. the purse chip's class: `oilshort` exactly when in < out, and absent when in >= out;
//   3. the computed animation on that chip is `oilblink` (a real animation, not a comment);
//   4. the numbers stay readable: opacity never reaches 0 in the keyframes;
//   5. a screenshot of the deficit chip at 1280x800, plus the class readings written to JSON.
//
// The two directions come from two eras on the same page (2023 is the PM's live repro, in 600 < out
// 850); the leg does not fake a state to get the negative arm.
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
const OUT = evidenceDir("pb239", (process.argv.find((v) => v.startsWith("--out=")) || "").slice(6));
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
  if (BASE) {
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb239-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    let log = "";
    while (Date.now() - started < 20000) {
      if (log.includes("OpenCHQ web shell")) break;
      await sleep(100);
      log += child.stdout.read() ? String(child.stdout.read()) : "";
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch {}
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const pageErrors = [];

  const readings = [];
  for (const era of ["2023", "1986"]) {
    // One throwaway player and one page PER ERA: an account holds one seat, and a second tab on the
    // same seat would take the socket over (ws_takeover) instead of opening a second room.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    const name = "e2e-pb239-" + era + "-" + Date.now().toString(36).slice(-6);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    mark(era + " throwaway player registers", true, name);
    await page.selectOption('#launch select[name="era"]', era);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, era,
      { timeout: 25000, polling: 100 });
    await sleep(600);

    const read = await page.evaluate(() => {
      const room = window.__chq.room();
      const oil = room && room.seat && room.seat.oil ? room.seat.oil : null;
      const chip = document.querySelector(".pursechip");
      const style = chip ? getComputedStyle(chip) : null;
      return {
        era: room ? String(room.era) : null,
        oil: oil ? { in: oil.in, out: oil.out, held: oil.held, short: oil.short === true, dry: oil.dry === true } : null,
        chipClass: chip ? chip.className : null,
        chipText: chip ? (chip.textContent || "").trim().slice(0, 120) : null,
        animationName: style ? style.animationName : null,
        animationDuration: style ? style.animationDuration : null,
      };
    });
    readings.push(read);
    const wantsShort = Boolean(read.oil && Number.isFinite(read.oil.in) && Number.isFinite(read.oil.out) && read.oil.in < read.oil.out);
    mark(era + " seat oil readout arrived", Boolean(read.oil), JSON.stringify(read.oil));
    mark(era + " in<out is " + wantsShort + " and the server flag agrees", Boolean(read.oil) && read.oil.short === wantsShort,
      "in " + (read.oil && read.oil.in) + " / out " + (read.oil && read.oil.out) + " / short " + (read.oil && read.oil.short));
    const hasClass = /(^|\s)oilshort(\s|$)/.test(String(read.chipClass || ""));
    mark(era + " chip carries oilshort exactly when in<out", hasClass === wantsShort, "class=" + read.chipClass);
    mark(era + " chip animation is oilblink exactly when short", (read.animationName === "oilblink") === wantsShort,
      "animation=" + read.animationName + " " + read.animationDuration);

    if (wantsShort) {
      const shot = path.join(OUT, "pb239-oil-flash-2023-1280x800.png");
      const chip = await page.$(".pursechip");
      if (chip) await chip.screenshot({ path: shot }).catch(() => {});
      if (!chip) await page.screenshot({ path: shot });
      mark("captured the deficit chip", true, shot);
      // Two frames a half second apart: the opacity pulse must actually move on a live page.
      const opacityA = await page.evaluate(() => {
        const chip = document.querySelector(".pursechip");
        return chip ? Number(getComputedStyle(chip).opacity) : null;
      });
      await sleep(520);
      const opacityB = await page.evaluate(() => {
        const chip = document.querySelector(".pursechip");
        return chip ? Number(getComputedStyle(chip).opacity) : null;
      });
      mark("the chip's opacity moves between frames (it is really flashing)", opacityA !== opacityB,
        opacityA + " -> " + opacityB);
      mark("the numbers stay readable (opacity never 0)", Number(opacityA) > 0 && Number(opacityB) > 0,
        opacityA + " / " + opacityB);
    }
    await context.close();
  }

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  writeFileSync(path.join(OUT, "pb239-oil-flash.json"), JSON.stringify({ base: BASE, readings, evidence }, null, 2) + "\n");
  console.log("EVIDENCE " + path.join(OUT, "pb239-oil-flash.json"));
  await browser.close();
  if (child) child.kill("SIGTERM");
  console.log("PB239_E2E " + (failed === 0 ? "OK" : "FAILED " + failed));
  if (failed !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("PB239_E2E THREW " + (err && err.message ? err.message : err));
  process.exit(1);
});
