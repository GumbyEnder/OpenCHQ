// Node test for `air` (order 275).
//
// What breaks if this node is removed: an aircraft flies a mission and is immediately flyable
// again, so air power costs nothing and there is no reason to hold it back. The counts are the
// booklet's (docs/POLISH_LOOP.md): 8 rounds after a strike, 4 after a scramble.

import { openMatch } from "../../server/match.mjs";
import { advance, issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { inactiveRounds, sendMission, tickAir, STRIKE_NOTE } from "../../server/air.mjs";
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
  const strike = sendMission(match, "blue", "blue:air", "strike", { x: 85, y: 40 });
  if (strike.error) fail("a strike from a friendly city was refused: " + strike.error);
  if (inactiveRounds(aircraft, match.round) !== 8) {
    fail("a strike did not cost 8 rounds: " + inactiveRounds(aircraft, match.round));
  }
  if (!strike.events.some((event) => event.type === "strike" && event.rounds === 8)) {
    fail("the strike event did not report its cost: " + JSON.stringify(strike.events));
  }

  // --- while inactive: no second mission, and no order either --------------------------
  const again = sendMission(match, "blue", "blue:air", "strike", { x: 85, y: 40 });
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

  // --- PB-188: a STRIKE is a mission, so it flies inside the restricted circle ----------------
  // The ruling (room 8383 §4): the circle is a property of the air layer, not of the Bomb button.
  // The arms below pin the boundary, the cost of a refusal, and the two decisions the ticket
  // records rather than leaves implicit: the wrap seam counts as distance, and a patrol keeps the
  // open range because a scramble defaults to the aircraft's own cell.
  {
    const restricted = Math.floor(Number(air.restrictedReach));
    const maximum = Math.floor(Number(air.reach));
    if (!(restricted > 0)) fail("no restricted air radius is configured, so PB-188 cannot be measured");
    if (!(maximum > restricted)) fail("the maximum radius must be larger than the restricted one: " + maximum + " vs " + restricted);

    const atEdge = freshMatch();
    const edgePlane = plane("blue:air", "blue", 80, 40);
    atEdge.pieces = [edgePlane];
    atEdge.round = 3;
    const edge = sendMission(atEdge, "blue", "blue:air", "strike", { x: 80 + restricted, y: 40 });
    if (edge.error) fail("a strike exactly at the restricted radius was refused: " + edge.error);
    if (inactiveRounds(edgePlane, atEdge.round) !== 8) fail("the edge strike did not cost 8 rounds");

    const band = freshMatch();
    const bandPlane = plane("blue:air", "blue", 80, 40);
    const bystander = { id: "red:inf", side: "red", domain: "land", kind: "infantry", x: 80 + restricted + 1, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100 };
    band.pieces = [bandPlane, bystander];
    band.round = 3;
    const fuelBefore = JSON.stringify((band.sides && band.sides.blue && band.sides.blue.fuel) ?? null);
    const refusedStrike = sendMission(band, "blue", "blue:air", "strike", { x: 80 + restricted + 1, y: 40 });
    if (!refusedStrike.error) fail("a strike one cell past the restricted radius was accepted");
    if (!/air strike must be inside the restricted air radius \(\d+ cells\)/.test(refusedStrike.error)) {
      fail("the strike refusal did not name the restricted circle as a strike: " + refusedStrike.error);
    }
    if (!/maximum radius/.test(refusedStrike.error)) fail("the refusal did not name the maximum radius too: " + refusedStrike.error);
    if (inactiveRounds(bandPlane, band.round) !== 0) fail("a refused strike still cost the plane its flying time");
    if (JSON.stringify((band.sides && band.sides.blue && band.sides.blue.fuel) ?? null) !== fuelBefore) {
      fail("a refused strike still spent oil");
    }
    if (band.round !== 3) fail("a refused strike moved the round");
    if (bystander.strength !== 100) fail("a refused strike damaged a unit outside the circle: " + bystander.strength);

    // The wrap seam: at the board's edge the distance is the short way round, so a target
    // `restricted` cells across x=319/0 is INSIDE and one more is outside.
    const W = 320;
    const seam = openMatch("1986", []);
    seam.clock = "running";
    seam.sites = [
      { id: 20, name: "Seam Base", x: 2, y: 40, kind: "city", owner: "blue" },
      { id: 21, name: "Seam City", x: 200, y: 20, kind: "city", owner: "red" },
    ];
    const seamPlane = plane("blue:air", "blue", 2, 40);
    seam.pieces = [seamPlane];
    seam.round = 3;
    const wrapTarget = { x: (2 - restricted + W) % W, y: 40 };
    const wrapped = sendMission(seam, "blue", "blue:air", "strike", wrapTarget);
    if (wrapped.error) fail("a strike " + restricted + " cells across the wrap seam was refused: " + wrapped.error);
    seamPlane.inactiveUntil = 0;
    const seamOut = { x: (2 - restricted - 1 + W) % W, y: 40 };
    const across = sendMission(seam, "blue", "blue:air", "strike", seamOut);
    if (!across.error) fail("a strike " + (restricted + 1) + " cells across the wrap seam was accepted");

    // Patrol keeps the open range: DECIDED in the ticket, not forgotten. A scramble named at a far
    // cell still flies, because gating it would stack a second unverified assumption on the 6.
    const scramble = freshMatch();
    const scrambler = plane("blue:air", "blue", 80, 40);
    scramble.pieces = [scrambler];
    scramble.round = 3;
    const patrolFar = sendMission(scramble, "blue", "blue:air", "patrol", { x: 80 + maximum, y: 40 });
    if (patrolFar.error) fail("a patrol is supposed to keep the open range and was refused: " + patrolFar.error);
    if (inactiveRounds(scrambler, scramble.round) !== 4) fail("the far patrol did not cost 4 rounds");
  }

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
  if (note !== STRIKE_NOTE) fail("the strike event lost its note: " + note);

  // --- a strike pays (s>>1)+1 on land, and the hull's kind sets the sea count (PB-348) ---
  // decompiled.c 8795-8814 / docs/re/COMBAT.md s6 :233-245: land damage is (strength >> 1) + 1, so
  // 100 leaves 49; kinds 5-7 take 34 (three strikes) and kinds 8/9 take 25 (four).
  const land = freshMatch();
  const bomber = plane("blue:air", "blue", 80, 40);
  const target = { id: "red:inf", side: "red", domain: "land", kind: "infantry", x: 82, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100 };
  land.pieces = [bomber, target];
  land.round = 1;
  const halved = sendMission(land, "blue", "blue:air", "strike", { x: 82, y: 40 });
  if (halved.error) fail("the strike on a land unit was refused: " + halved.error);
  if (target.strength !== 100 - ((100 >> 1) + 1)) fail("a strike did not leave a full land unit at 49 (8795-8814): " + target.strength);

  const fleet = freshMatch();
  const flyer = plane("blue:air", "blue", 80, 40);
  const hull = { id: "red:ship", side: "red", domain: "sea", kind: "cruiser", x: 82, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100 };
  fleet.pieces = [flyer, hull];
  // A cruiser is kind 8: 25 a strike, so the third leaves it on 25 and the fourth sinks it.
  for (let i = 0; i < 3; i++) {
    flyer.inactiveUntil = 0;
    fleet.round = i + 1;
    const hit = sendMission(fleet, "blue", "blue:air", "strike", { x: 82, y: 40 });
    if (hit.error) fail("sea strike " + (i + 1) + " was refused: " + hit.error);
  }
  if (!fleet.pieces.some((piece) => piece.id === "red:ship")) fail("three strikes sank a kind-8 cruiser; it takes 25 a strike and needs four (8795-8814)");
  flyer.inactiveUntil = 0;
  fleet.round = 5;
  const fourth = sendMission(fleet, "blue", "blue:air", "strike", { x: 82, y: 40 });
  if (fourth.error) fail("the fourth sea strike was refused: " + fourth.error);
  if (fleet.pieces.some((piece) => piece.id === "red:ship")) fail("four strikes did not sink the cruiser");

  // --- the tick keeps running with an aircraft in the match --------------------------
  const live = freshMatch();
  live.pieces = [plane("blue:air", "blue", 80, 40)];
  live.round = 0;
  const round = tickMatch(live);
  if (!round.events) fail("a round with an aircraft in it produced no events array");
}
