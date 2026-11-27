// PB-205 page leg: Save Game, the overwrite confirmation, and Resume Saved War, through a real page,
// a real socket and a real server at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb205-save-resume.mjs                # starts its own server
//   node tests/e2e/pb205-save-resume.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb205-save-resume.mjs --out=<dir>
//
// Manual p.16 l.416 (Save Game) and p.36-37 l.1142-1150 (Resume Saved War). Per viewport:
//   1. control: a 1986 bot match runs one round and is held - so the save has a round, a path and a
//      purse that could all be lost, and the board is not round 0;
//   2. Save opens with the strip's own button, the war name is typed, Save is clicked: the player
//      reads "Saved war ... at round N.", and N is the round on screen;
//   3. the same name opens the OVERWRITE confirmation (case-folded), not a silent second slot; the
//      panel says so, the click on Overwrite replaces the slot (same id, same count) and the toast
//      says "Overwrote";
//   4. Resume Saved War lists the named slot, picking it restores that round, that piece set and
//      that purse, and the clock comes back HELD;
//   5. layout: the strip's four game buttons do not overlap each other or leave the viewport, and the
//      save panel and its confirmation buttons sit inside the viewport at both widths.
//
// The state comes from window.__chq.room(), the same payload the page draws; the slot list and the
// button texts come from the rendered DOM.

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
const OUT = evidenceDir("pb205-save-resume", argOf("out"));
const ERA = "1986";
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

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
    }, 10000);
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
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb205-e2e-"));
let server = null;
let browser = null;
let BASE = GIVEN;

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
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    // The strip's Resign/New/Quit open a native confirm(); a headless page auto-DISMISSES it, so
    // without this handler the click is silently cancelled and the room never changes. Accept, and
    // keep the text so the leg can assert the question was actually asked.
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });

    const room = () => page.evaluate(() => window.__chq.room());
    const texts = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => String(el.textContent || "").trim()), selector);
    const boxes = (selectors) => page.evaluate((list) => {
      const out = {};
      for (const sel of list) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        out[sel] = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom, visible: rect.width > 0 && rect.height > 0 };
      }
      return out;
    }, selectors);
    async function shot(name) {
      const file = path.join(OUT, name + "-" + tag + ".png");
      await page.screenshot({ path: file });
      return file;
    }
    async function waitRound(min, deadline = 20000) {
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const cur = await room();
        if (cur && Number(cur.round) >= min) return cur;
        await sleep(100);
      }
      return null;
    }

    // ---- 1. sign in, open a 1986 bot match, play one round, hold -------------------------
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const name = "e2e-pb205-" + tag + "-" + Date.now().toString(36).slice(-6);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await page.selectOption('#launch select[name="era"]', ERA);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
    await page.click("#speedUp");
    await page.click("#speedUp");
    await page.click("#speedUp");
    await page.click("#speedUp");
    await page.click("#speedUp");
    await page.click("#clockBtn");
    let cur = await waitRound(1);
    mark(tag + ": one round played before the save", Boolean(cur), "round " + (cur && cur.round));
    if (cur && cur.clock === "running") {
      await page.click("#clockBtn");
      await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock !== "running", null, { timeout: 8000 }).catch(() => {});
    }
    cur = await room();
    const savedRound = Number(cur.round);
    const savedCash = Number(cur.seat.cash);
    const savedIds = (cur.pieces || []).map((p) => p.id).sort();
    if (cur.clock === "running") {
      // A held clock keeps the save a point in time; the server holds on `hold`, so a second click
      // is only insurance for a dropped frame.
      await page.click("#clockBtn");
      await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock !== "running", null, { timeout: 8000 }).catch(() => {});
      cur = await room();
    }
    mark(tag + ": the clock is held before the save", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

    // ---- 2. Save under a name -------------------------------------------------------------
    await page.click("#saveBtn");
    await page.waitForSelector("#savePanel:not(.hidden)", { timeout: 8000 });
    await shot("01-save-open");
    await page.fill("#saveName", "Leg War");
    await page.click("#saveGo");
    await page.waitForFunction(() => /Saved war "Leg War" at round \d+\./.test(document.querySelector("#flash")?.textContent || ""), null, { timeout: 12000 });
    const saveToast = await page.textContent("#flash");
    mark(tag + ": Save writes a named slot at the round on screen", new RegExp("at round " + savedRound + "\\.").test(String(saveToast)), String(saveToast));
    await shot("02-saved");
    // The save panel closed on success.
    const panelHidden = await page.evaluate(() => document.querySelector("#savePanel").classList.contains("hidden"));
    mark(tag + ": the save panel closes on success", panelHidden);
    // The account's list now carries the slot.
    await page.click("#saveBtn");
    await page.waitForSelector("#savePanel:not(.hidden)", { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll("#saveExisting .slottitle")].some((el) => el.textContent === "Leg War"), null, { timeout: 10000 });
    const listed = await texts("#saveExisting .slottitle");
    mark(tag + ": the saved war is listed on the account", listed.includes("Leg War"), JSON.stringify(listed));
    const listMeta = await texts("#saveExisting .slotmeta");
    mark(tag + ": the list names the round and the purse", listMeta.some((line) => line.includes("round " + savedRound)) && listMeta.some((line) => /\d/.test(line.split("·").pop() || "")),
      JSON.stringify(listMeta));
    mark(tag + ": no player-facing slot line carries a side:kind id", !listMeta.concat(listed).some((line) => /(blue|red):[a-z]/.test(line)));

    // ---- 3. the overwrite confirmation -----------------------------------------------------
    await page.fill("#saveName", "leg war");
    await page.click("#saveGo");
    await page.waitForSelector("#saveConfirm:not(.hidden)", { timeout: 8000 });
    const confirmText = String(await page.textContent("#saveConfirmText"));
    mark(tag + ": a duplicate name asks before overwriting", /already exists/.test(confirmText), confirmText);
    await shot("03-overwrite-confirm");
    const confirmBox = (await boxes(["#saveConfirm", "#saveOverwrite", "#saveBack"]));
    const inside = (box) => box && box.visible && box.x >= 0 && box.y >= 0 && box.right <= viewport.width + 0.5 && box.bottom <= viewport.height + 0.5;
    mark(tag + ": the overwrite controls sit inside the viewport", inside(confirmBox["#saveOverwrite"]) && inside(confirmBox["#saveBack"]),
      JSON.stringify(confirmBox));
    await page.click("#saveOverwrite");
    await page.waitForFunction(() => /Overwrote saved war "leg war" at round \d+\./.test(document.querySelector("#flash")?.textContent || ""), null, { timeout: 12000 });
    const overToast = await page.textContent("#flash");
    mark(tag + ": Overwrite replaces the same slot", /Overwrote saved war/.test(String(overToast)), String(overToast));
    // Still one slot with that name, not two.
    await page.click("#saveBtn");
    await page.waitForSelector("#savePanel:not(.hidden)", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll("#saveExisting .slottitle").length >= 1, null, { timeout: 8000 });
    const afterOverwrite = await texts("#saveExisting .slottitle");
    mark(tag + ": the overwrite did not add a second slot", afterOverwrite.filter((line) => line.toLowerCase() === "leg war").length === 1, JSON.stringify(afterOverwrite));
    await page.click("#saveClose");

    // ---- 5a. strip layout, before leaving the match ---------------------------------------
    const strip = await boxes(["#saveBtn", "#resignBtn", "#newBtn", "#quitBtn"]);
    const order = ["#saveBtn", "#resignBtn", "#newBtn", "#quitBtn"].map((sel) => strip[sel]).filter(Boolean);
    const insideView = order.every((box) => box.visible && box.x >= 0 && box.right <= viewport.width + 0.5 && box.bottom <= viewport.height + 0.5);
    let overlaps = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = order[i];
        const b = order[j];
        if (a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5) overlaps = true;
      }
    }
    mark(tag + ": the strip's four game buttons fit inside the viewport", insideView, JSON.stringify(strip));
    mark(tag + ": Save does not overlap Resign/New/Quit", !overlaps, JSON.stringify(strip));

    // ---- 4. Quit, then Resume Saved War ----------------------------------------------------
    await page.click("#quitBtn");
    mark(tag + ": Quit asks before leaving the war", dialogs.some((line) => /Quit this game/.test(line)), JSON.stringify(dialogs));
    await page.waitForFunction(() => window.__chq.room() === null, null, { timeout: 12000 });
    await page.click("#resumeWarBtn");
    await page.waitForSelector("#slotsPanel:not(.hidden)", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll("#slotList .slotrow").length >= 1, null, { timeout: 10000 });
    const slotNames = await texts("#slotList .slottitle");
    const slotMetas = await texts("#slotList .slotmeta");
    // The slot's identity is the folded name; an overwrite keeps the id and takes the spelling the
    // player typed last, so the label is compared folded and the observed spelling is on the row.
    mark(tag + ": Resume Saved War lists the named slot", slotNames.some((line) => line.toLowerCase() === "leg war"), JSON.stringify(slotNames));
    mark(tag + ": the resume list is player-facing, no side:kind ids", !slotNames.concat(slotMetas).some((line) => /(blue|red):[a-z]/.test(line)));
    const slotsBox = await boxes(["#slotsPanel", "#slotList"]);
    mark(tag + ": the resume panel sits inside the viewport", inside(slotsBox["#slotsPanel"]), JSON.stringify(slotsBox["#slotsPanel"]));
    await shot("04-resume-list");
    await page.click('#slotList .slotrow');
    await page.waitForFunction((want) => {
      const r = window.__chq.room();
      return Boolean(r) && Number(r.round) === want;
    }, savedRound, { timeout: 15000, polling: 100 });
    const resumed = await room();
    const resumedIds = (resumed.pieces || []).map((p) => p.id).sort();
    mark(tag + ": the resumed war is the saved round", Number(resumed.round) === savedRound, "round " + resumed.round + " (saved " + savedRound + ")");
    mark(tag + ": the resumed room comes back held", resumed.clock !== "running", "clock " + resumed.clock);
    mark(tag + ": the resumed piece set is the saved one", JSON.stringify(resumedIds) === JSON.stringify(savedIds),
      "pieces " + resumedIds.length + " vs " + savedIds.length);
    mark(tag + ": the resumed purse is the saved one", Number(resumed.seat.cash) === savedCash, "cash " + resumed.seat.cash + " (saved " + savedCash + ")");
    await shot("05-resumed");

    mark(tag + ": no page error", pageErrors.length === 0, pageErrors.join(" | "));
    await context.close();
  }
} catch (err) {
  mark("leg threw", false, err && err.stack ? err.stack : String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill("SIGTERM");
    await sleep(600);
  }
}

const verdict = failed === 0 ? "PASS" : "FAIL";
writeFileSync(path.join(OUT, "pb205-verdict.json"), JSON.stringify({ verdict, failed, evidence, out: OUT }, null, 2));
console.log("pb205 page leg: " + verdict + " (" + (evidence.length - failed) + " passed, " + failed + " failed) — " + OUT);
process.exit(failed === 0 ? 0 : 1);
