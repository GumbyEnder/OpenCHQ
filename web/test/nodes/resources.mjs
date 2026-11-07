// resources — more than oil, and still no invented rates.
//
// What fails if this is removed:
//   - a second resource kind exists only as a row of config              -> adding a third kind
//     would mean editing the economy module again, which is the one-off oil code this node
//     exists to remove
//   - the kind is held and consumed per side, generically                -> a reserve would go
//     back to being an `if (kind === "oil")` field on the seat
//   - a kind names the scenarios it belongs to                           -> steel would appear in
//     1918 and the era gate would be decoration
//   - a kind with no `rate` is refused, not paid                         -> the first invented
//     yield would become the game's lore the moment the page drew it
//   - the seat view and the player's purse carry the kind                -> the model could be
//     right and still be invisible
//
// The last one is the important one. This project's rule is that nothing unknown gets a number
// by default; `produce` returning an error instead of paying 1 is that rule as code.
//
// A third kind is configured here at runtime (`tin`, which appears nowhere in web/) to prove a
// kind is data: the same hold/consume/refuse functions serve it without a line of new code.

import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { configPath, resetRules } from "../../server/rules.mjs";
import {
  consume,
  hold,
  knownKinds,
  metersFor,
  produce,
  rateOf,
  resourceKinds,
  resourceSpec,
  upkeepResources,
} from "../../server/resources.mjs";
import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { purseText } from "../../public/command.mjs";

export const name = "resources";

export async function run(ctx) {
  const { fail } = ctx;
  const must = (ok, why) => {
    if (!ok) fail(why);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const meter = (match, side, kind) => metersFor(match, side).find((entry) => entry.kind === kind) || null;

  // ---- kinds are data, not branches ------------------------------------------------------
  const kinds = knownKinds();
  must(kinds.includes("fuel"), "the fuel kind fell out of config: " + JSON.stringify(kinds));
  must(kinds.includes("steel"), "there is no second resource kind in config: " + JSON.stringify(kinds));
  eq(Number(resourceSpec("steel").reserve), 40, "the second kind's reserve must come from config");

  // ---- a scenario carries only the kinds it names -----------------------------------------
  const early = resourceKinds("1918");
  must(early.includes("fuel"), "1918 lost fuel: " + JSON.stringify(early));
  must(!early.includes("steel"), "steel leaked into 1918: " + JSON.stringify(early));
  const modern = resourceKinds("1986");
  must(modern.includes("steel"), "1986 lost steel: " + JSON.stringify(modern));

  // ---- held and consumed, per side, with no code per kind ---------------------------------
  const match = openMatch("1986", []);
  const spent = consume(match, "blue", "steel", 5);
  must(spent && spent.ok === true, "a side could not spend steel: " + JSON.stringify(spent));
  eq(spent.held, 35, "steel after spending 5");
  eq(meter(match, "red", "steel").held, 40, "one side's spending must not touch the other's reserve");
  const topped = hold(match, "blue", "steel", 2);
  must(topped && topped.ok === true, "a side could not hold steel: " + JSON.stringify(topped));
  eq(topped.held, 37, "steel after holding 2");

  // ---- a dry kind is a flag, and zero is the floor ----------------------------------------
  const drained = consume(match, "red", "steel", 40);
  must(drained && drained.ok === true, "a side could not spend its whole reserve: " + JSON.stringify(drained));
  eq(drained.held, 0, "a reserve must reach zero");
  eq(drained.dry, true, "an empty reserve must be flagged dry");
  const over = consume(match, "red", "steel", 1);
  must(over && over.error, "a side spent steel it did not have");
  must(/Not enough steel/.test(over.error), "wrong refusal for an empty reserve: " + over.error);
  eq(meter(match, "red", "steel").held, 0, "a refused spend must not go below zero");

  // ---- the rate nobody recovered is refused, never defaulted ------------------------------
  eq(rateOf("steel"), null, "steel has no recovered rate and must report null");
  eq(rateOf("fuel"), null, "fuel has no recovered rate and must report null");
  const before = meter(match, "blue", "steel").held;
  const paid = produce(match, "blue", "steel", 3);
  must(paid && paid.error, "a kind with no rate paid something anyway: " + JSON.stringify(paid));
  must(/never recovered/.test(paid.error), "an unknown rate must say so: " + paid.error);
  eq(meter(match, "blue", "steel").held, before, "a refused payout must not change the reserve");

  // ---- a round burns every kind the scenario carries --------------------------------------
  const roundMatch = openMatch("1986", []);
  upkeepResources(roundMatch);
  eq(meter(roundMatch, "blue", "steel").held, 39, "one running round must burn one steel");
  eq(meter(roundMatch, "red", "steel").held, 39, "the burn is per side");
  const oldMatch = openMatch("1918", []);
  upkeepResources(oldMatch);
  must(!oldMatch.sides.blue.resources || !Object.hasOwn(oldMatch.sides.blue.resources, "steel"),
    "a 1918 round created a steel holding: " + JSON.stringify(oldMatch.sides.blue.resources));
  must(!consume(oldMatch, "blue", "steel", 1).ok, "a scenario without steel let a side spend it");

  // ---- shown: the seat view and the player's own purse -----------------------------------
  const shownMatch = openMatch("1986", []);
  consume(shownMatch, "blue", "steel", 5);
  const seat = forSeat(shownMatch, "blue").seat;
  must(seat && Array.isArray(seat.reserves), "the seat view carries no resource list");
  const steel = (seat.reserves || []).find((entry) => entry.kind === "steel");
  must(steel, "the seat view dropped steel: " + JSON.stringify(seat.reserves));
  eq(steel.held, 35, "the seat view's steel holding");
  eq(steel.rate, null, "the seat view must report an unrecovered rate as null, not a number");
  const purse = purseText(seat);
  must(purse.includes("steel 35"), "the purse does not show the second kind: " + purse);
  must(!purse.includes("$"), "the purse is written as money: " + purse);

  // ---- a third kind, configured here, needs no new code anywhere -------------------------
  const shipped = JSON.parse(readFileSync(configPath(), "utf8"));
  const custom = JSON.parse(JSON.stringify(shipped));
  custom.resources.tin = { reserve: 7, burn: 2, eras: ["1986"] };
  const customPath = path.join(ctx.dataDir, "game-tin.json");
  writeFileSync(customPath, JSON.stringify(custom, null, 2));
  const previous = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = customPath;
  resetRules();
  try {
    must(knownKinds().includes("tin"), "a configured kind is not known: " + JSON.stringify(knownKinds()));
    must(!resourceKinds("1942").includes("tin"), "the configured kind ignored its era gate");
    const tinMatch = openMatch("1986", []);
    eq(meter(tinMatch, "blue", "tin").held, 7, "a configured kind's reserve");
    const tinSpent = consume(tinMatch, "blue", "tin", 3);
    must(tinSpent && tinSpent.ok === true, "a configured kind could not be consumed: " + JSON.stringify(tinSpent));
    eq(tinSpent.held, 4, "a configured kind after spending");
    const tinPaid = produce(tinMatch, "blue", "tin", 1);
    must(tinPaid && /never recovered/.test(String(tinPaid.error)), "a configured kind paid without a rate");
    upkeepResources(tinMatch);
    eq(meter(tinMatch, "blue", "tin").held, 2, "a configured kind must burn what config says");
  } finally {
    if (previous === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = previous;
    resetRules();
  }

  // ---- fuel kept its old seat fields, and fuel is now one kind like any other -------------
  const fuelMatch = openMatch("1986", []);
  upkeepResources(fuelMatch);
  const fuelSpec = resourceSpec("fuel");
  eq(fuelMatch.sides.blue.fuel, Number(fuelSpec.reserve) - Number(fuelSpec.burn), "fuel's old seat field");
  eq(fuelMatch.sides.blue.resources.fuel.held, fuelMatch.sides.blue.fuel, "the fuel meter and the old field disagree");
}
