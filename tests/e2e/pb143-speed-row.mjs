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
// PB-174: the leg red-flagged itself, not the row. `setSpeed` clicked `#speedDown` after the room
// read said 1 while the click had already reached 0, so Playwright waited 30 s on a disabled button
// and the run died on a timeout instead of an assertion; and the speed-1 check asserted the
// pre-PB-164 string, so the shipped `Speed 1 · held` read red. Both are fixed here: every click is
// guarded on `.disabled` and a refused click re-reads the room, and speed 1 accepts either spelling.
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
    // PB-173: the phase word sits in its own fixed slot, so #stripInfo must not change width when
    // the clock toggles held<->running, and #clockBtn must not change with its glyph.
    stripInfo: box("stripInfo"), clockBtn: box("clockBtn"),
    clock: (window.__chq.room() || {}).clock || null,
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

    // PB-174: `#speedDown`/`#speedUp` go `disabled` at the rail, and the room read can lag a click
    // that already reached it. `page.click` on a disabled button waits out its 30 s timeout instead
    // of failing an assertion, so every click is guarded and a guarded miss re-reads the room
    // instead of looping on a dead button.
    const roomSpeed = () => page.evaluate(() => {
      const r = window.__chq.room();
      return r ? Number(r.speed) : null;
    });
    const disabled = (sel) => page.evaluate((s) => {
      const b = document.querySelector(s);
      return !b || b.disabled;
    }, sel);
    const setSpeed = async (want) => {
      for (let i = 0; i < 20; i++) {
        const got = await roomSpeed();
        if (got === null) return null;
        if (got === want) return got;
        const id = got < want ? "#speedUp" : "#speedDown";
        const clicked = await page.evaluate((sel) => {
          const b = document.querySelector(sel);
          if (!b || b.disabled) return false;
          b.click();
          return true;
        }, id);
        if (clicked) { await sleep(300); continue; }
        // The button refused the click: either the read is behind a click that already arrived, or
        // this speed is the rail. Settle, re-read, and hand the settled value to the assertions.
        await sleep(400);
        const settled = await roomSpeed();
        if (settled === want) return settled;
        if (await disabled(id)) return settled;
      }
      return await roomSpeed();
    };

    const s1 = await setSpeed(1);
    await sleep(250);
    const one = await page.evaluate(boxes);
    const s0 = await setSpeed(0);
    await sleep(250);
    const zero = await page.evaluate(boxes);
    const settled = { one: s1, zero: s0 };

    const dDown = +(zero.down.left - one.down.left).toFixed(2);
    const dUp = +(zero.up.left - one.up.left).toFixed(2);
    const dWidth = +(zero.readout.width - one.readout.width).toFixed(2);

    check(settled.one === 1, "the room settled at speed 1 before the box read", "speed " + settled.one);
    // PB-164 gave speed 1 an optional ` · held` suffix (app.js:1341): both spellings are the
    // speed-1 readout, and the leg must accept the shipped wording instead of pre-PB-164 text.
    check(one.text === "Speed 1" || one.text === "Speed 1 · held",
      "speed 1 reads `Speed 1` (PB-164's ` · held` suffix allowed)", one.text);
    check(zero.text === "Speed 0 · paused", "speed 0 reads `Speed 0 · paused`", zero.text);
    check(dDown === 0, "`-` does not move between speed 1 and speed 0", "delta " + dDown);
    check(dUp === 0, "`+` does not move between speed 1 and speed 0", "delta " + dUp);
    check(dWidth === 0, "the readout slot is the same width at both speeds", "delta " + dWidth);

    // PM 8245 §2: the geometry must hold with the clock HELD as well as running. PB-173 puts the
    // phase word in its own slot, so toggling the clock must move nothing; this pass walks the same
    // speed 1 -> speed 0 axis with the clock held and reports both deltas beside the running pair.
    const toggleClock = async (want) => {
      for (let i = 0; i < 8; i++) {
        const got = await page.evaluate(() => (window.__chq.room() || {}).clock || null);
        if (got === want) return got;
        await page.evaluate(() => {
          const b = document.getElementById("clockBtn");
          if (b) b.click();
        });
        await sleep(350);
      }
      return await page.evaluate(() => (window.__chq.room() || {}).clock || null);
    };

    // Put the clock back on the speed-1 rail before toggling: at speed 0 the clock reads `paused`,
    // and the held/running pair is only meaningful from a running clock.
    await setSpeed(1);
    await sleep(250);
    const heldState = await toggleClock("held");
    const h1 = await page.evaluate(() => {
      const r = window.__chq.room();
      return r ? Number(r.speed) : null;
    });
    await sleep(150);
    const oneHeld = await page.evaluate(boxes);
    const h0 = await setSpeed(0);
    await sleep(250);
    const zeroHeld = await page.evaluate(boxes);

    const hDown = +(zeroHeld.down.left - oneHeld.down.left).toFixed(2);
    const hUp = +(zeroHeld.up.left - oneHeld.up.left).toFixed(2);
    const hWidth = +(zeroHeld.readout.width - oneHeld.readout.width).toFixed(2);
    // Same speed, clock running vs held: nothing in the row may move either.
    const cDown = +(oneHeld.down.left - one.down.left).toFixed(2);
    const cUp = +(oneHeld.up.left - one.up.left).toFixed(2);
    const cInfo = +(oneHeld.stripInfo.width - one.stripInfo.width).toFixed(2);
    const cClock = +(oneHeld.clockBtn.width - one.clockBtn.width).toFixed(2);

    check(heldState === "held", "the clock is held for the second pass", String(heldState));
    check(h1 === 1 && h0 === 0, "the room settled at speed 1 then 0 with the clock held",
      JSON.stringify({ one: h1, zero: h0 }));
    check(hDown === 0, "`-` does not move between speed 1 and speed 0 while held", "delta " + hDown);
    check(hUp === 0, "`+` does not move between speed 1 and speed 0 while held", "delta " + hUp);
    check(hWidth === 0, "the readout slot is the same width at both speeds while held", "delta " + hWidth);
    check(cDown === 0, "`-` does not move between running and held at speed 1", "delta " + cDown);
    check(cUp === 0, "`+` does not move between running and held at speed 1", "delta " + cUp);
    check(cInfo === 0, "#stripInfo keeps its width between running and held", "delta " + cInfo
      + " " + JSON.stringify({ running: one.stripInfo && one.stripInfo.width, held: oneHeld.stripInfo && oneHeld.stripInfo.width }));
    check(cClock === 0, "#clockBtn keeps its width between running and held", "delta " + cClock);
    check(errors.length === 0, "no page error during the run", errors.slice(0, 2).join(" | "));

    const summary = {
      base: BASE, era: ERA, viewport: "1440x900",
      settledSpeed: settled, speed1: one, speed0: zero,
      speed1Held: oneHeld, speed0Held: zeroHeld,
      delta: { down: dDown, up: dUp, readoutWidth: dWidth,
        held: { down: hDown, up: hUp, readoutWidth: hWidth },
        clockToggle: { down: cDown, up: cUp, stripInfoWidth: cInfo, clockBtnWidth: cClock } },
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
