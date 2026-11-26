// PB-297 pin: air strike arithmetic, manual_pages.txt l.797-798 (PM's line refs; the manual text is
// not on this host, so the rule below is the PM's reading of p.25 and is quoted, not re-derived).
//
//   "A land target loses half its remaining strength; a sea target a constant amount. The manual
//    reads: three strikes kill a ship, six a land unit."
//
// Shape, not literals: both numbers are read from config through `combatRules()` - the same object
// `air.mjs` reads - so a retune moves the pin and the server together.
//   * land  -> combat.airStrikeLandFactor (0.5), applied to the REMAINING strength
//   * sea   -> combat.airStrikeSeaAmount (0.34) x combat.maxStrength, a CONSTANT per strike
// The constant is cited to config, whose source line records the disassembly
// (FUN_1ac5_0dbe 1ac5:0dbe, 8795-8814: 34 for kinds 5-7, 25 for kinds 8/9).
//
// Producer: web/server/air.mjs sendMission's `mission.type === "strike"` block (:468-503).
//
// Arms (a), (b), (c) and (d) are GREEN and each carries a mutant (ticket card). The note at the end
// records the manual's own "six strikes" count against the halving the port implements: halving
// never reaches zero (100 -> 50 -> 25 -> 12.5 -> 6.25 -> 3.13 -> 1.56), so the prose count is not
// reproduced by this arithmetic. That is reported, not fixed.
import { warMatch } from "../wartime.mjs";
import { sendMission } from "../../server/air.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb297_air_strike";

const ROUND = 10;

function board() {
  const match = warMatch("1986", []);
  match.round = ROUND;
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.sides.red.fuel = 5000;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", type: 4, owner: "blue" },
    { id: 12, name: "Kiev", x: 84, y: 44, kind: "city", type: 4, owner: "red" },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 84, y: 44 } };
  match.pieces = [{
    id: "blue:air:297", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100,
  }];
  return match;
}

function target(id, domain, kind, x, y, strength) {
  return {
    id, side: "red", domain, kind, x, y, path: [], pace: 1, facing: null, fighting: null,
    shots: 0, strength, maxStrength: 100,
  };
}

function strike(match, at) {
  const order = sendMission(match, "blue", "blue:air:297", "strike", at);
  if (order.error) throw new Error("a strike from a ready plane at the aircraft's berth was refused: " + JSON.stringify(order.error));
  return order;
}

// The plane owes rounds after a strike, so every second strike in an arm advances the clock past
// the timer it just set (air.mjs:369 inactiveUntil = round + air.strikeRounds).
function ready(match) {
  match.round = Number(match.round) + 8;
  for (const piece of match.pieces) {
    if (piece.id === "blue:air:297") {
      piece.inactiveUntil = 0;
      piece.readyAnnounced = false;
    }
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const combat = combatRules();
  const max = combat.maxStrength;
  const landFactor = combat.airStrikeLandFactor;
  const seaAmount = Number((max * combat.airStrikeSeaAmount).toFixed(2));
  if (!(landFactor > 0 && landFactor < 1)) {
    fail("pb297: config combat.airStrikeLandFactor is " + JSON.stringify(landFactor) + "; the land shape needs a factor in (0,1)");
  }
  if (!(seaAmount > 0)) {
    fail("pb297: config combat.airStrikeSeaAmount x maxStrength is " + JSON.stringify(seaAmount) + "; the sea shape needs a positive constant");
  }

  const reds = [];
  const arm = (label, body) => {
    try {
      body();
      console.log("pb297 arm " + label + " ok");
    } catch (err) {
      reds.push("arm " + label + ": " + (err && err.message ? err.message : String(err)));
    }
  };

  // ---- (a) a land target loses HALF ITS REMAINING strength --------------------------------------
  arm("(a) land-half-of-remaining l.797", () => {
    // Full bar: 100 -> 50.
    const first = board();
    const inf = target("red:inf:1", "land", "infantry", 84, 44, max);
    first.pieces.push(inf);
    strike(first, { x: 84, y: 44 });
    const afterOne = inf.strength;
    if (Number(afterOne.toFixed(2)) !== Number((max * landFactor).toFixed(2))) {
      fail("a full land target read " + afterOne + " after one strike, not max x config airStrikeLandFactor = "
        + Number((max * landFactor).toFixed(2)) + " (producer: web/server/air.mjs:488)");
    }
    // Second strike: half of what is LEFT, not half of the bar again.
    ready(first);
    strike(first, { x: 84, y: 44 });
    const afterTwo = inf.strength;
    if (Number(afterTwo.toFixed(2)) !== Number((afterOne * landFactor).toFixed(2))) {
      fail("the second strike left " + afterTwo + ", not half of the remaining " + afterOne + " = "
        + Number((afterOne * landFactor).toFixed(2)) + " (producer: web/server/air.mjs:488)");
    }
    // A damaged target proves it is the REMAINING bar: 40 -> 20, not 40 - 50.
    const hurt = board();
    const weak = target("red:inf:2", "land", "infantry", 84, 44, 40);
    hurt.pieces.push(weak);
    strike(hurt, { x: 84, y: 44 });
    if (Number(weak.strength.toFixed(2)) !== Number((40 * landFactor).toFixed(2))) {
      fail("a land target at 40 read " + weak.strength + " after a strike, not 40 x " + landFactor
        + " = " + Number((40 * landFactor).toFixed(2)) + " - the strike is not reading the remaining bar"
        + " (producer: web/server/air.mjs:488)");
    }
  });

  // ---- (b) a sea target loses a CONSTANT per strike --------------------------------------------
  arm("(b) sea-constant l.798", () => {
    const match = board();
    const hull = target("red:sub:1", "sea", "submarine", 84, 44, max);
    match.pieces.push(hull);
    const dealt = [];
    for (let i = 0; i < 2; i += 1) {
      const before = hull.strength;
      strike(match, { x: 84, y: 44 });
      dealt.push(Number((before - hull.strength).toFixed(2)));
      ready(match);
    }
    if (dealt[0] !== seaAmount || dealt[1] !== seaAmount) {
      fail("two strikes on a hull dealt " + JSON.stringify(dealt) + "; the manual's sea target takes a"
        + " constant, config airStrikeSeaAmount x maxStrength = " + seaAmount + " each"
        + " (producer: web/server/air.mjs:483)");
    }
    if (hull.strength !== 0 && Number(hull.strength.toFixed(2)) !== Number((max - 2 * seaAmount).toFixed(2))) {
      fail("after two constant strikes the hull reads " + hull.strength + ", not " + (max - 2 * seaAmount));
    }
  });

  // ---- (c) three strikes from a full bar sink a ship, and not before ----------------------------
  arm("(c) three-strikes-kill l.798", () => {
    const match = board();
    const hull = target("red:cruiser:1", "sea", "cruiser", 84, 44, max);
    match.pieces.push(hull);
    strike(match, { x: 84, y: 44 });
    ready(match);
    strike(match, { x: 84, y: 44 });
    const aliveEarly = match.pieces.some((piece) => piece.id === "red:cruiser:1");
    if (!aliveEarly) {
      fail("a full cruiser died on the SECOND strike; the manual's count is three"
        + " (constant = " + seaAmount + ", bar = " + max + ") - producer: web/server/air.mjs:483");
    }
    ready(match);
    strike(match, { x: 84, y: 44 });
    const still = match.pieces.some((piece) => piece.id === "red:cruiser:1");
    if (still) {
      fail("three strikes from a full bar left the cruiser on the board at strength "
        + (match.pieces.find((piece) => piece.id === "red:cruiser:1") || {}).strength
        + "; the manual's ship dies on the third (producer: web/server/air.mjs:482-492)");
    }
  });

  // ---- (d) the constant is CONFIG's, not a literal in the module -------------------------------
  arm("(d) sea-constant-from-config l.798", () => {
    const match = board();
    const hull = target("red:sub:2", "sea", "submarine", 84, 44, max);
    match.pieces.push(hull);
    const order = strike(match, { x: 84, y: 44 });
    const hit = (order.events || []).find((event) => event.type === "strike_hit" && event.target === "red:sub:2");
    if (!hit) fail("the strike emitted no strike_hit event for the hull");
    if (Number(hit.amount) !== seaAmount) {
      fail("the strike event carries amount " + hit.amount + ", not config's airStrikeSeaAmount x maxStrength = "
        + seaAmount + " (producer: web/server/air.mjs:483)");
    }
    if (hit.domain !== "sea") fail("the hull's strike_hit event reads domain " + JSON.stringify(hit.domain) + ", not \"sea\"");
  });

  // ---- the manual's prose count, recorded -----------------------------------------------------
  {
    let bar = max;
    const row = [];
    for (let i = 0; i < 6; i += 1) {
      bar = Number((bar * landFactor).toFixed(2));
      row.push(bar);
    }
    console.log("pb297 note: halving from " + max + " reads " + JSON.stringify(row) + " after six strikes;"
      + " the manual's \"six strikes kill a land unit\" is therefore NOT reproduced by the half-shape"
      + " (the original's own (s>>1)+1 leaves 1 the same way). Reported, not fixed.");
  }

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red at f5a6109 - " + reds.join(" | "));
  }
}
