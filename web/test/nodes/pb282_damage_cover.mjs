// PB-282 pin: the two per-hit numbers a live 1986 fight showed for infantry against infantry -
// 20 and 13 - both come out of the original's own rule, and the difference is the DEFENDER's cell.
//
// The RE answer (docs/re/COMBAT.md s2): the damage byte is the 0x18f0 pairing matrix cell
// (attacker kind x target kind), and FUN_194c_000e @ 194c:000e (decompiled.c 7043-7062) then
// subtracts a terrain-cover share from the defender's terrain byte:
//   mountain (10): infantry kinds 1/3 lose a quarter, tanks a sixth;
//   capital / base / city (4/5/6): infantry kinds 1/3 lose (cell+1)/3, tanks a fifth.
// Integer arithmetic, so the 20-cell is 15 on a mountain and 13 in a city. Nothing else in the
// sampled function reads era, strength or a veteran flag: those are not inputs to the cell.
//
// What fails if this is removed:
//   - coverFor() stops reading the defender's cell            -> 13 comes back as 20 everywhere
//   - the city branch drifts from (cell+1)/3                  -> 13 and 14 both move
//   - the matrix cell is re-guessed per attacker              -> base 1->1 is no longer 20
//   - a strength term creeps into the damage                  -> the same fight changes as HP drops
//
// The two cells are the ones the report named: the Havana approach (78,50, plain -> 20) and a
// city/capital cell at the front (Havana 76,60 -> 13, Washington 79,44 -> 13). The board bake is
// asserted before the damage, so a re-bake moves this leg honestly instead of silently passing.

import { CELL_W, boardPayload } from "../../server/board.mjs";
import { baseDamageFor, damageFor } from "../../server/combat.mjs";

export const name = "pb282_damage_cover";

const PLAIN = 8;
const CITY = 6;
const CAPITAL = 4;
const MOUNTAIN = 10;

function unit(id, side, kind, x, y, extra = {}) {
  return {
    id,
    side,
    domain: "land",
    kind,
    x,
    y,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
    strength: 100,
    ...extra,
  };
}

function terrainAt(board, x, y) {
  return board.cells[y * CELL_W + x];
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("pb282: the board has no cell array (the pin needs the baked terrain)");

  // ---- the cells the report named, and the terrain they carry --------------------------------
  const cells = {
    approach: { x: 78, y: 50 }, // the Havana approach: open ground
    havana: { x: 76, y: 60 },   // Havana itself, a city
    washington: { x: 79, y: 44 }, // the Washington front, a capital
    ridge: { x: 78, y: 46 },    // a mountain cell next to the approach
  };
  const wanted = { approach: PLAIN, havana: CITY, washington: CAPITAL, ridge: MOUNTAIN };
  for (const [key, cell] of Object.entries(cells)) {
    const got = terrainAt(board, cell.x, cell.y);
    if (got !== wanted[key]) {
      fail("pb282: " + key + " " + cell.x + "," + cell.y + " is terrain " + got + ", expected " + wanted[key] + " - the board bake moved, re-point the pin");
    }
  }

  // ---- the matrix cell: infantry -> infantry is 20, and it is a pairing, not a strength ------
  const plainDefender = unit("red:inf", "red", "infantry", cells.approach.x, cells.approach.y);
  const base = baseDamageFor("infantry", plainDefender);
  if (Number(base) !== 20) fail("pb282: infantry->infantry is " + base + ", not the measured 20 (matrix 1->1)");

  // ---- 20 on the plain, 13 in the city, 13 in the capital, 15 on the ridge -------------------
  const attacker = unit("blue:inf", "blue", "infantry", cells.approach.x - 1, cells.approach.y);
  const cases = [
    ["approach (plain)", cells.approach, 20],
    ["Havana (city)", cells.havana, 13],
    ["Washington (capital)", cells.washington, 13],
    ["ridge (mountain)", cells.ridge, 15],
  ];
  for (const [label, cell, expected] of cases) {
    const defender = unit("red:inf", "red", "infantry", cell.x, cell.y);
    const shot = damageFor(attacker, defender);
    if (Number(shot.base) !== 20) fail("pb282: " + label + " base is " + shot.base + ", not 20");
    if (Number(shot.amount) !== expected) {
      fail("pb282: " + label + " takes " + shot.amount + " per hit, expected " + expected + " (base " + shot.base + ", covered " + shot.covered + ")");
    }
  }

  // The 13 is the doc's arithmetic, not a number copied into the port: 20 - (20+1)/3 = 13.
  const documented = 20 - Math.floor((20 + 1) / 3);
  if (documented !== 13) fail("pb282: the doc's own integer arithmetic no longer gives 13");
  const cityShot = damageFor(attacker, unit("red:inf", "red", "infantry", cells.havana.x, cells.havana.y));
  if (Number(cityShot.amount) !== documented) fail("pb282: the city hit is " + cityShot.amount + ", the documented formula gives " + documented);

  // ---- a tank defender is a fifth, not a third: 20 -> 16 in the city -------------------------
  const tankInCity = damageFor(
    unit("blue:tank", "blue", "tank", cells.havana.x - 1, cells.havana.y),
    unit("red:tank", "red", "tank", cells.havana.x, cells.havana.y)
  );
  if (Number(tankInCity.base) !== 20 || Number(tankInCity.amount) !== 16) {
    fail("pb282: tank->tank in a city is base " + tankInCity.base + " / hit " + tankInCity.amount + ", expected 20 / 16");
  }

  // ---- entrenchment is the kind-3 column, not a multiplier beside the cover ------------------
  const dugIn = damageFor(
    unit("blue:inf", "blue", "infantry", cells.approach.x - 1, cells.approach.y),
    unit("red:dug", "red", "infantry", cells.approach.x, cells.approach.y, { entrenched: true })
  );
  if (Number(dugIn.base) !== 15) fail("pb282: an entrenched infantry defender is base " + dugIn.base + ", not the kind-3 cell 15");

  // ---- strength is not an input: the same pairing at 40 hp takes the same 20 ----------------
  const weakAttacker = unit("blue:inf", "blue", "infantry", cells.approach.x - 1, cells.approach.y, { strength: 40 });
  const weakDefender = unit("red:inf", "red", "infantry", cells.approach.x, cells.approach.y, { strength: 40 });
  const weakShot = damageFor(weakAttacker, weakDefender);
  if (Number(weakShot.amount) !== 20) fail("pb282: a 40-hp infantry->infantry hit is " + weakShot.amount + ", expected the same 20 as at full strength");

  // ---- a 1v1 with matched facings takes no flank/rear bonus: the reported 20 is the plain cell
  const facing = damageFor(
    unit("blue:inf", "blue", "infantry", 50, 60, { facing: "e" }),
    unit("red:inf", "red", "infantry", 51, 60, { facing: "w", fighting: null })
  );
  if (facing.flank || facing.rear) fail("pb282: a 1v1 facing each other took a flank/rear bonus");
  if (Number(facing.amount) !== Number(20)) fail("pb282: a 1v1 attack on plain is " + facing.amount + ", not 20");
}
