// PB-321 page leg: the peacetime starting destination, through the page, with two human seats.
//
//   node tests/e2e/pb321-destination-one-seat.mjs                 # starts its own server from this tree
//   node tests/e2e/pb321-destination-one-seat.mjs --url=<base>    # a running server
//   node tests/e2e/pb321-destination-one-seat.mjs --out=<dir>
//
// What this leg is for. PB-321 routes `destinationOp`'s seat line through the one shared delivery
// helper (`deliverSeatLog` + `logSeatsFor`). The node pins grade the shape and the clamp; this leg
// grades the rule the player can see: a destination ordered from the blue seat at PEACE puts exactly
// one delivered line in blue's Log, the ack carries the stored cell, and red's Log and red's socket
// get nothing at all. The order is placed by real page action - select the piece twice (the second
// select arms the destination, app.js:1430), then click a cell that is not the piece's own
// (app.js:1522-1534 turns an own-cell click into an inspect and nothing goes on the wire).
//
// Two precision notes, both measured rather than assumed (frodo, room 10236):
//
//   * The mover's Log gains TWO rows, not one. The page prints its own ack echo
//     `noteLog([...destinationText(rounds)...])` (app.js:4602, text from command.mjs:349, "Starting
//     destination set: N rounds of walking. It moves the moment war begins.") and the DELIVERED line
//     arrives from `op:"log"` (app.js:4577-4578, "a destination is set; it moves when the war
//     begins"). The two sentences differ, so appendLog's round+text dedupe keeps both. This leg
//     grades the delivered sentence BY COUNT (exactly 1) and records the echo's text beside it.
//   * The door is peacetime only: `move.mjs:655` refuses with DESTINATION_AT_WAR during a war, and
//     `app.js:1430` only arms when `atPeace()`. The arm therefore runs in an era that OPENS at
//     peace. In this build that is 1986/2023 only (`peace.mjs:31-35` COLD_WAR_ERAS), and a 1942 room
//     cannot be walked into peace at all (the cease-fire kit is a LATE_ERAS tool, `late.mjs:30,156`).
//     The controller's asked-for 1942 fixture is measured as the CONTROL arm instead: the same
//     gesture in a two-human 1942 war does not arm, so no `op:"destination"` ever leaves the page.
//
// Read from the page and the sockets, never from the store: the painted rows of `#roundLog`, the
// page's own `window.__chq.state()` (selected / armedDestination) and the frames each seat's
// WebSocket actually received (Playwright's `websocket` event = per-seat, not per-server).

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const OUT = evidenceDir("pb321-page-one-seat", argOf("out"));
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const PEACE_ERA = "1986";      // opens at peace (peace.mjs COLD_WAR_ERAS)
const WAR_ERA = "1942";        // the control: at war from round 0, no peace door
const DELIVERED = "a destination is set; it moves when the war begins";
const ECHO_RE = /^Starting destination set: .*It moves the moment war begins\.?$/;
const LEG = readFileSync(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail: detail === undefined ? "" : String(detail).slice(0, 900) });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + (detail === undefined ? "" : String(detail).slice(0, 300)));
  writeFileSync(path.join(OUT, "pb321-destination-one-seat.json"),
    JSON.stringify({ leg: "pb321-destination-one-seat", at: new Date().toISOString(), literal, evidence }, null, 2) + "\n");
}

// Poll a node-side predicate that reads what already arrived; no page is involved.
async function waitFor(read, timeout = 8000, step = 100) {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await sleep(step);
  }
}

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

// Per-seat socket frames. Registered before the page navigates, so the handshake frame is seen too.
function watchFrames(page, frames) {
  page.on("websocket", (ws) => {
    ws.on("framereceived", (event) => {
      const raw = typeof event.payload === "string" ? event.payload : String(event.payload || "");
      try {
        frames.push({ t: Date.now(), frame: JSON.parse(raw) });
      } catch { /* a binary frame is not a room frame */ }
    });
  });
}

const ops = (frames, from, op) => frames.slice(from).map((row) => row.frame).filter((f) => f && f.op === op);

// The painted Log: each row's own round prefix and its text, exactly as the player reads them.
const paintedLog = (page) => page.evaluate(() => [...document.querySelectorAll("#roundLog li")].map((li) => {
  const text = (li.textContent || "").trim();
  const hit = /^round (\d+) \u2014 /.exec(text);
  return { round: hit ? Number(hit[1]) : null, text: hit ? text.slice(hit[0].length) : text };
}));

// The Log panel is open when its nav control is armed. An EMPTY log paints `#dialogBody` with a note
// and no `#roundLog` list at all (app.js:3348), so "the list is absent" is not "the panel is shut" -
// the panel's own state is what this reads, and paintedLog() returning [] is only trusted with it.
const logIsOpen = (page) => page.evaluate(() => {
  const button = document.querySelector('.navbtn[data-dialog="log"]');
  const panel = document.getElementById("dialog");
  return Boolean(button && button.classList.contains("armed") && panel && !panel.classList.contains("hidden"));
});

async function openLog(page) {
  if (await logIsOpen(page)) return;
  await page.evaluate(() => {
    const button = document.querySelector('.navbtn[data-dialog="log"]');
    if (button) button.click();
  });
  await page.waitForFunction(() => {
    const button = document.querySelector('.navbtn[data-dialog="log"]');
    const panel = document.getElementById("dialog");
    return Boolean(button && button.classList.contains("armed") && panel && !panel.classList.contains("hidden"));
  }, null, { timeout: 10000, polling: 60 });
  await sleep(300);
}

async function closeLog(page) {
  if (!(await logIsOpen(page))) return;
  await page.evaluate(() => {
    const button = document.querySelector('.navbtn[data-dialog="log"]');
    if (button) button.click();
  });
  await page.waitForFunction(() => {
    const button = document.querySelector('.navbtn[data-dialog="log"]');
    return !button || !button.classList.contains("armed");
  }, null, { timeout: 10000, polling: 60 });
  await sleep(200);
}

// What the open panel actually shows: the list's rows, or the empty-log sentence, never a blank.
async function logState(page) {
  const open = await logIsOpen(page);
  const rows = open ? await paintedLog(page) : null;
  const empty = await page.evaluate(() => {
    const body = document.getElementById("dialogBody");
    return body && !document.getElementById("roundLog") ? String(body.textContent || "").trim().slice(0, 120) : "";
  });
  return { open, rows, empty };
}

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
}

async function openTwoHuman(blue, red, era, redName) {
  await blue.selectOption('#launch select[name="era"]', era);
  await blue.selectOption('#launch select[name="side"]', "blue");
  await blue.waitForSelector("li.person", { timeout: 30000 });
  await blue.evaluate((name) => {
    const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
    if (row) row.querySelector("button").click();
  }, redName);
  await red.waitForSelector("#invites .invite button", { timeout: 30000 });
  await red.evaluate(() => document.querySelector("#invites .invite button").click());
  await blue.waitForFunction(() => {
    const room = window.__chq.room();
    return Boolean(room) && room.blue && room.red && room.blue.kind === "human" && room.red.kind === "human";
  }, null, { timeout: 30000, polling: 100 });
  const roomId = await blue.evaluate(() => window.__chq.room().id);
  await red.waitForFunction((id) => String(window.__chq.room() && window.__chq.room().id) === String(id), roomId,
    { timeout: 30000, polling: 100 });
  await sleep(350);
  return roomId;
}

// Candidate cells, nearest first and straight lines before diagonals. Off-map and illegal cells are
// filtered by the server's own planner below, not by a guess here.
//
// The floor is 2 cells, not 1, and that is measured: at the 1280x800 fit zoom one cell is ~3.9 CSS
// px, so a click on the ADJACENT cell lands inside the piece badge's own hit box. `clickIntent` then
// answers "this piece" (command.mjs:284-301, own-cell reach = scale/2 + one CSS pixel of slop), the
// page re-arms the destination instead of sending the order, and the leg reads "nothing happened"
// with a green-looking toast. Measured with a scratch probe on this literal: +1 cell at 1280x800
// sends only `op:"route"`; +2 cells sends `op:"destination"` at both widths. A leg that aims one
// cell out is measuring the badge, not the door.
function candidates(piece) {
  const out = [];
  const homeY = piece.y;
  for (const d of [2, 3, 4, 5]) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const y = homeY + dy * d;
      if (y < 0 || y > 260) continue;
      const x = (((piece.x + dx * d) % 320) + 320) % 320;
      if (x === piece.x && y === piece.y) continue;
      out.push({ x, y });
    }
  }
  return out;
}

// A legal destination cell, chosen by the SAME planner the order uses: `op:"route"` is read-only
// (lobby.mjs routeFor -> planOrder) and never queues anything. The ORDER itself is the page's click.
async function legalTarget(page, frames, piece) {
  for (const cell of candidates(piece)) {
    const from = frames.length;
    await page.evaluate((args) => window.__chq.send({ op: "route", piece: args.piece, to: args.to }),
      { piece: piece.id, to: cell });
    const hit = await waitFor(() => ops(frames, from, "route").find((f) => f.to
      && Number(f.to.x) === cell.x && Number(f.to.y) === cell.y), 700, 40);
    if (hit && !hit.error && Array.isArray(hit.path) && hit.path.length && Number(hit.rounds) > 0) {
      return { cell, reply: hit };
    }
  }
  return null;
}

let BASE = "";
let CHILD = null;
let BROWSER = null;
let literal = { tree: "", head: "", served: "", source: "" };

function treeHead() {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main() {
  literal.tree = root;
  literal.head = treeHead();
  const { chromium } = await loadPlaywright();
  let child = null;
  if (GIVEN) {
    BASE = GIVEN;
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb321-page-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        OPENCHQ_WEB_HOST: "127.0.0.1",
        OPENCHQ_WEB_PORT: String(port),
        OPENCHQ_WEB_DATA: dataDir,
        // The server stamps the tree's own HEAD, so /api/version names the literal this run measured.
        ...(literal.head ? { OPENCHQ_COMMIT: literal.head } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    CHILD = child;
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch { /* still booting */ }
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }
  try {
    const version = await (await fetch(BASE + "/api/version")).json();
    literal.served = String(version.commit || "");
    literal.source = String(version.source || "");
  } catch { /* an older host may not answer */ }
  console.log("PB321_LITERAL tree=" + literal.head + " served=" + literal.served + " source=" + literal.source
    + " base=" + BASE);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  BROWSER = browser;

  for (const viewport of VIEWPORTS) {
    const tag = Date.now().toString(36).slice(-5) + viewport.width;
    const at = " @" + viewport.width + "x" + viewport.height;
    const errors = [];
    const framesBlue = [];
    const framesRed = [];
    const ctxBlue = await browser.newContext({ viewport });
    const ctxRed = await browser.newContext({ viewport });
    const blue = await ctxBlue.newPage();
    const red = await ctxRed.newPage();
    watchFrames(blue, framesBlue);
    watchFrames(red, framesRed);
    blue.on("pageerror", (err) => errors.push("blue: " + String(err)));
    red.on("pageerror", (err) => errors.push("red: " + String(err)));
    const blueName = "P321B" + tag;
    const redName = "P321R" + tag;

    await signIn(blue, blueName, "pw-blue-" + tag);
    await signIn(red, redName, "pw-red-" + tag);
    const roomId = await openTwoHuman(blue, red, PEACE_ERA, redName);
    mark("a two-human " + PEACE_ERA + " room is open (an era that OPENS at peace)" + at, true,
      blueName + " / " + redName + " room " + roomId);

    const open = await blue.evaluate(() => {
      const room = window.__chq.room();
      return {
        round: room.round,
        clock: room.clock,
        peace: room.peace,
        you: room.you,
        pieces: (room.pieces || []).map((p) => ({ id: p.id, side: p.side, x: p.x, y: p.y, kind: p.kind, domain: p.domain, startingDestination: p.startingDestination || null })),
      };
    });
    const soldier = open.pieces.find((p) => p.side === "blue" && p.kind !== "aircraft" && p.domain !== "sea");
    if (!open.peace || open.peace.active !== true || !soldier) {
      mark("the room is at peace with a blue ground piece to order" + at, false,
        "peace=" + JSON.stringify(open.peace) + " soldier=" + JSON.stringify(soldier));
      await ctxBlue.close(); await ctxRed.close();
      continue;
    }
    mark("the room is at peace with a blue ground piece to order" + at, true,
      "peace=" + JSON.stringify(open.peace) + " piece=" + soldier.id + " @" + soldier.x + "," + soldier.y);
    mark("the piece starts with no stored destination" + at, soldier.startingDestination === null,
      JSON.stringify(soldier.startingDestination));

    // ---- before: blue's Log count (panel opened, counted, closed so the board takes clicks) ------
    await openLog(blue);
    const blueBase = await logState(blue);
    await closeLog(blue);
    await openLog(red);
    const redBase = await logState(red);
    const blueBefore = blueBase.rows.length;
    const redBefore = redBase.rows.length;
    mark("the two Logs are open and readable before the order" + at,
      blueBase.open && redBase.open && Number.isInteger(blueBefore) && Number.isInteger(redBefore),
      "blue=" + blueBefore + " row(s) " + JSON.stringify(blueBase.empty) + " red=" + redBefore + " row(s) " + JSON.stringify(redBase.empty));

    // ---- the gesture: two selects (the second arms) then a cell that is not the piece's own ------
    const own = await blue.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [soldier.x, soldier.y]);
    await blue.mouse.click(own.x, own.y);
    await sleep(260);
    const first = await blue.evaluate(() => ({ selected: window.__chq.state().selected, armed: window.__chq.state().armedDestination }));
    await blue.mouse.click(own.x, own.y);
    await sleep(260);
    const second = await blue.evaluate(() => ({
      selected: window.__chq.state().selected,
      armed: window.__chq.state().armedDestination,
      toast: window.__chq.toast(),
    }));
    mark("the first select selects the piece" + at, String(first.selected) === String(soldier.id) && !first.armed,
      JSON.stringify(first));
    mark("the second select arms the destination (nothing on the wire yet)" + at,
      String(second.armed) === String(soldier.id) && /Destination mode/i.test(second.toast),
      JSON.stringify(second));

    const target = await legalTarget(blue, framesBlue, soldier);
    if (!target) {
      mark("a legal destination cell answers the read-only planner" + at, false, "no candidate plan");
      await ctxBlue.close(); await ctxRed.close();
      continue;
    }
    const gapX = Math.abs(target.cell.x - soldier.x);
    mark("a legal destination cell answers the read-only planner" + at,
      Boolean(target.cell) && (gapX >= 2 || Math.abs(target.cell.y - soldier.y) >= 2),
      JSON.stringify(target.cell) + " rounds=" + target.reply.rounds + " path=" + target.reply.path.length
        + " gap=" + gapX + "," + Math.abs(target.cell.y - soldier.y) + " cells from " + soldier.x + "," + soldier.y);

    // Aim check: the instrument's own aim resolves back to the cell it means to click.
    const aim = await blue.evaluate(([x, y]) => {
      const at = window.__chq.cellToScreen(x, y);
      const back = window.__chq.screenToCell(at.x, at.y);
      return { at, back };
    }, [target.cell.x, target.cell.y]);
    const aimed = Number(aim.back.x) === target.cell.x && Number(aim.back.y) === target.cell.y;
    mark("the click point resolves back to the intended cell" + at, aimed, JSON.stringify(aim));
    if (!aimed) {
      await ctxBlue.close(); await ctxRed.close();
      continue;
    }

    // ---- the order, by page action --------------------------------------------------------------
    const framesBeforeBlue = framesBlue.length;
    const framesBeforeRed = framesRed.length;
    await blue.mouse.click(aim.at.x, aim.at.y);
    const ack = await waitFor(() => ops(framesBlue, framesBeforeBlue, "destination")[0], 9000, 60);
    const refusals = ops(framesBlue, framesBeforeBlue, "error");

    // (a) the stored cell, from the ack, BEFORE any log row is graded.
    mark("(a) the server acked the destination with the stored cell" + at,
      Boolean(ack) && String(ack.piece) === String(soldier.id) && Number(ack.to && ack.to.x) === target.cell.x
        && Number(ack.to && ack.to.y) === target.cell.y,
      JSON.stringify(ack) + (refusals.length ? " refusals=" + JSON.stringify(refusals) : ""));
    if (!ack) {
      mark("(a) the page sent the order as op:\"destination\"" + at, false,
        "frames=" + JSON.stringify(ops(framesBlue, framesBeforeBlue, "order")) + " errors=" + JSON.stringify(refusals));
      mark("the attack reads with no page errors" + at, errors.length === 0, errors.join(" | "));
      await ctxBlue.close(); await ctxRed.close();
      continue;
    }

    // (b) the mover's DELIVERED line, by count, plus the page's own ack echo recorded beside it.
    await sleep(450);
    await openLog(blue);
    await sleep(250);
    const blueAfter = await logState(blue);
    const blueRows = blueAfter.rows || [];
    const delivered = blueRows.filter((row) => row.text === DELIVERED);
    const echo = blueRows.filter((row) => ECHO_RE.test(row.text));
    const blueDelta = blueRows.length - blueBefore;
    mark("(b) the mover reads the delivered destination line exactly once" + at, delivered.length === 1,
      "count=" + delivered.length + " rows=" + JSON.stringify(delivered));
    mark("(d) the move's ack echo is the page's own second row, recorded not assumed" + at, echo.length === 1,
      "count=" + echo.length + " text=" + JSON.stringify(echo.map((row) => row.text)));
    mark("(d) the mover's Log gained exactly two rows for the one order" + at, blueDelta === 2,
      "before=" + blueBefore + " after=" + blueRows.length + " delta=" + blueDelta);

    // (c) the OTHER seat: DOM delta 0 AND no op:"log" frame on red's own socket.
    await sleep(300);
    const redAfter = await logState(red);
    const redRows = redAfter.rows || [];
    const redDelta = redRows.length - redBefore;
    const redLogFrames = ops(framesRed, framesBeforeRed, "log");
    mark("(c) the other seat's Log does not move across the order" + at,
      redAfter.open && redDelta === 0,
      "before=" + redBefore + " after=" + redRows.length + " delta=" + redDelta + " empty=" + JSON.stringify(redAfter.empty));
    mark("(c) the other seat's socket received no op:\"log\" for it" + at,
      redLogFrames.length === 0, "frames=" + JSON.stringify(redLogFrames).slice(0, 400));

    // What the mover's own socket carried, so the delivered count is read from the wire too.
    const blueLogLines = ops(framesBlue, framesBeforeBlue, "log")
      .flatMap((f) => (Array.isArray(f.lines) ? f.lines : []))
      .filter((line) => line && line.text === DELIVERED);
    mark("(b) the mover's socket carried that line exactly once" + at, blueLogLines.length === 1,
      "count=" + blueLogLines.length + " frames=" + JSON.stringify(ops(framesBlue, framesBeforeBlue, "log")).slice(0, 500));

    const stored = await blue.evaluate((id) => {
      const piece = (window.__chq.room().pieces || []).find((p) => String(p.id) === String(id));
      return piece ? piece.startingDestination || null : null;
    }, soldier.id);
    evidence.push({
      label: "detail: the stored cell on the page's own room payload (not graded — the ack is the grade)",
      ok: true, detail: JSON.stringify(stored),
    });
    mark("the attack reads with no page errors" + at, errors.length === 0, errors.join(" | "));

    await ctxBlue.close();
    await ctxRed.close();
  }

  // ---- CONTROL: the fixture the controller named (two-human 1942) cannot reach this door ---------
  {
    const tag = Date.now().toString(36).slice(-5) + "ctl";
    const viewport = { width: 1280, height: 800 };
    const at = " @1280x800 (control)";
    const errors = [];
    const framesBlue = [];
    const ctxBlue = await browser.newContext({ viewport });
    const ctxRed = await browser.newContext({ viewport });
    const blue = await ctxBlue.newPage();
    const red = await ctxRed.newPage();
    watchFrames(blue, framesBlue);
    blue.on("pageerror", (err) => errors.push("blue: " + String(err)));
    red.on("pageerror", (err) => errors.push("red: " + String(err)));
    await signIn(blue, "P321C" + tag, "pw-ctl-" + tag);
    await signIn(red, "P321D" + tag, "pw-ctl-" + tag);
    await openTwoHuman(blue, red, WAR_ERA, "P321D" + tag);
    const open = await blue.evaluate(() => {
      const room = window.__chq.room();
      return {
        era: room.era,
        peace: room.peace,
        pieces: (room.pieces || []).map((p) => ({ id: p.id, side: p.side, x: p.x, y: p.y, kind: p.kind, domain: p.domain })),
      };
    });
    const soldier = open.pieces.find((p) => p.side === "blue" && p.kind !== "aircraft" && p.domain !== "sea");
    mark("control: a two-human 1942 room opens AT WAR, not at peace" + at,
      Boolean(open.peace && open.peace.active === true) === false && Boolean(soldier),
      "era=" + open.era + " peace=" + JSON.stringify(open.peace) + " piece=" + (soldier && soldier.id));
    if (soldier) {
      const own = await blue.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [soldier.x, soldier.y]);
      await blue.mouse.click(own.x, own.y);
      await sleep(240);
      await blue.mouse.click(own.x, own.y);
      await sleep(240);
      const armed = await blue.evaluate(() => ({
        selected: window.__chq.state().selected,
        armed: window.__chq.state().armedDestination,
        toast: window.__chq.toast(),
        note: window.__chq.note(),
      }));
      mark("control: the second select does NOT arm at war (the wrong door's own shape)" + at,
        !armed.armed, JSON.stringify(armed));
      const framesBefore = framesBlue.length;
      const cell = { x: (((soldier.x + 2) % 320) + 320) % 320, y: soldier.y };
      const aim = await blue.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [cell.x, cell.y]);
      await blue.mouse.click(aim.x, aim.y);
      await sleep(1200);
      const dest = ops(framesBlue, framesBefore, "destination");
      const went = framesBlue.slice(framesBefore).map((row) => row.frame).map((f) => f && f.op).filter(Boolean);
      mark("control: no op:\"destination\" frame leaves the page at war" + at, dest.length === 0,
        "frames after the click=" + JSON.stringify(went) + " destination=" + JSON.stringify(dest));
      mark("control: no page errors" + at, errors.length === 0, errors.join(" | "));
    }
    await ctxBlue.close();
    await ctxRed.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");

  writeFileSync(path.join(OUT, "pb321-destination-one-seat.json"),
    JSON.stringify({ leg: "pb321-destination-one-seat", at: new Date().toISOString(), literal, evidence }, null, 2) + "\n");
  const md5 = createHash("md5").update(LEG).digest("hex");
  const total = evidence.length;
  console.log("PB321_E2E " + (total - failed) + " passed / " + failed + " failed; leg md5 " + md5);
  console.log("PB321_LITERAL " + JSON.stringify(literal));
  console.log("EVIDENCE " + path.join(OUT, "pb321-destination-one-seat.json"));
  if (failed) process.exitCode = 1;
}

// A thrown leg must not leave a browser and a server holding the host: the first draft did, and the
// run then looked like a hang instead of a red. Watchdog + cleanup are the instrument's own.
const watchdog = setTimeout(() => {
  console.error("PB321_E2E WATCHDOG: no verdict after 420 s");
  try { if (CHILD) CHILD.kill("SIGTERM"); } catch { /* already gone */ }
  process.exit(2);
}, 420000);
watchdog.unref();

main().then(() => {
  clearTimeout(watchdog);
}).catch(async (err) => {
  console.error("PB321_E2E THREW " + (err && err.stack ? err.stack : err));
  try { if (BROWSER) await BROWSER.close(); } catch { /* already closed */ }
  try { if (CHILD) CHILD.kill("SIGTERM"); } catch { /* already gone */ }
  clearTimeout(watchdog);
  process.exit(1);
});
