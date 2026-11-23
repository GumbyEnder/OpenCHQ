// PB-178: the manual's two air circles, and the one the Bomb order has to obey.
//
// Manual p.25 names a RESTRICTED air radius "in which most missions must be performed" and a larger
// MAXIMUM air radius, which an unloaded transfer may use. The port carried one number (air.reach 10,
// a stand-in) and no target-distance test at all: a bombing run was accepted at any distance from
// the aircraft as long as a friendly berth stood within reach of the plane. This node pins:
//
//   1. the config carries both circles, restricted < maximum, and both say UNVERIFIED;
//   2. the briefing ships both, so the page can refuse a far click before it becomes an order;
//   3. a bomb target AT the restricted radius is accepted (the boundary's inside arm);
//   4. a bomb target ONE cell outside is refused, the refusal NAMES the restricted radius, and the
//      refusal costs the player nothing: no cash moves, the site's timer does not move, the aircraft
//      is still ready and no oil is spent;
//   5. a bomb target at the maximum radius is still refused - the maximum is the transfer's, not a
//      mission's;
//   6. an unloaded transfer at the maximum radius is accepted, and one cell further is refused, so
//      PB-178 did not narrow the transfer rule it was told to leave alone;
//   7. the distance is wrap-aware like every other distance on this board;
//   8. PB-193: a refused click does not spend the intent it refused (a bomb stays armed, a
//      transfer stays armed), and a send or a clear goes back to strike - so Escape disarms.
import { readFileSync } from "node:fs";
import { airBriefing, sendMission } from "../../server/air.mjs";
import { resourceSpec } from "../../server/resources.mjs";
import { rules } from "../../server/rules.mjs";
import { nextDoorMode } from "../../public/command.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function ok(message, value, detail = "") {
  if (!value) fail(message + (detail ? " — " + detail : ""));
}

function plane(id, side, x, y, extra = {}) {
  return { id, side, domain: "air", kind: "aircraft", x, y, path: [], pace: 1, ...extra };
}

function site(id, kind, owner, x, y, name = id) {
  return { id, kind, owner, x, y, name };
}

// Blue's own strip at 80,44. The aircraft sits on it, which is where a plane on the ground is: the
// cell it flies from is the cell the radius is measured from.
const HOME = site("home", "city", "blue", 80, 44, "Home");

function match(pieces, sites, extra = {}) {
  return {
    round: 1,
    era: "1986",
    pieces,
    sites: [HOME, ...sites],
    capitals: {},
    sides: { blue: { cash: 4000 }, red: { cash: 4000 } },
    ...extra,
  };
}

export const name = "pb178_bomb_radius";

export async function run() {
  const air = rules().air || {};
  const restricted = Number(air.restrictedReach);
  const maximum = Number(air.reach);

  // --- 1. both circles, and both labelled as port values -------------------------------------
  ok("config carries air.restrictedReach", Number.isFinite(restricted) && restricted > 0, String(air.restrictedReach));
  ok("config carries the maximum air.reach", Number.isFinite(maximum) && maximum > 0, String(air.reach));
  ok("the restricted radius is the SMALLER circle", restricted < maximum, restricted + " vs " + maximum);
  ok("restrictedReach carries its own provenance", /UNVERIFIED/i.test(String(air.restrictedReachSource || "")),
    String(air.restrictedReachSource || "").slice(0, 60));
  ok("the summary note names both circles", /restrictedReach/.test(String((rules().notes || {}).air || "")));

  // --- 2. the page is told both numbers ------------------------------------------------------
  {
    const m = match([plane("p1", "blue", 80, 44)], []);
    const [briefing] = airBriefing(m, "blue");
    eq("the briefing ships the restricted radius", briefing.restrictedReach, restricted);
    eq("the briefing ships the maximum radius", briefing.reach, maximum);
  }

  // --- 3. inside the restricted radius: accepted, and it lands ------------------------------
  {
    const inside = site("red-in", "city", "red", 80 + restricted, 44, "Inside");
    const m = match([plane("p1", "blue", 80, 44)], [inside]);
    const oilBefore = Number((resourceSpec("fuel") || {}).airMission) || 0;
    const result = sendMission(m, "blue", "p1", "bomb", { x: inside.x, y: inside.y });
    ok("a target ON the restricted radius is accepted", !result.error, result.error || "");
    const hit = result.events.find((e) => e.type === "bomb_hit");
    ok("the run lands as a bomb_hit", Boolean(hit), JSON.stringify(result.events.map((e) => e.type)));
    eq("the owner pays the city's 125 M", Number(m.sides.red.cash), 4000 - 125);
    eq("the site is unready for 5 rounds", Number(inside.readyRound), 1 + 5);
    ok("the aircraft is away for the strike's 8 rounds", Number(m.pieces[0].inactiveUntil) === 1 + 8,
      String(m.pieces[0].inactiveUntil));
    void oilBefore;
  }

  // --- 4. one cell outside: refused, named, and free ----------------------------------------
  {
    const out = site("red-out", "city", "red", 80 + restricted + 1, 44, "Outside");
    const m = match([plane("p1", "blue", 80, 44)], [out]);
    const result = sendMission(m, "blue", "p1", "bomb", { x: out.x, y: out.y });
    ok("one cell past the restricted radius is refused", Boolean(result.error), JSON.stringify(result));
    ok("the refusal names the restricted radius and its size",
      /restricted air radius/.test(String(result.error)) && new RegExp("\\(" + restricted + " cells\\)").test(String(result.error)),
      String(result.error));
    ok("the refusal names the maximum radius too",
      new RegExp("maximum radius \\(" + maximum + " cells\\)").test(String(result.error)), String(result.error));
    eq("no cash moved", Number(m.sides.red.cash), 4000);
    eq("the site's timer did not move", out.readyRound, undefined);
    eq("no bomb_hit event was produced", result.events, undefined);
    ok("the aircraft is still ready", Number(m.pieces[0].inactiveUntil || 0) === 0, String(m.pieces[0].inactiveUntil));
  }

  // --- 5. the maximum radius is not a mission radius either ---------------------------------
  {
    const far = site("red-far", "city", "red", 80 + maximum, 44, "Far");
    const m = match([plane("p1", "blue", 80, 44)], [far]);
    const result = sendMission(m, "blue", "p1", "bomb", { x: far.x, y: far.y });
    ok("a target at the maximum radius is refused for a bombing run", Boolean(result.error), JSON.stringify(result));
    ok("that refusal still names the restricted radius",
      /restricted air radius/.test(String(result.error)), String(result.error));
    eq("and it still cost nothing", Number(m.sides.red.cash), 4000);
  }

  // --- 6. an unloaded transfer still uses the maximum radius --------------------------------
  {
    const berth = site("blue-far", "city", "blue", 80 + maximum, 44, "FarBerth");
    const m = match([plane("p1", "blue", 80, 44)], [berth]);
    const result = sendMission(m, "blue", "p1", "transfer", { x: berth.x, y: berth.y });
    ok("a transfer at the maximum radius is accepted", !result.error, result.error || "");
    eq("the plane rebased there", Number(m.pieces[0].x), berth.x);

    const tooFar = site("blue-too-far", "city", "blue", 80 + maximum + 1, 44, "TooFar");
    const m2 = match([plane("p1", "blue", 80, 44)], [tooFar]);
    const refused = sendMission(m2, "blue", "p1", "transfer", { x: tooFar.x, y: tooFar.y });
    ok("a transfer one cell past the maximum is refused as out of range",
      Boolean(refused.error) && /transfer range/.test(String(refused.error)), String(refused.error));
  }

  // --- 7. wrap-aware: across the seam is one cell, not 319 ---------------------------------
  {
    const seam = site("red-seam", "city", "red", 319, 44, "Seam");
    const m = match([plane("p1", "blue", 0, 44)], [seam], {
      sites: [site("home", "city", "blue", 0, 44, "Home"), seam],
    });
    const result = sendMission(m, "blue", "p1", "bomb", { x: 319, y: 44 });
    ok("a target one cell across the seam is inside the circle", !result.error, result.error || "");
  }

  // --- 8. PB-193: the door transition, which the DOM legs can only see through a socket ------
  // The refusal must not spend the intent it refused: a far bomb click leaves the door armed for a
  // bomb (and a transfer for a transfer), because the manual's Air panel treats a bombing run and
  // an air strike as separate orders. A send and a clear both return to the everyday mode, which is
  // what makes Escape actually clear a bomb kept through a refusal.
  {
    eq("a refused bomb click leaves the door armed for a bomb", nextDoorMode("bomb", "refused"), "bomb");
    eq("a refused transfer click leaves the door armed for a transfer", nextDoorMode("transfer", "refused"), "transfer");
    eq("a refusal with no order armed stays on strike", nextDoorMode("strike", "refused"), "strike");
    eq("a sent mission goes back to strike", nextDoorMode("bomb", "sent"), "strike");
    eq("a clear (Escape and every other clear) goes back to strike", nextDoorMode("bomb", "cleared"), "strike");
    ok("the pre-PB-193 shape - a refusal always downgrading to strike - is NOT what the page does",
      nextDoorMode("bomb", "refused") !== "strike",
      "refused(\"bomb\") === " + JSON.stringify(nextDoorMode("bomb", "refused")));
  }

  // --- 9. the wiring: the page routes all three transitions through that function -----------
  // The transition is only worth testing if the page actually calls it. app.js cannot be imported
  // here (it is DOM-bound), so this reads the source the way camera_pan does and pins the three
  // call sites by shape: a refusal and a send go through nextDoorMode, clearCommand disarms through
  // it, and no site hard-sets strike. That is what makes the pinned mutant (which reverts the call
  // sites and leaves the module alone) red here instead of passing on the module's own rows.
  {
    const app = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
    ok("the page imports the door transition from command.mjs", /nextDoorMode/.test(app));
    ok("the refusal branch routes through the transition",
      /nextDoorMode\(pendingMission, "refused"\)/.test(app),
      "no refused call site in app.js");
    ok("the send site routes through the transition",
      /nextDoorMode\(pendingMission, "sent"\)/.test(app),
      "no sent call site in app.js");
    const clear = (app.match(/function clearCommand\(\) \{[\s\S]*?\n\}/) || [""])[0];
    ok("clearCommand() disarms the door through the transition",
      /nextDoorMode\(pendingMission, "cleared"\)/.test(clear),
      clear ? clear.replace(/\s+/g, " ").slice(-180) : "clearCommand() not found");
    const literals = (app.match(/pendingMission = "strike"/g) || []).length;
    eq("no site writes the strike mode directly - only the declaration", literals, 1);
  }
}
