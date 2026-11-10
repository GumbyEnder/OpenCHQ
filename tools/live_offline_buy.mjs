// Two T-000 manual checks, driven through the real client on the live build.
//
//   (1) network off for 10 s, issue a Buy, network back on -> the order is queued, the player is
//       told, and the server applies it exactly once.
//   (2) 15 minutes with the clock running -> zero "Connection lost" toasts, the page never reloads.
//
// The network cut is a real one: an iptables DROP on the host's live addresses for the length of the
// test, removed in a finally block. Chrome's own offline emulation leaves an established WebSocket up,
// so the client never learns it is offline and the queued-order path is never reached - that is why the
// earlier attempt could not demonstrate it.
//
//   node local/live_offline_buy.mjs [soakSeconds]
//
// Writes /tmp/chq/t000-live.json and appends to /tmp/chq/t000-live.log.

import { chromium } from "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";

const BASE = process.env.CHQ_BASE || "https://openchq-web-production.up.railway.app";
const HOST = new URL(BASE).hostname;
const SOAK_S = Number(process.env.SOAK_S || 900);
const OUT = "/tmp/chq";
fs.mkdirSync(OUT, { recursive: true });
const logFile = OUT + "/t000-live.log";
const log = (...p) => {
  const line = new Date().toISOString().slice(11, 19) + " " + p.join(" ");
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { when: new Date().toISOString(), base: BASE, buy: {}, soak: {} };
const save = () => fs.writeFileSync(OUT + "/t000-live.json", JSON.stringify(result, null, 2));

const sudo = (...args) => execFileSync("sudo", ["-n", ...args], { encoding: "utf8" });

function cutNetwork(ips, on) {
  for (const ip of ips) {
    try {
      sudo("iptables", "-w", on ? "-I" : "-D", "OUTPUT", "-p", "tcp", "-d", ip, "--dport", "443", "-j", "DROP");
      log(on ? "dropped" : "restored", ip);
    } catch (err) {
      log("iptables", on ? "insert" : "delete", "failed", ip, String(err.message).slice(0, 120));
    }
  }
}

async function main() {
  const ips = await dns.resolve4(HOST);
  log("live addresses:", ips.join(","));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const page = await context.newPage();
  const frames = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      try {
        const t = String(f.payload);
        if (t.startsWith("{")) frames.push(JSON.parse(t));
      } catch {}
    });
  });
  const flash = () => page.evaluate(() => (document.querySelector("#flash") || {}).textContent || "");
  const strip = () => page.evaluate(() => document.body.innerText.split("\n").filter((l) => /round \d+/.test(l))[0] || "");

  try {
    // --- account and match ------------------------------------------------------------------
    const name = "t000" + Date.now().toString(36).slice(-7);
    const reg = await context.request.post(BASE + "/api/register", { data: { username: name, password: "probe-" + name } });
    log("register", reg.status(), name);
    if (reg.status() !== 200) throw new Error("register " + reg.status());
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector(".navbtn");
    await page.getByRole("button", { name: "Play a bot" }).click();
    await page.waitForFunction(() => /round \d+/.test(document.body.innerText));
    await sleep(1200);
    log("match open:", await strip());
    result.buy.user = name;
    result.buy.footer = await page.evaluate(() => (document.body.innerText.match(/build ([0-9a-f]{7,40})/) || [])[1] || "");

    // Round 0 opens with a pool that cannot cover a unit; run the clock until one is affordable.
    await page.click("#clockBtn");
    const poolB = async () => Number((await page.evaluate(() => (document.body.innerText.match(/pool ([\d.]+)b/) || [])[1])) || 0);
    for (const until = Date.now() + 180000; Date.now() < until && (await poolB()) < 10; ) await sleep(1500);
    log("pool", (await poolB()) + "b", "|", await strip());
    await page.click("#clockBtn");

    // --- arm a sea unit through the real Buy dialog ------------------------------------------
    await page.locator('.navbtn[data-dialog="buy"]').click();
    await page.waitForSelector("#dialog:not(.hidden) .buyrow");
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("#dialogBody .buyrow:not(.head)")].map((r) => ({
        kind: r.children[0].innerText.trim(), disabled: r.disabled, cost: r.children[3].innerText.trim(),
      }))
    );
    const sea = rows.find((r) => !r.disabled && ["submarine", "cruiser"].includes(r.kind));
    if (!sea) throw new Error("no affordable sea unit: " + JSON.stringify(rows));
    const maskP = new Promise((res) => {
      const iv = setInterval(() => {
        const m = frames.find((f) => f.op === "placement" && f.mask);
        if (m) { clearInterval(iv); res(m); }
      }, 100);
      setTimeout(() => { clearInterval(iv); res(null); }, 8000);
    });
    await page.locator("#dialogBody .buyrow", { hasText: sea.kind }).first().click();
    const mask = await maskP;
    if (!mask) throw new Error("no placement mask for " + sea.kind);
    const bytes = Buffer.from(mask.mask, "base64");
    const bw = mask.width, bh = mask.height;
    // A cell in the middle of the mask's own valid set, so the click lands on a legal cell.
    const valid = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (bytes[y * bw + x]) valid.push([x, y]);
    const [cx, cy] = valid[Math.floor(valid.length / 2)];
    // The click point is computed from the canvas as it is at click time, not as it was when the
    // dialog opened. The Buy panel and the bottom band both resize the canvas, which is how the
    // first attempt could send a stale coordinate into a legal mask cell.
    const pointFor = async (x, y) => {
      const canvas = page.locator("canvas#board");
      const box = await canvas.boundingBox();
      const attr = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
      return {
        x: box.x + (x + 0.5) * (attr.w / bw) * (box.width / attr.w),
        y: box.y + (y + 0.5) * (attr.h / bh) * (box.height / attr.h),
        box, attr,
      };
    };
    const first = await pointFor(cx, cy);
    log("armed", sea.kind, sea.cost, "| mask", bw + "x" + bh, "valid", valid.length, "| canvas", first.attr.w + "x" + first.attr.h, "css", Math.round(first.box.width) + "x" + Math.round(first.box.height));
    result.buy.armed = { kind: sea.kind, cost: sea.cost, maskCells: valid.length, cell: [cx, cy] };
    await page.screenshot({ path: OUT + "/t000-armed.png" });

    // --- the 10 s cut ------------------------------------------------------------------------
    const beforeCut = frames.filter((f) => f.op === "bought").length;
    cutNetwork(ips, true);
    const cutAt = Date.now();
    await sleep(2500);
    result.buy.flashWhenCut = await flash();
    log("after cut, flash:", JSON.stringify(result.buy.flashWhenCut));

    // Fresh coordinates, measured after the cut began and after the layout has had time to
    // settle. The cell the server buys must be the cell the mask marked.
    await sleep(300);
    const click = await pointFor(cx, cy);
    const clickX = click.x;
    const clickY = click.y;
    result.buy.clickAt = { x: Math.round(clickX), y: Math.round(clickY), canvas: [click.attr.w, click.attr.h], css: [Math.round(click.box.width), Math.round(click.box.height)] };
    await page.mouse.click(clickX, clickY);
    await sleep(800);
    const queued = await flash();
    result.buy.queuedText = queued;
    result.buy.queuedShown = /queued and will be sent/.test(queued);
    log("buy while cut, flash:", JSON.stringify(queued));
    await page.screenshot({ path: OUT + "/t000-queued.png" });

    while (Date.now() - cutAt < 10000) await sleep(250);
    result.buy.cutSeconds = Math.round((Date.now() - cutAt) / 1000);
    log("cut for", result.buy.cutSeconds, "s; flash:", JSON.stringify(await flash()));

    cutNetwork(ips, false);
    const backAt = Date.now();
    try {
      await page.waitForFunction(() => /Reconnected|Bought an|refused/.test((document.querySelector("#flash") || {}).textContent || ""), null, { timeout: 60000 });
    } catch {
      result.buy.waitTimedOut = true;
      log("no reconnect/ack within 60 s; flash:", JSON.stringify(await flash()));
    }
    await sleep(4000);
    const bought = frames.filter((f) => f.op === "bought");
    const errors = frames.filter((f) => f.op === "error");
    result.buy.reconnectedAfterMs = Date.now() - backAt;
    result.buy.newBoughtFrames = bought.length - beforeCut;
    result.buy.boughtFramesTotal = bought.length;
    result.buy.errorTexts = errors.map((e) => e.error);
    result.buy.flashAfter = await flash();
    result.buy.stripAfter = await strip();
    const boughtCell = (result.buy.flashAfter.match(/at (\d+),(\d+)/) || []).slice(1).map(Number);
    result.buy.serverCell = boughtCell;
    result.buy.cellMatch = boughtCell[0] === cx && boughtCell[1] === cy;
    log("after restore:", JSON.stringify({
      newBought: result.buy.newBoughtFrames, boughtTotal: bought.length,
      errors: result.buy.errorTexts, flash: result.buy.flashAfter,
      wanted: [cx, cy], serverCell: boughtCell, cellMatch: result.buy.cellMatch,
    }));
    if (result.buy.newBoughtFrames !== 1 || result.buy.errorTexts.length || !result.buy.cellMatch) {
      throw new Error("offline buy did not apply exactly once on the masked cell");
    }
    await page.screenshot({ path: OUT + "/t000-after-reconnect.png" });
    save();

    // --- the 15 minute run -------------------------------------------------------------------
    const origin = await page.evaluate(() => performance.timeOrigin);
    const started = Date.now();
    const toasts = [];
    let last = "";
    const samples = [];
    await page.click("#clockBtn").catch(() => {});
    while ((Date.now() - started) / 1000 < SOAK_S) {
      const st = await page.evaluate(() => ({
        flash: (document.querySelector("#flash") || {}).textContent || "",
        round: (document.body.innerText.match(/round (\d+)/) || [])[1] || null,
        origin: performance.timeOrigin,
      }));
      if (st.flash !== last) {
        toasts.push({ at: Math.round((Date.now() - started) / 1000), text: st.flash });
        last = st.flash;
      }
      if (st.origin !== origin) {
        result.soak.reloadedAt = Math.round((Date.now() - started) / 1000);
        log("PAGE RELOADED at", result.soak.reloadedAt, "s");
        break;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      if (!samples.length || secs - samples[samples.length - 1].s >= 120) {
        samples.push({ s: secs, round: st.round });
        log("soak", secs + "s round", st.round);
      }
      await sleep(1000);
    }
    result.soak.seconds = Math.round((Date.now() - started) / 1000);
    result.soak.toasts = toasts;
    result.soak.disconnectToasts = toasts.filter((t) => /Connection lost/.test(t.text)).length;
    result.soak.samples = samples;
    result.soak.endRound = await page.evaluate(() => (document.body.innerText.match(/round (\d+)/) || [])[1] || null);
    result.soak.reloaded = result.soak.reloadedAt || null;
    await page.screenshot({ path: OUT + "/t000-soak-end.png" });
    log("soak done:", JSON.stringify({ seconds: result.soak.seconds, disconnectToasts: result.soak.disconnectToasts, endRound: result.soak.endRound, reloaded: !!result.soak.reloaded }));
    save();
  } finally {
    cutNetwork(ips, false); // never leave a DROP rule behind
    await browser.close();
  }
}

main().catch((err) => {
  result.error = String(err && err.stack ? err.stack : err).slice(0, 800);
  log("FAILED:", result.error.split("\n").slice(0, 3).join(" | "));
  save();
  process.exit(1);
});
