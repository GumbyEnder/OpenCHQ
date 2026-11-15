// Node test for the air predicate (T-029). Owner: game; reviewer: Pippin.
//
// What breaks if this node is removed: nothing on the board, today. There are TWO predicates in the
// engine that answer "is this piece on the air layer?", of different widths:
//
//   placement.layerOf   -> kind === "aircraft" || domain === "air"   (the layer rule)
//   air.isAircraft      -> kind === "aircraft" only  (before T-029; move.mjs 95/109/283 called it)
//   combat.mjs 87/101/123/290 -> the same expression as layerOf, inlined four times, sharing the
//                                meaning and none of the identity.
//
// A piece shaped {kind:"tank", domain:"air"} was therefore air to placement, economy and combat and
// ground to the walker. Nothing in config/game.json carries domain "air" yet, so nothing was
// mis-simulated: the defect is latent, and that is exactly why a game-state mutant cannot pin it.
// After T-029 combat and air both CALL placement.layerOf, so the split cannot reopen without this
// test going red. That is the only artifact T-021's item 1 ever had.
//
// The assertions are on the predicates and on the exported combat surfaces every one of those four
// call sites is reachable through: rangeOf, candidatesFor, chooseTarget, computeTargets. A re-inlined
// narrow check in any of them, or a re-narrowed isAircraft, fails a named line here.

import { candidatesFor, chooseTarget, computeTargets, rangeOf } from "../../server/combat.mjs";
import { isAircraft } from "../../server/air.mjs";
import { layerOf } from "../../server/placement.mjs";
import { DOMAIN_BY_KIND } from "../../server/shop.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "t029_air_predicate";

function piece(id, side, x, y, shape) {
  return {
    id,
    side,
    x,
    y,
    kind: shape.kind,
    ...(shape.domain === undefined ? {} : { domain: shape.domain }),
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
  };
}

export async function run(ctx) {
  const fail = ctx.fail;

  // The shapes that separate the two predicates, plus the controls that keep every assertion from
  // being satisfied by a function that answers "not air" to everything.
  const shapes = [
    ["a kind-only aircraft", { kind: "aircraft" }, true],
    ["an aircraft whose domain reads land", { kind: "aircraft", domain: "land" }, true],
    ["a tank", { kind: "tank", domain: "land" }, false],
    ["a tank carrying domain air", { kind: "tank", domain: "air" }, true],
    ["a cruiser", { kind: "cruiser", domain: "sea" }, false],
    ["a kindless piece carrying domain air", { domain: "air" }, true],
  ];

  // --- 1. the two predicates agree, over every shape, as functions --------------------------
  for (const [label, shape, air] of shapes) {
    if (layerOf(shape) !== (air ? "air" : "ground")) {
      fail("layerOf is the reference and it disagrees with this test's table: " + label + " -> " + layerOf(shape));
    }
    if (isAircraft(shape) !== (layerOf(shape) === "air")) {
      fail("air.isAircraft disagrees with placement.layerOf on " + label + " (T-029: it must delegate)");
    }
  }

  // --- 2. the separating shape, through all four combat call sites --------------------------
  const enemyOf = (shape) => [piece("blue:subject", "blue", 10, 10, shape), piece("red:enemy", "red", 11, 10, { kind: "infantry", domain: "land" })];

  const wide = { kind: "tank", domain: "air" };
  const widePair = enemyOf(wide);
  const [subject, enemy] = widePair;

  if (rangeOf(subject) !== 0) {
    fail("rangeOf: a tank carrying domain air still has a reach - combat re-narrowed to the kind (combat.mjs:87)");
  }
  if (candidatesFor(subject, widePair).length !== 0) {
    fail("candidatesFor: a tank carrying domain air found a target - combat re-narrowed to the kind (combat.mjs:101)");
  }
  if (candidatesFor(enemy, widePair).length !== 0) {
    fail("candidatesFor: an enemy can target a tank carrying domain air - combat re-narrowed to the kind (combat.mjs:123)");
  }
  if (chooseTarget(subject, widePair) !== null) {
    fail("chooseTarget: a tank carrying domain air chose a target - combat re-narrowed to the kind (combat.mjs:123)");
  }
  const wideTargets = computeTargets(widePair);
  if (wideTargets[0] !== null) {
    fail("computeTargets: a tank carrying domain air was armed - combat re-narrowed to the kind (combat.mjs:290)");
  }
  if (wideTargets[1] !== null) {
    fail("computeTargets: an enemy was armed against a tank carrying domain air - combat re-narrowed to the kind (combat.mjs:290)");
  }

  // --- 3. the same shape through the walker's own bridge ----------------------------------
  // move.mjs 95/109/283 call isAircraft to decide whether a piece holds the cell under it. This is
  // the one place the widening is a behaviour change, and it must be the same rule as combat's.
  if (isAircraft(subject) !== true) {
    fail("air.isAircraft: a tank carrying domain air is ground to the walker while combat calls it air");
  }

  // --- 4. controls: the air checks are not simply "nothing engages" ------------------------
  const plain = { kind: "tank", domain: "land" };
  const plainPair = enemyOf(plain);
  if (rangeOf(plainPair[0]) <= 0) fail("rangeOf: a plain tank has no reach, so section 2 proves nothing");
  if (candidatesFor(plainPair[0], plainPair).length !== 1) {
    fail("candidatesFor: a plain tank at distance 1 found no target, so section 2 proves nothing");
  }
  if (chooseTarget(plainPair[0], plainPair) === null) {
    fail("chooseTarget: a plain tank chose no target, so section 2 proves nothing");
  }
  const plainTargets = computeTargets(plainPair);
  if (plainTargets[0] === null) fail("computeTargets: a plain tank was unarmed, so section 2 proves nothing");

  // An aircraft is the same on every surface: unreachable, unarmed, untargetable.
  const planeShape = { kind: "aircraft" };
  const planePair = enemyOf(planeShape);
  if (rangeOf(planePair[0]) !== 0) fail("rangeOf: an aircraft has a reach");
  if (candidatesFor(planePair[0], planePair).length !== 0) fail("candidatesFor: an aircraft found a target");
  if (candidatesFor(planePair[1], planePair).length !== 0) fail("candidatesFor: an aircraft was targetable");
  if (computeTargets(planePair)[0] !== null) fail("computeTargets: an aircraft was armed");

  // --- 5. the widening is latent: no kind on the board carries domain "air" --------------
  // Recorded, not asserted as a rule: the day a kind carries domain "air" is the day section 3 stops
  // being latent. DOMAIN_BY_KIND is where a bought piece's domain comes from, and note that
  // `aircraft` maps to "land" - which is why layerOf needs BOTH arms and why the kind-only test in
  // isAircraft looked equivalent for as long as it did.
  const airDomain = Object.keys(DOMAIN_BY_KIND).filter((k) => DOMAIN_BY_KIND[k] === "air");
  if (airDomain.length) {
    console.log("note: DOMAIN_BY_KIND now maps " + airDomain.join(", ") + " to air - section 3 is no longer latent");
  }

  // --- 6. the identity itself: none of these modules may restate the predicate ------------
  // Sections 1-4 pin the MEANING, and meaning cannot see one of the four combat sites.
  // computeTargets reads `ranges[i] = rangeOf(piece)` and skips on `ranges[i] <= 0`, and rangeOf
  // already answers 0 for an air piece, so its own `armed[i]` test is unreachable for air:
  // re-narrowing that one line changes nothing observable. That is exactly why T-029's object is
  // IDENTITY and not behaviour - four copies of one expression are a trap even when they are all
  // correct today. So the last assertion is structural: the expression may not be written out again
  // in any module that is supposed to call the rule. move.mjs is in this list because PM's "one rule
  // everywhere" names movement: 95/109/283 call isAircraft and 484/536 tested the kind inline.
  // A re-inline of the full pre-T-029 expression fails here and passes the whole rest of the suite,
  // which is the honest pair: behaviour identical, identity lost.
  const guarded = ["../../server/combat.mjs", "../../server/air.mjs", "../../server/move.mjs"];
  for (const rel of guarded) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const code = line.split("//")[0];
      if (/kind\s*===\s*"aircraft"/.test(code) || /domain\s*===\s*"air"/.test(code)) {
        fail(
          rel + ":" + (index + 1) + " restates the air predicate instead of calling placement.layerOf: " + line.trim()
        );
      }
    });
  }
}
