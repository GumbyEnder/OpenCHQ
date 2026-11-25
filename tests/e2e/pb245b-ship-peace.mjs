// PB-245 page leg: the peace control, played from the page at 1280x800.
//
// The rule (manual printed p.31-32):
//   "At the start of the 1986 and 2023 scenarios, and at any time during those scenarios that both
//    players agree, peacetime conditions prevail... A counter in Monitor One tells you how much time
//    remains in mandatory peace; after that, either player can start the war by pressing Begin
//    Hostilities/Cease Fire." p.32 War Status: "only after the mandatory time has elapsed."
//
// What a player does here, through the page and nothing stubbed:
//   1. two seats register, blue invites red to a 1986 war and red accepts;
//   2. the war runs; blue proposes a cease fire from the kit and red accepts it;
//   3. the strip and the War panel both print the counter, and the War panel offers Begin
//      Hostilities, enabled because the server says the counter has elapsed (shipped config
//      prints no mandatory length);
//   4. blue presses Begin Hostilities: the war is on again for BOTH seats, the counter is gone, the
//      stale "Cease fire accepted" note is cleared, and each seat reads its own log line.
//
//   node tests/e2e/pb245b-ship-peace.mjs                 # starts its own server from this tree
//   node tests/e2e/pb245b-ship-peace.mjs --url=<base>    # a running server (the LIVE leg once shipped)
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
const OUT = path.resolve((process.argv.find((v) => v.startsWith("--out=")) || "").slice(6) ||
  path.join(process.env.HOME || ".", "agents", "game", "notes", "pb245b-ship"));
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

async function signIn(page, BASE, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (BASE) {
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb245b-ship-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch {}
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const tag = Date.now().toString(36).slice(-6);
  const blueName = "ShipBlue" + tag;
  const redName = "ShipRed" + tag;
  const ctxBlue = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxRed = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blue = await ctxBlue.newPage();
  const red = await ctxRed.newPage();
  const pageErrors = [];
  blue.on("pageerror", (err) => pageErrors.push("blue: " + String(err)));
  red.on("pageerror", (err) => pageErrors.push("red: " + String(err)));

  await signIn(blue, BASE, blueName, "pw-blue-" + tag);
  await signIn(red, BASE, redName, "pw-red-" + tag);
  mark("both seats are in the lobby", true, blueName + " / " + redName);

  // Blue sets the match up: 1986, blue, then invites red from the people list.
  await blue.selectOption('#launch select[name="era"]', "1986");
  await blue.selectOption('#launch select[name="side"]', "blue");
  await blue.waitForSelector("li.person", { timeout: 25000 });
  await blue.evaluate((name) => {
    const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
    row.querySelector("button").click();
  }, redName);
  await red.waitForSelector("#invites .invite button", { timeout: 25000 });
  await red.evaluate(() => document.querySelector("#invites .invite button").click());

  await blue.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1986", null,
    { timeout: 25000, polling: 100 });
  const roomId = await blue.evaluate(() => window.__chq.room().id);
  await red.waitForFunction((id) => window.__chq.room() && window.__chq.room().id === id, roomId,
    { timeout: 25000, polling: 100 });
  await sleep(500);
  const atWarOpen = await blue.evaluate(() => {
    const room = window.__chq.room();
    return { peace: room.peace, round: room.round, clock: room.clock };
  });
  // PB-245b changed the world: 1986 opens in the COLD WAR, so at round 0 the peace is already
  // active and the cold-war flag is set. A cut that empties COLD_WAR_ERAS nulls both and reds this.
  mark("the 1986 open reads the cold war at round 0 (coldWar true, peace active)",
    Boolean(atWarOpen.peace) && atWarOpen.peace.active === true && atWarOpen.peace.coldWar === true &&
      atWarOpen.round === 0, JSON.stringify(atWarOpen.peace) + " round " + atWarOpen.round);

  // frodo 9271 §3: leave the cold war BEFORE the arm, the way the other 245b legs do. This leg is
  // the war -> peace -> war control the PB-245 ship row cites, so the cease fire below has to be
  // proposed from a WAR, not from the cold war the era opens in. One real press on the War panel's
  // own Begin Hostilities, both seats out, then the arm runs unchanged.
  //
  // RED presses this one, and blue keeps the final press, on purpose: the round log dedupes by
  // round+text, so a repeat of "you began hostilities; the war is on again" by the same seat at the
  // same round would leave the final row with no new line to read. Different seats, different
  // sentences, no collision.
  await red.click('.navbtn[data-dialog="war"]');
  await red.waitForSelector("#dialogBody", { timeout: 10000 });
  const coldPanel = await red.evaluate(() => {
    const body = document.getElementById("dialogBody");
    const begin = [...body.querySelectorAll("button")].find((b) => /^Begin Hostilities$/.test(b.textContent.trim()));
    return { hasBegin: Boolean(begin), disabled: begin ? begin.disabled : null };
  });
  mark("the cold war offers Begin Hostilities at round 0, the counter elapsed",
    coldPanel.hasBegin && coldPanel.disabled === false, "disabled=" + coldPanel.disabled);
  await red.evaluate(() => {
    const begin = [...document.querySelectorAll("#dialogBody button")].find((b) => /^Begin Hostilities$/.test(b.textContent.trim()));
    if (!begin) throw new Error("the cold war has no Begin Hostilities button");
    begin.click();
  });
  for (const seat of [blue, red]) {
    await seat.waitForFunction(() => {
      const room = window.__chq.room();
      return Boolean(room && room.peace && room.peace.active === false);
    }, null, { timeout: 25000, polling: 100 });
  }
  const coldLeft = await red.evaluate(() => ({
    peace: window.__chq.room().peace,
    strip: (document.getElementById("stripInfo").textContent || "").trim(),
  }));
  const coldLeftBlue = await blue.evaluate(() => ({
    peace: window.__chq.room().peace,
    strip: (document.getElementById("stripInfo").textContent || "").trim(),
  }));
  mark("one press ends the cold war for BOTH seats, and the war is on",
    coldLeft.peace.active === false && coldLeft.peace.brokenBy === "red" &&
      coldLeftBlue.peace.active === false && coldLeftBlue.peace.brokenBy === "red",
    "red=" + JSON.stringify(coldLeft.peace) + " blue=" + JSON.stringify(coldLeftBlue.peace));
  mark("the cold-war counter is gone from the strip while the war runs",
    !/cold war|war may resume/i.test(coldLeft.strip) && !/cold war|war may resume/i.test(coldLeftBlue.strip),
    "red=" + coldLeft.strip + " | blue=" + coldLeftBlue.strip);
  await red.keyboard.press("Escape");
  await sleep(250);

  // Run the clock: the cease-fire tool is a wartime act and the server refuses it on a held clock.
  await blue.click("#clockBtn");
  await blue.waitForFunction(() => window.__chq.room() && window.__chq.room().clock === "running", null,
    { timeout: 15000, polling: 100 });

  // Blue proposes from the kit; red's kit turns the same row into the answer. The kit is a panel,
  // so open it the way a player does before reading its buttons.
  await blue.click('.navbtn[data-dialog="kit"]');
  await blue.waitForSelector('.shop.tools button', { timeout: 25000 });
  await blue.evaluate(() => {
    const button = [...document.querySelectorAll(".shop.tools button")].find((b) => /^Cease-fire$/.test(b.textContent.trim()));
    if (!button) throw new Error("blue's kit has no Cease-fire button: " + [...document.querySelectorAll(".shop.tools button")].map((b) => b.textContent).join("|"));
    button.click();
  });
  await red.click('.navbtn[data-dialog="kit"]');
  await red.waitForFunction(() => {
    const room = window.__chq.room();
    return Boolean(room && room.seat && room.seat.ceasefire && room.seat.ceasefire.canAnswer === true);
  }, null, { timeout: 25000, polling: 100 });
  await red.waitForSelector('.shop.tools button', { timeout: 25000 });
  const acceptTitle = await red.evaluate(() => {
    const button = [...document.querySelectorAll(".shop.tools button")].find((b) => /^Accept cease-fire$/.test(b.textContent.trim()));
    if (!button) throw new Error("red's kit has no Accept cease-fire button");
    const title = button.title;
    button.click();
    return title;
  });
  // frodo 9241 §2: the sentence on the button that creates the state must not promise an ending.
  mark("the accept button's title names the peace, not an end to the war",
    !/war ends/i.test(acceptTitle) && /peace/i.test(acceptTitle), acceptTitle);

  await blue.waitForFunction(() => {
    const room = window.__chq.room();
    return Boolean(room && room.peace && room.peace.active === true);
  }, null, { timeout: 25000, polling: 100 });
  await red.waitForFunction(() => {
    const room = window.__chq.room();
    return Boolean(room && room.peace && room.peace.active === true);
  }, null, { timeout: 25000, polling: 100 });
  await sleep(400);

  const peaceState = await blue.evaluate(() => {
    const room = window.__chq.room();
    return {
      peace: room.peace,
      strip: (document.getElementById("stripInfo").textContent || "").trim(),
      note: window.__chq.note(),
    };
  });
  mark("an accepted cease fire is a PEACE, not an ending", Boolean(peaceState.peace && peaceState.peace.active === true),
    JSON.stringify(peaceState.peace));
  mark("the match is not over and no winner is named",
    await blue.evaluate(() => !window.__chq.room().over && !window.__chq.room().winner), "over/winner are clear");
  mark("the strip prints the counter", /cease-fire/i.test(peaceState.strip) && /war may resume/i.test(peaceState.strip),
    peaceState.strip);

  // The War panel: the counter, the peacetime footing, and Begin Hostilities.
  await blue.click('.navbtn[data-dialog="war"]');
  await blue.waitForSelector("#dialogBody", { timeout: 10000 });
  const panel = await blue.evaluate(() => {
    const body = document.getElementById("dialogBody");
    const begin = [...body.querySelectorAll("button")].find((b) => /^Begin Hostilities$/.test(b.textContent.trim()));
    return {
      text: (body.textContent || "").replace(/\s+/g, " ").trim(),
      hasBegin: Boolean(begin),
      beginDisabled: begin ? begin.disabled : null,
      beginTitle: begin ? begin.title : "",
      dfn: [...body.querySelectorAll("dt")].map((dt) => dt.textContent + "=" + (dt.nextElementSibling ? dt.nextElementSibling.textContent : "")),
    };
  });
  mark("the War panel prints the peace counter", /Cease-fire=the mandatory peace has elapsed/.test(panel.dfn.join("|")),
    panel.dfn.join(" | "));
  // PB-245b shipped the longer footing sentence (web/public/app.js:2678: transfers, oil, unready
  // cities, cash, production ground, starting destinations, the invisible enemy). Pin the shipped words.
  mark("the War panel states the peacetime footing", /Peacetime: units transfer instantly/.test(panel.text), panel.text.slice(0, 120));
  mark("the agreement's note is printed while the peace stands", /Cease fire accepted/i.test(panel.text),
    panel.text.slice(0, 160));
  mark("the War panel offers Begin Hostilities, enabled at the elapsed counter",
    panel.hasBegin && panel.beginDisabled === false, "disabled=" + panel.beginDisabled + " title=" + panel.beginTitle);
  const shotPeace = path.join(OUT, "peace-war-panel-1280x800.png");
  await blue.screenshot({ path: shotPeace, fullPage: false });
  mark("War panel screenshot at 1280x800", true, shotPeace);

  // Press it. The war must come back for BOTH seats without a reload.
  const blueLogMark = await blue.evaluate(() => window.__chq.log().length);
  const redLogMark = await red.evaluate(() => window.__chq.log().length);
  await blue.evaluate(() => {
    const begin = [...document.querySelectorAll("#dialogBody button")].find((b) => /^Begin Hostilities$/.test(b.textContent.trim()));
    if (!begin) throw new Error("Begin Hostilities vanished before the press");
    begin.click();
  });
  await blue.waitForFunction(() => {
    const room = window.__chq.room();
    return Boolean(room && room.peace && room.peace.active === false);
  }, null, { timeout: 25000, polling: 100 });
  await red.waitForFunction(() => {
    const room = window.__chq.room();
    return Boolean(room && room.peace && room.peace.active === false);
  }, null, { timeout: 25000, polling: 100 });
  await sleep(600);

  const after = await blue.evaluate(() => ({
    peace: window.__chq.room().peace,
    strip: (document.getElementById("stripInfo").textContent || "").trim(),
    note: window.__chq.note(),
    dialog: (document.getElementById("dialogBody").textContent || "").replace(/\s+/g, " ").trim(),
    lines: window.__chq.log().map((line) => line.text),
  }));
  const afterRed = await red.evaluate(() => ({
    peace: window.__chq.room().peace,
    lines: window.__chq.log().map((line) => line.text),
  }));
  mark("the war is on again for the seat that pressed", after.peace && after.peace.active === false && after.peace.brokenBy === "blue",
    JSON.stringify(after.peace));
  mark("the war is on again for the OTHER seat", afterRed.peace && afterRed.peace.active === false,
    JSON.stringify(afterRed.peace));
  mark("the strip's counter is gone", !/cease-fire/i.test(after.strip), after.strip);
  mark("the stale cease-fire note is cleared", !/Cease fire accepted/i.test(after.note) && !/Cease fire accepted/.test(after.dialog),
    "board note=" + JSON.stringify(after.note));
  mark("the War panel no longer offers Begin Hostilities", !/Begin Hostilities/.test(after.dialog), after.dialog.slice(0, 140));
  const blueLines = after.lines.slice(blueLogMark).map((t) => t.text || t);
  const redLines = afterRed.lines.slice(redLogMark).map((t) => t.text || t);
  mark("the acting seat reads its own act", blueLines.some((t) => /^you began hostilities; the war is on again$/.test(t)),
    JSON.stringify(blueLines.slice(-4)));
  mark("the other seat reads the breaker's sentence", redLines.some((t) => /^Blue has broken the peace: the war is on again\.$/.test(t)),
    JSON.stringify(redLines.slice(-4)));
  mark("the acting seat is not told it broke the peace", !blueLines.some((t) => /broken the peace/i.test(t)),
    JSON.stringify(blueLines.slice(-4)));
  const shotWar = path.join(OUT, "war-resumed-1280x800.png");
  await blue.screenshot({ path: shotWar, fullPage: false });
  mark("post-press screenshot at 1280x800", true, shotWar);
  mark("no page errors on either seat", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

  const summary = {
    base: BASE,
    roomId,
    seats: { blue: blueName, red: redName },
    atWarOpen,
    peace: peaceState,
    panel,
    after: { peace: after.peace, strip: after.strip, note: after.note },
    evidence,
    failed,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "pb245b-ship-peace.json"), JSON.stringify(summary, null, 2));
  console.log((failed ? "FAIL " : "PASS ") + failed + " failed / " + evidence.length + " checks");
  console.log("evidence " + path.join(OUT, "pb245b-ship-peace.json"));
  await ctxBlue.close();
  await ctxRed.close();
  await browser.close();
  if (child) child.kill();
  if (failed) process.exit(1);
}

await main();
