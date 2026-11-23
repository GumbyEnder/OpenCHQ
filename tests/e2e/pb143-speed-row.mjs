// PB-143 speed row: `+` must not move when the readout changes width.
//
//   node tests/e2e/pb143-speed-row.mjs --url=http://127.0.0.1:PORT
//
// The claim is about boxes, not CSS: `#speedDown` and `#speedUp` must sit at the same x at speed 1
// and at speed 0, where the readout reads `Speed 0 · paused` and is ~20.75 px wider than `Speed 1`.
// Measured on live 4f7c503 (Playwright, 1440x900, era 1942): readout width 74.00 -> 94.75 px and
// `+` left 599.63 -> 620.38 (delta +20.75). This leg prints the delta and exits 1 while it is
// non-zero, which is the red half of the fix.
//
// It drives the real page as a player: throwaway sign-in, Play a bot, the speed buttons.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
};

const BASE = (arg("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) { console.error("usage: node pb143-speed-row.mjs --url=<base>"); process.exit(2); }
const ERA = arg("era", "1942");
const OUT = path.join(here, "pb143-speed-row-" + new Date().toISOString().replace(/[:.]/g, "-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
function check(ok, label, detail = "") {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));
}

const boxes = () => {
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), width: +r.width.toFixed(2) };
  };
  return {
    text: (document.getElementById("speedReadout") || {}).textContent || "",
    down: box("speedDown"), readout: box("speedReadout"), up: box("speedUp"),
  };
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
      const name = "speedrow" + Date.now().toString(36).slice(-8);
      const password = "pw-" + Math.random().toString(36).slice(2, 12);
      await page.fill("#register input[name=username]", name);
      await page.fill("#register input[name=password]", password);
      await page.click("#register button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    }
    await page.selectOption('#launch select[name="era"]', ERA);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e,
      ERA, { timeout: 30000, polling: 100 });
    await page.waitForSelector("#speedUp", { state: "visible", timeout: 15000 });

    const setSpeed = async (want) => {
      for (let i = 0; i < 12; i++) {
        const r = await page.evaluate(() => window.__chq.room());
        if (!r) return null;
        if (Number(r.speed) === want) return r;
        await page.click(Number(r.speed) < want ? "#speedUp" : "#speedDown");
        await sleep(300);
      }
      return await page.evaluate(() => window.__chq.room());
    };

    await setSpeed(1);
    await sleep(250);
    const one = await page.evaluate(boxes);
    await setSpeed(0);
    await sleep(250);
    const zero = await page.evaluate(boxes);

    const dDown = +(zero.down.left - one.down.left).toFixed(2);
    const dUp = +(zero.up.left - one.up.left).toFixed(2);
    const dWidth = +(zero.readout.width - one.readout.width).toFixed(2);

    check(one.text === "Speed 1", "speed 1 reads `Speed 1`", one.text);
    check(zero.text.indexOf("paused") >= 0, "speed 0 reads the paused text", zero.text);
    check(dDown === 0, "`-` does not move between speed 1 and speed 0", "delta " + dDown);
    check(dUp === 0, "`+` does not move between speed 1 and speed 0", "delta " + dUp);
    check(dWidth === 0, "the readout slot is the same width at both speeds", "delta " + dWidth);
    check(errors.length === 0, "no page error during the run", errors.slice(0, 2).join(" | "));

    const summary = {
      base: BASE, era: ERA, viewport: "1440x900",
      speed1: one, speed0: zero,
      delta: { down: dDown, up: dUp, readoutWidth: dWidth },
      checks: rows,
    };
    writeFileSync(path.join(OUT, "pb143-speed-row.json"), JSON.stringify(summary, null, 2));
    console.log("summary " + path.join(OUT, "pb143-speed-row.json"));
    console.log("PB143_" + (rows.every((r) => r.ok) ? "OK" : "FAILED") + " "
      + rows.filter((r) => r.ok).length + "/" + rows.length + " checks, upLeft " + dUp);
    process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
