// T-010 AC1: play a LIVE 1942 bot match to the end, driven with orders, and time it.
//
//   node tests/e2e/full-match.mjs --url=https://openchq-web-production.up.railway.app \
//        --speed=1 --gate=contact
//
// What it does, as a player would:
//   1. signs in (or registers a throwaway), opens Play a bot / 1942 / blue;
//   2. with the clock HELD, sends the opening infantry at the enemy column's line of march, and
//      buys one tank beside each enemy-held capital (never ON a capital - see --gate=none below);
//   3. presses Play and waits for first contact (a piece of ours carrying a `fighting` link);
//   4. pauses, orders every land piece at the nearest red-held capital, plays again;
//   5. screenshots the first "took <name>" line and the end screen, and stops at room().over.
//
// Every action goes through the page: the Buy rows, canvas clicks, #clockBtn and #speedUp. Nothing
// is stubbed. The rounds of first contact / first capture / end and the wall time of each leg are
// written to summary.json beside the screenshots.
//
// --gate=none  buys only, no phase gate (kept for the control leg: the same policy without the
//              pause-before-attack step).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
if (!BASE) { console.error("usage: node full-match.mjs --url=<live base>"); process.exit(2); }
const ERA = arg("era", "1942");
const WANT_SPEED = Number(arg("speed", "1")) || 1;
const GATE = arg("gate", "contact");
// --no-orders: the pure control leg. Buys happen, the opening infantry is sent at the midpoint,
// and nothing is ever ordered at a capital - no phase-2 attack, no phase-3 re-order.
const NO_ORDERS = process.argv.includes("--no-orders");
const MAX_MS = Number(arg("budget", "900000")) || 900000;
// --cap=<round>: stop the leg at this round even if nobody has won. T-015 AC4 compares two legs
// over the same round cap, so "none by cap" is a data point, not a failure; the leg only fails if
// the server stops advancing rounds while the clock says running (a stall), which is dumped.
const CAP = Number(arg("cap", "0")) || 0;
// A round at speed 6 is ~0.6 s; a minute without the round counter moving is not slow play.
const STALL_MS = Number(arg("stall-ms", "45000")) || 45000;
const OUT = path.join(here, "t010-full-match-" + ERA + "-s" + WANT_SPEED + "-" + new Date().toISOString().replace(/[:.]/g, "-"));

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const summary = { base: BASE, era: ERA, speed: WANT_SPEED, gate: GATE, startedAt: new Date().toISOString() };
function mark(ok, label, detail = "") {
  rows.push({ ok: Boolean(ok), label, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const room = () => page.evaluate(() => window.__chq.room());
const dist = (a, b) => {
  const raw = Math.abs(Number(a.x) - Number(b.x));
  const dx = Math.min(raw, 320 - raw);
  return Math.max(dx, Math.abs(Number(a.y) - Number(b.y)));
};
async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}
async function clickCell(cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const vp = page.viewportSize();
  if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
    await page.click("#camFit").catch(() => {});
    await sleep(250);
    const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    if (!again || again.x < 2 || again.y < 2 || again.x > vp.width - 2 || again.y > vp.height - 2) return false;
    await page.mouse.click(again.x, again.y);
    await sleep(160);
    return true;
  }
  await page.mouse.click(point.x, point.y);
  await sleep(160);
  return true;
}
async function clockIs(want) {
  const cur = await room();
  if (cur && cur.clock === want) return true;
  await page.click("#clockBtn").catch(() => {});
  await page.waitForFunction((w) => { const r = window.__chq.room(); return r && r.clock === w; }, want, { timeout: 8000, polling: 100 }).catch(() => {});
  const after = await room();
  return Boolean(after && after.clock === want);
}
async function setSpeed(want) {
  for (let i = 0; i < 10; i++) {
    if (Number((await room()).speed) === want) break;
    await page.click(Number((await room()).speed) < want ? "#speedUp" : "#speedDown").catch(() => {});
    await sleep(200);
  }
  const read = await page.evaluate(() => (document.querySelector("#speedReadout") || {}).textContent || "");
  return { shown: read.trim(), speed: Number((await room()).speed) };
}
async function orderTo(pieceId, cell) {
  const cur = await room();
  const me = (cur.pieces || []).find((p) => p.id === pieceId);
  if (!me) return { ok: false, why: "piece not in the view" };
  await clickCell({ x: me.x, y: me.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 6000 }).catch(() => {});
  const selected = await page.evaluate(() => window.__chq.state().selected);
  if (String(selected) !== String(pieceId)) return { ok: false, why: "not selected" };
  const pt = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.move(pt.x, pt.y);
  await sleep(250);
  // The note area is shared: an alarm ("A transport is crossing unscreened.") can hold it instead of
  // the route preview, so the order is verified by the server's own path, not by the preview text.
  const note = await page.evaluate(() => (document.querySelector("#boardNote") || {}).textContent || "");
  await clickCell(cell);
  await page
    .waitForFunction(
      (id) => {
        const r = window.__chq.room();
        const p = (r.pieces || []).find((x) => x.id === id);
        return p && Array.isArray(p.path) && p.path.length > 0;
      },
      pieceId,
      { timeout: 6000, polling: 100 }
    )
    .catch(() => {});
  const after = await room();
  const piece = (after.pieces || []).find((p) => p.id === pieceId);
  const moved = Boolean(piece && Array.isArray(piece.path) && piece.path.length > 0);
  return { ok: moved, note: note.slice(0, 120), path: piece ? piece.path.length : 0 };
}
// Buy one unit as near as the server's own mask allows, but never on a cell the target could be
// captured from at distance 0..3, and never on an enemy-held site: the point is a march, not a
// purchase that flips a capital in one round (that is reported as a defect, not used).
async function buyNear(kind, target, standoff = 4) {
  await page.click('#nav button[data-dialog="buy"]').catch(() => {});
  await sleep(200);
  const price = await page.evaluate((k) => {
    const row = document.querySelector('button.buyrow[data-kind="' + k + '"]');
    if (!row) return null;
    return { disabled: Boolean(row.disabled), text: row.textContent.trim().slice(0, 60) };
  }, kind);
  if (!price || price.disabled) {
    // The row greys out when the pool cannot cover it: not an error, just a "not yet".
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }
  await page.click('button.buyrow[data-kind="' + kind + '"]').catch(() => {});
  const armed = await page
    .waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 4000, polling: 100 })
    .then(() => true)
    .catch(() => false);
  if (!armed) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  const cur = await room();
  const cells = await page.evaluate(() => window.__chq.legalCells(6000));
  const taken = new Set((cur.pieces || []).map((p) => p.x + "," + p.y));
  const enemySite = new Set((cur.sites || []).filter((s) => s.owner && s.owner !== cur.you).map((s) => s.x + "," + s.y));
  const had = new Set((cur.pieces || []).map((p) => p.id));
  const pick = cells
    .filter((c) => !taken.has(c.x + "," + c.y) && !enemySite.has(c.x + "," + c.y) && dist(c, target) >= standoff)
    .sort((a, b) => dist(a, target) - dist(b, target))[0];
  if (!pick) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  const placed = await clickCell(pick);
  if (!placed) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  await page.waitForFunction((n) => window.__chq.room().pieces.some((p) => !n.includes(p.id)), [...had], { timeout: 15000 }).catch(() => {});
  const after = await room();
  // A new id is not necessarily OUR unit: the bot buys on the same tick, so a red piece that
  // appeared during the wait must not be mistaken for the tank we just placed. That mistake made
  // tanks[cap] point at an enemy piece, which quietly disabled the reinforce-on-death branch.
  return (after.pieces || []).find((p) => !had.has(p.id) && p.side === cur.you) || null;
}

const t0 = Date.now();
const timeline = { firstContact: null, firstCapture: null, end: null };
// --trace: every site-owner change the seat is shown, with the round and the pieces standing on
// that cell when it was first seen. This is what a capture looks like from outside: the room view
// carries owners, not events, so the poll interval is the resolution of the "how".
const TRACE = process.argv.includes("--trace");
// Cadence, measured, not assumed: (round, clock) at each poll, so the leg can say what the server
// actually ran at (rounds per running wall second) instead of what config/game.json would imply.
const cadence = [];
function cadenceStep(now) {
  if (!now) return;
  const last = cadence[cadence.length - 1];
  if (last && last.round === now.round && last.clock === now.clock) return;
  cadence.push({ t: Date.now(), round: Number(now.round), clock: now.clock });
}
function cadenceRate() {
  let rounds = 0, ms = 0;
  for (let i = 1; i < cadence.length; i++) {
    const a = cadence[i - 1], b = cadence[i];
    if (a.clock !== "running" || b.clock !== "running") continue;
    const dr = b.round - a.round;
    if (dr <= 0) continue;
    rounds += dr; ms += b.t - a.t;
  }
  return ms > 0 ? { rounds, ms, roundsPerSecond: Number((rounds / (ms / 1000)).toFixed(3)), secondsPerRound: Number((ms / 1000 / rounds).toFixed(3)) } : null;
}
const ownerTrace = new Map();
const traceLog = [];
function traceStep(now) {
  if (!now || !Array.isArray(now.sites)) return;
  for (const site of now.sites) {
    const key = site.id === null || site.id === undefined ? `s:${site.name}:${site.x},${site.y}` : String(site.id);
    const before = ownerTrace.has(key) ? ownerTrace.get(key) : undefined;
    ownerTrace.set(key, site.owner ?? null);
    if (before === undefined || before === (site.owner ?? null)) continue;
    const here = (now.pieces || []).filter((p) => p.x === site.x && p.y === site.y)
      .map((p) => `${p.side}:${p.domain}:${p.kind}`);
    const entry = {
      round: now.round,
      id: key,
      name: site.name,
      kind: site.kind,
      type: site.type,
      from: before ?? null,
      to: site.owner ?? null,
      by: here,
    };
    traceLog.push(entry);
    if (TRACE) console.log("TRACE " + JSON.stringify(entry));
  }
}
let endShot = null, captureShot = null;

// ---- the stall guard -------------------------------------------------------
// Two different things look the same from outside: a match nobody can win (rounds keep coming,
// no capital changes hands) and a server that has stopped running rounds (the counter freezes
// while the clock still says running). Only the second is a defect. The guard separates them by
// watching the round counter, and on a freeze it dumps what the server itself holds - not only
// what the seat is allowed to see - so the cause can be read after the fact.
let capped = false;
let stall = null;
let watchRound = null;
let watchAt = Date.now();
function guard(now) {
  if (!now) return null;
  if (CAP && Number(now.round) >= CAP) return "cap";
  if (now.over) return null;
  const round = Number(now.round);
  if (round !== watchRound) {
    watchRound = round;
    watchAt = Date.now();
    return null;
  }
  // A held clock is not a stall: the player paused it.
  if (now.clock !== "running") {
    watchAt = Date.now();
    return null;
  }
  return Date.now() - watchAt >= STALL_MS ? "stall" : null;
}
function serverState(now) {
  return {
    round: now ? now.round : null,
    clock: now ? now.clock : null,
    over: now ? now.over : null,
    pieces: (now && now.pieces || []).map((p) => ({
      id: p.id, side: p.side, domain: p.domain, kind: p.kind, x: p.x, y: p.y,
      path: Array.isArray(p.path) ? p.path.length : 0,
      fighting: p.fighting ?? null, shots: p.shots ?? 0,
      strength: p.strength, entrenched: Boolean(p.entrenched), pinned: Boolean(p.pinned),
    })),
    capitals: now ? now.capitalList : null,
  };
}
async function dumpStall(now, phase) {
  const id = summary.room;
  const raw = id
    ? await page.evaluate((rid) => fetch("/api/debug/room?id=" + encodeURIComponent(rid))
        .then((r) => (r.ok ? r.json() : { status: r.status, note: "no debug endpoint on this host" }))
        .catch((e) => ({ error: String(e) })), id).catch(() => null)
    : null;
  let shotPath = null;
  try { shotPath = await shot("06-stall-" + phase + "-r" + (now && now.round) + ".png"); } catch { /* the dump matters more */ }
  const payload = {
    at: new Date().toISOString(),
    phase,
    wallMs: Date.now() - timeline.playAt,
    stallMs: STALL_MS,
    client: serverState(now),
    server: raw,
    screenshot: shotPath,
  };
  writeFileSync(path.join(OUT, "stall-" + phase + ".json"), JSON.stringify(payload, null, 2));
  summary.stall = payload;
  console.log("STALL " + JSON.stringify({ phase, round: payload.client.round, clock: payload.client.clock, pieces: payload.client.pieces.length }));
  return payload;
}


try {
  mkdirSync(OUT, { recursive: true });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  summary.version = version;
  mark(Boolean(version && version.short), "live build", version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "fm" + Date.now().toString(36).slice(-8);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    summary.user = name;
    mark(true, "registered a throwaway user", name);
  } else {
    mark(true, "signed in with the browser's session");
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
  let r = await room();
  const you = r.you;
  summary.seat = you;
  summary.room = r.id;
  const capitals = (r.sites || []).filter((s) => Number(s.type) === 1 || Number(s.type) === 2);
  const foeCaps = capitals.filter((c) => c.owner && c.owner !== you);
  summary.capitalSet = capitals.map((c) => ({ name: c.name, x: c.x, y: c.y, owner: c.owner }));
  // Baseline for --trace: the owners at round 0, before the clock runs.
  traceStep(r);
  mark(capitals.length > 0 && foeCaps.length > 0, "the room names the era's capitals and which are enemy-held", { size: capitals.length, enemy: foeCaps.map((c) => c.name) });
  if (!foeCaps.length) throw new Error("no enemy-held capital in the room view");

  // T-012 AC7: the round-0 capital list, as the page draws it. The War panel prints the server's
  // `capitalList` - name and holder per capital - so this screenshot is the page's answer, not the
  // harness restating what it read from the socket.
  await page.click('#nav button[data-dialog="war"]').catch(() => {});
  await sleep(350);
  const roundZeroText = await page.evaluate(() => ((document.querySelector("#dialogBody") || {}).textContent || "").replace(/\s+/g, " ").trim());
  summary.roundZeroPanel = roundZeroText;
  await shot("00-capitals-round0.png");
  const panelNames = capitals.map((c) => c.name);
  mark(panelNames.every((n) => roundZeroText.includes(n + " — " + (capitals.find((c) => c.name === n).owner || "neutral"))),
    "the War panel lists every round-0 capital with the server's holder", roundZeroText);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(150);

  const speedRead = await setSpeed(WANT_SPEED);
  mark(Number(speedRead.speed) === WANT_SPEED, "speed set", speedRead);

  await clockIs("held");
  const opening = (r.pieces || []).find((p) => p.side === you && p.domain === "land");
  // The enemy column marches at our seat capital; send the opening infantry to the midpoint of the
  // two seat capitals, which is on the line of march and is open ground, not a cell we already hold.
  const foeSeat = r.capitals[you === "blue" ? "red" : "blue"];
  const ownSeat = r.capitals[you];
  const wrapX = (x) => ((x % 320) + 320) % 320;
  const intercept = foeSeat && ownSeat
    ? { x: wrapX(Math.round((ownSeat.x + foeSeat.x) / 2)), y: Math.round((ownSeat.y + foeSeat.y) / 2) }
    : { x: wrapX(opening.x + 30), y: opening.y };
  let ordered = opening ? await orderTo(opening.id, intercept) : { ok: false, why: "no opening land piece" };
  if (!ordered.ok && opening) {
    // fall back to a cell 6 east along the same line, still short of the enemy column
    const near = { x: wrapX(ownSeat.x + 6), y: ownSeat.y };
    ordered = await orderTo(opening.id, near);
    intercept.x = near.x; intercept.y = near.y;
  }
  mark(ordered.ok, "opening infantry ordered onto the enemy column's line of march", { piece: opening && opening.id, to: intercept, note: ordered.note || ordered.why });

  // One tank beside each enemy-held capital, bought now or as income allows later.
  const tanks = {};
  // pieceId -> the board's refusal, for a piece whose nearest red capital is out of march reach.
  const unreachable = new Map();
  // How many of our land pieces must stand beside a still-red capital before it can fall, and a
  // counter so the reinforcement buy runs every 5th retask instead of every one.
  const WANT_NEAR = 3;
  let retaskCount = 0;
  for (const cap of foeCaps) {
    const unit = await buyNear("tank", cap, 4);
    if (unit) tanks[cap.name] = unit.id;
    console.log("buy near " + cap.name + ": " + (unit ? unit.id + "@" + unit.x + "," + unit.y + " (d=" + dist(unit, cap) + ")" : "none yet"));
  }
  mark(Object.keys(tanks).length > 0, "a tank bought beside an enemy capital", tanks);
  await clockIs("held");
  await shot("01-match-open.png");
  mark(await clockIs("running"), "clock running");
  timeline.playAt = Date.now();

  // ---- phase 1: contact ----------------------------------------------------
  const deadline = Date.now() + MAX_MS;
  let contact = false;
  let lastBuyTry = 0;
  let lastBuyRound = null;
  while (Date.now() < deadline && !contact) {
    const now = await room();
    if (!now) break;
    if (now.over) break;
    const g = guard(now);
    if (g === "cap") { capped = true; break; }
    if (g === "stall") { stall = await dumpStall(now, "contact"); break; }
    cadenceStep(now);
    traceStep(now);
    // --trace also names where the seat's own pieces stand each poll: a capture is attributed to
    // the pieces the poll finds on the cell, and at speed 6 the poll can be a round late, so the
    // positions are what tell a walk from a jump.
    if (TRACE) console.log("PIECES " + JSON.stringify((now.pieces || []).filter((p) => p.side === you).map((p) => [p.id, p.x, p.y, p.kind])));
    contact = (now.pieces || []).some((p) => p.side === you && p.fighting);
    if (!contact) {
      // keep one attacker per capital available while we wait - at most once every 4 ROUNDS (a
      // wall-clock retry fired ~7x more often per round at speed 1 than at speed 6), and only
      // for a capital that has no attacker yet
      if (lastBuyRound === null || Number(now.round) - lastBuyRound >= 4) {
        lastBuyRound = Number(now.round);
        for (const cap of foeCaps) {
          if (tanks[cap.name]) continue;
          const unit = await buyNear("tank", cap, 4);
          if (unit) tanks[cap.name] = unit.id;
        }
      }
    }
    await sleep(400);
  }
  timeline.firstContact = (await room()).round;
  timeline.contactWallMs = Date.now() - timeline.playAt;
  mark(contact, "first contact, driven by an order", { round: timeline.firstContact, wallMs: timeline.contactWallMs });
  await shot("02-first-contact.png");

  // ---- phase 2: take the capitals -----------------------------------------
  if (GATE === "contact" && !NO_ORDERS && !capped && !stall) {
    await clockIs("held");
    for (const cap of foeCaps) {
      if (!tanks[cap.name]) {
        const unit = await buyNear("tank", cap, 4);
        if (unit) tanks[cap.name] = unit.id;
      }
    }
    const mine = (await room()).pieces.filter((p) => p.side === you && p.domain === "land");
    for (const piece of mine) {
      const nearest = [...foeCaps].sort((a, b) => dist(piece, a) - dist(piece, b))[0];
      const res = await orderTo(piece.id, { x: nearest.x, y: nearest.y });
      console.log("order " + piece.id + " -> " + nearest.name + ": " + (res.ok ? "ok" : res.why));
    }
    mark(await clockIs("running"), "clock running for the attack");
  }

  // ---- phase 3: capture and end -------------------------------------------
  // The first capture can land during phase 2 (the tanks are already ordered at the capitals), so
  // the trace - polled from round 0 - is the authority on when and where. The poll loop below only
  // sees what changes after it starts; reading the trace keeps a cap that fell at r21 from being
  // reported as "none".
  if (!timeline.firstCapture) {
    const capIds = new Set(capitals.map((c) => Number(c.id)));
    const hit = traceLog.find((e) => capIds.has(Number(e.id)) && e.to === you);
    if (hit) {
      timeline.firstCapture = hit.round;
      timeline.captureSite = hit.name;
      timeline.captureFromTrace = true;
    }
  }
  // The capture is read off the room's own site owners, not off a log line: the capital rows are in
  // the seat view, so a capital that flips to us is the fact the win check just read.
  const owners = new Map((await room()).sites.filter((s) => Number(s.type) === 1 || Number(s.type) === 2).map((s) => [s.name, s.owner]));
  // The re-task cadence is the ROUND, not the poll. The poll interval is wall clock, so a
  // tick-based cadence re-tasked roughly eight times more often per round at speed 1 than at
  // speed 6: the two speeds were playing different matches instead of one match at two paces,
  // and the s1 leg could stall the march by re-pointing every piece before it had walked.
  let lastRetaskRound = null;
  while (!capped && !stall && Date.now() < deadline) {
    const now = await room();
    if (!now) break;
    const g = guard(now);
    if (g === "cap") { capped = true; break; }
    if (g === "stall") { stall = await dumpStall(now, "attack"); break; }
    cadenceStep(now);
    traceStep(now);
    if (TRACE) console.log("PIECES " + now.round + " " + JSON.stringify((now.pieces || []).filter((p) => p.side === you).map((p) => [p.id, p.x, p.y, p.kind])));
    for (const site of now.sites || []) {
      if (!(Number(site.type) === 1 || Number(site.type) === 2)) continue;
      const was = owners.get(site.name);
      if (was !== site.owner) {
        owners.set(site.name, site.owner);
        if (site.owner === you && !timeline.firstCapture) {
          timeline.firstCapture = now.round;
          timeline.captureWallMs = Date.now() - timeline.playAt;
          timeline.captureSite = site.name;
          captureShot = await shot("03-first-capture.png");
        }
      }
    }
    if (now.over) {
      timeline.end = now.round;
      timeline.endWallMs = Date.now() - timeline.playAt;
      summary.winner = now.winner;
      // T-012: the end screen's own reason and capital list, off the live server.
      summary.result = now.result || null;
      summary.endNote = now.note || "";
      endShot = await shot("04-end-screen.png");
      await page.click('#nav button[data-dialog="war"]').catch(() => {});
      await sleep(350);
      summary.endPanel = await page.evaluate(() => ((document.querySelector("#dialogBody") || {}).textContent || "").replace(/\s+/g, " ").trim());
      await shot("05-end-capitals.png");
      await page.keyboard.press("Escape").catch(() => {});
      break;
    }
    // retry buys while income arrives, and re-order an idle piece whose capital is still red
    if (!NO_ORDERS && (lastRetaskRound === null || Number(now.round) - lastRetaskRound >= 3)) {
      lastRetaskRound = Number(now.round);
      retaskCount += 1;
      const reds = (now.sites || []).filter((s) => (Number(s.type) === 1 || Number(s.type) === 2) && s.owner !== you);
      if (reds.length) {
        const idle = (now.pieces || []).filter((p) => p.side === you && p.domain === "land" && !(p.path || []).length && !p.fighting);
        for (const piece of idle.slice(0, 2)) {
          // A refused order is a fact about the ground, not a transient: a land piece in Europe
          // cannot reach Tokyo at path cost 100 (the manual's march limit), so re-trying it every
          // three rounds for a thousand rounds only hides that. Name it and move on.
          if (unreachable.has(piece.id)) continue;
          const nearest = [...reds].sort((a, b) => dist(piece, a) - dist(piece, b))[0];
          const res = await orderTo(piece.id, { x: nearest.x, y: nearest.y });
          if (!res.ok && !res.path) {
            unreachable.set(piece.id, res.note || "no route");
            console.log("re-order " + piece.id + " -> " + nearest.name + ": NO ROUTE (" + (res.note || "no note") + ")");
          } else {
            console.log("re-order " + piece.id + " -> " + nearest.name + ": " + (res.ok ? "path " + res.path : res.why));
          }
        }
        // Reinforce before re-tasking. A garrison holding its capital (T-015 AC6) does not fall
        // to one piece sent alone, and a land piece parked in Europe cannot pay the march to Tokyo
        // at all (Manual p.21, path cost 100) - so a single tracked "attacker" per capital was
        // never enough: it bought one tank, the tank died, and the leg ground to the budget with
        // that capital still red. Keep WANT_NEAR pieces of ours within 6 of every still-red
        // capital, one buy attempt per 5th retask so the buy dialog is not opened every 3 rounds.
        if (retaskCount % 5 === 0) {
          for (const cap of foeCaps) {
            if (!reds.some((s) => s.name === cap.name)) continue;
            const near = (now.pieces || []).filter((p) => p.side === you && p.domain === "land" && dist(p, cap) <= 6);
            if (near.length >= WANT_NEAR) continue;
            const unit = await buyNear("tank", cap, 4);
            console.log("reinforce " + cap.name + ": " + (unit ? unit.id + "@" + unit.x + "," + unit.y + " (near=" + (near.length + 1) + "/" + WANT_NEAR + ")" : "no buy (pool or ground)"));
            if (unit) tanks[cap.name] = unit.id;
          }
        }
      }
    }
    await sleep(150);
  }
  const final = await room();
  summary.timeline = timeline;
  summary.captures = final ? (final.sites || []).filter((s) => Number(s.type) === 1 || Number(s.type) === 2).map((s) => `${s.name}:${s.owner}`) : [];
  summary.over = Boolean(final && final.over);
  summary.winner = final && final.winner;
  summary.trace = traceLog;
  summary.wallMs = Date.now() - t0;
  summary.cap = CAP || null;
  summary.capped = capped;
  summary.stall = stall || null;
  summary.unreachable = [...unreachable.entries()].map(([piece, why]) => ({ piece, why }));
  summary.endRound = final ? final.round : null;
  summary.cadence = cadenceRate();
  summary.cadenceSamples = cadence.length;

  // --- the before/after comparison, in the shape AC4 asks for -----------------
  // First contact round, every capital that changed hands and when, and the holder of each
  // capital after each change: the same three readings taken on both legs.
  const isCapital = (e) => Number(e.type) === 1 || Number(e.type) === 2;
  summary.capitalTimeline = traceLog.filter(isCapital)
    .map((e) => ({ round: e.round, name: e.name, from: e.from, to: e.to, by: e.by }));
  summary.captureRounds = summary.capitalTimeline.filter((e) => e.to === you);
  const start = (summary.capitalSet || []).map((c) => ({ name: c.name, owner: c.owner }));
  const ownersAt = new Map(start.map((c) => [c.name, c.owner]));
  const series = [];
  const countOwners = (round) => {
    const tally = { blue: 0, red: 0, null: 0 };
    for (const c of start) tally[ownersAt.get(c.name) ?? "null"] = (tally[ownersAt.get(c.name) ?? "null"] || 0) + 1;
    series.push({ round, ...tally, holders: start.map((c) => `${c.name}:${ownersAt.get(c.name) ?? "none"}`) });
  };
  countOwners(0);
  for (const e of summary.capitalTimeline) {
    if (!ownersAt.has(e.name)) continue;
    ownersAt.set(e.name, e.to);
    countOwners(e.round);
  }
  summary.capitalHoldSeries = series;
  summary.firstContactRound = timeline.firstContact;
  summary.capturesByRound = summary.captureRounds.map((e) => `${e.name}@r${e.round}`);

  if (stall) {
    mark(false, "rounds kept advancing (no stall)", {
      round: stall.client.round, clock: stall.client.clock, dump: path.join(OUT, "stall-" + stall.phase + ".json"),
    });
  } else {
    mark(true, "rounds kept advancing (no stall)", { round: summary.endRound, capped, cap: CAP || null });
  }
  if (capped) {
    // A cap is a data point: the same cap on both legs is the comparison. "none by cap" is a
    // reading, not a failure, and the leg is only red if the clock froze (the stall row above).
    mark(true, "the leg ran to the round cap",
      { cap: CAP, round: summary.endRound, winner: summary.winner || "none by cap", captures: summary.capturesByRound });
  } else {
    mark(Boolean(timeline.firstCapture), "a city capture happened", { round: timeline.firstCapture, site: timeline.captureSite });
    mark(Boolean(final && final.over), "the match reached a game end", { round: final && final.round, winner: final && final.winner, capitalOwners: summary.captures });
  }
  mark(errors.length === 0, "no page error during the match", errors.slice(0, 3));
  // T-012: when the match ended by capitals, the live page must name the capital that fell last,
  // and that name must be the last capital transition the trace recorded.
  if (summary.over) {
    const result = summary.result || null;
    const lastTrace = [...traceLog].reverse().find((e) =>
      (Number(e.type) === 1 || Number(e.type) === 2) && e.to === summary.winner);
    const named = Boolean(result && result.reason === "capitals" && result.lastCapital && result.lastCapital.name);
    mark(named, "the end screen names the capital that decided the match", result && result.lastCapital);
    if (named && lastTrace) {
      mark(result.lastCapital.name === lastTrace.name,
        "the named capital is the last one the trace saw change hands",
        { named: result.lastCapital.name, traced: lastTrace.name, round: lastTrace.round });
    }
    const listed = Boolean(result && Array.isArray(result.capitals) && result.capitals.length === capitals.length);
    mark(listed, "the result lists the era's whole capital set", result && result.capitals);
    mark(/fell last|fell at round/.test(summary.endNote || ""),
      "the server's end note carries the reason", summary.endNote);
  }
} catch (err) {
  mark(false, "run threw", String(err && err.message ? err.message : err));
  summary.error = String(err && err.stack ? err.stack : err);
} finally {
  summary.rows = rows;
  summary.failed = rows.filter((x) => !x.ok).length;
  summary.endedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("summary " + path.join(OUT, "summary.json"));
  console.log(summary.failed === 0 ? "FULL_MATCH_OK" : "FULL_MATCH_FAILED rows=" + summary.failed);
  await browser.close();
  process.exit(summary.failed === 0 ? 0 : 1);
}
