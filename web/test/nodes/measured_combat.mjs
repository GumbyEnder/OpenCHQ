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
  if (cfg.entrenchDamageFactor !== 0.75) {
    fail("entrenchDamageFactor is " + cfg.entrenchDamageFactor + ", not the measured 0.75 (20 -> 15 against infantry)");
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
