// PB-315 page leg: the TWO-HUMAN pause handshake on a real page (manual p.34).
//
//   node tests/e2e/pb315-pause-handshake.mjs                 # starts its own server on a free port
//   node tests/e2e/pb315-pause-handshake.mjs --url=<base>    # a running server (the shipped build)
//   node tests/e2e/pb315-pause-handshake.mjs --out=<dir>
//
// "In a two-player game, only one player need press Pause ... Both players must 'unpause' in order
// for the game to begin again." "Opponent Waiting" shows if the opponent has unpaused and you have
// not; "Waiting for Opponent" if you have unpaused and he has not.
//
// What this leg measures, at 1280x800 AND 1024x768, from two real browser contexts:
//   (a) either seat's Pause holds the clock for both seats;
//   (b) the clock runs again only after both seats press Play;
//   (c) between the presses, the seat that pressed Play and was refused reads "Waiting for
//       Opponent" and the seat holding reads "Opponent Waiting" - on #pauseBanner, with no raw ids;
//   (d) a bot room is unchanged: one Play resumes and the handshake sentences never appear there;
//   (e) a seat that leaves does not leave the other stuck: the present seat's Play is accepted and
//       the room says why the clock stopped.
//
// Run on a pre-change tree this leg is RED on the (c) arms by name ("... reads <text>") because the
// frame carried no `hold` block at all, so both seats were told the same sentence. Nothing here
// writes to the store except the rooms a player would open.

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
const OUT = evidenceDir("pb315-pause-handshake", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 300)));
  writeFileSync(path.join(OUT, "pb315-pause-handshake.json"), JSON.stringify({ evidence }, null, 2));
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

// Everything this leg asserts is read from the page: the banner the player sees, the room payload
// the page draws, and the toast a refused press puts up.
const state = (page) => page.evaluate(() => {
  const banner = document.getElementById("pauseBanner");
  const room = window.__chq.room();
  return {
    bannerText: banner ? banner.textContent : null,
    bannerHidden: banner ? banner.classList.contains("hidden") : null,
    bannerPaused: banner ? banner.classList.contains("paused") : null,
    clock: room ? room.clock : null,
    hold: room ? (room.hold || null) : null,
    note: room ? (room.note || "") : "",
    toast: window.__chq.toast() || "",
  };
});

async function clickClock(page) {
  await page.evaluate(() => document.getElementById("clockBtn").click());
  await sleep(250);
}

async function waitClock(page, want, what) {
  try {
    await page.waitForFunction((value) => {
      const room = window.__chq.room();
      return Boolean(room) && room.clock === value;
    }, want, { timeout: 8000, polling: 80 });
    return true;
  } catch {
    const now = await state(page);
    mark(what, false, "clock stayed " + now.clock + " (wanted " + want + ")");
    return false;
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb315-"));
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
      } catch { /* still booting */ }
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  // ---- (d) a bot room is unchanged: ONE Play resumes, no handshake sentence -------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    const tag = Date.now().toString(36).slice(-6);
    await signIn(page, "P315Bot" + tag, "pw-bot-" + tag);
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.evaluate(() => document.querySelector("#launch button[type=submit]").click());
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
      null, { timeout: 25000, polling: 100 });
    await sleep(300);
    const opened = await state(page);
    mark("(d) a bot room opens on the plain paused sentence",
      opened.bannerText === "Paused - press Play to resume", "banner=" + JSON.stringify(opened.bannerText));
    await clickClock(page);
    const paused = await waitClock(page, "running", "(d) the bot room's Play starts the clock");
    const afterPlay = await state(page);
    mark("(d) one Play resumes a bot room and the handshake sentence never appears",
      paused && afterPlay.bannerPaused === false && afterPlay.bannerText !== "Waiting for Opponent",
      "clock=" + afterPlay.clock + " pausedClass=" + afterPlay.bannerPaused + " banner=" + JSON.stringify(afterPlay.bannerText));
    await clickClock(page);
    await waitClock(page, "held", "(d) the bot room's Pause holds the clock");
    const held = await state(page);
    mark("(d) a bot room keeps the plain sentence while held",
      held.bannerText === "Paused - press Play to resume" && String(held.note || "").length > 0,
      "banner=" + JSON.stringify(held.bannerText));
    mark("(d) the bot arm runs with no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  for (const viewport of VIEWPORTS) {
    const tag = Date.now().toString(36).slice(-6) + viewport.width;
    const ctxBlue = await browser.newContext({ viewport });
    const ctxRed = await browser.newContext({ viewport });
    const blue = await ctxBlue.newPage();
    const red = await ctxRed.newPage();
    const errors = [];
    blue.on("pageerror", (err) => errors.push("blue: " + String(err)));
    red.on("pageerror", (err) => errors.push("red: " + String(err)));
    const blueName = "P315Blue" + tag;
    const redName = "P315Red" + tag;

    await signIn(blue, blueName, "pw-blue-" + tag);
    await signIn(red, redName, "pw-red-" + tag);
    mark("both seats are in the lobby @" + viewport.width, true, blueName + " / " + redName);

    // Two humans: blue invites red from the online list, red accepts.
    await blue.selectOption('#launch select[name="era"]', "1986");
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

    const opened = await state(blue);
    mark("the two-human room opens held on the plain sentence @" + viewport.width,
      opened.clock === "held" && opened.bannerText === "Paused - press Play to resume",
      "clock=" + opened.clock + " banner=" + JSON.stringify(opened.bannerText));

    // The page is given the two hold facts; without them it cannot word (c) at all.
    mark("the room frame carries a per-seat hold block @" + viewport.width,
      opened.hold !== null && typeof opened.hold === "object"
        && opened.hold.you === false && opened.hold.other === false,
      "hold=" + JSON.stringify(opened.hold));

    // ---- (b) nobody holds: one Play starts the clock ----------------------------------------
    await clickClock(blue);
    await waitClock(blue, "running", "(b) blue's Play starts the clock");
    await waitClock(red, "running", "(b) red sees the clock running");

    // ---- (a) blue's Pause holds it for both -------------------------------------------------
    await clickClock(blue);
    await waitClock(blue, "held", "(a) blue's Pause holds the clock");
    await waitClock(red, "held", "(a) red sees the clock held");
    const blueHeld = await state(blue);
    const redHeld = await state(red);

    // ---- (c) each seat's sentence names its side of the handshake --------------------------
    mark("(c) the seat holding reads Opponent Waiting @" + viewport.width,
      blueHeld.bannerText === "Opponent Waiting" && blueHeld.bannerPaused === true,
      "banner=" + JSON.stringify(blueHeld.bannerText) + " pausedClass=" + blueHeld.bannerPaused);
    mark("(c) the other seat reads Waiting for Opponent @" + viewport.width,
      redHeld.bannerText === "Waiting for Opponent" && redHeld.bannerPaused === true,
      "banner=" + JSON.stringify(redHeld.bannerText) + " pausedClass=" + redHeld.bannerPaused);

    // ---- (b)+(c) red's Play is refused, and the sentences do not move ----------------------
    await clickClock(red);
    await sleep(300);
    const redRefused = await state(red);
    const blueWatching = await state(blue);
    mark("(b) one seat's Play does not resume the other's Pause @" + viewport.width,
      redRefused.clock === "held" && blueWatching.clock === "held",
      "red=" + redRefused.clock + " blue=" + blueWatching.clock);
    mark("(b) the refused seat is told who holds the clock, by name, not by id @" + viewport.width,
      redRefused.toast.includes("The clock is held by " + blueName) && !/[0-9a-f]{16,}/i.test(redRefused.toast),
      "toast=" + JSON.stringify(redRefused.toast));
    mark("(c) the refused seat still reads Waiting for Opponent @" + viewport.width,
      redRefused.bannerText === "Waiting for Opponent",
      "banner=" + JSON.stringify(redRefused.bannerText));
    mark("(c) the holder still reads Opponent Waiting @" + viewport.width,
      blueWatching.bannerText === "Opponent Waiting",
      "banner=" + JSON.stringify(blueWatching.bannerText));

    // ---- (b) the holder's Play resumes it --------------------------------------------------
    await clickClock(blue);
    await waitClock(blue, "running", "(b) the holder's Play resumes the clock");
    await waitClock(red, "running", "(b) red sees the clock running again");
    const running = await state(red);
    mark("(c) the handshake sentence goes away when the clock runs @" + viewport.width,
      running.bannerPaused === false && running.bannerText === "Paused - press Play to resume",
      "banner=" + JSON.stringify(running.bannerText) + " pausedClass=" + running.bannerPaused);

    // ---- symmetry: the other seat can hold too, and the sentences follow the seat ----------
    await clickClock(red);
    await waitClock(blue, "held", "(a) red's Pause holds the clock for blue");
    const redHeld2 = await state(red);
    const blueHeld2 = await state(blue);
    mark("(a) either seat's Pause holds the clock for both @" + viewport.width,
      redHeld2.clock === "held" && blueHeld2.clock === "held",
      "red=" + redHeld2.clock + " blue=" + blueHeld2.clock);
    mark("(c) the sentence follows the seat that held, not the seat that shipped @" + viewport.width,
      redHeld2.bannerText === "Opponent Waiting" && blueHeld2.bannerText === "Waiting for Opponent",
      "red=" + JSON.stringify(redHeld2.bannerText) + " blue=" + JSON.stringify(blueHeld2.bannerText));
    await clickClock(blue);
    await sleep(300);
    const blueRefused = await state(blue);
    mark("(b) blue's Play is refused while red holds @" + viewport.width,
      blueRefused.clock === "held" && blueRefused.toast.includes("The clock is held by " + redName),
      "clock=" + blueRefused.clock + " toast=" + JSON.stringify(blueRefused.toast));
    mark("(c) red is told blue is waiting @" + viewport.width,
      (await state(red)).bannerText === "Opponent Waiting", "red banner read after blue's refused Play");
    await clickClock(red);
    await waitClock(blue, "running", "(b) red's Play resumes after its own hold");

    // ---- (e) a seat that leaves does not leave the other stuck ------------------------------
    await clickClock(red);
    await waitClock(blue, "held", "(e) red's Pause holds the clock before the drop");
    await ctxRed.close();
    await sleep(800);
    const dropped = await state(blue);
    mark("(e) the present seat is told the match is paused and still theirs @" + viewport.width,
      dropped.clock === "held" && dropped.note.includes("disconnected"),
      "clock=" + dropped.clock + " note=" + JSON.stringify(dropped.note));
    mark("(e) the absent seat's hold does not survive the drop @" + viewport.width,
      dropped.hold && dropped.hold.other === false, "hold=" + JSON.stringify(dropped.hold));
    await clickClock(blue);
    const resumed = await waitClock(blue, "running", "(e) the present seat's Play is accepted after the drop");
    mark("(e) the present seat is not stuck at the clock the absent seat held @" + viewport.width,
      resumed === true, "clock=" + (await state(blue)).clock);

    mark("0 page errors @" + viewport.width, errors.length === 0, errors.join(" | "));
    await ctxBlue.close();
  }

  await browser.close();
  const total = evidence.length;
  console.log("PB315_E2E " + failed + " failed / " + total + " checks");
  if (failed) {
    console.log("PB315_E2E FAILED " + failed);
    process.exitCode = 1;
  } else {
    console.log("PB315_E2E PASSED " + total);
  }
}

main().catch((err) => {
  console.log("PB315_E2E CRASH " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
}).finally(() => {
  if (child) child.kill();
});
