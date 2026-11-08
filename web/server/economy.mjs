// Buying, oil ownership, income and per-side fuel. Owner: A6.
//
// Every function here mutates the match it is given, in place: `match.sites` owners,
// `match.sides[side].cash`, `.fuel`, `.dry`, and the piece list for a purchase. No disk,
// no network, no timers, no randomness.
//
// Every figure comes from config/game.json through rules.mjs. The only literals in this
// file are side names, site kinds, the two country names the extract's own country list
// starts with (USA, USSR), and the stand-in "unready" flag, which carries no duration
// because no duration was recovered.

import { payEvery, priceOf } from "./rules.mjs";
import { upkeepResources } from "./resources.mjs";
// Where a purchase may stand. One rule, one module: the page paints the mask this module returns.
import { canPlace } from "./placement.mjs";

const SIDES = Object.freeze(["blue", "red"]);

// Site kinds. Cities and capitals come from the board payload; docks and oilfields are
// the same asset list with other kinds.
const CITY_KINDS = new Set(["city"]);
const DOCK_KINDS = new Set(["dock", "docks"]);
const WELL_KINDS = new Set(["oilfield", "well"]);
// A capital is occupiable but is never a country claim: it has no owner until a piece takes
// it, and losing the piece opens it again. That is the win condition's rule.
const CAPITAL_KINDS = new Set(["capital"]);

function occupiable(kind) {
  return ownable(kind) || CAPITAL_KINDS.has(kind);
}

// A unit's domain. The match's piece shape names land and sea only, so aircraft are
// bought at a city and travel with the land walkers.
const DOMAIN_BY_KIND = Object.freeze({
  infantry: "land",
  tank: "land",
  aircraft: "land",
  ship: "sea",
  submarine: "sea",
});

// A nuke stays refused: not at any round, not with any pool, not before the clock runs.
const REFUSED_KINDS = new Set(["nuke"]);
const REFUSED_NUKE = "A nuke is refused.";

// A site's country, when the asset list names one. USA is Blue. Russia matches USSR and
// is Red. Every other named region (and every unnamed site) starts neutral.
const HOME_SIDE = Object.freeze({
  usa: "blue",
  "u.s.a.": "blue",
  us: "blue",
  america: "blue",
  "united states": "blue",
  "united states of america": "blue",
  ussr: "red",
  "u.s.s.r.": "red",
  "soviet union": "red",
  russia: "red",
  "russian federation": "red",
});

function isSide(value) {
  return SIDES.includes(value);
}

function seatOf(match, side) {
  const sides = match && match.sides;
  return sides && isSide(side) ? sides[side] : null;
}

function regionOf(site) {
  if (!site) return null;
  for (const key of ["region", "countryName", "country_name", "country"]) {
    const value = site[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const id = site.country_id ?? site.countryId ?? (typeof site.country === "number" ? site.country : null);
  // The extract's country list begins USA, USSR; a bare index 0 or 1 means those two.
  // Any other index is a country whose side this module cannot name, so it stays neutral.
  if (Number.isInteger(id)) return id === 0 ? "USA" : id === 1 ? "USSR" : null;
  return null;
}

function sideOfRegion(region) {
  if (region === null || region === undefined) return null;
  const key = String(region).trim().toLowerCase();
  return Object.hasOwn(HOME_SIDE, key) ? HOME_SIDE[key] : null;
}

// Sites that a side can own: the countries' cities, their docks, and the oilfields.
// Capitals are not on this list; they are the win condition, not income.
function ownable(kind) {
  return CITY_KINDS.has(kind) || DOCK_KINDS.has(kind) || WELL_KINDS.has(kind);
}

// Ownership is seeded once per match object: a city, dock or well starts with the country
// it is in, and nothing re-seeds a site that already carries an owner, so a capture made
// later in the match is never undone here.
const seeded = new WeakSet();

export function seedOwners(match) {
  if (!match || !Array.isArray(match.sites) || seeded.has(match)) return;
  seeded.add(match);
  for (const site of match.sites) {
    if (!site || !ownable(site.kind)) continue;
    if (site.owner === "blue" || site.owner === "red") continue;
    const side = sideOfRegion(regionOf(site));
    site.owner = side; // null when the country is not one of the two sides
  }
}

function siteAt(match, x, y) {
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return null;
  return match.sites.find((site) => site && Number(site.x) === cx && Number(site.y) === cy) || null;
}

function wellAt(match, x, y) {
  const site = siteAt(match, x, y);
  return site && WELL_KINDS.has(site.kind) ? site : null;
}

function listOf(seat, key) {
  if (!seat) return [];
  if (!Array.isArray(seat[key])) seat[key] = [];
  return seat[key];
}

function holds(seat, site) {
  const id = site.id;
  return listOf(seat, "cities").includes(id) || listOf(seat, "wells").includes(id);
}

// A site is friendly to a side when that side owns it outright, or when the side's own
// list names it. Country seeding is what normally sets the owner.
function friendly(match, side, site) {
  if (!site) return false;
  if (site.owner === side) return true;
  return holds(seatOf(match, side), site);
}

function pushOnce(list, value) {
  if (!list.includes(value)) list.push(value);
}

function dropValue(list, value) {
  const at = list.indexOf(value);
  if (at >= 0) list.splice(at, 1);
}

// --- buying ------------------------------------------------------------------------------

export function buy(match, side, kind, x, y, board = null) {
  if (!match || !Array.isArray(match.sites) || !Array.isArray(match.pieces)) {
    return { error: "There is no match to buy into." };
  }
  const seat = seatOf(match, side);
  if (!seat) return { error: `Unknown side: ${side}.` };
  if (match.over) return { error: "The match is over." };

  const unitKind = String(kind ?? "");
  if (REFUSED_KINDS.has(unitKind)) return { error: REFUSED_NUKE };
  const domain = Object.hasOwn(DOMAIN_BY_KIND, unitKind) ? DOMAIN_BY_KIND[unitKind] : null;
  if (!domain) return { error: `No such unit: ${unitKind || "(none)"}.` };
  const price = priceOf(unitKind);
  if (price === null) return { error: `No price for a ${unitKind}.` };

  seedOwners(match);

  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return { error: "A purchase needs whole cells." };
  if (match.pieces.some((piece) => Number(piece.x) === cx && Number(piece.y) === cy)) {
    return { error: "Two pieces cannot share a cell." };
  }

  // Where it may stand is the placement module's rule, and the page highlights the cells that same
  // module returns. A purchase no longer needs a city or a dock: land and air go anywhere on land in
  // the seat's own zone, and a hull goes into coastal water.
  const placement = canPlace(match, side, unitKind, cx, cy, board);
  if (placement.error) return { error: placement.error };

  if (!Number.isFinite(seat.cash) || seat.cash < price) {
    return { error: `Not enough in ${side}'s pool for a ${unitKind}.` };
  }
  seat.cash -= price;

  // The build still costs the nearest held city its readiness: production happens somewhere, even
  // when the owner widened where the unit may stand.
  const home = nearestOwned(match, side, cx, cy);
  if (home) home.unready = true;

  seat.bought = Number(seat.bought || 0) + 1;
  let serial = seat.bought;
  let id = `${side}:${unitKind}:${serial}`;
  while (match.pieces.some((piece) => piece.id === id)) {
    serial += 1;
    seat.bought = serial;
    id = `${side}:${unitKind}:${serial}`;
  }

  const piece = {
    id,
    side,
    domain,
    kind: unitKind,
    x: cx,
    y: cy,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
  };
  match.pieces.push(piece);
  return { ok: true, piece };
}

// The site a purchase is charged to: the nearest one this side holds, measured with the board's own
// X wrap. Nothing is invented when the seat holds nothing; the purchase simply marks no site.
function nearestOwned(match, side, x, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const site of match.sites) {
    if (!site || site.owner !== side) continue;
    const dx = Math.abs(Number(site.x) - x);
    const wrapped = Math.min(dx, 320 - dx);
    const dy = Math.abs(Number(site.y) - y);
    const distance = Math.max(wrapped, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = site;
    }
  }
  return best;
}

// --- oil capture -------------------------------------------------------------------------

function syncWellLists(match, siteId, side) {
  for (const other of SIDES) {
    const seat = seatOf(match, other);
    if (!seat) continue;
    if (other === side) pushOnce(listOf(seat, "wells"), siteId);
    else dropValue(listOf(seat, "wells"), siteId);
  }
}

export function capture(match, side, x, y) {
  if (!match || !Array.isArray(match.sites) || !isSide(side)) return [];
  seedOwners(match);
  const well = wellAt(match, x, y);
  if (!well) return [];
  if (well.owner === side) return [];
  const from = well.owner ?? null;
  well.owner = side;
  syncWellLists(match, well.id, side);
  return [{ type: "capture", site: well.id, name: well.name, side, from }];
}

// --- occupation: what standing on a site does ----------------------------------------------
//
// A well was the only site a piece could take, which left every city and both capitals
// decorative: income could never move with the map. Standing on a site is now the capture
// rule. A city or dock changes hands permanently; a capital is held only while a piece stands
// on it, because that is what the win condition reads.
export function occupy(match) {
  const events = [];
  if (!match || !Array.isArray(match.sites) || !Array.isArray(match.pieces)) return events;
  seedOwners(match);

  // One pass over the pieces, not one pass per site: with 84 sites and 1000 rooms a round the
  // per-site filter was the difference between 10x and 3x headroom in the capacity bench.
  const byCell = new Map();
  for (const piece of match.pieces) {
    if (!piece || !isSide(piece.side)) continue;
    const key = Number(piece.x) + "," + Number(piece.y);
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(piece.side);
  }

  for (const site of match.sites) {
    if (!site || !occupiable(site.kind)) continue;
    const sides = [...new Set(byCell.get(Number(site.x) + "," + Number(site.y)) || [])];
    const holder = sides.length === 1 ? sides[0] : null; // contested or empty: nobody holds it

    // A capital is taken the same way and kept the same way; what makes it different is that
    // the win condition reads it, and a piece standing on it is the freshest fact. An open
    // capital (nobody has taken it) stays open, which is why ownership is never seeded onto one.
    if (holder && site.owner !== holder) {
      events.push({ type: "capture", site: site.id, name: site.name, kind: site.kind, side: holder, from: site.owner ?? null });
      site.owner = holder;
    }
  }
  return events;
}

// --- income ------------------------------------------------------------------------------

function ownedCities(match, side) {
  const seat = seatOf(match, side);
  const listed = new Set(listOf(seat, "cities"));
  const ids = new Set();
  for (const site of match.sites) {
    if (!site || !CITY_KINDS.has(site.kind)) continue; // capitals are not cities
    if (site.owner === side || listed.has(site.id)) ids.add(site.id);
  }
  return ids;
}

function ownedWells(match, side) {
  const ids = new Set();
  for (const site of match.sites) {
    if (site && WELL_KINDS.has(site.kind) && site.owner === side) ids.add(site.id);
  }
  return ids;
}

export function payoutFor(match, side) {
  const cities = ownedCities(match, side).size;
  const wells = ownedWells(match, side).size;
  return { cities, wells, amount: cities + wells };
}

// Income lands on every payEvery-th round: one per city held plus one per owned well.
// Capitals are not cities. A finished match pays nothing. A side whose pool was never
// funded - cash not a number, or already short (negative) - is not paid.
export function pay(match) {
  if (!match || !Array.isArray(match.sites) || !match.sides) return [];
  seedOwners(match);
  if (match.over) return [];
  const round = Number(match.round);
  const every = Number(payEvery());
  if (!Number.isInteger(round) || !Number.isFinite(every) || every <= 0) return [];
  if (round <= 0 || round % every !== 0) return [];

  const events = [];
  for (const side of SIDES) {
    const seat = seatOf(match, side);
    if (!seat) continue;
    if (!Number.isFinite(seat.cash) || seat.cash < 0) {
      events.push({ type: "income_skipped", side, reason: "short", round });
      continue;
    }
    const { cities, wells, amount } = payoutFor(match, side);
    seat.cash += amount;
    events.push({ type: "income", side, round, cities, wells, amount });
  }
  return events;
}

// --- fuel --------------------------------------------------------------------------------

// One running round for both sides, in place: a unit standing on a well takes it for its
// side; the resource model does everything else (standing on a well refills fuel, a side with
// no unit on a well burns it, a dry side is flagged and stops, and the other side is
// untouched). Fuel is one kind in config/game.json's `resources`; this function no longer
// knows a reserve, a burn rate or a field name. See resources.mjs.
export function upkeep(match) {
  if (!match || !Array.isArray(match.sites) || !Array.isArray(match.pieces)) return [];
  seedOwners(match);
  const events = [];

  for (const side of SIDES) {
    if (!seatOf(match, side)) continue;
    for (const piece of match.pieces) {
      if (piece.side !== side) continue;
      const well = wellAt(match, piece.x, piece.y);
      if (well && well.owner !== side) events.push(...capture(match, side, piece.x, piece.y));
    }
  }

  return events.concat(upkeepResources(match));
}
