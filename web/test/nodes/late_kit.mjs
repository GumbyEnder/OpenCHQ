// Node test for `late_kit` (order 280).
//
// What breaks if this node is removed: 1918 would offer a nuke, intel would not reveal a
// submarine, the satellite pass would announce itself to the enemy, foreign aid would not
// flip a city, and a launch would not stop after three. Nothing here invents a radius, a cost
// or a damage number - a nuke is refused by default, and the blast it deals is PB-230's arm.

import { openMatch } from "../../server/match.mjs";
import { forSeat, resultOf } from "../../server/view.mjs";
import { rules } from "../../server/rules.mjs";
import { assertShippedNukesArmed, withNukesOff } from "./_nuke_default.mjs";
import { scanSpec } from "../../public/scan.mjs";
import { nukeStatus, launchEdge, toolsForEra, useTool, intelNote, INTEL_NOTE, answerCeasefire, CEASEFIRE_NOTE, CEASEFIRE_PROPOSED_NOTE, CEASEFIRE_DECLINED_NOTE } from "../../server/late.mjs";
import { peaceOf } from "../../server/peace.mjs";
import { buySatellite, tickSatellites } from "../../server/satellite.mjs";

export const name = "late_kit";

function sub(id, side, x, y) {
  return { id, side, domain: "sea", kind: "submarine", x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 };
}

function fresh(era = "1986") {
  const match = openMatch(era, []);
  match.clock = "running";
  // Fund both seats: the recovered tools cost 10 billion each and the early start pool is a
  // 9-billion stand-in (T-001 leaves startPool alone).
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red" },
    { id: 13, name: "Riyadh", x: 200, y: 60, kind: "city", owner: null },
  ];
  // PB-228 (PM 8872 §2b): aid fails closed on a capital set that did not fully resolve, and the
  // set openMatch() computed belongs to the opening board this fixture replaces. These three sites
  // carry no capitals, so the fixture says so instead of inheriting the opening board's misses.
  match.capitalSet = { era, source: "fixture", list: [], missing: [] };
  match.round = 4;
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;

  // --- era gating ---------------------------------------------------------------------
  const early = toolsForEra("1918");
  for (const tool of ["intel", "aid", "ceasefire", "nuke", "oil"]) {
    if (early.includes(tool)) fail("1918 offered the 1986 tool " + tool);
  }
  const late = toolsForEra("1986");
  for (const tool of ["intel", "aid", "ceasefire", "nuke"]) {
    if (!late.includes(tool)) fail("1986 does not offer " + tool);
  }
  // PB-224 (PM 8905 §2): the satellite is a UNIT, not a tool. The old worldwide pass is gone, and
  // with it the tool door; the reveal is the piece's own round.
  if (late.includes("satellite")) fail("1986 still offers the retired satellite tool");
  if (!useTool(fresh(), "blue", "satellite").error) fail("the retired satellite tool still runs");
  const concealed = toolsForEra("9999");
  if (!concealed.includes("oil")) fail("the concealed start lost oil");
  if (!concealed.includes("nuke")) fail("the ???? era did not use the 1986 set");
  const wrongEra = useTool(fresh("1942"), "blue", "intel");
  if (!wrongEra.error) fail("1942 ran an intel scan");

  // --- intel reveals everything and tells the opponent --------------------------------
  const match = fresh();
  const hidden = sub("red:sub", "red", 200, 100);
  match.pieces = [sub("blue:sub", "blue", 0, 15), hidden];
  if (forSeat(match, "blue").pieces.some((piece) => piece.id === "red:sub")) {
    fail("a still submarine was visible before intel");
  }
  const intel = useTool(match, "blue", "intel");
  if (intel.error) fail("intel was refused in 1986: " + intel.error);
  if (!intel.events.some((event) => event.type === "intel" && event.note === intelNote(event.cost))) {
    fail("intel did not report itself: " + JSON.stringify(intel.events));
  }
  // PB-160: the banner says what the bar does and shows the price the event charged.
  const intelEvent = intel.events.find((event) => event.type === "intel");
  if (!intelEvent || !intelEvent.note.startsWith(INTEL_NOTE)) {
    fail("the intel banner lost its copy: " + JSON.stringify(intelEvent && intelEvent.note));
  }
  if (!/\b10b$/.test(intelEvent.note)) fail("the intel banner does not show the config price: " + intelEvent.note);
  if (/Every unit is revealed/i.test(intelEvent.note)) fail("the intel banner still overstates the reveal");
  if (!intel.events.some((event) => event.type === "intel_seen" && event.side === "red")) {
    fail("intel did not tell the opponent");
  }
  // PB-158: the reveal is the bar's, on the server. The submarine sits at column 200; at t=0 the
  // bar is fully off the left, so the payload must not carry it, and it appears only when the
  // bar's span reaches its column.
  if (forSeat(match, "blue", match.scan.startedAt).pieces.some((piece) => piece.id === "red:sub")) {
    fail("intel revealed a unit before the bar reached it");
  }
  const reach200 = Number(match.scan.startedAt) +
    Math.round((200 / scanSpec(320).cellsPerSecond) * 1000) + 500;
  if (!forSeat(match, "blue", reach200).pieces.some((piece) => piece.id === "red:sub")) {
    fail("intel did not reveal the submarine once the bar covered its column");
  }
  if (/radius/i.test(INTEL_NOTE)) fail("the intel note contains the banned word radius: " + INTEL_NOTE);

  // --- the satellite is a piece, it is quiet, and a submarine is never part of it (PB-222/PB-224) --
  // The manual: L326 "except submarines, which remain hidden"; L329 "Submarines are always hidden
  // from air and satellite scanning"; L936 "all enemy units are exposed except submarines". PB-224
  // moved that rule from the retired worldwide tool onto the planned piece: the hull and the sub sit
  // inside the same radius, and only the hull is revealed.
  const quiet = fresh();
  const quietSub = sub("red:sub", "red", 242, 22);
  const quietHull = {
    id: "red:cruiser", side: "red", domain: "sea", kind: "cruiser", x: 240, y: 20,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1,
  };
  quiet.pieces = [sub("blue:sub", "blue", 0, 15), quietHull, quietSub];
  const bought = buySatellite(quiet, "blue", 240, 20);
  if (bought.error) fail("a recon satellite was refused: " + bought.error);
  const satEvents = tickSatellites(quiet);
  if (satEvents.some((event) => event.type === "intel_seen")) fail("the satellite pass told the opponent");
  const satEvent = satEvents.find((event) => event.type === "satellite");
  if (!satEvent) fail("the satellite pass produced no event: " + JSON.stringify(satEvents));
  if (satEvent.reveals !== 1) fail("the satellite count includes the submarine: " + satEvent.reveals);
  const quietSeen = forSeat(quiet, "blue").pieces.map((piece) => piece.id);
  if (!quietSeen.includes("red:cruiser")) {
    fail("the satellite pass did not reveal a surface enemy: " + quietSeen.join(","));
  }
  if (quietSeen.includes("red:sub")) {
    fail("the satellite pass revealed a submarine: " + quietSeen.join(","));
  }
  if (quietSub.revealedRound !== undefined) {
    fail("the satellite pass stamped a submarine: " + String(quietSub.revealedRound));
  }

  // --- foreign aid moves the nation of the city it is aimed at ---------------------------
  const aid = fresh();
  aid.pieces = [];
  // PB-226: aid names its city. The target is Kiev's cell, not a hidden lowest-id pick.
  // PB-228: a gift moves the picked city's NATION one step. These three sites carry no
  // country_id, so each is its own one-city nation: one gift neutral, the second allied.
  const given = useTool(aid, "blue", "aid", { x: 180, y: 22 });
  if (given.error) fail("foreign aid was refused: " + given.error);
  const flipped = given.events.find((event) => event.type === "aid");
  if (!flipped) fail("aid produced no event");
  if (aid.sites.find((site) => site.id === flipped.site).owner !== null) {
    fail("aid did not move the nation of the city it named: "
      + aid.sites.find((site) => site.id === flipped.site).owner);
  }
  if (flipped.turned !== "neutral") fail("the first gift did not land on the neutral step: " + String(flipped.turned));
  if (flipped.from !== "red") fail("aid did not name the side that lost the city: " + flipped.from);
  const again = useTool(aid, "blue", "aid", { x: 180, y: 22 });
  if (again.error) fail("the second gift was refused: " + again.error);
  if (aid.sites.find((site) => site.id === flipped.site).owner !== "blue") {
    fail("the second gift did not bring the city over");
  }

  // --- a cease-fire is a PROPOSAL the opponent answers (PB-200, manual p.32 L1032) ---------
  // "Your opponent must agree to your proposed cease-fire, or the war continues." The old tool
  // answered itself; this block is the three facts: offered, declined, agreed.
  const truce = fresh();
  truce.pieces = [sub("blue:sub", "blue", 0, 15)];
  const before = JSON.stringify(truce.sites) + JSON.stringify(truce.pieces);
  const stop = useTool(truce, "blue", "ceasefire");
  if (stop.error) fail("a cease-fire was refused: " + stop.error);
  if (!stop.events.some((event) => event.type === "ceasefire_proposed" && event.note === CEASEFIRE_PROPOSED_NOTE)) {
    fail("the cease-fire did not say it was a proposal: " + JSON.stringify(stop.events));
  }
  if (truce.over) fail("a proposal ended the match before the opponent answered");
  if (JSON.stringify(truce.sites) + JSON.stringify(truce.pieces) !== before) {
    fail("the proposal changed the board; nothing changes until it is answered");
  }
  if (!useTool(truce, "blue", "ceasefire").error) fail("a second offer was accepted while one was pending");
  if (!answerCeasefire(truce, "blue", true).error) fail("the proposer answered its own offer");
  const refusedTruce = answerCeasefire(truce, "red", false);
  if (refusedTruce.error) fail("the decline was refused: " + refusedTruce.error);
  if (truce.over) fail("a declined cease-fire ended the match");
  if (!refusedTruce.events.some((event) => event.type === "ceasefire_declined" && event.note === CEASEFIRE_DECLINED_NOTE)) {
    fail("the decline did not say the war continues: " + JSON.stringify(refusedTruce.events));
  }
  if (JSON.stringify(truce.sites) + JSON.stringify(truce.pieces) !== before) {
    fail("a declined cease-fire changed the board");
  }
  // A declined offer is off the table, so the same or the other side may offer again.
  if (useTool(truce, "blue", "ceasefire").error) fail("a fresh offer was refused after a decline");
  if (!answerCeasefire(truce, "blue", true).error) fail("the proposer answered its own second offer");
  const agreed = answerCeasefire(truce, "red", true);
  if (agreed.error) fail("the acceptance was refused: " + agreed.error);
  if (!agreed.events.some((event) => event.type === "ceasefire_accepted" && event.note === CEASEFIRE_NOTE)) {
    fail("the acceptance did not say the war was over: " + JSON.stringify(agreed.events));
  }
  // PB-245 (manual p.31): an accepted cease fire puts the war at PEACE. The match does not end:
  // `over` and `winner` do not move, and the state carries the mandatory counter's own deadline.
  if (truce.over) fail("an accepted cease-fire ended the match; peace is a state, not an ending");
  if (truce.winner) fail("an accepted cease-fire named a winner; a truce is not a victory");
  const peace = peaceOf(truce);
  if (!peace || peace.active !== true) fail("the acceptance did not put the war at peace: " + JSON.stringify(peace));
  if (peace.since !== truce.round) fail("the peace does not start on the round it was agreed: " + JSON.stringify(peace));

  // --- the shipped default is ARMED, and a forced-off config still refuses ------------
  // PB-233 (f): the shipped file arms the block, so the status test runs on shipped rules and the
  // refusal keeps its own arm under an explicit enabled:false config.
  assertShippedNukesArmed(fresh());
  {
    const restoreOff = withNukesOff();
    try {
      const nuked = fresh();
      const refused = useTool(nuked, "blue", "nuke", { x: 100, y: 100 });
      if (!refused.error) fail("a nuke launched with the block forced off");
      if (nukeStatus(nuked, "blue").allowed) fail("nukeStatus allowed a launch with the block forced off");
    } finally {
      restoreOff();
    }
  }

  // The limit is the DIFFERENCE of the two counters (Manual p.30, PB-156), and that arithmetic is
  // readable without enabling the tool. The refusal itself needs `nukes.enabled:true`, so it is
  // proved in pb156_nuke.mjs over a config that turns the block on; asserting it here would only
  // read the disabled note and look like a rule test.
  const counted = fresh();
  counted.late = { launched: { blue: { fired: 2 }, red: { fired: 0 } } };
  if (launchEdge(counted, "blue") !== 2) fail("the launch edge is not fired(mine) - fired(theirs)");
  counted.late = { launched: { blue: { fired: 3 }, red: { fired: 1 } } };
  if (launchEdge(counted, "blue") !== 2) fail("the launch edge counted one side's absolute total");

  // --- a target near a capital is home ground ----------------------------------------
  const guarded = fresh();
  guarded.capitals = { blue: { x: 79, y: 44 }, red: { x: 183, y: 25 } };
  const near = useTool(guarded, "blue", "nuke", { x: 80, y: 44 });
  if (!near.error) fail("a nuke was allowed on home ground near a capital");
}
