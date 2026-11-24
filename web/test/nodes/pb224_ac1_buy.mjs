// PB-224 AC1: buying reconSat creates a satellite piece OWNED by that side, at the picked point.
// One file per AC (PM 8918 §2 / 8919 §3), so a red names the AC instead of hiding five later arms
// behind one fail(): this label carries AC1 and nothing else.
//
// Manual p.29 L924: satellites are "purchased like any other unit". There is no placement rule to
// satisfy - the manual gives a satellite a point on the satellite map, not a friendly city - so the
// only checks are the era, the purse and the cell.
//
// What fails if this is removed: a buy that lands at the wrong point, on the wrong side, with a
// ground piece beside it, or that charges the wrong price, stops being caught.

import { CELL_H } from "../../server/board.mjs";
import { buySatellite, satelliteRules } from "../../server/satellite.mjs";
import { fresh, makeAsserts } from "../pb224_helpers.mjs";

export const name = "pb224_ac1_buy";

export async function run() {
  const t = makeAsserts(name);
  const cfg = satelliteRules();
  const match = fresh();
  const before = match.sides.blue.cash;

  const bought = buySatellite(match, "blue", 100, 40);
  if (bought.error) t.fail("a 1986 blue satellite was refused: " + bought.error);
  const sat = bought.satellite;
  t.eq("the satellite is blue's", sat.side, "blue");
  t.eq("the satellite's kind", sat.kind, "reconSat");
  t.eq("the satellite's domain", sat.domain, "sat");
  t.eq("the satellite sits where it was picked", [sat.x, sat.y], [100, 40]);
  t.eq("the satellite opens in orbit", sat.orbit, true);
  t.eq("the satellite's radius is the config's", sat.radius, cfg.scanRadius);
  t.eq("the satellite's fuel is the config's capacity", [sat.fuel, sat.fuelCapacity], [cfg.fuelCapacity, cfg.fuelCapacity]);
  t.eq("the satellite was charged at the reconSat price", match.sides.blue.cash, before - bought.price);
  // It flies ABOVE the board: no ground piece, so no cell is blocked and no city can be captured by
  // orbiting over it (the reason the record lives in match.satellites, not match.pieces).
  t.eq("the buy added no ground piece", match.pieces.length, 0);

  // Red buys its own; each side owns its piece, and the ids do not collide.
  const red = buySatellite(match, "red", 100, 40);
  if (red.error) t.fail("the same cell was refused to red's satellite: " + red.error);
  t.ok("the two sides do not share one satellite id", red.satellite.id !== sat.id);
  t.eq("red owns the second satellite", red.satellite.side, "red");

  // Refusals: an era without satellites, a cell off the map, an empty purse.
  t.ok("1942 sells no recon satellite", Boolean(buySatellite(fresh("1942"), "blue", 100, 40).error));
  t.ok("a satellite cannot be placed off the map", Boolean(buySatellite(fresh(), "blue", 100, CELL_H + 1).error));
  const poor = fresh();
  poor.sides.blue.cash = 0;
  t.ok("a satellite cannot be bought with an empty pool", Boolean(buySatellite(poor, "blue", 100, 40).error));

  console.log(t.line());
}
