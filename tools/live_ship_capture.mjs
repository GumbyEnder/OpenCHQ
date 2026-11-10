// T-000 manual check (b): a real ship order on the live build, captured at three moments the
// screenshot itself can be checked against, because the script only shoots when the server's own
// room state puts the hull where the caption claims it is.
//
//   node local/live_ship_capture.mjs
//
// Writes docs/captures/t000-ship-{1-washington,2-mid-atlantic,3-arrival}.png and /tmp/chq/ship.json.

import { chromium } from "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs";
import fs from "node:fs";

const BASE = process.env.CHQ_BASE || "https://openchq-web-production.up.railway.app";
const CAPS = "/mnt/nas/projects/OpenCHQ/docs/captures";
const OUT = "/tmp/chq";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...p) => console.log(new Date().toISOString().slice(11, 19), ...p);
const report = { when: new Date().toISOString(), base: BASE };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 760 } });
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
// The newest server view of our own pieces.
const pieces = () => {
  for (let i = frames.length - 1; i >= 0; i--) {
    const r = frames[i].room;
    if (r && Array.isArray(r.pieces) && r.pieces.length) return { round: r.round, clock: r.clock, pieces: r.pieces };
  }
  return null;
};
let shipId = null;
const ship = () => {
  const view = pieces();
  if (!view) return null;
  const own = shipId
    ? view.pieces.find((p) => p.id === shipId)
    : view.pieces.find((p) => /cruiser/i.test(String(p.kind)));
  if (!own) return null;
  shipId = own.id;
  return { ...own, round: view.round, clock: view.clock };
};
const clickCell = async (x, y) => {
  const canvas = page.locator("canvas#board");
  const box = await canvas.boundingBox();
  const attr = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
  await page.mouse.click(box.x + (x + 0.5) * (attr.w / 320) * (box.width / attr.w), box.y + (y + 0.5) * (attr.h / 136) * (box.height / attr.h));
};

try {
  const name = "ship" + Date.now().toString(36).slice(-7);
  const reg = await context.request.post(BASE + "/api/register", { data: { username: name, password: "probe-" + name } });
  log("register", reg.status(), name);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".navbtn");
  await page.getByRole("button", { name: "Play a bot" }).click();
  await page.waitForFunction(() => /round \d+/.test(document.body.innerText));
  await sleep(1000);
  await page.click("#clockBtn");
  for (let i = 0; i < 120; i++) {
    const pool = Number((await page.evaluate(() => (document.body.innerText.match(/pool ([\d.]+)b/) || [])[1])) || 0);
    if (pool >= 10) break;
    await sleep(1500);
  }
  await page.click("#clockBtn");
  log("pool ready;", await strip());

  // --- buy a cruiser and put it on the water nearest Washington -----------------------------
  await page.locator('.navbtn[data-dialog="buy"]').click();
  await page.waitForSelector("#dialog:not(.hidden) .buyrow");
  const maskP = new Promise((res) => {
    const iv = setInterval(() => {
      const m = frames.find((f) => f.op === "placement" && f.mask);
      if (m) { clearInterval(iv); res(m); }
    }, 100);
    setTimeout(() => { clearInterval(iv); res(null); }, 8000);
  });
  await page.locator("#dialogBody .buyrow", { hasText: "cruiser" }).first().click();
  const mask = await maskP;
  if (!mask) throw new Error("no cruiser placement mask");
  const bytes = Buffer.from(mask.mask, "base64");
  const valid = [];
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (bytes[y * mask.width + x]) valid.push([x, y]);
  // Washington is at 84,44 (the capital is inland); the nearest legal berth is the closest valid cell.
  const near = valid.sort((a, b) => (Math.abs(a[0] - 84) + Math.abs(a[1] - 44)) - (Math.abs(b[0] - 84) + Math.abs(b[1] - 44)))[0];
  log("berth", near, "of", valid.length, "valid cells");
  await clickCell(near[0], near[1]);
  await sleep(2000);
  report.bought = { at: near, flash: await flash() };
  log("bought:", JSON.stringify(report.bought));
  if (!/Bought an/.test(report.bought.flash)) throw new Error("buy did not land: " + report.bought.flash);
  await sleep(500);

  // --- leg 1: order to a mid-Atlantic lane cell ---------------------------------------------
  const hull = ship();
  if (!hull) throw new Error("no own sea piece in the room view");
  report.shipId = hull.id;
  log("hull", JSON.stringify({ id: hull.id, x: hull.x, y: hull.y, kind: hull.kind }));
  await clickCell(hull.x, hull.y);          // select the hull
  await sleep(700);
  await clickCell(106, 32);                 // draw the route
  await sleep(900);
  const planned = await flash();
  await page.screenshot({ path: CAPS + "/t000-ship-1-washington.png" });
  const atBerth = ship();
  report.capture1 = { strip: await strip(), ship: { x: atBerth.x, y: atBerth.y }, route: planned };
  await clickCell(106, 32);                 // send it
  await sleep(1200);
  report.order = { to: [106, 32], route: planned, flash: await flash() };
  log("order:", JSON.stringify(report.order));

  // --- run and shoot the crossing ------------------------------------------------------------
  await page.click("#clockBtn");
  let mid = null;
  for (let i = 0; i < 240; i++) {
    const s = ship();
    if (s && s.x >= 96 && s.x <= 118 && s.y >= 24 && s.y <= 42) {
      mid = s;
      break;
    }
    await sleep(500);
  }
  if (!mid) throw new Error("hull never reached the mid-Atlantic band");
  log("mid-Atlantic at", mid.x + "," + mid.y, "round", mid.round, "clock", mid.clock);
  await page.screenshot({ path: CAPS + "/t000-ship-2-mid-atlantic.png" });
  report.capture2 = { strip: await strip(), ship: { x: mid.x, y: mid.y }, round: mid.round, clock: mid.clock };

  // --- leg 2: on to Hamburg's berth -----------------------------------------------------------
  const midNow = ship();
  await clickCell(midNow.x, midNow.y);
  await sleep(600);
  await clickCell(157, 27);
  await sleep(900);
  await clickCell(157, 27);
  await sleep(1200);
  log("second leg:", JSON.stringify(await flash()));

  let arrived = null;
  for (let i = 0; i < 600; i++) {
    const s = ship();
    if (s && Math.abs(s.x - 157) <= 2 && Math.abs(s.y - 27) <= 2) {
      arrived = s;
      break;
    }
    await sleep(500);
  }
  if (!arrived) throw new Error("hull never reached 157,27");
  log("arrived at", arrived.x + "," + arrived.y, "round", arrived.round, "clock", arrived.clock);
  await page.click("#clockBtn");
  await sleep(700);
  await page.screenshot({ path: CAPS + "/t000-ship-3-arrival.png" });
  report.capture3 = { strip: await strip(), ship: { x: arrived.x, y: arrived.y }, round: arrived.round, clock: arrived.clock };
  log("done:", JSON.stringify(report.capture3));
} catch (err) {
  report.error = String(err && err.stack ? err.stack : err).slice(0, 600);
  log("FAILED:", report.error.split("\n")[0]);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(OUT + "/ship.json", JSON.stringify(report, null, 2));
  await browser.close();
}
