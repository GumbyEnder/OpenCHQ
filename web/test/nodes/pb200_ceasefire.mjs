// pb200_ceasefire — a cease fire is a PROPOSAL the opponent must accept (PB-200).
//
// The manual (p.32, L1032): "ask for a cease-fire, or to resign. Your opponent must agree to your
// proposed cease-fire, or the war continues." The shipped tool said "Cease fire accepted." to the
// player who clicked it, with no opponent in the loop, and its log line landed a round after the
// event that caused it.
//
// What fails if this module is removed:
//   - the tool ends the match by itself again (AC1/AC2: no offer, no answer, war over)
//   - the answering side is not told, or the proposer is allowed to answer itself
//   - an accepted truce reports a winner or a reason other than "ceasefire" (AC3)
//   - the offer's event round and its log round disagree (AC4)
//   - a bot seat leaves an offer on the table forever instead of answering it
//     (PB-250 owns WHICH answer; this arm grades that an answer lands at all)
//
// Everything after the module arms goes over real sockets with real sessions, the way the page does.

import { openMatch } from "../../server/match.mjs";
import { forSeat, resultNote, resultOf } from "../../server/view.mjs";
import { answerCeasefire, ceasefireOf, kitBriefing, useTool, CEASEFIRE_DECLINED_NOTE, CEASEFIRE_NOTE, CEASEFIRE_PROPOSED_NOTE } from "../../server/late.mjs";
import { logLines } from "../../server/log.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "pb200_ceasefire";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function fresh(era = "1986") {
  const match = openMatch(era, []);
  match.clock = "running";
  match.round = 3;
  return match;
}

export async function run(ctx) {
  // ---- module arms: offer, decline, offer again, accept ------------------------------------
  {
    const match = fresh();
    const board = JSON.stringify(match.sites) + JSON.stringify(match.pieces);
    const offer = useTool(match, "blue", "ceasefire");
    if (offer.error) fail("a cease fire was refused: " + offer.error);
    const proposed = (offer.events || []).find((event) => event.type === "ceasefire_proposed");
    if (!proposed) fail("the tool produced no proposal: " + JSON.stringify(offer.events));
    eq("the proposal's note", proposed.note, CEASEFIRE_PROPOSED_NOTE);
    if (match.over) fail("the proposal ended the match without an answer");
    eq("the proposal changed the board", JSON.stringify(match.sites) + JSON.stringify(match.pieces), board);

    const blueSees = forSeat(match, "blue").seat.ceasefire;
    const redSees = forSeat(match, "red").seat.ceasefire;
    eq("the proposer's view says the offer is its own", [blueSees.status, blueSees.yours, blueSees.canAnswer], ["pending", true, false]);
    eq("the opponent's view says it may answer", [redSees.status, redSees.yours, redSees.canAnswer], ["pending", false, true]);

    if (!useTool(match, "blue", "ceasefire").error) fail("a second offer was accepted while one was pending");
    if (!answerCeasefire(match, "blue", true).error) fail("the proposer answered its own offer");

    const decline = answerCeasefire(match, "red", false);
    if (decline.error) fail("the decline was refused: " + decline.error);
    if (match.over) fail("a declined cease fire ended the match");
    eq("the decline's note", (decline.events[0] || {}).note, CEASEFIRE_DECLINED_NOTE);
    eq("a declined offer is off the table", ceasefireOf(match, "red").status, "declined");
    if (!answerCeasefire(match, "red", true).error) fail("an offer that was already declined was answered again");
    eq("the declined board is untouched", JSON.stringify(match.sites) + JSON.stringify(match.pieces), board);

    // A fresh offer, from the OTHER side this time, then an acceptance.
    const second = useTool(match, "red", "ceasefire");
    if (second.error) fail("a fresh offer was refused after a decline: " + second.error);
    const accept = answerCeasefire(match, "blue", true);
    if (accept.error) fail("the acceptance was refused: " + accept.error);
    eq("the acceptance's note", (accept.events[0] || {}).note, CEASEFIRE_NOTE);
    // PB-245 (manual p.31): peace is a STATE. An accepted cease fire no longer ends the match, so
    // `over` and `winner` stay put and the seat reads the peace object instead of a result.
    if (match.over) fail("an accepted cease fire ended the match; p.31 makes it a state");
    if (match.winner) fail("an accepted cease fire named a winner; a truce is not a victory");
    const bluePeace = forSeat(match, "blue").peace;
    const redPeace = forSeat(match, "red").peace;
    eq("both seats read peace", [Boolean(bluePeace && bluePeace.active), Boolean(redPeace && redPeace.active)], [true, true]);
    eq("the peace names the offerer", [bluePeace.by, redPeace.by], ["red", "red"]);
    eq("the peace keeps the match open for both seats", [forSeat(match, "blue").over, forSeat(match, "red").over], [false, false]);
    eq("no result is invented", resultOf(match), null);
    if (!answerCeasefire(match, "blue", true).error) fail("a finished match still answered an offer");
  }

  // ---- log arms: each fact is readable in the seat's own voice -----------------------------
  {
    const match = fresh();
    const offer = useTool(match, "blue", "ceasefire");
    const own = logLines(match, "blue", offer.events, 4);
    const foe = logLines(match, "red", offer.events, 4);
    if (!own.length || !/proposed/.test(own[0].text)) fail("the proposer has no proposal line: " + JSON.stringify(own));
    if (!foe.length || !/cease fire/i.test(foe[0].text)) fail("the opponent has no proposal line: " + JSON.stringify(foe));
    const decline = answerCeasefire(match, "red", false);
    const proposerSees = logLines(match, "blue", decline.events, 4);
    const declinerSees = logLines(match, "red", decline.events, 4);
    if (!proposerSees.length) fail("the proposer has no decline line");
    if (!declinerSees.length) fail("the decliner has no decline line");
    // Both voices are pinned, per seat. A presence-only assert passes on an inverted branch: the
    // decliner was once told "a cease fire was declined" and the proposer "you declined the cease
    // fire", and both lines still existed. The sentence must name the seat that did the act.
    if (!proposerSees.some((line) => /^your cease fire was declined; the war goes on$/.test(line.text))) {
      fail("the proposer's decline line is not the refusal of its own offer: " + JSON.stringify(proposerSees));
    }
    if (!declinerSees.some((line) => /^you declined the cease fire; the war goes on$/.test(line.text))) {
      fail("the decliner's decline line does not name its own act: " + JSON.stringify(declinerSees));
    }
    if (proposerSees.some((line) => /^you declined/.test(line.text))) {
      fail("the proposer is told it declined its own offer: " + JSON.stringify(proposerSees));
    }
    useTool(match, "blue", "ceasefire");
    const accept = answerCeasefire(match, "red", true);
    for (const side of ["blue", "red"]) {
      if (!logLines(match, side, accept.events, 4).length) fail("seat " + side + " has no line for the agreed truce");
    }
  }

  // ---- the briefing and the page say "proposal", and the page has both answers -----------------
  {
    const brief = kitBriefing(fresh(), "blue").find((entry) => entry.name === "ceasefire");
    if (!brief) fail("the kit has no cease-fire entry");
    if (!/proposal/i.test(brief.text)) fail("the briefing still calls the cease fire an accepted act: " + brief.text);
    if (!/opponent must agree/i.test(brief.text)) fail("the briefing does not say the opponent must agree: " + brief.text);
    if (/^Accepted/i.test(brief.text)) fail("the briefing still opens by accepting the offer: " + brief.text);

    // The page's own two halves: the pending label the proposer reads, and the decline op. Both are
    // strings a later edit would silently drop, so they are pinned here rather than eyeballed.
    const page = readFileSync(fileURLToPath(new URL("../../public/app.js", import.meta.url)), "utf8");
    const row = page.slice(page.indexOf("function toolRow"), page.indexOf("function paintLog"));
    if (!/Cease-fire proposed/.test(row)) fail("the page has no pending cease-fire label");
    if (!/op: "ceasefire_answer", accept: false/.test(row)) fail("the page has no decline button");
    if (!/op: "ceasefire_answer", accept: true/.test(row)) fail("the page has no accept button");
    if (!/truce\.canAnswer/.test(row)) fail("the page does not read the seat's canAnswer flag");
  }

  // ---- a PvP room: the opponent gets accept/decline, and the rounds agree -------------------
  const alice = await ctx.register("TruceBlue");
  const bob = await ctx.register("TruceRed");
  const a = ctx.socket(alice.token);
  const b = ctx.socket(bob.token);
  await new Promise((resolve) => {
    if (a.ws.readyState === 1 && b.ws.readyState === 1) return resolve();
    let open = 0;
    const done = () => { open += 1; if (open === 2) resolve(); };
    if (a.ws.readyState === 1) done(); else a.ws.addEventListener("open", done);
    if (b.ws.readyState === 1) done(); else b.ws.addEventListener("open", done);
  });
  await a.wait((m) => m.op === "welcome", "alice welcome");
  await b.wait((m) => m.op === "welcome", "bob welcome");

  // Both cursors are taken BEFORE the invite is sent: the two frames land in the same tick, so a
  // cursor read after alice's frame can already be past bob's.
  let markA = a.box.length;
  let markB = b.box.length;
  a.send({ op: "invite", user: bob.user.username, era: "1986", side: "blue" });
  const invited = await a.wait((m) => m.op === "invited" && m.invite, "alice's invite", markA);
  const shown = await b.wait((m) => m.op === "invite" && m.invite, "bob's invite", markB);
  if (shown.invite.id !== invited.invite.id) fail("the two seats saw different invites");
  b.send({ op: "answer", id: shown.invite.id, accept: true });
  const roomA = await a.wait((m) => m.op === "room" && m.room && m.room.id && m.room.era === "1986", "alice's room");
  const roomB = await b.wait((m) => m.op === "room" && m.room && m.room.id === roomA.room.id, "bob's room");
  if (roomA.room.id !== roomB.room.id) fail("the two seats landed in different rooms");

  // Round 0.6 s so the log arrives inside a test; then start the clock the way a player does.
  markA = a.box.length;
  a.send({ op: "speed", speed: 6 });
  await a.wait((m) => m.op === "speed" && m.speed === 6, "speed 6", markA);
  markA = a.box.length;
  a.send({ op: "run" });
  await a.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "clock running", markA);

  // AC1: the offer reaches the table, and the OTHER seat is told it may answer.
  markA = a.box.length;
  a.send({ op: "tool", tool: "ceasefire" });
  const ack = await a.wait((m) => m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "ceasefire_proposed"), "the proposal ack", markA);
  const eventRound = ack.events.find((e) => e.type === "ceasefire_proposed").round;
  const bRoom = await ctx.waitUntil(b.box, 0, (m) => m.op === "room" && m.room && m.room.seat && m.room.seat.ceasefire && m.room.seat.ceasefire.canAnswer === true, "bob's answerable offer", 8000);
  if (bRoom.room.over) fail("the proposal ended the match before bob answered");
  const aRoom = await a.wait((m) => m.op === "room" && m.room && m.room.seat && m.room.seat.ceasefire && m.room.seat.ceasefire.yours === true, "alice's own pending offer");
  if (aRoom.room.over) fail("the proposer's room ended on its own offer");

  // AC4: the event's round and the round its log line prints are the same number. The frame that
  // carries the line is the round the fact landed in, which is one ahead of the round it happened.
  const logFrame = await ctx.waitUntil(b.box, 0, (m) => m.op === "log" && Array.isArray(m.lines) && m.lines.some((line) => /cease fire/i.test(line.text)), "bob's proposal log line", 8000);
  const proposalLine = logFrame.lines.find((line) => /cease fire/i.test(line.text));
  eq("the proposal's event round and its log round", proposalLine.round, eventRound);
  if (!(Number(logFrame.round) > Number(eventRound))) {
    fail("the proposal's line arrived in the same round it was made in, so the agreement arm proves nothing: frame " + logFrame.round + ", event " + eventRound);
  }

  // AC2, the pending half: the offer does NOT stop the war. A round runs while the offer is on the
  // table, which is the manual's "or the war continues".
  const offerRound = Number(aRoom.room.round);
  // A round arrives as a delta once the seat has a shadow, so the delta's own round is the witness;
  // waiting for another whole `room` frame here would wait for a frame the server is right not to send.
  await ctx.waitUntil(a.box, 0,
    (m) => (m.op === "delta" && m.delta && Number(m.delta.round) > offerRound) ||
      (m.op === "room" && m.room && Number(m.room.round) > offerRound),
    "a round while the offer is pending", 8000);

  // AC2: declined leaves the war running, and the board unchanged.
  markB = b.box.length;
  b.send({ op: "ceasefire_answer", accept: false });
  const declinedAck = await b.wait((m) => m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "ceasefire_declined"), "the decline ack", markB);
  if (!declinedAck) fail("the decline produced no ack");
  const afterDecline = await ctx.waitUntil(a.box, 0, (m) => m.op === "room" && m.room && m.room.seat && m.room.seat.ceasefire && m.room.seat.ceasefire.status === "declined", "the declined room", 8000);
  if (afterDecline.room.over) fail("a declined cease fire ended the match");
  const declineLine = await ctx.waitUntil(a.box, 0, (m) => m.op === "log" && Array.isArray(m.lines) && m.lines.some((line) => /^your cease fire was declined; the war goes on$/.test(line.text)), "alice's decline line", 8000);
  if (!declineLine) fail("the proposer never read that the offer was declined");
  // The proposer is alice. An inverted branch tells her she declined her own offer, and the loose
  // /declined/i match above was satisfied by exactly that sentence.
  const aliceLog = (line) => /^you declined the cease fire/.test(line.text);
  if (a.box.some((m) => m.op === "log" && Array.isArray(m.lines) && m.lines.some(aliceLog))) {
    fail("the proposer was told it declined its own offer");
  }

  // AC3: a fresh offer, accepted, ends the match with reason "ceasefire" and no winner.
  markA = a.box.length;
  a.send({ op: "tool", tool: "ceasefire" });
  await a.wait((m) => m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "ceasefire_proposed"), "the second offer ack", markA);
  await ctx.waitUntil(b.box, 0, (m) => m.op === "room" && m.room && m.room.seat && m.room.seat.ceasefire && m.room.seat.ceasefire.canAnswer === true, "bob's second answerable offer", 8000);
  markB = b.box.length;
  markA = a.box.length;
  b.send({ op: "ceasefire_answer", accept: true });
  // PB-245: no `over` frame is sent. Both seats read the same peace object with the match open.
  const peaceB = await ctx.waitUntil(b.box, markB, (m) => m.op === "room" && m.room && m.room.peace && m.room.peace.active === true, "bob's peace state", 8000);
  eq("the answerer's match stays open", Boolean(peaceB.room.over), false);
  const peaceA = await ctx.waitUntil(a.box, markA, (m) => m.op === "room" && m.room && m.room.peace && m.room.peace.active === true, "alice's peace state", 8000);
  eq("the proposer's match stays open", Boolean(peaceA.room.over), false);
  eq("both seats read the same deadline", peaceA.room.peace.untilRound, peaceB.room.peace.untilRound);
  if (a.box.slice(markA).some((m) => m.op === "over")) fail("an accepted cease fire sent an over frame");
  if (b.box.slice(markB).some((m) => m.op === "over")) fail("an accepted cease fire sent the answerer an over frame");

  // ---- a bot seat ANSWERS (PB-250: which word is the city rule's business, not this arm's) ---
  const carol = await ctx.register("TruceBot");
  const c = ctx.socket(carol.token);
  await new Promise((resolve) => {
    if (c.ws.readyState === 1) return resolve();
    c.ws.addEventListener("open", () => resolve());
  });
  await c.wait((m) => m.op === "welcome", "carol welcome");
  let markC = c.box.length;
  c.send({ op: "bot", era: "1986", side: "blue" });
  const botRoom = await c.wait((m) => m.op === "room" && m.room && m.room.era === "1986" && m.room.id, "the bot room", markC);
  // The room frame names the two seats as `blue`/`red` with their kind, not as a `seats` table.
  if (!botRoom.room.red || botRoom.room.red.kind !== "bot") {
    fail("the bot room has no bot seat: " + JSON.stringify({ blue: botRoom.room.blue, red: botRoom.room.red }));
  }
  markC = c.box.length;
  c.send({ op: "speed", speed: 6 });
  await c.wait((m) => m.op === "speed" && m.speed === 6, "bot room speed 6", markC);
  markC = c.box.length;
  c.send({ op: "run" });
  await c.wait((m) => m.op === "room" && m.room && m.room.clock === "running", "bot room clock running", markC);
  markC = c.box.length;
  c.send({ op: "tool", tool: "ceasefire" });
  await c.wait((m) => m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "ceasefire_proposed"), "the bot-room offer ack", markC);
  // The decline rides a delta's `seat` (seatChanged) when the seat already had a shadow; both shapes
  // are accepted so this arm grades the fact, not which frame happened to carry it.
  // PB-250 replaced the fixed DECLINE with a stated rule (bot.mjs:botCeasefireAnswer: the bot accepts
  // only when it holds fewer cities than the proposer). This arm therefore grades the FACT PB-200
  // owns - the offer stops hanging and the answering status reaches the proposer - and leaves which
  // word to PB-250's own arm, which flips the city count to get both answers.
  const answered = (seat) => seat && seat.ceasefire &&
    (seat.ceasefire.status === "declined" || seat.ceasefire.status === "accepted");
  const botAnswered = await ctx.waitUntil(c.box, 0,
    (m) => (m.op === "room" && m.room && answered(m.room.seat)) ||
      (m.op === "delta" && m.delta && answered(m.delta.seat)),
    "the bot's answer", 8000);
  const answerFrame = botAnswered.op === "room" ? botAnswered.room : botAnswered.delta;
  const status = answerFrame.seat.ceasefire.status;
  // A decline leaves the war on; an accept enters the peace PB-245 made a STATE. Neither is an ending.
  if (answerFrame.over) fail("the bot's answer (" + status + ") ended the match");
  if (status === "accepted" && !(answerFrame.peace && answerFrame.peace.active)) {
    fail("the bot accepted but the seat reads no peace: " + JSON.stringify(answerFrame.peace));
  }

  for (const sock of [a, b, c]) sock.close();
}
