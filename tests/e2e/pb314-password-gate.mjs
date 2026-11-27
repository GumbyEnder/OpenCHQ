// PB-314 page leg: the Change-password disclosure is a session control, at 1280x800 AND 1024x768.
//
//   node tests/e2e/pb314-password-gate.mjs                # starts its own server from this tree
//   node tests/e2e/pb314-password-gate.mjs --url=<base>   # a running server (the shipped build)
//   node tests/e2e/pb314-password-gate.mjs --out=<dir>
//
// Filed from the PM's 06:59 ET sweep on live 0b98752 (PM 10120, card §2): signed out, the masthead's
// "Change password" disclosure painted at the top right of the gate at both widths. The control is
// inert — POST /api/password without a session answers 401 "Sign in first." — so this is page
// hygiene, not a security finding, and the fix must not delete the feature to hide it.
//
// Per viewport, in one browser context, in this order:
//   1. FIRST PAINT, signed out: #passwordBox has no layout box, computed display none, and no point
//      over the masthead hit-tests to it or its summary (opacity/z-index/translate cheats pass a
//      class read and still take clicks, so the geometry and the hit-test are the assertion);
//   2. register -> signed-in LOBBY: the disclosure IS laid out and its summary owns its own centre,
//      and a real click opens the form (the counter-arm: a fix that hides it always fails here);
//   3. wrong current password -> #flash = "That is not the current password." (db.mjs:146 — the
//      change form's sentence, NOT the login path's "Those credentials did not match.");
//   4. correct current password -> #flash STARTS WITH "Password changed." (a second session appends
//      " N other session(s) ended.", so equality would be the wrong assertion);
//   5. a REAL click on Sign out (no force:true) — with window.__pb314Marker set and framenavigated
//      counted — returns the gate and hides the disclosure again with NO reload (AC (c));
//   6. the old password is refused by the LOGIN form ("Those credentials did not match.") and the
//      new one signs in, so AC (b)'s "new pw works" is the same course, not a second fixture;
//   7. no page errors at either width.
//
// The signed-in half is what makes a blunt `display: none` fail (card §4.4). M1 (§4.6) — forcing the
// box visible while signed out — must turn checks 1 red at both widths and leave 2-6 green.

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
const OUT = evidenceDir("pb314-password-gate", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const OLD_PW = "old-" + "pb314-pass"; // >= 8 chars, the server's floor
const NEW_PW = "new-" + "pb314-pass";
const WRONG_CURRENT = "That is not the current password.";
const WRONG_LOGIN = "Those credentials did not match.";
const CHANGED_PREFIX = "Password changed.";

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
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb314-e2e-"));
let server = null;
let browser = null;
let BASE = GIVEN;
let VERSION = null;

// Everything the geometry and hit-test arms read, measured in the page: one evaluate, so the two
// arms cannot disagree about which state they saw.
const MEASURE = () => {
  const box = document.getElementById("passwordBox");
  const summary = box ? box.querySelector("summary") : null;
  const gate = document.getElementById("gate");
  const play = document.getElementById("play");
  const account = document.getElementById("account");
  const cs = box ? getComputedStyle(box) : null;
  const r = box ? box.getBoundingClientRect() : null;
  const vis = (el) => Boolean(el) && !el.classList.contains("hidden") && getComputedStyle(el).display !== "none";
  const hits = [];
  if (box) {
    const top = Math.min(240, Math.round(Math.max(0, (r && r.height ? r.bottom : 0) + 40)) || 96);
    for (let y = 4; y < top; y += 8) {
      for (let x = 2; x < document.documentElement.clientWidth; x += 16) {
        const at = document.elementFromPoint(x, y);
        if (at && (at === box || box.contains(at))) hits.push([x, y, at.id || at.className || at.tagName]);
      }
    }
  }
  let summaryHit = null;
  if (summary && r && r.width > 0 && r.height > 0) {
    const sr = summary.getBoundingClientRect();
    const at = document.elementFromPoint(Math.round(sr.left + sr.width / 2), Math.round(sr.top + sr.height / 2));
    summaryHit = { at: at ? (at.id || at.className || at.tagName) : "none", self: Boolean(at && (at === summary || summary.contains(at))) };
  }
  return {
    boxPresent: Boolean(box),
    className: box ? box.className : null,
    display: cs ? cs.display : null,
    visibility: cs ? cs.visibility : null,
    opacity: cs ? cs.opacity : null,
    width: r ? Math.round(r.width * 10) / 10 : null,
    height: r ? Math.round(r.height * 10) / 10 : null,
    left: r ? Math.round(r.left) : null,
    top: r ? Math.round(r.top) : null,
    clientRects: box ? box.getClientRects().length : 0,
    hitsOverMasthead: hits.length,
    firstHit: hits.length ? hits[0] : null,
    summaryHit,
    gateShown: vis(gate),
    playShown: vis(play),
    accountText: account ? account.textContent : null,
    inMatch: document.body.classList.contains("in-match"),
    open: box ? box.open : null,
    formDisplay: (() => {
      const form = document.getElementById("password");
      return form ? getComputedStyle(form).display : null;
    })(),
    flash: String((document.getElementById("flash") || {}).textContent || "").trim(),
  };
};

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("a given server answers", true, BASE);
  }
  try {
    VERSION = await fetch(BASE + "/api/version").then((r) => r.json());
  } catch { VERSION = null; }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });

  for (const viewport of VIEWPORTS) {
    const tag = viewport.width + "x" + viewport.height;
    const run = Date.now().toString(36).slice(-6);
    const name = "pb314-" + tag + "-" + run;
    const pageErrors = [];
    const navigations = [];
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 200)));
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
    const shot = (label) => page.screenshot({ path: path.join(OUT, label + "-" + tag + ".png") });
    const flash = () => page.evaluate(() => String((document.getElementById("flash") || {}).textContent || "").trim());

    try {
      // ---- 1. FIRST PAINT, signed out ---------------------------------------------------
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
      await sleep(400);
      const gate = await page.evaluate(MEASURE);
      await shot("01-gate");

      mark(tag + ": signed out, the gate is the surface on screen",
        gate.gateShown && !gate.playShown && !gate.inMatch && gate.accountText === "",
        `gate=${gate.gateShown} play=${gate.playShown} in-match=${gate.inMatch} account=${JSON.stringify(gate.accountText)}`);
      mark(tag + ": signed out, #passwordBox has no layout box and computed display none",
        gate.boxPresent && gate.clientRects === 0 && gate.display === "none",
        `display=${gate.display} rects=${gate.clientRects} ${gate.width}x${gate.height} at (${gate.left},${gate.top}) class=${gate.className}`);
      mark(tag + ": signed out, no point over the masthead hit-tests to the disclosure or its summary",
        gate.hitsOverMasthead === 0,
        `${gate.hitsOverMasthead} hits${gate.firstHit ? " first " + JSON.stringify(gate.firstHit) : ""}`);

      // ---- 2. signed in: the LOBBY still offers the control -------------------------------
      await page.fill("#register input[name=username]", name);
      await page.fill("#register input[name=password]", OLD_PW);
      await page.click("#register button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
      await sleep(500);
      const lobby = await page.evaluate(MEASURE);
      await shot("02-lobby");
      mark(tag + ": signed in, the disclosure is laid out in the lobby",
        lobby.boxPresent && lobby.display !== "none" && lobby.width > 0 && lobby.height > 0 && lobby.clientRects > 0,
        `display=${lobby.display} ${lobby.width}x${lobby.height} at (${lobby.left},${lobby.top}) rects=${lobby.clientRects}`);
      mark(tag + ": signed in, the summary owns its own centre and opens the form on a real click",
        Boolean(lobby.summaryHit && lobby.summaryHit.self),
        JSON.stringify(lobby.summaryHit));

      await page.click("#passwordBox summary");
      await sleep(150);
      const opened = await page.evaluate(MEASURE);
      mark(tag + ": the opened form is laid out and takes input",
        opened.open === true && opened.formDisplay !== "none" && opened.height > lobby.height,
        `open=${opened.open} form=${opened.formDisplay} box ${opened.width}x${opened.height}`);
      await shot("03-open");

      // ---- 3. the change form's own refusal sentence --------------------------------------
      await page.fill("#password input[name=current]", "not-" + OLD_PW);
      await page.fill("#password input[name=next]", NEW_PW);
      await page.click("#password button[type=submit]");
      await sleep(500);
      const wrong = await flash();
      mark(tag + ": a wrong current password is refused with the CHANGE form's sentence",
        wrong === WRONG_CURRENT, JSON.stringify(wrong));

      // ---- 4. the change works, and the toast is a prefix not an equality ------------------
      await page.fill("#password input[name=current]", OLD_PW);
      await page.fill("#password input[name=next]", NEW_PW);
      await page.click("#password button[type=submit]");
      await sleep(700);
      const changed = await flash();
      mark(tag + ": a correct current password changes it, toast starts with \"" + CHANGED_PREFIX + "\"",
        changed.startsWith(CHANGED_PREFIX), JSON.stringify(changed));

      // ---- 5. AC (c): sign out hides it again, with no reload ------------------------------
      const navsBefore = navigations.length;
      await page.evaluate(() => { window.__pb314Marker = 1; });
      await page.click('#account button');
      await page.waitForSelector("#gate:not(.hidden)", { timeout: 15000 });
      await sleep(400);
      const out = await page.evaluate(MEASURE);
      const marker = await page.evaluate(() => window.__pb314Marker);
      await shot("04-after-signout");
      mark(tag + ": after a real Sign out click the gate is back and the disclosure is hidden again",
        out.gateShown && out.display === "none" && out.clientRects === 0 && out.hitsOverMasthead === 0,
        `display=${out.display} rects=${out.clientRects} ${out.width}x${out.height} hits=${out.hitsOverMasthead}`);
      mark(tag + ": Sign out did not reload the page (marker survives, no navigation)",
        marker === 1 && navigations.length === navsBefore,
        `marker=${String(marker)} navigations ${navsBefore} -> ${navigations.length}`);

      // ---- 6. the LOGIN path's sentence, then the new password works ----------------------
      await page.fill("#login input[name=username]", name);
      await page.fill("#login input[name=password]", OLD_PW);
      await page.click("#login button[type=submit]");
      await sleep(700);
      const oldRefused = await flash();
      mark(tag + ": the old password is refused by the LOGIN form with its own sentence",
        oldRefused === WRONG_LOGIN, JSON.stringify(oldRefused));

      await page.fill("#login input[name=username]", name);
      await page.fill("#login input[name=password]", NEW_PW);
      await page.click("#login button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
      await sleep(500);
      const back = await page.evaluate(MEASURE);
      await shot("05-relogin");
      mark(tag + ": the new password signs in and the disclosure is back in the lobby",
        back.playShown && back.display !== "none" && back.width > 0 && back.height > 0,
        `play=${back.playShown} display=${back.display} ${back.width}x${back.height}`);

      mark(tag + ": no page error", pageErrors.length === 0, JSON.stringify(pageErrors));
    } catch (err) {
      mark(tag + ": the course completed without throwing", false, String((err && err.message) || err).slice(0, 400));
    } finally {
      await context.close();
    }
  }

  const passed = evidence.filter((row) => row.ok).length;
  console.log("pb314 page leg: " + passed + " passed / " + failed + " failed");
  const verdict = {
    name: "pb314-password-gate",
    base: BASE,
    version: VERSION,
    mode: GIVEN ? "url" : "self-hosted",
    viewports: VIEWPORTS,
    checks: evidence,
    passed,
    failed,
  };
  writeFileSync(path.join(OUT, "pb314-verdict" + (GIVEN ? "-url" : "") + ".json"), JSON.stringify(verdict, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
  }
  process.exitCode = failed ? 1 : 0;
}
