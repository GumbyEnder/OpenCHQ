// PB-296b pin: a PLANE-DRIVEN paradrop, manual printed p.25 rules 1-3:
//
//   (1) on land, not on an enemy city or an enemy unit;
//   (2) the plane stays home and goes unready;
//   (3) the infantry takes a minor loss - config combat.paradropLoss (0.25), a STAND-IN for a page
//       that prints no number.
//
// ...and the same sentence's last clause: "A carrier-based plane can do neither a loaded transfer nor
// a paradrop."
//
// Producer: web/server/air.mjs paradrop. Before this fix it took an infantry id and a cell and never
// named an aircraft at all, so a drop could not unready a plane, could not be refused for a
// carrier-based one, and was not checked for terrain or for the site it landed on - and no server op
// reached it. Arms (f), (g), (h), (j) are those deviations; (i) and (k) are the green controls that
// must stay green.
import { warMatch } from "../wartime.mjs";
import { airBriefing, paradrop } from "../../server/air.mjs";
import { combatRules } from "../../server/rules.mjs";
import { terrainNameAt } from "../../server/move.mjs";

export const name = "pb296b_paradrop";

const ROUND = 10;
const PLANE = "blue:air:296";

function board() {
  const match = warMatch("1986", []);
  match.round = ROUND;
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", type: 4, owner: "blue" },
    { id: 11, name: "Kiev", x: 82, y: 44, kind: "city", type: 4, owner: "red" },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 82, y: 44 } };
  match.pieces = [{
    id: PLANE, side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40,
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
    { id: PLANE, side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40, path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, inactiveUntil: 0 },
  ];
  return match;
}

const planeOf = (match) => match.pieces.find((piece) => piece.id === PLANE);

function waterCell() {
  for (let y = 20; y < 90; y += 1) {
    for (let x = 50; x < 110; x += 1) {
      if (terrainNameAt(x, y) === "ocean") return { x, y };
    }
  }
  return null;
}

// A land cell near the plane that is not a site: the drops that should be legal use it.
function landCell(match) {
  for (const [x, y] of [[81, 44], [83, 44], [81, 43], [80, 42], [82, 43], [80, 44]]) {
    if (terrainNameAt(x, y) === "ocean") continue;
    if ((match.sites || []).some((site) => Number(site.x) === x && Number(site.y) === y)) continue;
    return { x, y };
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const reds = [];
  const arm = (label, body) => {
    try {
      body();
      console.log("pb296b arm " + label + " ok");
    } catch (err) {
      reds.push("arm " + label + ": " + (err && err.message ? err.message : String(err)));
    }
  };

  // ---- (f) a carrier-based plane cannot paradrop ------------------------------------------------
  arm("(f) carrier-no-paradrop p.25", () => {
    const match = withCarrier(board());
    const rider = infantry("blue:inf:f", 80, 40);
    match.pieces.push(rider);
    const cell = landCell(match);
    const order = paradrop(match, "blue", rider.id, cell, PLANE);
    if (!order.error) {
      fail("a paradrop flown by a CARRIER-BASED aircraft was ACCEPTED; the printed page says a"
        + " carrier-based plane can do neither a loaded transfer nor a paradrop");
    } else if (!/carrier/i.test(order.error)) {
      fail("the refusal for a carrier-based drop does not name the carrier: " + order.error);
    }
    if (rider.x !== 80 || rider.y !== 40) fail("the refused carrier drop moved the infantry");
  });

  // ---- (g) a paradrop lands on land only --------------------------------------------------------
  arm("(g) paradrop-land-only p.25 r1", () => {
    const cell = waterCell();
    if (!cell) fail("pb296b (g): no ocean cell on this board (set OPENCHQ_DATA); the arm cannot measure the land rule");
    const match = board();
    const rider = infantry("blue:inf:g", 80, 40);
    match.pieces.push(rider);
    const order = paradrop(match, "blue", rider.id, cell, PLANE);
    if (!order.error) {
      fail("a paradrop onto OCEAN at " + cell.x + "," + cell.y + " was ACCEPTED (the infantry landed"
        + " on " + rider.x + "," + rider.y + "); rule 1 is land only");
    } else if (!/land/i.test(order.error)) {
      fail("the refusal for an ocean drop does not say the target must be land: " + order.error);
    }
    if (rider.x !== 80 || rider.y !== 40) fail("the refused ocean drop moved the infantry");
  });

  // ---- (h) a paradrop may not land on an enemy city ---------------------------------------------
  arm("(h) paradrop-not-enemy-city p.25 r1", () => {
    const match = board();
    const city = (match.sites || []).find((site) => site.owner === "red");
    const rider = infantry("blue:inf:h", 80, 40);
    match.pieces.push(rider);
    const order = paradrop(match, "blue", rider.id, { x: city.x, y: city.y }, PLANE);
    if (!order.error) {
      fail("a paradrop onto the empty ENEMY CITY " + city.name + " was ACCEPTED; rule 1 is \"not on"
        + " an enemy city\"");
    } else if (!/enemy|not yours|city/i.test(order.error)) {
      fail("the refusal for an enemy-city drop does not name the site: " + order.error);
    }
    if (rider.x !== 80 || rider.y !== 40) fail("the refused enemy-city drop moved the infantry");
  });

  // ---- (i) a paradrop may not land on an enemy unit (control) -----------------------------------
  arm("(i) paradrop-not-enemy-unit p.25 r1", () => {
    const match = board();
    const rider = infantry("blue:inf:i", 80, 40);
    const cell = landCell(match);
    const defender = {
      id: "red:inf:i", side: "red", domain: "land", kind: "infantry", x: cell.x, y: cell.y,
      path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 60,
    };
    match.pieces.push(rider, defender);
    const order = paradrop(match, "blue", rider.id, cell, PLANE);
    if (!order.error) fail("a paradrop onto an enemy unit at " + cell.x + "," + cell.y + " was ACCEPTED");
    if (rider.x !== 80 || rider.y !== 40) fail("the refused drop still moved the infantry");
    if (Number(defender.strength) !== 60) fail("the refused drop changed the defender's strength to " + defender.strength);
  });

  // ---- (j) the plane stays home and goes unready ------------------------------------------------
  arm("(j) paradrop-plane-home-unready p.25 r2", () => {
    const match = board();
    const rider = infantry("blue:inf:j", 80, 40);
    match.pieces.push(rider);
    const cell = landCell(match);
    const plane = planeOf(match);
    const from = { x: plane.x, y: plane.y };
    const order = paradrop(match, "blue", rider.id, cell, PLANE);
    if (order.error) fail("a plain paradrop onto empty land was refused: " + order.error);
    if (plane.x !== from.x || plane.y !== from.y) fail("the paradrop moved the aircraft");
    if (rider.x !== cell.x || rider.y !== cell.y) fail("the paradrop did not land the infantry at " + cell.x + "," + cell.y);
    const line = airBriefing(match, "blue").find((entry) => entry.id === plane.id);
    if (!line) fail("the aircraft is not in the seat briefing after the drop");
    else if (line.ready === true) {
      fail("the aircraft is still READY after flying a paradrop; rule 2 is that it stays home and"
        + " goes unready");
    } else if (Number(line.roundsLeft) <= 0) {
      fail("the aircraft owes no rounds after the drop (roundsLeft " + line.roundsLeft + ")");
    }
  });

  // ---- (k) the infantry pays config's paradropLoss (control) ------------------------------------
  arm("(k) paradrop-loss p.25 r3", () => {
    const combat = combatRules();
    const loss = combat.paradropLoss;
    if (!(loss > 0 && loss < 1)) fail("pb296b (k): config combat.paradropLoss is " + JSON.stringify(loss));
    const match = board();
    const rider = infantry("blue:inf:k", 80, 40, { strength: 100 });
    match.pieces.push(rider);
    const cell = landCell(match);
    const order = paradrop(match, "blue", rider.id, cell, PLANE);
    if (order.error) fail("a plain paradrop onto empty land was refused: " + order.error);
    const expected = Number((100 - 100 * loss).toFixed(2));
    if (Number(rider.strength) !== expected) {
      fail("the infantry landed at strength " + rider.strength + ", not 100 - 100 x config paradropLoss "
        + loss + " = " + expected);
    }
    const event = (order.events || []).find((entry) => entry.type === "paradrop");
    if (!event) fail("the paradrop emitted no event");
    else if (Number(event.loss) !== Number((100 * loss).toFixed(2))) {
      fail("the event carries loss " + event.loss + ", not " + Number((100 * loss).toFixed(2)));
    }
    if (String(event && event.planeId) !== PLANE) fail("the drop event does not name the aircraft that flew it");
    if (rider.entrenched === true) fail("the arrived infantry still reads entrenched");
  });

  // ---- (m) an inactive plane cannot fly a drop --------------------------------------------------
  arm("(m) paradrop-needs-a-ready-plane p.25", () => {
    const match = board();
    const rider = infantry("blue:inf:m", 80, 40);
    match.pieces.push(rider);
    planeOf(match).inactiveUntil = ROUND + 4;
    const cell = landCell(match);
    const order = paradrop(match, "blue", rider.id, cell, PLANE);
    if (!order.error) {
      fail("an INACTIVE aircraft flew a paradrop; the drop is a mission and an inactive aircraft"
        + " may fly CAP alone (PB-293, p.24)");
    }
    if (rider.x !== 80 || rider.y !== 40) fail("the refused drop moved the infantry");
  });

  // ---- (n) a drop without an aircraft is refused, not silently flown by nobody -----------------
  arm("(n) paradrop-needs-an-aircraft p.25", () => {
    const match = board();
    const rider = infantry("blue:inf:n", 80, 40);
    match.pieces.push(rider);
    const cell = landCell(match);
    const order = paradrop(match, "blue", rider.id, cell);
    if (!order.error) fail("a paradrop with NO aircraft id was ACCEPTED");
    else if (!/aircraft|plane/i.test(order.error)) {
      fail("the refusal for a drop with no aircraft does not name the aircraft: " + order.error);
    }
  });

  // ---- the manual's loss provenance is the page's, not p.50 -------------------------------------
  arm("(o) loss-source p.22/p.25 r3", () => {
    const entry = (ctx.config && ctx.config.combat && ctx.config.combat.paradropLoss) || {};
    const source = String(entry.source || "");
    if (!/UNMEASURED|UNVERIFIED/.test(source)) {
      fail("combat.paradropLossSource does not carry its UNVERIFIED/UNMEASURED tag: " + JSON.stringify(source));
    }
    if (/p\.50|page 50/.test(source)) {
      fail("combat.paradropLossSource still cites p.50; PM 9860 §4 moves it to p.22 / p.25 r3: "
        + JSON.stringify(source));
    }
  });

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red: " + reds.join(" | "));
  }
}
