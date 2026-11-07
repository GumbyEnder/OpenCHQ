// Node ownership: who holds the world on the opening bell.
//
// The default is by country, and it is the shipped game's own field: CBR-SET.DAT carries cbr_cn per
// site, and the two capitals sit in country 0 (Washington, 17 sites) and country 1 (Moscow, 16).
// A site whose country has no capital in the game stays neutral — that is the honest reading of a
// two-side scenario, and it is what the extract's country ids support.
//
// The per-era region files (CBR-REGN.DT0..DT4) do NOT drive this: they are 184 regions by 5 (x,y)
// points (REGIONS.DAT) with a per-era governing region, and Washington's region 62 governs 4 regions
// in 1918 and 1 in 1986 — administrative control, not the NATO/Warsaw blocs a player would expect.
// Nothing here invents an alliance table to fill that gap; the test pins the country default so it
// cannot drift into a guess.
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";

export const name = "ownership";

const ERAS = ["1918", "1942", "1986", "2023", "9999"];

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

    // Country 0 is Washington's country and country 1 is Moscow's: the default must be that field.
    // Oilfields and wells are named assets, not country sites, so they carry no country id.
    const countryless = (site) => site.country_id === undefined || site.country_id === null;
    for (const site of own.blue) {
      if (countryless(site)) continue;
      if (site.country_id !== 0) fail(era + ": blue owns " + site.name + " in country " + site.country_id);
    }
    for (const site of own.red) {
      if (countryless(site)) continue;
      if (site.country_id !== 1) fail(era + ": red owns " + site.name + " in country " + site.country_id);
    }
    for (const site of own.none) {
      // A capital is deliberately unowned: it is the win condition, not income.
      if (site.kind === "capital") continue;
      // Facilities are not income sites: the economy only owns cities, docks and wells.
      if (site.kind === "facility") continue;
      if (site.country_id === 0 || site.country_id === 1) {
        fail(era + ": " + site.name + " is in a side's country but has no owner");
      }
    }

    // A capital is the win condition, not income: it is never owned by this seeding.
    const capitals = match.sites.filter((site) => site.kind === "capital");
    if (capitals.length !== 2) fail(era + " should have two capitals, has " + capitals.length);
    for (const capital of capitals) {
      if (capital.owner === "blue" || capital.owner === "red") {
        fail(era + ": the capital " + capital.name + " was handed to a side by seeding");
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
