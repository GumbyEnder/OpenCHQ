// T-000 manual check: one ship, one run, three frames a reader cannot mix up.
//
//   node tools/live_ship_capture.mjs
//
// Why this is different from the first version: it wrote each PNG as it went, so a run that
// failed after frame 2 could leave frame 3 from an older run on disk, and two captures could
// show two different matches under the same name. Now every frame is written to a run
// directory and published to docs/captures/ only when all three agree: one username, one hull
// id, increasing round numbers, and the round in the picture equal to the round in the
// server's own room frame.
//
// Each published PNG also carries a burned-in provenance strip (run, hull, round, server cell)
// so the claim is readable in the image itself, not only in a JSON file beside it.
//
// Writes docs/captures/t000-ship-{1-washington,2-mid-atlantic,3-arrival}.png and
// docs/captures/t000-ship-run.json (run id, hull id, rounds, cells, sha256 per file).

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
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const runId = "shiprun-" + Date.now().toString(36).slice(-6);
const work = path.join(OUT, runId);
fs.mkdirSync(work, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

// --- the server's own view of the room -------------------------------------------------------
const state = { round: null, clock: null, you: null, pieces: new Map() };
const frames = [];
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => {
    try {
      const t = String(f.payload);
      if (!t.startsWith("{")) return;
      const msg = JSON.parse(t);
      frames.push(msg);
      if (msg.op === "room" && msg.room) {
        state.round = Number(msg.room.round);
        state.clock = msg.room.clock;
        state.you = msg.room.you;
        state.pieces = new Map((msg.room.pieces || []).map((p) => [p.id, p]));
      } else if (msg.op === "delta" && msg.delta) {
        const d = msg.delta;
        if (d.round !== undefined) state.round = Number(d.round);
        if (d.clock !== undefined) state.clock = d.clock;
        for (const p of d.pieces || []) state.pieces.set(p.id, p);
        for (const id of d.gone || []) state.pieces.delete(id);
      }
    } catch {}
  });
});

const flash = () => page.evaluate(() => (document.querySelector("#flash") || {}).textContent || "");
const stripText = () => page.evaluate(() => document.body.innerText.split("\n").filter((l) => /round \d+/.test(l))[0] || "");
const domRound = async () => Number((await stripText()).match(/round (\d+)/)?.[1] ?? NaN);

// Only shoot when the picture and the server frame agree. A screenshot of a claim the server is
// not making is not evidence.
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

async function capture(name, frame) {
  const r = await domRound();
  if (r !== frame.round) throw new Error(`client round ${r} != server round ${frame.round}`);
  const strip = await stripText();
  const label = [
    `CAPTURE ${runId}  ·  hull ${frame.hull}  ·  round ${frame.round} (${frame.clock})`,
    `server cell ${frame.x},${frame.y}  ·  ${name}`,
    `client strip: ${strip}`,
  ].join("\n");
  await stamp(label);
  const target = path.join(work, name);
  await page.screenshot({ path: target });
  fs.writeFileSync(target + ".json", JSON.stringify({ ...frame, clientRound: r, strip }, null, 2));
  log("captured", name, "round", frame.round, "cell", frame.x + "," + frame.y);
  return { target, strip };
}

function currentHull(hullId) {
  const p = state.pieces.get(hullId);
  if (!p) return null;
  return { ...p, round: state.round, clock: state.clock };
}

// Fresh box on every click: opening/closing the Buy dialog and the arrival of the bottom band
// both change the canvas's CSS size, so a coordinate measured before either is stale.
async function clickCell(x, y) {
  const canvas = page.locator("canvas#board");
  const box = await canvas.boundingBox();
  const attr = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
  const px = (x + 0.5) * (attr.w / 320);
  const py = (y + 0.5) * (attr.h / 136);
  await page.mouse.click(box.x + px * (box.width / attr.w), box.y + py * (box.height / attr.h));
}

const report = { runId, when: new Date().toISOString(), base: BASE, frames: [] };

try {
  const name = "ship" + Date.now().toString(36).slice(-7);
  const reg = await context.request.post(BASE + "/api/register", { data: { username: name, password: "probe-" + name } });
  log("register", reg.status(), name);
  if (reg.status() !== 200) throw new Error("register " + reg.status());
  report.user = name;
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".navbtn");
  await page.getByRole("button", { name: "Play a bot" }).click();
  await page.waitForFunction(() => /round \d+/.test(document.body.innerText));
  await sleep(1200);
  await page.click("#clockBtn");
  for (let i = 0; i < 120; i++) {
    const pool = Number((await page.evaluate(() => (document.body.innerText.match(/pool ([\d.]+)b/) || [])[1])) || 0);
    if (pool >= 10) break;
    await sleep(1500);
  }
  await page.click("#clockBtn");
  log("pool ready;", await stripText());

  // --- buy a cruiser at the Washington berth --------------------------------------------------
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
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) if (bytes[y * mask.width + x]) valid.push([x, y]);
  }
  // Washington is at 84,44 (the capital itself is inland); the nearest legal berth is the closest
  // cell the server's own mask marks as placeable.
  const berth = valid.sort((a, b) => (Math.abs(a[0] - 84) + Math.abs(a[1] - 44)) - (Math.abs(b[0] - 84) + Math.abs(b[1] - 44)))[0];
  log("berth", berth, "of", valid.length, "valid cells");
  await clickCell(berth[0], berth[1]);
  await sleep(2500);
  const boughtFlash = await flash();
  const boughtAt = (boughtFlash.match(/at (\d+),(\d+)/) || []).slice(1).map(Number);
  report.bought = { wanted: berth, at: boughtAt, flash: boughtFlash };
  log("bought:", JSON.stringify(report.bought));
  if (boughtAt[0] !== berth[0] || boughtAt[1] !== berth[1]) {
    throw new Error("buy landed on a different cell: " + JSON.stringify(boughtAt) + " != " + JSON.stringify(berth));
  }
  if (!/Bought an/.test(boughtFlash)) throw new Error("buy did not land: " + boughtFlash);

  // The hull is the piece the server put on the berth, not the first sea-looking thing in the
  // frame (the first version could latch onto an unrelated piece and chase it for 20 minutes).
  let hull = null;
  for (let i = 0; i < 40 && !hull; i++) {
    await sleep(250);
    hull = [...state.pieces.values()].find((p) =>
      p && p.side === state.you && p.kind === "cruiser" && p.x === berth[0] && p.y === berth[1]) || null;
  }
  if (!hull) throw new Error("no cruiser at the berth in the server's piece list");
  const hullId = hull.id;
  report.hullId = hullId;
  log("hull", JSON.stringify({ id: hullId, x: hull.x, y: hull.y, kind: hull.kind }));

  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);

  const frame1 = { hull: hullId, x: hull.x, y: hull.y, round: state.round, clock: state.clock };
  const shot1 = await capture("t000-ship-1-washington.png", frame1);
  report.frames.push({ file: "t000-ship-1-washington.png", ...frame1, toast: await flash(), clientStrip: shot1.strip });

  // --- order the mid-Atlantic leg -------------------------------------------------------------
  await clickCell(hull.x, hull.y);              // select
  await sleep(700);
  await clickCell(106, 32);                     // ask the server for the route
  await sleep(1200);
  const planned = await flash();
  await clickCell(106, 32);                     // send it
  await sleep(1500);
  report.order1 = { to: [106, 32], preview: planned, flash: await flash() };
  log("order:", JSON.stringify(report.order1));

  // --- run to the mid-Atlantic band -----------------------------------------------------------
  await page.click("#clockBtn");
  let mid = null;
  // Mid-Atlantic means the ordered waypoint, not the first cell past the US coast: the widened
  // 96..118 band caught the hull at 97,39, which is still offshore of Washington.
  for (let i = 0; i < 300; i++) {
    const s = currentHull(hullId);
    if (s && s.round > frame1.round && Math.abs(s.x - 106) <= 1 && Math.abs(s.y - 32) <= 1) { mid = s; break; }
    await sleep(500);
  }
  if (!mid) throw new Error("hull never reached the mid-Atlantic waypoint (106,32)");
  log("mid-Atlantic at", mid.x + "," + mid.y, "round", mid.round, mid.clock);
  const frame2 = { hull: hullId, x: mid.x, y: mid.y, round: mid.round, clock: mid.clock };
  const shot2 = await capture("t000-ship-2-mid-atlantic.png", frame2);
  report.frames.push({ file: "t000-ship-2-mid-atlantic.png", ...frame2, toast: await flash(), clientStrip: shot2.strip });

  // --- on to Hamburg's berth ------------------------------------------------------------------
  const now = currentHull(hullId);
  await clickCell(now.x, now.y);
  await sleep(600);
  await clickCell(157, 27);
  await sleep(900);
  report.preview2 = await flash();
  await clickCell(157, 27);
  await sleep(1500);
  report.order2 = { to: [157, 27], flash: await flash() };
  log("second leg:", JSON.stringify(report.order2));

  let arrived = null;
  for (let i = 0; i < 600; i++) {
    const s = currentHull(hullId);
    if (s && Math.abs(s.x - 157) <= 2 && Math.abs(s.y - 27) <= 2) { arrived = s; break; }
    await sleep(500);
  }
  if (!arrived) throw new Error("hull never reached 157,27");
  await page.click("#clockBtn").catch(() => {});
  await sleep(900);
  arrived = currentHull(hullId);
  log("arrived at", arrived.x + "," + arrived.y, "round", arrived.round, arrived.clock);
  const frame3 = { hull: hullId, x: arrived.x, y: arrived.y, round: arrived.round, clock: arrived.clock };
  const shot3 = await capture("t000-ship-3-arrival.png", frame3);
  report.frames.push({ file: "t000-ship-3-arrival.png", ...frame3, toast: await flash(), clientStrip: shot3.strip });

  // --- the invariant, checked before anything is published ------------------------------------
  const rounds = report.frames.map((f) => f.round);
  const hulls = new Set(report.frames.map((f) => f.hull));
  if (hulls.size !== 1) throw new Error("more than one hull in the frames: " + [...hulls].join(","));
  if (!(rounds[0] < rounds[1] && rounds[1] < rounds[2])) throw new Error("rounds are not increasing: " + rounds.join(","));
  report.monotonic = true;
  report.rounds = rounds;

  for (const f of report.frames) {
    fs.copyFileSync(path.join(work, f.file), path.join(CAPS, f.file));
    fs.copyFileSync(path.join(work, f.file + ".json"), path.join(CAPS, f.file + ".json"));
    f.sha256 = sha(path.join(CAPS, f.file));
  }
  report.published = new Date().toISOString();
  fs.writeFileSync(path.join(CAPS, "t000-ship-run.json"), JSON.stringify(report, null, 2));
  log("PUBLISHED", runId, "rounds", rounds.join(" -> "), "hull", report.hullId);
} catch (err) {
  report.error = String(err && err.stack ? err.stack : err).slice(0, 900);
  report.monotonic = false;
  fs.writeFileSync(path.join(OUT, "ship-failed.json"), JSON.stringify(report, null, 2));
  log("FAILED:", report.error.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
