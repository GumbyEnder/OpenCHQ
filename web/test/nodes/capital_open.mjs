// The opening bell (B-3b, supersedes R6): the file's owner byte is LIVE, not a label.
//
// R6 cleared a capital's owner so that no seat was handed to a side at the bell, and its stated
// reason was that a held 1942 would open decided. The original's turn-0 RAM says the bytes are
// held - London 0x59 blue and Berlin 0x9A red before any order (docs/re/B3_CAPITALS.md §2) - and the
// win check at 1c0d:000c reads that same byte. B-3b moves the win onto the era's whole capital set,
// which removes R6's reason: measured on the file, no era hands every capital to one side at the
// bell (1918 2 blue / 1 red, 1942 3/3, 1986 3 blue / 1 red). So the clear is gone, and what the
// bytes say is what the match opens with.
//
// Pinned here:
//   1. every capital in a file era opens with the owner the file carries;
//   2. checkWin(match) is null at round 0 in every era - measured, not assumed;
//   3. the consequence, stated and pinned rather than discovered later: 1918 is one blue capture
//      (Berlin) and 1986 is one blue capture (Moscow), while red needs three in 1986. The asymmetry
//      is in the data and in the original's own check, not in this port;
//   4. a 2023 rolled capital reports the holder its site record carries, and 9999 is 1986 through
//      openMatch (eraOf coerces anything outside ERAS).

import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { checkWin, tickMatch } from "../../server/tick.mjs";
import { eraTable } from "../../server/era.mjs";

export const name = "capital_open";

function fail(message) {
  throw new Error("node test capital_open: " + message);
}

function landOn(site, side) {
  return {
    id: side + ":probe:" + site.x + ":" + site.y,
    side,
    domain: "land",
    kind: null,
    x: site.x,
    y: site.y,
    path: [],
  };
}

// The file's capitals and their owners, from docs/re/B3_CAPITALS.md §2 and web/data/eras.json.
const EXPECT = {
  1918: { 10: "blue", 11: "red", 17: "blue" },
  1942: { 10: "blue", 11: "red", 17: "red", 35: "red", 62: "blue", 63: "blue" },
  1986: { 10: "blue", 35: "blue", 62: "blue", 63: "red" },
};

function capitalSite(match, id) {
  const site = match.sites.find((place) => Number(place.id) === Number(id));
  if (!site) fail("the match has no site " + id);
  return site;
}

// One land unit takes the site centre, the owner byte is cleared as if the garrison had left, and one
// tick has to end the match when that site is the last capital the side was missing.
function takeAndTick(match, id, side) {
  const site = capitalSite(match, id);
  site.owner = null;
  match.clock = "running";
  match.pieces = [landOn(site, side)];
  tickMatch(match);
}

export async function run() {
  const reported = {};

  for (const era of ["1918", "1942", "1986"]) {
    const sites = matchSites(era);
    if (!sites.length) fail(era + " has no sites");
    const match = openMatch(era, sites);
    seedOwners(match);

    const set = match.capitalSet.list;
    const want = EXPECT[era];
    const ids = set.map((capital) => Number(capital.siteId)).sort((a, b) => a - b).join(",");
    const expected = Object.keys(want).map(Number).sort((a, b) => a - b).join(",");
    if (ids !== expected) fail(era + ": capital set is " + ids + ", the file's is " + expected);

    const held = { blue: 0, red: 0 };
    for (const capital of set) {
      const site = capitalSite(match, capital.siteId);
      const owner = site.owner === "blue" || site.owner === "red" ? site.owner : null;
      if (owner !== want[capital.siteId]) {
        fail(era + ": " + site.name + " opened " + owner + ", the file says " + want[capital.siteId]);
      }
      // The set's own label has to agree with the site record, or a report built from the set
      // disagrees with the rule that decides the match.
      if (capital.owner !== owner) {
        fail(era + ": the set labels " + site.name + " " + capital.owner + " and the site says " + owner);
      }
      held[owner] += 1;
    }

    const round0 = checkWin(match);
    if (round0 !== null) fail(era + ": the match is already " + round0 + "'s at round 0");
    reported[era] = { capitals: set.length, blue: held.blue, red: held.red, win: round0 };
  }

  // 3. The reach of a held opening, measured. 1918: blue holds London and Paris, so Berlin is the
  //    whole match. 1986: blue holds three of four, so Moscow is the whole match - while red, holding
  //    only Moscow, has to take London, Tokyo and Washington, so red's first capture must not end it.
  const b1918 = openMatch("1918", matchSites("1918"));
  seedOwners(b1918);
  if (checkWin(b1918) !== null) fail("1918 is decided before the first capture");
  takeAndTick(b1918, 11, "blue");
  if (checkWin(b1918) !== "blue") fail("blue taking Berlin in 1918 did not end the match: " + checkWin(b1918));

  const b1986 = openMatch("1986", matchSites("1986"));
  seedOwners(b1986);
  if (checkWin(b1986) !== null) fail("1986 is decided before the first capture");
  takeAndTick(b1986, 63, "blue");
  if (checkWin(b1986) !== "blue") fail("blue taking Moscow in 1986 did not end the match: " + checkWin(b1986));

  const r1986 = openMatch("1986", matchSites("1986"));
  seedOwners(r1986);
  takeAndTick(r1986, 10, "red");
  if (checkWin(r1986) !== null) {
    fail("red taking London in 1986 ended the match on one capture: " + checkWin(r1986));
  }

  // A quiet round on a held opening decides nothing: the trigger is a capture inside the set.
  const quiet = openMatch("1918", matchSites("1918"));
  seedOwners(quiet);
  quiet.clock = "running";
  quiet.pieces = [];
  tickMatch(quiet);
  if (checkWin(quiet) !== null) fail("a quiet 1918 round produced a " + checkWin(quiet) + " win");

  // 4. A rolled era: two capitals, each labelled with the holder its site record carries.
  const rolled = openMatch("2023", matchSites("2023"));
  seedOwners(rolled);
  if (rolled.capitalSet.source !== "rolled") fail("2023's set is " + rolled.capitalSet.source + ", expected rolled");
  if (rolled.capitalSet.list.length !== 2) fail("2023 rolled " + rolled.capitalSet.list.length + " capitals");
  for (const capital of rolled.capitalSet.list) {
    const site = capitalSite(rolled, capital.siteId);
    const owner = site.owner === "blue" || site.owner === "red" ? site.owner : null;
    if (capital.owner !== owner) {
      fail("2023: the set labels " + site.name + " " + capital.owner + " and the site says " + owner);
    }
  }

  // A year with no file row is not a fifth era of the file's kind: 9999 is the concealed start and it
  // rolls like 2023. Measured, not inherited - "9999" is in match.ERAS, so eraOf passes it through
  // rather than coercing it to 1986, and the draw lands one capital in each side's own ground.
  const odd = openMatch("9999", matchSites("9999"));
  seedOwners(odd);
  if (String(odd.era) !== "9999") fail("openMatch(9999) reports era " + odd.era + ", expected 9999");
  if (odd.capitalSet.source !== "rolled") fail("9999's set is " + odd.capitalSet.source + ", expected rolled");
  const oddOwners = odd.capitalSet.list.map((capital) => {
    const site = capitalSite(odd, capital.siteId);
    return site.owner === "blue" || site.owner === "red" ? site.owner : null;
  });
  if (oddOwners.length !== 2 || new Set(oddOwners).size !== 2 || oddOwners.includes(null)) {
    fail("9999's two capitals are not one per side: " + JSON.stringify(oddOwners));
  }
  if (checkWin(odd) !== null) fail("9999 opens already won by " + checkWin(odd));
  // The literal label is not an era id. eraOf sends anything outside ERAS to 1986, so "????" plays
  // 1986's four file capitals - the one place the two names diverge.
  const labelled = openMatch("????", matchSites("????"));
  if (String(labelled.era) !== "1986" || labelled.capitalSet.list.length !== 4) {
    fail("the literal ???? label should fall through to 1986's four capitals, got " +
      labelled.era + " with " + labelled.capitalSet.list.length);
  }
  // And the fall-through set must not label owners its sites do not carry: the board there is the
  // neutral 1986 template, so every label has to read neutral too. This is the exact drift the
  // rolled-year fix removed, one path over.
  for (const capital of labelled.capitalSet.list) {
    const site = capitalSite(labelled, capital.siteId);
    const owner = site.owner === "blue" || site.owner === "red" ? site.owner : null;
    if (capital.owner !== owner) {
      fail("????: the set labels " + site.name + " " + capital.owner + " and the site says " + owner);
    }
  }

  // eras.json is untouched by any of this: the 1942 seats are still blue's in the data.
  const row = eraTable("1942");
  if (!row || !Array.isArray(row.sites)) fail("eraTable(1942) is missing");
  const seats = row.sites.filter((site) => site.id === 62 || site.id === 63);
  if (seats.length !== 2) fail("eras.json 1942 should name both seats, names " + seats.length);
  for (const seat of seats) {
    if (seat.owner !== "blue") {
      fail("eras.json 1942 id " + seat.id + " owner is " + seat.owner + ", expected blue");
    }
  }

  console.log(
    "capital owners at round 0: file bytes live (1918 2 blue/1 red, 1942 3/3, 1986 3 blue/1 red); " +
      "no era decided at round 0; 1918 blue needs Berlin, 1986 blue needs Moscow, 1986 red needs three"
  );
  return reported;
}
