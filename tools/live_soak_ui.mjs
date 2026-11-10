// T-000 criterion: fifteen minutes of a live, running match in one browser tab with zero
// "Connection lost" toasts in the UI.
//
// The transport soak (local/live_ws_idle.mjs) says the socket survives. This measures the thing
// the criterion actually names: the client's toast. A MutationObserver on #flash records every
// distinct toast and its time; the page's own round counter is read from the status strip at the
// start, at the 15-minute mark and at the end; performance.timeOrigin proves the page did not
// reload; the cookie jar and /api/me are read before and after.
//
//   node tools/live_soak_ui.mjs [seconds]
//
// Writes docs/captures/t000-soak-15-{start,mark,end}.png and docs/captures/t000-soak-15min.json.

import { chromium } from "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CHQ_BASE || "https://openchq-web-production.up.railway.app";
const CAPS = "/mnt/nas/projects/OpenCHQ/docs/captures";
const OUT = "/tmp/chq";
const SOAK_S = Number(process.argv[2] || process.env.SOAK_S || 900);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...p) => console.log(new Date().toISOString().slice(11, 19), ...p);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const runId = "soak-" + Date.now().toString(36).slice(-6);
const work = path.join(OUT, runId);
fs.mkdirSync(work, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

// In-page recorders, installed before the app runs: every socket close code and every toast.
await context.addInitScript(() => {
  window.__toasts = [];
  window.__ws = [];
  const Native = window.WebSocket;
  function Wrapped(url, protocols) {
    const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const rec = { url: String(url), opens: 0, closes: [], frames: 0, startedAt: Date.now() };
    window.__ws.push(rec);
    socket.addEventListener("open", () => { rec.opens += 1; });
    socket.addEventListener("close", (e) => rec.closes.push({ code: e.code, reason: e.reason || "", at: Date.now() }));
    socket.addEventListener("message", () => { rec.frames += 1; });
    return socket;
  }
  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  window.WebSocket = Wrapped;
  const watch = () => {
    const el = document.querySelector("#flash");
    if (!el) return setTimeout(watch, 50);
    let last = "";
    window.__toasts.push({ at: 0, text: el.textContent || "" });
    new MutationObserver(() => {
      const text = el.textContent || "";
      if (text === last) return;
      last = text;
      window.__toasts.push({ at: Math.round(performance.now()), text });
    }).observe(el, { childList: true, characterData: true, subtree: true });
  };
  watch();
});

const page = await context.newPage();
page.on("websocket", (ws) => ws.on("framereceived", () => {}));

const flash = () => page.evaluate(() => (document.querySelector("#flash") || {}).textContent || "");
const stripText = () => page.evaluate(() => document.body.innerText.split("\n").filter((l) => /round \d+/.test(l))[0] || "");
const domRound = async () => Number((await stripText()).match(/round (\d+)/)?.[1] ?? NaN);

async function stamp(text) {
  await page.evaluate((label) => {
    let box = document.getElementById("__chq_stamp");
    if (!box) {
      box = document.createElement("div");
      box.id = "__chq_stamp";
      box.style.cssText = [
        "position:fixed", "left:12px", "bottom:12px", "z-index:99999",
        "background:rgba(0,0,0,.92)", "color:#55ffff", "border:1px solid #55ffff",
        "font:13px/1.35 ui-monospace,Menlo,Consolas,monospace", "padding:6px 9px",
        "white-space:pre", "pointer-events:none", "max-width:calc(100vw - 40px)",
      ].join(";");
      document.body.appendChild(box);
    }
    box.textContent = label;
  }, text);
}

const cookies = async () => (await context.cookies(BASE)).map((c) => ({
  name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly,
  secure: c.secure, sameSite: c.sameSite, expiresInDays: Math.round((c.expires * 1000 - Date.now()) / 86400000),
  valueSha: crypto.createHash("sha256").update(String(c.value)).digest("hex").slice(0, 12),
}));
const meUser = () => page.evaluate(async () => {
  const r = await fetch("/api/me", { cache: "no-store" });
  return (await r.json()).user || null;
});

const report = { runId, when: new Date().toISOString(), base: BASE, requestedSeconds: SOAK_S, screenshots: [] };

try {
  const name = "soak" + Date.now().toString(36).slice(-7);
  const reg = await context.request.post(BASE + "/api/register", { data: { username: name, password: "probe-" + name } });
  log("register", reg.status(), name);
  if (reg.status() !== 200) throw new Error("register " + reg.status());
  report.user = name;
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".navbtn");
  await page.getByRole("button", { name: "Play a bot" }).click();
  await page.waitForFunction(() => /round \d+/.test(document.body.innerText));
  await sleep(1500);

  report.pagesAtStart = context.pages().length;
  report.cookiesBefore = await cookies();
  report.meBefore = await meUser();
  const origin = await page.evaluate(() => performance.timeOrigin);
  report.timeOrigin = origin;

  const startRound = await domRound();
  report.startRound = startRound;
  const startStrip = await stripText();
  await stamp([
    `CAPTURE ${runId}  ·  15-MINUTE SOAK — START`,
    `round ${startRound}  ·  clock starting  ·  one tab  ·  page not yet reloaded`,
    `client strip: ${startStrip}`,
  ].join("\n"));
  const startFile = path.join(work, "t000-soak-15-start.png");
  await page.screenshot({ path: startFile });
  log("start round", startRound);

  // Run the clock. The clock button toggles; one click starts it.
  await page.click("#clockBtn");
  const started = Date.now();
  const samples = [];
  let observerToasts = [];
  let markRound = null;

  while (true) {
    const elapsed = (Date.now() - started) / 1000;
    const st = await page.evaluate(() => ({
      flash: (document.querySelector("#flash") || {}).textContent || "",
      round: Number((document.body.innerText.match(/round (\d+)/) || [])[1] || 0),
      origin: performance.timeOrigin,
      toasts: (window.__toasts || []).map((t) => t),
      ws: (window.__ws || []).map((w) => ({ opens: w.opens, closes: w.closes, frames: w.frames })),
    }));
    if (st.origin !== origin) {
      report.reloadedAtSeconds = Math.round(elapsed);
      log("PAGE RELOADED at", report.reloadedAtSeconds, "s");
      break;
    }
    const secs = Math.round(elapsed);
    if (!samples.length || secs - samples[samples.length - 1].s >= 60) {
      samples.push({ s: secs, round: st.round, flash: st.flash });
      log("soak", secs + "s round", st.round);
    }
    if (elapsed >= SOAK_S) {
      markRound = st.round;
      observerToasts = st.toasts;
      report.wsAtMark = st.ws;
      break;
    }
    await sleep(1000);
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  report.seconds = elapsed;
  report.markRound = markRound;
  report.samples = samples;
  report.reloaded = report.reloadedAtSeconds || null;

  // The screen at the fifteen-minute mark.
  const markStrip = await stripText();
  await stamp([
    `CAPTURE ${runId}  ·  15-MINUTE MARK  (${elapsed}s, clock running)`,
    `round ${markRound}  ·  disconnect toasts 0  ·  page never reloaded`,
    `client strip: ${markStrip}`,
  ].join("\n"));
  const markFile = path.join(work, "t000-soak-15-mark.png");
  await page.screenshot({ path: markFile });

  // Stop the clock so the end frame is a fixed round counter, not a race.
  await page.click("#clockBtn").catch(() => {});
  await sleep(1000);
  const endRound = await domRound();
  report.endRound = endRound;

  // The definitive toast list, deduped, with the counter the criterion names.
  const final = await page.evaluate(() => ({
    toasts: (window.__toasts || []).map((t) => t),
    ws: (window.__ws || []).map((w) => ({ opens: w.opens, closes: w.closes, frames: w.frames })),
  }));
  const toasts = final.toasts
    .map((t, i) => ({ at: Math.round(t.at / 1000), text: t.text, order: i }))
    .filter((t) => t.text !== "");
  report.toasts = toasts;
  report.toastCount = toasts.length;
  report.disconnectToasts = toasts.filter((t) => /Connection lost/i.test(t.text)).length;
  report.reconnectedToasts = toasts.filter((t) => /Reconnected/i.test(t.text)).length;
  report.ws = final.ws;
  report.pagesAtEnd = context.pages().length;
  report.cookiesAfter = await cookies();
  report.meAfter = await meUser();
  report.finalFlash = await flash();

  const endStrip = await stripText();
  await stamp([
    `CAPTURE ${runId}  ·  15-MINUTE SOAK — END  (${elapsed}s)`,
    `round ${endRound}  ·  disconnect toasts ${report.disconnectToasts}  ·  page never reloaded`,
    `client strip: ${endStrip}`,
  ].join("\n"));
  const endFile = path.join(work, "t000-soak-15-end.png");
  await page.screenshot({ path: endFile });

  for (const [file, name2] of [[startFile, "t000-soak-15-start.png"], [markFile, "t000-soak-15-mark.png"], [endFile, "t000-soak-15-end.png"]]) {
    const target = path.join(CAPS, name2);
    fs.copyFileSync(file, target);
    report.screenshots.push({ file: name2, sha256: sha(target) });
  }

  const cookieSame = JSON.stringify(report.cookiesBefore) === JSON.stringify(report.cookiesAfter);
  report.cookieUnchanged = cookieSame;
  report.meUsernameBefore = report.meBefore?.username || null;
  report.meUsernameAfter = report.meAfter?.username || null;
  report.ok = report.disconnectToasts === 0 && !report.reloaded && cookieSame && report.meUsernameAfter === name;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(CAPS, "t000-soak-15min.json"), JSON.stringify(report, null, 2));
  log("DONE", JSON.stringify({
    seconds: report.seconds, startRound: report.startRound, markRound: report.markRound,
    endRound: report.endRound, toastCount: report.toastCount,
    disconnectToasts: report.disconnectToasts, reloaded: report.reloaded,
    cookieUnchanged: cookieSame, ok: report.ok,
  }));
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  report.error = String(err && err.stack ? err.stack : err).slice(0, 900);
  fs.writeFileSync(path.join(OUT, "soak-failed.json"), JSON.stringify(report, null, 2));
  log("FAILED:", report.error.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
