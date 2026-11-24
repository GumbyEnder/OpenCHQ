// The nuke's damage arm (PB-230). Owner: game, 2026-11-24.
//
// Manual p.30: a nuke is used once, aimed at a map cell, and costs 10 billion (p.28 USE NUKES 10).
// Its kill zone destroys everything within three spaces of ground zero - land, sea and air units,
// cities, bases and oil fields, BOTH sides' - and leaves wasteland behind, where attrition is
// extreme enough to kill (p.21). Satellites and satellite killers are above the board and are
// untouched.
//
// WHAT IS MEASURED AND WHAT IS NOT
//   * cost 10b: config `prices.nuke` (manual p.28), charged by late.mjs before this module runs.
//   * three-nuke lead: DECODED (PB-156), late.nukeStatus.
//   * capital exclusion: the guard exists in the archive but its size was never printed, so
//     `nukes.exclusion` (2 cells) stays a STAND-IN and every refusal says so.
//   * kill radius 3: "within three spaces" is a PORT DECISION, not a decode. It is stored as
//     `nukes.killRadius` and read as CHEBYSHEV distance (a square), because that is how this build
//     already reads every other radius (capital exclusion, satellite scan). UNVERIFIED against the
//     original: Ghidra or a DOSBox leg can settle the shape and the count.
//   * wasteland attrition: the rate is the existing `combat.attritionPerRound.wasteland` stand-in.
//     The lethality is not a new number - move.attritionStep has always given wasteland a floor of
//     0 and every other terrain a 20% floor - it only needs the cell to READ as wasteland.
//
// Geometry and removal are blast.mjs's (PB-231), so the build has ONE radius rule: the killer
// satellite and the nuke cannot drift apart.

import { blastHits, inSquare, STAND_IN } from "./blast.mjs";
import { rules } from "./rules.mjs";
import { CELL_W, TERRAIN, boardPayload } from "./board.mjs";
import { countryName } from "./countries.mjs";
import { NO_REGION, regionAt, regionSites, territoryReady } from "./territory.mjs";
import { siteAtCell } from "./siteindex.mjs";
import { capitalRows } from "./capitals.mjs";

// A blast with no usable radius configured refuses rather than picking a number here: 3 is the
// manual's count and config carries it, so a null answer means the config lost a key this ticket
// added, not that a default is wanted.
export const NUKE_RADIUS_UNKNOWN = "This build's nuke has no kill radius configured, so a launch is refused.";

export const NUKE_NEEDS_CELL = "A nuke needs a target cell: pick the ground you want to hit.";
export const NUKE_OFF_MAP = "The target is off the map.";
// The ring's size is config, so the sentence reads it instead of printing a number that a config
// move would leave lying (frodo's PB-230 card finding 6).
export function capitalText() {
  return "Too close to a capital. SDI/ABM keeps a ring around every capital; " + exclusionRadius() +
    " cells is a " + STAND_IN + " (the archive kept the guard but never printed its size).";
}
export const NUKE_HOME_COUNTRY = "That cell is in your own home country. A nuke may not be used on home ground, " +
  "even where it has been invaded.";
export const NUKE_HOME_UNKNOWN = "This match's capitals or territory did not resolve, so a nuke cannot tell your " +
  "home country from a target.";

// Water as the walker reads it (board.TERRAIN 0-2: ocean, docks, shallows). A lake is land with its
// own attrition, so a lake in the blast becomes wasteland like any other land cell.
const WATER = new Set(["ocean", "docks", "shallows"]);

// The site kinds a blast levels. Capitals are NOT in this set: the kill radius can reach a capital
// from outside the exclusion ring, and the manual's list (p.30) is units, cities, bases and oil
// fields. A dock is a port, not one of the three, and stays standing.
const DESTROYABLE = new Set(["city", "base", "oilfield"]);

// null = the config has no usable nuke radius. The caller refuses; it never substitutes a number,
// because 3 comes from the manual and lives in config, so a missing key is a lost key, not a default.
export function killRadius() {
  const value = Number((rules().nukes || {}).killRadius);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function exclusionRadius() {
  const value = Number((rules().nukes || {}).exclusion);
  return Number.isInteger(value) && value >= 1 ? value : 2;
}

function wrapX(x) {
  return ((Number(x) % CELL_W) + CELL_W) % CELL_W;
}

// The board's own grid, read the way move.mjs reads it: cached once per process, null when the
// extract is missing. A host with no terrain cannot tell land from water, so a blast there paints
// no wasteland rather than guessing.
let cellsCache;
function grid() {
  if (cellsCache !== undefined) return cellsCache;
  try {
    cellsCache = boardPayload().cells || null;
  } catch {
    cellsCache = null;
  }
  return cellsCache;
}

function terrainName(x, y) {
  const cells = grid();
  if (!cells) return null;
  const id = cells[Number(y) * CELL_W + wrapX(x)];
  return id === undefined || id === null ? null : TERRAIN[Number(id)] || null;
}

// The bundled roster. A site's country is a property of the map, not of who holds it, so the era's
// country map answers the same before and after a capture; ownership always comes from the match's
// live row, which is read first. This exists so a match whose own roster dropped a site still names
// that site's country instead of calling the ground foreign.
let bundledSitesCache;
function bundledSites() {
  if (bundledSitesCache !== undefined) return bundledSitesCache;
  try {
    bundledSitesCache = boardPayload().sites || [];
  } catch {
    bundledSitesCache = [];
  }
  return bundledSitesCache;
}

function countryOfSite(site) {
  if (!site) return null;
  const country = site.country_id;
  return country === undefined || country === null ? null : Number(country);
}

function siteById(match, id) {
  if (id === undefined || id === null) return null;
  const live = (match && Array.isArray(match.sites) ? match.sites : [])
    .find((place) => place && String(place.id) === String(id));
  return live || bundledSites().find((place) => place && String(place.id) === String(id)) || null;
}

// ONE capital resolution, read by BOTH refusals (PM 8963 / frodo 8962 §4). The era's capital set
// joined to live sites is the resolved set; the seat pair (`match.capitals`) is the fallback for a
// match that carries no set, and that fallback reports itself incomplete so the caller fails closed.
//
// `side` is the set's own holder byte, captured when the set was built - that is what makes the
// home-country refusal hold after an invasion: the site's live owner flips and the set's answer does
// not. `complete` is false when the set reported missing rows, joined to nothing, or a row has no
// usable cell, because a partial set silently shrinks home ground (PB-228's precedent).
export function resolvedCapitals(match) {
  const set = match && match.capitalSet;
  const list = [];
  let declared = false;
  let complete = false;
  if (set && Array.isArray(set.list)) {
    declared = true;
    // The era's own holder bytes, by site id. `capitalSet.list` rows built from the file carry the
    // SITE's owner, which is still null before seedOwners, so the file's row is the authority on
    // which side a capital belongs to - and it is static, which is what makes the answer hold after
    // an invasion.
    let fileOwners = new Map();
    try {
      for (const row of capitalRows(String((match && match.era) ?? "")).rows) {
        fileOwners.set(String(row.id), row.owner);
      }
    } catch {
      fileOwners = new Map();
    }
    for (const row of set.list) {
      if (!row) continue;
      const site = siteById(match, row.siteId) || siteAtCell((match && match.sites) || [], row.x, row.y);
      const x = Number(site && site.x !== undefined ? site.x : row.x);
      const y = Number(site && site.y !== undefined ? site.y : row.y);
      const holder = row.owner !== undefined && row.owner !== null ? row.owner
        : (row.drawnBy !== undefined && row.drawnBy !== null ? row.drawnBy
          : (fileOwners.get(String(row.siteId)) ?? (site && site.owner)));
      list.push({
        side: holder === "blue" || holder === "red" ? holder : null,
        siteId: row.siteId !== undefined && row.siteId !== null ? Number(row.siteId) : null,
        name: (site && site.name) || row.name || null,
        x,
        y,
        country: countryOfSite(site),
      });
    }
    complete = list.length > 0
      && !(Array.isArray(set.missing) && set.missing.length > 0)
      && list.every((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y));
  } else if (match && match.capitals) {
    declared = true;
    const sites = Array.isArray(match.sites) ? match.sites : [];
    for (const side of ["blue", "red"]) {
      const at = match.capitals[side];
      if (!at || !Number.isFinite(Number(at.x)) || !Number.isFinite(Number(at.y))) continue;
      const site = siteAtCell(sites, at.x, at.y);
      list.push({
        side,
        siteId: site ? Number(site.id) : null,
        name: (site && site.name) || null,
        x: Number(at.x),
        y: Number(at.y),
        country: countryOfSite(site),
      });
    }
  }
  return { list, declared, complete };
}

// The countries a seat's home ground is in: every country one of THIS side's capitals stands in,
// from the same resolved set the exclusion ring reads. Owner-independent on purpose (the manual's
// refusal says "even if it's been invaded"), and deliberately NOT late.homeCountries(), which
// follows the HOLDER because aid's rule is about the opponent's ground as it stands today.
export function homeCountriesOf(match, side) {
  const { list, declared } = resolvedCapitals(match);
  if (!declared) return null;
  const out = new Set();
  for (const capital of list) {
    if (capital.side !== side) continue;
    // A side's capital whose country cannot be named makes the home SET unknowable, not smaller:
    // refusing on the missing one is PB-228's partial-set rule applied to this guard.
    if (capital.country === null) return null;
    out.add(capital.country);
  }
  if (out.size) return out;
  // A set that carries no holder bytes (a hand-built fixture) still answers from the seat's own
  // capital cell. Country ids are static, so this loses nothing after an invasion.
  const at = match && match.capitals && match.capitals[side];
  if (at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.y))) {
    const here = siteAtCell((match && match.sites) || [], at.x, at.y);
    const country = countryOfSite(here);
    if (country !== null) out.add(country);
  }
  return out.size ? out : null;
}

// The country a cell stands in, through the era's own region -> site row (CBR-REGN), so a cell with
// no site ON it still answers. A null country means the map has no answer for this cell - an
// unassigned region, a region row with no site, or a site with no country byte - and the caller
// refuses rather than reading that as foreign ground (PM 8963).
export function cellCountry(match, x, y) {
  if (!match || !territoryReady()) return null;
  const era = String(match.era ?? "");
  const rows = regionSites(era);
  if (!Array.isArray(rows)) return null;
  const region = regionAt(x, y);
  if (region === NO_REGION) return { country: null, region, reason: "no region" };
  const siteId = rows[region];
  if (siteId === undefined || siteId === null) return { country: null, region, reason: "no site row" };
  const site = siteById(match, siteId);
  if (!site) return { country: null, region, reason: "no site" };
  const country = countryOfSite(site);
  return { country, region, reason: country === null ? "no country byte" : null };
}

// Whether a capital's exclusion ring covers this cell. Every capital of the resolved set, both
// sides: the archive's guard is around home ground, and a player may not use the other side's ring
// to snipe a capital either. Reading the same set as the home-country refusal is the point - with
// two sources, a set that lost a capital would move one refusal and not the other.
export function nearCapital(match, cell) {
  const radius = exclusionRadius();
  for (const capital of resolvedCapitals(match).list) {
    if (Math.abs(capital.x - cell.x) <= radius && Math.abs(capital.y - cell.y) <= radius) return capital;
  }
  return null;
}

// The aim check: every refusal sits above the charge, so a refused launch costs 0.
export function nukeTarget(match, side, target) {
  if (!target || target.x === undefined || target.y === undefined) return { error: NUKE_NEEDS_CELL };
  const x = Number(target.x);
  const y = Number(target.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y > 135) return { error: NUKE_OFF_MAP };
  const cell = { x: wrapX(x), y };
  // The radius is config, and a missing key refuses here rather than inside nukeStrike: a launch
  // that bought a strike with no zone would be the one path that charges for nothing.
  const radius = killRadius();
  if (radius === null) return { error: NUKE_RADIUS_UNKNOWN };
  const capital = nearCapital(match, cell);
  if (capital) return { error: capitalText(), capital: { x: capital.x, y: capital.y, side: capital.side } };
  // b(ii) fails closed (PM 8963): a match that cannot name its capitals, a set that did not fully
  // resolve, a home-country set that came back empty, and a cell the territory map cannot name all
  // refuse and charge 0 rather than reading "I could not tell" as "not home ground". Every one of
  // these sits above the charge in late.useTool, so a refusal costs 0.
  const capitals = resolvedCapitals(match);
  const home = capitals.declared ? homeCountriesOf(match, side) : null;
  if (!capitals.declared || !capitals.complete || !home) {
    return { error: NUKE_HOME_UNKNOWN, capitals: { declared: capitals.declared, complete: capitals.complete, resolved: home ? home.size : 0 } };
  }
  const here = cellCountry(match, cell.x, cell.y);
  if (!here || here.country === null) {
    return { error: NUKE_HOME_UNKNOWN, cell: { x: cell.x, y: cell.y }, reason: here ? here.reason : "no territory" };
  }
  if (home.has(here.country)) {
    const named = countryName(here.country);
    return {
      error: NUKE_HOME_COUNTRY,
      country: here.country,
      name: named || null,
    };
  }
  return { ok: true, cell, homeGuard: true };
}

// Which cells the blast turns to wasteland: every land cell in the square, the destroyed sites'
// own cells included. Returned sorted and de-duplicated so two runs on one seed produce the same
// event, the same list and the same digest.
export function wastelandCells(match, at, radius = killRadius()) {
  const out = [];
  if (!Number.isInteger(radius) || radius < 1) return out;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const y = at.y + dy;
    if (y < 0 || y > 135) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = wrapX(at.x + dx);
      const name = terrainName(x, y);
      if (!name || WATER.has(name)) continue;
      out.push(x + "," + y);
    }
  }
  return [...new Set(out)].sort();
}

export function wastelandAt(match, x, y) {
  if (!match || !Array.isArray(match.wasteland)) return false;
  return match.wasteland.includes(wrapX(x) + "," + Number(y));
}

// The terrain lookup attritionStep takes (move.mjs): a wasteland cell reads as wasteland, everything
// else reads the board. Built once per round, not once per piece.
export function wastelandTerrain(match) {
  const list = Array.isArray(match.wasteland) ? match.wasteland : [];
  // No blast has landed in this room: hand back null so move.attritionStep keeps its own grid path
  // (and its per-round cost) exactly as it was before this ticket.
  if (!list.length) return null;
  const set = new Set(list);
  return (piece) => (set.has(wrapX(piece.x) + "," + Number(piece.y))
    ? "wasteland"
    : terrainName(piece.x, piece.y));
}

function addWasteland(match, cells) {
  const have = new Set(Array.isArray(match.wasteland) ? match.wasteland : []);
  const added = [];
  for (const key of cells) {
    if (have.has(key)) continue;
    have.add(key);
    added.push(key);
  }
  match.wasteland = [...have].sort();
  return added;
}

// The strike itself. Pure in the sense that it is the one writer: it reads the match, removes what
// the blast caught, paints the ground and hands back the events. The caller (late.mjs) owns the
// price, the counters, the warning and the winter roll.
export function nukeStrike(match, side, at) {
  const radius = killRadius();
  const hits = blastHits(match.pieces, at, { radius });
  if (!hits.ok) return { error: hits.error };
  match.pieces = hits.survivors;

  const doomed = [];
  const kept = [];
  for (const site of Array.isArray(match.sites) ? match.sites : []) {
    if (!site) continue;
    const caught = DESTROYABLE.has(String(site.kind)) && inSquare(at, site, radius);
    if (caught) doomed.push(site);
    else kept.push(site);
  }
  if (doomed.length) match.sites = kept;

  const painted = addWasteland(match, wastelandCells(match, at, radius));

  return { radius, cell: hits.cell, pieces: hits.killed, sites: doomed, wasteland: painted };
}

// The one sentence the player reads. It names the stand-in rather than letting a radius of 3 read
// as recovered, and counts what actually died instead of describing the rule.
export function nukeNote(strike) {
  const pieces = strike.pieces.length;
  const sites = strike.sites.length;
  return `Nuke at ground zero: ${pieces} unit${pieces === 1 ? "" : "s"} and ${sites} ` +
    `site${sites === 1 ? "" : "s"} destroyed within ${strike.radius} cells ` +
    `(${strike.radius} is a ${STAND_IN}; the kill zone is read as a square). ` +
    `The ground there is wasteland.`;
}
