// Node test for PB-224's OPENING POSITION: a 1986 or 2023 start opens with one recon satellite per
// side already in orbit, every other era opens with none.
//
// PM 8913 §2 ruled this off p.12 L326-328 ("Press Satellite. You'll see your satellite (in blue)
// over the Atlantic... The red satellite is over Europe") and p.16 L439 / p.29 L924 (satellites are
// a 1986/2023 feature). Both the COUNT and the CELLS are STAND-INS: the p.12 frame is a tutorial and
// the archive prints no start position, so the DOSBox check is owed (Open RE Q-new).
//
// Why this is a separate node from pb224_satellite_unit: the bought-unit ACs and the ruled opening are
// separate behaviours with separate sources, and a red line should name which of the two broke.
//
// What fails if this is removed: openMatch stops seeding, a 1986 room shows an empty Show Satellites
// box until someone buys one, and the p.12 frame the ruling is built on is not reproduced at all.

import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { buySatellite, satelliteRules } from "../../server/satellite.mjs";

export const name = "pb224_satellite_start";

function fail(message) {
  throw new Error("node test pb224_satellite_start: " + message);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(label + ": " + a + " !== " + b);
}

export async function run() {
  const cfg = satelliteRules();

  // --- the two eras the ruling names open with one per side, on the config cells ----------------
  for (const era of ["1986", "2023"]) {
    const match = openMatch(era, []);
    eq(era + " opens with one satellite per side", match.satellites.length, 2);
    eq(era + " opens with one blue and one red", match.satellites.map((sat) => sat.side).sort(), ["blue", "red"]);
    for (const sat of match.satellites) {
      eq(era + " " + sat.side + " satellite sits on the config start cell",
        [sat.x, sat.y], [cfg.startCells[sat.side].x, cfg.startCells[sat.side].y]);
      eq(era + " " + sat.side + " satellite opens in orbit with a full tank",
        [sat.orbit, sat.fuel, sat.fuelCapacity], [true, cfg.fuelCapacity, cfg.fuelCapacity]);
    }
    // The p.12 stand-in is blue over the Atlantic, red over Europe: the blue one must sit WEST of the
    // red one on this board (New York 83,42 / London 148,30), or the frame is mirrored and the test
    // is pinning a coordinate pair without pinning the picture it stands for.
    const blue = match.satellites.find((sat) => sat.side === "blue");
    const red = match.satellites.find((sat) => sat.side === "red");
    if (!(blue.x < red.x)) fail(era + ": the blue satellite is not west of the red one (" + blue.x + " !< " + red.x + ")");

    // It is not a ground piece: the opening pair must not block a cell, take fire or capture.
    if (match.pieces.some((unit) => unit.domain === "sat" || unit.kind === "reconSat")) {
      fail(era + " put a satellite in match.pieces");
    }
    // Both seats' payloads carry the pair, and it is on the Show Satellites view from round 0.
    for (const seat of ["blue", "red"]) {
      eq(era + " " + seat + "'s frame carries both opening satellites",
        forSeat(match, seat).satellites.map((sat) => sat.side).sort(), ["blue", "red"]);
    }
  }

  // --- every other era opens with none, including 9999 whose roster carries reconSat -------------
  for (const era of ["1918", "1942", "9999"]) {
    eq(era + " opens with no satellite", openMatch(era, []).satellites.length, 0);
  }

  // --- the opening ids are outside the purchase namespace --------------------------------------
  // A bought unit is `<side>:<kind>:<n>` from seat.bought, which starts at 0. The setup pair must not
  // sit in that space or the first purchase would collide with it.
  const match = openMatch("1986", []);
  match.sides.blue.cash = 50000;
  const bought = buySatellite(match, "blue", 40, 20);
  if (bought.error) fail("a satellite could not be bought beside the opening pair: " + bought.error);
  const ids = match.satellites.map((sat) => sat.id);
  eq("three satellites, three distinct ids", new Set(ids).size, 3);
  if (bought.satellite.id.startsWith("blue:reconSat:setup")) fail("the buy reused the setup id namespace");
}
