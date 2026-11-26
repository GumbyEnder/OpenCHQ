// PB-286 pin: a city's militia does not care whether a defender is back in the block. It fires
// at every enemy piece standing inside the city, on that piece's own militia beat, and a defender
// arriving or leaving changes neither the beat nor the target.
//
// RE answer (decompiled.c, FUN_1c0d_00b4 @ 1c0d:00b4, lines 9030-9110; militia block 9054-9081,
// damage applied 9083-9107):
//
//   9042  FUN_188b_00a4(piece x, piece y) reads the terrain under the piece.
//   9043  uVar3 = *(byte *)0xc478 is the SITE at that cell; 0xff means no site.
//   9054  bVar1 = piece kind (byte[piece+0x906] & 0xf).
//   9055  local_4 = byte[terrain + 0x1996] (terrain attrition byte).
//   9056  if uVar3 == 0xff there is no site and the damage block below is skipped.
//   9058  if the site carries an owner (byte[site+0x1102] & 0xc0):
//   9060    if the piece's owner bits differ from the site's and the piece is land (kind < 7):
//   9061      local_4 = 0x82 - bit 0x80 means "militia", low five bits = 2 damage;
//   9062-68    a weakened site sets move points 0xfff6 (-10) and FUN_188b_0472 tries the capture.
//   9072-77 else (site unowned): local_4 = byte[0x199a] = 20 per pass until the capture lands.
//   9083-9107 damage is applied to THIS piece: with 0x80 clear the 20 floor, with 0x80 set the
//             low-five-bit amount (2). The routine never reads another piece, never reads a
//             defender, and has no branch for "a defender is present".
//
// So the original's militia is occupancy damage keyed on (this piece's cell, that site's owner).
// A defender returning to the city is not an input at all: the enemy occupier pays on its cadence
// before, during and after the defender's stay. The defender itself, standing on its own city,
// takes 0 (the owner-bits compare at 9060 fails). Manual p.10/p.23 agrees on the effect: "you see
// it take damage even after the enemy unit is destroyed ... enemy cities have a small militia
// which defends them from conquest."
//
// What fails if this is removed:
//   - the occupancy arm goes back to riding exchanges        -> the round-13/19 silence and the
//                                                              r14 return would read no militia
//   - the beat is reset when a defender arrives              -> r14 fires early or late
//   - the defender is treated as a militia target            -> red:inf:1 takes a militia event
//   - the per-piece guard is dropped                         -> two militia events on one piece
//
// Caveat carried for the ruling: the port ALSO fires at an attacker one cell outside the city
// when it traded with the defender on that city (combat.mjs's defence arm). FUN_1c0d_00b4 has no
// such branch - its damage lands on a piece standing on the site. This node pins the occupancy
// question the card asks; the defence arm is not claimed against these lines.

import { resolve } from "../../server/combat.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb286_militia_defender";

// Berlin on the shipped 1986 board: site 11, anchor (161,30), D-026 footprint cell (160,29).
const BERLIN = { id: 11, kind: "city", owner: "red", name: "Berlin", x: 161, y: 30 };
const FOOTPRINT = { x: 160, y: 29 };
const ANCHOR = { x: 161, y: 30 };

function unit(id, side, kind, x, y, extra = {}) {
  const max = combatRules().maxStrength;
  return {
    id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null,
    fighting: null, shots: 0, strength: max, maxStrength: max, ...extra,
  };
}

function matchOf(pieces, extra = {}) {
  return {
    era: "1986", round: 1, clock: "running", pieces, sites: [{ ...BERLIN }], capitals: {},
    sides: { blue: {}, red: {} }, foughtRound: -1, over: false, winner: null, ...extra,
  };
}

const militiaShots = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.militia === true);

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();
  const dmg = Number(cfg.militiaDamage);
  const every = Number(cfg.shotEveryRounds);
  if (dmg <= 0) fail("pb286: militiaDamage is " + cfg.militiaDamage + "; the pin needs a live militia");

  // --- 1. the beat is unbroken across a defender's return -----------------------------------
  // r12-r13: the enemy tank is alone in Berlin. r14: red puts a defender back into the city.
  // r18: the defender leaves again (removed from the board, the same state as a unit that moved
  // out). The occupancy beat must read 12, 14, 16, 18 - not restart at 14, not stop at 18.
  {
    const tank = unit("blue:tank:286", "blue", "tank", FOOTPRINT.x, FOOTPRINT.y);
    const match = matchOf([tank], { round: 12 });
    const rounds = [];
    const defenderMilitia = [];
    for (let round = 12; round <= 19; round++) {
      match.round = round;
      if (round === 14) match.pieces.push(unit("red:inf:286", "red", "infantry", ANCHOR.x, ANCHOR.y));
      if (round === 18) match.pieces = match.pieces.filter((p) => p.id !== "red:inf:286");
      const events = resolve(match) || [];
      const shots = militiaShots(events);
      for (const shot of shots) {
        if (shot.target === "red:inf:286") defenderMilitia.push({ round, shot });
        if (shot.target === "blue:tank:286") rounds.push(round);
      }
    }
    const want = [12];
    for (let round = 12 + every; round <= 19; round += every) want.push(round);
    if (rounds.join(",") !== want.join(",")) {
      fail("pb286: the occupier's militia beat over r12-r19 read " + rounds.join(",") + ", not " + want.join(",")
        + " - a defender's return reset it");
    }
    if (defenderMilitia.length !== 0) {
      fail("pb286: the defender on its own city took " + defenderMilitia.length + " militia event(s): "
        + JSON.stringify(defenderMilitia.map((x) => ({ round: x.round, target: x.shot.target }))));
    }
    // The defender's return is the round the card is about: it must be a full beat, not a token.
    const at14 = rounds.includes(14);
    if (!at14) fail("pb286: r14 - the round the defender returned - had no militia on the occupier");
    if (!rounds.includes(16)) fail("pb286: a defender in the block silenced the militia at r16");
    if (!rounds.includes(18)) fail("pb286: the militia stopped firing after the defender left again at r18");
  }

  // --- 2. a defender present from the start does not double the hit ---------------------------
  // Defender and occupier in the same city block exchange shots, so the militia has both the
  // defence arm and the occupancy arm available. The `paid` guard must still pay the occupier
  // once that round: two militia events on one piece would double the city's output.
  {
    const tank = unit("blue:tank:287", "blue", "tank", FOOTPRINT.x, FOOTPRINT.y);
    const defender = unit("red:inf:287", "red", "infantry", ANCHOR.x, ANCHOR.y);
    const match = matchOf([tank, defender], { round: 5 });
    const events = resolve(match) || [];
    const shots = militiaShots(events);
    const onTank = shots.filter((e) => e.target === "blue:tank:287");
    const onDefender = shots.filter((e) => e.target === "red:inf:287");
    if (onTank.length !== 1) fail("pb286: with a defender back in the block the occupier drew " + onTank.length + " militia events, expected exactly 1");
    if (onDefender.length !== 0) fail("pb286: the defending infantry took " + onDefender.length + " militia event(s) while on its own city");
    if (Number(onTank[0].amount) !== dmg) fail("pb286: the militia amount is " + onTank[0].amount + ", not " + dmg);
  }
}
