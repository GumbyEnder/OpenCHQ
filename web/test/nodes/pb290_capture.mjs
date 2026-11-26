// PB-290 pin: three capture rules at the server, each arm citing its manual line.
//
// (a) manual_pages.txt l.709 — an oil field joins the side whose LAND unit occupies it and stays
//     with that side after the unit leaves, until an enemy unit occupies it.
// (b) l.248-249 — capturing a city destroys the enemy air unit based there.
// (c) l.190 — a unit in a friendly city, base or oil field regains part of its strength each round
//     until full. This pins the SHAPE ("rises each round, caps at full"). The per-round AMOUNT is
//     UNVERIFIED: config combat.repairPerRound is a STAND-IN and the measured row is per PASS
//     (+10 every other pass, measured.combat.repairPerPass), so nothing here asserts 5.
//
// The three producers are economy.occupy (a and b) and move.repairStep (c) - the same functions
// tick.mjs runs in one round (:176 resolve, tickEntrench, repairStep, occupy, tickAir, upkeep, pay).
// Nothing in this module writes to the product: every arm reads what the server does today.
//
// What each arm would read if its rule were removed (the mutant each arm needs):
//   (a) a field that re-opens when its occupier walks off  -> the "stays" arm reads a null owner
//   (b) the air-strip block in occupy() deleted            -> the plane survives and no event fires
//   (c) the cap dropped (before + rate)                    -> a 98-strength unit reads 100 -> 103
//   (c, deviation) the site-kind list names `oilfield`      -> a unit on a type-5 FACILITY does not
//       repair, while world.json's draw-only wells (PB-153: no rule may see them) do. That is the
//       red arm on this literal; it is reported, not fixed, pending the ruling.
import { warMatch } from "../wartime.mjs";
import { matchSites } from "../../server/board.mjs";
import { occupy, seedOwners } from "../../server/economy.mjs";
import { repair, repairStep } from "../../server/move.mjs";
import { isOilField, siteTypeOf } from "../../server/sitetype.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb290_capture";

function unit(id, side, kind, x, y, extra = {}) {
  const max = combatRules().maxStrength;
  return {
    id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null,
    fighting: null, shots: 0, strength: max, maxStrength: max, ...extra,
  };
}

function opening(era = "1986") {
  const match = warMatch(era, matchSites(era));
  seedOwners(match);
  match.pieces = [];
  match.round = 10;
  return match;
}

const ownerOf = (match, id) => (match.sites.find((site) => site && site.id === id) || {}).owner;
const captures = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.type === "capture");

export async function run(ctx) {
  const { fail } = ctx;

  // ---- (a) manual_pages.txt l.709: the oil field joins its occupier and keeps that side ---------
  {
    const match = opening();
    const field = match.sites.find((site) => isOilField(site) && site.owner === "blue");
    if (!field) fail("pb290 (a): the 1986 board must open with a blue type-5 oil field");
    if (siteTypeOf(field) !== 5) fail("pb290 (a): the field " + field.id + " is type " + siteTypeOf(field) + ", not 5");

    // The occupier takes it.
    match.pieces = [unit("red:inf:290", "red", "infantry", field.x, field.y)];
    const took = captures(occupy(match));
    const take = took.find((e) => e.site === field.id);
    if (!take) fail("pb290 (a) l.709: a red infantry ON blue's oil field " + field.id + " did not take it");
    if (take.side !== "red" || take.from !== "blue" || ownerOf(match, field.id) !== "red") {
      fail("pb290 (a) l.709: the field went " + JSON.stringify({ side: take.side, from: take.from, owner: ownerOf(match, field.id) })
        + ", expected red from blue");
    }

    // It stays with that side after the unit leaves - two rounds of nobody on it.
    match.pieces = [];
    for (const round of [11, 12]) {
      match.round = round;
      const idle = occupy(match);
      if (ownerOf(match, field.id) !== "red") {
        fail("pb290 (a) l.709: the field left red on round " + round + " with no unit on it (owner "
          + ownerOf(match, field.id) + ", events " + JSON.stringify(idle.map((e) => e.type)) + ")");
      }
      if (captures(idle).length !== 0) fail("pb290 (a) l.709: an empty field fired a capture on round " + round);
    }

    // A land unit on an ADJACENT cell still takes nothing: the rule names the unit that OCCUPIES it.
    match.pieces = [unit("red:beside", "red", "infantry", field.x + 1, field.y)];
    const beside = occupy(match);
    if (ownerOf(match, field.id) !== "red" || captures(beside).length !== 0) {
      fail("pb290 (a) l.709: a unit one cell off the field changed it (owner " + ownerOf(match, field.id)
        + ", events " + JSON.stringify(beside.map((e) => e.type)) + ") - the rule names the occupier");
    }

    // Until an ENEMY unit occupies it.
    match.pieces = [unit("blue:inf:290", "blue", "infantry", field.x, field.y)];
    const back = captures(occupy(match));
    const again = back.find((e) => e.site === field.id);
    if (!again || again.side !== "blue" || ownerOf(match, field.id) !== "blue") {
      fail("pb290 (a) l.709: a blue infantry back on red's field did not retake it (owner " + ownerOf(match, field.id) + ")");
    }
    console.log("pb290 arm (a) ok at l.709: field " + field.id + " blue->red on occupation, red through two empty rounds, blue on retake");
  }

  // ---- (b) manual_pages.txt l.248-249: capturing a city destroys the enemy air unit based there --
  {
    const match = opening();
    const city = match.sites.find((site) => site.kind === "city" && site.owner === "red");
    const other = match.sites.find((site) => site.kind === "city" && site.owner === "red" && site.id !== city.id);
    if (!city || !other) fail("pb290 (b): the 1986 board must open with two red cities");
    match.pieces = [
      unit("blue:inf:290", "blue", "infantry", city.x, city.y),
      unit("red:plane:here", "red", "aircraft", city.x, city.y, { domain: "air" }),
      unit("red:plane:elsewhere", "red", "aircraft", other.x, other.y, { domain: "air" }),
      unit("blue:plane:mine", "blue", "aircraft", other.x, other.y, { domain: "air" }),
    ];
    const events = occupy(match);
    const dead = events.filter((e) => e && e.type === "destroyed" && e.pieceId === "red:plane:here");
    if (dead.length !== 1) {
      fail("pb290 (b) l.248-249: taking red city " + city.id + " did not destroy the red aircraft based on it "
        + "(events " + JSON.stringify(events.map((e) => e.type + ":" + (e.pieceId || e.site))) + ")");
    }
    if (dead[0].cause !== "capture") fail("pb290 (b) l.248-249: the destroy event's cause is " + dead[0].cause + ", not capture");
    if (match.pieces.some((piece) => piece.id === "red:plane:here")) {
      fail("pb290 (b) l.248-249: the destroyed aircraft is still in match.pieces");
    }
    // The two planes the capture cannot reach: the enemy one based elsewhere, and the capturer's own.
    for (const id of ["red:plane:elsewhere", "blue:plane:mine"]) {
      if (!match.pieces.some((piece) => piece.id === id)) {
        fail("pb290 (b) l.248-249: " + id + " was destroyed by the capture of a city it is not based on");
      }
    }
    console.log("pb290 arm (b) ok at l.248-249: capturing city " + city.id + " destroyed red:plane:here only");
  }

  // ---- (c) manual_pages.txt l.190: regains part of its strength each round until full ----------
  const combat = combatRules();
  const max = Number(combat.maxStrength);
  const rate = Number(combat.repairPerRound);
  {
    const match = opening();
    const blueCities = match.sites.filter((site) => site.kind === "city" && site.owner === "blue");
    if (blueCities.length < 2) fail("pb290 (c): the 1986 board must open with two blue cities");
    const [city, cityB] = blueCities;
    const enemyCity = match.sites.find((site) => site.kind === "city" && site.owner === "red");
    const damaged = unit("blue:inf:city", "blue", "infantry", city.x, city.y, { strength: 60 });
    const atEnemy = unit("blue:inf:enemy", "blue", "infantry", enemyCity.x, enemyCity.y, { strength: 60 });
    const nearFull = unit("blue:inf:cap", "blue", "tank", cityB.x, cityB.y, { strength: max - 1 });
    match.pieces = [damaged, atEnemy, nearFull];

    // Rises each round, on a friendly city.
    const r10 = repairStep(match);
    const first = damaged.strength;
    match.round = 11;
    const r11 = repairStep(match);
    const second = damaged.strength;
    if (!(second > first && first > 60)) {
      fail("pb290 (c) l.190: a damaged unit on its own city read " + 60 + " -> " + first + " -> " + second
        + " over two rounds; expected a rise each round");
    }
    if (first - 60 !== second - first) {
      fail("pb290 (c) l.190: the city's per-round rise was " + (first - 60) + " then " + (second - first) + " - not a steady part each round");
    }

    // Caps at full: one short of full goes to full and no further.
    if (nearFull.strength !== max) {
      fail("pb290 (c) l.190: a unit one point short of full read " + nearFull.strength + " on its own city, expected the cap " + max);
    }
    match.round = 12;
    const over = repairStep(match);
    if (nearFull.strength !== max) fail("pb290 (c) l.190: a full-strength unit rose to " + nearFull.strength + ", above the cap " + max);
    if (over.some((e) => e && e.pieceId === "blue:inf:cap")) fail("pb290 (c) l.190: a full-strength unit still fired a repair event");

    // Friendly only: the same damaged unit on an ENEMY city does not rise.
    if (atEnemy.strength !== 60) fail("pb290 (c) l.190: a unit on an ENEMY city repaired to " + atEnemy.strength);

    // A base is part of the manual's list, but no era's data carries a `base` site (1918/1942/1986/
    // 2023 all report 0), so that third of the sentence is UNPROBEABLE here, not passed.
    const bases = match.sites.filter((site) => site && site.kind === "base").length;
    console.log("pb290 arm (c): city rises " + (first - 60) + "/round and caps at " + max + "; `base` sites on the 1986 board: " + bases + " (unprobeable)");

    // The oil field third of l.190. The type-5 field is the original's oil field (PB-153); the
    // world.json `oilfield` kind is a draw-only sketch no rule may see.
    const field = match.sites.find((site) => isOilField(site) && site.owner === "blue");
    const onField = unit("blue:inf:oil", "blue", "infantry", field.x, field.y, { strength: 60 });
    match.pieces = [onField];
    match.round = 13;
    const oilEvents = repairStep(match);
    const order = repair(match, "blue", "blue:inf:oil");
    if (onField.strength === 60 || oilEvents.length === 0) {
      fail("pb290 (c) l.190 DEVIATION: a unit on its own oil field " + field.id + " (type 5, kind " + field.kind
        + ") did not regain strength (strength " + onField.strength + " from 60, events "
        + JSON.stringify(oilEvents.map((e) => e.type)) + "; the repair ORDER answers "
        + JSON.stringify(order.error || order.state) + "). Producer: web/server/move.mjs:862 repairStep kinds list, "
        + "and web/server/move.mjs:788 repair()'s allowed list - both name `oilfield`, the draw-only well kind "
        + "(PB-153), and never the type-5 `facility` the board serves");
    }
  }
}
