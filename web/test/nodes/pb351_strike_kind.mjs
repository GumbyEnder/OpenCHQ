// pb351_strike_kind — a sea strike_hit names the damage row that CHOSE the amount.
//
// PB-351 (filed from frodo's 10570): nothing consumes strike_hit.kind, so this is record hygiene,
// but the record was wrong. `damageMatrix.kinds` names infantry/tank/entrenched/submarine/cruiser/
// carrier only. A destroyer (or any hull whose kind has no row) pays from `transportDamageKind`
// (5 -> 34 a strike), yet the event reported `Number(kind) || 0` of the UNMAPPED kind, i.e. 0.
// A reader summing by kind saw a row that paid nothing next to a bar that lost 34.
//
// What fails if this node is removed:
//   - the event goes back to reporting the target's raw kind -> destroyer/kind-11 arms red with
//     "reported kind 0 ... it paid 34 from kind 5"
//   - the amount stops coming from the reported row -> the kind->amount table arm reds
//   - a named hull (sub/cruiser/carrier) loses its 7/8/9 -> the unchanged-kinds arm reds
//
// Producer: web/server/air.mjs sendMission's `mission.type === "strike"` sea branch.
import { warMatch } from "../wartime.mjs";
import { sendMission } from "../../server/air.mjs";
import { combatRules } from "../../server/rules.mjs";

export const name = "pb351_strike_kind";

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
    id: "blue:air:351", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100,
  }];
  return match;
}

function hull(id, kind, strength = 100) {
  return {
    id, side: "red", domain: "sea", kind, x: 84, y: 44,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, strength, maxStrength: 100,
  };
}

function strike(match) {
  const order = sendMission(match, "blue", "blue:air:351", "strike", { x: 84, y: 44 });
  if (order.error) throw new Error("a strike from a ready plane at its berth was refused: " + JSON.stringify(order.error));
  const hit = (order.events || []).find((event) => event.type === "strike_hit");
  if (!hit) throw new Error("the strike emitted no strike_hit event");
  return hit;
}

export async function run(ctx) {
  const fail = typeof ctx.fail === "function" ? ctx.fail : (message) => { throw new Error(message); };
  const combat = combatRules();
  const shipDamage = combat.airStrikeShipDamage || {};
  const fallback = String(combat.transportDamageKind);

  // The premise: 5 is a row with a positive amount, and destroyer/kind-11 have no row of their own.
  if (!(Number(shipDamage[fallback]) > 0)) {
    fail("pb351: combat.airStrikeShipDamage has no positive amount for transportDamageKind " + fallback
      + "; this arm cannot grade the fallback class");
  }
  if (Object.prototype.hasOwnProperty.call(shipDamage, "destroyer")) {
    fail("pb351: airStrikeShipDamage now carries a `destroyer` row; re-derive this arm instead of assuming the 5 fallback");
  }

  const reds = [];
  const arm = (label, body) => {
    try {
      body();
      console.log("pb351 arm " + label + " ok");
    } catch (err) {
      reds.push("arm " + label + ": " + (err && err.message ? err.message : String(err)));
    }
  };

  // ---- (a) a destroyer reports the class it paid from (5), not 0 -------------------------------
  arm("(a) destroyer-reports-paid-kind", () => {
    const match = board();
    const destroyer = hull("red:destroyer:1", "destroyer");
    match.pieces.push(destroyer);
    const hit = strike(match);
    const paid = Number(shipDamage[fallback]);
    if (Number(hit.kind) !== Number(fallback)) {
      fail("a destroyer strike_hit reported kind " + JSON.stringify(hit.kind) + " while paying "
        + hit.amount + " from kind " + fallback + " (producer: web/server/air.mjs sea strike branch)");
    }
    if (Number(hit.amount) !== paid) {
      fail("a destroyer strike_hit carried amount " + hit.amount + ", not airStrikeShipDamage[" + fallback + "] = " + paid);
    }
    if (Number(destroyer.strength) !== 100 - paid) {
      fail("a destroyer at 100 read " + destroyer.strength + " after one strike, not " + (100 - paid));
    }
  });

  // ---- (b) a numeric kind with no row (the cargo hulls, kind 11) reports 5 too -----------------
  arm("(b) kind-11-reports-paid-kind", () => {
    const match = board();
    const cargo = hull("red:cargo:11", 11);
    match.pieces.push(cargo);
    const hit = strike(match);
    if (Number(hit.kind) !== Number(fallback)) {
      fail("a kind-11 hull's strike_hit reported kind " + JSON.stringify(hit.kind) + ", not the paid class " + fallback);
    }
    if (Number(cargo.strength) !== 100 - Number(shipDamage[fallback])) {
      fail("a kind-11 hull did not lose the class-" + fallback + " amount: " + cargo.strength);
    }
  });

  // ---- (c) the named hulls keep 7/8/9, and their amounts still come from those rows ------------
  arm("(c) named-kinds-unchanged", () => {
    for (const [kind, id] of [["submarine", "7"], ["cruiser", "8"], ["carrier", "9"]]) {
      const match = board();
      const target = hull("red:" + kind + ":1", kind);
      match.pieces.push(target);
      const hit = strike(match);
      if (Number(hit.kind) !== Number(id)) {
        fail("a " + kind + "'s strike_hit reported kind " + JSON.stringify(hit.kind) + ", not " + id
          + " - PB-351 must leave the mapped kinds alone");
      }
      if (Number(hit.amount) !== Number(shipDamage[id])) {
        fail("a " + kind + "'s strike_hit carried amount " + hit.amount + ", not airStrikeShipDamage[" + id + "] = " + shipDamage[id]);
      }
    }
  });

  // ---- (d) the invariant: a sea strike_hit never reads kind 0 ----------------------------------
  arm("(d) no-zero-kind-on-a-paid-row", () => {
    for (const kind of ["destroyer", "transport", 11, "submarine", "cruiser", "carrier"]) {
      const match = board();
      match.pieces.push(hull("red:hull:" + String(kind), kind));
      const hit = strike(match);
      if (!(Number(hit.kind) > 0)) {
        fail("a hull of kind " + JSON.stringify(kind) + " emitted strike_hit kind " + JSON.stringify(hit.kind)
          + " with amount " + hit.amount + " - a paid row cannot report class 0");
      }
      const row = shipDamage[String(hit.kind)];
      if (row === undefined || Number(row) !== Number(hit.amount)) {
        fail("a hull of kind " + JSON.stringify(kind) + " reported class " + hit.kind + " but amount "
          + hit.amount + "; airStrikeShipDamage[" + hit.kind + "] = " + row
          + " - the reported class is not the row that chose the amount");
      }
    }
  });

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red on PB-351 strike_hit.kind - " + reds.join(" | "));
  }
}
