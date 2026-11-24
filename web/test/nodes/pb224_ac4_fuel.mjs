// PB-224 AC4: each move spends fuel; at 0 the satellite is removed, with a log line.
// One file per AC (PM 8918 §2 / 8919 §3): this label carries AC4 and nothing else.
//
// Manual p.29 L924-937: each move burns booster fuel and "sweeping" ultimately knocks the satellite
// out of the sky. The archive prints no fuel count, so fuelCapacity/fuelPerMove are config
// STAND-INS, and the removal rule is the card's: the move that spends the last unit is still flown,
// then the piece is swept with a log line.
//
// What fails if this is removed: an order that spends no fuel, a piece that never falls, a fall
// with no log line, or a dry satellite that still accepts an order stops being caught.
//
// The REMOVAL is asserted directly. An earlier loop ran until `sat.orbit === false`, so a never-
// swept satellite redded on the next move's refusal ("move 4 was refused early") instead of on the
// removal rule it is meant to pin - measured: mutant D at f8cec52.

import { logLines } from "../../server/log.mjs";
import { buySatellite, orderSatellite, satelliteRules, tickSatellites } from "../../server/satellite.mjs";
import { fresh, makeAsserts } from "../pb224_helpers.mjs";

export const name = "pb224_ac4_fuel";

export async function run() {
  const t = makeAsserts(name);
  const cfg = satelliteRules();
  const match = fresh();
  const bought = buySatellite(match, "blue", 20, 40);
  if (bought.error) t.fail("satellite: " + bought.error);
  const sat = bought.satellite;
  let down = null;

  for (let moves = 1; moves <= cfg.fuelCapacity; moves++) {
    const order = orderSatellite(match, "blue", sat.id, sat.x + 2, 40);
    if (order.error) t.fail("move " + moves + " was refused with fuel still in the tank: " + order.error);
    t.eq("move " + moves + " spent exactly fuelPerMove", order.fuel, cfg.fuelCapacity - cfg.fuelPerMove * moves);
    const events = tickSatellites(match);
    down = events.find((event) => event.type === "satellite_down") || down;
    if (moves < cfg.fuelCapacity) {
      t.ok("the satellite is still in orbit after " + moves + " of " + cfg.fuelCapacity + " moves",
        sat.orbit !== false);
    }
  }
  t.eq("the satellite is out of orbit after fuelCapacity moves", sat.orbit, false);
  t.eq("the satellite is no longer in match.satellites", match.satellites.some((one) => one.id === sat.id), false);
  if (!down) t.fail("the satellite fell out of orbit with no event");
  t.eq("the down event names the piece", down.pieceId, bought.satellite.id);
  t.eq("the down event's reason", down.reason, "fuel");
  const ownerLine = logLines(match, "blue", [down], match.round).map((line) => line.text).join(" ");
  t.ok("the seat gets a log line for the satellite that fell", /fallen out of orbit|fuel/i.test(ownerLine));

  // And a satellite with no fuel cannot be ordered at all (belt and braces: the piece is gone here,
  // so this arm uses a fresh one whose tank is already dry).
  const dry = fresh();
  const dryBought = buySatellite(dry, "blue", 20, 40);
  dryBought.satellite.fuel = 0;
  t.ok("a satellite with an empty tank accepts no order",
    Boolean(orderSatellite(dry, "blue", dryBought.satellite.id, 30, 40).error));

  console.log(t.line());
}
