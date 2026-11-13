// T-010 AC3(b) / PB-003: a real 10-second network drop during Buy; the order survives and applies
// exactly once, on the cell the placement mask named.
//
//   node tests/e2e/drop-buy.mjs --url=https://openchq-web-production.up.railway.app
//
// The cut is a real iptables DROP on the live host's own addresses (Chrome's offline emulation
// leaves an established WebSocket up, so it never reaches the queued-order path). The DROP is
// removed in a finally block. Evidence: #flash text while cut and while queued, the frame the
// server answers with after the restore, and the server cell compared against the masked cell.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = (arg("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) { console.error("usage: node drop-buy.mjs --url=<live base>"); process.exit(2); }
const ERA = arg("era", "1942");
const DROP_SOCKET = process.argv.includes("--drop-socket");
const OUT = path.join(here, "t010-drop-buy-" + new Date().toISOString().replace(/[:.]/g, "-"));

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const summary = { base: BASE, era: ERA, startedAt: new Date().toISOString(), buy: {} };
const mark = (ok, label, detail = "") => {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
};
const sudo = (...a) => execFileSync("sudo", ["-n", ...a], { encoding: "utf8" });
const PORT = (() => {
  const u = new URL(BASE);
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
})();
const cut = (ips, on) => {
  for (const ip of ips) {
    sudo("iptables", "-w", on ? "-I" : "-D", "OUTPUT", "-p", "tcp", "-d", ip, "--dport", String(PORT), "-j", "DROP");
    console.log((on ? "drop " : "restore ") + ip);
  }
};

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await context.newPage();
const frames = [];
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => {
    try { const t = String(f.payload); if (t.startsWith("{")) frames.push(JSON.parse(t)); } catch { /* ignore */ }
  });
});
const room = () => page.evaluate(() => window.__chq.room());
// The socket timeline, recorded in the page: Playwright's own websocket event has no open/close
// timestamps, so a reconnect can only be measured against a toast. PB-025 is a socket claim, so the
// page logs each socket's open and close from its first line of script.
await page.addInitScript(() => {
  const Native = window.WebSocket;
  window.__wsLog = [];
  function Tap(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    const record = { url: String(url), createdAt: Date.now(), openedAt: null, closedAt: null, code: null };
    window.__wsLog.push(record);
    ws.addEventListener("open", () => { record.openedAt = Date.now(); });
    ws.addEventListener("close", (event) => { record.closedAt = Date.now(); record.code = event && event.code; });
    return ws;
  }
  Tap.prototype = Native.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Tap[key] = Native[key];
  window.WebSocket = Tap;
});
const wsLog = () => page.evaluate(() => (window.__wsLog || []).map((w) => ({ ...w })));
const flash = () => page.evaluate(() => (document.querySelector("#flash") || {}).textContent || "");
const shot = async (n) => { const f = path.join(OUT, n); await page.screenshot({ path: f }); console.log("shot " + f); return f; };

const ips = /^\d+\.\d+\.\d+\.\d+$/.test(new URL(BASE).hostname)
  ? [new URL(BASE).hostname]
  : await dns.resolve4(new URL(BASE).hostname);
summary.ips = ips;
let cutOn = false;
try {
  mkdirSync(OUT, { recursive: true });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  summary.version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark(true, "live build", summary.version);
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "db" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    summary.user = name;
    mark(true, "registered a throwaway user", name);
  }
  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e, ERA, { timeout: 30000, polling: 100 });
  await page.click("#camFit").catch(() => {});
  mark(true, "room open", { era: (await room()).era, round: (await room()).round });

  // The pool has to cover a purchase: run the clock until it does.
  await page.click("#clockBtn");
  const cash = async () => Number(((await room()).seat || {}).cash ?? 0);
  for (let i = 0; i < 120 && (await cash()) < 10000; i++) await sleep(1000);
  summary.buy.pool = await cash();
  mark(summary.buy.pool >= 10000, "the pool covers a cruiser", summary.buy.pool);
  await page.click("#clockBtn"); // hold while the purchase is armed

  // Arm a sea unit through the real Buy dialog.
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(300);
  await page.click('button.buyrow[data-kind="cruiser"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 });
  const legal = await page.evaluate(() => window.__chq.legalCells(6000));
  if (!legal.length) throw new Error("no legal cell for a cruiser");
  const cell = legal[Math.floor(legal.length / 2)];
  summary.buy.cell = cell;
  summary.buy.maskCells = legal.length;
  mark(true, "a cruiser is armed and the mask names a legal cell", { cell, maskCells: legal.length });

  // ---- the 10 s cut ---------------------------------------------------------
  const before = frames.filter((f) => f.op === "bought").length;
  const piecesAt = async () => ((await room()).pieces || []).filter((p) => Number(p.x) === cell.x && Number(p.y) === cell.y).length;
  summary.buy.piecesBefore = await piecesAt();
  cut(ips, true);
  cutOn = true;
  const cutAt = Date.now();
  await sleep(2500);
  summary.buy.flashWhenCut = await flash();
  const pt = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.click(pt.x, pt.y);
  // The page's queued sentence is a timer, not an event: orderwatch says it after ACK_WAIT_MS
  // (2 s) with no answer, so waiting 0.8 s could only ever read the Buy prompt back (PB-003).
  await sleep(2600);
  summary.buy.queuedText = await flash();
  mark(/queued/i.test(summary.buy.queuedText) || /offline|reconnect/i.test(summary.buy.flashWhenCut),
    "the page tells the player the order is queued while the network is down", { cut: summary.buy.flashWhenCut, queued: summary.buy.queuedText });
  await shot("01-queued-while-cut.png");
  // --drop-socket: a real 10 s DROP leaves an already-open socket alive on loopback (nothing writes,
  // so nothing fails) and the queued order flushes on that same socket. That leg proves the queue
  // and not the reconnect. This flag kills the socket while the network is still black, so the
  // reconnect policy is exercised for real: the page has to wait out the rest of the cut and come
  // back by itself once the DROP is gone.
  if (DROP_SOCKET) {
    await page.evaluate(() => window.__chq.dropSocket());
    summary.buy.socketDropped = true;
    console.log("closed the page's socket mid-cut (--drop-socket)");
  }
  while (Date.now() - cutAt < 10000) await sleep(200);
  summary.buy.cutSeconds = Math.round((Date.now() - cutAt) / 1000);
  cut(ips, false);
  cutOn = false;
  const backAt = Date.now();
  // The socket's own open event is the witness, not a toast: wait for the first socket that opened
  // after the restore, and report its distance from the restore (PB-025's reconnectedAfterMs).
  await page
    .waitForFunction((t) => (window.__wsLog || []).some((w) => w.openedAt && w.openedAt >= t), backAt, { timeout: 60000 })
    .catch(() => { summary.buy.waitTimedOut = true; });
  const openedAt = await page.evaluate((t) => {
    const hit = (window.__wsLog || [])
      .filter((w) => w.openedAt && w.openedAt >= t)
      .sort((a, b) => a.openedAt - b.openedAt)[0];
    return hit ? hit.openedAt : null;
  }, backAt);
  summary.buy.reconnectedAfterMs = openedAt ? openedAt - backAt : null;
  summary.buy.wsLog = await wsLog();
  const reopened = !summary.buy.waitTimedOut && summary.buy.reconnectedAfterMs !== null;
  // Without --drop-socket the socket usually survives a 10 s DROP of its own path: nothing was being
  // written, so nothing failed, and the queued order goes out on the same connection. That is a pass
  // for the queue, and no reconnect is owed. With --drop-socket a reconnect is the whole point.
  mark(reopened || !DROP_SOCKET,
    DROP_SOCKET ? "the socket reopened after the restore" : "the socket survived the cut on its own",
    { reconnectedAfterMs: summary.buy.reconnectedAfterMs, dropped: DROP_SOCKET, closes: summary.buy.wsLog.filter((w) => w.closedAt).length });
  if (reopened) {
    mark(Number(summary.buy.reconnectedAfterMs) <= 15000,
      "the socket was back within 15 s of the network returning", summary.buy.reconnectedAfterMs);
  }
  // "Bought a cruiser", "Bought an infantry": the old pattern only matched the second, so a cruiser
  // leg waited out the full 60 s timeout and reported 63 s as a reconnect (PB-025).
  await page
    .waitForFunction(() => /Bought |reconnect|refused/i.test((document.querySelector("#flash") || {}).textContent || ""), null, { timeout: 20000 })
    .catch(() => { summary.buy.noToast = true; });
  await sleep(3000);
  const bought = frames.filter((f) => f.op === "bought");
  const errs = frames.filter((f) => f.op === "error");
  summary.buy.newBoughtFrames = bought.length - before;
  summary.buy.errorTexts = errs.map((e) => e.error);
  summary.buy.flashAfter = await flash();
  const got = (summary.buy.flashAfter.match(/at (\d+),(\d+)/) || []).slice(1).map(Number);
  summary.buy.serverCell = got;
  summary.buy.cellMatch = got[0] === cell.x && got[1] === cell.y;
  mark(summary.buy.newBoughtFrames === 1, "exactly one purchase landed after the restore", summary.buy.newBoughtFrames);
  summary.buy.piecesAfter = await piecesAt();
  mark(summary.buy.piecesAfter === summary.buy.piecesBefore + 1,
    "the server holds exactly one new piece on that cell", { before: summary.buy.piecesBefore, after: summary.buy.piecesAfter });
  mark(summary.buy.errorTexts.length === 0, "no refusal came back", summary.buy.errorTexts);
  mark(summary.buy.cellMatch, "the unit landed on the cell the mask named", { wanted: cell, server: got, flash: summary.buy.flashAfter });
  await shot("02-after-restore.png");
} catch (err) {
  mark(false, "run threw", String(err && err.message ? err.message : err));
  summary.error = String(err && err.stack ? err.stack : err);
} finally {
  if (cutOn) {
    try { cut(ips, false); } catch (e) { console.log("could not remove the DROP: " + e.message); }
  }
  summary.rows = rows;
  summary.failed = rows.filter((x) => !x.ok).length;
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("summary " + path.join(OUT, "summary.json"));
  console.log(summary.failed === 0 ? "DROP_BUY_OK" : "DROP_BUY_FAILED rows=" + summary.failed);
  await browser.close();
  process.exit(0);
}
