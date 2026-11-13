// measured_combat — the original's fight, as measured (T-009, AC7).
//
// What fails if this is removed:
//   - a MEASURED row quietly loses its evidenceRef        -> the number stops being traceable
//   - someone re-guesses baseDamage back to a stand-in    -> the matrix cell it came from disagrees
//   - the per-round rates get "measured" without D-017    -> attrition/repair claim a figure that
//     depends on the speed setting, so the label lies
//   - the 0x1956 range matrix is re-read as cell counts   -> the thresholds are SQUARED distances
//
// The numbers come from a live read of the running original and from CHQ_unpacked.EXE on
// 2026-11-13 (DOSBox 0.74-3, cycles=auto). Evidence: docs/re/COMBAT.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { combatKeys, combatRules, combatSource, combatValue } from "../../server/rules.mjs";
import { baseDamageFor, damageFor } from "../../server/combat.mjs";

export const name = "measured_combat";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, "..", "..", "..", "config", "game.json");

// Rows the original's 0x18f0 matrix hands to the runtime, by the remake's kind name. The value is
// the cell for a same-class opponent, which is what a flat per-kind damage can express.
const MEASURED_BASE_DAMAGE = { infantry: 17, tank: 20, cruiser: 25, carrier: 25, submarine: 34 };

export async function run(ctx) {
  const { fail } = ctx;
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const block = config.combat || {};

  // --- every key is labelled, and a MEASURED label carries its evidence ---------------------
  for (const key of combatKeys()) {
    const value = combatValue(key, undefined);
    if (value === undefined) fail("config.combat." + key + " has no value");
    const source = combatSource(key).trim();
    if (!source) fail("config.combat." + key + " has no source");
    const entry = block[key];
    if (/MEASURED/i.test(source) && !/STAND-IN|UNMEASURED|UNVERIFIED/i.test(source)) {
      if (typeof entry.evidenceRef !== "string" || !entry.evidenceRef.trim()) {
        fail("config.combat." + key + " is labelled MEASURED without an evidenceRef");
      }
    }
  }

  // --- the per-round rates are still stand-ins until the pacing ruling ----------------------
  for (const key of ["attritionPerRound", "repairPerRound"]) {
    if (!/STAND-IN/i.test(combatSource(key))) {
      fail("config.combat." + key + " claims a per-round measurement; the original applies it per pass and passes per round move with the speed (D-017)");
    }
  }

  // --- damage: the runtime rows are the matrix cells, not the old guesses -------------------
  const measured = combatValue("measured", {}) || {};
  const matrix = measured.damageMatrix || {};
  const rows = matrix.rows || {};
  for (const kind of [1, 2, 3, 7, 8, 9]) {
    if (!Array.isArray(rows[String(kind)]) || rows[String(kind)].length !== 9) {
      fail("measured.damageMatrix is missing row " + kind + " (nine target columns)");
    }
  }
  const baseDamage = combatValue("baseDamage", {}) || {};
  for (const [kind, expected] of Object.entries(MEASURED_BASE_DAMAGE)) {
    if (Number(baseDamage[kind]) !== expected) {
      fail("combat.baseDamage." + kind + " is " + baseDamage[kind] + ", not the measured " + expected);
    }
  }
  // A sub may not hurt land: the matrix column for kind 1 is 0 and the runtime must not print a
  // damage number for that pairing either.
  if (rows["7"][1] !== 0) fail("damageMatrix sub->infantry is not 0; a sub cannot engage land");
  if (rows["7"][0] !== 5) fail("damageMatrix row 7 no longer starts at the 0x18f0 base layout");
  if (Number(baseDamage.submarine) <= Number(baseDamage.cruiser)) {
    fail("a submarine must hit hulls harder than a cruiser does (measured 34 vs 25)");
  }

  // --- ranges are squared-distance thresholds, not cells ----------------------------------
  const classes = (measured.rangeMatrix || {}).classes || [];
  if (classes.length !== 6) fail("measured.rangeMatrix.classes is not the 6x6 matrix");
  const want = [[5, 5, 2, 2, 2, 26], [5, 5, 2, 2, 2, 10], [0, 5, 5, 5, 5, 17],
    [10, 10, 10, 10, 10, 26], [17, 17, 17, 17, 17, 37], [0, 0, 20, 20, 20, 20]];
  for (let r = 0; r < 6; r++) {
    if (JSON.stringify(classes[r]) !== JSON.stringify(want[r])) {
      fail("rangeMatrix row " + r + " is " + JSON.stringify(classes[r]) + ", not " + JSON.stringify(want[r]));
    }
  }
  const cfg = combatRules();
  if (cfg.landEngageCells !== 2) fail("landEngageCells is " + cfg.landEngageCells + ", not the measured 2 (dist^2 <= 5)");
  const sea = cfg.seaRangeCells || {};
  if (sea.submarine !== 2 || sea.cruiser !== 3 || sea.carrier !== 4) {
    fail("seaRangeCells is not the measured ladder 2/3/4: " + JSON.stringify(sea));
  }
  if (!(sea.submarine < sea.cruiser && sea.cruiser < sea.carrier)) {
    fail("the sea ladder lost sub < cruiser < carrier (Manual p.42)");
  }
  // Class 2 (kind 7) has a 0 against land: the sub cannot shoot ashore.
  if (classes[2][0] !== 0) fail("the sub's land column is not 0 in the range matrix");

  // --- modifiers ---------------------------------------------------------------------------
  const mods = measured.modifiers || {};
  if (mods.rear !== 2) fail("modifiers.rear is not the measured x2");
  if (mods.flank !== 1.5) fail("modifiers.flank is not the measured x1.5");
  if (cfg.flankMultiplier !== 1.5) fail("combat.flankMultiplier is " + cfg.flankMultiplier + ", not 1.5");
  if (cfg.rearMultiplier !== 2) fail("combat.rearMultiplier is " + cfg.rearMultiplier + ", not the measured rear x2");
  if (cfg.entrenchDamageFactor !== 1) {
    fail("entrenchDamageFactor is " + cfg.entrenchDamageFactor + "; the entrench discount is the kind-3 column and a second factor would count it twice");
  }
  if (!(mods.terrainCoverCity["1"] < mods.terrainCoverMountain["1"])) {
    fail("city cover must be stronger than mountain cover for infantry (measured 0.667 vs 0.75)");
  }

  // --- attrition table -> per-pass rows ----------------------------------------------------
  const bytes = (measured.attritionTable || {}).bytes || [];
  if (bytes.length !== 15) fail("measured.attritionTable.bytes is not the 15-terrain 0x1996 table");
  const terrainNames = ["ocean", "dock", "ocean2", "lake", "capital", "base", "city", "oilfield",
    "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland"];
  const perPass = measured.attritionPerPass || {};
  for (let t = 1; t < bytes.length; t++) {
    const amount = bytes[t] & 0x1f;
    const name = terrainNames[t];
    if (name === "ocean2") continue;
    const expected = t === 14 ? 34 : amount;
    if (Number(perPass[name]) !== expected) {
      fail("attritionPerPass." + name + " is " + perPass[name] + ", not " + expected + " from 0x1996");
    }
  }
  // Manual p.21's 20 % floor is literally strength - 20 in the code.
  if (cfg.attritionFloor !== 0.2) fail("attritionFloor is not 0.2 (the strength-20 term)");
  if (!(Number(perPass.polar) > Number(perPass.desert))) {
    fail("polar attrition (5) must exceed desert (3)");
  }
  const repair = measured.repairPerPass || {};
  if (repair.amount !== 10) fail("repairPerPass.amount is not the measured 10");
  if (repair.everyOtherPass !== true) fail("repairPerPass.everyOtherPass is not true (0xcae bit 3)");
  if (repair.everyOtherCall !== true) fail("repairPerPass must say the gate is per CALL of FUN_1c0d_0656, not per round");
  if (repair.perPassAverage !== 5) fail("repairPerPass.perPassAverage is not 5 (10 on every other call)");
  if (repair.perRoundSpeed1 !== 59) fail("repairPerPass.perRoundSpeed1 is not the 59 arithmetic (5 x 11.75 passes)");

  // --- the runtime reads the matrix, pairing by pairing ------------------------------------
  // These are the cells the old per-attacker collapse got wrong, so they are the assertions that
  // fail if baseDamage is ever read again for a pairing the table covers.
  const tankToInfantry = baseDamageFor("tank", { kind: "infantry", domain: "land" }, cfg);
  if (tankToInfantry !== 26) fail("tank->infantry is " + tankToInfantry + ", not matrix cell 2->1 = 26");
  const tankToDug = baseDamageFor("tank", { kind: "infantry", domain: "land", entrenched: true }, cfg);
  if (tankToDug !== 20) fail("tank->entrenched infantry is " + tankToDug + ", not matrix cell 2->3 = 20 (the entrench column)");
  const infToTank = baseDamageFor("infantry", { kind: "tank", domain: "land" }, cfg);
  if (infToTank !== 17) fail("infantry->tank is " + infToTank + ", not matrix cell 1->2 = 17");
  const subToLand = baseDamageFor("submarine", { kind: "infantry", domain: "land" }, cfg);
  if (subToLand !== 0) fail("submarine->land is " + subToLand + ", not matrix cell 7->1 = 0");
  const cruiserToCarrier = baseDamageFor("cruiser", { kind: "carrier", domain: "sea" }, cfg);
  if (cruiserToCarrier !== 34) {
    fail("cruiser->carrier is " + cruiserToCarrier + ", not the kind-nine alias 8 -> 34 (table byte 8*9+9)");
  }
  const carrierToCarrier = baseDamageFor("carrier", { kind: "carrier", domain: "sea" }, cfg);
  if (carrierToCarrier !== 25) fail("carrier->carrier is " + carrierToCarrier + ", not the kind-nine alias 9 -> 25");
  const nine = matrix.kindNineColumn || {};
  for (const [code, value] of Object.entries({ 1: 35, 2: 35, 3: 35, 4: 0, 5: 5, 6: 5, 7: 34, 8: 34, 9: 25 })) {
    if (Number(nine[code]) !== value) fail("kindNineColumn[" + code + "] is " + nine[code] + ", not the measured " + value);
  }
  // Flank/rear follow the original's facing comparison and only bite while the defender is
  // already fighting a third piece. A dedicated 1v1 must get neither bonus.
  const third = { id: "blue:c", kind: "tank", domain: "land", facing: "w", fighting: null };
  const plainDuel = damageFor({ id: "blue:a", kind: "tank", domain: "land" }, { id: "red:d", kind: "infantry", domain: "land", facing: "w", fighting: "blue:a" }, cfg);
  if (plainDuel.flank || plainDuel.rear) fail("a 1v1 got a flank/rear bonus: " + JSON.stringify(plainDuel));
  const rearHit = damageFor({ id: "blue:b", kind: "tank", domain: "land", facing: "w" },
    { id: "red:d", kind: "infantry", domain: "land", facing: "w", fighting: "blue:c" }, cfg);
  if (!rearHit.rear || rearHit.amount !== rearHit.base * 2) fail("same-facing attack is not rear x2: " + JSON.stringify(rearHit));
  const flankHit = damageFor({ id: "blue:b", kind: "tank", domain: "land", facing: "n" },
    { id: "red:d", kind: "infantry", domain: "land", facing: "w", fighting: "blue:c" }, cfg);
  if (!flankHit.flank || flankHit.amount !== flankHit.base * 1.5) fail("side attack is not flank x1.5: " + JSON.stringify(flankHit));
  const frontHit = damageFor({ id: "blue:b", kind: "tank", domain: "land", facing: "e" },
    { id: "red:d", kind: "infantry", domain: "land", facing: "w", fighting: "blue:c" }, cfg);
  if (frontHit.flank || frontHit.rear || frontHit.amount !== frontHit.base) fail("facing attack got a bonus: " + JSON.stringify(frontHit));
  void third;

  // --- air strikes -------------------------------------------------------------------------
  const air = measured.airStrike || {};
  if (air.landDamage !== "(strength >> 1) + 1") fail("airStrike.landDamage is not the measured formula");
  if (Number(air.shipDamage["8"]) !== 25 || Number(air.shipDamage["5"]) !== 34) {
    fail("airStrike per-kind ship loss is not 34 for kind 5-7 / 25 for kind 8-9");
  }
  if (cfg.airStrikeLandFactor !== 0.5) {
    fail("airStrikeLandFactor is " + cfg.airStrikeLandFactor + ", not the manual's 0.5 that the runtime carries");
  }

  // --- entrenchment and pinning have no original timer --------------------------------------
  if (cfg.entrenchRounds !== 1) fail("entrenchRounds is " + cfg.entrenchRounds + "; the original flips on the first eligible pass");
  if (!(measured.entrench || {}).hasOwnProperty("timer") || measured.entrench.timer !== null) {
    fail("measured.entrench.timer must be null: the original has no entrench timer");
  }
  if (!(measured.pinning || {}).hasOwnProperty("duration") || measured.pinning.duration !== null) {
    fail("measured.pinning.duration must be null: contact is re-evaluated every pass");
  }
  if (!/STAND-IN/i.test(combatSource("pinRounds"))) fail("pinRounds lost its STAND-IN label");
}
