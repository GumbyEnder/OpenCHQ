// PB-163 companion: the readiness POOL's membership, pinned on the Detroit case and a second city.
//
// The PM's live finding (room 7822) is that Detroit's pool is ELEVEN unique sites, not the eight that
// were visible in the panel: Norfolk, New Orleans and Houston sit inside the decoded radius (d^2 <
// 401 with X wrapped at 320) and must be unready with Detroit. A pool that quietly dropped them
// would still produce a plausible timer, so membership is the thing worth pinning, not just the
// number.
//
// Rule under test (DECODED, FUN_2dfc_1874, PB-154): the pool is the build site plus every producing
// record of the side with d^2 < 401; the build site is listed a second time; timers pool across the
// list. Numbers below are the 1986 Blue opening at round 0 with a 10 b infantry.
import { boardPayload, matchSites } from "../../server/board.mjs";
import { poolReadiness } from "../../server/readiness.mjs";

export const name = "pb163_readiness_pool";

function fail(message) {
  throw new Error("node test pb163_readiness_pool: " + message);
}

function eq(actual, expected, label) {
  if (actual !== expected) fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function distanceSq(a, b) {
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, 320 - dx);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return wrap * wrap + dy * dy;
}

export async function run(ctx) {
  const board = boardPayload();
  if (!Array.isArray(board.cells) || board.source !== "extract") {
    ctx.skip("no board extract on this host, so the era's site table cannot be read");
    return;
  }

  const poolFor = (city) => {
    const fresh = matchSites("1986", board);
    const match = { era: "1986", round: 0, sites: fresh, sides: { blue: { bought: 0 } } };
    const site = fresh.find((row) => row.name === city);
    if (!site) fail("the 1986 extract has no " + city);
    const out = poolReadiness(match, "blue", site, "infantry");
    return {
      site,
      rounds: out.rounds,
      roundAt: out.round,
      names: out.sites.map((id) => fresh.find((row) => row.id === id)).filter(Boolean).map((row) => row.name).sort(),
    };
  };

  // ---- Detroit: 11 unique sites, five rounds, and the three the panel hid --------------------
  const detroit = poolFor("Detroit");
  eq(detroit.names.length, 11, "Detroit's pool is 11 unique sites (the panel showed eight)");
  eq(detroit.rounds, 5, "Detroit's infantry timer is 5 rounds");
  eq(detroit.roundAt, 5, "and it is ready at round 5");
  for (const city of ["Norfolk", "New Orleans", "Houston"]) {
    if (!detroit.names.includes(city)) fail(city + " is inside Detroit's radius and left out of its pool");
  }
  for (const city of ["Chicago", "Toronto", "Washington", "New York", "St Louis", "Atlanta", "Boston"]) {
    if (!detroit.names.includes(city)) fail(city + " is a Detroit neighbour and is missing from its pool");
  }
  // Every member is inside the decoded radius, and every member is a producing record of the side.
  const freshForDetroit = matchSites("1986", board);
  for (const name of detroit.names) {
    const row = freshForDetroit.find((site) => site.name === name);
    if (!row) fail(name + " is in the pool but not in the era table");
    if (!(Number(row.id) >= 0 && Number(row.id) < 64)) fail(name + " is outside the 0-63 record window");
    if (!["city", "capital", "base"].includes(String(row.kind))) fail(name + " is not a producer but sits in the pool");
    if (distanceSq(row, detroit.site) >= 401) fail(name + " is at d^2 " + distanceSq(row, detroit.site) + ", outside the radius");
  }

  // A blue city just outside the radius is the discriminating negative: Denver is d^2 416 from
  // Detroit, so it is NOT a Detroit neighbour - but it IS a neighbour of Houston below. A test that
  // only counted members would accept a pool that swallowed the whole board.
  const denver = freshForDetroit.find((site) => site.name === "Denver");
  if (!denver) fail("the 1986 extract has no Denver");
  if (distanceSq(denver, detroit.site) < 401) fail("Denver is inside Detroit's radius; the negative case has moved");
  if (detroit.names.includes("Denver")) fail("Denver is outside 401 and must not be in Detroit's pool");

  // ---- A second city: Norfolk, whose pool differs from Detroit's both ways -------------------
  const norfolk = poolFor("Norfolk");
  eq(norfolk.names.length, 10, "Norfolk's pool is 10 unique sites");
  eq(norfolk.rounds, 6, "Norfolk's infantry timer is 6 rounds");
  if (!norfolk.names.includes("Detroit")) fail("Detroit is a Norfolk neighbour and is missing from its pool");
  if (!norfolk.names.includes("New Orleans")) fail("New Orleans is a Norfolk neighbour and is missing from its pool");
  if (norfolk.names.includes("Houston")) fail("Houston is d^2 " + distanceSq(freshForDetroit.find((s) => s.name === "Houston"), norfolk.site) + " from Norfolk and must not be in its pool");

  // ---- Houston: the third hidden member, and Denver inside its radius -----------------------
  const houston = poolFor("Houston");
  eq(houston.names.length, 8, "Houston's pool is 8 unique sites");
  eq(houston.rounds, 7, "Houston's infantry timer is 7 rounds");
  if (!houston.names.includes("Denver")) fail("Denver is inside Houston's radius and is missing from its pool");
  if (!houston.names.includes("Los Angeles")) fail("Los Angeles is inside Houston's radius and is missing from its pool");
  if (houston.names.includes("Washington")) fail("Washington is outside Houston's radius and must not be in its pool");

  console.log("pb163_readiness_pool: Detroit 11/5, Norfolk 10/6, Houston 8/7; membership both ways");
}
