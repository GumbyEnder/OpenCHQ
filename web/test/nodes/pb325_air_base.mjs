// pb325_air_base — an aircraft's base is a RULE, not whichever site the array lists first.
//
// PB-325 (medium, port decision, original behaviour UNVERIFIED): base = the airstrip on the plane's
// own cell, else the nearest friendly airstrip by Chebyshev distance with x-wrap at 320, ties to the
// lower site id. Basis: manual p.24-25, the unit "remains at its original base".
//
// What breaks if this is removed: `baseFor` used `(match.sites || []).find(...)`, so the briefed base
// was the first friendly strip inside the reach radius in ARRAY order. A plane bought at London could
// be briefed from a strip on the other side of the map, and the Air dialog named a base the player
// never flew from.
//
// Every arm here is built so array order and the rule DISAGREE: the wrong site is listed first, so a
// passing arm is the rule and a red arm names which clause failed.

import { airBriefing } from "../../server/air.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "pb325_air_base";

const CELL_W = 320;

function plane(id, side, x, y) {
  return {
    id, side, domain: "land", kind: "aircraft", x, y,
    path: [], pace: 1, facing: null, fighting: null, shots: 0,
  };
}
const site = (id, name, kind, owner, x, y) => ({ id, name, kind, owner, x, y });

function matchWith(sites, pieces) {
  return { sites, pieces, round: 0, clock: "running" };
}

export async function run(ctx) {
  const { fail } = ctx;
  const air = rules().air || {};
  const reach = Number(air.reach);
  if (!(reach > 0)) fail("no aircraft reach is configured, so no base can be resolved");
  if (reach < 10) fail("this pin needs a reach of at least 10 to place its strips: " + reach);

  // ---- (a) the strip on the plane's own cell wins, even when a nearer-in-array strip exists ------
  // BOTH strips must be inside `reach`, or the arm cannot tell the rule from array order: a first-
  // listed strip the berth search would refuse anyway proves nothing. Paris is 4 cells away, so the
  // array-order `find` this replaces returns Paris - measured RED on the array-order mutant.
  {
    const far = site(10, "Paris", "city", "blue", 84, 40);       // listed FIRST, 4 cells away
    const own = site(11, "London", "city", "blue", 80, 40);      // the plane stands here
    const m = matchWith([far, own], [plane("p1", "blue", 80, 40)]);
    const base = (airBriefing(m, "blue")[0] || {}).base;
    if (base !== "London") {
      fail("(a) a plane standing on London was briefed from " + JSON.stringify(base) +
        " — the own-cell strip must win over array order");
    }
  }

  // ---- (b) a plane on a cell with no strip takes the NEAREST friendly strip, not the first listed -
  // Kiev is listed first and IS inside reach (d=6), so array order picks it; the rule picks Odessa.
  {
    const first = site(20, "Kiev", "base", "blue", 56, 50);       // d = 6, listed first, in reach
    const nearest = site(21, "Odessa", "base", "blue", 53, 50);    // d = 3, listed second
    // standing on an oil field: a friendly cell that is not an air strip
    const m = matchWith([first, nearest], [plane("p2", "blue", 50, 50)]);
    const base = (airBriefing(m, "blue")[0] || {}).base;
    if (base !== "Odessa") {
      fail("(b) the nearest strip on a non-strip cell is Odessa (d=3); the briefed base was " +
        JSON.stringify(base) + " — array order was " + JSON.stringify(first.name));
    }
  }

  // ---- (c) the x-wrap case: a strip six cells away across the seam beats one eight cells east ---
  {
    const east = site(30, "Vladivostok", "city", "blue", 10, 50);   // dx 8, listed first
    const across = site(31, "Nome", "city", "blue", 316, 50);       // dx |2-316| = 314 -> wrap 6
    const m = matchWith([east, across], [plane("p3", "blue", 2, 50)]);
    const base = (airBriefing(m, "blue")[0] || {}).base;
    const dx = Math.abs(2 - 316);
    if (Math.min(dx, CELL_W - dx) !== 6) fail("(c) the pin's own wrap arithmetic is wrong: " + dx);
    if (base !== "Nome") {
      fail("(c) the wrap strip Nome is 6 cells away and Vladivostok is 8; the briefed base was " +
        JSON.stringify(base) + " — the wrap at " + CELL_W + " was not applied");
    }
  }

  // ---- (d) a tie on distance goes to the lower site id ------------------------------------------
  {
    const higher = site(77, "Tripoli", "city", "blue", 54, 50);     // d = 4, id 77, listed first
    const lower = site(12, "Tunis", "city", "blue", 46, 50);        // d = 4, id 12
    const m = matchWith([higher, lower], [plane("p4", "blue", 50, 50)]);
    const base = (airBriefing(m, "blue")[0] || {}).base;
    if (base !== "Tunis") {
      fail("(d) two strips sit 4 cells away (ids 77 and 12); the tie must go to id 12 (Tunis), the " +
        "briefed base was " + JSON.stringify(base));
    }
  }

  // ---- (e) an enemy strip is never a base, and a friendly carrier still is ----------------------
  {
    const enemy = site(40, "Berlin", "city", "red", 52, 50);
    const m = matchWith([enemy], [
      plane("p5", "blue", 50, 50),
      { id: "c1", side: "blue", domain: "sea", kind: "carrier", x: 55, y: 50 },
    ]);
    const base = (airBriefing(m, "blue")[0] || {}).base;
    if (base !== "c1") {
      fail("(e) with only an ENEMY strip at 2 cells and a friendly carrier at 5, the base must be " +
        "the carrier (c1); it was " + JSON.stringify(base));
    }
  }

  // ---- (f) nothing in reach is no base, and that is not silently a wrong one --------------------
  {
    const far = site(50, "Sydney", "city", "blue", 200, 200);
    const m = matchWith([far], [plane("p6", "blue", 50, 50)]);
    const brief = airBriefing(m, "blue")[0] || {};
    if (brief.base !== null) fail("(f) a strip " + Math.max(150, 150) + " cells away was briefed as the base: " + JSON.stringify(brief.base));
    if (brief.canFly !== false) fail("(f) with no strip in reach canFly must be false: " + JSON.stringify(brief.canFly));
  }
}
