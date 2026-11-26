// PB-293 pin: air inactivity, manual_pages.txt l.773-777.
//
//   (a) a mission leaves the unit inactive for its cost in rounds (air.strikeRounds, 8);
//   (b) CAP (patrol) costs air.patrolRounds (4);
//   (c) an INACTIVE unit may still fly CAP, and that CAP ADDS its cost to what the unit owes;
//   (d) an inactive unit may fly NO other mission - strike, bomb and transfer are all refused;
//   (e) the BRIEFING offers exactly what the server accepts: a ready plane lists every mission, an
//       inactive one lists CAP alone with the added rounds, and the manual's "less effective" clause
//       rides on a config lever labelled UNVERIFIED (no number invented in code).
//
// Costs are read from config, never typed here: air.strikeRounds/air.patrolRounds are the booklet's
// 8 and 4 and the file wins (air.mjs missionCosts). The pin asserts the ORDERINGS and the refusals,
// not a re-derivation of the numbers.
//
// Already pinned elsewhere, cited not duplicated: the mission ack names its order and a replay is
// answered from memory and charged once (web/test/nodes/pb172_mission_replay.mjs:118-142, which also
// reads `roundsLeft` after a mission).
//
// What each arm would read if its producer were removed (the mutant each arm needs):
//   (a) inactiveUntil not written                          -> the strike leaves the plane ready
//   (b) patrol priced as a strike                          -> CAP reads 8, not 4
//   (c) the inactive guard runs before the mode is known   -> CAP is refused (this is the deviation)
//   (d) the inactive guard dropped entirely                -> a strike flies while inactive
import { warMatch } from "../wartime.mjs";
import { matchSites } from "../../server/board.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { airBriefing, inactiveRounds, sendMission } from "../../server/air.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "pb293_air_inactivity";

const ROUND = 10;

function authoredRules() {
  // rules().air: the same object air.mjs's missionCosts() reads, not a second parse of
  // config/game.json, so the pin cannot disagree with the server about a price.
  const air = (rules() || {}).air;
  if (!air || typeof air !== "object") throw new Error("pb293: rules().air is missing");
  return air;
}

function setup(era = "1986") {
  const match = warMatch(era, matchSites(era));
  seedOwners(match);
  match.round = ROUND;
  const city = match.sites.find((site) => site.kind === "city" && site.owner === "blue");
  if (!city) throw new Error("pb293: the " + era + " board must open with a blue city to base the plane in");
  const plane = {
    id: "blue:air:293", side: "blue", domain: "air", kind: "aircraft",
    x: city.x, y: city.y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
    strength: 100, maxStrength: 100,
  };
  match.pieces = [plane];
  return { match, city, plane };
}

const fly = (match, plane, mode) => sendMission(match, "blue", plane.id, mode, { x: plane.x, y: plane.y });

export async function run(ctx) {
  const { fail } = ctx;
  const air = authoredRules();
  const strikeCost = Number(air.strikeRounds);
  const patrolCost = Number(air.patrolRounds);
  if (!(strikeCost > 0) || !(patrolCost > 0)) {
    fail("pb293: config air.strikeRounds/patrolRounds are " + air.strikeRounds + "/" + air.patrolRounds + "; the pin needs both");
  }

  // ---- (a) l.773-777: a mission leaves the unit inactive for its cost ---------------------------
  {
    const { match, plane } = setup();
    const order = fly(match, plane, "strike");
    if (order.error) fail("pb293 (a): a strike from a ready plane was refused: " + JSON.stringify(order.error));
    const until = Number(plane.inactiveUntil);
    if (!(Number(inactiveRounds(plane, match.round)) === strikeCost)) {
      fail("pb293 (a) l.773-777: after a strike the plane owes " + inactiveRounds(plane, match.round)
        + " rounds, not config's air.strikeRounds " + strikeCost + " (producer: web/server/air.mjs:369 writes inactiveUntil)");
    }
    if (!(until === ROUND + strikeCost)) {
      fail("pb293 (a) l.773-777: inactiveUntil is " + until + ", not round " + ROUND + " + " + strikeCost + " = " + (ROUND + strikeCost));
    }
    const again = fly(match, plane, "strike");
    if (!again.error) fail("pb293 (a) l.773-777: a second strike was ACCEPTED while the plane was inactive");
    match.round = until;
    if (inactiveRounds(plane, match.round) !== 0) {
      fail("pb293 (a) l.773-777: at round " + until + " the plane still owes " + inactiveRounds(plane, match.round) + " rounds");
    }
    const after = fly(match, plane, "strike");
    if (after.error) fail("pb293 (a) l.773-777: a plane whose timer expired at round " + until + " was refused: " + JSON.stringify(after.error));
    console.log("pb293 arm (a) ok at l.773-777: a strike sets " + strikeCost + " rounds (until " + until + "), refuses a second, and flies again at " + until);
  }

  // ---- (b) l.773-777: CAP costs its own, shorter price ----------------------------------------
  {
    const { match, plane } = setup();
    const order = fly(match, plane, "patrol");
    if (order.error) fail("pb293 (b): a CAP from a ready plane was refused: " + JSON.stringify(order.error));
    const owed = inactiveRounds(plane, match.round);
    if (!(owed === patrolCost)) {
      fail("pb293 (b) l.773-777: CAP left the plane owing " + owed + " rounds, not config's air.patrolRounds "
        + patrolCost + " (producer: web/server/air.mjs:42 modeFor prices patrol from config)");
    }
    if (!(patrolCost < strikeCost)) fail("pb293 (b): config has CAP (" + patrolCost + ") not shorter than a strike (" + strikeCost + ")");
    console.log("pb293 arm (b) ok at l.773-777: CAP costs " + patrolCost + " rounds against a strike's " + strikeCost);
  }

  // ---- (d) l.773-777: an inactive unit flies NO other mission ---------------------------------
  // Checked before (c) so the record carries the refusals even when (c) reds.
  {
    const { match, plane } = setup();
    fly(match, plane, "strike");
    const refused = {};
    for (const mode of ["strike", "bomb", "transfer"]) {
      const result = fly(match, plane, mode);
      refused[mode] = result.error ? "refused" : "ACCEPTED";
      if (!result.error) {
        fail("pb293 (d) l.773-777: '" + mode + "' was accepted while the plane owed "
          + inactiveRounds(plane, match.round) + " rounds - only CAP may fly (producer: web/server/air.mjs:280-281)");
      }
    }
    console.log("pb293 arm (d) ok at l.773-777: strike/bomb/transfer all refused while inactive (" + JSON.stringify(refused) + ")");
  }

  // ---- (c) l.773-777: an inactive unit MAY fly CAP, and it ADDS the CAP cost -------------------
  {
    const { match, plane } = setup();
    fly(match, plane, "strike");
    const owed = inactiveRounds(plane, match.round);
    const untilBefore = Number(plane.inactiveUntil);
    const cap = fly(match, plane, "patrol");
    if (cap.error) {
      fail("pb293 (c) l.773-777: an inactive plane was refused CAP with " + JSON.stringify(cap.error)
        + " while it owed " + owed + " rounds; the manual says an inactive unit may fly CAP (air.mjs:280-290"
        + " is the gate the fix moved).");
    }
    const after = Number(plane.inactiveUntil);
    if (!(after === untilBefore + patrolCost)) {
      fail("pb293 (c) l.773-777: CAP while inactive set until " + after + " from " + untilBefore
        + "; the manual says the CAP ADDS " + patrolCost + " rounds, so " + (untilBefore + patrolCost)
        + " was expected. Producer: web/server/air.mjs owedFrom");
    }
    if (inactiveRounds(plane, match.round) !== after - match.round) {
      fail("pb293 (c): the plane's outstanding rounds (" + inactiveRounds(plane, match.round) + ") do not match until "
        + after + " minus the round " + match.round);
    }
    // A ready plane's CAP is still round + cost, not a doubling of an old timer.
    const fresh = setup();
    fly(fresh.match, fresh.plane, "patrol");
    if (Number(fresh.plane.inactiveUntil) !== ROUND + patrolCost) {
      fail("pb293 (c): a READY plane's CAP set until " + fresh.plane.inactiveUntil + ", expected round " + ROUND
        + " + " + patrolCost);
    }
    // And the round it comes due, it flies again.
    match.round = after;
    if (inactiveRounds(plane, match.round) !== 0) fail("pb293 (c): the plane still owes rounds at " + after);
    const again = fly(match, plane, "patrol");
    if (again.error) fail("pb293 (c): at round " + after + " a CAP was refused: " + JSON.stringify(again.error));
    console.log("pb293 arm (c) ok at l.773-777: CAP while inactive added " + patrolCost + " rounds ("
      + untilBefore + " -> " + after + "), a ready CAP is round + " + patrolCost + ", and the plane flies again at " + after);
  }

  // ---- (e) l.777 the page's half: the briefing offers what the server accepts -------------------
  {
    const ready = setup();
    const readyLine = airBriefing(ready.match, "blue")[0];
    // PB-296b adds the paradrop to a ready plane's menu, so the expected list carries it; the arm
    // still says what it always said - the briefing lists every mode the server accepts.
    const allModes = (readyLine.missions || []).map((mission) => mission.mode).join(",");
    if (allModes !== "patrol,strike,bomb,drop,transfer") {
      fail("pb293 (e): a READY plane's briefing lists " + JSON.stringify(allModes)
        + ", not every mission the server accepts (producer: web/server/air.mjs airBriefing)");
    }

    const away = setup();
    fly(away.match, away.plane, "strike");
    const owed = inactiveRounds(away.plane, away.match.round);
    const line = airBriefing(away.match, "blue")[0];
    if (!(line.roundsLeft === owed)) {
      fail("pb293 (e): the briefing says " + line.roundsLeft + " rounds left where the server charges " + owed);
    }
    const offered = (line.missions || []).map((mission) => mission.mode).join(",");
    if (offered !== "patrol") {
      fail("pb293 (e) l.777: an inactive plane's briefing still offers " + JSON.stringify(offered)
        + "; the server refuses every mission but CAP, so the page must not offer them (producer: airBriefing's"
        + " `allowed` filter)");
    }
    const capMission = line.missions[0];
    if (capMission.allowed !== true) fail("pb293 (e): the offered CAP is not marked allowed");
    if (!capMission.note || !/adds /.test(capMission.note)) {
      fail("pb293 (e): the inactive CAP carries no added-rounds note (" + JSON.stringify(capMission.note) + ")");
    }
    // The CAP the briefing offers is the CAP the server flies: accepted, and it adds the cost.
    const untilBefore = Number(away.plane.inactiveUntil);
    const cap = fly(away.match, away.plane, "patrol");
    if (cap.error) fail("pb293 (e): the briefing offered a CAP the server refuses: " + JSON.stringify(cap.error));
    if (Number(away.plane.inactiveUntil) !== untilBefore + patrolCost) {
      fail("pb293 (e): the offered CAP set until " + away.plane.inactiveUntil + " from " + untilBefore);
    }
  }

  // ---- the "less effective" lever: present, labelled, and the same value the event carries -------
  {
    const factor = Number(air.inactivePatrolFactor);
    if (!(Number.isFinite(factor) && factor >= 0 && factor <= 1)) {
      fail("pb293: config air.inactivePatrolFactor is " + JSON.stringify(air.inactivePatrolFactor)
        + "; the manual's reduced CAP needs a lever in [0,1]");
    }
    if (!/UNVERIFIED/.test(String(air.inactivePatrolFactorSource || ""))) {
      fail("pb293: air.inactivePatrolFactorSource does not say UNVERIFIED; the amount was never recovered");
    }
    const { match, plane } = setup();
    fly(match, plane, "strike");
    const cap = fly(match, plane, "patrol");
    const event = (cap.events || []).find((entry) => entry.type === "cap_while_inactive");
    if (!event) fail("pb293: a CAP flown while inactive emitted no cap_while_inactive event");
    if (Number(event.effectiveness) !== factor) {
      fail("pb293: the event's effectiveness " + event.effectiveness + " is not the config lever " + factor);
    }
    console.log("pb293 arm (e) ok: an inactive briefing lists CAP alone (allowed, adds " + patrolCost
      + " rounds), the server flies it, and the reduced-effectiveness lever is config's " + factor + " (UNVERIFIED)");
  }
}
