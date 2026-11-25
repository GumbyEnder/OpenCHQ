// Node late_kit_visible: the kit's consequences in words, not in a comment.
//
// The tools worked and the buttons existed, but the nuke's guard radius, the launch limit and the
// fact that a launch does nothing were only readable in late.mjs. This node puts them on the page
// and in the round log, marks every unascertained number STAND-IN, and makes a refusal say why.
import { kitBriefing, nukeStatus, useTool } from "../../server/late.mjs";
import { logLines } from "../../server/log.mjs";
import { rules } from "../../server/rules.mjs";
import { forSeat } from "../../server/view.mjs";
import { buySatellite, tickSatellites } from "../../server/satellite.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function match(extra = {}) {
  return {
    era: "1986",
    round: 4,
    sides: { blue: { cash: 50000 }, red: { cash: 50000 } },
    pieces: [
      { id: "b1", side: "blue", domain: "land", kind: "infantry", x: 80, y: 44, path: [], pace: 1 },
      { id: "r1", side: "red", domain: "land", kind: "infantry", x: 183, y: 25, path: [], pace: 1 },
    ],
    sites: [
      { id: "home", name: "Home", kind: "city", owner: "blue", x: 80, y: 44 },
      { id: "theirs", name: "Theirs", kind: "city", owner: "red", x: 183, y: 25 },
    ],
    capitals: { blue: { x: 79, y: 44 }, red: { x: 183, y: 25 } },
    ...extra,
  };
}

export const name = "late_kit_visible";

export async function run() {
  const cfg = rules().nukes || {};
  const radius = Number(cfg.exclusion);

  // --- every tool has a sentence, and the nuke's numbers are the config's -------------------
  {
    const m = match();
    const kit = kitBriefing(m, "blue");
    const names = kit.map((entry) => entry.name);
    for (const tool of ["intel", "aid", "ceasefire", "nuke"]) {
      if (!names.includes(tool)) fail("the kit does not describe " + tool);
    }
    // PB-224: the satellite row is gone from the kit on purpose - a satellite is a unit, and its
    // door is the Buy row, not a tool button that spends money and reveals the world.
    if (names.includes("satellite")) fail("the kit still offers the retired satellite tool");
    for (const entry of kit) {
      if (!entry.text || entry.text.length < 20) fail(entry.name + " has no sentence to show");
      if (typeof entry.allowed !== "boolean") fail(entry.name + " does not say whether it is available");
    }

    const nuke = kit.find((entry) => entry.name === "nuke");
    // PB-244: the sentence names the rule (the manual's "within three spaces", read as a square) and
    // leaves the provenance to config; a developer tag in a briefing is a defect, not a signal.
    if (/\b(UNVERIFIED|UNMEASURED|STAND-IN)\b/.test(nuke.text)) fail("the nuke text still hands the player a developer tag");
    if (!/square/.test(nuke.text)) fail("the nuke text no longer says how the shape is read: " + nuke.text);
    if (Number.isFinite(radius) && radius >= 1) {
      if (!nuke.text.includes(String(radius))) fail("the nuke text does not print the config's radius: " + nuke.text);
    }
    if (!/3 .*fired/.test(nuke.text)) fail("the nuke text does not print the launch limit");
    // PB-230 retired the "deals no damage" stand-in: the briefing now has to describe the kill zone
    // and the wasteland it leaves, in the same sentence that names the radius a stand-in.
    if (/no damage/.test(nuke.text)) fail("the nuke text still says it deals no damage");
    if (!/wasteland/.test(nuke.text)) fail("the nuke text does not say what it leaves behind");
    if (!/home country/.test(nuke.text)) fail("the nuke text does not name the home-country refusal");

    // The refused case carries its reason rather than a bare no.
    if (cfg.enabled !== true) {
      eq("a refused nuke is unavailable", nuke.allowed, false);
      if (!nuke.reason) fail("a refused nuke has no reason");
      const refusal = useTool(m, "blue", "nuke", { x: 200, y: 100 });
      if (!refusal.error) fail("a refused nuke was launched");
      eq("the order and the briefing give the same reason", refusal.error, nuke.reason);
    }
  }

  // --- a tool that cannot do anything says so before it is pressed --------------------------
  {
    const lonely = match({ pieces: [{ id: "b1", side: "blue", domain: "land", kind: "infantry", x: 80, y: 44, path: [], pace: 1 }], sites: [] });
    const kit = kitBriefing(lonely, "blue");
    const intel = kit.find((entry) => entry.name === "intel");
    eq("intel is unavailable with nothing to reveal", intel.allowed, false);
    if (!intel.reason) fail("intel has no reason for its refusal");
    const aid = kit.find((entry) => entry.name === "aid");
    eq("aid is unavailable with no enemy city", aid.allowed, false);
    if (!aid.reason) fail("aid has no reason for its refusal");
  }

  // --- the kit is the seat's own, and it rides the view -------------------------------------
  {
    const m = match();
    eq("the seat view carries the kit", forSeat(m, "blue").seat.kit.length, kitBriefing(m, "blue").length);
    // PB-156: the limit is the DIFFERENCE of the two counters (Manual p.30), so a side two ahead
    // may fire one more - and the sentence has to say so in those terms, not as "1 of 3 left".
    const limited = match({ late: { launched: { blue: { fired: 2 }, red: { fired: 0 } } } });
    const nuke = kitBriefing(limited, "blue").find((entry) => entry.name === "nuke");
    if (!/may fire 1 more/.test(nuke.text)) fail("the briefing does not count the launches left: " + nuke.text);
    if (!/3 more fired/.test(nuke.text)) fail("the briefing does not state the difference rule: " + nuke.text);
  }

  // --- the round log records a tool use for its owner only ----------------------------------
  {
    const m = match();
    const intel = useTool(m, "blue", "intel", null);
    if (intel.error) fail("intel was refused: " + intel.error);
    const mine = logLines(m, "blue", intel.events, 4);
    if (!mine.length) fail("intel produced no log line for its owner");
    if (!/intel/i.test(mine[0].text)) fail("the log does not name intel: " + mine[0].text);
    const theirs = logLines(m, "red", intel.events, 4);
    if (!theirs.length) fail("the side that was read was not told");
    if (!/read your positions/i.test(theirs[0].text)) fail("the enemy line does not say what happened: " + theirs[0].text);

    // A satellite is quiet: the other seat is not told. PB-224: the pass is the piece's own round.
    const satBought = buySatellite(m, "blue", 183, 25);
    if (satBought.error) fail("the satellite was refused: " + satBought.error);
    const satEvents = tickSatellites(m);
    eq("a satellite tells nobody", logLines(m, "red", satEvents, 4).length, 0);
    if (!logLines(m, "blue", satEvents, 4).length) fail("a satellite produced no line for its owner");

    // Aid moves a city and says which. PB-226: the city is the one the player names.
    const aid = useTool(m, "blue", "aid", { x: 183, y: 25 });
    if (aid.error) fail("aid was refused: " + aid.error);
    const aidLine = logLines(m, "blue", aid.events, 4);
    if (!aidLine.length) fail("aid produced no log line");
    if (!/aid/i.test(aidLine[0].text)) fail("the log does not name aid: " + aidLine[0].text);
    // PB-236 moved this arm's class. The other seat's aid line is now gated by the nation's SIZE
    // (manual p.30: only large countries make it known) on top of `legible()`. This fixture's
    // city has no country byte, so `nationOf` makes it a ONE-city nation - below the cut whatever
    // the cut is - and red has a piece standing on the very cell, so fog is satisfied and the size
    // gate is the only thing left. The old assertion here was `length, 1`, which pinned the
    // un-gated announcement PB-236 removes; the positive half (a large nation, in sight) lives in
    // pb236_aid_announce arms 1 and 2.
    eq("aid into a one-city nation is not the other seat's news", logLines(m, "red", aid.events, 4).length, 0);

    // PB-200: a cease-fire is a proposal, and BOTH seats read a line for it - the offerer is told it
    // is waiting on the opponent, the opponent is told there is an offer to answer.
    const cf = useTool(m, "blue", "ceasefire", null);
    if (cf.error) fail("the cease-fire was refused: " + cf.error);
    const ownLine = logLines(m, "blue", cf.events, 4);
    const foeLine = logLines(m, "red", cf.events, 4);
    if (!ownLine.length) fail("a cease-fire produced no line for the side that offered it");
    if (!/proposed/i.test(ownLine[0].text)) fail("the offerer is not told the offer is pending: " + ownLine[0].text);
    if (!foeLine.length) fail("the opponent is not told a cease-fire was proposed");
    if (!/cease fire/i.test(foeLine[0].text)) fail("the opponent's line does not name the offer: " + foeLine[0].text);
    if (m.over) fail("a cease-fire proposal ended the match without an answer");
  }

  // --- an era without the kit offers none of it ---------------------------------------------
  {
    const early = match({ era: "1918" });
    eq("1918 has no kit to brief", kitBriefing(early, "blue").filter((entry) => entry.name === "nuke").length, 0);
    const refused = useTool(early, "blue", "nuke", { x: 200, y: 100 });
    if (!refused.error) fail("a nuke was launched in 1918");
  }

  // --- the nuke status and the briefing agree -----------------------------------------------
  {
    const m = match();
    const status = nukeStatus(m, "blue");
    const nuke = kitBriefing(m, "blue").find((entry) => entry.name === "nuke");
    eq("the briefing repeats the status", nuke.allowed, status.allowed);
    eq("the briefing repeats the reason", nuke.reason, status.reason || null);
  }
}
