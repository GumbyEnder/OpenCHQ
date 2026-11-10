// Node ownership: who holds the world on the opening bell.
//
// The opening owner is no longer derived from country index 0/1. It is the era table's verdict:
// for 1918, 1942 and 1986 the live capture byte from docs/re/era-captures (baked into
// web/data/eras.json by tools/bake_eras.mjs); for 2023 and ???? the roll from the match seed.
// Country seeding survives only for the sites no era row names - the painted docks and the
// hand-placed wells - and that is checked here too.
//
// This node pins the seeding contract: what openMatch + seedOwners leave on `match.sites` must be
// exactly the table, id by id, and a second pass must change nothing. era_setup.mjs covers the
// capitals and the presence set.
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { eraTable, UNOWNED_MIN, UNOWNED_MAX } from "../../server/era.mjs";

export const name = "ownership";

const FIXED = ["1918", "1942", "1986"];
const ROLLED = ["2023", "9999"];

function ownerKey(site) {
  return site.owner === "blue" || site.owner === "red" ? site.owner : "none";
}

export async function run(ctx) {
  const { fail } = ctx;
  const counts = {};

  for (const era of FIXED) {
    const table = eraTable(era);
    if (!table) fail(era + " has no baked era table");
    const sites = matchSites(era);
    if (!sites.length) fail(era + " has no sites to own");
    const match = openMatch(era, sites);
    seedOwners(match);

    for (const row of table.sites) {
      const site = match.sites.find((entry) => Number(entry.id) === row.id);
      if (!row.present) {
        if (site) fail(era + ": absent id " + row.id + " is on the board");
        continue;
      }
      if (!site) fail(era + ": present id " + row.id + " is missing from the board");
      if ((site.owner ?? null) !== row.owner) {
        fail(era + " id " + row.id + " (" + site.name + ") opened owned by " + JSON.stringify(site.owner) +
          ", the era table says " + JSON.stringify(row.owner));
      }
    }

    // A dock or a well is not in the 84-row table: country seeding still gives it a side.
    for (const site of match.sites) {
      if (site.type !== undefined) continue;
      if (site.owner === "blue" || site.owner === "red" || site.owner === null) continue;
      fail(era + ": " + site.name + " carries an owner that is not blue, red or null");
    }

    const own = { blue: 0, red: 0, none: 0 };
    for (const site of match.sites) own[ownerKey(site)] += 1;
    counts[era] = own;

    // Seeding is idempotent: a capture made later is never undone by a second pass.
    const before = match.sites.map((site) => site.owner ?? null);
    seedOwners(match);
    const after = match.sites.map((site) => site.owner ?? null);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail(era + ": a second seeding changed owners");
  }

  // 1986's four cities stay unowned: the §4 clear, visible in the opening, not only in the bake.
  const opened1986 = openMatch("1986", matchSites("1986"));
  seedOwners(opened1986);
  for (const id of [43, 46, 50, 53]) {
    const site = opened1986.sites.find((entry) => Number(entry.id) === id);
    if (!site) fail("1986 id " + id + " is missing from the opening");
    if (site.owner !== null) fail("1986 id " + id + " (" + site.name + ") opened owned by " + site.owner);
  }

  // Rolled eras: two capitals worth of sides, and an unowned count inside the configured range.
  for (const era of ROLLED) {
    const match = openMatch(era, matchSites(era), { seed: 4242 });
    seedOwners(match);
    const own = { blue: 0, red: 0, none: 0 };
    for (const site of match.sites) {
      if (site.type === undefined) continue;
      own[ownerKey(site)] += 1;
    }
    if (own.blue === 0 || own.red === 0) fail(era + " rolled no ownership: " + JSON.stringify(own));
    if (own.none < UNOWNED_MIN || own.none > UNOWNED_MAX) {
      fail(era + " rolled " + own.none + " unowned sites, outside [" + UNOWNED_MIN + ", " + UNOWNED_MAX + "]");
    }
    if (own.blue + own.red + own.none !== 84) fail(era + " rolled ownership for " + (own.blue + own.red + own.none) + " sites, not 84");
    counts[era] = own;
  }

  // The board grows with the era: 1918 keeps 25 of the 84 sites, 1986 all of them.
  if (!(counts["1986"].blue > counts["1918"].blue)) fail("1986 should hold more blue ground than 1918");
  return counts;
}
