// PB-332 page leg: the closed Opponent select shows the opponent's name and level only, and the
// original's behaviour note is one line UNDER the select that follows the choice (and the select's
// title), at 1440, 1280 and 1024.
//
// Why: the lobby's option text carried the config label too — "COL. BUCK ZEAL (3) - Marches; may
// repeat a destination" — so the closed control (280 px wide, 260 px of content at every width; the
// Lobby card is a fixed 320 px column) ellipsized from level 2 upward and cut the widest name
// ("NO OPPONENT - Two players, one machine: ...", 467.6 px of text) in half. Measured on 2ada057:
// widest option text 467.63 px against 260 px of content at all three widths.
//
// Arms, per width (1440x900, 1280x800, 1024x768) and per choice (levels 1-5 and "no opponent"):
//   (a)  the closed select's text is `name (level)` (the word alone for no-opponent) — the leg types
//        none of it: every expected string is derived from /api/setup's own rows;
//   (b)  that text FITS: measured at the select's own computed font, the string's width is inside
//        the select's content box, and the select is not a horizontal scroll window. This is the
//        arm the label-in-the-option defect reds (467.63 px of text in a 260 px box);
//   (c)  the note is visible for the chosen opponent, sits under the select inside the Lobby card,
//        and carries exactly that row's label;
//   (d)  the select's title carries the same note;
//   (e)  the note follows the choice: level 2 and level 5 are different sentences and the line
//        changes between them;
//   (f)  no page error.
//
// Usage:
//   node tests/e2e/pb332-opponent-note.mjs                 # starts its own server on this checkout
//   node tests/e2e/pb332-opponent-note.mjs --url=<base>     # a running server (live leg)
//   node tests/e2e/pb332-opponent-note.mjs --mutant=label    # the label put back in the option text,
//                                                           # expects RED by name
//   node tests/e2e/pb332-opponent-note.mjs --out=<dir>
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function headSha() {
  const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return out.status === 0 ? String(out.stdout || "").trim() : "";
}
const SHA = String(process.env.GATE_SHA || "").trim() || headSha();

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const MUTANT = argOf("mutant", "");
const OUT = evidenceDir("pb332-opponent-note", argOf("out"));
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
// Headroom demanded inside the select's content box, so "it fits" is not a one-pixel coincidence.
const FIT_HEADROOM_PX = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = { sha: SHA, base: GIVEN || "", mutant: MUTANT, viewports: VIEWPORTS.map((v) => v.width) };
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail).slice(0, 1200) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb332-opponent-note.json"), JSON.stringify({ ...RUN, evidence }, null, 2));
  return Boolean(ok);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

// The mutant is planted in a COPY of the tree so the checkout under test is never edited: the exact
// pre-fix option text, label and all.
function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb332-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const appPath = path.join(dir, "web", "public", "app.js");
  const before = readFileSync(appPath, "utf8");
  let after = before;
  if (kind === "label") {
    after = before.replace(
      '    option.textContent = row.name + " (" + row.level + ")";\n',
      '    option.textContent = row.name + " (" + row.level + ")" + (row.label ? " - " + row.label : ""); // mutant: the note back in the closed select\n',
    );
  } else {
    throw new Error("unknown mutant: " + kind);
  }
  if (after === before) throw new Error("the mutant could not be planted: the anchored option write moved");
  writeFileSync(appPath, after);
  return dir;
}

async function startServer(tree) {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb332-page-"));
  const child = spawn(process.execPath, ["web/server/main.mjs"], {
    cwd: tree,
    env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = "http://127.0.0.1:" + port;
  const started = Date.now();
  while (Date.now() - started < 25000) {
    try { const res = await fetch(base + "/api/version"); if (res.ok) return { child, base }; } catch { /* booting */ }
    await sleep(120);
  }
  child.kill("SIGTERM");
  throw new Error("the server did not answer /api/version within 25 s");
}

// One evaluate per viewport: the select's font, its content box, and the note's geometry. Canvas
// measureText at the select's OWN computed font is the "would this text be clipped" witness — a
// select's scrollWidth does not report overflowing option text.
const MEASURE = () => {
  const r2 = (n) => Math.round(n * 100) / 100;
  const sel = document.querySelector('#launch select[name="level"]');
  const note = document.getElementById("opponentNote");
  const card = document.getElementById("lobby");
  const cs = getComputedStyle(sel);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  const selBox = sel.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  const noteBox = note ? note.getBoundingClientRect() : null;
  const chosen = sel.selectedOptions[0] || null;
  return {
    options: [...sel.options].map((o) => o.value),
    chosen: chosen ? chosen.textContent : null,
    chosenValue: sel.value,
    chosenTextPx: chosen ? r2(ctx.measureText(chosen.textContent).width) : null,
    contentPx: r2(sel.clientWidth - padL - padR),
    selectScrollWidth: sel.scrollWidth,
    selectClientWidth: sel.clientWidth,
    font: ctx.font,
    title: sel.getAttribute("title"),
    selectBox: { left: r2(selBox.left), right: r2(selBox.right), top: r2(selBox.top), bottom: r2(selBox.bottom) },
    cardBox: { left: r2(cardBox.left), right: r2(cardBox.right) },
    note: noteBox
      ? {
        exists: true,
        text: note.textContent,
        display: getComputedStyle(note).display,
        visible: noteBox.width > 0 && noteBox.height > 0 && getComputedStyle(note).display !== "none",
        left: r2(noteBox.left), right: r2(noteBox.right), top: r2(noteBox.top), bottom: r2(noteBox.bottom),
        underSelect: noteBox.top >= selBox.bottom - 0.5,
        insideCard: noteBox.left >= cardBox.left - 0.5 && noteBox.right <= cardBox.right + 0.5,
      }
      : { exists: false },
  };
};

async function main() {
  const { chromium } = await loadPlaywright();
  let BASE = GIVEN;
  let child = null;
  if (!BASE) {
    const tree = MUTANT ? mutantTree(MUTANT) : root;
    const started = await startServer(tree);
    child = started.child;
    BASE = started.base;
    mark("a local server answers", true, BASE + " tree=" + (MUTANT ? "mutant(" + MUTANT + ")" : "the checkout"));
  }
  const setup = await (await fetch(BASE + "/api/setup")).json();
  RUN.base = BASE;
  const bot = (setup && setup.bot) || {};
  const rows = (Array.isArray(bot.opponents) ? bot.opponents : []).filter((row) => Number(row.level) >= 1);
  const none = bot.none && bot.none.value ? bot.none : null;
  // Every expected string comes from the served config, never from this file.
  const expected = rows.map((row) => ({
    value: String(row.level),
    text: String(row.name) + " (" + row.level + ")",
    label: String(row.label || ""),
  }));
  if (none) expected.push({ value: String(none.value), text: String(none.name || "NO OPPONENT"), label: String(none.label || "") });
  mark("the served setup offers the opponents this leg grades", expected.length >= 6,
    JSON.stringify(expected.map((row) => [row.value, row.text, row.label])));

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (const viewport of VIEWPORTS) {
      const at = " @" + viewport.width;
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
      const user = "p332" + viewport.width + Date.now().toString(36).slice(-5);
      await page.fill("#register input[name=username]", user);
      await page.fill("#register input[name=password]", "pb332-pass-123");
      await page.click("#register button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
      await page.waitForFunction((n) => document.querySelectorAll('#launch select[name="level"] option').length === n,
        expected.length, { timeout: 25000 });
      await sleep(250);

      const notes = [];
      for (const want of expected) {
        await page.selectOption('#launch select[name="level"]', want.value);
        await sleep(120);
        const m = await page.evaluate(MEASURE);
        notes.push({ value: want.value, note: m.note.text });
        const who = want.text;

        mark("(a) the closed select says the name and level only: " + who + at,
          m.chosen === want.text,
          JSON.stringify({ shown: m.chosen, want: want.text }));

        mark("(b) the closed select fits its whole text: " + who + at,
          m.chosenTextPx !== null && m.chosenTextPx <= m.contentPx - FIT_HEADROOM_PX &&
            m.selectScrollWidth <= m.selectClientWidth + 1,
          JSON.stringify({ textPx: m.chosenTextPx, contentPx: m.contentPx, headroom: FIT_HEADROOM_PX,
            scrollWidth: m.selectScrollWidth, clientWidth: m.selectClientWidth, font: m.font }));

        mark("(c) the note is visible under the select and carries this opponent's behaviour: " + who + at,
          Boolean(m.note.exists && m.note.visible && m.note.underSelect && m.note.insideCard) &&
            want.label.length > 0 && m.note.text === want.label,
          JSON.stringify({ note: m.note, want: want.label, selectBox: m.selectBox }));

        mark("(d) the select's title carries the same note: " + who + at,
          m.title === want.label && want.label.length > 0,
          JSON.stringify({ title: m.title, want: want.label }));
      }

      // (e) the note follows the choice: level 2 and level 5 are different sentences in this config.
      const lo = notes.find((n) => n.value === "2");
      const hi = notes.find((n) => n.value === "5");
      const loLabel = expected.find((r) => r.value === "2");
      const hiLabel = expected.find((r) => r.value === "5");
      mark("(e) the note follows the choice (level 2 vs level 5)" + at,
        Boolean(lo && hi && loLabel && hiLabel && loLabel.label !== hiLabel.label) &&
          lo.note === loLabel.label && hi.note === hiLabel.label && lo.note !== hi.note,
        JSON.stringify({ level2: lo && lo.note, level5: hi && hi.note }));

      mark("(f) no page error was raised" + at, errors.length === 0, JSON.stringify(errors.slice(0, 4)));

      await page.locator("#lobby").screenshot({ path: path.join(OUT, "lobby-" + viewport.width + ".png") });
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    if (child) child.kill("SIGTERM");
  }

  const passes = evidence.filter((e) => e.ok).length;
  console.log("");
  console.log("checks: " + evidence.length + ", passed: " + passes + ", failed: " + failed + "; sha " +
    (SHA || "unknown") + "; tree " + (MUTANT ? "mutant(" + MUTANT + ")" : (GIVEN || "the checkout")));
  if (MUTANT) {
    // A mutant is only proved by an arm going RED BY NAME: a leg that fails to boot also exits 1 and
    // that is a broken run, not a red arm.
    const redByCopy = evidence.filter((e) => !e.ok && /the closed select (says|fits)/.test(e.label));
    if (!redByCopy.length) {
      console.log("PB332_MUTANT_NOT_PROVED: the planted " + MUTANT + " red no select-name/fit arm");
      process.exit(1);
    }
    console.log("PB332_MUTANT_PROVED: " + redByCopy.length + " select arm(s) RED by name under mutant(" + MUTANT + ")");
    process.exit(0);
  }
  console.log(failed === 0 ? "PB332_OPPONENT_NOTE_OK" : "PB332_OPPONENT_NOTE_RED");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log("FAIL the leg threw — " + String((err && err.stack) || err));
  process.exit(1);
});
