// PB-339 page leg: a refused sign-in names itself INSIDE the Sign in form, under the password field,
// in the page's own copy of the sentence — at 1024, 1280 and 1440 — and the line lives until the
// next submit or edit, not for the toast's six seconds.
//
//   node tests/e2e/pb339-signin-inline.mjs                 # starts its own server from this tree
//   node tests/e2e/pb339-signin-inline.mjs --url=<base>    # a running server
//   node tests/e2e/pb339-signin-inline.mjs --out=<dir>
//
// The defect (PM 10508 §2): a failed sign-in showed only the bottom toast ("Those credentials did
// not match."). The player is looking at the two fields they just typed into, so the words move into
// the form; the toast may stay and does.
//
// Per width (1024x768, 1280x800, 1440x900), one browser context, in this order:
//   (a) a wrong password paints #loginProblem with EXACTLY the producer's sentence, laid out under
//       the password input and above the submit button, inside the form's own box;
//   (a2) after 6.4 s the toast (#flash) is empty and the line is STILL painted — the toast's timer
//       must not decide how long the player gets to read it;
//   (c) the painted text is the shared sentence: no field id ("username"/"password"), no raw server
//       body, no "undefined"/"null"/"Error";
//   (d) the card holds it: the line does not clip and the document does not scroll sideways;
//   (b-edit) typing one character into the name field clears the line and its text;
//   (a3) the next submit paints it again — the clear is not a one-shot;
//   (b-success) the correct password signs in and clears the line;
//   (e) no page errors.
//
// Mutants this leg is the grader for: M1 removes the <p> line (every (a) check reds by name); M2
// drops the input listeners (b-edit reds by name).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb339-signin-inline", argOf("out"));

const SENTENCE = "Those credentials did not match.";
const PASSWORD = "pb339-right-pass";
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;
const evidence = [];
let failed = 0;

function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 1400) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 400)));
  writeFileSync(path.join(OUT, "pb339-signin-inline.json"), JSON.stringify({ sentence: SENTENCE, evidence }, null, 2));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

// One frame: where the line is, what it says, and whether anything overflows.
const snapshot = (page) => page.evaluate(() => {
  const rr = (n) => Math.round(n * 100) / 100;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: rr(r.x), y: rr(r.y), right: rr(r.right), bottom: rr(r.bottom), w: rr(r.width), h: rr(r.height) }; };
  const form = document.getElementById("login");
  const problem = document.getElementById("loginProblem");
  const pw = form ? form.querySelector('input[name="password"]') : null;
  const button = form ? form.querySelector('button[type="submit"]') : null;
  const card = form ? form.closest(".panel") : null;
  const flash = document.getElementById("flash");
  if (!form || !pw || !button || !card) return { missing: "form" };
  if (!problem) return { missing: "line", form: box(form), card: box(card), password: box(pw), button: box(button) };
  const cs = getComputedStyle(problem);
  return {
    text: String(problem.textContent || ""),
    hidden: problem.hidden,
    display: cs.display,
    visibility: cs.visibility,
    visible: !problem.hidden && cs.display !== "none" && cs.visibility !== "hidden" && problem.getBoundingClientRect().width > 0,
    problem: box(problem),
    password: box(pw),
    button: box(button),
    form: box(form),
    card: box(card),
    problemScrollWidth: problem.scrollWidth,
    problemClientWidth: problem.clientWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    gate: box(document.getElementById("gate")),
    innerWidth: window.innerWidth,
    flash: flash ? String(flash.textContent || "") : "",
  };
});

const serve = async (page) => page.waitForFunction(() => {
  const p = document.getElementById("loginProblem");
  return p && !p.hidden && String(p.textContent || "").trim().length > 0;
}, null, { timeout: 15000, polling: 60 }).catch(() => {});

const cleared = async (page) => page.waitForFunction(() => {
  const p = document.getElementById("loginProblem");
  return !p || (p.hidden && !String(p.textContent || "").trim());
}, null, { timeout: 15000, polling: 60 }).catch(() => {});

let BASE = GIVEN;
let child = null;

async function main() {
  const { chromium } = await loadPlaywright();
  if (!BASE) {
    const port = await freePort();
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        OPENCHQ_WEB_HOST: "127.0.0.1",
        OPENCHQ_WEB_PORT: String(port),
        OPENCHQ_WEB_DATA: mkdtempSync(path.join(tmpdir(), "pb339-")),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* booting */ }
      await sleep(120);
    }
  }
  console.log("served", (await (await fetch(BASE + "/api/version")).text()).trim());
  // The 2026-11-28 rule: a leg must prove the server it grades is THIS tree. /api/version reads a
  // committed build stamp that is expected to predate HEAD, so the proof is byte identity of the
  // served app.js against the file on disk.
  const digest = (buf) => createHash("md5").update(buf).digest("hex");
  const treeDigest = digest(readFileSync(path.join(root, "web", "public", "app.js")));
  const servedDigest = digest(Buffer.from(await (await fetch(BASE + "/app.js")).arrayBuffer()));
  mark("PB339 port: the server serves this tree's app.js", treeDigest === servedDigest,
    JSON.stringify({ treeDigest, servedDigest }));
  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  for (const viewport of VIEWPORTS) {
    const at = " @" + viewport.width + "x" + viewport.height;
    const tag = "P39" + Date.now().toString(36).slice(-5) + viewport.width;
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    // Register, then sign out: the failure has to be a real sign-in against a real account.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    await page.fill("#register input[name=username]", tag);
    await page.fill("#register input[name=password]", PASSWORD);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForFunction(() => {
      const play = document.getElementById("play");
      const gate = document.getElementById("gate");
      return play && gate && play.classList.contains("hidden") && !gate.classList.contains("hidden");
    }, null, { timeout: 30000 });

    // (a) a wrong password paints the line inside the form, under the password field.
    await page.fill("#login input[name=username]", tag);
    await page.fill("#login input[name=password]", "wrong-" + PASSWORD);
    await page.click("#login button[type=submit]");
    await serve(page);
    let snap = await snapshot(page);
    const laidOut = Boolean(snap) && !snap.missing && snap.visible &&
      snap.problem.y >= snap.password.bottom - 0.51 &&
      snap.problem.bottom <= snap.button.y + 0.51 &&
      snap.problem.x >= snap.form.x - 0.51 && snap.problem.right <= snap.form.right + 0.51;
    mark("PB339 (a)" + at + ": the refusal is painted inside the form, under the password field",
      laidOut && snap.text === SENTENCE,
      JSON.stringify({ text: snap && snap.text, problem: snap && snap.problem, password: snap && snap.password,
        button: snap && snap.button, form: snap && snap.form, missing: snap && snap.missing }));
    await page.screenshot({ path: path.join(OUT, "pb339-" + viewport.width + "-refused.png"),
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } });

    // (a2) it outlives the toast: #flash empties at 6 s, the line does not move.
    await sleep(6400);
    snap = await snapshot(page);
    mark("PB339 (a2)" + at + ": the line outlives the 6 s toast instead of clearing with it",
      Boolean(snap) && !snap.missing && snap.visible && snap.text === SENTENCE && snap.flash === "",
      JSON.stringify({ visible: snap && snap.visible, text: snap && snap.text, flash: snap && snap.flash }));

    // (c) no field id, no raw server text, nothing invented.
    const dirty = /username|password|name=|undefined|null|Error|status|[<>]/i.exec(snap ? snap.text : "");
    mark("PB339 (c)" + at + ": the line carries no field id and no raw server text",
      Boolean(snap) && !snap.missing && snap.text === SENTENCE && !dirty,
      JSON.stringify({ text: snap && snap.text, dirty: dirty && dirty[0] }));

    // (d) the card holds it at this width, and nothing scrolls sideways.
    const fits = Boolean(snap) && !snap.missing &&
      snap.problemScrollWidth <= snap.problemClientWidth + 1 &&
      snap.problem.right <= snap.card.right + 0.51 &&
      snap.docScrollWidth <= snap.innerWidth &&
      snap.gate.right <= snap.innerWidth + 0.51;
    mark("PB339 (d)" + at + ": the card holds the line with no overflow",
      fits,
      JSON.stringify({ problem: snap && { scrollWidth: snap.problemScrollWidth, clientWidth: snap.problemClientWidth, right: snap.problem && snap.problem.right },
        cardRight: snap && snap.card && snap.card.right, docScrollWidth: snap && snap.docScrollWidth,
        innerWidth: snap && snap.innerWidth, gateRight: snap && snap.gate && snap.gate.right }));

    // (b-edit) one keystroke in the name field clears the line, text and all.
    await page.type("#login input[name=username]", "x");
    await cleared(page);
    snap = await snapshot(page);
    mark("PB339 (b-edit)" + at + ": editing a field clears the line",
      Boolean(snap) && !snap.missing && !snap.visible && String(snap.text || "").trim() === "",
      JSON.stringify({ visible: snap && snap.visible, text: snap && snap.text }));

    // (a3) the next submit paints it again — the clear is not a one-shot.
    await page.click("#login button[type=submit]");
    await serve(page);
    snap = await snapshot(page);
    mark("PB339 (a3)" + at + ": the next submit paints the line again",
      Boolean(snap) && !snap.missing && snap.visible && snap.text === SENTENCE,
      JSON.stringify({ visible: snap && snap.visible, text: snap && snap.text }));

    // (b-success) the correct password signs in and clears the line.
    await page.fill("#login input[name=username]", tag);
    await page.fill("#login input[name=password]", PASSWORD);
    await page.click("#login button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    await cleared(page);
    snap = await snapshot(page);
    mark("PB339 (b-success)" + at + ": a successful sign-in clears the line",
      Boolean(snap) && !snap.missing && !snap.visible && String(snap.text || "").trim() === "" && snap.flash !== SENTENCE,
      JSON.stringify({ visible: snap && snap.visible, text: snap && snap.text, flash: snap && snap.flash }));

    // (e) no page errors on the whole course.
    mark("PB339 (e)" + at + ": no page error",
      errors.length === 0, JSON.stringify(errors));

    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");
  const passed = evidence.length - failed;
  console.log("pb339 page leg: " + passed + " passed / " + failed + " failed; evidence " + OUT);
  if (failed > 0) {
    console.log("PB339_INLINE_RED");
    process.exit(1);
  }
  console.log("PB339_INLINE_OK");
}

main().catch((err) => {
  if (child) child.kill("SIGTERM");
  console.error(err && err.stack ? err.stack : err);
  console.log("PB339_INLINE_RED");
  process.exit(1);
});
