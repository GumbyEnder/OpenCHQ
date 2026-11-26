// PB-296a pin: a LOADED air transfer, manual printed p.25:
//
//   "A loaded transfer needs infantry within 3 spaces of the plane's START and entrenched, with the
//    destination a friendly city or base inside the restricted radius. A carrier-based plane can do
//    neither a loaded transfer nor a paradrop."
//
// ...and the readiness half, printed p.25 and p.22: the air unit becomes unready when it flies.
//
// Arms (a)-(e) are the loaded-transfer rules; (l) is transfer-unready-owed, which PM 9860 §3 put on
// 296a "covering both unloaded and loaded". Producer: web/server/air.mjs transferPlane (reached
// through sendMission(..., "transfer", target)). Before this fix the target's `load` key was unknown
// and ignored - the plane rebased alone - which is what arm (a) measures.
//
// The 3-cell loader radius is the PRINTED page's number, not a recovered one: config/game.json has no
// key for it, and air.mjs carries LOAD_CELLS = 3 with its citation rather than inventing a lever
// nothing else reads. The destination circle is the existing air.restrictedReach (PB-178).
import { warMatch } from "../wartime.mjs";
import { airBriefing, sendMission } from "../../server/air.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "pb296a_transfer_load";

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
const riderOf = (match, id) => match.pieces.find((piece) => piece.id === id);

export async function run(ctx) {
  const { fail } = ctx;
  const reds = [];
  const arm = (label, body) => {
    try {
      body();
      console.log("pb296a arm " + label + " ok");
    } catch (err) {
      reds.push("arm " + label + ": " + (err && err.message ? err.message : String(err)));
    }
  };
  const air = rules().air || {};
  const restricted = Number(air.restrictedReach);
  const reach = Number(air.reach);

  // ---- (a) a loaded transfer carries the infantry to the destination -----------------------------
  arm("(a) loaded-transfer-carries p.25", () => {
    const match = board();
    const rider = infantry("blue:inf:a", 81, 41);
    match.pieces.push(rider);
    const order = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: rider.id });
    if (order.error) fail("a loaded transfer with the infantry one cell from the plane was refused: " + order.error);
    const plane = planeOf(match);
    if (plane.x !== 83 || plane.y !== 43) fail("the plane did not rebase (at " + plane.x + "," + plane.y + ")");
    if (rider.x !== 83 || rider.y !== 43) {
      fail("the infantry stayed at " + rider.x + "," + rider.y + " while its plane rebased to 83,43;"
        + " a loaded transfer carries it (web/server/air.mjs transferPlane) - the page p.25 rule");
    }
    if (rider.entrenched === true) fail("the carried infantry still reads entrenched after the move");
    if (plane.loaded) fail("the plane still reads loaded after the transfer landed");
    const event = (order.events || []).find((entry) => entry.type === "transfer");
    if (!event) fail("the loaded transfer emitted no transfer event");
    else if (String(event.load) !== rider.id) {
      fail("the transfer event does not name the infantry it carried (event.load " + JSON.stringify(event.load) + ")");
    }
  });

  // ---- (b) the loader must be within 3 cells of the plane's START -------------------------------
  arm("(b) load-radius p.25", () => {
    const far = board();
    const outsider = infantry("blue:inf:b1", 84, 40);
    far.pieces.push(outsider);
    const refused = sendMission(far, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: outsider.id });
    if (!refused.error) {
      fail("a loaded transfer with the infantry 4 cells from the plane's start was ACCEPTED; the"
        + " printed page allows 3");
    } else if (!/3 cells|within 3/.test(refused.error)) {
      fail("the refusal for a loader 4 cells away does not name the 3-cell rule: " + refused.error);
    }
    if (outsider.x !== 84 || outsider.y !== 40) fail("the refused loaded transfer moved the loader");
    // control: exactly 3 cells is inside the rule.
    const edge = board();
    const inside = infantry("blue:inf:b2", 83, 40);
    edge.pieces.push(inside);
    const ok = sendMission(edge, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: inside.id });
    if (ok.error) fail("a loader exactly 3 cells from the start was refused: " + ok.error);
    if (inside.x !== 83 || inside.y !== 43) fail("the control loader did not land with the plane");
  });

  // ---- (c) the loader must be entrenched --------------------------------------------------------
  arm("(c) load-entrenched p.25", () => {
    const match = board();
    const loose = infantry("blue:inf:c", 81, 41, { entrenched: false });
    match.pieces.push(loose);
    const refused = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: loose.id });
    if (!refused.error) {
      fail("a loaded transfer loaded an infantry that was NOT entrenched; the printed page requires"
        + " an entrenched loader");
    } else if (!/entrench/i.test(refused.error)) {
      fail("the refusal for an unentrenched loader does not name entrenchment: " + refused.error);
    }
    if (loose.x !== 81 || loose.y !== 41) fail("the refused loaded transfer moved the unentrenched infantry");
    // control: the same cell, entrenched, is accepted.
    const armed = board();
    const dug = infantry("blue:inf:c2", 81, 41);
    armed.pieces.push(dug);
    const ok = sendMission(armed, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: dug.id });
    if (ok.error) fail("an entrenched loader one cell away was refused: " + ok.error);
  });

  // ---- (d) a LOADED destination must be inside the restricted radius ----------------------------
  arm("(d) load-restricted-radius p.25", () => {
    if (!(restricted > 0) || !(reach > restricted)) {
      fail("pb296a (d): config air.restrictedReach/air.reach are " + restricted + "/" + reach
        + "; the arm needs a restricted circle smaller than the maximum");
    }
    const match = board();
    const rider = infantry("blue:inf:d", 81, 41);
    match.pieces.push(rider);
    // Far Base sits 8 cells from the plane's start: outside the restricted 6, inside the max 10.
    const refused = sendMission(match, "blue", "blue:air:296", "transfer", { x: 88, y: 40, load: rider.id });
    if (!refused.error) {
      fail("a LOADED transfer to a base " + (88 - 80) + " cells away was ACCEPTED; a loaded transfer's"
        + " destination must lie inside the restricted air radius (" + restricted + "), and only an"
        + " unloaded transfer may use the maximum (" + reach + ")");
    }
    if (planeOf(match).x !== 80) fail("the refused loaded transfer rebased the plane");
    if (rider.x !== 81 || rider.y !== 41) fail("the refused loaded transfer moved the infantry");
    // control: the same destination, unloaded, is inside air.reach and must be accepted.
    const empty = board();
    const ok = sendMission(empty, "blue", "blue:air:296", "transfer", { x: 88, y: 40 });
    if (ok.error) fail("an UNLOADED transfer inside the maximum radius was refused: " + ok.error);
    if (planeOf(empty).x !== 88) fail("the unloaded control transfer did not rebase the plane");
  });

  // ---- (e) a carrier-based plane makes no loaded transfer ---------------------------------------
  arm("(e) carrier-no-loaded-transfer p.25", () => {
    const match = withCarrier(board());
    const rider = infantry("blue:inf:e", 81, 41);
    match.pieces.push(rider);
    const refused = sendMission(match, "blue", "blue:air:296", "transfer", { x: 83, y: 43, load: rider.id });
    if (!refused.error) {
      fail("a CARRIER-BASED aircraft made a loaded transfer and it was ACCEPTED; the printed page says"
        + " a carrier-based plane can do neither a loaded transfer nor a paradrop");
    } else if (!/carrier/i.test(refused.error)) {
      fail("the refusal for a carrier-based loaded transfer does not name the carrier: " + refused.error);
    }
    if (rider.x !== 81 || rider.y !== 41) fail("the refused carrier loaded transfer moved the infantry");
    // control: an UNLOADED rebase from a carrier is still legal (the page forbids only the loaded one).
    const empty = withCarrier(board());
    const ok = sendMission(empty, "blue", "blue:air:296", "transfer", { x: 83, y: 43 });
    if (ok.error) fail("an unloaded transfer of a carrier-based plane was refused: " + ok.error);
  });

  // ---- (l) a transfer leaves the plane unready, loaded or not -----------------------------------
  arm("(l) transfer-unready-owed p.25/p.22", () => {
    const cost = Number(air.transferRounds);
    if (!(cost > 0)) {
      fail("pb296a (l): config air.transferRounds is " + JSON.stringify(air.transferRounds)
        + "; the printed page says the air unit becomes unready, so a 0-round transfer cannot"
        + " satisfy it (air.transferRoundsSource)");
    }
    for (const load of [false, true]) {
      const match = board();
      const rider = infantry("blue:inf:l", 81, 41);
      if (load) match.pieces.push(rider);
      const order = sendMission(match, "blue", "blue:air:296", "transfer",
        load ? { x: 83, y: 43, load: rider.id } : { x: 83, y: 43 });
      if (order.error) {
        fail("the " + (load ? "loaded" : "unloaded") + " transfer was refused: " + order.error);
        continue;
      }
      const plane = planeOf(match);
      const until = Number(plane.inactiveUntil);
      const owed = until - ROUND;
      if (!(owed === cost)) {
        fail("the " + (load ? "loaded" : "unloaded") + " transfer left the plane owed " + owed
          + " rounds (inactiveUntil " + JSON.stringify(plane.inactiveUntil) + "), not config's " + cost);
      }
      const line = airBriefing(match, "blue").find((entry) => entry.id === plane.id);
      if (!line) fail("the plane left the seat briefing after the transfer");
      else if (line.ready === true) {
        fail("the " + (load ? "loaded" : "unloaded") + " transfer left the plane READY; the printed"
          + " page says the air unit becomes unready");
      }
    }
  });

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red: " + reds.join(" | "));
  }
}
