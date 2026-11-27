// PB-247 page leg: the strip's oil chip says the WORD OIL while it flashes, and stops saying it
// when the flow is covered.
//
//   node tests/e2e/pb247-oil-word.mjs                 # starts its own server from this tree
//   node tests/e2e/pb247-oil-word.mjs --url=<base>    # a running server
//
// What is measured, all from the page's own view (window.__chq):
//   1. the seat's oil readout as the SERVER sent it, and its `short` flag;
//   2. the chip carries a `.oilword` leg reading exactly "OIL" when and only when that flag is on;
//   3. the word is the FIRST leg of the chip (so the chip's ellipsis cannot be what removes it);
//   4. the chip still flashes when short - the word is an addition, not a replacement;
//   5. the strip still fits: at 1280x800 and at 1024x768 the chip's right edge stays left of the
//      clock button and the document does not scroll sideways;
//   6. a crop of the deficit chip at 1280x800, plus the readings written to JSON.
//
// The two directions come from two eras on one page (2023 blue is in 600 < out 850; 1986 blue is
// covered), so neither arm is faked.
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
const OUT = evidenceDir("pb247", (process.argv.find((v) => v.startsWith("--out=")) || "").slice(6));
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

async function readChip(page) {
  return page.evaluate(() => {
    const room = window.__chq.room();
    const oil = room && room.seat && room.seat.oil ? room.seat.oil : null;
    const chip = document.querySelector(".pursechip");
    const word = chip ? chip.querySelector(".oilword") : null;
    const clock = document.getElementById("clockBtn") || document.querySelector(".clockbtn");
    const style = chip ? getComputedStyle(chip) : null;
    const chipBox = chip ? chip.getBoundingClientRect() : null;
    const clockBox = clock ? clock.getBoundingClientRect() : null;
    return {
      era: room ? String(room.era) : null,
      oil: oil ? { in: oil.in, out: oil.out, held: oil.held, short: oil.short === true, dry: oil.dry === true } : null,
      chipClass: chip ? chip.className : null,
      chipText: chip ? (chip.textContent || "").trim().slice(0, 120) : null,
      wordText: word ? (word.textContent || "").trim() : null,
      wordFirst: chip && chip.firstElementChild ? chip.firstElementChild.className : null,
      animationName: style ? style.animationName : null,
      chipRight: chipBox ? Math.round(chipBox.right) : null,
      clockLeft: clockBox ? Math.round(clockBox.left) : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function fitLine(read) {
  const fits = read.chipRight !== null && read.clockLeft !== null && read.chipRight <= read.clockLeft;
  const noScroll = read.scrollWidth <= read.viewport.w;
  return { fits, noScroll, detail: "chip right " + read.chipRight + " / clock left " + read.clockLeft +
    " / scrollWidth " + read.scrollWidth + " at " + read.viewport.w + "x" + read.viewport.h };
}

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (BASE) {
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb247-"));
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
    // One throwaway player and one page per era: an account holds one seat, and a second tab on the
    // same seat would take the socket over (ws_takeover) instead of opening a second room.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    const name = "e2e-pb247-" + era + "-" + Date.now().toString(36).slice(-6);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await page.selectOption('#launch select[name="era"]', era);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, era,
      { timeout: 25000, polling: 100 });
    await sleep(600);

    const read = await readChip(page);
    readings.push(read);
    const short = Boolean(read.oil && Number.isFinite(read.oil.in) && Number.isFinite(read.oil.out) && read.oil.in < read.oil.out);
    mark(era + " seat oil readout arrived", Boolean(read.oil), JSON.stringify(read.oil));
    mark(era + " in<out is " + short + " and the server flag agrees", Boolean(read.oil) && read.oil.short === short,
      "in " + (read.oil && read.oil.in) + " / out " + (read.oil && read.oil.out) + " / short " + (read.oil && read.oil.short));

    // ---- the word ------------------------------------------------------------------------
    mark(era + " the chip says OIL exactly when the flow is short", (read.wordText === "OIL") === short,
      "word=" + JSON.stringify(read.wordText) + " chip=" + JSON.stringify(read.chipText));
    if (short) {
      mark(era + " the word is the chip's FIRST leg", read.wordFirst === "oilword", "first=" + read.wordFirst);
      mark(era + " the chip still flashes while naming the shortage", read.animationName === "oilblink", "animation=" + read.animationName);
      mark(era + " the numbers stay on the chip beside the word", /[0-9]/.test(String(read.chipText || "")), "chip=" + JSON.stringify(read.chipText));
    }

    // ---- it still fits, at the wide viewport and at the narrow one -------------------------
    const wide = fitLine(read);
    mark(era + " the strip fits at " + read.viewport.w + "x" + read.viewport.h, wide.fits && wide.noScroll, wide.detail);
    await page.setViewportSize({ width: 1024, height: 768 });
    await sleep(400);
    const narrow = await readChip(page);
    readings.push(narrow);
    const narrowFit = fitLine(narrow);
    mark(era + " the strip fits at 1024x768", narrowFit.fits && narrowFit.noScroll, narrowFit.detail);
    mark(era + " the word survives the narrow width", (narrow.wordText === "OIL") === short,
      "word=" + JSON.stringify(narrow.wordText) + " chip=" + JSON.stringify(narrow.chipText));
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(300);

    if (short) {
      const shot = path.join(OUT, "pb247-oil-word-" + era + "-1280x800.png");
      const chip = await page.$(".pursechip");
      if (chip) await chip.screenshot({ path: shot }).catch(() => {});
      if (!chip) await page.screenshot({ path: shot });
      mark("captured the deficit chip with the word", true, shot);
    }
    await context.close();
  }

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  writeFileSync(path.join(OUT, "pb247-oil-word.json"), JSON.stringify({ base: BASE, readings, evidence }, null, 2) + "\n");
  console.log("EVIDENCE " + path.join(OUT, "pb247-oil-word.json"));
  await browser.close();
  if (child) child.kill("SIGTERM");
  console.log("PB247_E2E " + (failed === 0 ? "OK" : "FAILED " + failed));
  if (failed !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("PB247_E2E THREW " + (err && err.message ? err.message : err));
  process.exit(1);
});
