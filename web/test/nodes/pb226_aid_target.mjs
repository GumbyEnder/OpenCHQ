// Node test for `pb226_aid_target` — foreign aid names its city (Manual L382 + p.30).
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
  AID_HOME_COUNTRY,
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
    // Enemy cities, so "the lowest id" and "the city the player picked" are different answers.
    // PB-227: countries matter now. Red's two capitals stand in country 1 and country 8, so the home
    // countries are a SET and a hard-coded "1" is not the rule; Minsk (3) and Riyadh (2) sit outside
    // it, which is what keeps an aid target reachable.
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red", country_id: 1 },
    { id: 16, name: "Budapest", x: 185, y: 40, kind: "city", owner: "red", country_id: 8 },
    { id: 14, name: "Minsk", x: 190, y: 30, kind: "city", owner: "red", country_id: 3 },
    { id: 15, name: "Tbilisi", x: 175, y: 35, kind: "city", owner: "red", country_id: 1 },
    { id: 17, name: "Debrecen", x: 186, y: 45, kind: "city", owner: "red", country_id: 8 },
    // One of the seat's own cities, one neutral city, and a cell with no site at all.
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue", country_id: 0 },
    { id: 13, name: "Riyadh", x: 200, y: 60, kind: "city", owner: null, country_id: 2 },
    { id: 20, name: "Empty Sea", x: 60, y: 90, kind: "water", owner: null },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 180, y: 22 } };
  match.capitalSet = {
    era: "1986",
    source: "file",
    list: [
      { siteId: 10, name: "New York", x: 80, y: 40, owner: "blue" },
      { siteId: 12, name: "Kiev", x: 180, y: 22, owner: "red" },
      { siteId: 16, name: "Budapest", x: 185, y: 40, owner: "red" },
    ],
    missing: [],
  };
  match.round = 4;
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;

  // --- the pick wins: the city named is the city TURNED ---------------------------------
  // PB-228: a gift moves the picked city's NATION one step. Minsk is country 3 and the only
  // country-3 city in this fixture, so one gift takes that nation hostile -> neutral and the second
  // brings it over. The pick, the price and event.site are unchanged rules.
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
  if (event.turned !== "neutral") {
    fail("the first gift of a hostile nation landed on " + JSON.stringify(event.turned) + ", not the neutral step");
  }
  if (match.sites.find((site) => site.id === 14).owner !== null) {
    fail("the first gift did not take the picked city's nation to neutral: "
      + match.sites.find((site) => site.id === 14).owner);
  }
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
  // The second gift completes the same campaign: the nation comes over, and the city is the seat's.
  const given2 = useTool(match, "blue", "aid", { x: 190, y: 30 });
  if (given2.error) fail("the second gift at the same city was refused: " + given2.error);
  const event2 = (given2.events || []).find((row) => row.type === "aid");
  if (!event2 || event2.site !== 14) fail("the second gift did not stay on the pick: " + JSON.stringify(event2));
  if (event2.turned !== "allied") fail("the second gift landed on " + JSON.stringify(event2.turned) + ", not the allied step");
  if (match.sites.find((site) => site.id === 14).owner !== "blue") fail("the picked city did not change hands");
  if (match.sides.blue.cash !== cashBefore - 2 * price) {
    fail("two gifts charged " + (cashBefore - match.sides.blue.cash) + ", not twice the config price " + price);
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
    // PB-227: a city inside the opponent's home country is refused whatever its owner is, and the
    // two arms name different countries so a fixed "country 1" cannot pass this.
    [{ x: 175, y: 35 }, AID_HOME_COUNTRY, "an aid aimed at a red city in red's country 1"],
    [{ x: 186, y: 45 }, AID_HOME_COUNTRY, "an aid aimed at a red city in red's country 8"],
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

  // --- a NEUTRAL city is a legal target: manual L986-987 --------------------------------
  // "hostile ones to become neutral, or neutral ones to become allied". Accepting only a hostile
  // pick was the stand-in reading half the sentence; the mutant that puts the refusal back has to
  // red the first line below.
  const neutral = fresh();
  const neutralBefore = neutral.sides.blue.cash;
  const swayed = useTool(neutral, "blue", "aid", { x: 200, y: 60 });
  if (swayed.error) fail("an aid aimed at a neutral city was refused: " + swayed.error);
  const aidEvent = (swayed.events || []).find((row) => row.type === "aid");
  if (!aidEvent) fail("aid at a neutral city produced no event");
  if (aidEvent.site !== 13) {
    fail("aid did not turn the neutral city the player picked: event.site=" + aidEvent.site + " (expected 13)");
  }
  if (neutral.sites.find((site) => site.id === 13).owner !== "blue") fail("the neutral city did not become allied");
  if (neutral.sites.find((site) => site.id === 12).owner !== "red") fail("aid at a neutral city also moved a hostile city");
  if (aidEvent.from !== null) fail("the aid line did not name the neutral city as neutral: from=" + String(aidEvent.from));
  if (neutral.sides.blue.cash !== neutralBefore - price) {
    fail("aid at a neutral city charged " + (neutralBefore - neutral.sides.blue.cash) + ", not the config price " + price);
  }

  // --- the briefing tells the player they pick, and offers the row when only neutrals are left --
  const brief = kitBriefing(fresh(), "blue").find((entry) => entry.name === "aid");
  if (!brief) fail("the kit briefing lost its aid row");
  if (!/you pick/i.test(brief.text)) fail("the aid briefing does not say the player picks the city: " + brief.text);
  const neutralOnly = fresh();
  neutralOnly.sites = neutralOnly.sites.filter((site) => site.owner === null);
  const neutralBrief = kitBriefing(neutralOnly, "blue").find((entry) => entry.name === "aid");
  if (!neutralBrief || !neutralBrief.allowed) {
    fail("the kit refuses aid when the only cities left to sway are neutral: " + JSON.stringify(neutralBrief && neutralBrief.reason));
  }
}
