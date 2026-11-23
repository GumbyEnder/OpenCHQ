// PB-173 + PB-180 leg: no strip box may change width when the clock is toggled, and the strip's
// readouts must show their whole string at the widths the cards name.
//
//   node tests/e2e/pb173-speed-slots.mjs                 # starts its own server
//   node tests/e2e/pb173-speed-slots.mjs --url=<base>    # use a running server
//
// PB-173: three boxes in the strip are content-sized, so toggling the clock changes their width and
// the speed control can walk with them (#stripInfo -10.65 px, #purseChip +9.25 px, #clockBtn
// -9.78 px, row -11.18 px on live eea6834). PB-180: at 1280x800 #stripInfo rendered 50 of 151 px
// and #purseChip 182 of 548 px, both ellipsized.
//
// This leg reads real bounding boxes off a real page in a real match at every named width, and it
// toggles the clock at each width — a slot that holds at 1440 and breaks at 1280 is not a slot.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
// The full economy string the title must carry is the SAME function the page renders the dialogue
// with — not a regex over a substring, so "the ledger is one hover away" is measured against the
// seat the server actually sent (frodo 8327 §6).
import { purseText } from "../../web/public/command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb173")));
console.log("out dir: " + OUT + " (pass --out=<dir> or --out <dir> to move it)");
const WIDTHS = (argOf("widths", "1440x900,1280x800,1024x768")).split(",").map((s) => {
  const [w, h] = s.split("x").map(Number);
  return { w, h, label: s };
});
const TOL = 0.05;
// The ledger the strip no longer prints has to be one hover away at EVERY width (frodo 8327): the
// oil budget line and the payday countdown, not just the income leg.
const LEDGER = /oil in \d+ \/ out \d+ \/ reserve \d+/;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}
const near = (a, b) => Math.abs(a - b) <= TOL;
const d2 = (a, b) => (a == null || b == null ? null : +(b - a).toFixed(2));

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb173-"));
let server = null;
let browser = null;
let BASE = GIVEN;
const series = [];

const BOXES = [
  ["brand", "#strip > .brand"],
  ["stripInfo", "#stripInfo"],
  ["phase", "#stripInfo .phase"],
  ["purseChip", "#purseChip"],
  ["purseCash", "#purseChip .cash"],
  ["purseInc", "#purseChip .inc"],
  ["clockBtn", "#clockBtn"],
  ["speedctl", ".speedctl"],
  ["speedDown", "#speedDown"],
  ["speedUp", "#speedUp"],
];
// The row itself: every control the player can press, for the overlap and overflow arms.
const ROW = [
  ["New", "#newBtn"], ["Resign", "#resignBtn"], ["Quit", "#quitBtn"], ["Clock", "#clockBtn"],
  ["speed-", "#speedDown"], ["speed+", "#speedUp"], ["speedReadout", "#speedReadout"],
  ["stripInfo", "#stripInfo"], ["purseChip", "#purseChip"],
];

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    const v = await fetch(BASE + "/api/version").then((r) => r.json()).catch(() => null);
    mark("the given host answers /api/version", Boolean(v), JSON.stringify(v));
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTHS[0].w, height: WIDTHS[0].h } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb173-" + Math.random().toString(36).slice(2, 18).padEnd(16, "0");
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && document.body.classList.contains("in-match"), null, { timeout: 25000, polling: 100 });
  await sleep(600);
  mark("a 1986 match is open", Boolean(await page.evaluate(() => window.__chq.room()?.id)));

  const snap = (label) => page.evaluate(({ boxes, row, label }) => {
    const rows = {};
    for (const [key, sel] of boxes) {
      const el = document.querySelector(sel);
      if (!el) { rows[key] = null; continue; }
      const r = el.getBoundingClientRect();
      rows[key] = { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
        scrollW: el.scrollWidth, clientW: el.clientWidth, text: (el.textContent || "").trim(),
        title: el.getAttribute("title") || "" };
    }
    const items = [];
    for (const [key, sel] of row) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      items.push({ label: key, x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) });
    }
    const strip = document.getElementById("strip");
    const room = window.__chq.room() || {};
    return { label, rows, items,
      clock: room.clock || null, speed: Number(room.speed),
      readout: (document.getElementById("speedReadout")?.textContent || "").trim(),
      strip: { scrollW: strip.scrollWidth, clientW: strip.clientWidth },
      viewport: { w: window.innerWidth, h: window.innerHeight } };
  }, { boxes: BOXES, row: ROW, label });

  const clockRunning = async () => (await page.evaluate(() => (window.__chq.room() || {}).clock)) === "running";
  const setSpeed = async (want) => {
    for (let i = 0; i < 10; i++) {
      const s = await page.evaluate(() => Number((window.__chq.room() || {}).speed));
      if (s === want) return true;
      await page.click(s < want ? "#speedUp" : "#speedDown");
      await sleep(160);
    }
    return false;
  };

  const overlapPairs = (items) => {
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0.5 && oy > 0.5) pairs.push({ a: a.label, b: b.label, ox: +ox.toFixed(2) });
      }
    }
    return pairs;
  };

  // PB-187: the purse's cash leg at one width and one balance. It writes a synthetic balance into
  // the chip's own .cash span (the node paintPurse writes), measures, and restores the live string.
  // The leg only ever saw the fresh match's two-digit "50b" at 1024, so a chip that held two digits
  // passed while 234b/999b ran under #clockBtn and the brand's `overflow: hidden` cut the figure to
  // "2" (PM 8353 on live 25ba20d). `brand` is measured too: a box laid out past its own clip box can
  // read whole by its own scrollWidth while half the ink is invisible.
  const cashProbe = (cash, round = null) => page.evaluate(({ cash, round, row }) => {
    const el = document.getElementById("purseChip");
    const span = el.querySelector(".cash");
    const before = span ? span.textContent : null;
    if (span) span.textContent = cash;
    // The live failing report was a saved match at round 217, not a fresh one: a three-digit round
    // grows #stripInfo by one digit and slides the purse further right. Same technique — write it,
    // measure before the next room frame can repaint, restore.
    const info = document.getElementById("stripInfo");
    const infoBefore = info.innerHTML;
    if (round != null) {
      const bump = (nodes) => {
        for (const n of nodes) {
          if (n.nodeType === 3) n.textContent = n.textContent.replace(/round \d+/, "round " + round);
          else bump(n.childNodes);
        }
      };
      bump(info.childNodes);
    }
    const rect = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { sel, x: +r.x.toFixed(2), right: +(r.x + r.width).toFixed(2), w: +r.width.toFixed(2),
        scrollW: n.scrollWidth, clientW: n.clientWidth, text: (n.textContent || "").trim() };
    };
    const chip = rect("#purseChip"), cashBox = rect("#purseChip .cash"), brand = rect("#strip > .brand");
    const items = [];
    for (const [key, sel] of row) {
      const n = document.querySelector(sel);
      if (!n) continue;
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      items.push({ label: key, x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) });
    }
    const strip = document.getElementById("strip");
    if (span) span.textContent = before;
    info.innerHTML = infoBefore;
    return { cash, chip, cashBox, brand, items, strip: { scrollW: strip.scrollWidth, clientW: strip.clientWidth } };
  }, { cash, round, row: ROW });

  const signoutW = {};
  for (const { w, h, label } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(500);
    if (!(await clockRunning())) { await page.click("#clockBtn"); await sleep(400); }
    await setSpeed(1);
    await sleep(400);

    const run = await snap("running-" + label);
    await page.click("#clockBtn");
    await sleep(600);
    const held = await snap("held-" + label);
    series.push(run, held);
    mark("the clock reads held at " + label, held.clock === "held", JSON.stringify({ clock: held.clock, stripInfo: held.rows.stripInfo?.text }));
    await page.click("#clockBtn");
    await sleep(500);
    mark("the clock is back to running at " + label, await clockRunning());

    // THE CARD: nothing in the row may change width or move for a clock toggle.
    for (const key of ["stripInfo", "phase", "purseChip", "clockBtn"]) {
      const a = run.rows[key], b = held.rows[key];
      mark("#" + key + " keeps its width across the toggle at " + label,
        Boolean(a && b) && near(a.w, b.w),
        JSON.stringify({ running: a && a.w, held: b && b.w, dW: a && b ? d2(a.w, b.w) : null, textA: a && a.text, textB: b && b.text }));
    }
    for (const key of ["speedctl", "speedDown", "speedUp"]) {
      const a = run.rows[key], b = held.rows[key];
      mark(key + " does not move across the toggle at " + label,
        Boolean(a && b) && near(a.x, b.x),
        JSON.stringify({ running: a && a.x, held: b && b.x, dL: a && b ? d2(a.x, b.x) : null }));
    }

    // PB-180 (PM 8316 §1, option (a)): #stripInfo shows its whole string at every named width; the
    // purse is a SUMMARY ("116b +1.45b/rd") — whole at 1440/1280, and at 1024 the income leg may drop
    // into the title while the cash figure stays whole. This is the arm that was three reds before
    // the summary: the full 412 px economy string could not fit a 88 px slot by any CSS.
    const info = run.rows.stripInfo;
    mark("#stripInfo shows its whole string at " + label,
      Boolean(info) && info.clientW > 0 && info.scrollW <= info.clientW,
      JSON.stringify({ text: info && info.text, scrollW: info && info.scrollW, clientW: info && info.clientW, w: info && info.w }));
    // The FULL economy string, built by the page's own purseText from this match's own seat. The
    // title has to contain it verbatim at every width — the summary replaces the strip's reading
    // of it, never its existence.
    const seat = await page.evaluate(() => (window.__chq.room() || {}).seat || null);
    const full = seat ? purseText(seat, false) : "";
    const titleHasFull = Boolean(full) && full.length > 40 && ((run.rows.purseChip || {}).title || "").includes(full);
    mark("#purseChip title carries the full economy string at " + label,
      titleHasFull,
      JSON.stringify({ full, len: full.length, title: (run.rows.purseChip || {}).title || "" }));
    if (w > 1100) {
      const chip = run.rows.purseChip;
      // The fresh match opens on 50b; the card's own example is "116b +1.45b/rd", so the slot has to
      // hold a three-digit balance too. Same chip, same width, one synthetic string, restored after.
      const wide = await page.evaluate(() => {
        const el = document.getElementById("purseChip");
        const before = el.innerHTML;
        el.innerHTML = '<span class="cash">116b</span><span class="inc"> +1.45b/rd</span>';
        const detail = { w: +el.getBoundingClientRect().width.toFixed(2), scrollW: el.scrollWidth, clientW: el.clientWidth };
        const fits = el.clientWidth > 0 && el.scrollWidth <= el.clientWidth;
        el.innerHTML = before;
        return { fits, detail };
      });
      mark("#purseChip shows its whole summary at " + label,
        Boolean(chip) && chip.clientW > 0 && chip.scrollW <= chip.clientW
          && /\db \+.*b\/rd/.test(chip.text) && wide.fits && LEDGER.test(chip.title),
        JSON.stringify({ text: chip && chip.text, scrollW: chip && chip.scrollW, clientW: chip && chip.clientW,
          w: chip && chip.w, textOk: /\db \+.*b\/rd/.test((chip && chip.text) || ""),
          nat: Boolean(chip) && chip.scrollW <= chip.clientW, wide: wide.fits, at116b: wide.detail,
          titleHasLedger: LEDGER.test((chip && chip.title) || "") }));
      // PB-187b (frodo 8371 §4): the handle ellipsizes; the Sign out button is a CONTROL and used to
      // live in the same clipping box as the text. With a legal 26-char handle at 1280x800 the
      // ellipsis ate the button — 23.39 px inside the clip box, 42.65 px cut — so elementFromPoint on
      // its centre returned #debugToggle and the control was effectively gone. Measure the button:
      // inside #account, its own full width (not clipped), and the top element at its centre.
      //
      // frodo 8422 §3: this arm used to require `(name).length >= 26` while the registration above
      // always makes exactly 26 chars, so it could only ever describe one length. 17 and 24 are just
      // as legal and are where the ellipsis wins, and the ticket ships on 17/24/26 — so every length
      // runs the SAME assert. The handle text is set inside the page (the purse probe's own pattern)
      // and restored after the measurement; the login handle itself is untouched.
      for (const chars of [17, 24, 26]) {
        const acct = await page.evaluate((chars) => {
          const a = document.getElementById("account");
          const btn = a ? a.querySelector("button") : null;
          const who = a ? a.querySelector(".who") : null;
          if (!who || !btn) return { name: null, account: null, signout: null, text: null, hit: null };
          const before = who.textContent;
          who.textContent = "e2e-pb173-" + "x".repeat(Math.max(0, chars - 10));
          const box = (n) => {
            const r = n.getBoundingClientRect();
            return { x: +r.x.toFixed(2), right: +(r.x + r.width).toFixed(2), w: +r.width.toFixed(2),
              scrollW: n.scrollWidth, clientW: n.clientWidth };
          };
          let hit = null;
          const r = btn.getBoundingClientRect();
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          hit = el ? (el.id || el.tagName) : null;
          const out = { name: who.textContent, account: box(a), signout: box(btn),
            text: btn.textContent, hit };
          who.textContent = before;
          return out;
        }, chars);
        signoutW[label + "/" + chars] = acct.signout ? acct.signout.w : null;
        mark("Sign out is whole and hittable beside a " + chars + "-char handle at " + label,
          Boolean(acct.signout) && (acct.name || "").length === chars
            && acct.signout.right <= acct.account.right + 0.5
            && acct.signout.scrollW <= acct.signout.clientW
            && acct.hit === "BUTTON" && acct.text === "Sign out"
            && (label.indexOf("1280") !== 0 || signoutW["1440x900/" + chars] == null
              || near(acct.signout.w, signoutW["1440x900/" + chars])),
          JSON.stringify(acct));
      }
    } else {
      const cash = run.rows.purseCash;
      const chip = run.rows.purseChip;
      mark("#purseChip keeps the cash figure whole at " + label,
        Boolean(cash) && cash.clientW > 0 && cash.scrollW <= cash.clientW
          && /^\d+b$/.test(cash.text) && /b\/rd/.test(chip ? chip.title : "")
          && LEDGER.test(chip ? chip.title : ""),
        JSON.stringify({ cash: cash && cash.text, scrollW: cash && cash.scrollW, clientW: cash && cash.clientW,
          chipText: chip && chip.text, titleHasIncome: Boolean(chip && /b\/rd/.test(chip.title)),
          // frodo 8343 §2: the PASS condition asserts the full LEDGER on the title, so the detail
          // prints that same field. `titleHasIncome` alone under-reports what the mark requires.
          titleHasLedger: LEDGER.test((chip && chip.title) || "") }));
      // PB-187 (a): the 1024 arms this leg never ran. 50b, 234b and 999b (the last two synthetic: the
      // fresh match opens on two digits) must each show the cash span whole, keep the chip inside the
      // brand's clip box, overlap nothing in the row — #clockBtn first — and leave the strip fitting
      // the window. The cash span's own scrollWidth is not enough: the old chip measured 30 px of
      // content while the brand cut it at 11 px.
      for (const value of ["50b", "234b", "999b"]) {
        const probe = await cashProbe(value, 217);
        const cashPairs = overlapPairs(probe.items);
        mark("#purseChip shows " + value + " whole and clear at " + label,
          Boolean(probe.cashBox) && probe.cashBox.clientW > 0 && probe.cashBox.scrollW <= probe.cashBox.clientW
            && probe.cashBox.text === value
            && probe.chip.right <= probe.brand.right + 0.5
            && cashPairs.length === 0 && probe.strip.scrollW <= probe.strip.clientW,
          JSON.stringify({ cash: probe.cashBox, chip: probe.chip, brandRight: probe.brand.right,
            overlaps: cashPairs, strip: probe.strip }));
      }
    }
    // PB-179's floor: nothing overlaps and nothing runs past the window.
    const pairs = overlapPairs(run.items);
    mark("no strip control overlaps at " + label, pairs.length === 0, JSON.stringify(pairs));
    // PB-187: the brand clips (`overflow: hidden`), so a readout laid out past its right edge is
    // invisible ink that no overlap test sees. The chip has to end inside the box that clips it.
    const chipBox = run.rows.purseChip, brandBox = run.rows.brand;
    mark("#purseChip sits inside the brand box at " + label,
      Boolean(chipBox && brandBox) && chipBox.x + chipBox.w <= brandBox.x + brandBox.w + 0.5,
      JSON.stringify({ chipRight: chipBox && +(chipBox.x + chipBox.w).toFixed(2),
        brandRight: brandBox && +(brandBox.x + brandBox.w).toFixed(2) }));
    mark("no strip control runs past the window at " + label,
      Math.max(...run.items.map((it) => it.x + it.w)) <= w + 0.5,
      "rightmost=" + Math.max(...run.items.map((it) => it.x + it.w)).toFixed(1) + " window=" + w);
    mark("the strip does not overflow at " + label, run.strip.scrollW <= run.strip.clientW, JSON.stringify(run.strip));
    await page.screenshot({ path: path.join(OUT, "pb173-" + label + ".png") });
  }

  // The speed axis, at the widest viewport: 1 -> 0 ("paused") -> 6 must not move the control either.
  await page.setViewportSize({ width: WIDTHS[0].w, height: WIDTHS[0].h });
  await sleep(400);
  await setSpeed(1);
  await sleep(400);
  const base1 = await snap("speed1");
  series.push(base1);
  await setSpeed(0);
  await sleep(600);
  const s0 = await snap("speed0");
  series.push(s0);
  mark("speed 0 reads paused in the strip", s0.speed === 0 && /paused/.test(s0.rows.stripInfo?.text || ""), JSON.stringify({ speed: s0.speed, stripInfo: s0.rows.stripInfo?.text }));
  await setSpeed(6);
  await sleep(600);
  const s6 = await snap("speed6");
  series.push(s6);
  mark("speed 6 is reachable", s6.speed === 6, JSON.stringify({ speed: s6.speed, readout: s6.readout }));
  for (const [label, snap2] of [["speed 0", s0], ["speed 6", s6]]) {
    for (const key of ["stripInfo", "phase", "purseChip", "clockBtn"]) {
      const a = base1.rows[key], b = snap2.rows[key];
      mark("#" + key + " keeps its width at " + label, Boolean(a && b) && near(a.w, b.w),
        JSON.stringify({ at1: a && a.w, now: b && b.w, dW: a && b ? d2(a.w, b.w) : null, text: b && b.text }));
    }
    for (const key of ["speedctl", "speedDown", "speedUp"]) {
      const a = base1.rows[key], b = snap2.rows[key];
      mark(key + " does not move at " + label, Boolean(a && b) && near(a.x, b.x),
        JSON.stringify({ at1: a && a.x, now: b && b.x, dL: a && b ? d2(a.x, b.x) : null }));
    }
  }

  mark("no page error during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} catch (err) {
  failed += 1;
  evidence.push({ step: "leg threw", ok: false, detail: String(err && err.stack ? err.stack : err) });
  console.error("FAIL leg threw — " + String(err && err.message ? err.message : err));
} finally {
  try { if (browser) await browser.close(); } catch (err) { void err; }
  try { if (server) server.kill("SIGKILL"); } catch (err) { void err; }
  writeFileSync(path.join(OUT, "pb173-speed-slots.json"), JSON.stringify({ base: BASE, failed, evidence, series }, null, 2));
  console.log("pb173 speed slots: " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  process.exit(failed ? 1 : 0);
}
