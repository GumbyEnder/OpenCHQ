// Node test for `air` (order 275).
//
// What breaks if this node is removed: an aircraft flies a mission and is immediately flyable
// again, so air power costs nothing and there is no reason to hold it back. The counts are the
// booklet's (docs/POLISH_LOOP.md): 8 rounds after a strike, 4 after a scramble.

import { openMatch } from "../../server/match.mjs";
import { advance, issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { inactiveRounds, sendMission, tickAir } from "../../server/air.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "air";

function plane(id, side, x, y) {
  return {
    id, side, domain: "land", kind: "aircraft", x, y,
    path: [], pace: 1, facing: null, fighting: null, shots: 0,
  };
}

function freshMatch() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red" },
  ];
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;
  const air = rules().air || {};
  if (Number(air.strikeRounds) !== 8) fail("a strike must cost 8 rounds, the booklet count: " + air.strikeRounds);
  if (Number(air.patrolRounds) !== 4) fail("a scramble must cost 4 rounds, the booklet count: " + air.patrolRounds);
  if (!(Number(air.reach) > 0)) fail("no aircraft reach is configured");

  // --- a strike near a friendly city: allowed, and the aircraft goes inactive for 8 -----
  const match = freshMatch();
  const aircraft = plane("blue:air", "blue", 80, 40);
  match.pieces = [aircraft];
  match.round = 10;
  const strike = sendMission(match, "blue", "blue:air", "strike", { x: 100, y: 40 });
  if (strike.error) fail("a strike from a friendly city was refused: " + strike.error);
  if (inactiveRounds(aircraft, match.round) !== 8) {
    fail("a strike did not cost 8 rounds: " + inactiveRounds(aircraft, match.round));
  }
  if (!strike.events.some((event) => event.type === "strike" && event.rounds === 8)) {
    fail("the strike event did not report its cost: " + JSON.stringify(strike.events));
  }

  // --- while inactive: no second mission, and no order either --------------------------
  const again = sendMission(match, "blue", "blue:air", "strike", { x: 100, y: 40 });
  if (!again.error) fail("an inactive aircraft flew a second mission");
  if (!/8 more rounds/.test(again.error)) fail("the refusal did not say how long: " + again.error);
  aircraft.path = [{ x: 81, y: 40, pace: 1 }];
  const ordered = issueOrder(match, "blue", "blue:air", 90, 40);
  if (!ordered.error) fail("an inactive aircraft accepted an order");
  advance(match);
  if (aircraft.x !== 80 || aircraft.y !== 40) fail("an inactive aircraft moved: " + JSON.stringify(aircraft));
  aircraft.path = [];

  // --- the countdown reaches zero, and then it can fly -------------------------------
  match.round = 18;
  if (inactiveRounds(aircraft, match.round) !== 0) fail("8 rounds later the aircraft is still inactive");
  const ready = tickAir(match);
  if (!ready.some((event) => event.type === "ready" && event.pieceId === "blue:air")) {
    fail("becoming flyable produced no ready event: " + JSON.stringify(ready));
  }
  const patrol = sendMission(match, "blue", "blue:air", "patrol");
  if (patrol.error) fail("a scramble was refused after the countdown: " + patrol.error);
  if (inactiveRounds(aircraft, match.round) !== 4) {
    fail("a scramble did not cost 4 rounds: " + inactiveRounds(aircraft, match.round));
  }

  // --- a mission with no base in reach is refused ------------------------------------
  const far = freshMatch();
  const lonely = plane("blue:air", "blue", 300, 120);
  far.pieces = [lonely];
  far.round = 5;
  const refused = sendMission(far, "blue", "blue:air", "strike", { x: 300, y: 118 });
  if (!refused.error) fail("an aircraft struck with no city, dock or ship within reach");
  if (!/within reach/.test(refused.error)) fail("the refusal did not name the reason: " + refused.error);
  if (inactiveRounds(lonely, far.round) !== 0) fail("a refused mission still cost flying time");

  // --- a strike catches cargo; it does not invent damage on anything else ------------
  const sea = freshMatch();
  const hunter = plane("blue:air", "blue", 80, 40);
  const cargo = { id: "red:land", side: "red", domain: "land", kind: null, x: 82, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, transport: true };
  const soldier = { id: "red:land2", side: "red", domain: "land", kind: null, x: 84, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
  sea.pieces = [hunter, cargo, soldier];
  sea.round = 1;
  const caught = sendMission(sea, "blue", "blue:air", "strike", { x: 82, y: 40 });
  if (caught.error) fail("the strike on cargo was refused: " + caught.error);
  if (sea.pieces.some((piece) => piece.id === "red:land")) fail("a strike did not sink a caught transport");
  if (!caught.events.some((event) => event.type === "destroyed" && event.pieceId === "red:land")) {
    fail("the sunk transport produced no destroyed event");
  }
  if (!sea.pieces.some((piece) => piece.id === "red:land2")) fail("a strike on land removed a piece it has no rule for");
  const note = caught.events.find((event) => event.type === "strike").note;
  if (/[0-9$]/.test(String(note))) fail("the strike note invented a number: " + note);
  if (!/Stand-in/.test(String(note))) fail("a stand-in strike did not say it was a stand-in: " + note);

  // --- the tick keeps running with an aircraft in the match --------------------------
  const live = freshMatch();
  live.pieces = [plane("blue:air", "blue", 80, 40)];
  live.round = 0;
  const round = tickMatch(live);
  if (!round.events) fail("a round with an aircraft in it produced no events array");
}
