// PB-309 page leg: Switch Sides in a solo game, through a real page, a real socket and a real
// server at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb309-switch-sides.mjs                # starts its own server
//   node tests/e2e/pb309-switch-sides.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb309-switch-sides.mjs --out=<dir>
//
// Manual p.35 l.1126-1127: "you can actually switch sides during a game. To do this, press Switch
// Sides. This only works in a solo game or a game against 'no opponent.'"
//
// Per viewport:
//   1. the War panel of a solo 1942 war offers a control labelled Switch Sides (the film bar's four
//      Show Red / Blue / Common / Both views are a different surface and are not this control);
//   2. pressing it moves the seat: the page's own room frame says you are red, the computer holds
//      blue, and the reopened War panel says so in its own rows;
//   3. the sentence the player reads is the server's, and it carries no raw piece id;
//   4. a unit of the new side takes an order (the page says "Order sent."), so the player commands
//      the side they switched to;
//   5. a two-human war refuses the same press with a sentence, and no seat moves;
//   6. no page errors at either width.

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
const OUT = evidenceDir("pb309-switch-sides", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + ": " + log));
    });
  });
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "").slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + String(detail).slice(0, 300) : ""));
  return Boolean(ok);
}

// PB-313: a press may only follow a control that was SEEN. A bare page.click on a tree without the
// control burns Playwright's 30 s action timeout and THROWS, which used to skip the evidence file and
// the verdict line entirely — a pre-fix run then reads as a broken leg, not a clean red. Both helpers
// below are deadline-bounded and cannot throw: the result is always a value the leg can mark.
const SWITCH_DEADLINE_MS = 5000;
async function switchControl(page) {
  return page
    .waitForSelector("#switchSidesBtn", { state: "visible", timeout: SWITCH_DEADLINE_MS })
    .catch(() => null);
}
async function pressSwitch(page) {
  return page
    .click("#switchSidesBtn", { timeout: SWITCH_DEADLINE_MS })
    .then(() => true)
    .catch(() => false);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb309-e2e-"));
let server = null;
let browser = null;
let BASE = GIVEN;

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
}

let crash = null;
try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("a given server answers", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });

  for (const viewport of VIEWPORTS) {
    const tag = viewport.width + "x" + viewport.height;
    const run = Date.now().toString(36).slice(-6);
    const pageErrors = [];
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });

    const room = () => page.evaluate(() => window.__chq.room());
    const toast = () => page.evaluate(() => document.querySelector("#flash")?.textContent || "");
    const texts = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => String(el.textContent || "").trim()), selector);
    const shot = (name) => page.screenshot({ path: path.join(OUT, name + "-" + tag + ".png") });
    async function waitToast(pattern, deadline = 12000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const line = await toast();
        if (pattern.test(String(line))) return String(line);
        await sleep(80);
      }
      return null;
    }
    async function waitRoom(pred, deadline = 25000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await room();
        if (cur && pred(cur)) return cur;
        await sleep(100);
      }
      return null;
    }
    async function openWar() {
      await page.click('.navbtn[data-dialog="war"]');
      await sleep(220);
    }
    async function closeWar() {
      await page.click("#dialogClose");
      await sleep(120);
    }

    // ---- 1. the control exists on the live war's own panel -----------------------------------
    await signIn(page, "e2e-pb309-" + tag + "-" + run, "pw-" + run + "-a");
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    const solo = await waitRoom((r) => r.mode === "bot" && r.you === "blue");
    if (!mark(tag + ": a solo 1942 war opened with the player blue", Boolean(solo), solo && solo.id)) throw new Error("no solo room");
    await openWar();
    const buttons = await texts("#dialogBody button");
    mark(tag + ": the War panel offers a control labelled Switch Sides",
      buttons.includes("Switch Sides"), buttons.join(" | "));
    mark(tag + ": the film bar's four views are not what this control is",
      !buttons.some((b) => /^Show (Red|Blue|Common|Both)$/.test(b)), buttons.join(" | "));
    const controlSeen = await switchControl(page);
    mark(tag + ": the control is on the panel before any press (" + SWITCH_DEADLINE_MS
      + " ms guarded probe, cannot throw)", Boolean(controlSeen), buttons.join(" | "));
    await shot("01-war-panel-solo");

    // PB-313: on a build without the control, every fact that depends on the press is RED BY NAME and
    // the panel's own button labels are the reason. A missing affordance is an assertion, not a throw.
    const absent = "control absent — War panel buttons: " + (buttons.join(" | ") || "(none)");
    const pressed = Boolean(controlSeen) && await pressSwitch(page);

    if (pressed) {
      // ---- 2. the press moves the seat -------------------------------------------------------
      const flippedRoom = await waitRoom((r) => r.you === "red" && r.blue && r.blue.kind === "bot");
      mark(tag + ": the page's room frame says the player now holds the red side", Boolean(flippedRoom),
        flippedRoom ? JSON.stringify({ you: flippedRoom.you, blue: flippedRoom.blue, red: flippedRoom.red }) : "no flip");
      const flippedToast = await waitToast(/now the red side/i);
      mark(tag + ": the player reads the server's own sentence", Boolean(flippedToast), String(flippedToast));
      mark(tag + ": the sentence carries no raw piece id", Boolean(flippedToast)
        && !/(blue|red):[a-z]+:/.test(String(flippedToast || "")), String(flippedToast));
      mark(tag + ": the computer holds the side just left",
        Boolean(flippedRoom) && flippedRoom.blue.kind === "bot" && flippedRoom.red.kind === "human",
        flippedRoom ? JSON.stringify({ blue: flippedRoom.blue, red: flippedRoom.red }) : "no flip");
      // The panel is repainted on the room frame; close and reopen so the read is of a fresh paint.
      await closeWar();
      await openWar();
      const rows = await texts("#dialogBody dl dt, #dialogBody dl dd, #dialogBody p");
      const panelText = rows.join(" | ");
      mark(tag + ": the reopened War panel names the new side",
        /You/.test(panelText) && /\bred\b/.test(panelText) && /now the red side/i.test(panelText),
        panelText.slice(0, 300));
      await shot("02-war-panel-flipped");
      await closeWar();

      // ---- 3. an order on the new side lands -------------------------------------------------
      const fresh = await room();
      const mine = (fresh.pieces || []).filter((p) => p.side === fresh.you && p.domain !== "sat"
        && p.kind !== "aircraft" && p.domain !== "air" && p.domain !== "sea");
      let orderLine = null;
      for (const piece of mine.slice(0, 8)) {
        for (const [dx, dy] of DIRS) {
          const point = await page.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [piece.x, piece.y]);
          await page.mouse.click(point.x, point.y);
          await sleep(200);
          const to = await page.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [piece.x + dx, piece.y + dy]);
          await page.mouse.click(to.x, to.y);
          const line = await waitToast(/Order sent|refused|not yours|cannot|no route|nowhere/i, 4000);
          if (line && /Order sent/.test(line)) { orderLine = line; break; }
        }
        if (orderLine) break;
      }
      mark(tag + ": a unit of the new side takes an order", Boolean(orderLine), String(orderLine));
      await shot("03-order-on-new-side");
    } else {
      for (const step of [
        "the page's room frame says the player now holds the red side",
        "the player reads the server's own sentence",
        "the sentence carries no raw piece id",
        "the computer holds the side just left",
        "the reopened War panel names the new side",
        "a unit of the new side takes an order",
      ]) mark(tag + ": " + step, false, absent);
      await shot("02-switch-not-attempted");
      await closeWar().catch(() => {});
    }

    // A two-human war is a different room: out of the solo one first.
    await page.click("#quitBtn").catch(() => {});
    await sleep(400);

    // ---- 4. the 2P refusal -------------------------------------------------------------------
    const ctxB = await browser.newContext({ viewport });
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (err) => pageErrors.push("B: " + String(err)));
    pageB.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
    const nameB = "e2e-pb309b-" + tag + "-" + run;
    await signIn(pageB, nameB, "pw-" + run + "-b");
    // The player's page is still signed in and back in the lobby after Quit.
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.waitForSelector("li.person", { timeout: 30000 });
    await page.evaluate((name) => {
      const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
      row.querySelector("button").click();
    }, nameB);
    await pageB.waitForSelector("#invites .invite button", { timeout: 30000 });
    await pageB.evaluate(() => document.querySelector("#invites .invite button").click());
    const human = await waitRoom((r) => r.mode === "human" && r.blue && r.red
      && r.blue.kind === "human" && r.red.kind === "human");
    if (!mark(tag + ": a two-human 1942 war opened", Boolean(human), human && human.id)) throw new Error("no human room");
    const beforeTwo = JSON.stringify({ you: human.you, blue: human.blue, red: human.red });
    await openWar();
    const twoButtons = await texts("#dialogBody button");
    mark(tag + ": the 2P War panel still offers the control", twoButtons.includes("Switch Sides"), twoButtons.join(" | "));
    const twoSeen = await switchControl(page);
    const twoPressed = Boolean(twoSeen) && await pressSwitch(page);
    const twoAbsent = "control absent — 2P War panel buttons: " + (twoButtons.join(" | ") || "(none)");
    const refuseLine = twoPressed ? await waitToast(/only works in a solo game/i) : null;
    mark(tag + ": a two-human war refuses Switch Sides with a sentence", Boolean(refuseLine),
      twoPressed ? String(refuseLine) : twoAbsent);
    const afterTwo = await room();
    mark(tag + ": the refused press moved no seat",
      twoPressed && JSON.stringify({ you: afterTwo.you, blue: afterTwo.blue, red: afterTwo.red }) === beforeTwo,
      beforeTwo + " -> " + JSON.stringify({ you: afterTwo.you, blue: afterTwo.blue, red: afterTwo.red }));
    await shot("04-two-human-refusal");
    await ctxB.close();

    mark(tag + ": no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    await context.close();
  }

} catch (err) {
  // PB-313: an unexpected throw is an assertion too — recorded by name, and the artifact still lands.
  crash = err;
  mark("the leg reached its summary (unexpected throw)", false,
    String((err && err.stack) || err).slice(0, 900));
} finally {
  try {
    const file = path.join(OUT, "pb309-switch-sides.json");
    writeFileSync(file, JSON.stringify({
      base: BASE,
      viewports: VIEWPORTS,
      evidence,
      crash: crash ? String((crash && crash.stack) || crash) : null,
    }, null, 2) + "\n");
    console.log("EVIDENCE " + file);
  } catch (writeErr) {
    console.log("EVIDENCE WRITE FAILED " + String((writeErr && writeErr.message) || writeErr));
  }
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
}

console.log("PB309_E2E " + (failed === 0 && !crash ? "OK" : "FAILED " + failed));
if (failed !== 0 || crash) process.exitCode = 1;
