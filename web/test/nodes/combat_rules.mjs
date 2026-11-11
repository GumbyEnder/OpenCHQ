// Node test for `combat_rules` (T-003). Owner: A4.
//
// One assertion group per acceptance criterion in Dev Tasks/T-003. Every number the test compares
// is read back out of config.combat, never typed twice: a tunable change is a test that follows
// the file, and a missing source is a failure, not a silent default.

import { applyDamage, damageFor, distance, ensureStrength, resolve, tickEntrench } from "../../server/combat.mjs";
import { advance, attritionStep, entrench, issueOrder, repairStep } from "../../server/move.mjs";
import { paradrop, sendMission } from "../../server/air.mjs";
import { combatKeys, combatRules, combatSource, combatValue, rules } from "../../server/rules.mjs";
import * as rulesModule from "../../server/rules.mjs";

export const name = "combat_rules";

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
    ...extra,
  };
}

function ship(id, side, kind, x, y, extra = {}) {
  return unit(id, side, kind, x, y, { domain: "sea", ...extra });
}

function matchOf(pieces, extra = {}) {
  return {
    era: "1986",
    round: 1,
    clock: "running",
    pieces,
    sites: [],
    capitals: {},
    sides: { blue: {}, red: {} },
    foughtRound: -1,
    over: false,
    winner: null,
    ...extra,
  };
}

const near = (a, b, epsilon = 1e-9) => Math.abs(Number(a) - Number(b)) <= epsilon;
const shotsOf = (events) => events.filter((event) => event.type === "shot" && event.militia !== true);

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();

  // --- AC1: every key in config.combat has a source, and HITS is gone ---------------------
  const keys = combatKeys();
  if (!keys.length) fail("config.combat is empty");
  for (const key of keys) {
    const source = combatSource(key).trim();
    if (!source) fail("config.combat." + key + " has no source");
    const value = combatValue(key, undefined);
    if (value === undefined) fail("config.combat." + key + " has no value");
  }
  if (Object.hasOwn(rules(), "hits")) fail("config still carries the archive's hits=6");
  if (Object.hasOwn(rules(), "overrun")) fail("config still carries the count-based overrun flag");
  if (typeof rulesModule.hitsToKill === "function") fail("rules.mjs still exports hitsToKill");
  if (typeof rulesModule.overrunEnabled === "function") fail("rules.mjs still exports overrunEnabled");
  if (Object.hasOwn(cfg, "hits")) fail("combatRules() invented a hits key");
  for (const key of ["maxStrength", "shotEveryRounds", "baseDamage", "flankMultiplier", "entrenchDamageFactor", "attritionFloor", "repairPerRound", "paradropLoss"]) {
    if (!Object.hasOwn(cfg, key)) fail("combatRules() lost " + key);
  }

  // --- AC2: alternation -------------------------------------------------------------------
  {
    const match = matchOf([unit("blue:a", "blue", "infantry", 40, 40), unit("red:d", "red", "infantry", 41, 40)]);
    const firedOn = [];
    for (let round = 1; round <= 6; round++) {
      match.round = round;
      const shots = shotsOf(resolve(match));
      if (shots.length) {
        firedOn.push(round);
        if (shots.length !== 2) fail("round " + round + " fired " + shots.length + " times for one 1v1");
      }
    }
    if (JSON.stringify(firedOn) !== JSON.stringify([1, 3, 5])) {
      fail("shots did not land on r, r+2, r+4: " + JSON.stringify(firedOn));
    }
    if (match.foughtRound !== 5) fail("foughtRound is not the last round a shot landed: " + match.foughtRound);
    if (distance(match.pieces[0], match.pieces[1]) !== 1) fail("the fight moved a piece");
  }

  // --- AC3: a second attacker deals damage and takes none ---------------------------------
  {
    const alone = matchOf([unit("blue:a", "blue", "infantry", 40, 40), unit("red:d", "red", "infantry", 41, 40)]);
    const pair = matchOf([
      unit("blue:a", "blue", "infantry", 40, 40),
      unit("blue:b", "blue", "infantry", 40, 41),
      unit("red:d", "red", "infantry", 41, 40),
    ]);
    for (let round = 1; round <= 4; round++) {
      alone.round = round;
      pair.round = round;
      resolve(alone);
      resolve(pair);
    }
    const dAlone = alone.pieces.find((p) => p.id === "red:d").strength;
    const dPair = pair.pieces.find((p) => p.id === "red:d").strength;
    const b = pair.pieces.find((p) => p.id === "blue:b");
    if (!b) fail("the second attacker was removed from the fight");
    if (!near(b.strength, cfg.maxStrength)) fail("the second attacker took damage: " + b.strength);
    if (!(dPair < dAlone)) fail("a second attacker did not speed the kill: " + dPair + " vs " + dAlone);
  }

  // --- AC4: retarget when a closer enemy arrives ------------------------------------------
  {
    const d = unit("red:d", "red", "infantry", 50, 50);
    const far = unit("blue:a", "blue", "infantry", 52, 50);
    const match = matchOf([d, far]);
    resolve(match);
    if (d.fighting !== "blue:a") fail("the piece did not engage the only enemy in reach: " + d.fighting);
    const close = unit("blue:b", "blue", "infantry", 51, 50);
    match.pieces.push(close);
    match.round = 3;
    resolve(match);
    if (d.fighting !== "blue:b") fail("a closer enemy did not become the target: " + d.fighting);
  }

  // --- AC5: flank hits harder --------------------------------------------------------------
  {
    const d = unit("red:d", "red", "infantry", 60, 60, { facing: "e" });
    const front = unit("blue:a", "blue", "infantry", 61, 60);
    const side = unit("blue:b", "blue", "infantry", 60, 61);
    const match = matchOf([d, front, side]);
    const events = shotsOf(resolve(match));
    const fromFront = events.find((event) => event.pieceId === "blue:a");
    const fromSide = events.find((event) => event.pieceId === "blue:b");
    if (!fromFront || !fromSide) fail("both attackers did not fire: " + JSON.stringify(events));
    if (fromFront.flank) fail("a hit on the facing side counted as a flank");
    if (!fromSide.flank) fail("a hit on the side did not count as a flank");
    if (!near(fromSide.amount, fromFront.amount * cfg.flankMultiplier)) {
      fail("flank damage is not flankMultiplier x base: " + fromSide.amount + " vs " + fromFront.amount);
    }
    if (!near(damageFor(side, d).amount, cfg.baseDamage.infantry * cfg.flankMultiplier)) {
      fail("damageFor disagrees with the shot event");
    }
  }

  // --- AC6: a ship is never pinned and never flanked --------------------------------------
  {
    const d = ship("red:s", "red", "cruiser", 10, 10, { facing: "e" });
    const enemy = ship("blue:s", "blue", "cruiser", 10, 11);
    const match = matchOf([d, enemy]);
    const flanked = damageFor(enemy, d);
    if (flanked.amount !== flanked.base) fail("a sea hit was multiplied by the flank factor: " + flanked.amount);
    for (let round = 1; round <= 3; round++) {
      match.round = round;
      resolve(match);
      if (d.pinned === true) fail("a ship was pinned in round " + round);
      if (enemy.pinned === true) fail("a ship was pinned in round " + round);
    }
    // A land piece in the same fight does pin, which is what makes the exclusion mean something.
    const foot = unit("red:f", "red", "infantry", 30, 30);
    const attacker = unit("blue:f", "blue", "infantry", 31, 30);
    const landMatch = matchOf([foot, attacker]);
    for (let round = 1; round <= Math.max(1, cfg.pinRounds); round++) {
      landMatch.round = round;
      resolve(landMatch);
    }
    if (cfg.pinRounds > 0 && foot.pinned !== true) fail("a land piece in a long fight was never pinned");
  }

  // --- AC7: entrenchment ------------------------------------------------------------------
  {
    const foot = unit("blue:f", "blue", "infantry", 80, 40);
    const match = matchOf([foot]);
    for (let round = 1; round <= cfg.entrenchRounds; round++) {
      match.round = round;
      tickEntrench(match);
    }
    if (foot.entrenched !== true) fail("an idle infantry never entrenched");

    // Incoming damage is multiplied by the factor; being attacked does not clear the state.
    const attacker = unit("red:a", "red", "infantry", 81, 40);
    match.pieces.push(attacker);
    match.round = match.round + 2;
    const events = shotsOf(resolve(match));
    const hit = events.find((event) => event.pieceId === "red:a");
    if (!hit) fail("the entrenched infantry was not attacked");
    if (!near(hit.amount, cfg.baseDamage.infantry * cfg.entrenchDamageFactor)) {
      fail("entrenched damage is not entrenchDamageFactor x base: " + hit.amount);
    }
    if (foot.entrenched !== true) fail("being attacked cleared the entrenchment");

    // A move order clears it.
    match.pieces.pop();
    const order = issueOrder(match, "blue", "blue:f", 85, 40);
    if (order.error) fail("the entrenched piece refused a move order: " + order.error);
    if (foot.entrenched !== false) fail("a move order left the piece dug in");
  }

  // --- AC8: repair ------------------------------------------------------------------------
  {
    const city = { id: 10, name: "Home", x: 80, y: 40, kind: "city", owner: "blue" };
    const dock = { id: 11, name: "Port", x: 5, y: 5, kind: "docks", owner: "blue" };
    const hurt = unit("blue:f", "blue", "infantry", 80, 40, { strength: cfg.maxStrength - 40 });
    const hull = ship("blue:s", "blue", "cruiser", 5, 5, { strength: cfg.maxStrength - 40 });
    const match = matchOf([hurt, hull], { sites: [city, dock], round: 3 });
    repairStep(match);
    if (!near(hurt.strength, cfg.maxStrength - 40 + cfg.repairPerRound)) {
      fail("a city did not repair at repairPerRound: " + hurt.strength);
    }
    if (hurt.repairing !== true) fail("a repaired piece does not say repairing");
    // A ship on a city cell does not repair; on a dock it does.
    const beached = ship("red:s", "red", "cruiser", 80, 40, { strength: cfg.maxStrength - 40 });
    match.pieces.push(beached);
    repairStep(match);
    if (beached.strength !== cfg.maxStrength - 40) fail("a ship repaired on land");
    if (!(hull.strength > cfg.maxStrength - 40)) fail("a docked ship did not repair: " + hull.strength);
    for (let i = 0; i < 60; i++) repairStep(match);
    if (hurt.strength > cfg.maxStrength) fail("repair passed the starting maximum");
  }

  // --- AC9: attrition and its floor --------------------------------------------------------
  {
    const match = matchOf([unit("blue:f", "blue", "infantry", 10, 10)], { round: 1 });
    const look = () => "desert";
    for (let round = 1; round <= 200; round++) {
      match.round = round;
      attritionStep(match, look);
    }
    if (!near(match.pieces[0].strength, cfg.maxStrength * cfg.attritionFloor)) {
      fail("desert attrition did not stop at the floor: " + match.pieces[0].strength);
    }
    const waste = matchOf([unit("blue:f", "blue", "infantry", 10, 10)], { round: 1 });
    for (let round = 1; round <= 200; round++) {
      waste.round = round;
      attritionStep(waste, () => "wasteland");
    }
    if (waste.pieces.length !== 0) fail("wasteland attrition never reached zero: " + JSON.stringify(waste.pieces));
    // A friendly city does not drain its owner; an enemy one does. `strength` is optional on a
    // piece until a step or the view opens it (ensureStrength), so read it through that seam -
    // reading the raw field would compare `undefined` against the maximum and pass for the wrong
    // reason.
    const site = { id: 10, name: "Home", x: 10, y: 10, kind: "city", owner: "blue" };
    const home = matchOf([unit("blue:f", "blue", "infantry", 10, 10)], { sites: [site] });
    attritionStep(home, () => "city");
    if (ensureStrength(home.pieces[0], cfg.maxStrength) !== cfg.maxStrength) fail("attrition drained a unit in its own city");
    site.owner = "red";
    attritionStep(home, () => "city");
    if (!(ensureStrength(home.pieces[0], cfg.maxStrength) < cfg.maxStrength)) fail("attrition did not drain a unit in an enemy city");
  }

  // --- AC10: air strikes -------------------------------------------------------------------
  {
    const city = { id: 10, name: "Home", x: 80, y: 40, kind: "city", owner: "blue" };
    const plane = { id: "blue:air:1", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40, path: [], pace: 1 };
    const land = unit("red:l", "red", "infantry", 90, 44);
    const landMatch = matchOf([plane, land], { sites: [city] });
    const strike = sendMission(landMatch, "blue", "blue:air:1", "strike", { x: 90, y: 44 });
    if (strike.error) fail("the strike was refused: " + strike.error);
    if (!near(land.strength, cfg.maxStrength * cfg.airStrikeLandFactor)) {
      fail("an air strike did not halve a land unit: " + land.strength);
    }
    const sea = ship("red:s", "red", "cruiser", 90, 44);
    const seaMatch = matchOf([plane, sea], { sites: [city] });
    for (let i = 0; i < 3; i++) {
      plane.inactiveUntil = 0;
      seaMatch.round = i + 1;
      const result = sendMission(seaMatch, "blue", "blue:air:1", "strike", { x: 90, y: 44 });
      if (result.error) fail("strike " + (i + 1) + " was refused: " + result.error);
    }
    if (seaMatch.pieces.some((piece) => piece.id === "red:s")) fail("three strikes did not sink the ship");
  }

  // --- AC11: paradrop costs a quarter ------------------------------------------------------
  {
    const foot = unit("blue:f", "blue", "infantry", 80, 40);
    const match = matchOf([foot]);
    const drop = paradrop(match, "blue", "blue:f", { x: 70, y: 44 });
    if (drop.error) fail("the paradrop was refused: " + drop.error);
    if (foot.x !== 70 || foot.y !== 44) fail("the infantry did not land on the drop cell");
    if (!near(foot.strength, cfg.maxStrength * (1 - cfg.paradropLoss))) {
      fail("a paradrop did not cost paradropLoss: " + foot.strength);
    }
  }

  // --- AC12: a tank overruns infantry and keeps its path -----------------------------------
  {
    const tank = unit("blue:t", "blue", "tank", 40, 40);
    const foot = unit("red:f", "red", "infantry", 41, 40, { strength: cfg.baseDamage.tank - 1 });
    const match = matchOf([tank, foot]);
    const order = issueOrder(match, "blue", "blue:t", 43, 40);
    if (order.error) fail("the tank refused the order through the infantry: " + order.error);
    const events = advance(match);
    if (!events.some((event) => event.type === "overrun")) fail("the tank did not overrun: " + JSON.stringify(events.map((e) => e.type)));
    if (match.pieces.some((piece) => piece.id === "red:f")) fail("the overrun did not remove the infantry");
    if (!match.pieces.some((piece) => piece.id === "blue:t")) fail("the tank did not survive");
    if (!near(tank.strength, cfg.maxStrength - cfg.baseDamage.infantry)) fail("the tank took no losses: " + tank.strength);
    if (tank.x !== 41) fail("the tank did not enter the overrun cell: " + tank.x);
    if (!Array.isArray(tank.path) || tank.path.length === 0) fail("the tank dropped its path at the overrun");
    advance(match);
    if (tank.x !== 42) fail("the tank did not carry on past the cell: " + tank.x);
  }

  // --- AC13: death only when a hit meets the remaining strength ----------------------------
  {
    const piece = unit("blue:f", "blue", "infantry", 10, 10, { strength: 20 });
    const light = applyDamage(piece, 19);
    if (light.dead) fail("a hit below the remaining strength killed the unit");
    if (!near(piece.strength, 1)) fail("a light hit mis-counted: " + piece.strength);
    const fatal = applyDamage(piece, 1);
    if (!fatal.dead) fail("a hit equal to the remaining strength did not kill the unit");
    if (applyDamage(unit("x", "blue", "infantry", 1, 1, { strength: 100 }), 99).dead) fail("a 99 hit killed a 100 unit");
  }

  // --- ensureStrength is the one place a missing bar becomes a full one --------------------
  {
    const bare = unit("blue:bare", "blue", "infantry", 1, 1);
    if (ensureStrength(bare, cfg.maxStrength) !== cfg.maxStrength) fail("a piece with no strength did not open full");
    if (bare.maxStrength !== cfg.maxStrength) fail("a piece with no maximum did not record it");
  }

  // --- nothing fights in a finished match or with no pieces --------------------------------
  {
    const done = matchOf([unit("blue:a", "blue", "infantry", 40, 40), unit("red:d", "red", "infantry", 41, 40)], { over: true });
    if (resolve(done).length !== 0) fail("a finished match kept fighting");
    if (resolve(matchOf([])).length !== 0) fail("an empty roster produced events");
  }
}
