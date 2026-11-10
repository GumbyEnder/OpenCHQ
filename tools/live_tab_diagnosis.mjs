// T-000: diagnose "the browser tab died twice and the cookie was dropped".
//
// The question is not whether a tab can be closed — it can. The question is who closed it and
// whether the session cookie went with it. This script puts the two candidate causes in front
// of the same live build and records what each one actually does:
//
//   A. two page targets in ONE browser context (the automation case) -> shared cookie, server
//      closes the older socket with code 1000, both pages stay logged in;
//   B. a fresh browser context (a different cookie jar) -> no session, which is what "logged
//      out" looks like when a harness opens a second context instead of a second tab;
//   C. close the tab, open a new one in the same context -> the session cookie is still there;
//   D. reload -> /api/me returns the same user.
//
// It also counts the client toasts each page shows, so the takeover's "Connection lost" cycle is
// separated from a real disconnect of the app's only tab.
//
//   node tools/live_tab_diagnosis.mjs
//
// Writes docs/captures/t000-tab-diagnosis.json.

import { chromium } from "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CHQ_BASE || "https://openchq-web-production.up.railway.app";
const CAPS = "/mnt/nas/projects/OpenCHQ/docs/captures";
const OUT = "/tmp/chq";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...p) => console.log(new Date().toISOString().slice(11, 19), ...p);

const runId = "tabdiag-" + Date.now().toString(36).slice(-6);
const report = { runId, when: new Date().toISOString(), base: BASE, steps: {} };

// Record every socket close code and every toast, before the app runs.
const recorder = async (context) => context.addInitScript(() => {
  window.__toasts = [];
  window.__ws = [];
  const Native = window.WebSocket;
  function Wrapped(url, protocols) {
    const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const rec = { url: String(url), opens: 0, closes: [], frames: 0 };
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
    new MutationObserver(() => {
      const text = el.textContent || "";
      if (text === last) return;
      last = text;
      window.__toasts.push({ at: Math.round(performance.now()), text });
    }).observe(el, { childList: true, characterData: true, subtree: true });
  };
  watch();
});

const jar = async (context) => (await context.cookies(BASE)).map((c) => ({
  name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  expiresInDays: Math.round((c.expires * 1000 - Date.now()) / 86400000),
  valueSha: crypto.createHash("sha256").update(String(c.value)).digest("hex").slice(0, 12),
}));

const me = (page) => page.evaluate(async () => {
  try {
    const r = await fetch("/api/me", { cache: "no-store" });
    return { status: r.status, user: (await r.json()).user || null };
  } catch (err) { return { status: 0, error: String(err) }; }
});

const pageState = (page) => page.evaluate(() => ({
  flash: (document.querySelector("#flash") || {}).textContent || "",
  round: Number((document.body.innerText.match(/round (\d+)/) || [])[1] || 0),
  gateVisible: !!document.querySelector("#gate") && !document.querySelector("#gate").classList.contains("hidden"),
  signedInText: (document.querySelector("#account") || {}).innerText || "",
  origin: performance.timeOrigin,
  toasts: (window.__toasts || []).map((t) => ({ at: Math.round(t.at / 1000), text: t.text })).filter((t) => t.text),
  ws: (window.__ws || []).map((w) => ({ opens: w.opens, closes: w.closes, frames: w.frames })),
}));

const browser = await chromium.launch({ headless: true });
const contextA = await browser.newContext({ viewport: { width: 1400, height: 820 } });
await recorder(contextA);

try {
  const name = "tabdiag" + Date.now().toString(36).slice(-7);
  const reg = await contextA.request.post(BASE + "/api/register", { data: { username: name, password: "probe-" + name } });
  log("register", reg.status(), name);
  if (reg.status() !== 200) throw new Error("register " + reg.status());
  report.user = name;

  // --- one tab, a live match ---------------------------------------------------------------
  const page1 = await contextA.newPage();
  await page1.goto(BASE, { waitUntil: "load" });
  await page1.waitForSelector(".navbtn");
  await page1.getByRole("button", { name: "Play a bot" }).click();
  await page1.waitForFunction(() => /round \d+/.test(document.body.innerText));
  await sleep(1500);
  await page1.click("#clockBtn");
  await sleep(4000);
  report.steps.oneTab = {
    pages: contextA.pages().length,
    cookie: await jar(contextA),
    me: await me(page1),
    state: await pageState(page1),
  };
  log("one tab:", JSON.stringify(report.steps.oneTab.state.round), "round; me", report.steps.oneTab.me.user?.username);

  // --- A: a second page target in the SAME context ------------------------------------------
  const page2 = await contextA.newPage();
  await page2.goto(BASE, { waitUntil: "load" });
  await page2.waitForSelector(".navbtn");
  await sleep(12000);
  const s1 = await pageState(page1);
  const s2 = await pageState(page2);
  report.steps.twoTabsOneContext = {
    pages: contextA.pages().length,
    cookie: await jar(contextA),
    me1: await me(page1),
    me2: await me(page2),
    page1: s1,
    page2: s2,
    page1DisconnectToasts: s1.toasts.filter((t) => /Connection lost/i.test(t.text)).length,
    page2DisconnectToasts: s2.toasts.filter((t) => /Connection lost/i.test(t.text)).length,
  };
  log("two tabs same context: page1 disconnects", report.steps.twoTabsOneContext.page1DisconnectToasts,
      "page2 disconnects", report.steps.twoTabsOneContext.page2DisconnectToasts,
      "| close codes", JSON.stringify([s1.ws.flatMap((w) => w.closes.map((c) => c.code)), s2.ws.flatMap((w) => w.closes.map((c) => c.code))]));
  await page1.screenshot({ path: path.join(OUT, runId + "-page1-two-tabs.png") });

  // --- close the second target; the first should settle -------------------------------------
  const beforeClose = s1.toasts.length;
  await page2.close();
  await sleep(12000);
  const s1after = await pageState(page1);
  report.steps.afterSecondTabClosed = {
    pages: contextA.pages().length,
    cookie: await jar(contextA),
    me1: await me(page1),
    newToasts: s1after.toasts.slice(beforeClose),
    round: s1after.round,
    me: await me(page1),
  };
  log("after closing tab 2: round", s1after.round, "| new toasts",
      JSON.stringify(report.steps.afterSecondTabClosed.newToasts.map((t) => t.text)));

  // --- C: reload the surviving tab -----------------------------------------------------------
  const beforeOrigin = s1after.origin;
  await page1.reload({ waitUntil: "load" });
  await page1.waitForSelector(".navbtn");
  await sleep(3000);
  const s1reload = await pageState(page1);
  report.steps.reload = {
    me: await me(page1),
    cookie: await jar(contextA),
    sameOrigin: s1reload.origin === beforeOrigin,
    state: s1reload,
  };
  log("reload: me", report.steps.reload.me.user?.username, "| same document", report.steps.reload.sameOrigin,
      "| round", s1reload.round);

  // --- C2: close the last tab and open a new one in the same context -------------------------
  await page1.close();
  const page3 = await contextA.newPage();
  await page3.goto(BASE, { waitUntil: "load" });
  await page3.waitForSelector(".navbtn");
  await sleep(2500);
  report.steps.newTabAfterClose = {
    pages: contextA.pages().length,
    me: await me(page3),
    cookie: await jar(contextA),
    state: await pageState(page3),
  };
  log("new tab after close: me", report.steps.newTabAfterClose.me.user?.username,
      "| gate", report.steps.newTabAfterClose.state.gateVisible);

  // --- B: a fresh context = a different cookie jar ------------------------------------------
  const contextB = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  await recorder(contextB);
  const page4 = await contextB.newPage();
  await page4.goto(BASE, { waitUntil: "load" });
  await page4.waitForSelector(".navbtn");
  await sleep(2500);
  report.steps.freshContext = {
    cookie: await jar(contextB),
    me: await me(page4),
    state: await pageState(page4),
  };
  log("fresh context: me", report.steps.freshContext.me.user, "| gate", report.steps.freshContext.state.gateVisible,
      "| cookies", report.steps.freshContext.cookie.length);
  await page4.screenshot({ path: path.join(OUT, runId + "-fresh-context.png") });

  report.verdict = {
    cookieSurvivesTwoTabs: report.steps.twoTabsOneContext.me1.user?.username === name &&
      report.steps.twoTabsOneContext.me2.user?.username === name,
    cookieSurvivesReload: report.steps.reload.me.user?.username === name,
    cookieSurvivesTabClose: report.steps.newTabAfterClose.me.user?.username === name,
    takeoverPingPong: report.steps.twoTabsOneContext.page1DisconnectToasts > 0 &&
      report.steps.twoTabsOneContext.page2DisconnectToasts > 0,
    singleTabSettles: report.steps.afterSecondTabClosed.newToasts.filter((t) => /Connection lost/i.test(t.text)).length === 0,
    freshContextHasNoSession: !report.steps.freshContext.me.user && report.steps.freshContext.cookie.length === 0,
  };
  report.ok = Object.values(report.verdict).every(Boolean);
  fs.writeFileSync(path.join(CAPS, "t000-tab-diagnosis.json"), JSON.stringify(report, null, 2));
  log("VERDICT", JSON.stringify(report.verdict), "ok", report.ok);
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  report.error = String(err && err.stack ? err.stack : err).slice(0, 900);
  fs.writeFileSync(path.join(OUT, "tab-diagnosis-failed.json"), JSON.stringify(report, null, 2));
  log("FAILED:", report.error.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
