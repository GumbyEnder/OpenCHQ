// PB-293 page leg: an INACTIVE aircraft's menu offers CAP alone, and the CAP it offers is accepted
// and ADDS its rounds to the readout. The pixels, not just the payload.
//
//   node tests/e2e/pb293-air-inactive-page.mjs                # starts its own server
//   node tests/e2e/pb293-air-inactive-page.mjs --url=<base>   # a running server (the pin tree: red)
//   node tests/e2e/pb293-air-inactive-page.mjs --out=<dir>
//
// PM 9850 §4 + PM 9860 §2 (adopting frodo 9857 §4) / manual p.24: an inactive aircraft may fly CAP
// and nothing else, and a CAP flown while it owes rounds ADDS its cost to the time it owes. The
// server half is pinned in web/test/nodes/pb293_air_inactivity.mjs; this leg pins what the PLAYER
// sees, through a real page, a real socket and a real server:
//
//   1. control: a READY plane's Air menu lists all four missions, all enabled, readout "ready" -
//      so the absence in step 2 belongs to inactivity, not to a page that never renders a mission;
//   2. after one CAP (4 rounds) the menu offers exactly ONE control, an ENABLED "Scramble (CAP)",
//      and Strike/Bomb/Transfer are ABSENT - not greyed, not present at all (manual p.24);
//   3. clicking that CAP puts exactly one patrol frame on the wire, is ACCEPTED with no refusal,
//      and the readout goes from "4 rounds" to "8 rounds" - the cost is ADDED, not reset;
//   4. the Kit door (toolRow) offers the same single mission for the selected plane.
//
// The readout is checked as PIXELS: the AWAY cell must be the top-most element at its own centre
// (elementsFromPoint) and a 1:1 crop of it is written as evidence, so a value painted under a
// neighbouring button cannot pass. Screenshots accompany each state.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const ERA = "1986";
const OUT = evidenceDir("pb293-page", argOf("out"));
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
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
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

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb293-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  } else {
    mark("a given server answers", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    window.__sentFrames = [];
    WebSocket.prototype.send = function (data) {
      try { window.__sentFrames.push(String(data)); } catch (err) { void err; }
      return send.call(this, data);
    };
  });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const sentFrames = () => page.evaluate(() => (window.__sentFrames || []).slice());
  const noteText = () => page.evaluate(() => {
    const el = document.querySelector("#flashLine") || document.querySelector("#boardNote");
    return el ? String(el.textContent || "") : "";
  });

  async function shot(name) {
    const file = path.join(OUT, name + ".png");
    await page.screenshot({ path: file });
    return file;
  }

  async function setClock(want) {
    for (let i = 0; i < 6; i++) {
      const cur0 = await room();
      if (!cur0) return false;
      const now = cur0.clock === "running" ? "running" : "held";
      if (now === want) return true;
      await page.click("#clockBtn").catch(() => {});
      await page.waitForFunction((w) => {
        const r = window.__chq.room();
        return Boolean(r) && (r.clock === "running" ? "running" : "held") === w;
      }, want, { timeout: 8000, polling: 100 }).catch(() => {});
      await sleep(150);
    }
    return false;
  }

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

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb293-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  let cur = await room();
  mark("Play a bot opens a 1986 match", Boolean(cur && cur.seat), "round " + (cur && cur.round));
  if (cur && cur.clock === "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
    cur = await room();
  }
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

  // ---------------------------------------------------------------- buy and place an aircraft
  const board0 = await page.evaluate(() => (window.__chq.boardWidth ? window.__chq.boardWidth() : 320)).catch(() => 320);
  const WIDTH = Number(board0) || 320;
  const awayOn = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(WIDTH - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };
  async function buyAircraft() {
    const before = new Set(((await room()).pieces || []).map((p) => p.id));
    await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
    await sleep(250);
    const row = await page.evaluate(() => {
      const el = document.querySelector('button.buyrow[data-kind="aircraft"]');
      return el ? { disabled: Boolean(el.disabled), text: el.textContent.trim().slice(0, 80) } : null;
    });
    if (!row || row.disabled) return { error: "the aircraft row is missing or greyed: " + JSON.stringify(row) };
    await page.click('button.buyrow[data-kind="aircraft"]');
    const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
      .then(() => true).catch(() => false);
    if (!armed) return { error: "the aircraft purchase did not arm a placement" };
    const view = await room();
    const mine = new Set(((view.sites || []).filter((s) => s.owner === "blue")).map((s) => s.x + "," + s.y));
    const taken = new Set((view.pieces || []).map((p) => p.x + "," + p.y));
    const ports = (view.sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
    const cells = await page.evaluate(() => window.__chq.legalCells(8000));
    const scored = (cells || [])
      .filter((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y))
      .map((c) => ({ c, near: ports.length ? Math.min(...ports.map((s) => awayOn(c, s))) : 999 }));
    const inside = scored.filter((s) => s.near <= 6).sort((a, b) => b.near - a.near || b.c.x - a.c.x);
    const berth = inside[0] || scored.sort((a, b) => a.near - b.near)[0] || null;
    const pick = berth ? berth.c : null;
    if (!pick) return { error: "no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")" };
    await clickCell(pick);
    await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
      .catch(() => {});
    const after = await room();
    const plane = (after.pieces || []).find((p) => !before.has(p.id));
    if (!plane) return { error: "the aircraft never appeared on the board" };
    return { plane, cell: pick, near: berth.near, row: row.text };
  }

  const bought = await buyAircraft();
  if (bought.error) throw new Error(bought.error);
  const planeId = bought.plane.id;
  mark("an aircraft is bought and berthed", true, "plane " + planeId + " near " + bought.near);

  // ---------------------------------------------------------------- the Air menu, read from the DOM
  const CAP = "Scramble (CAP)";
  const OTHERS = ["Strike", "Bomb", "Transfer"];
  async function openAirMenu() {
    await page.click('.navbtn[data-dialog="air"]').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 })
      .catch(() => {});
  }
  async function readAirRow() {
    return page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || (c.textContent || "").trim()) === String(id); });
      if (!row) return null;
      const buttons = [...row.querySelectorAll("button")].map((b) => ({
        label: (b.textContent || "").trim(),
        disabled: Boolean(b.disabled),
        title: b.title || "",
      }));
      return { away: (row.children[2] ? row.children[2].textContent : "").trim(), buttons };
    }, planeId);
  }
  async function clickMission(label) {
    return page.evaluate((want) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      for (const row of rows) {
        for (const b of row.querySelectorAll("button")) {
          if ((b.textContent || "").trim() !== want) continue;
          if (b.disabled) return { clicked: false, disabled: true };
          b.click();
          return { clicked: true };
        }
      }
      return { clicked: false, missing: true };
    }, label);
  }
  // The readout as PIXELS: the cell's box, its overflow, and whether it is the top-most element at
  // its own centre. A value painted under a neighbouring button fails the last one.
  async function readAwayCell() {
    return page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => { const c = r.children[0]; return Boolean(c) && String(c.dataset.piece || (c.textContent || "").trim()) === String(id); });
      if (!row || !row.children[2]) return null;
      const el = row.children[2];
      const r = el.getBoundingClientRect();
      const top = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)[0] || null;
      return {
        text: (el.textContent || "").trim(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        clips: el.scrollWidth > el.clientWidth + 1,
        opacity: Number(getComputedStyle(el).opacity),
        topmost: top ? top.tagName + "." + top.className : null,
        onTop: Boolean(top) && (top === el || el.contains(top)),
      };
    }, planeId);
  }
  async function cropAway() {
    const box = await readAwayCell();
    if (!box || box.rect.width <= 0 || box.rect.height <= 0) return null;
    const file = path.join(OUT, "pb293-away-" + Date.now().toString(36) + ".png");
    await page.screenshot({ path: file, clip: box.rect }).catch(() => {});
    return { box, file };
  }

  // 1. control: a READY plane's menu has every mission.
  await openAirMenu();
  const readyRow = await readAirRow();
  const readyShot = await shot("pb293-1-ready-menu");
  {
    const seen = (readyRow && readyRow.buttons || []).map((b) => b.label);
    const missing = [CAP].concat(OTHERS).filter((label) => !seen.includes(label));
    const greyed = (readyRow && readyRow.buttons || []).filter((b) => b.disabled).map((b) => b.label);
    mark("a READY plane's Air menu lists all four missions", Boolean(readyRow) && missing.length === 0, "labels " + JSON.stringify(seen));
    mark("a READY plane's missions are all enabled (the control arm)", greyed.length === 0, "disabled " + JSON.stringify(greyed));
    mark("a READY plane's readout says ready", Boolean(readyRow) && /ready/i.test(readyRow.away), "away " + JSON.stringify(readyRow && readyRow.away));
    mark("evidence: ready menu screenshot", true, readyShot);
  }

  // 2. one CAP: the plane is now away for air.patrolRounds (4).
  const capFirst = await clickMission(CAP);
  mark("the ready CAP button is clickable", Boolean(capFirst && capFirst.clicked), JSON.stringify(capFirst));
  await page.waitForFunction((id) => {
    const air = (window.__chq.room().seat || {}).air || [];
    const p = air.find((x) => String(x.id) === String(id));
    return Boolean(p) && p.ready === false;
  }, planeId, { timeout: 10000, polling: 100 }).catch(() => {});
  const afterFirst = ((await room()).seat.air || []).find((p) => String(p.id) === String(planeId)) || null;
  const owed = afterFirst ? Number(afterFirst.roundsLeft) : NaN;
  mark("the first CAP leaves the plane away for its own cost (4 rounds)", owed === 4, "roundsLeft " + owed);

  // 3. the menu while inactive: CAP alone, and it is enabled.
  await openAirMenu();
  const awayRow = await readAirRow();
  const awayShot = await shot("pb293-2-inactive-menu");
  let awayAtFirstCap = null;
  {
    const labels = (awayRow && awayRow.buttons || []).map((b) => b.label);
    const caps = (awayRow && awayRow.buttons || []).filter((b) => b.label === CAP);
    const present = OTHERS.filter((label) => labels.includes(label));
    mark("an INACTIVE plane's menu offers exactly ONE control", labels.length === 1, "labels " + JSON.stringify(labels));
    mark("that control is an ENABLED \"Scramble (CAP)\"", caps.length === 1 && caps[0].disabled === false, JSON.stringify(caps));
    mark("Strike, Bomb and Transfer are ABSENT, not merely greyed (manual p.24)", present.length === 0,
      "still present " + JSON.stringify(present));
    mark("the readout column reads the 4 rounds it owes", Boolean(awayRow) && /^4 rounds$/.test(awayRow.away), "away " + JSON.stringify(awayRow && awayRow.away));
    const crop = await cropAway();
    awayAtFirstCap = crop;
    mark("the readout is the TOP-MOST element at its own centre and unclipped",
      Boolean(crop) && crop.box.onTop === true && crop.box.clips === false && /^4 rounds$/.test(crop.box.text),
      JSON.stringify(crop && { box: crop.box.rect, onTop: crop.box.onTop, topmost: crop.box.topmost, clips: crop.box.clips, text: crop.box.text }));
    mark("evidence: inactive menu + 1:1 readout crop (must read \"4 rounds\")", true, awayShot + " + " + (crop && crop.file));
  }

  // 4. clicking the CAP is ACCEPTED, and the readout ADDS 4 rounds (4 -> 8).
  const framesBefore = (await sentFrames()).length;
  const capSecond = await clickMission(CAP);
  mark("the inactive CAP button is clickable (not disabled)", Boolean(capSecond && capSecond.clicked), JSON.stringify(capSecond));
  const newFrames = (await sentFrames()).slice(framesBefore)
    .filter((line) => /"op"\s*:\s*"mission"/.test(String(line)) && /"mode"\s*:\s*"patrol"/.test(String(line)));
  mark("exactly one patrol mission frame went on the wire", newFrames.length === 1, "frames " + newFrames.length);
  await page.waitForFunction((id) => {
    const air = (window.__chq.room().seat || {}).air || [];
    const p = air.find((x) => String(x.id) === String(id));
    return Boolean(p) && Number(p.roundsLeft) === 8;
  }, planeId, { timeout: 10000, polling: 100 }).catch(() => {});
  const afterSecond = ((await room()).seat.air || []).find((p) => String(p.id) === String(planeId)) || null;
  const owedAfter = afterSecond ? Number(afterSecond.roundsLeft) : NaN;
  mark("the CAP was ACCEPTED: the plane now owes 8 rounds (4 + the CAP's 4, added not reset)",
    owedAfter === 8, "roundsLeft " + owed + " -> " + owedAfter);
  const refusal = await noteText();
  mark("no refusal line replaced the order (the page said the mission was ordered)",
    !/inactive for|refus|cannot|not ready/i.test(refusal), JSON.stringify(refusal.slice(0, 160)));

  await openAirMenu();
  const afterRow = await readAirRow();
  const afterShot = await shot("pb293-3-after-second-cap");
  {
    const crop8 = await cropAway();
    mark("the menu's readout now reads 8 rounds", Boolean(afterRow) && /^8 rounds$/.test(afterRow.away),
      "away " + JSON.stringify(afterRow && afterRow.away));
    mark("the 8-round readout is painted in the same cell and stays on top (the pixels grew with the cost)",
      Boolean(crop8) && crop8.box.onTop === true && /^8 rounds$/.test(crop8.box.text),
      JSON.stringify(crop8 && { box: crop8.box.rect, onTop: crop8.box.onTop, text: crop8.box.text }) + " -> " + (crop8 && crop8.file));
    mark("evidence: post-CAP screenshot", true, afterShot);
  }

  // 5. the second door: the Kit panel's toolRow for the selected plane offers the same single mission.
  await page.evaluate(() => {
    const el = document.querySelector("#dialogClose");
    if (el) el.click();
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(200);
  await clickCell(bought.cell);
  await page.click('.navbtn[data-dialog="kit"]').catch(() => {});
  await page.waitForSelector("#dialogBody button", { timeout: 8000 }).catch(() => {});
  const kit = await page.evaluate(() => [...document.querySelectorAll("#dialogBody button.buy")].map((b) => ({
    label: (b.textContent || "").trim(),
    disabled: Boolean(b.disabled),
  })));
  const kitShot = await shot("pb293-4-kit-door");
  {
    const capHit = kit.filter((b) => b.label === CAP || b.label.startsWith(CAP + " ("));
    const others = kit.filter((b) => ["Strike", "Bomb", "Transfer"].some((l) => b.label === l || b.label.startsWith(l + " (")));
    mark("the Kit door offers the CAP for the selected plane", capHit.length === 1 && capHit[0].disabled === false, JSON.stringify(capHit));
    mark("the Kit door offers no Strike/Bomb/Transfer either (the two doors agree)", others.length === 0, JSON.stringify(others));
    mark("evidence: Kit-door screenshot", true, kitShot);
  }

  mark("no page error", pageErrors.length === 0, pageErrors.join(" | "));
  await context.close();
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGKILL");
  writeFileSync(path.join(OUT, "pb293-page.json"), JSON.stringify({ base: BASE, evidence }, null, 2));
  console.log("");
  console.log("pb293 page leg: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);
  process.exit(failed ? 1 : 0);
}
