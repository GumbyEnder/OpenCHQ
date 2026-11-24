// PB-228 — foreign aid is a staged loyalty campaign per NATION, not a one-shot city flip.
//
// Manual L382 + p.30: aid makes "hostile ones become neutral, or neutral ones become allied"; the
// unit is the nation, and a nation with more cities takes more gifts. The archive printed no gift
// count, so the multiplier is config (`loyalty.giftsPerCity`) and every sentence that quotes the
// arithmetic calls it a stand-in (Open RE Q52).
//
// What fails if this node is removed:
//   - one gift flips a hostile city straight to the payer        -> the "first gift" arm;
//   - the number of gifts ignores how many cities the nation has  -> the three-city arm, and the
//     config arm that doubles the multiplier;
//   - one city moves and its nation stays put                     -> the whole-nation arm;
//   - a gift aimed at nation A advances nation B                  -> the isolation arm;
//   - a refused pick banks progress (a paid refusal by proxy)     -> the refusal arm;
//   - the toast does not name the city, the nation or the step    -> the sentence arms;
//   - the other side's gift does not cancel a banked gift          -> the counter-aid arm (p.30,
//     "Your opponent can give foreign aid to the same targets you do, thus negating your efforts").
//
// The nation NAMES come from the archive's own countries[] list (country_id is its index), never
// from where the cities happen to sit: web/data/countries.json, baked by tools/bake_countries.mjs.
//
// Every arm reads the event the server returns, the owners on the match, and the purse.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openMatch } from "../../server/match.mjs";
import { resolveDataRoot } from "../../server/board.mjs";
import { configPath, priceOf, resetRules } from "../../server/rules.mjs";
import { useTool, kitBriefing, giftsPerCity, giftsNeeded, nationOf, counterAid, homeSetComplete, AID_HOME_UNKNOWN } from "../../server/late.mjs";

export const name = "pb228_nation_loyalty";

// Three hostile nations with different city counts, one neutral nation with two cities, and the
// seat's own capital. Red's capital sits in a nation of its own (country 40), so the big hostile
// nation (country 7) is NOT the opponent's home country and stays reachable under PB-227.
function fresh() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.sides.blue.cash = 500000;
  match.sides.red.cash = 500000;
  match.pieces = [];
  const city = (id, name2, x, y, owner, country) => ({
    id, name: name2, x, y, kind: "city", owner, country_id: country,
  });
  match.sites = [
    city(10, "Washington", 80, 40, "blue", 0), // the seat's own capital
    city(12, "Kiev", 180, 22, "red", 1), // nation A (USSR), three cities
    city(14, "Minsk", 190, 30, "red", 1),
    city(16, "Kharkov", 186, 36, "red", 1),
    city(20, "Havana", 60, 80, "red", 31), // nation B (Cuba), one city
    city(30, "Beijing", 220, 50, null, 12), // nation C (China), two neutral cities
    city(32, "Shanghai", 224, 58, null, 12),
    city(90, "Moscow", 183, 25, "red", 37), // the opponent's capital, its own nation (Iraq)
    { id: 95, name: "Open Sea", x: 40, y: 100, kind: "water", owner: null },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 183, y: 25 } };
  match.capitalSet = {
    era: "1986",
    source: "file",
    list: [
      { siteId: 10, name: "Washington", x: 80, y: 40, owner: "blue" },
      { siteId: 90, name: "Moscow", x: 183, y: 25, owner: "red" },
    ],
    missing: [],
  };
  match.round = 4;
  return match;
}

const ownerOf = (match, id) => (match.sites.find((site) => site.id === id) || {}).owner;
const aidOf = (answer) => (answer.events || []).find((row) => row.type === "aid") || null;
const owners = (match, ids) => ids.map((id) => id + ":" + String(ownerOf(match, id))).join(",");

export async function run(ctx) {
  const { fail } = ctx;
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  };
  const price = priceOf("foreignAid");
  if (!Number.isFinite(price)) fail("the config has no foreignAid price");

  // ---- the nation is the unit, and its count sets the price in gifts ---------------------
  const match = fresh();
  const nationA = nationOf(match, match.sites.find((site) => site.id === 14));
  eq(nationA.cities.length, 3, "nation A's city count");
  eq(giftsPerCity(), 1, "the shipped gifts-per-city multiplier");
  eq(giftsNeeded(nationA), 3, "gifts needed for a three-city nation at 1 per city");

  const cash0 = match.sides.blue.cash;
  const first = aidOf(useTool(match, "blue", "aid", { x: 190, y: 30 }));
  if (!first) fail("the first gift produced no aid event");
  eq(first.site, 14, "the first gift's event.site (the pick)");
  eq(first.stance, "hostile", "the pocket's standing before the first gift");
  eq(first.turned, null, "the first gift's step");
  eq(first.gifts, 1, "the first gift's banked count");
  eq(first.needed, 3, "the first gift's threshold");
  // The defect this ticket names: after one gift the city is NOT the payer's, and its neighbours
  // are not either - the first step of a hostile nation is neutral.
  eq(owners(match, [12, 14, 16]), "12:red,14:red,16:red", "owners after the first gift");
  if (!/1 of 3 gifts/.test(String(first.note))) {
    fail("the first gift's sentence does not report the banked progress: " + first.note);
  }

  const second = aidOf(useTool(match, "blue", "aid", { x: 180, y: 22 }));
  if (!second) fail("the second gift produced no aid event");
  eq(second.gifts, 2, "the second gift's banked count");
  eq(owners(match, [12, 14, 16]), "12:red,14:red,16:red", "owners after the second gift");

  const third = aidOf(useTool(match, "blue", "aid", { x: 186, y: 36 }));
  if (!third) fail("the third gift produced no aid event");
  eq(third.turned, "neutral", "the third gift's step");
  eq(third.cities, 3, "the number of cities the step moved");
  eq(owners(match, [12, 14, 16]), "12:null,14:null,16:null", "owners after the third gift");
  if (!/has gone neutral/.test(String(third.note))) {
    fail("the third gift's sentence does not name the neutral step: " + third.note);
  }
  eq(match.sides.blue.cash, cash0 - 3 * price, "three gifts charged");

  // ---- a partial capital set FAILS CLOSED (PM 8872 §2b, frodo 8871 §7b) ---------------------
  // homeCountries() never reads capitalSet.missing, so a set that did not fully resolve used to
  // shrink "home" and let aid into a country the match could not identify. Now nothing is offered
  // and nothing is charged.
  const partial = fresh();
  eq(homeSetComplete(partial), true, "a fully resolved capital set is usable");
  partial.capitalSet.missing = [{ era: "1986", side: "red", name: "Moscow" }];
  eq(homeSetComplete(partial), false, "the incomplete capital set is detected");
  const blockedCash = partial.sides.blue.cash;
  const blocked = useTool(partial, "blue", "aid", { x: 190, y: 30 });
  eq(blocked.error, AID_HOME_UNKNOWN, "aid on a partial capital set is refused with the set's sentence");
  eq(partial.sides.blue.cash, blockedCash, "a refused aid on a partial set charged the payer");
  eq(partial.aid, undefined, "a refused aid on a partial set banked progress: " + JSON.stringify(partial.aid));
  eq(owners(partial, [12, 14, 16]), "12:red,14:red,16:red", "a refused aid on a partial set moved a city");
  const partialBrief = kitBriefing(partial, "blue").find((entry) => entry.name === "aid");
  if (!partialBrief || partialBrief.allowed) {
    fail("the kit offers aid on a partial capital set: " + JSON.stringify(partialBrief));
  }
  eq(partialBrief.reason, AID_HOME_UNKNOWN, "the kit row's reason on a partial capital set");
  // The control: the same pick on a complete set is accepted, so the refusal is the set and not the pick.
  const complete = fresh();
  eq(homeSetComplete(complete), true, "the control set is complete");
  const accepted = aidOf(useTool(complete, "blue", "aid", { x: 190, y: 30 }));
  eq(Boolean(accepted), true, "the same pick is accepted when the capital set is complete");

  // ---- the sentence names the city, the nation and the step (PM 8866 §2a) -------------------
  eq(String(first.note), "Foreign aid to Minsk: USSR is 1 of 3 gifts from turning; this gift is banked.",
    "the banked gift's sentence (city, nation, step)");
  eq(String(third.note), "Foreign aid to Kharkov: USSR has gone neutral.", "the neutral step's sentence");

  // ---- the second threshold brings the WHOLE nation over --------------------------------
  for (let gift = 0; gift < 2; gift += 1) {
    const banked = aidOf(useTool(match, "blue", "aid", { x: 190, y: 30 }));
    if (!banked || banked.turned !== null) fail("a neutral nation turned before its threshold: " + JSON.stringify(banked));
    eq(owners(match, [12, 14, 16]), "12:null,14:null,16:null", "owners before the allied threshold");
  }
  const allied = aidOf(useTool(match, "blue", "aid", { x: 190, y: 30 }));
  if (!allied) fail("the allied threshold produced no aid event");
  eq(allied.turned, "allied", "the allied step");
  eq(owners(match, [12, 14, 16]), "12:blue,14:blue,16:blue", "owners after the allied threshold");
  if (!/come over to your side/.test(String(allied.note))) {
    fail("the allied sentence does not name the step: " + allied.note);
  }
  eq(String(allied.note), "Foreign aid to Minsk: USSR has come over to your side.", "the allied step's sentence");
  // Nothing left to give: the city is the seat's own now, and that refusal costs nothing.
  const spare = useTool(match, "blue", "aid", { x: 190, y: 30 });
  if (!spare.error) fail("an aid aimed at a city the seat owns was accepted");

  // ---- one-city nations need one gift per step, not three --------------------------------
  const solo = fresh();
  const soloFirst = aidOf(useTool(solo, "blue", "aid", { x: 60, y: 80 }));
  eq(soloFirst.needed, 1, "a one-city nation's threshold");
  eq(soloFirst.turned, "neutral", "a one-city nation's first step");
  eq(ownerOf(solo, 20), null, "Havana after one gift");
  const soloSecond = aidOf(useTool(solo, "blue", "aid", { x: 60, y: 80 }));
  eq(soloSecond.turned, "allied", "a one-city nation's second step");
  eq(ownerOf(solo, 20), "blue", "Havana after two gifts");
  // Nation A and nation C were untouched by the Havana campaign.
  eq(owners(solo, [12, 14, 16]), "12:red,14:red,16:red", "nation A after gifts to nation B");
  eq(owners(solo, [30, 32]), "30:null,32:null", "nation C after gifts to nation B");

  // ---- a neutral nation of two cities allies both at once ---------------------------------
  const neutral = fresh();
  const nFirst = aidOf(useTool(neutral, "blue", "aid", { x: 220, y: 50 }));
  eq(nFirst.stance, "neutral", "the neutral nation's standing");
  eq(nFirst.needed, 2, "a two-city neutral nation's threshold");
  eq(nFirst.turned, null, "the neutral nation after one gift");
  eq(owners(neutral, [30, 32]), "30:null,32:null", "the neutral nation after one gift");
  const nSecond = aidOf(useTool(neutral, "blue", "aid", { x: 224, y: 58 }));
  eq(nSecond.turned, "allied", "the neutral nation's allied step");
  eq(owners(neutral, [30, 32]), "30:blue,32:blue", "the neutral nation after its threshold");

  // ---- a gift from the other side cancels one of the payer's banked gifts (PM 8866 §3) ------
  // Manual p.30: "Your opponent can give foreign aid to the same targets you do, thus negating
  // your efforts." HOW it negates was never recovered, so one-for-one is the labelled stand-in.
  const counter = fresh();
  const redFirst = aidOf(useTool(counter, "red", "aid", { x: 220, y: 50 }));
  if (!redFirst) fail("red's first gift produced no aid event");
  eq(redFirst.turned, null, "red's first gift in a two-city neutral nation is banked");
  eq(redFirst.cancelled, 0, "the first gift in the match cancels nothing");
  eq(counter.aid.red["12"], 1, "red's bank in China after one gift");
  const blueReply = aidOf(useTool(counter, "blue", "aid", { x: 224, y: 58 }));
  if (!blueReply) fail("blue's counter gift produced no aid event");
  eq(blueReply.cancelled, 1, "blue's gift cancels one of red's banked gifts");
  eq(blueReply.cancelledSide, "red", "which side's gift was cancelled");
  eq(blueReply.rivalBanked, 1, "what the other side had banked");
  eq(counter.aid.red["12"], 0, "red's bank after the cancel");
  eq(blueReply.gifts, 1, "blue's own bank after the cancel");
  eq(owners(counter, [30, 32]), "30:null,32:null", "a cancelled gift moves no city");
  if (!/cancels one the other side had banked/.test(String(blueReply.note))) {
    fail("the cancel is not in the sentence: " + blueReply.note);
  }
  // Red answers: blue's one is cancelled in turn, and red's own gift is the one that banks.
  const redAgain = aidOf(useTool(counter, "red", "aid", { x: 220, y: 50 }));
  eq(redAgain.cancelled, 1, "red's answer cancels blue's banked gift");
  eq(redAgain.cancelledSide, "blue", "the side red's gift cancelled");
  eq(counter.aid.blue["12"], 0, "blue's bank after red's answer");
  eq(counter.aid.red["12"], 1, "red's bank after its own gift");
  // Nothing banked against it, nothing cancelled.
  const quiet = fresh();
  const quietFirst = aidOf(useTool(quiet, "blue", "aid", { x: 220, y: 50 }));
  eq(quietFirst.cancelled, 0, "a gift with nothing banked against it cancels nothing");
  eq(quietFirst.cancelledSide, null, "no cancelled side when nothing was banked");

  // ---- a refused pick banks nothing and costs nothing --------------------------------------
  const refusedMatch = fresh();
  const before = refusedMatch.sides.blue.cash;
  const refusal = useTool(refusedMatch, "blue", "aid", { x: 80, y: 40 });
  if (!refusal.error) fail("an aid aimed at the seat's own city was accepted");
  eq(refusedMatch.sides.blue.cash, before, "a refused pick charged");
  eq(refusedMatch.aid, undefined, "a refused pick banked progress: " + JSON.stringify(refusedMatch.aid));
  const afterRefusal = aidOf(useTool(refusedMatch, "blue", "aid", { x: 190, y: 30 }));
  eq(afterRefusal.gifts, 1, "the first real gift after a refusal must be the first");

  // ---- the multiplier is config, not a constant -------------------------------------------
  const shipped = JSON.parse(readFileSync(configPath(), "utf8"));
  const custom = JSON.parse(JSON.stringify(shipped));
  if (!custom.loyalty || typeof custom.loyalty !== "object") fail("config has no loyalty block");
  custom.loyalty.giftsPerCity = 2;
  const dir = ctx.dataDir || mkdtempSync(path.join(tmpdir(), "openchq-pb228-"));
  const customPath = path.join(dir, "game-loyalty2.json");
  writeFileSync(customPath, JSON.stringify(custom, null, 2));
  const previous = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = customPath;
  resetRules();
  try {
    eq(giftsPerCity(), 2, "the configured multiplier");
    const doubled = fresh();
    const oneCity = nationOf(doubled, doubled.sites.find((site) => site.id === 20));
    eq(giftsNeeded(oneCity), 2, "a one-city nation at 2 gifts per city");
    const g1 = aidOf(useTool(doubled, "blue", "aid", { x: 60, y: 80 }));
    eq(g1.turned, null, "the first gift at the doubled multiplier");
    eq(ownerOf(doubled, 20), "red", "Havana at 1 of 2 gifts");
    const g2 = aidOf(useTool(doubled, "blue", "aid", { x: 60, y: 80 }));
    eq(g2.turned, "neutral", "the second gift at the doubled multiplier");
  } finally {
    if (previous === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = previous;
    resetRules();
  }

  // ---- the cancel is config too: off is the arms-race reading -------------------------------
  const noCounter = JSON.parse(JSON.stringify(shipped));
  noCounter.loyalty.counterAid = false;
  const offPath = path.join(dir, "game-loyalty-nocounter.json");
  writeFileSync(offPath, JSON.stringify(noCounter, null, 2));
  const prevOff = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = offPath;
  resetRules();
  try {
    eq(counterAid(), false, "the configured counter-aid switch");
    const armsRace = fresh();
    aidOf(useTool(armsRace, "red", "aid", { x: 220, y: 50 }));
    const keep = aidOf(useTool(armsRace, "blue", "aid", { x: 224, y: 58 }));
    eq(keep.cancelled, 0, "with counter-aid off the other side's gift is left alone");
    eq(armsRace.aid.red["12"], 1, "red's bank survives with counter-aid off");
    eq(armsRace.aid.blue["12"], 1, "blue banks its own gift");
  } finally {
    if (prevOff === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = prevOff;
    resetRules();
  }

  // ---- the kit row tells the player what one gift buys -------------------------------------
  const brief = kitBriefing(fresh(), "blue").find((entry) => entry.name === "aid");
  if (!brief) fail("the kit briefing lost its aid row");
  if (!/you pick/i.test(brief.text)) fail("the aid briefing does not say the player picks the city: " + brief.text);
  if (!/one step at a time/i.test(brief.text)) fail("the aid briefing does not describe the staged nation: " + brief.text);
  if (!brief.text.includes("STAND-IN")) fail("the aid briefing does not label the gift arithmetic a stand-in: " + brief.text);
  // PB-227: when every city left to sway sits in the opponent's home country, the row must say so
  // rather than offer a button whose every click is refused.
  const homeOnly = fresh();
  homeOnly.sites = homeOnly.sites.filter((site) => site.kind !== "city" || Number(site.country_id) === 37 || site.owner === "blue");
  const homeBrief = kitBriefing(homeOnly, "blue").find((entry) => entry.name === "aid");
  if (!homeBrief || homeBrief.allowed) {
    fail("the kit offers aid when every remaining target is in the opponent's home country: " + JSON.stringify(homeBrief));
  }
  // PM 8866 §2b: the Foreign Aid rules are on p.30 (tutorial p.14), not p.31.
  if (/p\.31/.test(brief.text)) fail("the aid briefing still cites p.31: " + brief.text);
  if (!/p\.30/.test(brief.text)) fail("the aid briefing does not cite p.30: " + brief.text);
  if (!/cancels one gift you had banked/i.test(brief.text)) {
    fail("the aid briefing does not describe the counter-aid cancel: " + brief.text);
  }

  // ---- the nation name is the archive's own list, not a guess -------------------------------
  const baked = JSON.parse(readFileSync(new URL("../../data/countries.json", import.meta.url), "utf8")).countries;
  eq(baked[12], "China", "the baked country list at id 12 (Beijing's nation)");
  eq(baked[1], "USSR", "the baked country list at id 1 (Kiev's nation)");
  eq(baked[31], "Cuba", "the baked country list at id 31 (Havana's nation)");
  const extractRoot = resolveDataRoot();
  if (extractRoot) {
    const meta = JSON.parse(readFileSync(path.join(extractRoot, "data", "game_meta.json"), "utf8"));
    eq(JSON.stringify(baked), JSON.stringify(meta.countries),
      "the baked country list vs the extract's game_meta.json countries[]");
  }
}
