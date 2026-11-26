// PB-293 pin: air inactivity, manual_pages.txt l.773-777.
//
//   (a) a mission leaves the unit inactive for its cost in rounds (air.strikeRounds, 8);
//   (b) CAP (patrol) costs air.patrolRounds (4);
//   (c) an INACTIVE unit may still fly CAP, and that CAP ADDS its cost to what the unit owes;
//   (d) an inactive unit may fly NO other mission - strike, bomb and transfer are all refused.
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
import { inactiveRounds, sendMission } from "../../server/air.mjs";
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
      fail("pb293 (c) l.773-777 DEVIATION: an inactive plane was refused CAP with "
        + JSON.stringify(cap.error) + " while it owed " + owed + " rounds. The manual says an inactive unit may fly "
        + "CAP and that the CAP ADDS " + patrolCost + " rounds. Producer: web/server/air.mjs:280-281 refuses on "
        + "`remaining > 0` before web/server/air.mjs:42 modeFor is consulted, so the CAP exception has no path. "
        + "Measured, reported, not fixed (PM 9823).");
    }
    const after = Number(plane.inactiveUntil);
    if (!(after >= untilBefore + patrolCost)) {
      fail("pb293 (c) l.773-777: CAP while inactive set until " + after + " from " + untilBefore
        + ", not an ADD of " + patrolCost + " rounds");
    }
    console.log("pb293 arm (c) ok at l.773-777: CAP while inactive added " + patrolCost + " rounds (" + untilBefore + " -> " + after + ")");
  }
}
