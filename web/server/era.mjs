// The era table: which sites exist in a given year, what type byte each carries, who owns it at
// the first bell, and which cells are capitals.
//
// The data is web/data/eras.json, baked from the Phase A captures by tools/bake_eras.mjs and
// committed, so a host with no extract still plays the original's opening. Nothing here reads the
// extract at runtime.
//
// Two rules from ERA_SETUP.md that this module must not break:
//   - `type` is the file's subtype byte (& 7) and travels beside world.json's `kind`, never over
//     it: the two disagree on 34 of 84 sites, and writing the subtype into `kind` would
//     reclassify cities, income and the 20 facilities in one keystroke. `kind` only changes for
//     the cells a fixture names as capitals, because the win condition reads kind.
//   - `owner` for 1918/1942/1986 is the live capture byte, never a country index. 2023 and ????
//     have no owner fixture; their owners are rolled from the match seed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tableFile = path.join(projectDir, "web", "data", "eras.json");

const FIXED_ERAS = new Set(["1918", "1942", "1986"]);
const ROLLED_ERAS = new Set(["2023", "9999"]);
const BOARD_X = 320;

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

// The baked entry for an era, or null. A year with no entry is null, never a guess at 1986.
export function eraTable(era) {
  if (era === null || era === undefined) return null;
  const world = load();
  if (!world || !world.eras) return null;
  const entry = world.eras[String(era)];
  if (!entry || !Array.isArray(entry.sites)) return null;
  return entry;
}

export function isFixedEra(era) {
  return FIXED_ERAS.has(String(era));
}

export function isRolledEra(era) {
  const table = eraTable(era);
  return Boolean(table && table.ownerSource !== "capture");
}

// What the lobby calls each side this era, with the source that names it.
export function eraSides(era) {
  const table = eraTable(era);
  return table && table.sides ? table.sides : null;
}

// --- the roll ------------------------------------------------------------------------------
// FUN_23aa_0e1c @ 23aa:0e1c picks two sites, rejects a pair that shares a country id, then
// requires FUN_188b_0216 @ 188b:0216 >= 0x271. That function returns dx*dx + dy*dy with X wrapped
// at 320, so 0x271 = 625 is a SQUARED distance: 25 map cells. The pair that survives becomes the
// two capitals; each site's owner then comes from the bloc its country belongs to. The bloc table
// itself was not recovered, so the port anchors one side on each capital and splits the rest
// evenly - that is the stand-in, and it is labelled as one.
export const UNOWNED_MIN = 32;
export const UNOWNED_MAX = 52;
export const DISTANCE_MIN_SQUARED = 0x271;

function hashSeed(seed) {
  const text = String(seed ?? "0");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, and identical in every engine, so a test can replay one map.
function rng(seed) {
  let a = hashSeed(seed);
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function squaredDistance(a, b) {
  let x1 = Number(a.x);
  let x2 = Number(b.x);
  if (Math.abs(x1 - x2) > BOARD_X / 2) {
    if (x1 < x2) x1 += BOARD_X;
    else x2 += BOARD_X;
  }
  const dx = x1 - x2;
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

function shuffle(list, next) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

function capitalEntry(site, id) {
  return { siteId: site.id, id: site.id, name: site.name, x: site.x, y: site.y, type: 3, source: id };
}

// Roll one pair of capitals and the bloc owners for a rolled era. Pure: returns fresh site copies
// and the capital pair; the input list is not mutated.
export function rollEra(sites, era, options = {}) {
  const table = eraTable(era);
  if (!table || table.ownerSource === "capture") return { sites, capitals: null };
  const list = Array.isArray(sites) ? sites : [];
  const settlements = list.filter((site) => site && Number.isInteger(Number(site.id)) && site.id !== null);
  const cities = settlements.filter((site) => Number(site.type) === 4);
  const candidates = cities.length >= 2 ? cities : settlements;
  if (candidates.length < 2) return { sites, capitals: null };

  const next = rng(options.seed ?? 0);
  // Country ids come from the board. A site without one cannot be told apart from another, so it
  // is a last resort, not a first choice: the original rejects a pair that shares a country.
  const countryOf = (site) => (site.country_id === undefined || site.country_id === null ? `site:${site.id}` : String(site.country_id));
  const shuffled = shuffle(candidates, next);
  let first = null;
  let second = null;
  for (const candidate of shuffled) {
    for (const other of shuffled) {
      if (candidate === other) continue;
      if (countryOf(candidate) === countryOf(other)) continue;
      if (squaredDistance(candidate, other) < DISTANCE_MIN_SQUARED) continue;
      first = candidate;
      second = other;
      break;
    }
    if (first) break;
  }
  // The whole board is smaller than the floor only if the floor were misread; say so by falling
  // back to the farthest pair rather than opening a match with no capitals.
  if (!first) {
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const d = squaredDistance(candidates[i], candidates[j]);
        if (!best || d > best.d) best = { d, a: candidates[i], b: candidates[j] };
      }
    }
    if (!best) return { sites, capitals: null };
    first = best.a;
    second = best.b;
  }

  const capitals = {
    blue: [capitalEntry(first, "rolled: one of two capitals at least 0x271 (625) squared cells apart, FUN_23aa_0e1c")],
    red: [capitalEntry(second, "rolled: one of two capitals at least 0x271 (625) squared cells apart, FUN_23aa_0e1c")],
  };
  const capitalIds = new Set([first.id, second.id]);

  // Unowned count: even, inside [32, 52], never a capital. Phase A saw 52 and 32; the range is the
  // spec's, the two observations are all the evidence behind it.
  const span = (UNOWNED_MAX - UNOWNED_MIN) / 2;
  const unownedCount = UNOWNED_MIN + 2 * Math.floor(next() * (span + 1));
  const rest = shuffle(settlements.filter((site) => !capitalIds.has(site.id)), next);
  const unowned = new Set(rest.slice(0, unownedCount).map((site) => site.id));

  const sourceTail = era === "9999"
    ? "stand-in, UNVERIFIED (FUN_23aa_054c not yet traced)"
    : "rolled: FUN_23aa_0e1c bloc rule (UNVERIFIED, two observations)";
  let flip = 0;
  const out = list.map((site) => {
    if (!Number.isInteger(Number(site.id))) return site;
    if (capitalIds.has(site.id)) {
      const side = first.id === site.id ? "blue" : "red";
      return { ...site, capitalSide: side, owner: side, source: sourceTail };
    }
    if (unowned.has(site.id)) return { ...site, owner: null, source: sourceTail };
    const side = flip % 2 === 0 ? "blue" : "red";
    flip += 1;
    return { ...site, owner: side, source: sourceTail };
  });
  return { sites: out, capitals };
}

// The capitals of an era. Fixed eras read the baked table; rolled eras roll them from the seed,
// using the site list for cells and country ids.
export function eraCapitals(era, options = {}) {
  const table = eraTable(era);
  if (!table) return null;
  if (table.ownerSource === "capture") {
    const map = (rows) => (Array.isArray(rows) ? rows : []).map((row) => ({
      siteId: row.id,
      id: row.id,
      name: row.name,
      x: row.x,
      y: row.y,
      type: row.type,
      source: row.source,
    }));
    return { blue: map(table.capitals && table.capitals.blue), red: map(table.capitals && table.capitals.red) };
  }
  const rolled = rollEra(options.sites, era, options);
  return rolled.capitals;
}

// Apply one era's opening to a site list and return a new list. Only the sites the 84-row table
// names are touched: type 0 means the site is absent that year and is dropped, everything else
// keeps its x/y and gains the subtype, plus the capture's owner for the fixed years. Docks and oil
// wells are not in the table and pass through untouched. A year with no entry returns the input.
export function applyEra(sites, era) {
  const table = eraTable(era);
  if (!table || !Array.isArray(sites)) return sites;

  const byId = new Map(table.sites.map((row) => [row.id, row]));
  const fixed = table.ownerSource === "capture";
  const capitalSide = new Map();
  if (fixed) {
    for (const side of ["blue", "red"]) {
      for (const row of (table.capitals && table.capitals[side]) || []) capitalSide.set(row.id, side);
    }
  }
  const out = [];
  for (const site of sites) {
    const id = Number(site && site.id);
    const row = Number.isInteger(id) ? byId.get(id) : undefined;
    if (!row) {
      out.push(site);
      continue;
    }
    if (row.present === false || row.type === 0) continue;
    const next = { ...site, type: row.type, eraSource: row.source };
    if (fixed) {
      next.owner = row.owner;
      // The cell is a capital for that side. `kind` is left alone: Paris is still a city in the
      // asset list, and rewriting kind would move its income. Consumers read capitalSide.
      const side = capitalSide.get(id);
      if (side) next.capitalSide = side;
    }
    out.push(next);
  }
  return out;
}

// One call for a match open: the filtered list, the owners (fixture or rolled) and the capitals.
export function prepareEra(sites, era, options = {}) {
  const table = eraTable(era);
  if (!table) return { sites, capitals: null, fixed: false };
  const applied = applyEra(sites, era);
  if (table.ownerSource === "capture") {
    return { sites: applied, capitals: eraCapitals(era, options), fixed: true };
  }
  const rolled = rollEra(applied, era, options);
  return { sites: rolled.sites, capitals: rolled.capitals, fixed: false };
}
