// PB-224 AC2: select plus destination moves it, FASTER than land or sea.
// One file per AC (PM 8918 §2 / 8919 §3): this label carries AC2 and nothing else.
//
// Manual p.29 L924-937: a satellite moves much faster than ground units. The rate is
// satellite.speedCells (a named STAND-IN in config), applied by tickSatellites; land walks 1-2
// cells a round and a hull 3, so the arm compares the satellite against both.
//
// What fails if this is removed: a satellite that moves at infantry speed, or a round that steps
// past its own speed budget, stops being caught.

import { cellsPerRound } from "../../server/rules.mjs";
import { buySatellite, orderSatellite, satelliteRules, tickSatellites } from "../../server/satellite.mjs";
import { fresh, makeAsserts } from "../pb224_helpers.mjs";

export const name = "pb224_ac2_fly";

export async function run() {
  const t = makeAsserts(name);
  const cfg = satelliteRules();
  const match = fresh();
  const bought = buySatellite(match, "blue", 40, 40);
  if (bought.error) t.fail("satellite: " + bought.error);

  const tank = cellsPerRound({ kind: "tank", domain: "land" });
  const hull = cellsPerRound({ kind: "cruiser", domain: "sea" });
  t.ok("the satellite is faster than a tank (" + cfg.speedCells + " > " + tank + ")", cfg.speedCells > tank);
  t.ok("the satellite is faster than a hull (" + cfg.speedCells + " > " + hull + ")", cfg.speedCells > hull);

  // A 24-cell move: a satellite flies it in ceil(24/speed) rounds; the tank needs 24/2 = 12.
  const order = orderSatellite(match, "blue", bought.satellite.id, 64, 40);
  if (order.error) t.fail("the satellite order was refused: " + order.error);
  t.eq("the order flies the whole line", order.path.length, 24);
  const rounds = Math.ceil(24 / cfg.speedCells);
  t.eq("the quoted rounds are the satellite's speed", order.rounds, rounds);
  t.ok("the satellite's 24-cell move is quicker than a tank's", rounds < Math.ceil(24 / tank));

  // One round of ticks moves exactly speedCells cells and then stops (a held clock never reaches the
  // tick, which is tickMatch's own guard, not this module's).
  tickSatellites(match);
  t.eq("one round moves the speed's worth of cells", bought.satellite.x, 40 + cfg.speedCells);
  t.ok("the satellite did not stay put", bought.satellite.x > 40);

  // An order for another side's satellite is refused, and so is a destination on its own cell.
  t.ok("red cannot order blue's satellite", Boolean(orderSatellite(match, "red", bought.satellite.id, 0, 0).error));
  t.ok("a satellite cannot be ordered onto the cell it already stands on",
    Boolean(orderSatellite(match, "blue", bought.satellite.id, bought.satellite.x, bought.satellite.y).error));

  console.log(t.line());
}
