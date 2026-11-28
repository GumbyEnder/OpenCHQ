// PB-327 page leg: every lobby control sits inside the Lobby card, on a fresh load and after Leave,
// at 1440, 1280 and 1024.
//
// Why: the launch form's single auto grid column was sized to its widest child's min-content, and a
// <select>'s min-content is its LONGEST option — the opponent list carries the original's five names
// with their notes. The column laid out 510 px wide inside a 282 px card, so every field of the form
// hung 209 px past the card's right edge and under the Match card. Measured on 30a4275: the card's
// scrollWidth is 528 against a 318 clientWidth in BOTH states at all three widths, so "after leaving"
// was never the trigger.
//
// Arms, per width (1440x900, 1280x800, 1024x768) and per state (fresh load, after Leave):
//   (a)  the Lobby card is not a scroll window: scrollWidth <= clientWidth + 1;
//   (b)  every control inside the card keeps its right edge inside the card's right edge (and its
//        left edge inside the card's left edge), named per control, with the overflow in px;
//   (c)  the UNION box of the launch form's children is inside the card's content box. The form's
//        own rect is NOT the arm: the form is a grid container whose box stays 282 px inside the
//        card while its children hang 209 px past it, so a check on form.right alone is green in
//        the mutant and measures nothing (frodo, room 10373 §4);
//   (d)  the two states hold the SAME control set and the same containment verdict, so a fix that
//        only works after leaving (or only on a fresh load) cannot pass.
//
// Usage: node tests/e2e/pb327-lobby-fit.mjs [--url=host] [--out=DIR]
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
const OUT = evidenceDir("pb327-lobby-fit", argOf("out"));
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 1200) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb327-lobby-fit.json"), JSON.stringify({ evidence }, null, 2));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Measured in one evaluate so the two states cannot drift apart between reads.
const MEASURE = () => {
  const r2 = (n) => Math.round(n * 100) / 100;
  const card = document.getElementById("lobby");
  const form = document.getElementById("launch");
  const cardBox = card.getBoundingClientRect();
  const formBox = form.getBoundingClientRect();
  // (c) grades the union box of the form's own children, not the form's rect: a grid container keeps
  // its box inside the card while its children overflow, so form.right alone cannot fail.
  const kids = [...form.children]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  const union = kids.length
    ? {
      left: r2(Math.min(...kids.map((r) => r.left))),
      right: r2(Math.max(...kids.map((r) => r.right))),
    }
    : null;
  const rows = [];
  const push = (key, el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    rows.push({
      key,
      left: r2(r.left), right: r2(r.right), w: r2(r.width),
      overRight: r2(r.right - cardBox.right), overLeft: r2(cardBox.left - r.left),
      inside: r.right <= cardBox.right + 0.5 && r.left >= cardBox.left - 0.5,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    });
  };
  for (const label of form.querySelectorAll(":scope > label")) {
    const field = label.querySelector("select, input");
    const name = (field && field.name) || (label.textContent || "").trim().split("\n")[0];
    push("label:" + name, label);
    push("field:" + name, field);
  }
  push("button:Play a bot", form.querySelector('button[type="submit"]'));
  push("filmsBtn", document.getElementById("filmsBtn"));
  push("resumeWarBtn", document.getElementById("resumeWarBtn"));
  push("layoutBtn", document.getElementById("layoutBtn"));
  push("people", document.getElementById("people"));
  push("invites", document.getElementById("invites"));
  return {
    card: { left: r2(cardBox.left), right: r2(cardBox.right), w: r2(cardBox.width),
      scrollWidth: card.scrollWidth, clientWidth: card.clientWidth },
    form: { left: r2(formBox.left), right: r2(formBox.right), w: r2(formBox.width),
      overRight: r2(formBox.right - cardBox.right) },
    // (c) the graded box: union of the form's children, and how far it runs past the card
    formChildren: kids.length,
    formUnion: union
      ? { left: union.left, right: union.right, w: r2(union.right - union.left),
        overRight: r2(union.right - cardBox.right), overLeft: r2(cardBox.left - union.left) }
      : { left: null, right: null, w: 0, overRight: 0, overLeft: 0 },
    bodyClass: document.body.className,
    rows,
  };
};

async function main() {
  const { chromium } = await loadPlaywright();
  let BASE = GIVEN;
  let child = null;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb327-page-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* still booting */ }
      await sleep(120);
    }
  }
  const version = await (await fetch(BASE + "/api/version")).json();
  mark("the page answers /api/version", Boolean(version && version.commit), JSON.stringify(version));

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  for (const viewport of VIEWPORTS) {
    const at = " @" + viewport.width + "x" + viewport.height;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
    const user = "p327" + viewport.width + Date.now().toString(36).slice(-5);
    await page.fill("#register input[name=username]", user);
    await page.fill("#register input[name=password]", "pb327-pass-123");
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
    await sleep(350);

    const fresh = await page.evaluate(MEASURE);
    mark("(a) fresh: the Lobby card is not a scroll window" + at,
      fresh.card.scrollWidth <= fresh.card.clientWidth + 1, JSON.stringify(fresh.card));
    for (const row of fresh.rows) {
      mark("(b) fresh: " + row.key + " sits inside the Lobby card" + at, row.inside,
        JSON.stringify({ left: row.left, right: row.right, w: row.w, overRight: row.overRight, overLeft: row.overLeft, cardRight: fresh.card.right }));
    }
    mark("(c) fresh: the launch form's children are inside the card (union box)" + at,
      fresh.formUnion.overRight <= 0.5 && fresh.formUnion.overLeft <= 0.5,
      JSON.stringify({ formUnion: fresh.formUnion, formChildren: fresh.formChildren, form: fresh.form }));

    // A real bot match, then the room's own Leave button — the route the report came in by.
    await page.selectOption('#launch select[name="era"]', "1986");
    await page.click('#launch button[type="submit"]');
    await page.waitForFunction(() => Boolean(window.__chq.room() && window.__chq.room().id), null, { timeout: 25000 });
    await sleep(300);
    const inMatch = await page.evaluate(() => ({ bodyClass: document.body.className, room: Boolean(window.__chq.room()) }));
    mark("the war opened, so the lobby really leaves the page" + at, inMatch.room && /\bin-match\b/.test(inMatch.bodyClass), JSON.stringify(inMatch));
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#room .actions button")];
      const leave = buttons.find((b) => /^Leave$/i.test((b.textContent || "").trim()));
      if (leave) leave.click();
    });
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 25000 });
    await sleep(450);

    const after = await page.evaluate(MEASURE);
    mark("(a) after Leave: the Lobby card is not a scroll window" + at,
      after.card.scrollWidth <= after.card.clientWidth + 1, JSON.stringify(after.card));
    for (const row of after.rows) {
      mark("(b) after Leave: " + row.key + " sits inside the Lobby card" + at, row.inside,
        JSON.stringify({ left: row.left, right: row.right, w: row.w, overRight: row.overRight, overLeft: row.overLeft, cardRight: after.card.right }));
    }
    mark("(c) after Leave: the launch form's children are inside the card (union box)" + at,
      after.formUnion.overRight <= 0.5 && after.formUnion.overLeft <= 0.5,
      JSON.stringify({ formUnion: after.formUnion, formChildren: after.formChildren, form: after.form }));
    mark("(d) the two states hold the same controls" + at,
      JSON.stringify(fresh.rows.map((r) => r.key)) === JSON.stringify(after.rows.map((r) => r.key)),
      JSON.stringify({ fresh: fresh.rows.map((r) => r.key), after: after.rows.map((r) => r.key) }));
    mark("(d) the two states agree on containment" + at,
      JSON.stringify(fresh.rows.filter((r) => !r.inside).map((r) => r.key)) === JSON.stringify(after.rows.filter((r) => !r.inside).map((r) => r.key)),
      JSON.stringify({ fresh: fresh.rows.filter((r) => !r.inside).map((r) => r.key), after: after.rows.filter((r) => !r.inside).map((r) => r.key) }));
    mark("no page error was raised" + at, errors.length === 0, JSON.stringify(errors.slice(0, 4)));
    await context.close();
  }
  await browser.close();
  if (child) child.kill("SIGTERM");

  console.log("");
  console.log("checks: " + evidence.length + ", failed: " + failed);
  console.log(failed === 0 ? "PB327_LOBBY_OK" : "PB327_LOBBY_RED");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log("FAIL the leg threw — " + String((err && err.stack) || err));
  process.exit(1);
});
