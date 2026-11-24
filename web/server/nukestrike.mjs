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

// A blast with no radius configured refuses rather than picking a number here.
export const KILL_RADIUS_FALLBACK = 3;

export const NUKE_NEEDS_CELL = "A nuke needs a target cell: pick the ground you want to hit.";
export const NUKE_OFF_MAP = "The target is off the map.";
export const NUKE_CAPITAL = "Too close to a capital. SDI/ABM keeps a ring around every capital; 2 cells is a " +
  STAND_IN + " (the archive kept the guard but never printed its size).";
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

export function killRadius() {
  const value = Number((rules().nukes || {}).killRadius);
  return Number.isInteger(value) && value >= 1 ? value : KILL_RADIUS_FALLBACK;
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

// The country a seat's home ground is in. Owner-independent on purpose: the manual's refusal says
// "even if it's been invaded", so this reads which country the side's CAPITAL stands in, not who
// currently holds it. That is deliberately NOT late.homeCountries(), which follows the HOLDER
// because aid's rule is about the opponent's ground as it stands today.
//
// The seat's capital is `match.capitals[side]`; the capital set row that stands on that cell names
// its site, and the site names its country. A match that lost its capital set still answers from the
// site under the capital cell, and a match where neither resolves returns null so the caller refuses
// rather than guessing.
export function homeCountriesOf(match, side) {
  const at = match && match.capitals && match.capitals[side];
  const sites = (match && Array.isArray(match.sites)) ? match.sites : [];
  if (!at || !sites.length) return null;
  const out = new Set();
  const set = match.capitalSet;
  if (set && Array.isArray(set.list)) {
    for (const row of set.list) {
      if (!row || Number(row.x) !== Number(at.x) || Number(row.y) !== Number(at.y)) continue;
      const site = sites.find((place) => place && Number(place.id) === Number(row.siteId))
        || siteAtCell(sites, row.x, row.y);
      const country = site && site.country_id;
      if (country !== undefined && country !== null) out.add(Number(country));
    }
  }
  if (!out.size) {
    const here = siteAtCell(sites, at.x, at.y);
    const country = here && here.country_id;
    if (country !== undefined && country !== null) out.add(Number(country));
  }
  return out.size ? out : null;
}

// The country a cell stands in, through the era's own region -> site row (CBR-REGN), so a cell with
// no site on it still answers. null = the map has no answer for this cell (unassigned region, or no
// territory extract), which the caller must not read as "not home" by accident.
export function cellCountry(match, x, y) {
  if (!match || !territoryReady()) return null;
  const era = String(match.era ?? "");
  const rows = regionSites(era);
  if (!Array.isArray(rows)) return null;
  const region = regionAt(x, y);
  if (region === NO_REGION) return { country: null, region };
  const siteId = rows[region];
  if (siteId === undefined || siteId === null) return { country: null, region };
  const site = (match.sites || []).find((place) => place && Number(place.id) === Number(siteId));
  if (!site) return { country: null, region };
  const country = site.country_id;
  return { country: country === undefined || country === null ? null : Number(country), region };
}

function capitalCells(match) {
  const out = [];
  for (const side of ["blue", "red"]) {
    const at = match && match.capitals && match.capitals[side];
    if (at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.y))) {
      out.push({ side, x: Number(at.x), y: Number(at.y) });
    }
  }
  return out;
}

// Whether a capital's exclusion ring covers this cell. Every capital, both sides: the archive's
// guard is around home ground, and a player may not use the other side's ring to snipe a capital
// either.
export function nearCapital(match, cell) {
  const radius = exclusionRadius();
  for (const capital of capitalCells(match)) {
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
  if (nearCapital(match, cell)) return { error: NUKE_CAPITAL };
  // Fail closed only where the match CLAIMS a capital set and it does not resolve - the PB-228 shape,
  // where a partial set would silently shrink home ground. A match with no capital set at all (a
  // fixture, or a room from before capitals landed) has no home ground to defend, so the guard is
  // recorded as not run rather than turning the tool into a refusal nobody can act on.
  const declared = Boolean(match.capitalSet && Array.isArray(match.capitalSet.list) && match.capitalSet.list.length);
  const home = homeCountriesOf(match, side);
  if (!home && declared) return { error: NUKE_HOME_UNKNOWN };
  const here = home ? cellCountry(match, cell.x, cell.y) : null;
  if (home && here && here.country !== null && home.has(here.country)) {
    const named = countryName(here.country);
    return {
      error: NUKE_HOME_COUNTRY,
      country: here.country,
      name: named || null,
    };
  }
  return { ok: true, cell, homeGuard: Boolean(home && here) };
}

// Which cells the blast turns to wasteland: every land cell in the square, the destroyed sites'
// own cells included. Returned sorted and de-duplicated so two runs on one seed produce the same
// event, the same list and the same digest.
export function wastelandCells(match, at, radius = killRadius()) {
  const out = [];
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
