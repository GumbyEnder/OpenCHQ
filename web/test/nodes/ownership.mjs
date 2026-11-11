// Node ownership: who holds the world on the opening bell.
//
// For 1918, 1942 and 1986 the answer is the CBR-TYPE.DTn owner byte, which board.matchSites now
// carries from web/data/eras.json: B-2 replaced the country-only rule for those years. The file hands
// Britain and France to blue in 1918, leaves two named neutrals unaligned and writes both 1942 seats
// blue, so a country id cannot reproduce the opening. From the file the two seats still open unheld -
// a capital's owner is read by tick as "held", the win condition, not as income.
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
import { seedOwners } from "../../server/economy.mjs";
import { eraTable } from "../../server/era.mjs";

export const name = "ownership";

const ERAS = ["1918", "1942", "1986", "2023", "9999"];

function tableOf(era) {
  return eraTable(era);
}

// The 84-row opening each capture measured, with the two seats carrying the file's owner byte:
// tick reads a capital's owner as "held", so the seats are part of the tally that year, not neutral.
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
    // The two seats are the exception: board.matchSites clears a capital's owner because tick reads
    // it as "held", so the seats are counted as neutral here.
    // Docks and oil wells are outside the 84-row table and still seed from country/region.
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
      // A rolled era's capital opens unowned: 2023's row carries no owner bits at all.
      if (site.kind === "capital") continue;
      // Facilities are not income sites: the economy only owns cities, docks and wells.
      if (site.kind === "facility") continue;
      // A table year's neutrals are the file's own ruling, not a country the seeder skipped.
      if (fromFile && site.type !== undefined) continue;
      if (site.country_id === 0 || site.country_id === 1) {
        fail(era + ": " + site.name + " is in a side's country but has no owner");
      }
    }

    // A capital is the win condition and not income, but the file's owner byte is still who holds
    // it: 1918 gives Washington to blue and Moscow to red, and 1942 gives both to blue.
    const capitals = match.sites.filter((site) => site.kind === "capital");
    if (capitals.length !== 2) fail(era + " should have two capitals, has " + capitals.length);
    for (const capital of capitals) {
      const want = fromFile ? table.sites[capital.id].owner : null;
      const got = capital.owner === "blue" || capital.owner === "red" ? capital.owner : null;
      if (got !== want) {
        fail(era + ": the capital " + capital.name + " opened " + got + ", the file says " + want);
      }
    }

    // Seeding is idempotent: a capture made later is never undone by a second pass.
    const before = match.sites.map((site) => site.owner ?? null);
    seedOwners(match);
    const after = match.sites.map((site) => site.owner ?? null);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail(era + ": a second seeding changed owners");

    counts[era] = { blue: own.blue.length, red: own.red.length, none: own.none.length };
  }

  // The board grows with the era, and ownership grows with it but never to the whole earth: a
  // two-side scenario leaves most of the world neutral by design.
  if (!(counts["1986"].blue > counts["1918"].blue - 1)) fail("1986 should hold at least as much as 1918");
  if (counts["1986"].none <= counts["1986"].blue) fail("most of the world should stay neutral in 1986");
  return counts;
}
