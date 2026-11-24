// Node test for `pb226_aid_target` — foreign aid names its city (Manual L382 + p.31).
//
// What breaks if this node is removed: the aid button spends the seat's pool on whatever city the
// server felt like turning (the lowest id), ignores the cell the player picked, and a refused call
// can still charge. The mutant that motivates every assertion below is the old arm itself:
//
//   const city = sites.filter(enemy city).sort(by id)[0];   // no target read at all
//
// which turns id 12 while the wire named id 14 and leaves the player's own pick untouched.

import { openMatch } from "../../server/match.mjs";
import { priceOf } from "../../server/rules.mjs";
import {
  useTool,
  kitBriefing,
  AID_NEEDS_CITY,
  AID_OFF_MAP,
  AID_NO_CITY,
  AID_OWN_CITY,
  AID_NEUTRAL_CITY,
} from "../../server/late.mjs";

export const name = "pb226_aid_target";

function fresh() {
  const match = openMatch("1986", []);
  match.clock = "running";
  // The recovered tools cost 10 billion each; fund both seats so a refusal can only come from the
  // rule under test, never from the purse.
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.pieces = [];
  match.sites = [
    // Two enemy cities, so "the lowest id" and "the city the player picked" are different answers.
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red" },
    { id: 14, name: "Minsk", x: 190, y: 30, kind: "city", owner: "red" },
    // One of the seat's own cities, one neutral city, and a cell with no site at all.
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 13, name: "Riyadh", x: 200, y: 60, kind: "city", owner: null },
    { id: 20, name: "Empty Sea", x: 60, y: 90, kind: "water", owner: null },
  ];
  match.round = 4;
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;

  // --- the pick wins: the city named is the city turned ---------------------------------
  const match = fresh();
  const price = priceOf("foreignAid");
  const cashBefore = match.sides.blue.cash;
  const given = useTool(match, "blue", "aid", { x: 190, y: 30 });
  if (given.error) fail("aid at an enemy city was refused: " + given.error);
  const event = (given.events || []).find((row) => row.type === "aid");
  if (!event) fail("aid produced no event");
  if (event.site !== 14) {
    fail("aid did not turn the city the player picked: event.site=" + event.site + " (expected 14)");
  }
  if (match.sites.find((site) => site.id === 14).owner !== "blue") fail("the picked city did not change hands");
  // The lowest-id enemy city is the old hidden policy; it must be untouched.
  if (match.sites.find((site) => site.id === 12).owner !== "red") {
    fail("aid also turned the lowest-id enemy city; the pick must be the only target");
  }
  if (event.name !== "Minsk" || event.x !== 190 || event.y !== 30) {
    fail("the aid line does not name the city it turned: " + JSON.stringify(event));
  }
  if (event.from !== "red") fail("aid did not name the side that lost the city: " + event.from);
  if (!Number.isFinite(price)) fail("the config has no foreignAid price");
  if (match.sides.blue.cash !== cashBefore - price) {
    fail("aid charged " + (cashBefore - match.sides.blue.cash) + ", not the config price " + price);
  }

  // --- every refusal names its reason and costs 0 ---------------------------------------
  const refusals = [
    // no target at all: the old hidden policy. Refused, not resolved to the lowest id.
    [null, AID_NEEDS_CITY, "a target-less aid"],
    // off the map in y (the board wraps in x, so x alone is not an off-map claim).
    [{ x: 10, y: 999 }, AID_OFF_MAP, "an aid aimed off the map"],
    [{ x: -1, y: 10 }, AID_OFF_MAP, "an aid aimed at negative x"],
    [{ x: 60, y: 90 }, AID_NO_CITY, "an aid aimed at a cell with no city"],
    [{ x: 80, y: 40 }, AID_OWN_CITY, "an aid aimed at the seat's own city"],
    [{ x: 200, y: 60 }, AID_NEUTRAL_CITY, "an aid aimed at a neutral city"],
  ];
  for (const [target, expected, label] of refusals) {
    const refused = fresh();
    const before = refused.sides.blue.cash;
    const owners = refused.sites.map((site) => site.id + ":" + site.owner).join(",");
    const answer = useTool(refused, "blue", "aid", target);
    if (!answer.error) fail(label + " was accepted");
    if (answer.error !== expected) fail(label + " said " + JSON.stringify(answer.error) + ", not " + JSON.stringify(expected));
    if (refused.sides.blue.cash !== before) {
      fail(label + " charged the seat " + (before - refused.sides.blue.cash) + "; a refusal costs 0");
    }
    if (refused.sites.map((site) => site.id + ":" + site.owner).join(",") !== owners) {
      fail(label + " changed a city's owner");
    }
  }

  // --- the briefing tells the player they pick ------------------------------------------
  const brief = kitBriefing(fresh(), "blue").find((entry) => entry.name === "aid");
  if (!brief) fail("the kit briefing lost its aid row");
  if (!/you pick/i.test(brief.text)) fail("the aid briefing does not say the player picks the city: " + brief.text);
}
