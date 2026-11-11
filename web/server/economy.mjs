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

import { payEvery, priceOf, cityIncome, capitalPays } from "./rules.mjs";
import { upkeepResources } from "./resources.mjs";
// Where a purchase may stand. One rule, one module: the page paints the mask this module returns.
import { canPlace } from "./placement.mjs";
import { CELL_W } from "./board.mjs";
// The opening owner bits, for the years the original wrote them from a file.
import { eraTable } from "./era.mjs";

const SIDES = Object.freeze(["blue", "red"]);

// Site kinds. Cities and capitals come from the board payload; docks and oilfields are
// the same asset list with other kinds.
const CITY_KINDS = new Set(["city"]);
const DOCK_KINDS = new Set(["dock", "docks"]);
const WELL_KINDS = new Set(["oilfield", "well"]);
// A capital is occupiable and its owner byte is who holds it: the era table writes the scenario's
// opening holder (1942 hands both seats to blue), and a capture overwrites the byte. The byte is
// the win condition's own field, not a country claim - no income is ever counted from a capital.
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
  cruiser: "sea",
  carrier: "sea",
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
  // For the years the original wrote owners from a file (1918/1942/1986) that table is the opening:
  // a site it names keeps the owner it arrived with, including `null` for the neutrals the file
  // clears. Falling back to the country there would re-own every unaligned city the original leaves
  // alone, and 1918's blue holds Britain and France, not just country 0. Docks and oil wells are
  // not in the 84-row table - they carry no `type` - and 2023 rolls its owners in B-3, so both keep
  // country seeding for now.
  const table = eraTable(match.era);
  const fromFile = Boolean(table && table.ownerSource === "file");
  for (const site of match.sites) {
    if (!site || !ownable(site.kind)) continue;
    if (site.owner === "blue" || site.owner === "red") continue;
    if (fromFile && site.type !== undefined) continue;
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
  if (!Number.isFinite(price)) return { error: `No price for a ${unitKind}.` };

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
  // occupy() leaves paying-site counts behind for pay(); a well changing hands changes only the
  // informational well count, so patch that summary instead of forcing pay() to rescan.
  const tally = match.incomeSummary;
  if (tally && from !== side) {
    if ((from === "blue" || from === "red") && tally[from].wells > 0) tally[from].wells -= 1;
    if (side === "blue" || side === "red") tally[side].wells += 1;
  }
  return [{ type: "capture", site: well.id, name: well.name, side, from }];
}

// --- occupation: what standing on a site does ----------------------------------------------
//
// A well was the only site a piece could take, which left every city and both capitals
// decorative: income could never move with the map. Standing on a site is now the capture
// rule. A city or dock changes hands permanently; a capital's owner byte is what the win
// condition reads, so taking the center cell rewrites it and the seat is whoever took it last.
export function occupy(match) {
  const events = [];
  if (!match || !Array.isArray(match.sites) || !Array.isArray(match.pieces)) return events;
  seedOwners(match);

  // One pass over the pieces, not one pass per site: with 84 sites and 1000 rooms a round the
  // per-site filter was the difference between 10x and 3x headroom in the capacity bench. A cell
  // key is numeric and a side is a bit, so the pass allocates nothing per piece.
  const byCell = new Map();
  for (const piece of match.pieces) {
    if (!piece || !isSide(piece.side)) continue;
    const key = Number(piece.y) * CELL_W + Number(piece.x);
    byCell.set(key, (byCell.get(key) || 0) | (piece.side === "blue" ? 1 : 2));
  }

  // Income counts are a by-product of this same pass: pay() runs every round now, and a second
  // walk of the site list per round per room is a measurable slice of the bench budget.
  const tally = {
    blue: { cities: 0, capitals: 0, wells: 0 },
    red: { cities: 0, capitals: 0, wells: 0 },
  };

  for (const site of match.sites) {
    if (!site) continue;
    const kind = site.kind;
    const holder = occupiable(kind) ? byCell.get(Number(site.y) * CELL_W + Number(site.x)) || 0 : 0;

    // A capital is taken the same way and kept the same way; what makes it different is that
    // the win condition reads it, and a piece standing on it is the freshest fact.
    const side = holder === 1 ? "blue" : holder === 2 ? "red" : null; // contested or empty: nobody holds it
    if (side && site.owner !== side) {
      events.push({ type: "capture", site: site.id, name: site.name, kind, side, from: site.owner ?? null });
      site.owner = side;
    }

    const owner = site.owner;
    if (owner !== "blue" && owner !== "red") continue;
    const row = tally[owner];
    if (kind === "city") row.cities += 1;
    else if (kind === "capital") row.capitals += 1;
    else if (WELL_KINDS.has(kind)) row.wells += 1;
  }

  match.incomeSummary = tally;
  return events;
}

// --- income ------------------------------------------------------------------------------

export function payoutFor(match, side) {
  const counts = incomeCounts(match);
  const { cities, wells } = counts[side] || { cities: 0, wells: 0 };
  // A city pays cityIncome millions every round. A well gives oil (resources.mjs), never cash;
  // `wells` is reported so the economy dialogue can show what is held, and `cashWells` is the
  // part that pays, which is always zero. Bases are not ownable at all and pay nothing.
  const amount = cities * cityIncome();
  return { cities, wells, cashWells: 0, amount };
}

// Both sides' paying-site counts in one pass over the sites. pay() runs every round now, so a
// per-side scan of 84 sites per side per room would be paid for every room every round.
function incomeCounts(match) {
  const counts = { blue: { cities: 0, wells: 0 }, red: { cities: 0, wells: 0 } };
  const paysCapital = capitalPays();
  for (const site of match.sites) {
    if (!site) continue;
    const side = site.owner;
    if (side !== "blue" && side !== "red") continue;
    const row = counts[side];
    if (CITY_KINDS.has(site.kind) || (paysCapital && CAPITAL_KINDS.has(site.kind))) row.cities += 1;
    else if (WELL_KINDS.has(site.kind)) row.wells += 1;
  }
  // A restored row can list a city whose site owner has since changed; the list is the second
  // source. It is normally empty, so this pass costs nothing on the hot path.
  for (const side of SIDES) {
    const seat = seatOf(match, side);
    const listed = seat && Array.isArray(seat.cities) ? seat.cities : null;
    if (!listed || listed.length === 0) continue;
    for (const id of listed) {
      const site = match.sites.find((entry) => entry && entry.id === id);
      if (!site || site.owner === side) continue;
      if (CITY_KINDS.has(site.kind) || (paysCapital && CAPITAL_KINDS.has(site.kind))) counts[side].cities += 1;
    }
  }
  return counts;
}

// Income lands every round (payEvery, Manual p.27): cityIncome millions per city and nothing per
// well. Capitals pay only when config money.capitalPays is true (UNVERIFIED, off by default). A
// finished match pays nothing. A side whose pool was never funded - cash not a number, or already
// short (negative) - is not paid.
export function pay(match) {
  if (!match || !Array.isArray(match.sites) || !match.sides) return [];
  seedOwners(match);
  if (match.over) return [];
  const round = Number(match.round);
  const every = Number(payEvery());
  if (!Number.isInteger(round) || !Number.isFinite(every) || every <= 0) return [];
  if (round <= 0 || round % every !== 0) return [];

  const events = [];
  // occupy() already walked every site this round and left both sides' paying counts behind.
  // Use it when it is fresh; otherwise (a direct pay() call in a test) count here.
  let tally = match.incomeSummary;
  if (tally) delete match.incomeSummary;
  if (!tally) {
    const blue = { cities: 0, capitals: 0, wells: 0 };
    const red = { cities: 0, capitals: 0, wells: 0 };
    for (const site of match.sites) {
      if (!site) continue;
      const owner = site.owner;
      if (owner !== "blue" && owner !== "red") continue;
      const row = owner === "blue" ? blue : red;
      if (site.kind === "city") row.cities += 1;
      else if (site.kind === "capital") row.capitals += 1;
      else if (WELL_KINDS.has(site.kind)) row.wells += 1;
    }
    tally = { blue, red };
  }
  const paysCapital = capitalPays();
  const perCity = cityIncome();
  for (const side of SIDES) {
    const seat = seatOf(match, side);
    if (!seat) continue;
    if (!Number.isFinite(seat.cash) || seat.cash < 0) {
      events.push({ type: "income_skipped", side, reason: "short", round });
      continue;
    }
    const row = tally[side];
    const cities = row.cities + (paysCapital ? row.capitals : 0);
    const wells = row.wells;
    const amount = cities * perCity;
    seat.cash += amount;
    events.push({ type: "income", side, round, cities, wells, cashWells: 0, amount });
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
