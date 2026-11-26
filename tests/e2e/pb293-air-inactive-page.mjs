// PB-293 page leg: an INACTIVE aircraft's menu greys the missions the server refuses, and the CAP
// it does offer is accepted and ADDS its rounds to the readout. The pixels, not just the payload.
//
//   node tests/e2e/pb293-air-inactive-page.mjs                # starts its own server
//   node tests/e2e/pb293-air-inactive-page.mjs --url=<base>   # a running server
//   node tests/e2e/pb293-air-inactive-page.mjs --out=<dir>
//
// PM 9850 §4 / frodo 9848 §7: manual l.777 says an inactive aircraft may fly CAP and nothing else,
// and a CAP flown while it owes rounds ADDS its cost to the time it owes. The server half is pinned
// in web/test/nodes/pb293_air_inactivity.mjs; this leg pins what the PLAYER sees, through the real
// page, a real socket and a real server:
//
//   1. a READY plane's Air menu shows all four missions enabled and the row reads "ready" (control -
//      proves the disabled state below belongs to inactivity, not to a permanently greyed button);
//   2. after one CAP the plane is away 4 rounds: the Air menu now shows CAP ENABLED and Strike, Bomb
//      and Transfer DISABLED, and the readout column reads "4 rounds";
//   3. clicking the enabled CAP is ACCEPTED (one mission frame on the wire, no refusal note) and the
//      readout becomes "8 rounds" - the cost is ADDED to what the plane already owed, not reset;
//   4. the Kit door (toolRow) shows the same three refusals for the selected plane, so the two doors
//      agree on the pixels as well as on the payload.
//
// Screenshots are written for each state; the DOM's own disabled flags and the row's text are the
// assertions.
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
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb293-page")));
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
  const MENUS = { patrol: "Scramble (CAP)", strike: "Strike", bomb: "Bomb", transfer: "Transfer" };
  async function openAirMenu() {
    await page.click('.navbtn[data-dialog="air"]').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 })
      .catch(() => {});
  }
  async function readAirRow() {
    return page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => (r.children[0] ? r.children[0].textContent : "").trim() === String(id));
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

  // 1. control: a READY plane's menu has every mission enabled.
  await openAirMenu();
  const readyRow = await readAirRow();
  const readyShot = await shot("pb293-1-ready-menu");
  {
    const seen = (readyRow && readyRow.buttons || []).map((b) => b.label);
    const wanted = Object.values(MENUS);
    const missing = wanted.filter((label) => !seen.includes(label));
    const greyed = (readyRow && readyRow.buttons || []).filter((b) => b.disabled).map((b) => b.label);
    mark("a READY plane's Air menu lists all four missions",
      Boolean(readyRow) && missing.length === 0, "labels " + JSON.stringify(seen));
    mark("a READY plane's missions are all enabled (the control arm)", greyed.length === 0, "disabled " + JSON.stringify(greyed));
    mark("a READY plane's readout says ready", Boolean(readyRow) && /ready/i.test(readyRow.away), "away " + JSON.stringify(readyRow && readyRow.away));
    mark("evidence: ready menu screenshot", true, readyShot);
  }

  // 2. one CAP: the plane is now away for air.patrolRounds (4).
  const capFirst = await clickMission(MENUS.patrol);
  mark("the ready CAP button is clickable", Boolean(capFirst && capFirst.clicked), JSON.stringify(capFirst));
  await page.waitForFunction((id) => {
    const air = (window.__chq.room().seat || {}).air || [];
    const p = air.find((x) => String(x.id) === String(id));
    return Boolean(p) && p.ready === false;
  }, planeId, { timeout: 10000, polling: 100 }).catch(() => {});
  const afterFirst = ((await room()).seat.air || []).find((p) => String(p.id) === String(planeId)) || null;
  const owed = afterFirst ? Number(afterFirst.roundsLeft) : NaN;
  mark("the first CAP leaves the plane away for its own cost (4 rounds)", owed === 4, "roundsLeft " + owed);

  // 3. the menu while inactive: CAP enabled, the other three disabled, readout names the rounds.
  await openAirMenu();
  const awayRow = await readAirRow();
  const awayShot = await shot("pb293-2-inactive-menu");
  {
    const byLabel = new Map((awayRow && awayRow.buttons || []).map((b) => [b.label, b]));
    const cap = byLabel.get(MENUS.patrol);
    const others = [MENUS.strike, MENUS.bomb, MENUS.transfer].map((label) => ({ label, hit: byLabel.get(label) }));
    mark("an INACTIVE plane's menu still lists all four missions",
      others.every((o) => Boolean(o.hit)), "labels " + JSON.stringify([...byLabel.keys()]));
    mark("an INACTIVE plane's CAP is ENABLED", Boolean(cap) && cap.disabled === false, JSON.stringify(cap));
    const stillEnabled = others.filter((o) => o.hit && o.hit.disabled === false).map((o) => o.label);
    mark("an INACTIVE plane's Strike, Bomb and Transfer are DISABLED (the pixels)", stillEnabled.length === 0,
      "still enabled " + JSON.stringify(stillEnabled));
    mark("the disabled buttons say why (the title names the rounds it owes)",
      others.every((o) => o.hit && /away|rounds/i.test(o.hit.title)),
      JSON.stringify(others.map((o) => o.hit && o.hit.title)));
    mark("the readout column reads the 4 rounds it owes", Boolean(awayRow) && /^4 rounds$/.test(awayRow.away), "away " + JSON.stringify(awayRow && awayRow.away));
    mark("evidence: inactive menu screenshot", true, awayShot);

    // The readout must be PAINTED, not merely present in the DOM: a 12 px cell can hold the text and
    // still be clipped or drawn in the background's own colour. Measure the cell's box, its overflow
    // and its computed colour, then crop it at 1:1 so the value is legible in the evidence.
    const awayBox = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => (r.children[0] ? r.children[0].textContent : "").trim() === String(id));
      if (!row || !row.children[2]) return null;
      const el = row.children[2];
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const rowBg = getComputedStyle(row).backgroundColor;
      // OCCLUSION is the arm the first version of this leg missed: the value can be in the DOM, have a
      // full-size box, a light colour, no clipping — and still be painted UNDER a button that overflowed
      // leftward out of the next column. The top element at the cell's own centre is the witness.
      const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const top = stack[0] || null;
      return {
        text: (el.textContent || "").trim(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        color: cs.color, background: rowBg, opacity: Number(cs.opacity),
        clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        clips: el.scrollWidth > el.clientWidth + 1,
        topmost: top ? top.tagName + "." + top.className : null,
        onTop: Boolean(top) && (top === el || el.contains(top)),
      };
    }, planeId);
    const awayCellShot = path.join(OUT, "pb293-2b-away-cell.png");
    if (awayBox && awayBox.rect.width > 0 && awayBox.rect.height > 0) {
      await page.screenshot({ path: awayCellShot, clip: awayBox.rect }).catch(() => {});
    }
    mark("the readout cell has a box with the value inside it, unclipped and opaque",
      Boolean(awayBox) && awayBox.rect.width >= 40 && awayBox.rect.height >= 12 && awayBox.clips === false
        && awayBox.opacity > 0.5 && /^4 rounds$/.test(awayBox.text),
      JSON.stringify(awayBox && { rect: awayBox.rect, clips: awayBox.clips, opacity: awayBox.opacity, color: awayBox.color, scroll: awayBox.scrollWidth + "/" + awayBox.clientWidth }));
    mark("the readout is the TOP-MOST element at its own centre (no button paints over the number)",
      Boolean(awayBox) && awayBox.onTop === true,
      JSON.stringify(awayBox && { topmost: awayBox.topmost, onTop: awayBox.onTop }));
    mark("evidence: away cell cropped at 1:1 (the pixels carry the value)", true, awayCellShot);
  }

  // 4. clicking the CAP is ACCEPTED, and the readout ADDS 4 rounds (4 -> 8).
  const framesBefore = (await sentFrames()).length;
  const capSecond = await clickMission(MENUS.patrol);
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
  mark("the menu's readout now reads 8 rounds", Boolean(afterRow) && /^8 rounds$/.test(afterRow.away),
    "away " + JSON.stringify(afterRow && afterRow.away));
  {
    const box8 = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll("#dialogBody .airtable .buyrow")].filter((r) => !r.classList.contains("head"));
      const row = rows.find((r) => (r.children[0] ? r.children[0].textContent : "").trim() === String(id));
      if (!row || !row.children[2]) return null;
      const r = row.children[2].getBoundingClientRect();
      const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const top = stack[0] || null;
      const el = row.children[2];
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
        text: (el.textContent || "").trim(),
        topmost: top ? top.tagName + "." + top.className : null,
        onTop: Boolean(top) && (top === el || el.contains(top)) };
    }, planeId);
    const shot8 = path.join(OUT, "pb293-3b-away-cell-after-cap.png");
    if (box8 && box8.width > 0 && box8.height > 0) {
      await page.screenshot({ path: shot8, clip: box8 }).catch(() => {});
    }
    mark("the 8-round readout is painted in the same cell and stays on top (the pixels grew with the cost)",
      Boolean(box8) && box8.width >= 40 && box8.height >= 12 && /^8 rounds$/.test(box8.text) && box8.onTop === true,
      JSON.stringify(box8) + " -> " + shot8);
  }
  mark("evidence: post-CAP screenshot", true, afterShot);

  // 5. the second door: the Kit panel's toolRow for the selected plane greys the same three.
  await page.evaluate(() => {
    const el = document.querySelector("#dialogClose");
    if (el) el.click();
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(200);
  await clickCell(bought.cell);
  await page.click('.navbtn[data-dialog="kit"]').catch(() => {});
  await page.waitForSelector("#dialogBody button", { timeout: 8000 }).catch(() => {});
  const kit = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("#dialogBody button.buy")].map((b) => ({
      label: (b.textContent || "").trim(),
      disabled: Boolean(b.disabled),
    }));
    const wanted = ["Scramble (CAP)", "Strike", "Bomb", "Transfer"];
    return wanted.map((label) => {
      const hit = buttons.find((b) => b.label === label || b.label.startsWith(label + " ("));
      return hit ? { label, disabled: hit.disabled } : { label, missing: true };
    });
  });
  const kitShot = await shot("pb293-4-kit-door");
  {
    const cap = kit.find((k) => k.label === MENUS.patrol);
    const others = kit.filter((k) => k.label !== MENUS.patrol);
    mark("the Kit door lists all four missions for the selected plane", kit.every((k) => !k.missing), JSON.stringify(kit));
    mark("the Kit door's CAP is enabled", Boolean(cap) && cap.disabled === false, JSON.stringify(cap));
    mark("the Kit door's Strike/Bomb/Transfer are disabled too (the two doors agree)",
      others.every((k) => k.disabled === true), JSON.stringify(others));
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
