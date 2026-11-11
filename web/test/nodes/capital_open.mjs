// The opening bell for the two seats (R6, FINAL — room 2949): the seats open UNHELD. B-3b moved the
// win from "troops on both seats" to "every capital in the era's set", so holding the seats is no
// longer enough - the rule that survives is that nobody is handed a capital by the owner byte.
//
// This is the interim deviation the PM ordered recorded in ERA_PHASE_B_SPEC.md: the file's owner
// bytes stay in eras.json as labels and board.matchSites clears them on every capital. B-3b moved
// the win off the two seats onto the era's whole capital set, so the seat expectations here changed
// with it; what R6 fixes - the seats open unheld - did not.
//
// Pinned here:
//   1. every capital site opens with owner === null, in every era, including 1942 (whose file row
//      hands both seats to blue);
//   2. checkWin(match) is null at round 0 for every era — no seat starts the match decided;
//   3. holding one seat is not a win, and neither is both seats: B-3b made the win the era's whole
//      capital set (four for 1986), so the seats are two of four;
//   4. eras.json's 1942 bytes are still blue/blue — the clearing happens at the call site, not in
//      the data.

import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { checkWin, tickMatch } from "../../server/tick.mjs";
import { eraTable } from "../../server/era.mjs";

export const name = "capital_open";

const ERAS = ["1918", "1942", "1986", "2023", "9999"];

function fail(message) {
  throw new Error("node test capital_open: " + message);
}

function landOn(seat, side) {
  return {
    id: side + ":probe:" + seat.x + ":" + seat.y,
    side,
    domain: "land",
    kind: null,
    x: seat.x,
    y: seat.y,
    path: [],
  };
}

export async function run() {
  const reported = {};

  for (const era of ERAS) {
    const sites = matchSites(era);
    if (!sites.length) fail(era + " has no sites");
    const capitals = sites.filter((site) => site.kind === "capital");
    if (capitals.length !== 2) fail(era + " should carry two capital sites, has " + capitals.length);
    for (const site of capitals) {
      if (site.owner !== null) fail(era + ": " + site.name + " opened held by " + site.owner);
    }

    const match = openMatch(era, sites);
    seedOwners(match);
    const seeded = match.sites.filter((site) => site.kind === "capital");
    if (seeded.length !== 2) fail(era + " match should carry two capitals, has " + seeded.length);
    for (const site of seeded) {
      if (site.owner !== null) fail(era + ": seeding handed " + site.name + " to " + site.owner);
    }

    const round0 = checkWin(match);
    if (round0 !== null) fail(era + ": the match is already " + round0 + "'s at round 0");
    reported[era] = { blue: null, red: null, win: round0 };
  }

  // 3. One seat is not a win, and neither are the two seats: 1986's set is four capitals (B-3b), so
  //    Washington and Moscow are two of four. The seats' file bytes are labels only, so neither
  //    side holds either seat until a land unit stands on it.
  const one = openMatch("1986", matchSites("1986"));
  seedOwners(one);
  one.pieces = [landOn(one.capitals.blue, "blue")];
  tickMatch(one);
  if (checkWin(one) !== null) fail("blue holding one 1986 seat produced a " + checkWin(one) + " win");

  const both = openMatch("1986", matchSites("1986"));
  seedOwners(both);
  both.pieces = [landOn(both.capitals.blue, "blue"), landOn(both.capitals.red, "blue")];
  tickMatch(both);
  if (checkWin(both) !== null) {
    fail("blue standing on both 1986 seats produced a " + checkWin(both) + " win; the era has four capitals");
  }

  // Every capital in the set, with the last one taken by troops this round, is the win - and the
  // last one is London, a city-kind site, so this also pins that membership and not site kind is
  // what the trigger looks at.
  const all = openMatch("1986", matchSites("1986"));
  seedOwners(all);
  all.clock = "running";
  const set = all.capitalSet.list;
  for (const capital of set.slice(1)) {
    all.sites.find((site) => Number(site.id) === Number(capital.siteId)).owner = "blue";
  }
  const lastSite = all.sites.find((site) => Number(site.id) === Number(set[0].siteId));
  lastSite.owner = null;
  all.pieces = [{ id: "blue:probe", side: "blue", domain: "land", kind: null, x: lastSite.x, y: lastSite.y, path: [] }];
  tickMatch(all);
  const win = checkWin(all);
  if (win !== "blue") fail("blue owning every 1986 capital, the last one taken by troops, and the win is " + win);

  // 4. eras.json keeps the file's bytes: the 1942 seats are blue's in the data, null on the board.
  const row = eraTable("1942");
  if (!row || !Array.isArray(row.sites)) fail("eraTable(1942) is missing");
  const seats = row.sites.filter((site) => site.id === 62 || site.id === 63);
  if (seats.length !== 2) fail("eras.json 1942 should name both seats, names " + seats.length);
  for (const seat of seats) {
    if (seat.owner !== "blue") {
      fail("eras.json 1942 id " + seat.id + " owner is " + seat.owner + ", expected blue (label kept)");
    }
  }

  console.log(
    "capital owners at round 0: all five eras open unheld (Washington null / Moscow null); " +
      "1942 file bytes stay blue/blue in eras.json; no era decided at round 0; " +
      "one seat or both seats held is not a win, every capital in the era's set taken is"
  );
  return reported;
}
