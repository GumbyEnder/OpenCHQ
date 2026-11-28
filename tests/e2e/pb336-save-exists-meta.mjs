// PB-336 page leg: the saveNow `data.exists` branch reaches the SAME confirm a row click reaches,
// through a real page, a real socket and a real server.
//
//   node tests/e2e/pb336-save-exists-meta.mjs                # starts its own server
//   node tests/e2e/pb336-save-exists-meta.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb336-save-exists-meta.mjs --out=<dir>
//
// The defect: the client's duplicate pre-check compares the trimmed title lowercase, so an internal
// double space (or a tab) misses the painted row and posts to /api/slots. The server's cleanSlotName
// collapses whitespace, so the answer comes back `exists:true` with the slot's id - and that branch
// used to compose its OWN sentence, with no parenthetical meta and the raw typed spelling quoted
// back at the player. Two sentences for one decision is the bug.
//
// Per viewport:
//   (a) typing "Front  Line" (two spaces) against a saved "Front Line" opens the overwrite confirm,
//       and its sentence is the ROW-CLICK sentence character for character (captured first);
//   (b) that sentence carries the row's meta line, in the same parenthetical the producer uses, and
//       names the STORED title - the typed double-space spelling appears nowhere in the confirm;
//   (c) the name field holds the stored title, so confirming overwrites the one slot: the list's
//       count does not change and the slot keeps its id (AC (b) of PB-326 stays intact);
//   (d) no raw slot id reaches the confirm or the name field; 0 page errors.
//
// The mutant (the old free-standing sentence restored in the exists branch) reds (a), (b) and (c)
// by name.

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
const OUT = evidenceDir("pb336-save-exists-meta", argOf("out"));
const TITLE = "Front Line";
const TYPED = "Front  Line"; // two spaces: the client pre-check misses, the server folds
const OLD = 'A saved war named "' + TYPED + '" already exists. Overwrite it with this round?';
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
  writeFileSync(path.join(OUT, "pb336-leg.json"), JSON.stringify({ evidence }, null, 2));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb336-e2e-"));
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
    const confirmState = () => page.evaluate(() => ({
      open: !document.getElementById("saveConfirm").classList.contains("hidden"),
      text: String(document.getElementById("saveConfirmText").textContent || ""),
      name: String(document.getElementById("saveName").value || ""),
    }));
    const rowMeta = () => page.evaluate(() => String(
      document.querySelector("#saveExisting .slotrow .slotmeta")?.textContent || ""));
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
      await page.screenshot({ path: path.join(OUT, "pb336-" + tag + "-" + name + ".png") });
    }
    // A confirm that never opens must FAIL BY NAME, not throw the leg away: that is the mutant.
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

    // ---- sign up, open a 1986 bot match, play a round, hold ---------------------------------
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const user = "pb336-" + tag + "-" + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", user);
    await page.fill("#register input[name=password]", "pw-" + user);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click("#launch button[type=submit]");
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().mode === "bot", null, { timeout: 30000, polling: 100 });
    for (let i = 0; i < 5; i += 1) await page.click("#speedUp");
    if (await page.evaluate(() => window.__chq.room()?.clock !== "running")) await page.click("#clockBtn");
    await page.waitForFunction(() => window.__chq.room() && Number(window.__chq.room().round) >= 1, null, { timeout: 30000, polling: 100 }).catch(() => {});
    if (await page.evaluate(() => window.__chq.room()?.clock === "running")) {
      await page.click("#clockBtn");
      await page.waitForFunction(() => window.__chq.room() && window.__chq.room().clock !== "running", null, { timeout: 10000 }).catch(() => {});
    }
    const liveRound = await page.evaluate(() => Number(window.__chq.room()?.round));
    mark(tag + ": a bot war is held at a real round before the save", liveRound >= 1, "round " + liveRound);

    // ---- save one war ----------------------------------------------------------------------
    await openSave(false);
    await page.fill("#saveName", TITLE);
    await page.click("#saveGo");
    await page.waitForFunction((want) => (document.getElementById("flash")?.textContent || "").includes(want), 'Saved war "Front Line"', { timeout: 12000 });
    mark(tag + ": the war is saved under a name", /Saved war "Front Line"/.test(await flash()), await flash());
    await page.evaluate(() => document.getElementById("saveClose")?.click());
    await sleep(150);

    // ---- capture the ROW-CLICK sentence first, so the typed path cannot grade itself --------
    await openSave();
    const meta = await rowMeta();
    await page.click("#saveExisting .slotrow");
    const rowConfirm = await grabConfirm();
    mark(tag + ": a row click opens the overwrite confirm (control)", rowConfirm.open === true, JSON.stringify(rowConfirm));
    mark(tag + ": the row-click sentence carries the row's meta line (control)",
      rowConfirm.text.includes("(" + meta + ")") && rowConfirm.name === TITLE,
      JSON.stringify({ meta, text: rowConfirm.text, name: rowConfirm.name }));
    await shot("01-row-confirm");
    await dismiss();

    // ---- (a) the typed double-space title reaches the same confirm -------------------------
    const before = await slots();
    const idBefore = before.length === 1 ? before[0].id : null;
    await page.fill("#saveName", TYPED);
    await page.click("#saveGo");
    const folded = await grabConfirm();
    mark(tag + ": a typed double-space title opens the overwrite confirm (AC a)", folded.open === true,
      JSON.stringify(folded));
    mark(tag + ": the exists branch's confirm is the row-click confirm (AC a)",
      folded.open && folded.text === rowConfirm.text,
      JSON.stringify({ rowClick: rowConfirm.text, typedDoubleSpace: folded.text }));
    await shot("02-typed-confirm");

    // ---- (b) stored title + the meta line, never the raw typed spelling --------------------
    mark(tag + ": the confirm carries the row's meta line (AC a)", folded.open && folded.text.includes("(" + meta + ")"),
      JSON.stringify({ meta, text: folded.text }));
    mark(tag + ": the confirm names the stored title, not the typed spelling (AC a)",
      folded.open && folded.text.includes('"' + TITLE + '"') && !folded.text.includes(TYPED),
      JSON.stringify({ text: folded.text, typed: TYPED }));
    mark(tag + ": the confirm is not the old free-standing sentence (AC a)",
      folded.open && folded.text !== OLD && /already exists \([^)]+\)\. Overwrite it with this round\?$/.test(folded.text),
      JSON.stringify({ text: folded.text, old: OLD }));
    mark(tag + ": the title field holds the stored title (AC a)", folded.open && folded.name === TITLE,
      JSON.stringify({ name: folded.name }));

    // ---- (c) confirming overwrites the ONE folded slot ------------------------------------
    if (folded.open) {
      await page.click("#saveOverwrite");
      await page.waitForFunction((want) => (document.getElementById("flash")?.textContent || "").includes(want), 'Overwrote saved war "Front Line"', { timeout: 12000 }).catch(() => {});
    }
    mark(tag + ": confirming overwrites the folded slot (AC b)", folded.open && /Overwrote saved war "Front Line"/.test(await flash()),
      JSON.stringify({ open: folded.open, flash: await flash() }));
    await page.evaluate(() => document.getElementById("saveClose")?.click());
    await sleep(150);
    await openSave();
    const after = await slots();
    mark(tag + ": the folded name still overwrites one slot, not two (AC b)",
      after.length === 1 && after[0].id === idBefore && after[0].name === TITLE,
      JSON.stringify({ count: after.length, id: after[0] && after[0].id, was: idBefore, name: after[0] && after[0].name }));

    // ---- (d) no raw ids on screen ----------------------------------------------------------
    const ids = after.map((slot) => slot.id).filter(Boolean);
    const visible = [folded.text, folded.name];
    mark(tag + ": no raw slot id reaches the confirm or the name field (AC d)",
      ids.length > 0 && ids.every((id) => visible.every((line) => !line.includes(id))),
      JSON.stringify({ ids, visible }));

    mark(tag + ": no page error", pageErrors.length === 0, pageErrors.join(" | "));
    await shot("03-after-overwrite");
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
writeFileSync(path.join(OUT, "pb336-verdict.json"), JSON.stringify({ verdict, failed, evidence, out: OUT, base: BASE }, null, 2));
console.log("pb336 page leg: " + verdict + " (" + (evidence.length - failed) + " passed, " + failed + " failed) — " + OUT);
console.log(failed === 0 ? "PB336_SAVE_EXISTS_OK" : "PB336_SAVE_EXISTS_RED");
process.exit(failed === 0 ? 0 : 1);
