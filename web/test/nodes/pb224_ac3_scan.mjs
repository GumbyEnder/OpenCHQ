// PB-224 AC3: each round, enemy units inside the scan radius are revealed, NEVER submarines.
// One file per AC (PM 8918 §2 / 8919 §3): this label carries AC3 and nothing else, so an AC3b or
// AC4 red cannot be mistaken for a scan red.
//
// Manual p.12 L326/L329 and p.29 L936: the radius exposes every enemy unit except submarines.
// PB-222's rule (a submarine is never revealed from the air) is kept at the piece here.
//
// What fails if this is removed: a pass that reveals a submarine, a unit one cell outside the
// radius, a friendly piece, or a stamp that outlives its round stops being caught.

import { forSeat } from "../../server/view.mjs";
import { buySatellite, satelliteRules, tickSatellites } from "../../server/satellite.mjs";
import { fresh, makeAsserts, unit } from "../pb224_helpers.mjs";

export const name = "pb224_ac3_scan";

export async function run() {
  const t = makeAsserts(name);
  const cfg = satelliteRules();
  const match = fresh();
  match.pieces = [
    unit("red:near", "red", "infantry", "land", 103, 40),
    unit("red:edge", "red", "tank", "land", 100 + cfg.scanRadius, 40),
    unit("red:out", "red", "infantry", "land", 100 + cfg.scanRadius + 1, 40),
    unit("red:sub", "red", "submarine", "sea", 100, 40),
    // Blue's own piece is parked FAR away on purpose: within sightCells (8) of red:out it would be
    // on the wire by ordinary sight, and this arm must fail if a reveal is what put it there.
    unit("blue:own", "blue", "infantry", "land", 10, 10),
  ];
  const bought = buySatellite(match, "blue", 100, 40);
  if (bought.error) t.fail("satellite: " + bought.error);

  const events = tickSatellites(match);
  const pass = events.find((event) => event.type === "satellite");
  if (!pass) t.fail("the satellite produced no pass event: " + JSON.stringify(events));
  t.eq("the pass reveals the near unit and the edge unit, never the sub or the far one or blue's own",
    pass.reveals, 2);
  const seen = forSeat(match, "blue").pieces.map((piece) => piece.id).sort();
  t.eq("the seat's frame carries exactly the revealed enemies plus its own piece", seen,
    ["blue:own", "red:edge", "red:near"]);
  t.ok("the pass did not stamp the submarine",
    match.pieces.find((piece) => piece.id === "red:sub").revealedRound === undefined);
  t.ok("the pass did not stamp a unit outside the radius",
    match.pieces.find((piece) => piece.id === "red:out").revealedRound === undefined);

  // The reveal lives one round, exactly like the old satellite stamp: the round after the pass it
  // is gone. Without this a stale stamp would reveal the board for the rest of the match.
  match.round += 1;
  const next = forSeat(match, "blue");
  t.ok("the reveal did not outlive its own round", !next.pieces.some((piece) => piece.id === "red:near"));
  t.ok("the satellite is still on the frame", next.satellites.some((sat) => sat.id === bought.satellite.id));

  console.log(t.line());
}
