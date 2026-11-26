// PB-263 page leg: the Message Level control, played from the page at 1280x800.
//
// The rule (manual p.32 "Message Level", p.19 "The Message Bar"):
//   "Level three warns of all threats to friendly cities, and of enemy units spotted; level two warns
//    of threats only; level one warns of only 'serious' threats; level zero gives no warning messages."
//
// What this leg does, through the page and nothing stubbed:
//   1. a 1942 blue-vs-bot room is opened from the page and the clock is started;
//   2. a real server-sent sighting arrives and is READ at level 3 - the sentence itself, opened in the
//      DOM (`#roundLog li[data-tag=spotted]`), not a selector's presence;
//   3. the control is cycled 3 -> 2 -> 1 -> 0 -> 3 with #msgLevelBtn; at 2 the spotted sentence is
//      gone, at 1 and 0 the warning set shrinks further, and at 0 no tagged line is painted at all;
//   4. a non-warning line (the payday) is still painted at level 0 - the level never hides news;
//   5. back at 3 the SAME spotted sentence is painted again from the retained buffer (one rule, at
//      paint time), and the level survives a reload through localStorage;
//   6. crops at 1280x800 of the strip + log at levels 3 and 1, and the readings written to JSON.
//
//   node tests/e2e/pb263-message-level.mjs                 # starts its own server from this tree
//   node tests/e2e/pb263-message-level.mjs --url=<base>    # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
// PB-278: a leg run without --out must not write into one operator's home directory - that path
// only exists on the machine that wrote it, so the next host's run either fails to mkdir or leaves
// evidence nobody can find. The default is a fresh temp dir; the run prints the path it used.
const OUT = path.resolve((process.argv.find((v) => v.startsWith("--out=")) || "").slice(6) ||
  mkdtempSync(path.join(tmpdir(), "openchq-pb263-")));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
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

// Every painted line, with the tag the server sent (or null): what the player can actually read.
const painted = (page) => page.evaluate(() => [...document.querySelectorAll("#roundLog li")].map((li) => ({
  tag: li.dataset.tag || null,
  text: (li.textContent || "").replace(/^round \d+ \u2014 /, ""),
})));
const readout = (page) => page.evaluate(() => {
  const el = document.getElementById("msgLevelReadout");
  return el ? (el.textContent || "").trim() : null;
});
const clickLevel = async (page) => {
  await page.click("#msgLevelBtn");
  await sleep(220);
};

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb263-"));
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

  const name = "e2e-pb263-" + Date.now().toString(36).slice(-6);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });

  await page.selectOption('#launch select[name="era"]', "1942");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
    null, { timeout: 30000, polling: 100 });
  mark("a 1942 human-vs-bot room is open",
    await page.evaluate(() => String(window.__chq.room().era) === "1942"), "era read from the room frame");

  // The control exists before the clock runs, disabled until there is a room.
  const control = await page.evaluate(() => ({
    button: Boolean(document.getElementById("msgLevelBtn")),
    readout: (document.getElementById("msgLevelReadout") || {}).textContent || null,
    title: (document.getElementById("msgLevelBtn") || {}).title || null,
  }));
  mark("the menu bar carries the Message Level control", control.button === true && control.readout === "Msg 3",
    JSON.stringify(control));
  mark("the control's tooltip names the port choice for the default and the port decision for 'serious'",
    /port.s choice/i.test(control.title || "") && /port decision/i.test(control.title || "") && /p\.32/.test(control.title || ""),
    control.title);

  await page.click("#clockBtn");
  await page.waitForFunction(() => window.__chq.room().clock === "running", null, { timeout: 20000, polling: 100 });

  // ---- 2. a real sighting, read as a sentence ----------------------------------------------------
  // The log panel's list only exists while the Log dialogue is open, and the dialogue refuses to build
  // it before the buffer has a line. So: let the clock commit a round, then open Log (retrying with
  // Escape, because an open with an empty buffer builds the "nothing has happened yet" note instead).
  await page.waitForFunction(() => Number((window.__chq.room() || {}).round) >= 1, null, { timeout: 90000, polling: 200 });
  const openLog = async () => {
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".navbtn")].find((b) => /^log$/i.test((b.textContent || "").trim()));
        if (btn) btn.click();
      });
      await sleep(300);
      if (await page.$("#roundLog")) return true;
      await page.keyboard.press("Escape");
      await sleep(300);
    }
    return false;
  };
  const logOpen = await openLog();
  mark("the Log panel opens and carries the log list", logOpen === true, "#roundLog " + (logOpen ? "present" : "missing"));

  let sawSpotted = true;
  await page.waitForFunction(() => document.querySelectorAll('#roundLog li[data-tag="spotted"]').length > 0,
    null, { timeout: 90000, polling: 250 }).catch(() => { sawSpotted = false; });
  const at3 = await painted(page);
  const spottedLine = at3.find((line) => line.tag === "spotted");
  mark("a server-sent sighting is painted at level 3 and its sentence reads", Boolean(spottedLine) && /\S/.test(spottedLine.text),
    spottedLine ? JSON.stringify(spottedLine.text) : "no spotted line within 60 s at level 3");
  mark("level 3's readout says Msg 3", (await readout(page)) === "Msg 3", String(await readout(page)));
  const newsLine = at3.find((line) => line.tag === null && /^paid /.test(line.text));
  mark("an untagged payday line is in the log at level 3", Boolean(newsLine), newsLine ? newsLine.text : "none");
  await page.screenshot({ path: path.join(OUT, "pb263-level3-1280x800.png") });

  // ---- 3. the cycle, each level read from the DOM ------------------------------------------------
  await clickLevel(page); // 3 -> 2
  const at2 = await painted(page);
  mark("the control cycled to Msg 2", (await readout(page)) === "Msg 2", String(await readout(page)));
  mark("the spotted sentence is NOT painted at level 2",
    Boolean(spottedLine) && !at2.some((line) => line.text === spottedLine.text),
    spottedLine ? "looked for " + JSON.stringify(spottedLine.text) : "no sentence to look for");
  mark("no spotted line of any kind survives level 2", !at2.some((line) => line.tag === "spotted"),
    "spotted in level 2: " + at2.filter((line) => line.tag === "spotted").length);
  mark("the payday line is still painted at level 2", !newsLine || at2.some((line) => line.text === newsLine.text),
    newsLine ? newsLine.text : "no payday line seen");

  await clickLevel(page); // 2 -> 1
  const at1 = await painted(page);
  const seriousSeen = at3.filter((line) => line.tag === "serious").length;
  mark("the control cycled to Msg 1", (await readout(page)) === "Msg 1", String(await readout(page)));
  mark("level 1 paints only serious warnings and the news",
    at1.every((line) => line.tag === null || line.tag === "serious"),
    "tags at level 1: " + JSON.stringify([...new Set(at1.map((line) => line.tag))]) +
      "; serious lines available at level 3: " + seriousSeen +
      (seriousSeen === 0 ? " (no capital alarm in this window — the serious rule is pinned on fixed lines by the node test)" : ""));
  await page.screenshot({ path: path.join(OUT, "pb263-level1-1280x800.png") });

  await clickLevel(page); // 1 -> 0
  const at0 = await painted(page);
  mark("the control cycled to Msg 0", (await readout(page)) === "Msg 0", String(await readout(page)));
  mark("level 0 paints no warning at all", !at0.some((line) => line.tag !== null),
    "tagged lines at level 0: " + at0.filter((line) => line.tag !== null).length);
  mark("level 0 still paints the news", !newsLine || at0.some((line) => line.text === newsLine.text),
    newsLine ? newsLine.text : "no payday line seen");

  // Level 0 has to outlive a round boundary, not just a click: the level is a stored setting, and the
  // next round's lines must arrive under the same threshold (PM 9655 §1's second leg).
  const roundAtZero = await page.evaluate(() => Number((window.__chq.room() || {}).round) || 0);
  await page.waitForFunction((r) => Number((window.__chq.room() || {}).round) > r, roundAtZero,
    { timeout: 90000, polling: 250 }).catch(() => {});
  const roundAfterZero = await page.evaluate(() => Number((window.__chq.room() || {}).round) || 0);
  const at0NextRound = await painted(page);
  mark("level 0 survives a round boundary",
    roundAfterZero > roundAtZero && (await readout(page)) === "Msg 0" && !at0NextRound.some((line) => line.tag !== null),
    "round " + roundAtZero + " -> " + roundAfterZero + ", readout " + (await readout(page)) +
      ", tagged painted: " + at0NextRound.filter((line) => line.tag !== null).length);

  await clickLevel(page); // 0 -> 3
  const back3 = await painted(page);
  mark("the cycle returned to Msg 3", (await readout(page)) === "Msg 3", String(await readout(page)));
  mark("the SAME spotted sentence is painted again from the retained buffer",
    Boolean(spottedLine) && back3.some((line) => line.text === spottedLine.text),
    spottedLine ? "matched " + JSON.stringify(spottedLine.text) : "no sentence to match");

  // ---- 5. the level survives a reload (the seat key) ---------------------------------------------
  await clickLevel(page); // 3 -> 2, so the stored value is a non-default
  const beforeReload = await readout(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
  await sleep(900);
  await page.waitForFunction(() => Number((window.__chq.room() || {}).round) >= 1, null, { timeout: 60000, polling: 200 });
  await openLog();
  await page.waitForFunction(() => document.querySelectorAll("#roundLog li").length > 0, null, { timeout: 30000, polling: 200 }).catch(() => {});
  const afterReload = await readout(page);
  mark("the level survives a reload", beforeReload === "Msg 2" && afterReload === "Msg 2",
    "before " + beforeReload + " / after " + afterReload);
  const reloaded = await painted(page);
  mark("after the reload a spotted line is still hidden at Msg 2",
    Boolean(spottedLine) && !reloaded.some((line) => line.text === spottedLine.text),
    "painted " + reloaded.length + " lines after reload");
  const stored = await page.evaluate(() => {
    try {
      return Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("openchq.messageLevel"))
        .map((k) => [k, localStorage.getItem(k)]));
    } catch { return null; }
  });
  mark("the stored level is per seat", Boolean(stored) && Object.keys(stored).some((k) => k.endsWith(".blue")),
    JSON.stringify(stored));

  // ---- 6. one browser, two seats: the key is the SEAT, not the browser -------------------------
  // Same browser = the same localStorage, so this is the arm where a single key would show. Blue is on
  // Msg 2 (stored above). Take the RED seat of a fresh 1942 room in the same page: the control must
  // open on msg 3 from red's own (absent) key, not inherit blue's 2. Set red to 1, go back to blue and
  // blue still reads 2 with both keys in storage. Seats are temporal; the keys are what persist.
  const leaveAndLaunch = async (side) => {
    await page.click('.navbtn[data-dialog="war"]').catch(() => {});
    await page.waitForSelector("#dialogBody", { timeout: 15000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("#dialogBody button")].find((b) => /leave the match/i.test(b.textContent || ""));
      if (btn) btn.click();
    });
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', side);
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((want) => {
      const room = window.__chq.room();
      if (!room || !room.seat) return false;
      const mine = String(room.you || (room.seat && room.seat.side) || "");
      return mine === want && String(room.era) === "1942";
    }, side, { timeout: 30000, polling: 100 });
    await sleep(700);
  };

  await leaveAndLaunch("red");
  const redReadout = await readout(page);
  mark("the same browser on the red seat opens on red's own key, not blue's",
    redReadout === "Msg 3", "red readout " + redReadout + " (blue was Msg 2 in the same storage)");
  await clickLevel(page); // red 3 -> 2
  await clickLevel(page); // red 2 -> 1
  const keysBoth = await page.evaluate(() => {
    try {
      return Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("openchq.messageLevel"))
        .map((k) => [k, localStorage.getItem(k)]));
    } catch { return null; }
  });
  mark("cycling on the red seat leaves the blue key alone",
    (await readout(page)) === "Msg 1" && Boolean(keysBoth) &&
      keysBoth["openchq.messageLevel.blue"] === "2" && keysBoth["openchq.messageLevel.red"] === "1",
    "readout " + (await readout(page)) + " / " + JSON.stringify(keysBoth));
  await leaveAndLaunch("blue");
  mark("returning to the blue seat restores blue's own level",
    (await readout(page)) === "Msg 2", "blue readout " + (await readout(page)));

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  const payload = { base: BASE, viewport: "1280x800", at3, at2, at1, at0, back3, reloaded, evidence, failed };
  writeFileSync(path.join(OUT, "pb263-leg.json"), JSON.stringify(payload, null, 2));
  console.log("pb263-message-level: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);

  await browser.close();
  if (child) child.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("pb263-message-level: leg crashed — " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
