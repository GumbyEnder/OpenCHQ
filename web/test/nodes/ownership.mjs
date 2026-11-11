// Node ownership: who holds the world on the opening bell.
//
// For 1918, 1942 and 1986 the answer is the CBR-TYPE.DTn owner byte, which board.matchSites now
// carries from web/data/eras.json: B-2 replaced the country-only rule for those years. The file hands
// Britain and France to blue in 1918, leaves two named neutrals unaligned and writes both 1942 seats
// blue, so a country id cannot reproduce the opening. From the file a capital's owner is live like any
// other site's (B-3b supersedes R6): the original's turn-0 RAM carries 0x59 blue on London and 0x9A red
// on Berlin before any order, and the win check reads that same byte, so nothing is cleared on the way
// in.
//
// 2023 and ???? keep the country rule: 2023's owners are rolled in B-3 and ???? is not modelled at
// all. There the default is by country, and it is the shipped game's own field: CBR-SET.DAT carries
// cbr_cn per site, and the two capitals sit in country 0 (Washington, 17 sites) and country 1
// (Moscow, 16). A site whose country has no capital in the game stays neutral — that is the honest
// reading of a two-side scenario, and it is what the extract's country ids support.
//
// The per-era region files (CBR-REGN.DT0..DT4) do NOT drive this: they are 184 regions by 5 (x,y)
// points (REGIONS.DAT) with a per-era governing region, and Washington's region 62 governs 4 regions
// in 1918 and 1 in 1986 — administrative control, not the NATO/Warsaw blocs a player would expect.
// Nothing here invents an alliance table to fill that gap; the test pins the country default so it
// cannot drift into a guess.
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { capitalSet } from "../../server/capitals.mjs";
import { checkWin } from "../../server/tick.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { eraTable } from "../../server/era.mjs";

export const name = "ownership";

const ERAS = ["1918", "1942", "1986", "2023"];

function tableOf(era) {
  return eraTable(era);
}

// The 84-row opening each capture measured, from the file's bytes: B-3b made a capital's owner byte
// live at the bell (it supersedes R6), so these are the file's own counts, not counts with the seats
// deducted. docs/re/B3_CAPITALS.md §3 has the same numbers against the original's turn-0 RAM.
const FILE_TALLY = {
  1918: { blue: 14, red: 9, null: 2 },
  1942: { blue: 40, red: 23, null: 1 },
  1986: { blue: 49, red: 25, null: 10 },
};

export async function run(ctx) {
  const { fail } = ctx;
  const counts = {};

  for (const era of ERAS) {
    const sites = matchSites(era);
    if (!sites.length) fail(era + " has no sites to own");
    const match = openMatch(era, sites);
    seedOwners(match);

    // The capital set opens exactly as the file leaves it, and no era hands every capital to one side
    // at round 0 - measured, not assumed. The set is the file's subtype-1/2 rows (or two rolled
    // capitals for 2023) joined to the board this match plays on, not the two seats the page labels.
    const set = match.capitalSet;
    if (!set || !set.list.length) fail(era + ": the capital set is empty, so no side could ever win");
    if (set.missing.length) {
      fail(era + ": capital ids " + set.missing.join(",") + " are in the table and not on the board");
    }
    if (set.source === "file") {
      const want = capitalSet(era, sites);
      const got = set.list.map((capital) => Number(capital.siteId)).sort((a, b) => a - b).join(",");
      const expected = want.list.map((capital) => Number(capital.siteId)).sort((a, b) => a - b).join(",");
      if (got !== expected) fail(era + ": the match's capital set is " + got + ", the file's is " + expected);
    } else if (set.list.length !== 2) {
      fail(era + ": rolled " + set.list.length + " capitals, the reading has 2");
    }
    for (const capital of set.list) {
      const site = match.sites.find((place) => Number(place.id) === Number(capital.siteId));
      if (!site) fail(era + ": the set names " + capital.siteId + " and the match has no such site");
    }
    // 2023 rolls its set, so its members cannot come from the file; every other era's members must.
    if (checkWin(match) !== null) fail(era + " opens already won by " + checkWin(match));

    const own = { blue: [], red: [], none: [] };
    for (const site of match.sites) {
      const key = site.owner === "blue" || site.owner === "red" ? site.owner : "none";
      own[key].push(site);
    }

    // Both sides hold ground before the first round.
    if (!own.blue.length) fail(era + ": blue owns nothing at open");
    if (!own.red.length) fail(era + ": red owns nothing at open");
    const blueCities = own.blue.filter((site) => site.kind === "city").length;
    const redCities = own.red.filter((site) => site.kind === "city").length;
    if (!blueCities) fail(era + ": blue owns no city, so it cannot buy, repair or base an aircraft");
    if (!redCities) fail(era + ": red owns no city");

    // From 1918 to 1986 the file's owner bit is the opening - not the country id. The original
    // hands Britain and France to blue, keeps named neutrals unaligned, and 1942 even writes both
    // seats blue. So a country-only rule is wrong for those years, and this test pins the file.
    // The file's owner bit is the opening for 1918/1942/1986 - not the country id. The original
    // hands Britain and France to blue, keeps named neutrals unaligned, and 1942 writes both seats
    // blue. A capital's byte is live like any other site's (B-3b supersedes R6), so it is compared
    // here the same way. Docks and oil wells are outside the 84-row table and still seed from
    // country/region.
    const table = tableOf(era);
    const fromFile = Boolean(table && table.ownerSource === "file");
    if (fromFile) {
      const rows = match.sites.filter((site) => Number.isInteger(site.id));
      for (const site of rows) {
        const row = table.sites[site.id];
        if (!row) fail(era + ": id " + site.id + " is live but the table has no row for it");
        const want = row.owner;
        const got = site.owner === "blue" || site.owner === "red" ? site.owner : null;
        if (got !== want) {
          fail(era + ": id " + site.id + " " + site.name + " opened " + got + ", the file says " + want);
        }
      }
      const tally = { blue: 0, red: 0, null: 0 };
      for (const site of rows) tally[site.owner === "blue" || site.owner === "red" ? site.owner : "null"] += 1;
      const want = FILE_TALLY[era];
      if (tally.blue !== want.blue || tally.red !== want.red || tally.null !== want.null) {
        fail(era + " opening is blue " + tally.blue + " / red " + tally.red + " / neutral " + tally.null +
          "; the captures give blue " + want.blue + " / red " + want.red + " / neutral " + want.null);
      }
    }
    const countryless = (site) => site.country_id === undefined || site.country_id === null;
    for (const site of own.blue) {
      if (countryless(site)) continue;
      // A table site's owner came from the file, not from its country.
      if (fromFile && site.type !== undefined) continue;
      if (site.country_id !== 0) fail(era + ": blue owns " + site.name + " in country " + site.country_id);
    }
    for (const site of own.red) {
      if (countryless(site)) continue;
      if (fromFile && site.type !== undefined) continue;
      if (site.country_id !== 1) fail(era + ": red owns " + site.name + " in country " + site.country_id);
    }
    for (const site of own.none) {
      // A neutral capital is legal - it is what a rolled era can draw, and a neutral capital blocks
      // both sides at the win check rather than being a missing owner.
      if (site.kind === "capital") continue;
      // Facilities are not income sites: the economy only owns cities, docks and wells.
      if (site.kind === "facility") continue;
      // A table year's neutrals are the file's own ruling, not a country the seeder skipped.
      if (fromFile && site.type !== undefined) continue;
      if (site.country_id === 0 || site.country_id === 1) {
        fail(era + ": " + site.name + " is in a side's country but has no owner");
      }
    }

    // Seeding is idempotent: a capture made later is never undone by a second pass.
    const before = match.sites.map((site) => site.owner ?? null);
    seedOwners(match);
    const after = match.sites.map((site) => site.owner ?? null);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail(era + ": a second seeding changed owners");

    counts[era] = { blue: own.blue.length, red: own.red.length, none: own.none.length };
  }

  // 9999 is the concealed start and it rolls like 2023: "9999" is in match.ERAS, so eraOf passes it
  // through instead of coercing it. The draw runs after seedOwners, so it lands inside owned ground
  // rather than on an ownerless board. A literal "????" label is not an era id - only that falls to 1986.
  const odd = openMatch("9999", matchSites("9999"));
  seedOwners(odd);
  if (String(odd.era) !== "9999") fail("openMatch(9999) reports era " + odd.era + ", expected 9999");
  if (odd.capitalSet.source !== "rolled" || odd.capitalSet.list.length !== 2) {
    fail("openMatch(9999) carries " + odd.capitalSet.source + " with " + odd.capitalSet.list.length + " capitals");
  }
  const oddOwners = odd.capitalSet.list.map((capital) => {
    const site = odd.sites.find((place) => Number(place.id) === Number(capital.siteId));
    return site && (site.owner === "blue" || site.owner === "red") ? site.owner : null;
  });
  if (oddOwners.includes(null) || new Set(oddOwners).size !== 2) {
    fail("9999's capitals are not one per side: " + JSON.stringify(oddOwners));
  }

  // The board grows with the era, and ownership grows with it but never to the whole earth: a
  // two-side scenario leaves most of the world neutral by design.
  if (!(counts["1986"].blue > counts["1918"].blue - 1)) fail("1986 should hold at least as much as 1918");
  if (counts["1986"].none <= counts["1986"].blue) fail("most of the world should stay neutral in 1986");
  return counts;
}
