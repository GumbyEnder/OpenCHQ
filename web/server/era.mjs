// The era site table: which sites exist in a given year, what subtype byte they carry, and - for
// the years the original writes owners from a file - who owns them at the opening.
//
// The data is web/data/eras.json, baked from the extract by tools/bake_eras.mjs and committed, so a
// host with no extract still plays the original's opening. Nothing here reads the extract at
// runtime and nothing here touches world.json: the subtype travels as `type` and `kind` keeps the
// asset list's word, because the two disagree on 14 of 84 sites at 1986 and mapping one onto the
// other would silently reclassify cities, income and the 20 facilities. That 14 is the whole
// disagreement under the only mapping that exists (1/2 = capital, 4 = city, 5 = facility): the 12
// sites whose 1986 row is type 3 and world.json calls city (0, 1, 2, 4, 21, 22, 51, 52, 54, 55, 57,
// 58), plus id 10 London and id 35 Tokyo, which the file calls type 1 and world.json calls city.
// Note eras.json's own _meta still says "34 of 84": that figure is stale (an earlier derivation),
// the reproducible count is 14, and the baked _meta is not B-2's to edit - re-bake corrects it.
//
// B-1 landed the table and these two pure functions. B-2 wired them in: board.matchSites applies
// the era to the base list and carries `type`, match.openMatch copies `type` and the file's owner
// onto the match's sites, and economy.seedOwners trusts that owner for the file years instead of
// guessing from country_id.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tableFile = path.join(projectDir, "web", "data", "eras.json");

let baked = null;
let attempted = false;

function load() {
  if (attempted) return baked;
  attempted = true;
  try {
    baked = JSON.parse(readFileSync(tableFile, "utf8"));
  } catch {
    baked = null;
  }
  return baked;
}

// The baked entry for an era, or null. A year the extract has no row for - "9999", junk, a missing
// file - is null, never a guess at 1986: ???? contradicts its own file row, so modelling it from
// the captures is forbidden.
export function eraTable(era) {
  if (era === null || era === undefined) return null;
  const world = load();
  if (!world || !world.eras) return null;
  const key = String(era);
  const entry = world.eras[key];
  if (!entry || !Array.isArray(entry.sites)) return null;
  return entry;
}

// Apply one era's opening to a site list and return a new list. Only the sites the 84-row table
// names are touched: a `type` of 0 means the site is absent that year and is dropped, everything
// else keeps its x/y and gains the subtype, plus the file's owner for the years that have one.
// Docks and oil wells are not in the table and pass through untouched. A year with no entry
// returns the input array itself - identity, not a copy.
export function applyEra(sites, era) {
  const table = eraTable(era);
  if (!table || !Array.isArray(sites)) return sites;

  const byId = new Map(table.sites.map((row) => [row.id, row]));
  const rolled = table.ownerSource === "rolled";
  const out = [];
  for (const site of sites) {
    const id = Number(site && site.id);
    const row = Number.isInteger(id) ? byId.get(id) : undefined;
    if (!row) {
      out.push(site);
      continue;
    }
    if (row.type === 0) continue;
    // A rolled era ships no owners: leave the site's current owner exactly as it was found, which
    // is what B-3 then rolls.
    out.push(rolled ? { ...site, type: row.type } : { ...site, type: row.type, owner: row.owner });
  }
  return out;
}
