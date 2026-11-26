// PB-296 pin: air transfers and paradrops, manual_pages.txt l.785-796 (manual printed p.25; PM's
// line refs - the manual text is not on this host, so each clause below is the PM's reading and is
// quoted, not re-derived).
//
//   LOADED TRANSFER: infantry within 3 spaces of the plane's START and entrenched; the destination
//   is a friendly city or base INSIDE the restricted radius. A carrier-based plane can make neither
//   a loaded transfer nor a paradrop.
//   PARADROP (rules 1-3): (1) on land, not on an enemy city or an enemy unit; (2) the plane stays
//   home and goes unready; (3) the infantry takes a minor loss - the amount is UNVERIFIED unless
//   cited, and config carries it (combat.paradropLoss 0.25, source "Manual p.50 (UNMEASURED)").
//
// Producers under test, both in web/server/air.mjs:
//   transferPlane (:220-281) via sendMission(..., "transfer", target)
//   paradrop      (:509-550)
//
// THE PORT HAS NO LOADED-TRANSFER AND NO PLANE-DRIVEN PARADROP. `transferPlane` reads only x/y off
// the target (:230-231) and rebases one aircraft; `paradrop` takes an infantry id and a cell and
// never names an aircraft. So most arms below are DEVIATIONS, reported with the producer line and
// not fixed here (PM 9844: tests first, reds as deviations). The two GREEN arms carry mutants.
//
// `load` on the transfer target is the contract this module states, not an existing field: the
// port ignores unknown target keys, which is exactly what arm (a) measures.
import { warMatch } from "../wartime.mjs";
import { airBriefing, paradrop, sendMission } from "../../server/air.mjs";
import { combatRules, rules } from "../../server/rules.mjs";
import { terrainNameAt } from "../../server/move.mjs";

export const name = "pb296_air_transfer_paradrop";

const ROUND = 10;
// Manual p.25 l.785-796. The port has no config key for the loader radius, so the manual's 3 is
// carried here with its citation; it is not sourced from the archive.
const LOAD_CELLS = 3;

function board() {
  const match = warMatch("1986", []);
  match.round = ROUND;
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.sides.red.fuel = 5000;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", type: 4, owner: "blue" },
    { id: 11, name: "Near Base", x: 83, y: 43, kind: "base", type: 3, owner: "blue" },
    { id: 12, name: "Far Base", x: 88, y: 40, kind: "base", type: 3, owner: "blue" },
    { id: 13, name: "Kiev", x: 85, y: 45, kind: "city", type: 4, owner: "red" },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 85, y: 45 } };
  match.pieces = [{
    id: "blue:air:296", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100,
    inactiveUntil: 0,
  }];
  return match;
}

function infantry(id, x, y, extra = {}) {
  return {
    id, side: "blue", domain: "land", kind: "infantry", x, y, path: [], pace: 1, facing: null,
    fighting: null, shots: 0, strength: 100, maxStrength: 100, entrenched: true, ...extra,
  };
}

function withCarrier(match) {
  match.pieces = [
    { id: "blue:carrier:296", side: "blue", domain: "sea", kind: "carrier", x: 80, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100 },
    { id: "blue:air:296", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, inactiveUntil: 0 },
  ];
  return match;
}

const planeOf = (match) => match.pieces.find((piece) => piece.id === "blue:air:296");

function waterCell() {
  for (let y = 20; y < 90; y += 1) {
    for (let x = 50; x < 110; x += 1) {
      if (terrainNameAt(x, y) === "ocean") return { x, y };
    }
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const reds = [];
  const arm = (label, body) => {
    try {
      body();
      console.log("pb296 arm " + label + " ok");
    } catch (err) {
      reds.push("arm " + label + ": " + (err && err.message ? err.message : String(err)));
    }
  };

  // ---- (a) a loaded transfer carries the infantry ----------------------------------------------
  arm("(a) loaded-transfer-carries l.785-790", () => {
    const match = board();
    const rider = infantry("blue:inf:a", 81, 41);
    match.pieces.push(rider);
    const order = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: rider.id });
    if (order.error) fail("a loaded transfer with the infantry one cell from the plane was refused: " + order.error);
    const plane = planeOf(match);
    if (plane.x !== 83 || plane.y !== 43) fail("the plane did not rebase (at " + plane.x + "," + plane.y + ")");
    if (rider.x !== 83 || rider.y !== 43) {
      fail("the infantry stayed at " + rider.x + "," + rider.y + " while its plane rebased to 83,43;"
        + " a loaded transfer carries it (producer: web/server/air.mjs transferPlane :220-281 reads"
        + " only x/y off the target and never moves a second piece) - DEVIATION, not fixed here");
    }
    if (plane.loaded) fail("the plane still reads loaded after the transfer landed");
  });

  // ---- (b) the loader must be within 3 spaces of the plane's START ------------------------------
  arm("(b) load-radius l.785-790", () => {
    const match = board();
    const rider = infantry("blue:inf:b", 80 + LOAD_CELLS + 1, 40);
    match.pieces.push(rider);
    const order = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: rider.id });
    if (!order.error) {
      fail("a loaded transfer with the infantry " + (LOAD_CELLS + 1) + " cells from the plane's start"
        + " was ACCEPTED; the manual allows " + LOAD_CELLS + " (producer: web/server/air.mjs"
        + " transferPlane has no loader check at all) - DEVIATION, not fixed here");
    }
  });

  // ---- (c) the loader must be entrenched --------------------------------------------------------
  arm("(c) load-entrenched l.785-790", () => {
    const match = board();
    const rider = infantry("blue:inf:c", 81, 41, { entrenched: false });
    match.pieces.push(rider);
    const order = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: rider.id });
    if (!order.error) {
      fail("a loaded transfer loaded an infantry that was NOT entrenched; the manual requires an"
        + " entrenched loader (producer: web/server/air.mjs transferPlane :220-281 never reads"
        + " entrenched) - DEVIATION, not fixed here");
    }
  });

  // ---- (d) a loaded destination must be inside the RESTRICTED radius ----------------------------
  arm("(d) load-restricted-radius l.785-790", () => {
    const air = rules().air || {};
    const restricted = Number(air.restrictedReach);
    const reach = Number(air.reach);
    if (!(restricted > 0) || !(reach > restricted)) {
      fail("pb296 (d): config air.restrictedReach/air.reach are " + restricted + "/" + reach
        + "; the arm needs a restricted circle smaller than the maximum");
    }
    const match = board();
    const rider = infantry("blue:inf:d", 81, 41);
    match.pieces.push(rider);
    const away = Math.min(reach, restricted + 2);
    // Far Base sits 8 cells from the plane's start: outside the restricted 6, inside the max 10.
    const order = sendMission(match, "blue", "blue:air:296", "transfer", { x: 88, y: 40, load: rider.id });
    if (!order.error) {
      fail("a LOADED transfer to a base " + away + " cells away was ACCEPTED; a loaded transfer's"
        + " destination must lie inside the restricted air radius (" + restricted + "), and only an"
        + " unloaded transfer may use the maximum (" + reach + ") - producer: web/server/air.mjs"
        + " transferPlane :252 gates on airReach for every transfer, loaded or not. DEVIATION,"
        + " not fixed here");
    }
  });

  // ---- (e) a carrier-based plane makes no loaded transfer --------------------------------------
  arm("(e) carrier-no-loaded-transfer l.785-796", () => {
    const match = withCarrier(board());
    const rider = infantry("blue:inf:e", 81, 41);
    match.pieces.push(rider);
    const order = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: rider.id });
    if (!order.error) {
      fail("a CARRIER-BASED aircraft made a loaded transfer to New York's base and it was ACCEPTED;"
        + " the manual says a carrier-based plane can do neither a loaded transfer nor a paradrop"
        + " (producer: web/server/air.mjs transferPlane :220-281 never asks where the plane is"
        + " based) - DEVIATION, not fixed here");
    }
  });

  // ---- (f) a carrier-based plane cannot paradrop ----------------------------------------------
  arm("(f) carrier-no-paradrop l.785-796", () => {
    const match = withCarrier(board());
    const rider = infantry("blue:inf:f", 80, 40);
    match.pieces.push(rider);
    const order = paradrop(match, "blue", rider.id, { x: 84, y: 44 });
    if (!order.error) {
      fail("a paradrop was ACCEPTED for an infantry whose only aircraft is CARRIER-BASED; the manual"
        + " forbids it (producer: web/server/air.mjs paradrop :509 takes no aircraft at all, so no"
        + " based-on-a-carrier test can exist there) - DEVIATION, not fixed here");
    }
  });

  // ---- (g) a paradrop lands on land only -------------------------------------------------------
  arm("(g) paradrop-land-only l.792-796", () => {
    const cell = waterCell();
    if (!cell) fail("pb296 (g): no ocean cell on this board (set OPENCHQ_DATA); the arm cannot measure the land rule");
    const match = board();
    const rider = infantry("blue:inf:g", 80, 40);
    match.pieces.push(rider);
    const order = paradrop(match, "blue", rider.id, cell);
    if (!order.error) {
      fail("a paradrop onto OCEAN at " + cell.x + "," + cell.y + " was ACCEPTED (the infantry landed"
        + " on " + rider.x + "," + rider.y + "); rule 1 is land only. Producer: web/server/air.mjs"
        + " paradrop :509-550 reads no terrain - DEVIATION, not fixed here");
    }
  });

  // ---- (h) a paradrop may not land on an enemy city -------------------------------------------
  arm("(h) paradrop-not-enemy-city l.792-796", () => {
    const match = board();
    const city = (match.sites || []).find((site) => site.owner === "red");
    const rider = infantry("blue:inf:h", 80, 40);
    match.pieces.push(rider);
    const order = paradrop(match, "blue", rider.id, { x: city.x, y: city.y });
    if (!order.error) {
      fail("a paradrop onto the empty ENEMY CITY " + city.name + " was ACCEPTED; rule 1 is \"not on"
        + " an enemy city\" (producer: web/server/air.mjs paradrop :509-550 reads no site table)"
        + " - DEVIATION, not fixed here");
    }
  });

  // ---- (i) a paradrop may not land on an enemy unit (GREEN) ------------------------------------
  arm("(i) paradrop-not-enemy-unit l.792-796", () => {
    const match = board();
    const rider = infantry("blue:inf:i", 80, 40);
    const defender = {
      id: "red:inf:i", side: "red", domain: "land", kind: "infantry", x: 84, y: 44,
      path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 60,
    };
    match.pieces.push(rider, defender);
    const order = paradrop(match, "blue", rider.id, { x: 84, y: 44 });
    if (!order.error) fail("a paradrop onto an enemy unit at 84,44 was ACCEPTED");
    if (rider.x !== 80 || rider.y !== 40) fail("the refused drop still moved the infantry");
    if (Number(defender.strength) !== 60) fail("the refused drop changed the defender's strength to " + defender.strength);
  });

  // ---- (j) the plane stays home and goes unready ----------------------------------------------
  arm("(j) paradrop-plane-home-unready l.793-795", () => {
    const match = board();
    const rider = infantry("blue:inf:j", 80, 40);
    match.pieces.push(rider);
    const plane = planeOf(match);
    const from = { x: plane.x, y: plane.y };
    paradrop(match, "blue", rider.id, { x: 84, y: 44 });
    if (plane.x !== from.x || plane.y !== from.y) fail("the paradrop moved the aircraft");
    if (rider.x !== 84 || rider.y !== 44) fail("the paradrop did not land the infantry at 84,44");
    const line = airBriefing(match, "blue").find((entry) => entry.id === plane.id);
    if (!line) fail("the aircraft is not in the seat briefing after the drop");
    if (line.ready === true) {
      fail("the aircraft is still READY after flying a paradrop; rule 2 is that it stays home and"
        + " goes unready (producer: web/server/air.mjs paradrop :509 takes no aircraft id and writes"
        + " no readiness byte) - DEVIATION, not fixed here");
    }
  });

  // ---- (k) the infantry pays a minor loss, and the amount is config's (GREEN) -------------------
  arm("(k) paradrop-loss l.796", () => {
    const combat = combatRules();
    const loss = combat.paradropLoss;
    if (!(loss > 0 && loss < 1)) fail("pb296 (k): config combat.paradropLoss is " + JSON.stringify(loss));
    const match = board();
    const rider = infantry("blue:inf:k", 80, 40, { strength: 100 });
    match.pieces.push(rider);
    const order = paradrop(match, "blue", rider.id, { x: 84, y: 44 });
    if (order.error) fail("a plain paradrop onto empty land was refused: " + order.error);
    const expected = Number((100 - 100 * loss).toFixed(2));
    if (Number(rider.strength) !== expected) {
      fail("the infantry landed at strength " + rider.strength + ", not 100 - 100 x config paradropLoss "
        + loss + " = " + expected + " (producer: web/server/air.mjs:526)");
    }
    const event = (order.events || []).find((entry) => entry.type === "paradrop");
    if (!event) fail("the paradrop emitted no event");
    if (Number(event.loss) !== Number((100 * loss).toFixed(2))) {
      fail("the event carries loss " + event.loss + ", not " + Number((100 * loss).toFixed(2)));
    }
    if (rider.entrenched === true) fail("the arrived infantry still reads entrenched");
  });

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red at f5a6109 - " + reds.join(" | "));
  }
}
