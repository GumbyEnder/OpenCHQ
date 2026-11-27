// PB-317 page leg: the Show Common mode has a readout of its own in the footer's fixed slot.
//
//   node tests/e2e/pb317-show-common-flag.mjs                   # starts its own server
//   node tests/e2e/pb317-show-common-flag.mjs --url=<base>      # a running server
//   node tests/e2e/pb317-show-common-flag.mjs --out=<dir>
//
// The manual is the spec (p.35 l.1119-1120, l.1133-1135): "Toggle Show-Who" switches to Show Common,
// step 4 sets Show Common and THEN presses Switch Sides, and step 5 the next player toggles Show-Who
// to his own side. So the mode is the PLAYER's and it survives the swap.
//
// What this leg asserts, per viewport (1280x800 and 1024x768):
//   (a) the slot reads "Show Common" while Common is on, and nothing mode-related in Normal; and the
//       slot does not CLIP the word (scrollWidth <= clientWidth + 1 in both states) - a slot sized in
//       `ch` bet on the font once already and cut the last glyph while every string compare passed;
//   (b) the slot's box is the same rectangle (x, y, w, h within 1 px) in both states;
//   (c) the word goes the same FRAME the War panel's button changes - pinned by a MutationObserver
//       that samples both texts on every DOM change, so a one-tick lag is a red, not a pass;
//   (d) Switch Sides keeps the mode and the readout, read after the swap;
//   (e) Leave returns to Normal and the slot goes empty, and the next war opens Normal;
//   (f) the slot never prints a raw id, and the page raises no error.
//
// What breaks if this is removed: a player in Common is looking at a map with most of both armies
// missing, and the only thing that says so lives in a dialogue they have closed.

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
const OUT = evidenceDir("pb317-show-common-flag", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const WORD = "Show Common";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 300)));
  writeFileSync(path.join(OUT, "pb317-show-common-flag.json"), JSON.stringify({ evidence }, null, 2));
}

let BASE = "";
let child = null;

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

// Make sure the War panel is OPEN (its button visible), not merely present in a stale dialog body.
// The nav button is a toggle, so a blind second click closes the panel and every later read grades
// a detached node.
async function openWar(page) {
  const visible = () => page.evaluate(() => {
    const button = document.getElementById("showCommonBtn");
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (await visible()) return;
  await page.evaluate(() => {
    const button = document.querySelector('#nav button[data-dialog="war"]');
    if (button) button.click();
  });
  await page.waitForFunction(() => {
    const button = document.getElementById("showCommonBtn");
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, null, { timeout: 15000, polling: 50 });
}

// Open a dialogue by its strip button. The War panel is where both controls live.
async function openDialog(page, which) {
  await page.evaluate((id) => {
    const button = document.querySelector('#nav button[data-dialog="' + id + '"]');
    if (button) button.click();
  }, which);
  await sleep(240);
}

const slotText = (page) => page.evaluate(() => {
  const slot = document.getElementById("modeFlag");
  return slot ? (slot.textContent || "").trim() : null;
});

const slotBox = (page) => page.evaluate(() => {
  const slot = document.getElementById("modeFlag");
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

// (a) The no-clip arm. overflow:hidden plus nowrap means a word wider than the slot keeps the RIGHT
// textContent and loses its last glyph on screen, so no string compare can see the defect: the only
// witness is the scroll box against the client box. Detail carries both plus the text's own width,
// because "90 vs 87" is the measurement that names a 3.22 px cut, not just a boolean.
const slotFit = (page) => page.evaluate(() => {
  const slot = document.getElementById("modeFlag");
  if (!slot) return null;
  const text = (slot.textContent || "").trim();
  let textWidth = 0;
  if (text) {
    const range = document.createRange();
    range.selectNodeContents(slot);
    textWidth = range.getBoundingClientRect().width;
  }
  return {
    text,
    scrollWidth: slot.scrollWidth,
    clientWidth: slot.clientWidth,
    overflow: getComputedStyle(slot).overflow,
    textWidth: Math.round(textWidth * 1000) / 1000,
  };
});

const fits = (fit) => Boolean(fit) && fit.scrollWidth <= fit.clientWidth + 1;

const sameBox = (a, b) => Boolean(a && b) &&
  Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
  Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;

// One snapshot of the button and the slot, taken together. Anything that reads them in two calls
// can see a state that never existed on screen.
const bothNow = (page) => page.evaluate(() => {
  const button = document.getElementById("showCommonBtn");
  const slot = document.getElementById("modeFlag");
  return {
    button: button ? (button.textContent || "").trim() : null,
    slot: slot ? (slot.textContent || "").trim() : null,
    box: slot ? (() => { const r = slot.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null,
    you: window.__chq.room() ? window.__chq.room().you : null,
    showCommon: Boolean(window.__chq.room() && window.__chq.room().showCommon && window.__chq.room().showCommon.on),
  };
});

// (c) needs the two writes to be seen in the same FRAME, so the page samples itself. A mutation
// callback fires between two DOM writes inside one task, which would grade an intermediate state no
// player can see; the sample is therefore deferred to the next animation frame, i.e. the next paint.
// A flag that lands a frame late is still a red, because the deferred sample captures the frame.
async function armSampler(page) {
  await page.evaluate(() => {
    window.__pb317 = { samples: [] };
    const sample = (why) => {
      const button = document.getElementById("showCommonBtn");
      const slot = document.getElementById("modeFlag");
      window.__pb317.samples.push({
        why,
        button: button ? (button.textContent || "").trim() : null,
        slot: slot ? (slot.textContent || "").trim() : null,
      });
    };
    window.__pb317.sample = sample;
    let pending = false;
    window.__pb317.observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; sample("paint"); });
    });
    window.__pb317.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    sample("armed");
  });
}

async function samplerAgreement(page, expectSlot) {
  return page.evaluate((want) => {
    const rows = (window.__pb317 && window.__pb317.samples) || [];
    const bad = rows.filter((row) => {
      if (row.button === null || row.slot === null) return true;
      if (row.button.endsWith("Common")) return row.slot !== want;
      if (row.button.endsWith("Normal")) return row.slot !== "";
      return false;
    });
    return { count: rows.length, bad: bad.slice(0, 8), last: rows.slice(-3) };
  }, expectSlot);
}

async function main() {
  const { chromium } = await loadPlaywright();

  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb317-page-"));
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
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    const at = " @" + viewport.width + "x" + viewport.height;

    await signIn(page, "P317" + tag, "pw-317-" + tag);
    // A SOLO war: Switch Sides is honoured there (manual p.35), and Show Common is a view of a live war.
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot",
      null, { timeout: 30000, polling: 100 });
    await sleep(300);
    mark("a solo 1942 war is open" + at, true, await page.evaluate(() => "room " + window.__chq.room().id));

    // ---- (a) + (b): Normal first -------------------------------------------------------------
    const normalWord = await slotText(page);
    const normalBox = await slotBox(page);
    mark("(a) the slot reads nothing mode-related in Normal" + at,
      normalWord === "" || !/common/i.test(String(normalWord)), JSON.stringify(normalWord));
    mark("(b) the slot has a box in Normal, not a collapsed one" + at,
      Boolean(normalBox) && normalBox.w > 40 && normalBox.h > 8, JSON.stringify(normalBox));

    await openWar(page);
    const before = await bothNow(page);
    mark("(a) the War panel's own button reads Normal" + at,
      String(before.button).endsWith("Normal"), JSON.stringify(before.button));

    await armSampler(page);

    // ---- (a) + (c): common ON, same frame -----------------------------------------------------
    await page.evaluate(() => document.getElementById("showCommonBtn").click());
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().showCommon
      && window.__chq.room().showCommon.on === true, null, { timeout: 20000, polling: 50 });
    await page.waitForFunction(() => {
      const button = document.getElementById("showCommonBtn");
      return Boolean(button) && (button.textContent || "").trim().endsWith("Common");
    }, null, { timeout: 20000, polling: 50 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { window.__pb317.sample("settled-on"); r(); })));
    const onState = await bothNow(page);
    const onBox = onState.box;
    mark("(a) the slot reads \"Show Common\" while Common is on" + at,
      onState.slot === WORD, JSON.stringify(onState.slot));
    const onFit = await slotFit(page);
    mark("(a) the ON slot does not clip the word (scrollWidth <= clientWidth + 1)" + at,
      fits(onFit), JSON.stringify(onFit));
    mark("(b) the slot's box is identical in both states (x, y, w, h within 1 px)" + at,
      sameBox(normalBox, onBox), JSON.stringify({ normalBox, onBox }));
    const onAgree = await samplerAgreement(page, WORD);
    mark("(c) no sampled frame has the button and the slot disagreeing" + at,
      onAgree.bad.length === 0, JSON.stringify({ count: onAgree.count, bad: onAgree.bad }));

    // ---- (d) Switch Sides keeps the mode and the readout --------------------------------------
    await page.evaluate(() => {
      const button = document.getElementById("switchSidesBtn");
      if (button) button.click();
    });
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().you === "red",
      null, { timeout: 25000, polling: 80 });
    await sleep(400);
    await openWar(page);
    const afterSwap = await bothNow(page);
    mark("(d) Switch Sides kept the mode" + at, afterSwap.showCommon === true,
      JSON.stringify({ you: afterSwap.you, showCommon: afterSwap.showCommon }));
    mark("(d) the readout is still there after the swap" + at, afterSwap.slot === WORD,
      JSON.stringify(afterSwap.slot));
    mark("(d) the War panel's button still says Common after the swap" + at,
      String(afterSwap.button).endsWith("Common"), JSON.stringify(afterSwap.button));

    // ---- (c) toggling back removes it --------------------------------------------------------
    await page.evaluate(() => window.__pb317.sample("before-off"));
    await page.evaluate(() => document.getElementById("showCommonBtn").click());
    // Bounded poll with the field itself in the detail: a bare waitForFunction timeout says nothing
    // about whether the frame never came or the page kept a stale block.
    let offRoom = null;
    for (let i = 0; i < 40; i += 1) {
      offRoom = await page.evaluate(() => {
        const r = window.__chq.room();
        if (!r) return null;
        return { you: r.you, showCommon: r.showCommon === undefined ? "absent" : JSON.stringify(r.showCommon) };
      });
      if (offRoom && offRoom.showCommon === "absent") break;
      await sleep(150);
    }
    mark("(c) the OFF frame cleared showCommon" + at,
      Boolean(offRoom) && offRoom.showCommon === "absent", JSON.stringify(offRoom));
    await page.waitForFunction(() => {
      const button = document.getElementById("showCommonBtn");
      return Boolean(button) && (button.textContent || "").trim().endsWith("Normal");
    }, null, { timeout: 20000, polling: 50 }).catch(() => {});
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { window.__pb317.sample("settled-off"); r(); })));
    const offState = await bothNow(page);
    mark("(c) toggling back to Normal emptied the slot" + at, offState.slot === "",
      JSON.stringify(offState.slot));
    const offFit = await slotFit(page);
    mark("(a) the OFF slot does not clip either (scrollWidth <= clientWidth + 1)" + at,
      fits(offFit), JSON.stringify(offFit));
    mark("(b) the slot came back to the same box" + at, sameBox(normalBox, offState.box),
      JSON.stringify({ normalBox, offBox: offState.box }));
    const offAgree = await samplerAgreement(page, WORD);
    mark("(c) no sampled frame kept the word after the button said Normal" + at,
      offAgree.bad.length === 0, JSON.stringify({ count: offAgree.count, bad: offAgree.bad }));

    // ---- (e) leave resets, and the next war opens Normal --------------------------------------
    await page.evaluate(() => window.__pb317.observer && window.__pb317.observer.disconnect());
    await page.evaluate(() => document.getElementById("showCommonBtn").click());
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().showCommon
      && window.__chq.room().showCommon.on === true, null, { timeout: 20000, polling: 50 });
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#dialogBody button")];
      const leave = buttons.find((b) => (b.textContent || "").trim() === "Leave the match");
      if (leave) leave.click();
    });
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 25000, polling: 80 });
    await sleep(350);
    const afterLeave = await slotText(page);
    mark("(e) leaving the match cleared the slot" + at, afterLeave === "", JSON.stringify(afterLeave));

    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot",
      null, { timeout: 30000, polling: 100 });
    await sleep(350);
    await openWar(page);
    const fresh = await bothNow(page);
    mark("(e) the next war opens in Normal with an empty slot" + at,
      fresh.showCommon === false && fresh.slot === "" && String(fresh.button).endsWith("Normal"),
      JSON.stringify(fresh));

    // ---- (f) no raw ids, no page errors ------------------------------------------------------
    const texts = [normalWord, onState.slot, offState.slot, afterLeave, fresh.slot].filter((t) => t !== null);
    mark("(f) the slot prints no raw id" + at,
      texts.every((t) => !/[0-9]/.test(t) && !/[:/]/.test(t)), JSON.stringify(texts));
    mark("(f) the page raised no error" + at, errors.length === 0, JSON.stringify(errors.slice(0, 4)));

    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");

  const total = evidence.length;
  const passed = total - failed;
  console.log("");
  console.log("PASSED " + passed + "/" + total);
  console.log("EVIDENCE " + path.join(OUT, "pb317-show-common-flag.json"));
  console.log(failed ? "PB317_E2E FAILED" : "PB317_E2E PASSED " + passed);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("PB317_E2E CRASHED: " + (err && err.stack ? err.stack : err));
  if (child) child.kill("SIGTERM");
  process.exit(1);
});
