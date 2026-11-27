// PB-205 page leg: the TWO-HUMAN handshake on a real page - the saved war that is not one seat's to
// start, and the war both seats saved at different moments. Tests-only: no served file is touched.
//
//   node tests/e2e/pb205-two-human.mjs                 # starts its own server on a free port
//   node tests/e2e/pb205-two-human.mjs --url=<base>    # a running server (the shipped build)
//   node tests/e2e/pb205-two-human.mjs --out=<dir>
//
// Why it exists: the canonical page leg (pb205-save-resume.mjs) drives a BOT war, and the node leg
// builds the incomplete-war case by DELETING one copy. Between them, two player-facing branches were
// unexercised:
//
//   W  p.36 l.1145 + p.37 l.1146-1150. Both seats save their own copy of one war; ONE seat's
//      selection must wait - "Waiting for <name> to select the same war" - create no room, and be
//      readable at /api/slots/pending. The SECOND seat's selection of its own copy opens ONE new
//      room for both accounts, at the saved round, with the clock held. Measured at 1280x800 and
//      1024x768 from two real browser contexts.
//   M  p.36 l.1145. Both seats saved the same war but NOT the same moment. The list must report
//      war.complete=false, sameMoment=false, waitingOn=[], and the selection must be refused with
//      "Both players have saved this war, but not the same moment of it. Save again with the clock
//      held." and create nothing. Built the way a player makes it: a live 1942 two-human room, the
//      clock running at speed 6, one seat saving at round N and the other at round M>N. (1986 and
//      2023 open in the cold war, where T-035 runs no round until hostilities are declared, so a
//      1986 room would hold at round 0 forever - that is why the moment branch needs a wartime era.)
//   X  one copy left: the selection is refused "Both players must save ..." and creates nothing.
//      The local mode removes the second copy from the store; --url mode cannot (the served volume
//      is not ours to write) and skips it, saying so.
//
// The state comes from window.__chq.room(), the same payload the page draws; every player-facing
// line is read from the rendered DOM.

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
const OUT = evidenceDir("pb205-two-human", argOf("out"));
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
  writeFileSync(path.join(OUT, "pb205-two-human.json"), JSON.stringify({ evidence }, null, 2));
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

async function startServer(port, dataDir) {
  child = spawn(process.execPath, ["web/server/main.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/api/version");
      if (res.ok) return;
    } catch {}
    await sleep(120);
  }
  throw new Error("the server did not answer on " + port);
}

const roomOf = (page) => page.evaluate(() => window.__chq.room());
const textOf = (page, sel) => page.evaluate((s) => String(document.querySelector(s)?.textContent || "").trim(), sel);

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
}

async function openTwoHumanWar(a, b, nameB, era) {
  await a.selectOption('#launch select[name="era"]', era);
  await a.selectOption('#launch select[name="side"]', "blue");
  await a.waitForSelector("li.person", { timeout: 30000 });
  await a.evaluate((name) => {
    const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
    row.querySelector("button").click();
  }, nameB);
  await b.waitForSelector("#invites .invite button", { timeout: 30000 });
  await b.evaluate(() => document.querySelector("#invites .invite button").click());
  await a.waitForFunction(() => {
    const r = window.__chq.room();
    return Boolean(r) && r.blue && r.red && r.blue.kind === "human" && r.red.kind === "human";
  }, null, { timeout: 30000, polling: 100 });
  const warId = await a.evaluate(() => window.__chq.room().id);
  await b.waitForFunction((id) => String(window.__chq.room()?.id) === String(id), warId, { timeout: 30000, polling: 100 });
  return warId;
}

async function saveAs(page, name) {
  await page.click("#saveBtn");
  await page.waitForSelector("#savePanel:not(.hidden)", { timeout: 10000 });
  await page.fill("#saveName", name);
  await page.click("#saveGo");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#flash")?.textContent || ""),
    'Saved war "' + escaped + '" at round \\d+\\.', { timeout: 15000 });
  const flash = await textOf(page, "#flash");
  return { flash, round: Number((flash.match(/at round (\d+)/) || [])[1]) };
}

async function clickSlot(page, name) {
  await page.waitForFunction((want) => [...document.querySelectorAll("#slotList .slotrow")]
    .some((row) => String(row.querySelector(".slottitle")?.textContent || "").trim() === want), name, { timeout: 15000 });
  await page.evaluate((want) => {
    const row = [...document.querySelectorAll("#slotList .slotrow")]
      .find((r) => String(r.querySelector(".slottitle")?.textContent || "").trim() === want);
    row.click();
  }, name);
}

async function leaveRoom(page) {
  if (await roomOf(page)) await page.click("#quitBtn");
  await page.waitForFunction(() => window.__chq.room() === null, null, { timeout: 20000 });
}

async function main() {
  const { chromium } = await loadPlaywright();
  let dataDir = "";
  if (GIVEN) {
    BASE = GIVEN;
  } else {
    const port = await freePort();
    dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb205-2p-"));
    BASE = "http://127.0.0.1:" + port;
    await startServer(port, dataDir);
  }
  mark("a server answers", true, BASE);
  const version = await (await fetch(BASE + "/api/version", { cache: "no-store" })).json();
  mark("the server names its literal", Boolean(version && version.commit), JSON.stringify(version));

  const browser = await chromium.launch({ headless: true });

  for (const viewport of VIEWPORTS) {
    const tag = viewport.width + "x" + viewport.height;
    const run = Date.now().toString(36).slice(-6);
    const errors = [];
    const contexts = [];

    const pair = async (era, names) => {
      const ctxA = await browser.newContext({ viewport });
      const ctxB = await browser.newContext({ viewport });
      contexts.push(ctxA, ctxB);
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      for (const [who, page] of [[names[2], a], [names[3], b]]) {
        page.on("pageerror", (err) => errors.push(who + ": " + String(err)));
        page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
      }
      await signIn(a, names[0], "pw-a-" + run);
      await signIn(b, names[1], "pw-b-" + run);
      const warId = await openTwoHumanWar(a, b, names[1], era);
      return { a, b, warId };
    };
    const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + "-" + tag + ".png") });

    // ---- W: both seats save one war; the first selection waits, the second opens it -------------
    try {
      const nameA = "TwoWA" + tag.replace("x", "") + run;
      const nameB = "TwoWB" + tag.replace("x", "") + run;
      const { a, b, warId } = await pair("1986", [nameA, nameB, "W-A", "W-B"]);
      const held = await roomOf(a);
      const savedRound = Number(held.round);
      mark(tag + " W: two accounts hold one 1986 two-human war",
        held.blue.kind === "human" && held.red.kind === "human" && held.clock !== "running",
        "room " + warId + " round " + savedRound + " clock " + held.clock);

      const saveA = await saveAs(a, "W A Copy");
      const saveB = await saveAs(b, "W B Copy");
      mark(tag + " W: each seat saved its own copy of the same moment",
        saveA.round === saveB.round && saveA.round === savedRound,
        "A round " + saveA.round + " B round " + saveB.round + " room " + savedRound);
      await shot(b, "W1-both-saved");

      // Quit ends the room for both seats; then only selection exists.
      await leaveRoom(a);
      await b.waitForFunction(() => window.__chq.room() === null, null, { timeout: 20000 });

      await a.click("#resumeWarBtn");
      await a.waitForSelector("#slotsPanel:not(.hidden)", { timeout: 10000 });
      await clickSlot(a, "W A Copy");
      await a.waitForFunction(() => /Waiting for .* to select the same war/.test(document.querySelector("#slotsStatus")?.textContent || ""),
        null, { timeout: 15000 });
      const waitingText = await textOf(a, "#slotsStatus");
      const roomWhileWaiting = await roomOf(a);
      const pending = await a.evaluate(async () => (await (await fetch("/api/slots/pending", { cache: "no-store" })).json()));
      await shot(a, "W2-first-selection-waits");
      mark(tag + " W: the first selection waits on the page and names the other seat",
        new RegExp(nameB).test(waitingText) && roomWhileWaiting === null, waitingText + " | room=" + JSON.stringify(roomWhileWaiting));
      mark(tag + " W: the claim is readable at /api/slots/pending", pending && pending.waiting === true, JSON.stringify(pending));

      await b.click("#resumeWarBtn");
      await b.waitForSelector("#slotsPanel:not(.hidden)", { timeout: 10000 });
      await clickSlot(b, "W B Copy");
      await b.waitForFunction(() => Boolean(window.__chq.room()), null, { timeout: 25000, polling: 100 });
      await a.waitForFunction(() => Boolean(window.__chq.room()), null, { timeout: 25000, polling: 100 });
      const roomA = await roomOf(a);
      const roomB = await roomOf(b);
      const flashA = await textOf(a, "#flash");
      const panelClosed = await a.evaluate(() => document.querySelector("#slotsPanel").classList.contains("hidden"));
      await shot(a, "W3-both-selected");
      mark(tag + " W: the second selection opens ONE room for both seats",
        Boolean(roomA) && Boolean(roomB) && String(roomA.id) === String(roomB.id),
        "A=" + roomA?.id + " B=" + roomB?.id + " (saved war " + warId + ")");
      mark(tag + " W: the resumed war is the saved round, and the clock is held",
        Number(roomA.round) === savedRound && roomA.clock !== "running" && roomB.clock !== "running",
        "round " + roomA.round + " (saved " + savedRound + ") clock " + roomA.clock + "/" + roomB.clock);
      mark(tag + " W: the waiting page is told it was seated and its panel closes",
        panelClosed && /Both players chose the war/.test(flashA), flashA);
      mark(tag + " W: no player-facing handshake line carries a side:kind id",
        !/(blue|red):[a-z]/.test(waitingText + " " + flashA), waitingText + " | " + flashA);

      // ---- X: one copy left in the store -> the war is incomplete and cannot start -------------
      if (dataDir) {
        await leaveRoom(a);
        await b.waitForFunction(() => window.__chq.room() === null, null, { timeout: 20000 });
        const bSlots = await b.evaluate(async () => (await (await fetch("/api/slots", { cache: "no-store" })).json()));
        const bCopy = (bSlots.slots || []).find((s) => String(s.name).toLowerCase() === "w b copy");
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(path.join(dataDir, "openchq.sqlite"));
        try {
          db.prepare("DELETE FROM saves WHERE id = ?").run(bCopy.id);
        } finally {
          db.close();
        }
        await a.click("#resumeWarBtn");
        await a.waitForSelector("#slotsPanel:not(.hidden)", { timeout: 10000 });
        await clickSlot(a, "W A Copy");
        await a.waitForFunction(() => /Both players must save/.test(document.querySelector("#slotsStatus")?.textContent || ""),
          null, { timeout: 15000 });
        const refuseText = await textOf(a, "#slotsStatus");
        await shot(a, "W4-one-copy-refused");
        mark(tag + " X: a one-copy two-player war is refused on the page and creates nothing",
          /Both players must save/.test(refuseText) && (await roomOf(a)) === null, refuseText);
      } else {
        mark(tag + " X: skipped in --url mode (the served store is not ours to write)", true, "not a gate claim");
      }
    } catch (err) {
      mark(tag + " W/X: the section ran to the end", false, err && err.stack ? err.stack : String(err));
    }
    for (const ctx of contexts.splice(0)) await ctx.close().catch(() => {});

    // ---- M: both seats saved the SAME war at DIFFERENT moments ---------------------------------
    try {
      const nameC = "TwoMC" + tag.replace("x", "") + run;
      const nameD = "TwoMD" + tag.replace("x", "") + run;
      const { a: c, b: d, warId } = await pair("1942", [nameC, nameD, "M-C", "M-D"]);

      // Speed 6 = 0.6 s a round, so two saves are genuinely two moments of one war.
      for (let i = 0; i < 5; i += 1) await c.click("#speedUp");
      await c.waitForFunction(() => Number(window.__chq.room()?.speed) >= 6, null, { timeout: 15000, polling: 100 });
      const startRound = Number((await roomOf(c)).round);
      await c.click("#clockBtn");
      await c.waitForFunction((base) => window.__chq.room()?.clock === "running" && Number(window.__chq.room().round) >= base + 2,
        startRound, { timeout: 30000, polling: 100 });
      const saveC = await saveAs(c, "M C Later");
      await c.waitForFunction((n) => Number(window.__chq.room().round) >= n + 2, saveC.round, { timeout: 30000, polling: 100 });
      const saveD = await saveAs(d, "M D Later");
      await shot(d, "M1-two-moments-saved");
      mark(tag + " M: one war was saved at two different rounds", saveD.round > saveC.round,
        "room " + warId + " C round " + saveC.round + " D round " + saveD.round);

      const slots = await c.evaluate(async () => (await (await fetch("/api/slots", { cache: "no-store" })).json()));
      const slotC = (slots.slots || []).find((s) => String(s.name) === "M C Later");
      mark(tag + " M: the list reports incomplete, not the same moment, nobody missing",
        Boolean(slotC) && slotC.war && slotC.war.complete === false && slotC.war.sameMoment === false &&
          Array.isArray(slotC.war.waitingOn) && slotC.war.waitingOn.length === 0,
        JSON.stringify(slotC && slotC.war));

      await leaveRoom(c);
      await d.waitForFunction(() => window.__chq.room() === null, null, { timeout: 20000 });

      await c.click("#resumeWarBtn");
      await c.waitForSelector("#slotsPanel:not(.hidden)", { timeout: 10000 });
      await clickSlot(c, "M C Later");
      await c.waitForFunction(() => /not the same moment/.test(document.querySelector("#slotsStatus")?.textContent || ""),
        null, { timeout: 15000 });
      const refuseText = await textOf(c, "#slotsStatus");
      await shot(c, "M2-not-the-same-moment-refused");
      mark(tag + " M: the page refuses it, names the remedy, and creates nothing",
        /not the same moment/.test(refuseText) && /clock held/.test(refuseText) && (await roomOf(c)) === null, refuseText);
    } catch (err) {
      mark(tag + " M: the section ran to the end", false, err && err.stack ? err.stack : String(err));
    }
    for (const ctx of contexts.splice(0)) await ctx.close().catch(() => {});
    mark(tag + ": no page error", errors.length === 0, errors.join(" | "));
  }

  await browser.close();
  const passed = evidence.filter((e) => e.ok).length;
  console.log("\npb205 two-human leg: " + (failed === 0 ? "PASS" : "FAIL") +
    " (" + passed + " passed, " + failed + " failed) at " + BASE + " — " + OUT);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { if (child) child.kill(); process.exit(code); })
  .catch((err) => {
    mark("leg threw", false, err && err.stack ? err.stack : String(err));
    if (child) child.kill();
    process.exit(1);
  });
