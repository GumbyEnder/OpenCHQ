// Node test for PB-157: bombing an empty enemy city, base or oil field.
//
// What breaks if this node is removed: a bombing run takes no money, a bombed city can still
// produce next round, a bombed oil field costs the owner nothing, a defended target is accepted
// (spending the aircraft on a site the strike mission already covers), a capital is accepted, a
// refusal burns the plane or the mission's oil, or one of the two client doors (Kit, Air) stops
// arming its Bomb button (see BOMB_SITE_KINDS and the capital rule in sendMission).
//
// Rule, decoded (config `air.bomb*`): FUN_1ac5_0dbe @ 1ac5:0dbe, decompiled.c 8768-8782;
// MANUAL p.25. An air mission on an unoccupied enemy city or base takes 5 of the original's money
// units (125 M; the panel divides cash by 40) and adds 5 to the site's timer. On a type-5 oil
// field the owner's next-round oil available drops by 1000 raw units (8 on the panel's /125
// scale). The aircraft is inactive for the strike's 8 rounds and is refused, not spent, on a
// defended or invalid target.

import { readFileSync } from "node:fs";
import { openMatch } from "../../server/match.mjs";
import { sendMission, airBriefing } from "../../server/air.mjs";
import { meterOf, upkeepResources } from "../../server/resources.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "pb157_bomb";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function plane(id, side, x, y) {
  return {
    id, side, domain: "air", kind: "aircraft", x, y, path: [], pace: 1,
    facing: null, fighting: null, shots: 0, inactiveUntil: 0,
  };
}

// A 1986 board: Blue holds a city with a plane on it (its berth), Red holds a capital, a city, a
// base and a type-5 oil field. Nothing is within sight of anything, so only the bombing rule moves
// a number. PB-157a: the capital is its own site, because a bombing run must not be able to hit it
// (the fixture used to park `capitals.red` on Kiev, which made "bomb an enemy city" and "bomb a
// capital" the same click).
function board() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.round = 10;
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.sides.red.fuel = 5000;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", type: 4, owner: "blue" },
    { id: 63, name: "Moscow", x: 150, y: 22, kind: "capital", type: 2, owner: "red" },
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", type: 4, owner: "red" },
    { id: 30, name: "Minsk Base", x: 200, y: 40, kind: "base", type: 3, owner: "red" },
    { id: 64, name: "Baku Field", x: 200, y: 60, kind: "facility", type: 5, owner: "red" },
  ];
  match.pieces = [plane("blue:plane", "blue", 80, 40)];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 150, y: 22 } };
  return match;
}

export async function run() {
  // --- the mission is offered, at the strike's round cost ------------------------------
  const brief = airBriefing(board(), "blue")[0];
  const bomb = brief.missions.find((mission) => mission.mode === "bomb");
  if (!bomb) fail("the aircraft briefing does not offer a bombing run");
  eq("the bombing run costs the strike's rounds", bomb.rounds, brief.missions.find((m) => m.mode === "strike").rounds);

  // --- an empty enemy city loses 125 M and is unready 5 rounds ------------------------
  const city = board();
  const sent = sendMission(city, "blue", "blue:plane", "bomb", { x: 180, y: 22 });
  if (sent.error) fail("an empty enemy city refused a bombing run: " + sent.error);
  eq("the city's owner lost 125 M", city.sides.red.cash, 50000 - 125);
  eq("the city is unready for 5 rounds", city.sites.find((s) => s.id === 12).readyRound, 15);
  eq("the plane is inactive for the strike's 8 rounds", city.pieces[0].inactiveUntil, 10 + 8);
  const event = sent.events.find((e) => e.type === "bomb_hit");
  if (!event) fail("the bombing run emitted no bomb event");
  eq("the event names the cash taken", event.cash, 125);
  eq("the event names the owner", event.owner, "red");
  const ownerLog = logLines(city, "red", sent.events, city.round).map((line) => line.text);
  if (!ownerLog.some((line) => /lost 0\.125b/.test(line))) {
    fail("the owner's round log does not read the loss: " + JSON.stringify(ownerLog));
  }

  // --- the floor is 0, not a negative pool -------------------------------------------
  const poor = board();
  poor.sides.red.cash = 100;
  const broke = sendMission(poor, "blue", "blue:plane", "bomb", { x: 180, y: 22 });
  if (broke.error) fail("a poor owner refused a bombing run: " + broke.error);
  eq("the owner's pool stops at 0", poor.sides.red.cash, 0);
  eq("the event reports what was actually taken", broke.events.find((e) => e.type === "bomb_hit").cash, 100);

  // --- a defended target is refused, and the aircraft is not spent -------------------
  const held = board();
  held.pieces.push({ id: "red:inf", side: "red", domain: "land", kind: "infantry", x: 180, y: 22, path: [], pace: 1, strength: 100 });
  const refused = sendMission(held, "blue", "blue:plane", "bomb", { x: 180, y: 22 });
  if (!refused.error) fail("a defended city accepted a bombing run");
  if (!/defended/.test(refused.error)) fail("the refusal does not say the target is defended: " + refused.error);
  eq("a refused run leaves the owner's cash alone", held.sides.red.cash, 50000);
  eq("a refused run leaves the aircraft ready", held.pieces[0].inactiveUntil, 0);

  // An aircraft based there is on the air layer and does not shield the site (T-021).
  const airOnly = board();
  airOnly.pieces.push({ id: "red:based", side: "red", domain: "air", kind: "aircraft", x: 180, y: 22, path: [], pace: 1, inactiveUntil: 0 });
  const throughAir = sendMission(airOnly, "blue", "blue:plane", "bomb", { x: 180, y: 22 });
  if (throughAir.error) fail("a based aircraft shielded its city from a bombing run: " + throughAir.error);

  // --- a base is a legal target; a neutral or friendly site is not -------------------
  const baseHit = board();
  const onBase = sendMission(baseHit, "blue", "blue:plane", "bomb", { x: 200, y: 40 });
  if (onBase.error) fail("an empty enemy base refused a bombing run: " + onBase.error);
  eq("a bombed base is unready 5 rounds", baseHit.sites.find((s) => s.id === 30).readyRound, 15);

  const neutral = board();
  neutral.sites.find((s) => s.id === 12).owner = null;
  if (!sendMission(neutral, "blue", "blue:plane", "bomb", { x: 180, y: 22 }).error) {
    fail("a neutral city accepted a bombing run");
  }
  const own = board();
  own.sites.find((s) => s.id === 12).owner = "blue";
  if (!sendMission(own, "blue", "blue:plane", "bomb", { x: 180, y: 22 }).error) {
    fail("a friendly city accepted a bombing run");
  }
  const nowhere = board();
  if (!sendMission(nowhere, "blue", "blue:plane", "bomb", { x: 5, y: 5 }).error) {
    fail("a cell with no enemy site accepted a bombing run");
  }

  // --- a capital is refused (frodo m7) -------------------------------------------------------
  // The refusal is the site-kind arm below the owner checks: BOMB_SITE_KINDS is city/base/facility
  // while AIRSTRIP_KINDS adds "capital" (a plane may be based at a capital, p.22), so the two sets
  // are one word apart and this assertion is the only thing pinning the difference. The mutant that
  // must red this is "capital" added to BOMB_SITE_KINDS at web/server/air.mjs.
  const cap = board();
  const onCapital = sendMission(cap, "blue", "blue:plane", "bomb", { x: 150, y: 22 });
  if (!onCapital.error) fail("a capital accepted a bombing run");
  eq("the capital refusal is the site-kind message", onCapital.error,
    "A bombing run hits a city, a base or an oil field, not a capital.");
  eq("a refused capital leaves the owner's cash alone", cap.sides.red.cash, 50000);
  eq("a refused capital leaves the aircraft ready", cap.pieces[0].inactiveUntil, 0);
  eq("a refused capital is not left unready", cap.sites.find((s) => s.id === 63).readyRound ?? null, null);

  // --- an oil field queues 1000, and T-033's NEXT settle consumes it -----------------
  const field = board();
  const raided = sendMission(field, "blue", "blue:plane", "bomb", { x: 200, y: 60 });
  if (raided.error) fail("an empty enemy oil field refused a bombing run: " + raided.error);
  eq("the oil field took no cash", field.sides.red.cash, 50000);
  const meter = meterOf(field, "red", "fuel");
  eq("1000 raw oil is queued against the owner", meter.bombed, 1000);
  eq("the event reports the oil loss", raided.events.find((e) => e.type === "bomb_hit").oil, 1000);

  // A twin with no bombing run: the only difference between the two settlements is the 1000.
  const twin = board();
  twin.pieces[0].inactiveUntil = 18;
  upkeepResources(field);
  upkeepResources(twin);
  const bombedHeld = Number(meterOf(field, "red", "fuel").held);
  const cleanHeld = Number(meterOf(twin, "red", "fuel").held);
  eq("the next settlement consumed the queued 1000", cleanHeld - bombedHeld, 1000);
  eq("the queue is one-shot", Number(meterOf(field, "red", "fuel").bombed) || 0, 0);

  // --- the two client doors arm the same three aims (PB-157a) --------------------------------
  // The browser leg (tests/e2e/pb157a-air-bomb.mjs) clicks the real buttons; this is the half that
  // runs in the node suite, so reverting either arm is red here on a host with no browser. The
  // defect was exactly one door: the Air dialog listed strike and transfer, so its Bomb button sent
  // the mission at the plane's own cell and the server refused it every time.
  const APP = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  const guards = APP.split("\n").filter((line) =>
    /mission\.mode === "strike"/.test(line) && /mission\.mode === "transfer"/.test(line));
  eq("both mission doors have an aim-arming guard", guards.length, 2);
  for (const guard of guards) {
    if (!/mission\.mode === "bomb"/.test(guard)) {
      fail("a mission door arms strike and transfer but not bomb, so that panel fires at the plane's own cell: " + guard.trim());
    }
  }
  eq("both doors hand the player the map", (APP.match(/pendingMission = mission\.mode;/g) || []).length, 2);
}
