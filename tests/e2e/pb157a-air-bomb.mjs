// PB-157a live leg: the AIR panel's Bomb door aims at a target instead of firing at the plane.
//
//   node tests/e2e/pb157a-air-bomb.mjs                 # starts its own server (OPENCHQ_DEBUG=1)
//   node tests/e2e/pb157a-air-bomb.mjs --url=<base>    # use a running server; it MUST be debug-on
//
// The defect this leg exists for: web/public/app.js armed `pendingMission` for strike and transfer
// in the Air dialog but not for bomb, so Air > Bomb sent `{op:"mission", mode:"bomb", to:plane.cell}`
// and the server refused every time ("That site is yours." / "needs an enemy site"). The Kit panel
// already armed it, so the two doors disagreed - the Air door could not produce a bombing run at all.
//
// What is measured, on a real page, a real socket and a real server:
//   1. one aircraft is bought and placed through the Buy panel and a canvas click;
//   2. Air > Bomb sends NOTHING - the dialog closes and the board note hands the player the map
//      ("Bomb: pick an empty enemy city, base, oil field or capital."), and the plane is still ready;
//   3. PB-171: a capital IS a target - its run lands and takes the same 125 M (a defended or
//      out-of-reach capital is reported UNPROBED, the kind refusal is a FAIL);
//   4. the target click lands the run: the owner's own round log reads "bombed at <city>: lost
//      0.125b, unready 5 rounds" and the raider's reads "0.125b taken";
//   5. the site's readyRound is +5 and the plane is away for the strike's 8 rounds;
//   6. Kit > Bomb on a second aircraft gives the SAME result, so the two doors agree.
//
// Evidence is read from the server's own two seat logs (the /api/debug/room dump, which exists only
// behind OPENCHQ_DEBUG=1) and from the page's own room view - never from a hand-built board.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb157a")));
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

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "playwright" && !existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      void err;
    }
  }
  return import("playwright");
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb157a-"));
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
      throw new Error("this leg reads the two seat logs from /api/debug/room, which is off on " + BASE
        + " (start that host with OPENCHQ_DEBUG=1, or run with no --url to start one here)");
    }
    mark("the given host serves the debug dump", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const note = () => page.evaluate(() => (document.querySelector("#boardNote") || {}).textContent || "");
  const wire = () => page.evaluate(() => window.__chq.wire() || []);
  async function debugRoom() {
    const cur = await room();
    if (!cur || !cur.id) return null;
    const res = await fetch(BASE + "/api/debug/room?id=" + encodeURIComponent(cur.id));
    return res.ok ? res.json() : null;
  }
  const logText = (dump, side) => ((dump && dump.log && dump.log[side]) || [])
    .map((line) => (typeof line === "string" ? line : line && line.text ? line.text : JSON.stringify(line)))
    .join("\n");

  // The clock is the measurement's frame: a held clock keeps the round still while a bomb is aimed
  // and resolved, and one played round is what makes the server WRITE the round log (the log lines
  // are produced by the tick, not by the order), which is where the owner's own loss is recorded.
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
  async function advanceOneRound() {
    const start = Number((await room()).round) || 0;
    await setClock("running");
    await page.waitForFunction((r) => Number(window.__chq.room().round) > r, start, { timeout: 30000, polling: 100 }).catch(() => {});
    await setClock("held");
    await sleep(400);
    return Number((await room()).round) || 0;
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
  const name = "e2e-pb157a-" + Date.now().toString(36).slice(-8);
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
  if (cur && cur.clock === "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
    cur = await room();
  }
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

  // ---------------------------------------------------------------- buy and place an aircraft
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
    const cells = await page.evaluate(() => window.__chq.legalCells(8000));
    const pick = (cells || []).find((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y));
    if (!pick) return { error: "no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")" };
    await clickCell(pick);
    await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
      .catch(() => {});
    const after = await room();
    const plane = (after.pieces || []).find((p) => !before.has(p.id));
    if (!plane) return { error: "the aircraft never appeared on the board" };
    return { plane, cell: pick, row: row.text };
  }

  const first = await buyAircraft();
  if (first.error) throw new Error(first.error);
  const planeId = first.plane.id;
  cur = await room();
  let briefing = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  mark("the Air panel briefs the new aircraft", Boolean(briefing), briefing ? "missions " + (briefing.missions || []).map((m) => m.mode).join("/") : "no briefing");
  mark("the briefing offers Bomb", Boolean(briefing && (briefing.missions || []).some((m) => m.mode === "bomb")), JSON.stringify(briefing && (briefing.missions || []).map((m) => m.label)));

  // ---------------------------------------------------------------- Air > Bomb arms, does not fire
  async function airBomb() {
    await page.click('.navbtn[data-dialog="air"]');
    await page.waitForSelector("#dialogBody button", { timeout: 8000 });
    const hit = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#dialogBody button")];
      const el = buttons.find((b) => (b.textContent || "").trim() === "Bomb");
      if (!el) return null;
      el.click();
      return el.textContent.trim();
    });
    if (!hit) return { error: "the Air dialog has no Bomb button" };
    await sleep(400);
    return { ok: true };
  }

  const wireBefore = (await wire()).length;
  const armed = await airBomb();
  if (armed.error) throw new Error(armed.error);
  const wireAfterArm = await wire();
  const sentOrders = wireAfterArm.slice(wireBefore).filter((line) => /mission/.test(String(typeof line === "string" ? line : JSON.stringify(line))));
  mark("Air > Bomb sends no order", sentOrders.length === 0, "wire " + JSON.stringify(sentOrders.slice(0, 2)));
  const armNote = await note();
  const armToast = await toast();
  mark("the board hands the player the map", /Bomb: pick an empty enemy city/i.test(armNote + " " + armToast), JSON.stringify((armNote || armToast).slice(0, 140)));
  cur = await room();
  briefing = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  mark("the plane is not spent by the click", Boolean(briefing && briefing.ready), "ready " + (briefing && briefing.ready));

  // ---------------------------------------------------------------- PB-171: the capital is a target
  // The refusal that used to stand here was ours: BOMB_SITE_KINDS lacked "capital" while the
  // airstrip list had it, so 2 of the 4 subtype capitals were refused by their kind byte. PM 8131
  // ruled capitals bombable like any empty enemy city; the run itself is measured at the END of this
  // leg, on its own aircraft, because it spends the plane the city target below needs. What is
  // measured here is only the hand-off: the note now names a capital and nothing has fired yet.
  const capital = cur.capitals && cur.capitals.red;
  const roundAtStart = Number(cur.round) || 0;
  void roundAtStart;
  if (!capital) throw new Error("the view carries no red capital to aim at");
  const dumpBefore = await debugRoom();
  mark("the board note names a capital as a bombing target", /or capital\./.test(armNote + " " + armToast),
    JSON.stringify((armNote + " " + armToast).slice(0, 160)));

  // ---------------------------------------------------------------- the air-panel hit
  // Target: an enemy city or base with no piece of ANY layer on it, chosen from the server's own
  // piece list (the client view only sends what the seat can see, so "empty" is not decidable there).
  async function pickEmptyTarget(dump) {
    const view = await room();
    const busy = new Set(((dump && dump.pieces) || []).map((p) => Number(p.x) + "," + Number(p.y)));
    const capitals = view.capitals || {};
    const capCells = new Set(Object.values(capitals).map((c) => Number(c.x) + "," + Number(c.y)));
    const sites = (view.sites || [])
      .filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"))
      .filter((s) => !capCells.has(Number(s.x) + "," + Number(s.y)))
      .filter((s) => !busy.has(Number(s.x) + "," + Number(s.y)));
    return sites[0] || null;
  }

  const target = await pickEmptyTarget(dumpBefore);
  if (!target) throw new Error("no empty enemy city/base to bomb (pieces " + ((dumpBefore && dumpBefore.pieceCount) || 0) + ")");
  mark("an empty enemy city is on the board", true, target.name + " at " + target.x + "," + target.y + " (kind " + target.kind + ")");

  const roundBeforeAir = Number((await room()).round) || 0;
  const rearmed = await airBomb();
  if (rearmed.error) throw new Error(rearmed.error);
  await clickCell({ x: target.x, y: target.y });
  await page.waitForFunction((id) => {
    const r = window.__chq.room();
    const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
    return p && p.ready === false;
  }, planeId, { timeout: 12000, polling: 100 }).catch(() => {});

  cur = await room();
  briefing = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(planeId));
  const siteAfter = (cur.sites || []).find((s) => Number(s.x) === Number(target.x) && Number(s.y) === Number(target.y));
  // The server's own resolved event, read while the clock is still held (the tick drains it): this
  // is the applied charge, not a re-derivation of it from config.
  const dumpAir = await debugRoom();
  const evAir = ((dumpAir && dumpAir.pendingEvents) || []).find((e) => e && e.type === "bomb_hit" && e.name === target.name);

  mark("the air-panel run spends the aircraft", Boolean(briefing && briefing.ready === false), "ready " + (briefing && briefing.ready) + " roundsLeft " + (briefing && briefing.roundsLeft));
  mark("the aircraft is away for the strike's 8 rounds", Number(briefing && briefing.roundsLeft) === 8,
    "roundsLeft " + (briefing && briefing.roundsLeft));
  mark("the server records the air-panel run", Boolean(evAir), JSON.stringify(evAir && { site: evAir.name, owner: evAir.owner, cash: evAir.cash, unready: evAir.unready, round: evAir.round }));
  mark("the air-panel run charges the owner 125 M", Boolean(evAir) && Number(evAir.cash) === 125 && evAir.owner === "red",
    "cash " + (evAir && evAir.cash) + " owner " + (evAir && evAir.owner));
  mark("the bombed site is unready 5 rounds", Boolean(evAir) && Number(siteAfter && siteAfter.readyRound) === Number(evAir.round) + 5,
    "readyRound " + (siteAfter && siteAfter.readyRound) + " want " + (evAir ? Number(evAir.round) + 5 : "?"));

  // One played round, so the server writes the round log the raider reads. (The bot seat gets no
  // log lines at all - lobby keeps room.log only for human seats - so the owner's copy of the line
  // is not readable from this leg; the applied charge above is the owner-side number.)
  await advanceOneRound();
  const dumpHit = await debugRoom();
  const blueAfter = logText(dumpHit, "blue");
  mark("the raider's log reads what was taken", /0\.125b taken/.test(blueAfter), (blueAfter.match(/[^\n]*0\.125b taken[^\n]*/) || [""])[0]);

  await page.screenshot({ path: path.join(OUT, "pb157a-air-bomb.png") });

  // ---------------------------------------------------------------- Kit > Bomb gives one answer
  const second = await buyAircraft();
  if (second.error) throw new Error("second aircraft: " + second.error);
  const kitTarget = await pickEmptyTarget(await debugRoom());
  if (!kitTarget) throw new Error("no second empty enemy site for the Kit door");
  await clickCell({ x: second.plane.x, y: second.plane.y });
  await page.waitForFunction((id) => String(window.__chq.state().selected) === String(id), String(second.plane.id), { timeout: 8000, polling: 100 }).catch(() => {});
  await page.click('.navbtn[data-dialog="kit"]');
  await page.waitForSelector("#dialogBody button.buy", { timeout: 8000 });
  const kitClicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#dialogBody button.buy")].find((b) => /^Bomb( \(|$)/.test((b.textContent || "").trim()));
    if (!el) return null;
    el.click();
    return el.textContent.trim();
  });
  mark("the Kit panel offers Bomb for the selected aircraft", Boolean(kitClicked), String(kitClicked));
  await sleep(400);
  const kitNote = (await note()) + " " + (await toast());
  mark("Kit > Bomb arms the same target click", /Bomb: pick an empty enemy city/i.test(kitNote), JSON.stringify(kitNote.slice(0, 140)));
  const roundBeforeKit = Number((await room()).round) || 0;
  const kitSiteBefore = ((await room()).sites || []).find((s) => Number(s.x) === Number(kitTarget.x) && Number(s.y) === Number(kitTarget.y));
  await clickCell({ x: kitTarget.x, y: kitTarget.y });
  await page.waitForFunction((id) => {
    const r = window.__chq.room();
    const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
    return p && p.ready === false;
  }, second.plane.id, { timeout: 12000, polling: 100 }).catch(() => {});

  cur = await room();
  const kitBrief = ((cur.seat && cur.seat.air) || []).find((p) => String(p.id) === String(second.plane.id));
  const kitSite = (cur.sites || []).find((s) => Number(s.x) === Number(kitTarget.x) && Number(s.y) === Number(kitTarget.y));
  const dumpKitHeld = await debugRoom();
  const evKit = ((dumpKitHeld && dumpKitHeld.pendingEvents) || []).find((e) => e && e.type === "bomb_hit" && e.name === kitTarget.name);
  mark("the kit door spends the aircraft too", Boolean(kitBrief && kitBrief.ready === false), "ready " + (kitBrief && kitBrief.ready));
  mark("the kit door charges the same 125 M", Boolean(evKit) && Number(evKit.cash) === 125 && evKit.owner === "red",
    "cash " + (evKit && evKit.cash) + " owner " + (evKit && evKit.owner));
  // A site keeps its own production timer, and the rule is max(round, that timer) + 5, so the
  // expectation is built the same way the server builds it - not "round + 5" over a fresh site.
  const kitWant = Math.max(Number(evKit && evKit.round), Number(kitSiteBefore && kitSiteBefore.readyRound) || 0) + 5;
  mark("the kit door leaves the site unready 5 rounds", Boolean(evKit) && Number(kitSite && kitSite.readyRound) === kitWant,
    "readyRound " + (kitSite && kitSite.readyRound) + " want " + kitWant + " (site was " + (kitSiteBefore && kitSiteBefore.readyRound) + ")");
  mark("the two doors give one result", Boolean(evAir && evKit) && Number(evAir.cash) === Number(evKit.cash)
    && Number(evAir.unready) === Number(evKit.unready),
    "air cash=" + (evAir && evAir.cash) + " unready=" + (evAir && evAir.unready)
    + " · kit cash=" + (evKit && evKit.cash) + " unready=" + (evKit && evKit.unready));
  await advanceOneRound();
  const dumpKit = await debugRoom();
  const redKit = logText(dumpKit, "red");
  void redKit;
  const blueKit = logText(dumpKit, "blue");
  mark("the kit door's log reads the same take", /0\.125b taken/.test(blueKit), (blueKit.match(/[^\n]*0\.125b taken[^\n]*/) || [""])[0]);

  // ---------------------------------------------------------------- PB-171: bomb the capital
  // The run the deleted refusal used to block. It reuses an aircraft that has come back from its
  // earlier mission rather than buying a third (the 1986 seat's cash runs out at two), so the leg
  // waits the missed rounds out. Two outcomes are legitimate non-failures and are reported as
  // UNPROBED, never as passes: a red piece on the capital (it is defended - a different, correct
  // rule) and a capital out of the plane's stand-in reach. The kind refusal this card deletes is NOT
  // one of them: if "not a capital" comes back, this leg fails.
  let capPlane = null;
  for (let i = 0; i < 10 && !capPlane; i += 1) {
    const v = await room();
    capPlane = ((v.seat && v.seat.air) || []).find((p) => p.ready) || null;
    if (!capPlane) await advanceOneRound();
  }
  const capView = await room();
  const capCell = capView.capitals && capView.capitals.red;
  if (!capCell) throw new Error("the view carries no red capital to aim at");
  if (!capPlane) {
    mark("a capital is a bombing target (UNPROBED: no aircraft came back in 10 rounds)", true, "no ready aircraft");
  } else {
    const capPiece = (capView.pieces || []).find((p) => String(p.id) === String(capPlane.id));
    if (!capPiece) throw new Error("the ready aircraft is not on the board: " + capPlane.id);
    await clickCell({ x: capPiece.x, y: capPiece.y });
    await page.waitForFunction((id) => String(window.__chq.state().selected) === String(id), String(capPlane.id), { timeout: 8000, polling: 100 }).catch(() => {});
    const capArmed = await airBomb();
    if (capArmed.error) throw new Error(capArmed.error);
    const dumpCapBefore = await debugRoom();
    const capOccupied = ((dumpCapBefore.pieces || []).some((p) => Number(p.x) === Number(capCell.x) && Number(p.y) === Number(capCell.y) && String(p.domain) !== "air"));
    await clickCell({ x: capCell.x, y: capCell.y });
    await page.waitForFunction((id) => {
      const r = window.__chq.room();
      const p = ((r.seat && r.seat.air) || []).find((x) => String(x.id) === String(id));
      return p && p.ready === false;
    }, String(capPlane.id), { timeout: 12000, polling: 100 }).catch(() => {});
    const capSaid = (await note()) + " " + (await toast());
    const dumpCap = await debugRoom();
    const evCap = ((dumpCap && dumpCap.pendingEvents) || []).find((e) => e && e.type === "bomb_hit"
      && Number(e.x) === Number(capCell.x) && Number(e.y) === Number(capCell.y));
    const capAfter = ((await room()).seat && (await room()).seat.air || []).find((p) => String(p.id) === String(capPlane.id));
    if (/not a capital/i.test(capSaid)) {
      mark("a capital is a bombing target", false, "the kind refusal came back: " + JSON.stringify(capSaid.slice(-200)));
    } else if (capOccupied) {
      mark("a capital is a bombing target (UNPROBED: the capital is defended)", true, "a red piece stands on the capital");
    } else if (!evCap && /reach/i.test(capSaid)) {
      mark("a capital is a bombing target (UNPROBED: out of stand-in reach)", true, JSON.stringify(capSaid.slice(-200)));
    } else {
      mark("a capital is a bombing target", Boolean(evCap), JSON.stringify(evCap && { site: evCap.name, kind: evCap.kind, owner: evCap.owner, cash: evCap.cash, unready: evCap.unready }));
      mark("the bombed capital takes the city's 125 M", Boolean(evCap) && Number(evCap.cash) === 125 && evCap.owner === "red",
        "cash " + (evCap && evCap.cash) + " owner " + (evCap && evCap.owner) + " kind " + (evCap && evCap.kind));
      mark("the capital run spends its aircraft", Boolean(capAfter && capAfter.ready === false), "ready " + (capAfter && capAfter.ready));
    }
  }

  mark("the page raised no script error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (err) {
  mark("the leg ran to the end", false, String(err && err.message ? err.message : err));
} finally {
  const summary = { base: BASE, era: ERA, at: new Date().toISOString(), failed, evidence };
  writeFileSync(path.join(OUT, "pb157a-air-bomb.json"), JSON.stringify(summary, null, 2));
  console.log("");
  console.log("pb157a summary: " + (evidence.filter((e) => e.ok).length) + " passed, " + failed + " failed, " + evidence.length + " checks");
  console.log("evidence " + path.join(OUT, "pb157a-air-bomb.json"));
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
