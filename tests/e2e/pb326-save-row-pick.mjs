// PB-326 page leg: a Save Game row is the Overwrite picker (manual p.36 l.1143), through a real page,
// a real socket and a real server at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb326-save-row-pick.mjs                # starts its own server
//   node tests/e2e/pb326-save-row-pick.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb326-save-row-pick.mjs --out=<dir>
//
// The defect: the list under the Save form was painted as static rows (`li.slotrow.static`,
// cursor: default, no handler), so the only path to an overwrite was retyping the title. Per viewport:
//   (a) clicking a saved row fills the title field with that row's title and opens the SAME confirm a
//       typed duplicate reaches — the two sentences are compared character for character, and the
//       typed one is captured first so the row path cannot be graded against itself;
//   (b) Cancel (the confirm's "Keep the name") leaves the save untouched: the slot's savedAt and round
//       do not move, and nothing is written; then Overwrite replaces that one save — the list's count
//       does not change and the slot keeps its id;
//   (c) the row is a real control: pointer cursor, focusable, and Enter and Space each open the
//       confirm with the row's title;
//   (d) no raw slot id appears in the row, the confirm or the title field;
//   (e) 0 page errors, and the confirm's buttons sit inside the viewport at both widths.
//
// The mutant (the row's click handler removed) reds arm (a) by name.

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
const OUT = evidenceDir("pb326-save-row-pick", argOf("out"));
const TITLE = "Front Line";
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + String(detail).slice(0, 400) : ""));
  writeFileSync(path.join(OUT, "pb326-leg.json"), JSON.stringify({ evidence }, null, 2));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb326-e2e-"));
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
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    const tag = viewport.width + "x" + viewport.height;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    const slots = () => page.evaluate(async () => {
      const res = await fetch("/api/slots", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      return Array.isArray(data.slots) ? data.slots : [];
    });
    const rows = () => page.evaluate(() => [...document.querySelectorAll("#saveExisting .slotrow")].map((el) => ({
      tag: el.tagName, type: el.getAttribute("type"), className: el.className,
      text: String(el.innerText || el.textContent || "").trim(),
      title: String(el.querySelector(".slottitle")?.textContent || ""),
      cursor: getComputedStyle(el).cursor,
      focusable: el.tabIndex >= 0,
    })));
    const confirmState = () => page.evaluate(() => ({
      open: !document.getElementById("saveConfirm").classList.contains("hidden"),
      text: String(document.getElementById("saveConfirmText").textContent || ""),
      name: String(document.getElementById("saveName").value || ""),
    }));
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
    const flash = () => page.evaluate(() => String(document.getElementById("flash")?.textContent || ""));

    async function openSave(wantRow = true) {
      await page.click("#saveBtn");
      await page.waitForSelector("#savePanel:not(.hidden)", { timeout: 8000 });
      if (wantRow) {
        await page.waitForFunction(() => document.querySelectorAll("#saveExisting .slotrow").length >= 1, null, { timeout: 10000 });
      } else {
        await sleep(400);
      }
    }
    async function shot(name) {
      await page.screenshot({ path: path.join(OUT, "pb326-" + tag + "-" + name + ".png") });
    }

    // ---- sign up, open a 1986 bot match, play a round, hold -----------------------------------
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const user = "pb326-" + tag + "-" + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", user);
    await page.fill("#register input[name=password]", "pw-" + user);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
    for (let i = 0; i < 5; i += 1) await page.click("#speedUp");
    // A fresh room is held; the clock button runs it (the same press a player makes), then holds it.
    if (await page.evaluate(() => window.__chq.room()?.clock !== "running")) await page.click("#clockBtn");
    await page.waitForFunction(() => window.__chq.room() && Number(window.__chq.room().round) >= 1, null, { timeout: 30000, polling: 100 }).catch(() => {});
    if (await page.evaluate(() => window.__chq.room()?.clock === "running")) {
      await page.click("#clockBtn");
      await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock !== "running", null, { timeout: 10000 }).catch(() => {});
    }
    const liveRound = await page.evaluate(() => Number(window.__chq.room()?.round));
    mark(tag + ": a bot war is held at a real round before the save", liveRound >= 1,
      "round " + liveRound);

    // ---- save one war -----------------------------------------------------------------------
    await openSave(false);
    await page.fill("#saveName", TITLE);
    await page.click("#saveGo");
    await page.waitForFunction(() => /Saved war "Front Line" at round \d+\./.test(document.getElementById("flash")?.textContent || ""), null, { timeout: 12000 });
    mark(tag + ": the war is saved under a name", /Saved war/.test(await flash()), await flash());

    // ---- (c) the row is a control -----------------------------------------------------------
    await openSave();
    const painted = await rows();
    mark(tag + ": the saved row is a button, not a printed line", painted.length === 1 && painted[0].tag === "BUTTON" && painted[0].type === "button",
      JSON.stringify(painted));
    mark(tag + ": the saved row shows the pointer cursor (AC c)", painted.length === 1 && painted[0].cursor === "pointer",
      JSON.stringify(painted.map((row) => row.cursor)));
    mark(tag + ": the saved row can take focus (AC c)", painted.length === 1 && painted[0].focusable === true,
      JSON.stringify(painted.map((row) => row.focusable)));
    const rowTitle = painted.length === 1 ? painted[0].title : "";
    mark(tag + ": the row's text is its title", rowTitle === TITLE, JSON.stringify(rowTitle));
    await shot("01-rows");

    // ---- capture the typed-duplicate sentence FIRST -----------------------------------------
    await page.fill("#saveName", "front line");
    await page.click("#saveGo");
    await page.waitForSelector("#saveConfirm:not(.hidden)", { timeout: 8000 });
    const typed = await confirmState();
    mark(tag + ": a typed duplicate opens the overwrite confirm", typed.open && /already exists/.test(typed.text), JSON.stringify(typed));
    await shot("02-typed-confirm");
    await page.click("#saveBack");
    await page.waitForFunction(() => document.getElementById("saveConfirm").classList.contains("hidden"), null, { timeout: 6000 });

    // A row click that never opens the confirm must FAIL BY NAME, not throw the leg away: the mutant
    // for this card is exactly that state, and a stack trace would hide which arm went red.
    const grabConfirm = async (ms = 5000) => {
      try {
        await page.waitForSelector("#saveConfirm:not(.hidden)", { timeout: ms });
      } catch { /* graded by the caller */ }
      return confirmState();
    };
    const dismiss = async () => {
      if ((await confirmState()).open) {
        await page.click("#saveBack");
        await page.waitForFunction(() => document.getElementById("saveConfirm").classList.contains("hidden"), null, { timeout: 6000 }).catch(() => {});
      }
    };

    // ---- (a) the row click reaches the same confirm -----------------------------------------
    const before = await slots();
    const savedAtBefore = before.length === 1 ? before[0].savedAt : null;
    const roundBefore = before.length === 1 ? before[0].round : null;
    await page.click("#saveExisting .slotrow");
    const picked = await grabConfirm();
    mark(tag + ": clicking a row fills the title field with the row's title (AC a)", picked.name === rowTitle && picked.name === TITLE,
      JSON.stringify({ name: picked.name, rowTitle }));
    mark(tag + ": clicking a row opens the overwrite confirm (AC a)", picked.open === true, JSON.stringify(picked));
    mark(tag + ": the row's confirm is the typed duplicate's confirm (AC a)", picked.open && picked.text === typed.text,
      JSON.stringify({ typed: typed.text, picked: picked.text }));
    await shot("03-row-confirm");

    // ---- (b) Cancel leaves the save untouched -----------------------------------------------
    await dismiss();
    const stillOpen = await page.evaluate(() => !document.getElementById("savePanel").classList.contains("hidden"));
    const afterCancel = await slots();
    mark(tag + ": Cancel writes nothing (AC b)", afterCancel.length === 1 && afterCancel[0].savedAt === savedAtBefore && afterCancel[0].round === roundBefore,
      JSON.stringify({ count: afterCancel.length, savedAt: afterCancel[0] && afterCancel[0].savedAt, was: savedAtBefore }));
    mark(tag + ": Cancel returns the player to the list, not a closed panel", stillOpen === true && afterCancel.length === 1,
      JSON.stringify({ panelOpen: stillOpen, count: afterCancel.length }));

    // ---- (c) Enter and Space open the confirm ----------------------------------------------
    await page.evaluate(() => document.querySelector("#saveExisting .slotrow").focus());
    await page.keyboard.press("Enter");
    const viaEnter = await grabConfirm();
    mark(tag + ": Enter on the row opens the confirm (AC c)", viaEnter.open && viaEnter.name === TITLE, JSON.stringify(viaEnter));
    await dismiss();
    await page.evaluate(() => document.querySelector("#saveExisting .slotrow").focus());
    await page.keyboard.press("Space");
    const viaSpace = await grabConfirm();
    mark(tag + ": Space on the row opens the confirm (AC c)", viaSpace.open && viaSpace.name === TITLE, JSON.stringify(viaSpace));
    await shot("04-keyboard-confirm");

    // ---- (b) Overwrite replaces that one save -----------------------------------------------
    const idBefore = afterCancel.length === 1 ? afterCancel[0].id : null;
    const armed = viaSpace.open;
    if (armed) {
      await page.click("#saveOverwrite");
      await page.waitForFunction(() => /Overwrote saved war "Front Line" at round \d+\./.test(document.getElementById("flash")?.textContent || ""), null, { timeout: 12000 }).catch(() => {});
    }
    mark(tag + ": confirming overwrites that one save (AC b)", armed && /Overwrote saved war/.test(await flash()),
      JSON.stringify({ armed, flash: await flash() }));
    // The panel stays open on the list after a cancel, so close it before the strip's button.
    await page.evaluate(() => document.getElementById("saveClose")?.click());
    await sleep(200);
    await openSave();
    const afterOverwrite = await slots();
    const repainted = await rows();
    mark(tag + ": the list's count does not change (AC b)", afterOverwrite.length === 1 && repainted.length === 1,
      JSON.stringify({ slots: afterOverwrite.length, rows: repainted.length }));
    mark(tag + ": the overwrite kept the slot's identity (AC b)", afterOverwrite.length === 1 && afterOverwrite[0].id === idBefore,
      JSON.stringify({ id: afterOverwrite[0] && afterOverwrite[0].id, was: idBefore }));

    // ---- (d) no raw ids on screen -----------------------------------------------------------
    const ids = afterOverwrite.map((slot) => slot.id);
    const visible = [
      ...repainted.map((row) => row.text),
      String(await page.textContent("#saveConfirmText")),
      String(await page.inputValue("#saveName")),
    ];
    mark(tag + ": no raw slot id reaches the row or the confirm (AC d)",
      ids.every((id) => id && visible.every((line) => !line.includes(id))), JSON.stringify({ ids, visible }));

    // ---- (e) the confirm fits both widths ---------------------------------------------------
    await page.click("#saveExisting .slotrow");
    const forFit = await grabConfirm();
    const box = await boxes(["#saveConfirm", "#saveOverwrite", "#saveBack"]);
    const inside = (b) => b && b.visible && b.x >= 0 && b.y >= 0 && b.right <= viewport.width + 0.5 && b.bottom <= viewport.height + 0.5;
    mark(tag + ": the confirm's buttons sit inside the viewport", forFit.open && inside(box["#saveOverwrite"]) && inside(box["#saveBack"]),
      JSON.stringify({ open: forFit.open, box }));
    await shot("05-overwritten");
    await page.evaluate(() => document.getElementById("saveClose")?.click());

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
writeFileSync(path.join(OUT, "pb326-verdict.json"), JSON.stringify({ verdict, failed, evidence, out: OUT, base: BASE }, null, 2));
console.log("pb326 page leg: " + verdict + " (" + (evidence.length - failed) + " passed, " + failed + " failed) — " + OUT);
console.log(failed === 0 ? "PB326_SAVE_ROW_OK" : "PB326_SAVE_ROW_RED");
process.exit(failed === 0 ? 0 : 1);
