// PB-195 node test — land units overlap to fight.
//
// What fails if this node is removed: the port goes back to firing two cells apart while the walker
// stops one short, which is what killed blue:infantry:5 at 78,44 without ever entering red's cell
// (live r287-318). Manual p.9: land units "must overlap to fight", and attacking means "move your
// unit so the two icons overlap".
//
// AC1: two infantry two cells apart take no damage.
// AC2: an attacker ordered onto a defender's cell overlaps it, and the two fight.
//
// Ships are NOT in scope: a hull keeps its kind's range (Manual p.24), and the land contact scan
// still governs land fire on a hull. config.combat.landOverlapOnly is what turns the rule on.

import { candidatesFor, distance, resolve } from "../../server/combat.mjs";
import { advance, issueOrder } from "../../server/move.mjs";
import { openMatch } from "../../server/match.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb195_land_overlap";

const shotsOf = (events) => events.filter((event) => event.type === "shot");

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();
  if (cfg.landOverlapOnly !== true) {
    fail("config.combat.landOverlapOnly is not on: the product config must carry Manual p.9's overlap rule");
  }

  // 165,8 is the plain cell orders.mjs already uses; 165,10 is two cells south of it.
  const match = openMatch("1986");
  const attacker = match.pieces.find((piece) => piece.id === "blue:land");
  const defender = match.pieces.find((piece) => piece.id === "red:land");
  if (!attacker || !defender) fail("the 1986 roster no longer carries blue:land and red:land");
  attacker.x = 165;
  attacker.y = 8;
  attacker.path = [];
  attacker.credit = 0;
  attacker.pace = 1;
  defender.x = 165;
  defender.y = 10;
  defender.path = [];
  match.pieces = [attacker, defender];
  match.round = 1;

  // --- AC1: two cells apart, no damage and no contact recorded ---------------------------
  if (distance(attacker, defender) !== 2) fail("the probe pair is not two cells apart: " + distance(attacker, defender));
  const contact = candidatesFor(attacker, [attacker, defender]);
  if (contact.length !== 0) fail("an infantry two cells away is still a combat candidate: " + JSON.stringify(contact.map((p) => p.id)));
  const quiet = resolve(match);
  if (shotsOf(quiet).length !== 0) fail("two infantry two cells apart fired: " + JSON.stringify(quiet));
  if (attacker.fighting !== null && attacker.fighting !== undefined) fail("a two-cell pair recorded a fight: " + attacker.fighting);
  if (Number(attacker.strength) !== cfg.maxStrength) fail("the attacker lost strength two cells away: " + attacker.strength);

  // --- AC2: ordered onto the defender's cell, the walker overlaps and the pair fights -----
  const order = issueOrder(match, "blue", attacker.id, defender.x, defender.y);
  if (order.error) fail("the attack order onto the enemy cell was refused: " + order.error);
  let held = null;
  for (let round = 0; round < 4 && distance(attacker, defender) !== 0; round++) {
    for (const event of advance(match)) {
      if (event.pieceId === attacker.id && event.type === "blocked") held = event;
    }
  }
  if (held) fail("the walker was held outside the enemy cell instead of pressing in: " + JSON.stringify(held));
  if (distance(attacker, defender) !== 0) {
    fail("the attacker did not overlap the defender: " + attacker.x + "," + attacker.y + " vs " + defender.x + "," + defender.y);
  }
  if (attacker.path.length !== 0) fail("the order did not finish on the enemy's cell: " + JSON.stringify(attacker.path));

  match.round = 8;
  const fight = resolve(match);
  const shots = shotsOf(fight);
  if (shots.length !== 2) fail("two overlapping land units did not trade a shot each: " + JSON.stringify(fight));
  const atBlue = shots.find((event) => event.target === attacker.id);
  const atRed = shots.find((event) => event.target === defender.id);
  if (!atBlue || !atRed) fail("one side of the overlap did not fire: " + JSON.stringify(shots));
  if (!(atBlue.amount > 0) || !(atRed.amount > 0)) fail("an overlapping exchange carried no damage: " + JSON.stringify(shots));

  console.log("pb195_land_overlap: two cells apart no contact, no damage; an ordered attacker walked in (overlap) and both fired " +
    atBlue.amount + "/" + atRed.amount);
}
