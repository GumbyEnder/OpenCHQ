// Node test: PB-154 — readiness uses the original's formula (FUN_2dfc_1874 @ 2dfc:1874).
//
// The decoded rule, as implemented in web/server/readiness.mjs:
//   caps  = 1 + the side's owned capitals (type 1/2) among records 0-63
//   list  = the build site + every site of the side among records 0-63 with d^2 < 401
//           (Euclidean, X wrapped at 320); the build site is counted TWICE
//   total = sum of the listed sites' current remaining timers
//           + floor(floor(price_b * 80 / 3) / caps)
//   each listed site's remaining timer = floor(total / count), +1 when total % count > count / 2
// Timers drop by 1 per round. In the concealed era, capitals are exempt for the first five builds.
//
// Acceptance criterion 1 (the worked example) is the literal arithmetic: 1 capital, a 10 b
// infantry, 5 other friendly ready sites inside 20 cells -> floor(266/2)=133, count 7, 19 rounds.
// AC2: one neighbour already at 30 -> floor((133+30)/7)=23, shorter than before. AC3: a friendly
// site 21 cells away is untouched. AC4: a 20 b tank and a 20 b aircraft give floor(533/2)=266
// before pooling, i.e. 38 after it.

import { warMatch } from "../wartime.mjs";
import {
  capitalDivisor,
  isSiteReady,
  poolReadiness,
  readinessNeighbours,
  readyRoundOf,
} from "../../server/readiness.mjs";
import { readinessRules } from "../../server/rules.mjs";

export const name = "pb154_readiness";

function must(cond, message, fail) {
  if (!cond) fail(message);
}

function eq(actual, expected, label, fail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// One blue capital far outside the 20-cell radius (caps still counts it anywhere among records),
// the build city, five friendly cities inside the radius, one 21 cells away, plus a type-5 oil
// field and a dock that must never be listed.
function fixture(era = "1986") {
  const match = warMatch(era, []);
  match.sites = [
    { id: 0, name: "Capital", kind: "capital", type: 1, x: 100, y: 100, owner: "blue" },
    { id: 10, name: "Build", kind: "city", type: 4, x: 50, y: 50, owner: "blue" },
    { id: 11, name: "N1", kind: "city", type: 4, x: 51, y: 50, owner: "blue" },
    { id: 12, name: "N2", kind: "city", type: 4, x: 52, y: 50, owner: "blue" },
    { id: 13, name: "N3", kind: "city", type: 4, x: 53, y: 50, owner: "blue" },
    { id: 14, name: "N4", kind: "city", type: 4, x: 54, y: 50, owner: "blue" },
    { id: 15, name: "N5", kind: "city", type: 4, x: 55, y: 50, owner: "blue" },
    { id: 16, name: "Far21", kind: "city", type: 4, x: 71, y: 50, owner: "blue" },
    { id: 64, name: "Oil", kind: "facility", type: 5, x: 50, y: 51, owner: "blue" },
    { id: "dock:50:49", name: "Dock", kind: "dock", x: 50, y: 49, owner: "blue" },
    { id: 20, name: "RedCity", kind: "city", type: 4, x: 51, y: 51, owner: "red" },
  ];
  match.pieces = [];
  match.round = 0;
  match.sides.blue.bought = 0;
  match.sides.red.bought = 0;
  return match;
}

const site = (match, id) => match.sites.find((entry) => entry.id === id);

export async function run(ctx) {
  const { fail } = ctx;

  // ---- the constants are the decoded ones, not the retired stand-ins ---------------------
  {
    const rules = readinessRules();
    eq(rules.radiusSq, 401, "readiness radiusSq", fail);
    eq(rules.priceScaleNumerator, 80, "readiness price scale numerator", fail);
    eq(rules.priceScaleDenominator, 3, "readiness price scale denominator", fail);
    eq(rules.capitalBase, 1, "readiness capital base", fail);
    must(!("roundsPerBillion" in rules) && !("cityWeight" in rules) && !("capitalWeight" in rules),
      "the retired stand-ins are still in the rules block", fail);
    console.log("pb154 constants ok: radiusSq 401, price 80/3, capital base 1; stand-ins gone");
  }

  // ---- AC1: the worked example -----------------------------------------------------------
  {
    const match = fixture();
    eq(capitalDivisor(match, "blue"), 2, "1 owned capital -> caps 2", fail);
    const listed = readinessNeighbours(match, "blue", site(match, 10));
    eq(listed.length, 6, "six unique sites are inside the radius (build site, 5 neighbours)", fail);
    must(!listed.includes(site(match, 16)), "the site 21 cells away is in the list", fail);
    must(!listed.includes(site(match, 64)), "a type-5 oil field is in the readiness list", fail);
    must(!listed.includes(site(match, "dock:50:49")), "a dock is in the readiness list", fail);

    const marked = poolReadiness(match, "blue", site(match, 10), "infantry");
    eq(marked.rounds, 19, "AC1: floor(floor(10*80/3)/2)=133 over count 7 -> 19 rounds", fail);
    eq(marked.round, 19, "AC1: ready round at round 0", fail);
    eq(readyRoundOf(site(match, 10)), 19, "the build city's timer", fail);
    for (const id of [11, 12, 13, 14, 15]) {
      eq(readyRoundOf(site(match, id)), 19, "neighbour " + id + " is pulled to the same timer", fail);
    }
    eq(readyRoundOf(site(match, 16)), 0, "AC3: the site 21 cells away is untouched", fail);
    eq(readyRoundOf(site(match, 64)), 0, "an oil field carries no readiness timer", fail);
    eq(readyRoundOf(site(match, "dock:50:49")), 0, "a dock carries no readiness timer", fail);
    eq(readyRoundOf(site(match, 0)), 0, "a capital outside the radius is untouched", fail);
    console.log("pb154 AC1 ok: 10 b infantry, caps 2, count 7 -> 19 rounds on the build site and its 5 neighbours");
  }

  // ---- AC2: an existing timer is pooled, so the new value can be SHORTER -----------------
  {
    const match = fixture();
    site(match, 15).readyRound = 30; // remaining 30 at round 0
    const marked = poolReadiness(match, "blue", site(match, 10), "infantry");
    // total = 133 base + 30 = 163; count 7; floor(163/7) = 23, 163 % 7 = 2 (not > 3.5).
    eq(marked.rounds, 23, "AC2: floor((133+30)/7) = 23", fail);
    eq(readyRoundOf(site(match, 15)), 23, "AC2: the 30-round neighbour got shorter, not longer", fail);
    must(23 < 30, "AC2: the pooled timer must be shorter than the neighbour's old timer", fail);
    console.log("pb154 AC2 ok: a neighbour at 30 remaining joins the pool and lands at 23");
  }

  // ---- AC4: the tank and the aircraft -----------------------------------------------------
  {
    for (const kind of ["tank", "aircraft"]) {
      const match = fixture();
      const marked = poolReadiness(match, "blue", site(match, 10), kind);
      // floor(20*80/3) = 533; /2 = 266; count 7 -> 38, remainder 0.
      eq(marked.rounds, 38, `AC4: ${kind} (20 b) gives floor(533/2)=266 over 7 -> 38`, fail);
    }
    console.log("pb154 AC4 ok: tank and aircraft (20 b) both pool to 38 rounds");
  }

  // ---- a second capital divides the base further: caps is 1 + owned capitals --------------
  {
    const match = fixture();
    match.sites.push({ id: 1, name: "Capital2", kind: "capital", type: 2, x: 120, y: 100, owner: "blue" });
    eq(capitalDivisor(match, "blue"), 3, "two owned capitals -> caps 3", fail);
    const marked = poolReadiness(match, "blue", site(match, 10), "infantry");
    // floor(266/3) = 88; count 7 -> 12, 88 % 7 = 4 > 3.5 -> +1 = 13.
    eq(marked.rounds, 13, "caps 3 pools to 13 rounds (the half-count rounding rule)", fail);
    console.log("pb154 caps ok: two capitals divide the base by 3 and the remainder rounds up");
  }

  // ---- timers drop by 1 per round ---------------------------------------------------------
  {
    const match = fixture();
    match.round = 5;
    const marked = poolReadiness(match, "blue", site(match, 10), "infantry");
    eq(marked.round, 24, "a round-5 build with 19 pooled rounds is ready at 24", fail);
    must(!isSiteReady(site(match, 10), 23), "ready one round early", fail);
    must(isSiteReady(site(match, 10), 24), "not ready on its own ready round", fail);
    must(isSiteReady(site(match, 10), 25), "not ready after its ready round", fail);
    console.log("pb154 timer ok: unready at 23, ready at 24, still ready at 25");
  }

  // ---- the concealed era exempts capitals for a side's first five builds -----------------
  {
    const match = fixture("9999");
    // Put the capital INSIDE the radius so the exemption is observable. count becomes 8
    // (7 unique sites + the build site counted twice).
    site(match, 0).x = 50;
    site(match, 0).y = 52;
    const exempt = poolReadiness(match, "blue", site(match, 10), "infantry");
    // caps 2; floor(266/2)=133; count 8 -> floor(133/8)=16, 5 > 4 -> +1 = 17.
    eq(exempt.rounds, 17, "concealed era, first build: pooled timer with the capital in the list", fail);
    eq(readyRoundOf(site(match, 0)), 0, "build 1: the capital is exempt and keeps its timer", fail);
    eq(readyRoundOf(site(match, 10)), 17, "build 1: the city is still tired", fail);
    match.sides.blue.bought = 5;
    for (const entry of match.sites) delete entry.readyRound;
    const tired = poolReadiness(match, "blue", site(match, 10), "infantry");
    eq(tired.rounds, 17, "concealed era, sixth build: same pool", fail);
    eq(readyRoundOf(site(match, 0)), 17, "build 6: the capital is tired like any other site", fail);
    console.log("pb154 concealed ok: capitals exempt for builds 1-5 (counter 0x1580), tired from build 6");
  }

  console.log("pb154_readiness ok: constants, worked example, pooling, rounding, timer decay, exemption");
}
