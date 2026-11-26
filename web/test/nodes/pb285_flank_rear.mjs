// PB-285 pin: flank x1.5 and rear x2, read off the original's own facing compare.
//
// RE (docs/re/COMBAT.md s2.2): the damage byte is the 0x18f0 pairing cell (attacker*9 + target,
// decompiled.c 7044), terrain cover is applied to it first (7048-7062), and then
// FUN_194c_000e @ 194c:000e compares FACING bytes at piece+0x7ce (decompiled.c 7064-7071):
//
//   7064  gate: attacker kind < 7, defender kind < 5, and the defender's own target link
//         (piece+0xbde) is set and is NOT the attacker - i.e. the defender is already
//         fighting a THIRD piece.
//   7066  attacker facing == defender facing           -> local_8 <<= 1     (rear, x2)
//   7069  else if ((attacker facing ^ 1) != defender facing) -> += local_8/2 (flank, x1.5)
//   7071  otherwise (the two face each other)          -> no bonus           (front, x1)
//
// Facing is a two-bit compass byte: FUN_194c_15c6 (decompiled.c 7982-8019) stamps 2/3 for
// north/south and 4/5 for east/west, so XOR 1 is the opposite side (N<->S, E<->W). Nothing in
// the bonus reads distance, adjacency or a cell offset: what makes a rear is the attacker
// carrying the defender's facing; what makes a flank is any facing that is neither the
// defender's nor its opposite; a front is facing each other. The adjacency that starts a fight
// lives in the 0x1956 range matrix, not here.
//
// Manual p.22: "When units engage, they take on a 'facing;' ... If the unit is then attacked
// from the flanks or rear, it takes additional damage." The p.9 walkthrough is the same rule in
// one sentence: an enemy facing north takes extra damage from a flank attack from the west.
//
// What fails if this is removed:
//   - the multipliers go to 1 in config                     -> 30 and 40 come back as 20
//   - the rear branch stops comparing facings               -> rear no longer doubles
//   - the flank branch treats "facing each other" as flank  -> the front arm reads 30
//   - the third-piece gate is dropped                       -> an isolated 1v1 takes a bonus
//   - the city arm stops applying the multiplier after cover-> 19.5/26 come back as 13
//
// City note: the port multiplies the COVERED cell by 1.5 (13 -> 19.5) and the original's
// integer form at 7070 is 13 + (int)13/2 = 19. The city arm pins what the port does today and
// names the difference so a gate reader can rule on it; it is not a claim that 19.5 is the
// original's number.

import { CELL_W, boardPayload } from "../../server/board.mjs";
import { baseDamageFor, damageFor } from "../../server/combat.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb285_flank_rear";

const PLAIN = 8;
const CITY = 6;
const PLAIN_CELL = { x: 78, y: 50 };  // the open cell the 1986 report used (PB-282)
const CITY_CELL = { x: 76, y: 60 };   // Havana, a city
const THIRD = { id: "blue:third", side: "blue" };

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

// One striker, one defender, and a third piece the defender is already engaged with. The
// attacker's cell never enters the damage rule; it is set beside the defender so the layout
// reads like a real three-way fight.
function exchange(cell, attackerFacing, defenderFacing, thirdFighting = THIRD.id) {
  const defender = unit("red:def", "red", "infantry", cell.x, cell.y, {
    facing: defenderFacing,
    fighting: thirdFighting,
  });
  const attacker = unit("blue:atk", "blue", "infantry", cell.x + 1, cell.y, {
    facing: attackerFacing,
  });
  return damageFor(attacker, defender);
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("pb285: the board has no cell array (the pin needs the baked terrain)");
  if (terrainAt(board, PLAIN_CELL.x, PLAIN_CELL.y) !== PLAIN) {
    fail("pb285: " + PLAIN_CELL.x + "," + PLAIN_CELL.y + " is terrain " + terrainAt(board, PLAIN_CELL.x, PLAIN_CELL.y) + ", expected plain " + PLAIN + " - the board bake moved, re-point the pin");
  }
  if (terrainAt(board, CITY_CELL.x, CITY_CELL.y) !== CITY) {
    fail("pb285: " + CITY_CELL.x + "," + CITY_CELL.y + " is terrain " + terrainAt(board, CITY_CELL.x, CITY_CELL.y) + ", expected city " + CITY + " - the board bake moved, re-point the pin");
  }

  // ---- the pairing cell the multipliers act on: infantry -> infantry is 20 ------------------
  const plainBase = baseDamageFor("infantry", unit("red:def", "red", "infantry", PLAIN_CELL.x, PLAIN_CELL.y));
  if (Number(plainBase) !== 20) fail("pb285: infantry->infantry is " + plainBase + ", not the measured 20 (matrix 1->1)");

  // ---- a plain, three pieces: 20 front / 30 flank / 40 rear ---------------------------------
  const front = exchange(PLAIN_CELL, "w", "e"); // facing each other
  if (Number(front.base) !== 20 || Number(front.covered) !== 20) fail("pb285: the plain front cell is base " + front.base + " / covered " + front.covered + ", expected 20 / 20");
  if (Number(front.amount) !== 20) fail("pb285: plain front is " + front.amount + ", expected 20");
  if (front.flank || front.rear) fail("pb285: facing each other took a flank/rear bonus");

  const flank = exchange(PLAIN_CELL, "n", "e"); // attacker perpendicular to the defender
  if (Number(flank.amount) !== 30) fail("pb285: plain flank is " + flank.amount + ", expected 30 (20 x 1.5)");
  if (flank.flank !== true || flank.rear === true) fail("pb285: the plain 30 is not flagged flank (" + JSON.stringify({ flank: flank.flank, rear: flank.rear }) + ")");

  const rear = exchange(PLAIN_CELL, "e", "e"); // attacker carries the defender's facing
  if (Number(rear.amount) !== 40) fail("pb285: plain rear is " + rear.amount + ", expected 40 (20 x 2)");
  if (rear.rear !== true || rear.flank === true) fail("pb285: the plain 40 is not flagged rear (" + JSON.stringify({ flank: rear.flank, rear: rear.rear }) + ")");

  // ---- an isolated 1v1 gets no bonus, even with flanking facings ---------------------------
  const lone = exchange(PLAIN_CELL, "n", "e", null);
  if (Number(lone.amount) !== 20) fail("pb285: a 1v1 with flanking facings read " + lone.amount + ", expected 20 - the defender must already be fighting a third piece");
  if (lone.flank || lone.rear) fail("pb285: a 1v1 took a flank/rear flag");

  // ---- the same three-piece rule on a city: cover first, then the multiplier ---------------
  const cityFront = exchange(CITY_CELL, "w", "e");
  if (Number(cityFront.covered) !== 13 || Number(cityFront.amount) !== 13) {
    fail("pb285: a city front is covered " + cityFront.covered + " / amount " + cityFront.amount + ", expected 13 / 13 (20 - (20+1)/3)");
  }
  const cityFlank = exchange(CITY_CELL, "n", "e");
  if (Number(cityFlank.amount) !== 19.5) {
    fail("pb285: a city flank is " + cityFlank.amount + ", expected 19.5 (13 x 1.5, cover before the multiplier)");
  }
  const cityRear = exchange(CITY_CELL, "e", "e");
  if (Number(cityRear.amount) !== 26) {
    fail("pb285: a city rear is " + cityRear.amount + ", expected 26 (13 x 2)");
  }
  // The original's integer form at 7070 is 13 + (int)13/2 = 19, not 19.5. Kept as a measured
  // difference, not a port claim: the pin above records the port's current arithmetic so a
  // later ruling that adopts the truncation reds this line and updates the number.
  const originalInteger = 13 + Math.floor(13 / 2);
  if (originalInteger !== 19) fail("pb285: the doc's integer flank arithmetic no longer gives 19");

  // ---- config carries the two shipped multipliers (provenance, checked last so a config cut
  //      reds the damage arm above first) ----------------------------------------------------
  const cfg = combatRules();
  if (Number(cfg.flankMultiplier) !== 1.5) fail("pb285: combat.flankMultiplier is " + cfg.flankMultiplier + ", not 1.5");
  if (Number(cfg.rearMultiplier) !== 2) fail("pb285: combat.rearMultiplier is " + cfg.rearMultiplier + ", not 2");
}
