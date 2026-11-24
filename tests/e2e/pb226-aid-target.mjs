// PB-226 leg: foreign aid names its city, on a real page, a real socket and a real server.
//
//   node tests/e2e/pb226-aid-target.mjs                 # starts its own server from this tree
//   node tests/e2e/pb226-aid-target.mjs --url=<base>    # use a running server; it MUST be debug-on
//
// The defect this leg exists for: the Aid button sent {op:"tool", tool:"aid"} with no target, and
// the server ignored the target the wire already carried — it filtered enemy cities, sorted by id
// and turned the first. So the player picked nothing and paid for a city nobody chose. PB-227 (the
// enemy home-country ban) and PB-228 (staged loyalty per nation) sit on top of this leg.
//
// What is measured:
//   1. the Aid button arms a PICKER: the board note says so, no {op:"tool"} frame goes out, and
//      the seat's pool has not moved;
//   2. clicking an enemy city sends that cell as the target, the city changes hands, the note is
//      the aid line, the log names the city, and the pool drops by exactly the config price;
//   3. Escape disarms: an armed aid is dropped and the next click is an ordinary map click;
//   4. a refused pick (a cell with no city) says the server's sentence and charges 0.
//
// Evidence: the page's own room view (window.__chq.room/note), the frames the page actually wrote
// (WebSocket.send is wrapped before the app runs), and the server's debug dump for the site row.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb226")));
mkdirSync(OUT, { recursive: true });

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
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir, OPENCHQ_DEBUG: "1" };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) {
        clearTimeout(timer);
        resolve(child);
      }
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
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb226-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers with the debug dump on", true, BASE);
  } else {
    const probe = await fetch(BASE + "/api/debug/room?id=none").catch(() => null);
    const body = probe ? await probe.json().catch(() => ({})) : {};
    if (!probe || probe.status !== 404 || /debug is off/.test(String(body.error || ""))) {
      throw new Error("this leg reads /api/debug/room, which is off on " + BASE
        + " (start that host with OPENCHQ_DEBUG=1, or run with no --url to start one here)");
    }
    mark("the given host serves the debug dump", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  // "No tool frame went out" is a claim about the socket, so the socket is measured: every frame
  // the page writes is recorded before the app's own handlers run.
  await context.addInitScript(() => {
    window.__sentFrames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { window.__sentFrames.push(String(data)); } catch { /* ignore */ }
      return send.call(this, data);
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  // say() paints the page's flash line; window.__chq.toast() is that element.
  const said = () => page.evaluate(() => window.__chq.toast());
  const sentFrames = () => page.evaluate(() => (window.__sentFrames || []).slice());
  const toolFrames = async () => (await sentFrames())
    .map((text) => { try { return JSON.parse(text); } catch { return null; } })
    .filter((frame) => frame && frame.op === "tool");

  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(250);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(160);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(160);
    return true;
  }

  async function openKit() {
    // The kit row lives in the Kit dialogue; the Aid button arms the picker and the dialogue
    // closes, which is the same door a player uses.
    if (!(await page.isVisible("div.shop.tools button.buy"))) {
      await page.click('.navbtn[data-dialog="kit"]').catch(() => {});
      await page.waitForSelector("div.shop.tools button.buy", { timeout: 8000 }).catch(() => {});
    }
  }

  async function aidButton() {
    return page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("div.shop.tools button.buy"));
      const el = buttons.find((button) => button.textContent.trim() === "Foreign aid");
      return el ? { disabled: Boolean(el.disabled), text: el.textContent.trim(), title: el.title } : null;
    });
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb226-" + Date.now().toString(36).slice(-8);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  mark("a throwaway player registers", true, name);

  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  let cur = await room();
  mark("Play a bot opens a 1986 match", Boolean(cur && cur.seat), "round " + (cur && cur.round));

  // A tool is spent in a running match (a held clock refuses), so the clock stays running. The
  // round is 5 s at speed 1, so a round may turn under the measurement; nothing here reads rounds.
  async function setClock(want) {
    for (let i = 0; i < 6; i++) {
      const cur0 = await room();
      if (!cur0) return false;
      if ((cur0.clock === "running" ? "running" : "held") === want) return true;
      await page.click("#clockBtn").catch(() => {});
      await page.waitForFunction((w) => {
        const r = window.__chq.room();
        return Boolean(r) && (r.clock === "running" ? "running" : "held") === w;
      }, want, { timeout: 8000, polling: 100 }).catch(() => {});
      await sleep(150);
    }
    return false;
  }

  const running = await setClock("running");
  mark("the clock runs, so a tool is not refused for the pause", running, "clock " + ((await room()).clock));

  await openKit();
  const aid = await aidButton();
  mark("the Kit row carries an enabled Foreign aid button", Boolean(aid && !aid.disabled), JSON.stringify(aid));

  // ---------------------------------------------------------------- 1. the button arms a picker
  const cash0 = Number((await room()).seat.cash);
  const frames0 = (await toolFrames()).length;
  await page.click("div.shop.tools button.buy:has-text('Foreign aid')");
  await sleep(250);
  const armedNote = await said();
  const frames1 = (await toolFrames()).length;
  const cash1 = Number((await room()).seat.cash);
  mark("the Aid button arms a picker instead of spending: the note asks for a city",
    /pick the city you want to sway/i.test(armedNote), armedNote);
  mark("arming sends no tool frame", frames1 === frames0, "tool frames " + frames0 + " -> " + frames1);
  mark("arming does not charge the pool", cash1 === cash0, "cash " + cash0 + " -> " + cash1);

  // ---------------------------------------------------------------- 2. the pick is the target
  const view = await room();
  const redCities = (view.sites || []).filter((site) => site.owner === "red" && site.kind === "city");
  if (!redCities.length) throw new Error("the 1986 board has no red city to turn");
  // The city the OLD code would have turned is the lowest id; picking another one proves the pick.
  const lowest = redCities.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
  const target = redCities.filter((site) => site.id !== lowest.id).sort((a, b) => Number(a.id) - Number(b.id))[0] || lowest;
  const untouched = redCities.find((site) => site.id !== target.id) || null;
  // The price the room itself sells aid at, so the pool delta is checked against the server's own
  // number; the config price (10 billion) is asserted separately as the figure the manual carried.
  const shopRow = ((view.shop || []).find((row) => row.tool === "aid")) || null;
  const price = shopRow ? Number(shopRow.price) : NaN;
  mark("the room sells aid at the config price (10 billion)", price === 10000, "shop price " + price);

  // A cell with no site and no piece: the refusal arm needs one the page can click.
  const occupied = new Set([
    ...((view.sites || []).map((site) => Number(site.x) + "," + Number(site.y))),
    ...((view.pieces || []).map((piece) => Number(piece.x) + "," + Number(piece.y))),
  ]);
  let empty = null;
  for (let y = 130; y >= 5 && !empty; y -= 7) {
    for (let x = 5; x < 320; x += 7) {
      if (!occupied.has(x + "," + y)) { empty = { x, y }; break; }
    }
  }
  if (!empty) throw new Error("no empty cell to aim a refused aid at");

  await clickCell({ x: target.x, y: target.y });
  const frames2 = await toolFrames();
  const sent = frames2[frames2.length - 1];
  mark("the city click sends the cell as the aid's target",
    Boolean(sent) && sent.tool === "aid" && sent.to && Number(sent.to.x) === Number(target.x) && Number(sent.to.y) === Number(target.y),
    JSON.stringify(sent));
  await page.waitForFunction((siteId) => {
    const r = window.__chq.room();
    const site = r && (r.sites || []).find((row) => row.id === siteId);
    return site && site.owner === "blue";
  }, target.id, { timeout: 10000, polling: 100 }).catch(() => {});
  const after = await room();
  const turned = (after.sites || []).find((site) => site.id === target.id);
  const keptOut = untouched ? (after.sites || []).find((site) => site.id === untouched.id) : null;
  const cash2 = Number(after.seat.cash);
  const aidNote = await said();
  // A tool's line belongs to the round that follows it (lobby.mjs pushes the events onto the
  // match's pendingEvents), so the log names the city on the next round frame, not on the ack.
  // The round log arrives as its own {op:"log"} frame per round, so it is the PAGE's log buffer
  // (window.__chq.log), not room.log on the last room frame.
  const logged = await page.waitForFunction((cityName) => {
    return (window.__chq.log() || []).some((line) => String(line.text || "").includes("aid reached " + cityName));
  }, target.name, { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
  const logRows = await page.evaluate(() => window.__chq.log());
  const logText = logRows.map((line) => String(line.text || "")).join(" | ");
  mark("the city the player picked changes hands", Boolean(turned && turned.owner === "blue"),
    "site " + target.id + " " + target.name + " owner " + (turned && turned.owner));
  mark("no other enemy city changed hands", !keptOut || keptOut.owner === "red",
    keptOut ? "site " + keptOut.id + " owner " + keptOut.owner : "no control city");
  mark("the note is the aid line", /Foreign aid\. The city changed hands\./.test(aidNote), aidNote);
  mark("the log names the city the aid reached", logged,
    "lines=" + logRows.length + " aidLines=" + logRows.filter((line) => /aid/i.test(String(line.text || ""))).length + " tail=" + logText.slice(-260));
  mark("the pool paid exactly the aid price", cash2 === cash1 - price, "cash " + cash1 + " -> " + cash2);

  // ---------------------------------------------------------------- 3. Escape disarms
  await openKit();
  await page.click("div.shop.tools button.buy:has-text('Foreign aid')");
  await sleep(150);
  await page.keyboard.press("Escape");
  await sleep(150);
  const frames3 = (await toolFrames()).length;
  const spot = empty;
  await clickCell(spot);
  await sleep(300);
  const frames4 = (await toolFrames()).length;
  mark("Escape drops the armed aid, so the next click sends no tool frame", frames4 === frames3,
    "tool frames " + frames3 + " -> " + frames4 + " after a click at " + spot.x + "," + spot.y);

  // ---------------------------------------------------------------- 4. a refused pick costs 0
  const cash3 = Number((await room()).seat.cash);
  await openKit();
  await page.click("div.shop.tools button.buy:has-text('Foreign aid')");
  await sleep(150);
  await clickCell(spot);
  await sleep(400);
  const refusedNote = await said();
  const cash4 = Number((await room()).seat.cash);
  mark("a pick that holds no city is refused in the server's own sentence", /holds no city/i.test(refusedNote), refusedNote);
  mark("a refused aid charges 0", cash4 === cash3, "cash " + cash3 + " -> " + cash4);

  mark("no page error during the run", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
} finally {
  try {
    if (browser) await browser.close();
  } catch { /* ignore */ }
  try {
    if (server) server.kill("SIGKILL");
  } catch { /* ignore */ }
  const report = { at: new Date().toISOString(), base: BASE, era: ERA, failed, evidence };
  writeFileSync(path.join(OUT, "pb226-aid-target.json"), JSON.stringify(report, null, 2));
  console.log("PB-226 leg: " + evidence.filter((row) => row.ok).length + " passed / " + failed + " failed — " + path.join(OUT, "pb226-aid-target.json"));
  process.exitCode = failed ? 1 : 0;
}
