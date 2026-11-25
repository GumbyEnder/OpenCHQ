// Node test: PB-245 — the PEACE CONTROL. A human-accepted cease fire must be leaveable from the
// page (manual printed p.31-32): "A counter in Monitor One tells you how much time remains in
// mandatory peace; after that, either player can start the war by pressing Begin Hostilities/
// Cease Fire." p.32 War Status: "allows you to begin hostilities, but only after the mandatory time
// has elapsed."
//
// Why this file exists at all: PB-245's AC1-5 landed the STATE and the two exits from the server
// (resign, capital, winter) plus resume_war as an op, but the page had no sender for it. A live
// accept therefore froze the war with the enemy invisible, oil frozen, cities never going unready
// and no control to leave - a soft lock, not a partial rule. This commit is the missing control:
// the counter on the strip and the War panel, the Begin Hostilities button, both seats' log lines,
// and the room note cleared when the peace ends.
//
// Arms:
//   1. the counter refuses resume and names the rounds left; a refused press changes nothing
//   2. at the counter the press is legal, and the two seats read DIFFERENT, correct sentences
//   3. the room note the agreement wrote does not outlive the restart (frodo 9236 §5)
//   4. the strip prints the counter (rounds left, and "war may resume" at zero)
//   5. the page's Begin Hostilities button exists, is gated on the server's canResume, and SENDS
//      resume_war - and this arm REDS when that sender is cut (the cut is run here, not assumed)
//   6. over real sockets, two human seats: offer, accept, press Begin Hostilities, and the war is
//      on for both seats with their own log lines and no stale note
//   7. the accept button's sentence names the peace, not an end to the war - and REDS on the old
//      sentence (frodo 9241 §2; the cut is run here, not assumed)
//   8. the refusal carries the count ("...: 1 round(s) remain."), and the refusal branch writes no
//      room note - both cut RUN, so a lost digit or a note cleared on refusal reds (frodo 9250 A2)

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { answerCeasefire, useTool } from "../../server/late.mjs";
import { peaceOf, resumeWar } from "../../server/peace.mjs";
import { forSeat } from "../../server/view.mjs";
import { logLines } from "../../server/log.mjs";
import { resetRules } from "../../server/rules.mjs";
import { stripInfoParts } from "../../public/shell.mjs";

export const name = "pb245_peace_control";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function ok(value, label) {
  if (!value) fail(label);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const shippedPath = path.resolve(here, "..", "..", "..", "config", "game.json");
const appPath = path.resolve(here, "..", "..", "public", "app.js");
const lobbyPath = path.resolve(here, "..", "..", "server", "lobby.mjs");

const MANDATORY = { "1986": 3 };

function withPeaceConfig(fn) {
  const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb245ctl-"));
  const file = path.join(dir, "game.json");
  shipped.peace = { ...(shipped.peace || {}), mandatoryRounds: { ...MANDATORY } };
  writeFileSync(file, JSON.stringify(shipped, null, 2));
  const before = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = file;
  resetRules();
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.OPENCHQ_CONFIG; else process.env.OPENCHQ_CONFIG = before;
    resetRules();
  }
}

// A match at war on `round`, then an agreed cease fire at that round.
function truceAcceptedAt(round) {
  const match = openMatch("1986", matchSites("1986"));
  match.clock = "running";
  match.round = round;
  const offer = useTool(match, "blue", "ceasefire");
  ok(!offer.error, "the fixture could not offer a cease fire: " + JSON.stringify(offer.error));
  const accept = answerCeasefire(match, "red", true);
  ok(accept && !accept.error, "the fixture could not accept the cease fire: " + JSON.stringify(accept && accept.error));
  ok(match.peace && match.peace.active === true, "the fixture did not enter peace");
  return match;
}

// The accept button's own sentence (frodo 9241 §2). It is read at the instant the state changes,
// so it must name the peace that starts instead of promising that the war ends.
function acceptTitleArms(source, label) {
  const start = source.indexOf('button.textContent = "Accept cease-fire"');
  if (start < 0) fail(label + ": the kit has no Accept cease-fire button");
  const block = source.slice(start, source.indexOf('} else if (truce.status === "pending")', start));
  if (block.length < 40) fail(label + ": the accept branch is not where it was: " + block.length + " chars");
  const title = (block.match(/button\.title = "([^"]*)"/) || [])[1] || "";
  ok(title.length > 0, label + ": the accept button carries no title");
  ok(!/war ends/i.test(title), label + ": the accept button still says the war ends: " + title);
  ok(/peace/i.test(title), label + ": the accept title does not name the peace it enters: " + title);
  ok(/declining leaves the board as it is/i.test(title),
    label + ": the decline half of the sentence was lost: " + title);
}

// The refusal must not touch the agreement's note (frodo 9250 §1, "pin the note-unchanged-on-
// refusal in the same eq block"). The clear lives in the lobby's resumeWarOp, so this reads that
// op's shape: the refusal returns before any note write.
function refusalNoteArms(source, label) {
  const start = source.indexOf("function resumeWarOp(");
  if (start < 0) fail(label + ": the lobby has no resumeWarOp");
  const next = source.indexOf("function missionOp(", start);
  const block = source.slice(start, next > start ? next : source.length);
  const refusal = block.indexOf("if (!result || result.error) {");
  const clear = block.indexOf('room.note = "";');
  if (refusal < 0) fail(label + ": resumeWarOp has no refusal branch");
  if (clear < 0) fail(label + ": resume_war no longer clears the agreement's note");
  ok(refusal < clear, label + ": the note clear sits before the refusal branch, so a refused press wipes the agreement's note");
  const body = block.slice(refusal, block.indexOf("return", refusal));
  ok(!/room\.note\s*=/.test(body), label + ": the refusal branch writes the room note");
}

// The page's Begin Hostilities sender, as one checker so the cut can be run against a copy.
function pageControlArms(source, label) {
  const start = source.indexOf('textContent = "Begin Hostilities"');
  if (start < 0) fail(label + ": the War panel has no Begin Hostilities button");
  const block = source.slice(start, source.indexOf("group.append(begin)", start));
  if (block.length < 40 || block.length > 1200) fail(label + ": the Begin Hostilities block is not where it was: " + block.length + " chars");
  ok(/begin\.disabled = peace\.canResume !== true/.test(block),
    label + ": the button does not defer to the server's canResume");
  ok(/begin\.addEventListener\("click", \(\) => send\(\{ op: "resume_war" \}\)\)/.test(block),
    label + ": the button has no resume_war sender");
  // The counter must read the SERVER's remaining count, not a deadline recomputed on the page.
  ok(/definition\(dl, peace\.coldWar \? "Cold war" : "Cease-fire"/.test(source),
    label + ": the War panel prints no peace counter");
  ok(/const left = Math\.max\(0, Math\.trunc\(Number\(peace\.remaining\) \|\| 0\)\);/.test(
    source.slice(source.indexOf("war(body)"), source.indexOf("log(body)"))),
    label + ": the War panel recomputes the counter instead of reading peace.remaining");
}

export async function run(ctx) {
  withPeaceConfig(() => {
    // ---- 1: the counter refuses, and names what is left --------------------------------
    {
      const match = truceAcceptedAt(3);
      const blue = forSeat(match, "blue");
      eq(blue.peace.remaining, 3, "the counter starts at the config's length (3)");
      eq(blue.peace.canResume, false, "the seat reads canResume:false while the counter runs");
      const early = resumeWar(match, "blue", 5);
      ok(early.error, "a press before the counter elapsed was allowed");
      ok(/mandatory peace has not elapsed/i.test(early.error), "the refusal does not name the rule: " + early.error);
      // frodo 9250 A2: the sentence the War panel shows must carry the digits, not just the rule.
      // This exact eq is what reds when peace.mjs drops the count (frodo's F3 survived without it).
      eq(early.error, "The mandatory peace has not elapsed: 1 round(s) remain.",
        "the refusal's sentence, count included");
      eq(early.remaining, 1, "the refusal does not name the rounds remaining");
      eq(peaceOf(match).active, true, "a refused press left the peace standing");
      eq(peaceOf(match).brokenBy, null, "a refused press named a breaker");
      eq(peaceOf(match).coldWar, false, "an agreed cease fire is not a cold war");
    }

    // ---- 2: at the counter it is legal, and each seat reads its own sentence ------------
    {
      const match = truceAcceptedAt(3);
      const at = resumeWar(match, "blue", 6);
      ok(at && at.ok, "a press at the counter was refused: " + JSON.stringify(at && at.error));
      eq(peaceOf(match).active, false, "the press did not end the peace");
      eq(peaceOf(match).brokenBy, "blue", "the state does not name the side that broke it");

      const mineLines = logLines(match, "blue", at.events, 6).map((line) => line.text);
      const foeLines = logLines(match, "red", at.events, 6).map((line) => line.text);
      eq(mineLines, ["you began hostilities; the war is on again"], "the acting seat's line");
      eq(foeLines, ["Blue has broken the peace: the war is on again."], "the other seat's line");
      ok(!foeLines.some((text) => /^you began/.test(text)), "the other seat is told it broke the peace");
      ok(!mineLines.some((text) => /broken the peace/i.test(text)), "the acting seat reads the accusation against itself");

      // The other direction, so the sentence is the breaker's and not a hard-coded "Blue".
      const match2 = truceAcceptedAt(3);
      const redAt = resumeWar(match2, "red", 6);
      ok(redAt && redAt.ok, "the red seat could not press Begin Hostilities");
      eq(logLines(match2, "red", redAt.events, 6).map((line) => line.text),
        ["you began hostilities; the war is on again"], "the red actor's line");
      eq(logLines(match2, "blue", redAt.events, 6).map((line) => line.text),
        ["Red has broken the peace: the war is on again."], "the blue seat's line names Red");
    }

    // ---- 4: the strip prints the counter ------------------------------------------------
    {
      const base = { era: "1986", you: "blue", clock: "running", round: 4, over: false };
      const withCounter = stripInfoParts({ ...base, peace: { active: true, remaining: 2, coldWar: false } })
        .map((part) => part.text);
      ok(withCounter.includes("cease-fire, 2 rounds left"), "the strip does not print the counter: " + JSON.stringify(withCounter));
      const elapsed = stripInfoParts({ ...base, peace: { active: true, remaining: 0, coldWar: false } })
        .map((part) => part.text);
      ok(elapsed.includes("cease-fire, war may resume"), "the strip does not say the war may resume: " + JSON.stringify(elapsed));
      const oneLeft = stripInfoParts({ ...base, peace: { active: true, remaining: 1, coldWar: false } })
        .map((part) => part.text);
      ok(oneLeft.includes("cease-fire, 1 round left"), "the strip's singular reads wrong: " + JSON.stringify(oneLeft));
      const atWar = stripInfoParts({ ...base, peace: null }).map((part) => part.text);
      ok(!atWar.some((text) => /cease-fire|cold war/.test(text)), "a war still prints a peace counter: " + JSON.stringify(atWar));
    }
  });

  // ---- 5: the page's sender, and the same arm against a CUT copy -----------------------
  {
    const source = readFileSync(appPath, "utf8");
    pageControlArms(source, "the shipped page");
    const cut = source.replace('begin.addEventListener("click", () => send({ op: "resume_war" }))', "");
    ok(cut !== source, "the cut arm could not cut the sender - the pin is not reading the real line");
    let red = false;
    try {
      pageControlArms(cut, "a cut page");
    } catch (err) {
      red = /no resume_war sender/.test(String(err && err.message));
    }
    ok(red, "cutting the Begin Hostilities sender did NOT red the arm");
  }

  // ---- 5b: the accept button's sentence, and the same cut (frodo 9241 §2) --------------
  {
    const source = readFileSync(appPath, "utf8");
    acceptTitleArms(source, "the shipped page");
    const old = source.replace(
      /button\.title = "Both sides agree and the fighting stops[^"]*";/,
      'button.title = "Both sides agree and the war ends. Declining leaves the board as it is.";');
    ok(old !== source, "the title cut could not be applied - the pin is not reading the real line");
    let titleRed = false;
    try {
      acceptTitleArms(old, "a page with the old sentence");
    } catch (err) {
      titleRed = /still says the war ends/.test(String(err && err.message));
    }
    ok(titleRed, "the old \"the war ends\" sentence did NOT red the title arm");

    // The refusal's note half, and its cut: a note write moved above the refusal must red.
    const lobby = readFileSync(lobbyPath, "utf8");
    refusalNoteArms(lobby, "the shipped lobby");
    const moved = lobby.replace("const mine = seatUsername(room, username);\n    if (!mine) return { error: \"You do not hold a seat in this match.\" };\n    const result = resumeWar(room.match, mine, room.match.round);",
      "const mine = seatUsername(room, username);\n    if (!mine) return { error: \"You do not hold a seat in this match.\" };\n    room.note = \"\";\n    const result = resumeWar(room.match, mine, room.match.round);");
    ok(moved !== lobby, "the note cut could not be applied - the pin is not reading the real op");
    let noteRed = false;
    try {
      refusalNoteArms(moved, "a lobby that clears the note before the refusal");
    } catch (err) {
      noteRed = /wipes the agreement's note/.test(String(err && err.message));
    }
    ok(noteRed, "clearing the note before the refusal did NOT red the arm");
  }

  // ---- 6: two human seats, over sockets, the way the page does it ----------------------
  // Skipped only by the one-file census driver (web/test/nodes/_only.mjs), which passes an empty
  // ctx; the full suite always has one, and the suite is the gate.
  if (!ctx || typeof ctx.register !== "function") return;
  {
    const tag = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 100);
    const alice = await ctx.register("CtrlBlue" + tag);
    const bob = await ctx.register("CtrlRed" + tag);
    const a = ctx.socket(alice.token);
    const b = ctx.socket(bob.token);
    await new Promise((resolve) => {
      let open = (a.ws.readyState === 1 ? 1 : 0) + (b.ws.readyState === 1 ? 1 : 0);
      if (open === 2) return resolve();
      const done = () => { open += 1; if (open === 2) resolve(); };
      if (a.ws.readyState !== 1) a.ws.addEventListener("open", done);
      if (b.ws.readyState !== 1) b.ws.addEventListener("open", done);
    });
    await a.wait((m) => m.op === "welcome", "alice welcome");
    await b.wait((m) => m.op === "welcome", "bob welcome");

    let markA = a.box.length;
    let markB = b.box.length;
    a.send({ op: "invite", user: bob.user.username, era: "1986", side: "blue" });
    const invited = await a.wait((m) => m.op === "invited" && m.invite, "alice's invite", markA);
    const shown = await b.wait((m) => m.op === "invite" && m.invite, "bob's invite", markB);
    b.send({ op: "answer", id: shown.invite.id, accept: true });
    const roomA = await a.wait((m) => m.op === "room" && m.room && m.room.id && m.room.era === "1986", "alice's room");
    await b.wait((m) => m.op === "room" && m.room && m.room.id === roomA.room.id, "bob's room");
    const roomId = roomA.room.id;

    // The cease-fire tool is a wartime act: the server refuses it on a held clock ("Start the clock
    // first."), so start it the way a player does.
    markA = a.box.length;
    a.send({ op: "speed", speed: 6 });
    await a.wait((m) => m.op === "speed" && m.speed === 6, "speed 6", markA);
    markA = a.box.length;
    a.send({ op: "run" });
    await a.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "clock running", markA);

    // Propose from blue, accept from red - the live accept path, no module call.
    // Once a seat holds a shadow the server sends DELTAS, not whole rooms, so any state assertion
    // asks for a full frame with `sync` (the same op a reconnecting page sends).
    const fullRoom = async (sock, pred, label, ms = 8000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const from = sock.box.length;
        sock.send({ op: "sync" });
        try {
          return await ctx.waitUntil(sock.box, from,
            (m) => m.op === "room" && m.room && pred(m.room), label, 2000);
        } catch { /* no frame yet: ask again */ }
      }
      fail(label + ": no full room frame within " + ms + "ms");
    };

    markA = a.box.length;
    a.send({ op: "tool", tool: "ceasefire" });
    await a.wait((m) => m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "ceasefire_proposed"),
      "the proposal ack", markA);
    await fullRoom(b, (room) => room.seat && room.seat.ceasefire && room.seat.ceasefire.canAnswer === true,
      "bob's answerable offer");
    b.send({ op: "ceasefire_answer", accept: true });
    const peaceB = await fullRoom(b, (room) => room.peace && room.peace.active === true, "bob's peace");
    ok(/Cease fire accepted/.test(String(peaceB.room.note || "")),
      "the accepted truce did not leave its note: " + JSON.stringify(peaceB.room.note));
    const peaceA = await fullRoom(a, (room) => room.peace && room.peace.active === true, "alice's peace");
    // The shipped config prints no mandatory length, so the counter is 0 here and the press is
    // legal at once; that is exactly the live case the control exists for.
    eq(peaceA.room.peace.remaining, 0, "the shipped config's counter is not 0");
    eq(peaceA.room.peace.canResume, true, "the press is refused under the shipped config");

    // Press Begin Hostilities: the op the button sends.
    markA = a.box.length;
    markB = b.box.length;
    a.send({ op: "resume_war" });
    const warA = await fullRoom(a, (room) => room.peace && room.peace.active === false, "alice's war");
    const warB = await fullRoom(b, (room) => room.peace && room.peace.active === false, "bob's war");
    eq(warA.room.note === "" || warA.room.note === undefined || warA.room.note === null, true,
      "the stale cease-fire note survived the restart: " + JSON.stringify(warA.room.note));
    eq(warB.room.note === "" || warB.room.note === undefined || warB.room.note === null, true,
      "the stale cease-fire note survived on the other seat: " + JSON.stringify(warB.room.note));

    const aliceLog = await ctx.waitUntil(a.box, markA,
      (m) => m.op === "log" && Array.isArray(m.lines) && m.lines.some((line) => /^you began hostilities/.test(line.text)),
      "alice's own line", 8000);
    const bobLog = await ctx.waitUntil(b.box, markB,
      (m) => m.op === "log" && Array.isArray(m.lines) && m.lines.some((line) => /^Blue has broken the peace/.test(line.text)),
      "bob's accusation", 8000);
    ok(aliceLog.lines.some((line) => /^you began hostilities; the war is on again$/.test(line.text)),
      "alice's line is not her own act: " + JSON.stringify(aliceLog.lines));
    ok(bobLog.lines.some((line) => /^Blue has broken the peace: the war is on again\.$/.test(line.text)),
      "bob's line does not name the breaker: " + JSON.stringify(bobLog.lines));
    // The round the line prints is the round the press happened in, and the room's roomId travels
    // with it so a log line never lands in another room's panel.
    eq(aliceLog.roomId, roomId, "the log line carried the wrong room");

    a.close();
    b.close();
  }
}
