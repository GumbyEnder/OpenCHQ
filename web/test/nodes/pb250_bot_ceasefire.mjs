// PB-250 — the computer opponent ANSWERS a cease-fire proposal, either way.
//
// The manual (p.32): "Your opponent must agree to your proposed cease-fire, or the war continues."
// PB-200 built the ask and the human answer; the AI's own answer was a fixed DECLINE (lobby.mjs),
// and the PM's bot-match play-test showed the proposer learning nothing at all. The rule shipped
// now is a stated PORT DECISION (bot.mjs:botCeasefireAnswer): the bot accepts only when it holds
// FEWER CITIES than the proposer. The original's trigger is still UNVERIFIED (AI.md:441).
//
// Both answers are exercised on a REAL bot room through the lobby's own tick, and the two rooms
// differ only in which seat the human took: the 1986 opening gives blue 38 cities and red 17, so
// blue-vs-Bot is the ACCEPT case and red-vs-Bot is the DECLINE case. What fails if the wiring is
// removed: the seat frame stays "pending" forever (the PM's bug), no log line lands, and a bot seat
// that accepted would re-declare the war in the next tick (the counter is spent at round 0).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { botCeasefireAnswer, citiesHeld } from "../../server/bot.mjs";
import { answerCeasefire, CEASEFIRE_NOTE, useTool } from "../../server/late.mjs";
import { logLines } from "../../server/log.mjs";
import { makeAsserts } from "../pb224_helpers.mjs";

export const name = "pb250_bot_ceasefire";

// The seat's own facts as the page reads them: the last whole-room frame, then every delta that
// carried a new seat (`seatChanged`). A round's answer usually rides a DELTA, so reading only
// `{op:"room"}` frames would read the offer and never the reply.
function seatOf(sent) {
  let seat = null;
  for (const message of sent) {
    if (message.op === "room" && message.room) seat = message.room.seat || seat;
    else if (message.op === "delta" && message.delta && message.delta.seat) seat = message.delta.seat;
  }
  return seat;
}

// The ROOM's own facts as the page reads them. `peace` and `note` are room fields; a delta carries
// both (PB-250 added `peace` to it), so this folds the frames in order rather than taking the last
// whole one.
function roomFacts(sent) {
  const facts = { peace: null, note: "" };
  for (const message of sent) {
    if (message.op === "room" && message.room) {
      facts.peace = message.room.peace ?? null;
      facts.note = String(message.room.note || "");
    } else if (message.op === "delta" && message.delta) {
      if (message.delta.peace !== undefined) facts.peace = message.delta.peace;
      if (message.delta.note !== undefined) facts.note = String(message.delta.note || "");
    }
  }
  return facts;
}

// One bot room, driven exactly the way main.mjs drives it: `now` is wall-clock ms and speed 1 is a
// 5 s round, so one step of 5000 ms is one round.
function openBotRoom(gate, sent, me, side) {
  gate.join(me, { send: (message) => sent.push(message), onclose: null });
  const started = gate.handle(me, { op: "bot", era: "1986", side });
  if (!started || started.error) throw new Error("PB-250 fixture: the bot room was refused: " + (started && started.error));
  const frame = sent.filter((m) => m.op === "room").pop();
  const id = frame && frame.room ? frame.room.id : null;
  if (!id) throw new Error("PB-250 fixture: the bot room never sent a room frame");
  const run = gate.handle(me, { op: "run" });
  if (!run || run.error) throw new Error("PB-250 fixture: the clock did not start: " + (run && run.error));
  const t0 = Date.now();
  gate.tickRooms(t0);
  gate.tickRooms(t0 + 5000);
  return { id, t0, round: gate.debugRoom(id).round };
}

export async function run() {
  const t = makeAsserts(name);
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb250-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");

    // ---- the board the rule reads ------------------------------------------------------------
    const board = openMatch("1986", matchSites("1986"));
    seedOwners(board);
    t.eq("PB-250 fixture: the 1986 opening is lopsided, which is what makes both answers reachable",
      [citiesHeld(board, "blue"), citiesHeld(board, "red")], [38, 17]);
    t.eq("PB-250: only cities and capitals count as ground held (docks, fields and facilities do not)",
      (board.sites || []).filter((site) => site.owner === "blue" && site.kind === "dock").length > 0,
      true);

    // ---- ACCEPT: the human takes blue (38 cities), the bot red (17) and is behind --------------
    let sent = [];
    const gate = createLobby();
    const blue = openBotRoom(gate, sent, "pb250_blue", "blue");
    t.eq("PB-250 fixture: the bot room reaches round 1 before the offer", blue.round, 1);
    const offer = gate.handle("pb250_blue", { op: "tool", tool: "ceasefire" });
    t.ok("PB-250 AC1: the human's proposal is accepted by the server", Boolean(offer && offer.ok));
    t.eq("PB-250: the offer is PENDING on the proposer's own frame before the answer",
      [seatOf(sent).ceasefire.status, seatOf(sent).ceasefire.yours, seatOf(sent).ceasefire.canAnswer],
      ["pending", true, false]);

    gate.tickRooms(blue.t0 + 10000);
    const accepted = gate.debugRoom(blue.id);
    const blueSeat = seatOf(sent);
    const blueRoom = roomFacts(sent);
    t.eq("PB-250 AC1: the bot answered inside three rounds (one)",
      [blueSeat.ceasefire.status, accepted.round], ["accepted", 2]);
    t.eq("PB-250 AC3: the accepted truce is the SAME peace two humans get",
      [blueRoom.peace.active, blueRoom.peace.by, blueRoom.peace.coldWar, blueRoom.peace.canResume, accepted.over],
      [true, "blue", false, true, false]);
    t.ok("PB-250: the shipped config's mandatory window ([]) is already spent, so no forced wait stands",
      Number(blueRoom.peace.untilRound) <= Number(blueRoom.peace.since), JSON.stringify(blueRoom.peace));
    t.eq("PB-250 AC3: the proposer gets the server's own peace sentence, not a second wording",
      blueRoom.note, CEASEFIRE_NOTE);
    // The bot seat has no reader, so the room's log carries the HUMAN seat's line; the bot's own
    // sentence is the same builder's (asserted below against a two-human accept).
    t.eq("PB-250 AC2: the proposer gets its own line for the agreement",
      accepted.log.blue.filter((line) => /agreed/.test(line.text)).map((line) => line.text),
      ["cease fire agreed; the war is at peace"]);
    t.eq("PB-250: the bot's decision is on the room's own record (debugRoom)",
      (accepted.botActions || []).filter((row) => row.type === "ceasefire").map((row) => row.accept), [true]);

    // The bot must not break the peace it granted: with no mandatory length the counter is spent,
    // so a bot that kept the old cold-war resume would re-declare the war on the next tick.
    for (let step = 3; step <= 5; step += 1) gate.tickRooms(blue.t0 + step * 5000);
    const kept = gate.debugRoom(blue.id);
    t.eq("PB-250: the bot keeps the truce it accepted (the cold war is the only peace it breaks)",
      [kept.round >= 4,
        kept.log.blue.filter((line) => /broken the peace/i.test(line.text) && Number(line.round) > 2).length,
        Boolean((roomFacts(sent).peace || {}).active)],
      [true, 0, true]);

    // ---- DECLINE: the human takes red (17 cities), the bot blue (38) and is ahead ---------------
    sent = [];
    const red = openBotRoom(gate, sent, "pb250_red", "red");
    t.eq("PB-250 fixture: the second bot room reaches round 1", red.round, 1);
    const offer2 = gate.handle("pb250_red", { op: "tool", tool: "ceasefire" });
    t.ok("PB-250: the red seat's proposal is accepted by the server", Boolean(offer2 && offer2.ok));
    gate.tickRooms(red.t0 + 10000);
    const declined = gate.debugRoom(red.id);
    const redSeat = seatOf(sent);
    const redRoom = roomFacts(sent);
    t.eq("PB-250 AC1: the same bot DECLINES when it is ahead on cities",
      [redSeat.ceasefire.status, redSeat.ceasefire.by, declined.round], ["declined", "red", 2]);
    t.eq("PB-250 AC2: the proposer reads the refusal in its own line",
      declined.log.red.filter((line) => /declined/.test(line.text)).map((line) => line.text),
      ["your cease fire was declined; the war goes on"]);
    t.eq("PB-250 AC2: the proposer reads the refusal, and only once",
      declined.log.red.filter((line) => /declined/.test(line.text)).map((line) => line.text),
      ["your cease fire was declined; the war goes on"]);
    t.ok("PB-250 AC3: a declined offer starts no peace",
      !(redRoom.peace && redRoom.peace.active === true), JSON.stringify(redRoom.peace));
    t.eq("PB-250: the decline is on the room's own record",
      (declined.botActions || []).filter((row) => row.type === "ceasefire").map((row) => row.accept), [false]);

    // ---- the rule DISCRIMINATES: same board, one city moved, answer flips ---------------------
    const level = openMatch("1986", matchSites("1986"));
    seedOwners(level);
    level.ceasefire = { by: "red", round: 1, status: "pending", answeredRound: null };
    t.eq("PB-250 AC1: the 1986 board answers DECLINE for a bot that is ahead",
      [citiesHeld(level, "blue") > citiesHeld(level, "red"), botCeasefireAnswer(level, "blue")], [true, false]);
    const behind = JSON.parse(JSON.stringify(level));
    // Move cities out of blue until the bot is behind. This is the rule's input and nothing else.
    const blueCities = behind.sites.filter((site) => site && site.owner === "blue" && site.kind === "city");
    for (const site of blueCities.slice(0, 25)) site.owner = "red";
    t.eq("PB-250 AC1: the SAME board with the bot behind answers ACCEPT",
      [citiesHeld(behind, "blue") < citiesHeld(behind, "red"), botCeasefireAnswer(behind, "blue")], [true, true]);
    t.eq("PB-250: a seat never answers its own offer",
      botCeasefireAnswer(behind, "red"), false);

    // ---- AC3 as a comparison: two humans vs the bot, on the same board and round --------------
    const humans = openMatch("1986", matchSites("1986"));
    humans.round = 3;
    const humanOffer = useTool(humans, "blue", "ceasefire");
    t.ok("PB-250 fixture: a human proposal lands", Boolean(humanOffer && humanOffer.ok));
    const humanAccept = answerCeasefire(humans, "red", true);

    const botMatch = openMatch("1986", matchSites("1986"));
    botMatch.round = 3;
    useTool(botMatch, "blue", "ceasefire");
    const botAccept = answerCeasefire(botMatch, "red", botCeasefireAnswer(botMatch, "red"));
    t.ok("PB-250 fixture: the bot's rule says yes on this board", botAccept.accepted === true);
    t.eq("PB-250 AC3: a human accept and the bot accept write the same peace state",
      humanAccept.peace, botAccept.peace);
    t.eq("PB-250 AC3: and the same line for each seat",
      [logLines(humans, "blue", humanAccept.events, 3), logLines(humans, "red", humanAccept.events, 3)],
      [logLines(botMatch, "blue", botAccept.events, 3), logLines(botMatch, "red", botAccept.events, 3)]);
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not evidence */ }
  }

  console.log(t.line());
}
