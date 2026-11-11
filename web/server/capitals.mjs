// The era's capital set, as the original keeps it in the site byte 0x1102.
//
// A site is a capital when `byte & 7` is 1 or 2. Its owner is `byte & 0xC0`: 0x40 blue, 0x80 red,
// 0x00 neutral. The win check at 1c0d:000c loops the whole site array, ignores absent sites, ignores
// everything that is not a capital, and returns 1 only when every active capital carries the side's
// owner bits. There is no separate capital flag, and a neutral capital blocks both sides.
//
// For 1918, 1942 and 1986 the file (web/data/eras.json, baked from CBR-TYPE.DTn) carries the
// subtype and the owner, so this module reads them and invents nothing:
//   1918: 10 London blue, 11 Berlin red, 17 Paris blue                        (3)
//   1942: 10 London blue, 11 Berlin red, 17 Paris red, 35 Tokyo red,
//         62 Washington blue, 63 Moscow blue                                  (6)
//   1986: 10 London blue, 35 Tokyo blue, 62 Washington blue, 63 Moscow red    (4)
// 2023 and ???? carry no subtype-1/2 row at all, so their two capitals cannot come from the data:
// they are rolled at launch by rollCapitals() below.
import { eraTable } from "./era.mjs";

export const CAPITAL_TYPES = [1, 2];
const SIDES = ["blue", "red"];

function isCapitalType(value) {
  const type = Number(value);
  return type === 1 || type === 2;
}

// The era's capital rows, from the baked table: [{ id, type, owner }]. `source` is "file" when the
// original wrote the owners from its data file, "rolled" when the year ships none.
export function capitalRows(era) {
  const table = eraTable(era);
  if (!table) return { era: String(era), source: "none", rows: [] };
  const rows = table.sites.filter((row) => isCapitalType(row.type));
  // `source` is read as evidence (the A4 drift guard), so it is derived from the rows themselves:
  // rows present means the file named the owners, no rows means the year rolled them. The old
  // ownerSource-first form had a dead branch - with rows present it always answered "file" - and a
  // table that claims rolled owners while carrying capital rows would have been reported as file.
  // That is a baked-data contradiction, so it fails rather than being papered over.
  const source = rows.length ? "file" : "rolled";
  if (rows.length && table.ownerSource !== "file") {
    throw new Error("era " + era + " carries capital rows but ownerSource is " + JSON.stringify(table.ownerSource));
  }
  return { era: String(era), source, rows };
}

// The file's capitals, joined to the site list the match is being built from, so a capital carries
// its id, its name and its cell. A row with no live site is reported, never silently dropped: the
// 84-row table and the site list disagreeing is a data bug worth failing on.
export function capitalsFromFile(era, sites) {
  const { rows, source } = capitalRows(era);
  const byId = new Map((sites || []).map((site) => [Number(site && site.id), site]));
  const missing = [];
  const list = [];
  for (const row of rows) {
    const site = byId.get(Number(row.id));
    if (!site) {
      missing.push(Number(row.id));
      continue;
    }
    list.push({
      siteId: Number(row.id),
      name: site.name,
      x: Number(site.x),
      y: Number(site.y),
      owner: SIDES.includes(row.owner) ? row.owner : null,
    });
  }
  return { era: String(era), source, list, missing };
}

// A small deterministic generator. Same seed, same capitals: a rolled era must be reproducible in a
// test and in a replay, which a bare Math.random() would break.
function mulberry32(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(value) {
  if (Number.isInteger(value)) return value >>> 0;
  const text = String(value === undefined || value === null ? "" : value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// A site that can hold a capital: on the map, a city or a capital by the asset list's word, not a
// dock or an oil well.
function holdable(site) {
  if (!site) return false;
  if (!Number.isFinite(Number(site.x)) || !Number.isFinite(Number(site.y))) return false;
  const kind = String(site.kind || "");
  return kind === "city" || kind === "capital" || kind === "base";
}

// ROLLED YEARS (2023, ????): two capitals, one for each side, drawn at launch from the sites that
// side already owns, so a rolled capital is always inside its own territory and never lands in
// enemy ground at round 0. Deterministic in `seed`, distinct by construction, and blue draws first.
//
// The distribution is a choice, not a measurement: what the original's overlay functions
// (FUN_23aa_0e1c, FUN_23aa_054c) actually do is still UNVERIFIED. This rule is recorded here and in
// docs/re/ERA_PHASE_B_SPEC.md so it can be checked against a captured 2023/???? launch later.
export function rollCapitals(sites, seed) {
  const random = mulberry32(seedOf(seed));
  const pool = (sites || []).filter(holdable);
  const picked = [];
  for (const side of SIDES) {
    const own = pool.filter((site) => site.owner === side && !picked.some((p) => p.siteId === Number(site.id)));
    // A side with no owned site to draw from falls back to any holdable site it does not already
    // share a cell with. Rolled years seed their owners from the country table, so this is a guard,
    // not the normal path.
    const from = own.length ? own : pool.filter((site) => !picked.some((p) => p.siteId === Number(site.id)));
    if (!from.length) continue;
    const site = from[Math.floor(random() * from.length) % from.length];
    picked.push({
      siteId: Number(site.id),
      name: site.name,
      x: Number(site.x),
      y: Number(site.y),
      owner: side,
      rolled: true,
    });
  }
  return picked;
}

// The set the match and the win check use: the file's capitals for the measured years, two rolled
// capitals for the years the file has none.
export function capitalSet(era, sites, seed) {
  const fromFile = capitalsFromFile(era, sites);
  if (fromFile.list.length) return fromFile;
  const list = rollCapitals(sites, seed === undefined ? era : seed);
  return { era: String(era), source: "rolled", list, missing: [] };
}

// Which side holds this capital right now, given the match's site records. A capital with no owner
// byte is held by nobody: that is the neutral capital the original lets block both sides.
export function holderOf(match, capital) {
  const site = (match.sites || []).find((place) => place && Number(place.id) === Number(capital.siteId));
  if (!site) return null;
  return SIDES.includes(site.owner) ? site.owner : null;
}

// The original's win condition: one side owns every active capital. Returns that side or null.
// Called from the capture path only - a capital changing hands is the only thing that can end a
// match, so the check never runs on a quiet round.
export function winnerOf(match) {
  const list = (match.capitals && match.capitals.list) || [];
  if (!list.length) return null;
  let winner = null;
  for (const capital of list) {
    const holder = holderOf(match, capital);
    if (!holder) return null;
    if (winner === null) winner = holder;
    else if (winner !== holder) return null;
  }
  return winner;
}

export const CAPITAL_SIDES = SIDES.slice();
