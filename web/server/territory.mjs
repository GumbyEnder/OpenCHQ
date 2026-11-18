// Territory model: which side holds each of the 184 regions, and whether a cell is friendly.
//
// The model is read from web/data/territory.json, baked by tools/bake_territory.mjs from
// REGIONS.DAT (geometry) and CBR-REGN.DTn (region -> site per era). docs/re/REGIONS.md holds the
// decode and the checks that pinned it; the short version:
//
//   * 184 regions. Each region is a four-corner quad on the 320x136 cell grid, with one label
//     point. Point-in-quad on cell centres reproduces the original's Show Ownership picture with
//     no misfiled region at all in the 1942 capture (167 of 167 coloured regions agree).
//   * CBR-REGN.DTn gives, per era, the site id each region belongs to. A region is held by
//     whoever holds that site, so a capture changes the region's colour in the same tick the site
//     record changes: the ownership view is derived from the site table and nothing else. There is
//     no second copy of "who holds Berlin" in this module.
//
// The reg.src field of CBR-REGN is the site id, never a nation id: era 1's rows join to
// CBR-TYPE.DT1's owner bits at 167/167. That is the whole reason this file can colour ground.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..", "..");
const dataFile = path.join(projectDir, "web", "data", "territory.json");

export const NO_REGION = 255;

function load() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(dataFile, "utf8"));
  } catch (err) {
    return null;
  }
  if (!raw || !Array.isArray(raw.regions) || !Array.isArray(raw.regionRuns)) return null;
  const grid = new Uint8Array(raw.width * raw.height).fill(NO_REGION);
  let at = 0;
  for (const [id, count] of raw.regionRuns) {
    grid.fill(id, at, at + count);
    at += count;
  }
  if (at !== grid.length) return null;
  return {
    width: raw.width,
    height: raw.height,
    regions: raw.regions,
    regionRuns: raw.regionRuns,
    grid,
    byEra: raw.byEra || {},
    meta: raw._meta || {},
  };
}

export const TERRITORY = load();

// The geometry the page draws from: ids, quads and the run-encoded cell -> region grid. No owner
// in here - who holds what changes with the match and is sent with the seat view.
export function territoryGeometry() {
  if (!TERRITORY) return null;
  return {
    width: TERRITORY.width,
    height: TERRITORY.height,
    noRegion: NO_REGION,
    regions: TERRITORY.regions,
    runEncoding: "[regionId,count]* row-major",
    regionRuns: TERRITORY.regionRuns,
  };
}

export function territoryReady() {
  return Boolean(TERRITORY);
}

export function boardSize() {
  return TERRITORY ? { width: TERRITORY.width, height: TERRITORY.height } : { width: 320, height: 136 };
}

// The region under a cell, or NO_REGION. X wraps like the board does; Y does not.
export function regionAt(x, y) {
  if (!TERRITORY) return NO_REGION;
  const cx = Math.round(Number(x));
  const cy = Math.round(Number(y));
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return NO_REGION;
  if (cy < 0 || cy >= TERRITORY.height) return NO_REGION;
  const wrapped = ((cx % TERRITORY.width) + TERRITORY.width) % TERRITORY.width;
  return TERRITORY.grid[cy * TERRITORY.width + wrapped];
}

export function regionLabel(id) {
  if (!TERRITORY) return null;
  const region = TERRITORY.regions[id];
  return region ? { x: region.label[0], y: region.label[1] } : null;
}

// era label -> region -> site id (null when the era's row leaves the region unassigned).
//
// The Concealed era ("9999") is named here on purpose (PB-087, room 6312 item 4). It has no CBR-REGN
// row of its own; tools/bake_territory.mjs donates the 2023 row, and this arm makes the donation
// legible at the reader instead of leaving it as a key that happens to be present. Deliberate remake
// choice: whether the 1990 original plays the hidden year on the 2023 map is UNVERIFIED.
export const CONCEALED_ERA = "9999";

export function regionSites(era) {
  if (!TERRITORY) return null;
  const label = String(era);
  if (label === CONCEALED_ERA) {
    const donated = TERRITORY.byEra[CONCEALED_ERA];
    return Array.isArray(donated) ? donated : null;
  }
  const row = TERRITORY.byEra[label];
  return Array.isArray(row) ? row : null;
}

// The era rows name sites BY ID, and the match roster is not id-ordered: 1918's 184-entry roster
// carries ids like `dock:39:34` inside the first 84 slots, so `match.sites[Number(siteId)]` (the
// pre-PB-092 form) answered with a different site for 183 of the 184 regions and served 50 blue /
// 72 red / 62 neutral where the id join serves 52/24/108 (the era row leaves one slot empty and it
// counts neutral on both readings). The row's 52 distinct ids name 25 distinct sites: 14 blue / 9
// red / 2 neutral. Those numbers reproduce from openMatch(era, matchSites(era)) + seedOwners() +
// regionSites(era) on the seeded 1918 fixture; web/test/nodes/site_join_1918.mjs is the pin.
// Join on the site's own id. String comparison keeps a numeric row id
// resolving against a string roster id (and vice versa) instead of depending on the bake's JSON types.
function siteOf(match, siteId) {
  if (!match || !Array.isArray(match.sites) || siteId === null || siteId === undefined) return null;
  return match.sites.find((site) => site && String(site.id) === String(siteId)) || null;
}

// The side that holds each region, in region id order. A region follows the site the era table
// assigns it to, read from the match's live site records: capture a city and every region that
// city owns changes at once.
export function ownersFor(match) {
  const row = regionSites(match && match.era);
  if (!row) return null;
  const out = new Array(row.length).fill(null);
  for (let rid = 0; rid < row.length; rid++) {
    const site = siteOf(match, row[rid]);
    out[rid] = site && (site.owner === "blue" || site.owner === "red") ? site.owner : null;
  }
  return out;
}

// What the Show Ownership view needs: the per-region owner list plus a count of the ground each
// side holds. The count is over regions, not cells, so it stays stable when the view zooms.
export function ownershipOf(match) {
  const owners = ownersFor(match);
  if (!owners) return { ready: false, era: match && match.era, owners: [], tally: { blue: 0, red: 0, neutral: 0 } };
  const tally = { blue: 0, red: 0, neutral: 0 };
  for (const owner of owners) {
    if (owner === "blue") tally.blue += 1;
    else if (owner === "red") tally.red += 1;
    else tally.neutral += 1;
  }
  return { ready: true, era: match.era, owners, tally };
}

// "Is this cell friendly territory?" - the question foreign aid (T-023) and peacetime placement
// (manual p.31) both need. Unassigned ground and the open sea answer false; a cell's owner must
// match the asking side.
export function isFriendly(match, side, x, y) {
  const rid = regionAt(x, y);
  if (rid === NO_REGION) return false;
  const owners = ownersFor(match);
  if (!owners || rid >= owners.length) return false;
  return owners[rid] === side;
}

// The reverse lookup the placement rules want: every region this side holds, as id + label point.
export function regionsHeldBy(match, side) {
  const owners = ownersFor(match);
  if (!owners) return [];
  const out = [];
  for (let rid = 0; rid < owners.length; rid++) {
    if (owners[rid] !== side) continue;
    const label = regionLabel(rid);
    out.push({ id: rid, x: label ? label.x : null, y: label ? label.y : null });
  }
  return out;
}
