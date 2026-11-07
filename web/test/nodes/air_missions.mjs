// Node air_missions: a mission is a choice with a price, not a sentence.
//
// The seat used to be told an aircraft was "ready" and nothing else: the two missions existed in
// air.mjs, their costs lived in a second hard-coded copy (8 and 4) that could drift from
// config/game.json, and a scramble never reached the round log. This node makes the choices visible
// and takes the price from the config file.
import { airBriefing, inactiveRounds, sendMission } from "../../server/air.mjs";
import { logLines } from "../../server/log.mjs";
import { rules } from "../../server/rules.mjs";
import { forSeat } from "../../server/view.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function plane(id, side, x, y, extra = {}) {
  return { id, side, domain: "air", kind: "aircraft", x, y, path: [], pace: 1, ...extra };
}

const SITE = { id: "home", name: "Home", kind: "city", owner: "blue", x: 80, y: 44 };

function match(pieces, extra = {}) {
  return { round: 1, pieces, sites: [SITE], capitals: {}, sides: {}, ...extra };
}

export const name = "air_missions";

export async function run() {
  const air = rules().air || {};
  const strikeRounds = Number(air.strikeRounds);
  const patrolRounds = Number(air.patrolRounds);
  if (!(strikeRounds > 0) || !(patrolRounds > 0)) fail("config has no mission costs");

  // --- the costs are the config's, not a copy in the module ---------------------------------
  {
    const m = match([plane("p1", "blue", 80, 44)]);
    const [briefing] = airBriefing(m, "blue");
    eq("the briefing is one entry per own aircraft", airBriefing(m, "blue").length, 1);
    const byMode = Object.fromEntries(briefing.missions.map((mission) => [mission.mode, mission.rounds]));
    eq("a strike costs the config's strike rounds", byMode.strike, strikeRounds);
    eq("a scramble costs the config's patrol rounds", byMode.patrol, patrolRounds);
    eq("the modes are the two the server accepts", briefing.missions.map((miss) => miss.mode), ["patrol", "strike"]);

    // What the server charges matches what the briefing promised.
    const result = sendMission(m, "blue", "p1", "patrol", { x: 90, y: 44 });
    if (result.error) fail("the scramble was refused: " + result.error);
    eq("the aircraft is away for the promised rounds", m.pieces[0].inactiveUntil, 1 + patrolRounds);
    eq("the event carries the same count", result.events[0].rounds, patrolRounds);
  }

  // --- a plane that is away cannot fly, and says how long ------------------------------------
  {
    const m = match([plane("p1", "blue", 80, 44, { inactiveUntil: 6 })]);
    const [briefing] = airBriefing(m, "blue");
    eq("rounds left is what the round says", briefing.roundsLeft, 5);
    eq("it is not ready", briefing.ready, false);
    const refused = sendMission(m, "blue", "p1", "strike", { x: 90, y: 44 });
    if (!refused.error) fail("an aircraft away on a mission was allowed to fly again");
    if (!/5 more rounds/.test(refused.error)) fail("the refusal does not say how long: " + refused.error);
    // The view badge uses the same count, so the page and the refusal agree.
    eq("the view badge agrees", inactiveRounds({ inactiveUntil: 6 }, 1), 5);
  }

  // --- reach: a mission needs somewhere to fly from -----------------------------------------
  {
    // Far from any friendly city or ship: the briefing says so, and the order is refused.
    const far = match([plane("p1", "blue", 300, 120)]);
    const [briefing] = airBriefing(far, "blue");
    eq("a plane out of reach has no base", briefing.canFly, false);
    eq("the briefing prints no invented base", briefing.base, null);
    const refused = sendMission(far, "blue", "p1", "strike", { x: 300, y: 120 });
    if (!refused.error) fail("a mission was flown with no base in reach");

    // The same plane beside its own city can fly.
    const near = match([plane("p1", "blue", 80, 44)]);
    eq("a plane at its city can fly", airBriefing(near, "blue")[0].canFly, true);
    eq("the briefing names the base", airBriefing(near, "blue")[0].base, "Home");
  }

  // --- the briefing is the seat's own --------------------------------------------------------
  {
    const m = match([plane("mine", "blue", 80, 44), plane("his", "red", 183, 25)]);
    eq("only your aircraft are briefed", airBriefing(m, "blue").map((p) => p.id), ["mine"]);
    eq("the enemy is briefed his own", airBriefing(m, "red").map((p) => p.id), ["his"]);
    eq("the seat view carries the briefing", forSeat(m, "blue").seat.air.map((p) => p.id), ["mine"]);
  }

  // --- the round log names the mission -------------------------------------------------------
  {
    const m = match([plane("p1", "blue", 80, 44)]);
    const result = sendMission(m, "blue", "p1", "patrol", { x: 90, y: 44 });
    const event = result.events[0];
    eq("a scramble is the event type", event.type, "scramble");
    const mine = logLines(m, "blue", [event], 1);
    if (!mine.length) fail("a scramble produced no log line");
    if (!/scrambl/i.test(mine[0].text)) fail("the log does not name the scramble: " + mine[0].text);
    eq("the line carries the round", mine[0].round, 1);

    // The enemy only hears a scramble he can see: put a red piece next to the flight.
    const blind = logLines(m, "red", [event], 1);
    eq("an unseen scramble is not the enemy's news", blind.length, 0);
    m.pieces.push({ id: "watcher", side: "red", domain: "land", kind: "infantry", x: 92, y: 44, path: [], pace: 1 });
    const seen = logLines(m, "red", [event], 1);
    if (!seen.length) fail("a scramble beside an enemy piece was not reported");
    if (!/enemy aircraft/i.test(seen[0].text)) fail("the enemy line does not say whose: " + seen[0].text);
  }

  // --- a strike is logged too -----------------------------------------------------------------
  {
    const m = match([plane("p1", "blue", 80, 44)]);
    const result = sendMission(m, "blue", "p1", "strike", { x: 90, y: 44 });
    const lines = logLines(m, "blue", [result.events[0]], 1);
    if (!lines.length) fail("a strike produced no log line");
    if (!/strike/i.test(lines[0].text)) fail("the log does not name the strike: " + lines[0].text);
  }

  // --- unknown modes are still refused --------------------------------------------------------
  {
    const m = match([plane("p1", "blue", 80, 44)]);
    const refused = sendMission(m, "blue", "p1", "bombardment", { x: 90, y: 44 });
    if (!refused.error) fail("an unknown mission was accepted");
  }
}
