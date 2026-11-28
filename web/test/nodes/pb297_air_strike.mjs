// pb297_air_strike — the air strike's arithmetic, graded against the ORIGINAL's routine.
//
// PB-348 moved the port onto the code (FUN_1ac5_0dbe @ 1ac5:0dbe, decompiled.c 8795-8814; the code
// governs the port, room 3544 ruling 1). This node used to pin the manual's shape - "half of the
// remaining strength" and "three strikes kill a ship" - read through a single land factor (0.5) and a
// single sea constant (0.34 x maxStrength). That shape is retired and is NOT to be re-added:
//   * land -> damage is (strength >> 1) + 1, so a full bar leaves 49, not 50, and the integer bar
//             reaches 0 on the SIXTH strike (100, 49, 24, 11, 5, 2, 0). The manual's own "six strikes
//             kill a land unit" prose IS reproduced by the shift; the float halving never reached 0.
//   * sea  -> the constant is chosen by the target's KIND: 34 for kinds 5-7, 25 for kinds 8/9. A
//             cruiser/carrier therefore needs FOUR strikes, not the page's three
//             (MANUAL-CONTRADICTED, Manual p.25; docs/re/COMBAT.md s6 :233-245, s9 item 1).
//
// Shape, not literals: every number is read from config through `combatRules()` - the same object
// `air.mjs` reads - so a retune moves the pin and the server together. The per-kind table lives in
// measured.combat.airStrike.shipDamage and reaches the runtime as combat.airStrikeShipDamage.
//
// Producer: web/server/air.mjs sendMission's `mission.type === "strike"` block.
import { warMatch } from "../wartime.mjs";
import { sendMission } from "../../server/air.mjs";
import { combatRules, combatValue } from "../../server/rules.mjs";

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

// The plane owes rounds after a strike, so the next strike in an arm advances the clock past the
// timer it just set (air.mjs: inactiveUntil = round + air.strikeRounds).
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
  // The single-node driver `test/nodes/_only.mjs` runs a node with an EMPTY ctx, so a red arm there
  // would otherwise surface as "fail is not a function" instead of the sentence that names the defect.
  const fail = typeof ctx.fail === "function" ? ctx.fail : (message) => { throw new Error(message); };
  const combat = combatRules();
  const max = combat.maxStrength;
  const measured = (combatValue("measured", {}) || {}).airStrike || {};
  const shipDamage = combat.airStrikeShipDamage || {};
  // The land figure is the original's integer shift, restated here so the arm and the report agree.
  const landDealt = (strength) => (Math.floor(strength) >> 1) + 1;

  if (combat.airStrikeLandFactor !== undefined || combat.airStrikeSeaAmount !== undefined) {
    fail("pb297: the retired levers are back in combatRules() (airStrikeLandFactor / airStrikeSeaAmount); PB-348 reads (s>>1)+1 and the per-kind ship table");
  }
  for (const kind of ["5", "6", "7", "8", "9"]) {
    if (!(Number(shipDamage[kind]) > 0)) {
      fail("pb297: combat.airStrikeShipDamage has no positive amount for kind " + kind + "; the table is the sea arm's only source");
    }
    if (Number(shipDamage[kind]) !== Number((measured.shipDamage || {})[kind])) {
      fail("pb297: combat.airStrikeShipDamage[" + kind + "] = " + shipDamage[kind]
        + " has drifted from measured.combat.airStrike.shipDamage[" + kind + "]");
    }
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

  // ---- (a) a land target loses (strength >> 1) + 1, on the REMAINING bar ----------------------
  arm("(a) land-(s>>1)+1 8795-8814", () => {
    const first = board();
    const inf = target("red:inf:1", "land", "infantry", 84, 44, max);
    first.pieces.push(inf);
    strike(first, { x: 84, y: 44 });
    const one = Number(inf.strength);
    if (one !== max - landDealt(max)) {
      fail("a full land target read " + one + " after one strike, not " + max + " - ((max>>1)+1) = "
        + (max - landDealt(max)) + " (producer: web/server/air.mjs, strike land branch)");
    }
    // Second strike: the shift runs on what is LEFT, not on the bar again.
    ready(first);
    strike(first, { x: 84, y: 44 });
    const two = Number(inf.strength);
    if (two !== one - landDealt(one)) {
      fail("the second strike left " + two + ", not " + one + " - ((one>>1)+1) = " + (one - landDealt(one))
        + " - the strike is not reading the remaining bar");
    }
    // A damaged target proves the same thing from a different height: 40 -> 19, not 40 - 51.
    const hurt = board();
    const weak = target("red:inf:2", "land", "infantry", 84, 44, 40);
    hurt.pieces.push(weak);
    strike(hurt, { x: 84, y: 44 });
    if (Number(weak.strength) !== 40 - landDealt(40)) {
      fail("a land target at 40 read " + weak.strength + " after a strike, not 40 - ((40>>1)+1) = "
        + (40 - landDealt(40)));
    }
  });

  // ---- (b) a sea target loses a CONSTANT chosen by its KIND ------------------------------------
  arm("(b) sea-per-kind 8795-8814", () => {
    for (const [kind, id] of [["submarine", "7"], ["cruiser", "8"], ["carrier", "9"]]) {
      const match = board();
      const hull = target("red:" + kind + ":1", "sea", kind, 84, 44, max);
      match.pieces.push(hull);
      const dealt = [];
      for (let i = 0; i < 2; i += 1) {
        const before = Number(hull.strength);
        strike(match, { x: 84, y: 44 });
        dealt.push(Number((before - Number(hull.strength)).toFixed(2)));
        ready(match);
      }
      const want = Number(shipDamage[id]);
      if (dealt[0] !== want || dealt[1] !== want) {
        fail("two strikes on a " + kind + " (kind " + id + ") dealt " + JSON.stringify(dealt)
          + "; the constant for its kind is " + want + " each (combat.airStrikeShipDamage)");
      }
    }
  });

  // ---- (c) the count: kinds 5-7 die on the third, kinds 8/9 on the fourth ---------------------
  arm("(c) three-vs-four 8795-8814 / s6 :239", () => {
    const sinkIn = (kind) => {
      const match = board();
      const hull = target("red:" + kind + ":c", "sea", kind, 84, 44, max);
      match.pieces.push(hull);
      const seen = [];
      for (let i = 0; i < 4; i += 1) {
        strike(match, { x: 84, y: 44 });
        seen.push(Number(hull.strength));
        if (!match.pieces.some((piece) => piece.id === hull.id)) return seen.join(",");
        ready(match);
      }
      return seen.join(",");
    };
    const sub = sinkIn("submarine");
    if (sub !== [max - 34, max - 68, 0].join(",")) {
      fail("a submarine's bar read " + sub + "; a kind-7 hull is 34 a strike and dies on the third");
    }
    const cruiser = sinkIn("cruiser");
    const four = [max - 25, max - 50, max - 75, 0].join(",");
    if (cruiser !== four) {
      fail("a cruiser's bar read " + cruiser + ", not " + four
        + "; kinds 8/9 take 25 a strike, so the count is four, not the page's three (s9 item 1)");
    }
  });

  // ---- (d) the amount and the kind are on the event, and they are config's ---------------------
  arm("(d) sea-constant-from-config 8795-8814", () => {
    const match = board();
    const hull = target("red:sub:2", "sea", "submarine", 84, 44, max);
    match.pieces.push(hull);
    const order = strike(match, { x: 84, y: 44 });
    const hit = (order.events || []).find((event) => event.type === "strike_hit" && event.target === "red:sub:2");
    if (!hit) fail("the strike emitted no strike_hit event for the hull");
    if (Number(hit.amount) !== Number(shipDamage["7"])) {
      fail("the strike event carries amount " + hit.amount + ", not combat.airStrikeShipDamage[\"7\"] = "
        + shipDamage["7"]);
    }
    if (Number(hit.kind) !== 7) {
      fail("the strike event carries kind " + JSON.stringify(hit.kind) + ", not 7 - the kind the amount was chosen by");
    }
    if (hit.domain !== "sea") fail("the hull's strike_hit event reads domain " + JSON.stringify(hit.domain) + ", not \"sea\"");
  });

  // ---- the manual's prose count, recomputed on the integer bar --------------------------------
  {
    let bar = max;
    const row = [];
    for (let i = 0; i < 6; i += 1) {
      bar = bar - landDealt(bar);
      row.push(bar);
    }
    console.log("pb297 note: the code's (s>>1)+1 reads " + JSON.stringify(row) + " after six strikes from " + max
      + "; the manual's \"six strikes kill a land unit\" IS reproduced by the integer shift (the retired"
      + " float halving never reached zero).");
  }

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red at 108afd6+PB-348 - " + reds.join(" | "));
  }
}
