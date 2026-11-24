// PB-224 AC3b: a pass reveals ENEMIES only; a friendly piece inside the radius is not a reveal.
// Its own label by the ruling (PM 8918 §2): AC3b is the side filter, a different rule from AC3's
// radius, and it must be able to red on its own.
//
// The skip is `unit.side === sat.side`. Without it the pass stamps friendly pieces with
// revealedRound, which the frame then reads as an intel reveal on your own unit.
//
// What fails if this is removed: deleting the side filter leaves every arm in AC3 green and only
// this label reds.

import { buySatellite, tickSatellites } from "../../server/satellite.mjs";
import { fresh, makeAsserts, unit } from "../pb224_helpers.mjs";

export const name = "pb224_ac3b_friendly";

export async function run() {
  const t = makeAsserts(name);
  const match = fresh();
  const friend = unit("blue:friend", "blue", "infantry", "land", 202, 60);
  const enemy = unit("red:near", "red", "infantry", "land", 197, 60);
  match.pieces = [
    friend,
    enemy,
    unit("red:far", "red", "infantry", "land", 300, 120),
  ];
  const bought = buySatellite(match, "blue", 200, 60);
  if (bought.error) t.fail("satellite: " + bought.error);

  // The positive control: the pass DID run and stamped the enemy beside the friend. Without it a
  // broken pass (or an empty tick) would make the "no friendly stamp" arm green for no reason.
  const events = tickSatellites(match);
  const pass = events.find((event) => event.type === "satellite");
  if (!pass) t.fail("the pass with one enemy in radius produced no event: " + JSON.stringify(events));
  t.eq("the pass reveals the enemy beside the friend and nothing else", pass.reveals, 1);
  t.eq("the enemy inside the radius is stamped for this round", enemy.revealedRound, match.round);
  t.ok("the pass did not stamp a friendly piece", friend.revealedRound === undefined);
  t.ok("the pass did not stamp the enemy outside the radius",
    match.pieces.find((piece) => piece.id === "red:far").revealedRound === undefined);

  console.log(t.line());
}
