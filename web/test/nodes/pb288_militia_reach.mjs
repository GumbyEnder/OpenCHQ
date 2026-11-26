// PB-288 pin: the city militia lands only on an enemy piece standing on the site's own cells.
//
// PM 9779 §4 ruled on the one fidelity difference (i) found by PB-286: the port had a second
// militia arm that paid any attacker which had traded shots with a defender standing on its own
// city, wherever that attacker stood - one cell outside the footprint, or four. The original has no
// such branch: FUN_1c0d_00b4 (decompiled.c 9030-9110) walks the pieces ON the site's cells. The arm
// is removed in web/server/combat.mjs; this pin is the two-sided witness.
//
// What fails if this is removed (i.e. if the old arm comes back):
//   - the OUTSIDE arm draws a militia event and the shooter loses militiaDamage: 100 -> 98
//   - the outside attacker's strength is no longer the exchange alone
// The INSIDE arm is the ruling's positive half and must stay 1 event / 100 - militiaDamage.
//
// Difference (ii) - per-pass in the original vs every shotEveryRounds here - is untouched and
// stays D-017; this pin deliberately says nothing about cadence.

import { resolve } from "../../server/combat.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb288_militia_reach";

// Berlin on the shipped board: anchor (161,30), measured D-026 block 160..162 x 29..31
// (web/data/footprints.json id 11). One cell west of the block is (159,30) - the exact geometry
// the removed arm used to reach.
const CITY = { id: 11, kind: "city", owner: "red", name: "Berlin", x: 161, y: 30 };
const INSIDE = { x: 160, y: 30 };
const OUTSIDE = { x: 159, y: 30 };
const DEFENDER_CELL = { x: 161, y: 30 };

function unit(id, side, kind, x, y, extra = {}) {
  const max = Number(combatRules().maxStrength);
  return {
    id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null,
    fighting: null, shots: 0, strength: max, maxStrength: max, ...extra,
  };
}

function matchOf(pieces) {
  return {
    era: "1942", round: 5, clock: "running", pieces, sites: [{ ...CITY }],
    capitals: {}, sides: { blue: {}, red: {} }, foughtRound: -1, over: false, winner: null,
  };
}

const militiaOf = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.militia === true);
const exchangeOf = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.type === "shot" && e.militia !== true);

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();
  const dmg = Number(cfg.militiaDamage);
  const max = Number(cfg.maxStrength);
  if (!(dmg > 0)) fail("pb288: combat.militiaDamage is " + JSON.stringify(cfg.militiaDamage) + " - no militia to measure");

  // ---- INSIDE: an enemy piece standing on a footprint cell pays the per-pass amount -----------
  {
    const occupier = unit("blue:infantry:1", "blue", "infantry", INSIDE.x, INSIDE.y);
    const match = matchOf([occupier]);
    const events = resolve(match) || [];
    const shots = militiaOf(events);
    if (shots.length !== 1) fail("pb288: an occupier on a footprint cell drew " + shots.length + " militia events, expected 1: " + JSON.stringify(events.map((e) => e.type)));
    const shot = shots[0];
    if (shot.target !== "blue:infantry:1") fail("pb288: the militia shot at " + JSON.stringify(shot.target));
    if (Number(shot.amount) !== dmg) fail("pb288: the militia paid " + JSON.stringify(shot.amount) + ", config says " + dmg);
    if (Number(occupier.strength) !== max - dmg) {
      fail("pb288: the inside occupier is on " + JSON.stringify(occupier.strength) + " after one militia pass, want " + (max - dmg));
    }
    if (match.sites[0].owner !== "red") fail("pb288: an unordered occupier captured the city - the arm measured the wrong thing");
  }

  // ---- OUTSIDE: the same fight, one cell west of the block - no militia ------------------------
  // The red defender stands on its own city's anchor, so the defender is "on its city" by every
  // reading; the blue shooter is adjacent (dist 1, in land engage range) and therefore trades
  // shots. Only the exchange may touch it: the removed arm paid militia here.
  {
    const defender = unit("red:infantry:2", "red", "infantry", DEFENDER_CELL.x, DEFENDER_CELL.y);
    const shooter = unit("blue:infantry:2", "blue", "infantry", OUTSIDE.x, OUTSIDE.y);
    const match = matchOf([shooter, defender]);
    const events = resolve(match) || [];
    const exchange = exchangeOf(events);
    if (exchange.length !== 2) {
      fail("pb288: the outside arm did not produce the exchange it needs to be a witness: " + JSON.stringify(events.map((e) => e.type)) + " - re-point the geometry");
    }
    const shots = militiaOf(events);
    if (shots.length !== 0) {
      fail("pb288: the militia reached an attacker one cell OUTSIDE the footprint: " + JSON.stringify(shots.map((e) => ({ target: e.target, at: e.at, amount: e.amount }))));
    }
    const paid = exchange.reduce((n, e) => n + (e.target === "blue:infantry:2" ? Number(e.amount) || 0 : 0), 0);
    if (Number(shooter.strength) !== max - paid) {
      fail("pb288: the outside shooter is on " + JSON.stringify(shooter.strength) + ", want " + (max - paid) + " (the exchange only, no militia)");
    }
    if (Number(shooter.strength) === max - paid - dmg) fail("pb288: the outside shooter took exactly one militia payment");
  }

  console.log("pb288_militia_reach: a piece on the site's cells pays " + dmg +
    " to the militia and a piece one cell outside the block pays it nothing");
}
