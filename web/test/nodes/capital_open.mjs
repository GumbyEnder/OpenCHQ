// The opening bell for the two seats (R6, FINAL — room 2949): the seats open UNHELD, and a side
// wins only by actually standing troops on both capitals.
//
// This is the interim deviation the PM ordered recorded in ERA_PHASE_B_SPEC.md: the file's owner
// bytes stay in eras.json as labels, board.matchSites clears them on every capital, and tick.mjs is
// untouched. Why it is interim, and what B-3 must replace it with, is in the spec.
//
// Pinned here:
//   1. every capital site opens with owner === null, in every era, including 1942 (whose file row
//      hands both seats to blue);
//   2. checkWin(match) is null at round 0 for every era — no seat starts the match decided;
//   3. holding one seat is not a win; land troops on both seats is;
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

  // 3. One seat is not a win; troops on both seats is. 1986's file bytes are labels only, so
  //    neither side holds either seat until a land unit stands on it.
  const one = openMatch("1986", matchSites("1986"));
  seedOwners(one);
  one.pieces = [landOn(one.capitals.blue, "blue")];
  tickMatch(one);
  if (checkWin(one) !== null) fail("blue holding one 1986 seat produced a " + checkWin(one) + " win");

  const both = openMatch("1986", matchSites("1986"));
  seedOwners(both);
  both.pieces = [landOn(both.capitals.blue, "blue"), landOn(both.capitals.red, "blue")];
  tickMatch(both);
  const win = checkWin(both);
  if (win !== "blue") fail("blue standing on both 1986 seats and the win is " + win);

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
      "one seat held is not a win, both held by blue is"
  );
  return reported;
}
