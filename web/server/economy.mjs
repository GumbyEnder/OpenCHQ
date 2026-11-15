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

import { payEvery, priceOf, cityIncome, capitalPays, combatRules, missionedSurvivesCapture } from "./rules.mjs";
import { upkeepResources } from "./resources.mjs";
// Where a purchase may stand. One rule, one module: the page paints the mask this module returns.
import { canPlace, siteLabel, layerOf } from "./placement.mjs";
import { markUnready } from "./readiness.mjs";
import { CELL_W } from "./board.mjs";
import { siteAtCell, siteCells, cellKeyOf } from "./siteindex.mjs";
// The opening owner bits, for the years the original wrote them from a file.
import { eraTable } from "./era.mjs";
// A rolled era's capital set has to be drawn after owners exist, so seeding rebuilds it here.
import { capitalSetFor } from "./match.mjs";
// The berth list is air.mjs's, not a second copy here: capture destroys the enemy aircraft on the
// strip it takes, so it has to read the same set a transfer lands on and a mission flies from.
import { AIRSTRIP_KINDS, inactiveRounds } from "./air.mjs";

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
// A site an air unit can be based in. Capturing one destroys the enemy aircraft sitting on it
// (Manual printed p.10, "City Conquest"): "note that the enemy air unit was destroyed when you
// took the city. Capturing the air strip is the most certain way of destroying enemy air units."
// The set itself lives in air.mjs (AIRSTRIP_KINDS) and is imported here, so capture, transfer and
// the mission base search cannot drift apart - they did once (room 4890: a mission could be flown
// from a `dock`/`docks` site and from any non-transport hull, neither of which capture treats as
// an air strip). A carrier is a piece, not a site, so it has no entry here: it changes hands only
// by combat, and a capture pass can never reach it.

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
  // A rolled era draws its two capitals from the sites a side already owns, so the draw has to run
  // after this seeding. openMatch built the set on the unseeded board, where every owner was still
  // null: both 2023 and the concealed year came back with two NEUTRAL capitals, which blocks both
  // sides and is not the rule rollCapitals states. Same seed, so the draw stays replayable.
  if (match.capitalSet && match.capitalSet.source === "rolled") {
    const seed = match.capitalSeed === undefined || match.capitalSeed === null ? match.era : match.capitalSeed;
    match.capitalSet = capitalSetFor(match.era, match.sites, seed);
  }
}

function siteAt(match, x, y) {
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return null;
  // Indexed per site list, not searched per piece: upkeep asks this once per piece per round.
  return siteAtCell(match.sites, cx, cy);
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

  // Where it may stand is the placement module's rule (D-019, and D-025's coastal berths). That
  // module also owns the two occupancy layers, so "Two pieces cannot share a cell" is no longer
  // asked here: a plane and the ground unit in the same city are on different layers (T-021).
  // The page paints the cells that same module returns.
  const placement = canPlace(match, side, unitKind, cx, cy, board);
  if (placement.error) return { error: placement.error, site: placement.site ? placement.site.id : null };

  if (!Number.isFinite(seat.cash) || seat.cash < price) {
    return { error: `Not enough in ${side}'s pool for a ${unitKind}.` };
  }
  seat.cash -= price;

  // Production tires the city it happened in and the friendly cities around it (Manual p.27
  // "Readiness"). readiness.mjs owns the radius and duration; every constant it reads is a
  // labelled UNMEASURED stand-in in config/game.json.
  const home = placement.site || null;
  const readiness = home ? markUnready(match, side, home, unitKind) : null;
  // The cell the piece lands on. For a D-025 hull bought at a coastal city or base that is the
  // water cell beside it, docks first - the placement module resolved it.
  const at = placement.place || { x: cx, y: cy };
  const px = Number(at.x);
  const py = Number(at.y);

  seat.bought = Number(seat.bought || 0) + 1;
  let serial = seat.bought;
  let id = `${side}:${unitKind}:${serial}`;
  while (match.pieces.some((piece) => piece.id === id)) {
    serial += 1;
    seat.bought = serial;
    id = `${side}:${unitKind}:${serial}`;
  }

  const max = combatRules().maxStrength;
  const piece = {
    id,
    side,
    domain,
    kind: unitKind,
    x: px,
    y: py,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
    strength: max,
    maxStrength: max,
    pinned: false,
  };
  match.pieces.push(piece);
  return {
    ok: true,
    piece,
    readiness,
    // PB-044: the message names the place, not the coordinates. `label` is the site's own name,
    // or its kind and the nearest named city for an unnamed berth.
    site: home && home.id !== undefined ? home.id : null,
    label: home ? siteLabel(match, home) : "",
  };
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
  // Ground layer only. A plane based at a city shares its cell (T-021) but does not hold its
  // streets: counting it here let a based aircraft veto every capture of its own city and let a
  // lone unarmed plane flip a red site blue. The predicate is placement.layerOf, the same one the
  // placement mask, the walker and combat already use, so capture cannot disagree with them.
  const byCell = new Map();
  for (const piece of match.pieces) {
    if (!piece || !isSide(piece.side)) continue;
    if (layerOf(piece) !== "ground") continue;
    const key = cellKeyOf(piece);
    byCell.set(key, (byCell.get(key) || 0) | (piece.side === "blue" ? 1 : 2));
  }

  // Income counts are a by-product of this same pass: pay() runs every round now, and a second
  // walk of the site list per round per room is a measurable slice of the bench budget.
  const tally = {
    blue: { cities: 0, capitals: 0, wells: 0 },
    red: { cities: 0, capitals: 0, wells: 0 },
  };

  const sites = match.sites;
  const cells = siteCells(sites);
  // Q50(a): does a plane AWAY ON A MISSION survive its base being taken? Read once per pass, not
  // per piece. `false` (the shipped default, PM ruling rooms 5031/5045) keeps the remake's current
  // behaviour: the engine has no airborne position, so a missioned plane stands on its base cell and
  // dies with it, exactly as a plane that was sitting there. air.missionedSurvivesBaseCaptureSource
  // states that this is UNVERIFIED and needs a DOSBox experiment before anyone flips it.
  const survivorsFlyAway = missionedSurvivesCapture();
  // Air units destroyed by this pass's captures, removed once after the walk (never while the site
  // loop is still reading match.pieces).
  let doomed = null;
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    if (!site) continue;
    const kind = site.kind;
    const holder = occupiable(kind) && cells && cells[i] !== null ? byCell.get(cells[i]) || 0 : 0;

    // A capital is taken the same way and kept the same way; what makes it different is that the
    // win condition reads it, so a piece standing on it is the freshest fact about the holder.
    const side = holder === 1 ? "blue" : holder === 2 ? "red" : null; // contested or empty: nobody holds it
    if (side && site.owner !== side) {
      events.push({ type: "capture", site: site.id, name: site.name, kind, side, from: site.owner ?? null });
      site.owner = side;
      // A captured air strip destroys the enemy aircraft based on it, in this same pass (Manual
      // printed p.10: the enemy air unit is destroyed when the city is taken). "Based on it" is the
      // plane's own cell being the site's cell - the same geometry transferPlane lands it on.
      if (cells && cells[i] !== null && AIRSTRIP_KINDS.has(kind)) {
        const key = cells[i];
        for (const piece of match.pieces) {
          if (!piece || piece.side === side) continue;
          if (layerOf(piece) !== "air") continue;
          if (cellKeyOf(piece) !== key) continue;
          // The Q50(a) arm: with the flag on, a plane that is still flying its mission (its only
          // airborne marker is `inactiveUntil`) is spared and stays on the captured cell. With the
          // flag off - the shipped default - this line spares nothing and the plane dies with its
          // base, which is the behaviour Q50 records as current.
          if (survivorsFlyAway && inactiveRounds(piece, match.round) > 0) continue;
          if (!doomed) doomed = new Set();
          if (doomed.has(piece.id)) continue;
          doomed.add(piece.id);
          events.push({
            type: "destroyed",
            side: piece.side,
            pieceId: piece.id,
            kind: piece.kind,
            x: Number(piece.x),
            y: Number(piece.y),
            site: site.id,
            name: site.name,
            cause: "capture",
            round: Number(match.round) || 0,
            note: "Air unit destroyed: its air strip was captured (Manual p.10).",
          });
        }
      }
    }

    const owner = site.owner;
    if (owner !== "blue" && owner !== "red") continue;
    const row = tally[owner];
    if (kind === "city") row.cities += 1;
    else if (kind === "capital") row.capitals += 1;
    else if (WELL_KINDS.has(kind)) row.wells += 1;
  }

  if (doomed) match.pieces = match.pieces.filter((piece) => !piece || !doomed.has(piece.id));

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
