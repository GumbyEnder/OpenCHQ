// Node pb127_capital_attrition: a capital cell charges the same per-round attrition as a city cell.
//
// PB-127 row 2. move.attritionStep keys the rate by TERRAIN NAME (move.mjs:547) and
// config/game.json's attritionPerRound had city 0.5 but no `capital` key, so a non-owner unit on a
// capital cell drained 0 where a city cell would drain 0.5 (city 100 -> 99.5, capital 100 -> 100).
// The site branch already lists capital in its isSite set and already spares an owner-held cell;
// the missing key was the whole defect. The value is the SAME STAND-IN as city/base/dock: the
// original charges these alike per pass (measured.combat.attritionPerPass city = capital = 20), and
// the pass-to-round conversion is D-017, still open.
//
// Pinned here, red at the pre-fix tree:
//   1. config: attritionPerRound.capital exists, equals city to the byte (0.5), and its source is
//      labelled STAND-IN and names D-017;
//   2. enemy-held capital cell, one round: 100 -> 99.5, one attrition event, terrain "capital";
//   3. enemy-held city cell, one round: 100 -> 99.5 - the same number, so the rule is parity;
//   4. owner-held capital cell: 100 -> 100 and no event, which proves the owner guard (not the key)
//      is what spares a friendly cell.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attritionStep } from "../../server/move.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb127_capital_attrition";

function fail(message) {
  throw new Error("node test pb127_capital_attrition: " + message);
}

function probe(terrain, owner, kind = "capital") {
  const match = {
    round: 1,
    sites: [{ id: 62, name: "Washington", x: 10, y: 10, kind, owner }],
    pieces: [{ id: "red:probe:1", side: "red", domain: "land", kind: "infantry", x: 10, y: 10, strength: 100 }],
  };
  const events = attritionStep(match, () => terrain);
  return { strength: match.pieces[0].strength, events };
}

export async function run() {
  const rules = combatRules();
  const rates = rules.attritionPerRound || {};
  if (!Object.prototype.hasOwnProperty.call(rates, "capital")) {
    fail("attritionPerRound has no `capital` key, so a capital cell silently takes 0 (rates: " + JSON.stringify(rates) + ")");
  }
  if (rates.capital !== rates.city) {
    fail("capital rate " + JSON.stringify(rates.capital) + " is not city's " + JSON.stringify(rates.city));
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const configFile = path.join(here, "..", "..", "..", "config", "game.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const block = config.combat && config.combat.attritionPerRound;
  if (!block || !block.value || block.value.capital === undefined) {
    fail("config/game.json carries no combat.attritionPerRound.value.capital");
  }
  if (block.value.capital !== block.value.city) {
    fail("config capital " + block.value.capital + " != city " + block.value.city);
  }
  const source = String(block.source || "");
  if (!/STAND-IN/i.test(source)) fail("attritionPerRound lost its STAND-IN label");
  if (!/D-017/.test(source)) fail("attritionPerRound's source does not name D-017, the open pass-to-round question");
  if (!/capital/i.test(source)) fail("attritionPerRound's source does not say the capital value is the same stand-in");

  // 2. Enemy-held capital.
  const capital = probe("capital", "blue", "capital");
  if (capital.events.length !== 1) fail("enemy-held capital emitted " + capital.events.length + " attrition events, expected 1");
  if (capital.strength !== 99.5) fail("enemy-held capital drained 100 -> " + capital.strength + ", expected 99.5");
  if (capital.events[0].terrain !== "capital") fail("event terrain is " + JSON.stringify(capital.events[0].terrain));
  if (capital.events[0].amount !== 0.5) fail("event amount is " + JSON.stringify(capital.events[0].amount) + ", expected 0.5");

  // 3. Enemy-held city: parity.
  const city = probe("city", "blue", "city");
  if (city.strength !== capital.strength) {
    fail("enemy-held city drained to " + city.strength + " but capital drained to " + capital.strength + "; the rule must be parity");
  }
  if (city.events.length !== 1) fail("enemy-held city emitted " + city.events.length + " events, expected 1");

  // 4. Owner-held capital: the guard, not the key, is what spares it.
  const held = probe("capital", "red", "capital");
  if (held.events.length !== 0) fail("owner-held capital emitted " + held.events.length + " events, expected 0");
  if (held.strength !== 100) fail("owner-held capital drained 100 -> " + held.strength + ", expected 100");

  console.log("pb127_capital_attrition ok: capital rate " + rates.capital + " = city " + rates.city + "; " +
    "enemy-held 100 -> " + capital.strength + " (capital) and 100 -> " + city.strength + " (city); owner-held 100 -> " +
    held.strength + "; source names STAND-IN + D-017");
}
