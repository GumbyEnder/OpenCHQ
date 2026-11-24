// Node test for `pb235_pre_game_aid` — foreign aid opens while the clock is held AT ROUND 0.
//
// The lobby's hold gate refuses every tool while `room.clock !== "running"`, because spending money
// into a pause is how a pause becomes a free turn. That is right for a mid-war hold and wrong for the
// pre-game: manual p.14 says foreign aid is "used mostly in the pre-game and cease-fire portions",
// and the pre-game is round 0 with the clock not yet started. So the gate asks
// `toolOpensWhileHeld(match, tool)`: aid opens at round 0 only, and a hold after the first round has
// run is still a pause. (PB-224 retired the satellite TOOL and with it the old never-lost exception;
// a satellite is a unit now, and buying one is not a tool use at all.)
//
// Two arms, because each catches a different regression:
//   - the module arm pins the predicate (round 0 vs round > 0, the retired satellite tool, fail-closed
//     on a room with no round);
//   - the wire arm drives the real lobby over the suite's server: a bot room is held at round 0, an
//     aid is accepted (an `ack` with an aid event, not the clock error), nuke still gets
//     "Start the clock first.", the clock then runs a round and is held again, and the same aid is
//     now refused by the gate. That arm is what reds if lobby.mjs goes back to naming the satellite
//     exception itself.

import { openMatch } from "../../server/match.mjs";
import { AID_HELD_MID_WAR, useTool, toolOpensWhileHeld } from "../../server/late.mjs";

export const name = "pb235_pre_game_aid";

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(got, want, message) {
  if (got !== want) throw new Error(message + " (got " + JSON.stringify(got) + ", want " + JSON.stringify(want) + ")");
}

function match(got, pattern, message) {
  if (!pattern.test(String(got))) throw new Error(message + " (got " + JSON.stringify(got) + ")");
}

function fixture(round) {
  const match = openMatch("1986", []);
  match.clock = "held";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.pieces = [];
  match.sites = [
    // Country 3 owns THREE cities, so the first gift is banked (1 of 3) and nothing turns: the
    // pre-game arm has to prove it charges and banks, not that it flips something on contact.
    { id: 14, name: "Minsk", x: 190, y: 30, kind: "city", owner: "red", country_id: 3 },
    { id: 18, name: "Brest", x: 188, y: 34, kind: "city", owner: "red", country_id: 3 },
    { id: 19, name: "Grodno", x: 186, y: 28, kind: "city", owner: "red", country_id: 3 },
    // Red's home country (1) and the seat's own city, for the refusal arms.
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red", country_id: 1 },
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue", country_id: 0 },
    { id: 20, name: "Empty Sea", x: 60, y: 90, kind: "water", owner: null },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 180, y: 22 } };
  match.capitalSet = {
    era: "1986",
    source: "fixture",
    list: [
      { siteId: 10, name: "New York", x: 80, y: 40, owner: "blue" },
      { siteId: 12, name: "Kiev", x: 180, y: 22, owner: "red" },
    ],
    missing: [],
  };
  match.round = round;
  return match;
}

function aid(target) {
  return useTool(target, "blue", "aid", { x: 190, y: 30 });
}

export async function run(ctx) {
  // --- the predicate, as the lobby calls it --------------------------------------------
  equal(toolOpensWhileHeld(fixture(0), "aid"), true, "aid opens on a held clock at round 0");
  equal(toolOpensWhileHeld(fixture(1), "aid"), false, "aid is refused on a held clock after round 0");
  equal(toolOpensWhileHeld(fixture(6), "aid"), false, "aid is refused on a held clock at round 6");
  // PB-224: there is no satellite TOOL any more - a recon satellite is a bought unit - so the old
  // exception is gone with it. A held clock opens nothing but aid.
  equal(toolOpensWhileHeld(fixture(0), "satellite"), false, "the retired satellite tool must not open at round 0");
  equal(toolOpensWhileHeld(fixture(6), "satellite"), false, "the retired satellite tool must not open mid-war");
  for (const tool of ["nuke", "intel", "ceasefire", "buy", "oil"]) {
    equal(toolOpensWhileHeld(fixture(0), tool), false, tool + " stays refused on a held clock at round 0");
  }
  equal(toolOpensWhileHeld({}, "aid"), false, "aid stays refused when the match carries no round");
  equal(toolOpensWhileHeld(null, "aid"), false, "aid stays refused when there is no match");

  // AC4: the sentence a mid-war hold gives aid names the state it needs and the state it is in, and
  // it is not the generic clock line. A cease-fire is deliberately not offered: no such state exists.
  match(AID_HELD_MID_WAR, /pre-game/, "the mid-war aid refusal names the pre-game");
  match(AID_HELD_MID_WAR, /held mid-war/, "the mid-war aid refusal names the hold");
  ok(AID_HELD_MID_WAR !== "Start the clock first.", "the mid-war aid refusal is its own sentence");
  ok(!/cease-?fire/i.test(AID_HELD_MID_WAR), "the refusal does not promise a cease-fire this build cannot enter");

  // --- the pick itself is the same in the pre-game as in the war -----------------------
  const pre = fixture(0);
  const preCash = pre.sides.blue.cash;
  const preOwners = pre.sites.map((site) => site.id + ":" + site.owner).join(",");
  const gift = aid(pre);
  ok(!gift.error, "aid at round 0 is accepted: " + JSON.stringify(gift.error));
  const event = (gift.events || []).find((row) => row.type === "aid");
  ok(event, "the round-0 gift produced an aid event");
  equal(event.site, 14, "the event stays on the city the player picked");
  equal(event.round, 0, "the event carries round 0, not a later round");
  equal(event.turned, null, "the first of three gifts turns nothing");
  equal(event.gifts, 1, "the first gift is banked as 1");
  equal(event.needed, 3, "a three-city nation needs three gifts");
  ok(pre.sides.blue.cash < preCash, "the round-0 gift charged the seat");
  equal(event.cost, preCash - pre.sides.blue.cash, "the charge matches the event's stated cost");
  equal(pre.sites.map((site) => site.id + ":" + site.owner).join(","), preOwners, "no city changed hands on a banked gift");
  match(event.note, /^Foreign aid to Minsk: .+ is 1 of 3 gifts from turning; this gift is banked\.$/,
    "the round-0 sentence names the city, the step and the bank");

  const war = fixture(4);
  const warCash = war.sides.blue.cash;
  const warGift = aid(war);
  ok(!warGift.error, "the same pick is accepted at round 4");
  const warEvent = (warGift.events || []).find((row) => row.type === "aid");
  equal(warEvent.note, event.note, "the sentence does not change with the round");
  equal(warCash - war.sides.blue.cash, preCash - pre.sides.blue.cash, "the charge does not change with the round");

  // --- the wire: the lobby's own gate, both sides of the hold --------------------------
  const user = await ctx.register();
  const socket = ctx.socket(user.token);
  // Every wait scans only the frames that arrived AFTER its own send. Without a cursor a later wait
  // can match an earlier refusal and turn a retry loop into a tautology.
  const mark = () => socket.box.length;
  const answerAfter = (from, pred, label) => socket.wait(pred, label, from);
  try {
    let from = mark();
    await answerAfter(from, (m) => m.op === "welcome", "welcome");
    from = mark();
    socket.send({ op: "bot", era: "1986", side: "blue" });
    const opening = await answerAfter(from, (m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
    equal(opening.room.round, 0, "a fresh bot room is round 0");
    equal(opening.room.clock, "held", "a fresh bot room holds the clock");

    const sites = Array.isArray(opening.room.sites) ? opening.room.sites : [];
    const targets = sites.filter((site) => site && site.kind === "city" && site.owner !== "blue");
    if (!targets.length) ctx.skip("this host's extract gave the 1986 board no city to aim at");

    // Try the enemy/neutral cities until one is paid for. A legal target is any city outside the
    // opponent's home country; the home-country refusals are PB-227's and are named, not silent, so
    // an arm that only ever sees them fails below with the last refusal attached.
    let accepted = null;
    let lastRefusal = "";
    for (const site of targets.slice(0, 8)) {
      const at = mark();
      socket.send({ op: "tool", tool: "aid", to: { x: site.x, y: site.y } });
      const answer = await answerAfter(at, (m) => (m.op === "ack" && Array.isArray(m.events) && m.events.some((e) => e.type === "aid"))
        || (m.op === "error" && m.error), "aid answer at " + site.name);
      if (answer.op === "ack") {
        accepted = { site, event: answer.events.find((e) => e.type === "aid") };
        break;
      }
      if (answer.error === "Start the clock first.") {
        throw new Error("the pre-game aid was refused by the hold gate: " + JSON.stringify(answer));
      }
      lastRefusal = answer.error;
    }
    ok(accepted, "no pre-game aid was accepted; last refusal: " + lastRefusal);
    ok(accepted.event.cost > 0, "the accepted pre-game aid charged the seat: " + JSON.stringify(accepted.event));
    equal(accepted.event.round, 0, "the accepted pre-game aid belongs to round 0");

    // The guard survives on the same held round: every other tool still needs the clock.
    from = mark();
    socket.send({ op: "tool", tool: "nuke" });
    const nuke = await answerAfter(from, (m) => m.op === "error" && m.error, "nuke refusal while held");
    equal(nuke.error, "Start the clock first.", "nuke is still refused while the clock is held at round 0");

    // Let a round run, hold again, and the same tool is now a pause spend: refused. The room's own
    // speed is set to 6 (0.6 s a round) first: at the default 5 s round the 2 s frame window would
    // read "no round yet" and the arm would fail on the harness's clock, not on the rule.
    from = mark();
    socket.send({ op: "speed", speed: 6 });
    await answerAfter(from, (m) => m.op === "room" && m.room && Number(m.room.speed) === 6, "speed 6");
    from = mark();
    socket.send({ op: "run" });
    await ctx.waitUntil(socket.box, from, (m) => m.op === "room" && m.room && Number(m.room.round) >= 1,
      "a round ran", 20000);
    from = mark();
    socket.send({ op: "hold" });
    await ctx.waitUntil(socket.box, from, (m) => m.op === "room" && m.room && m.room.clock !== "running",
      "clock held after a round", 10000);
    from = mark();
    socket.send({ op: "tool", tool: "aid", to: { x: targets[0].x, y: targets[0].y } });
    const held = await answerAfter(from, (m) => m.op === "error" && m.error, "aid refusal mid-war hold");
    // PB-235 AC4: the mid-war refusal is aid's own sentence, not the generic clock line - the
    // player must be told which state the tool needs (the pre-game) and where the room is (held
    // mid-war). The cease-fire is deliberately absent: this build has no cease-fire state.
    equal(held.error, AID_HELD_MID_WAR, "aid's mid-war refusal names the pre-game and the hold: " + JSON.stringify(held));
    ok(held.error !== "Start the clock first.", "aid's mid-war refusal is not the generic clock line");
  } finally {
    socket.close();
  }
}
