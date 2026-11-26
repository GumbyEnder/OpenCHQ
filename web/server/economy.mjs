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

import { payEvery, priceOf, cityIncome, maxCash, captureReward, combatRules, missionedSurvivesCapture } from "./rules.mjs";
import { upkeepResources, oilIncome } from "./resources.mjs";
import { peaceActive } from "./peace.mjs";
import { peaceRules } from "./rules.mjs";
import { isOilField, siteTypeOf } from "./sitetype.mjs";
// Where a purchase may stand. One rule, one module: the page paints the mask this module returns.
import { canPlace, siteLabel, layerOf } from "./placement.mjs";
import { poolReadiness, captureUnreadyRounds } from "./readiness.mjs";
import { CELL_W } from "./board.mjs";
import { siteAtCell, siteCells, cellKeyOf } from "./siteindex.mjs";
// The opening owner bits, for the years the original wrote them from a file.
import { eraTable } from "./era.mjs";
// A rolled era's capital set has to be drawn after owners exist, so seeding rebuilds it here.
import { capitalSetFor } from "./match.mjs";
// The berth list is air.mjs's, not a second copy here: capture destroys the enemy aircraft on the
// strip it takes, so it has to read the same set a transfer lands on and a mission flies from.
import { AIRSTRIP_KINDS, inactiveRounds } from "./air.mjs";
// PB-156: the income roll reads the global detonation count off the same module the launch writes.
import { detonatedCount, incomeSkipPercent, nukesEnabled, nukeRoll } from "./nukes.mjs";

const SIDES = Object.freeze(["blue", "red"]);

// Site kinds. Cities and capitals come from the board payload; docks and oilfields are
// the same asset list with other kinds.
const CITY_KINDS = new Set(["city"]);
const DOCK_KINDS = new Set(["dock", "docks"]);
// PB-153: the 20 `facility` ids are the original's type-5 oil fields.
const FACILITY_KINDS = new Set(["facility"]);
// The original captures a base as well as a city and an oil field: PB-155 pays 2 b when a
// type-3 or type-4 site changes hands, so a base has to be takeable by standing on it. Bases are
// not `ownable` (seedOwners never grants one from a country) - they only change hands in battle.
const BASE_KINDS = new Set(["base"]);
// world.json's sketched wells are draw-only: they keep a display owner (seedOwners) so they
// are painted in the country's colour, and no other rule may see them (PB-153 AC4). Kept out
// of `ownable` on purpose so a piece standing on one can never take it.
const DISPLAY_WELL_KINDS = new Set(["oilfield", "well"]);
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
  return ownable(kind) || CAPITAL_KINDS.has(kind) || BASE_KINDS.has(kind);
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

// Sites that a side can own: the cities and docks the asset list names, plus the type-5 oil
// fields (PB-153: the 20 `facility` sites, ids 64-83). world.json's sketched `oilfield`/`well`
// rows keep country seeding (they stay drawn in the country's colour) but drive no rule: they
// are not capturable and pay neither cash nor oil (PB-153 AC4).
// Capitals are not on this list; they are the win condition, not income.
function ownable(kind) {
  // PB-153: the 20 `facility` sites are type-5 oil fields and are captured by standing on them.
  // The world.json `wells` are a sketch: they keep their display owner (seedOwners) but no rule
  // may take them, so they are not occupiable. Docks and cities keep their own kinds.
  return CITY_KINDS.has(kind) || DOCK_KINDS.has(kind) || FACILITY_KINDS.has(kind);
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
    if (!site || !(ownable(site.kind) || DISPLAY_WELL_KINDS.has(String(site.kind)))) continue;
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

// The oil field under a cell: a type-5 site (PB-153). A world.json `oilfield`/`well` site is
// NOT one - it has no subtype - so the sketched wells no longer hand oil fields around.
function oilFieldAt(match, x, y) {
  const site = siteAt(match, x, y);
  return site && isOilField(site) ? site : null;
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

export function buy(match, side, kind, x, y, board = null, level = null, options = null) {
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

  // PB-262: the AI's level travels into the buy. decompiled.c 1632 is
  // `*(int *)0x1a0 < 5 && *(char *)(site + 0x10ae) != 0` -> FUN_107e_307a(site, 0) (1635), i.e.
  // levels 2-4 re-draw from ANOTHER of our sites when the site the AI picked is still counting
  // down, and level 5 buys at the picked site anyway. The level changes which site's unit the buy
  // draws from; it changes no price and no readiness arithmetic (1441 still charges the price).
  //
  // The escape is keyed on INTENT, never on the number. `level` is a report field here; the one
  // caller allowed to buy at a site whose timer is still running says so explicitly through
  // `options.allowUnreadySite`. A level-derived key (`level >= 5`) was reachable by ANY level-5
  // caller - lobby.mjs:1514 passes no level today, but a future call site that did would hand the
  // player's click the AI's exception with every arm green (frodo 9492 §4).
  const drawLevel = level === null || level === undefined
    ? null
    : (Number.isInteger(Number(level)) ? Number(level) : null);
  const allowUnreadySite = options !== null && options !== undefined
    && options.allowUnreadySite === true;

  // Where it may stand is the placement module's rule (D-019, and D-025's coastal berths). That
  // module also owns the two occupancy layers, so "Two pieces cannot share a cell" is no longer
  // asked here: a plane and the ground unit in the same city are on different layers (T-021).
  // The page paints the cells that same module returns.
  const placement = canPlace(match, side, unitKind, cx, cy, board, { allowUnreadySite });
  if (placement.error) return { error: placement.error, site: placement.site ? placement.site.id : null };

  if (!Number.isFinite(seat.cash) || seat.cash < price) {
    return { error: `Not enough in ${side}'s pool for a ${unitKind}.` };
  }
  seat.cash -= price;

  // Production tires the city it happened in and the friendly cities around it (Manual p.27
  // "Readiness"). readiness.mjs owns the radius and duration; every constant it reads is a
  // labelled UNMEASURED stand-in in config/game.json.
  const home = placement.site || null;
  const readiness = home ? poolReadiness(match, side, home, unitKind) : null;
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
    level: drawLevel,
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
  const field = oilFieldAt(match, x, y);
  if (!field) return [];
  if (field.owner === side) return [];
  const from = field.owner ?? null;
  field.owner = side;
  syncWellLists(match, field.id, side);
  // occupy() leaves paying-site counts behind for pay(); a type-5 field changing hands changes
  // only the informational field count, so patch that summary instead of forcing a rescan.
  const tally = match.incomeSummary;
  if (tally && from !== side) {
    if ((from === "blue" || from === "red") && tally[from].wells > 0) tally[from].wells -= 1;
    if (side === "blue" || side === "red") tally[side].wells += 1;
  }
  return [{ type: "capture", site: field.id, name: field.name, side, from }];
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
  // lone unarmed plane flip a red site blue. The predicate is placement.layerOf, and since T-029 it
  // is the same FUNCTION the placement mask, the walker (air.isAircraft) and combat's four air
  // checks call, not four copies of the same expression: until then the walker tested the kind
  // alone and combat inlined `kind === "aircraft" || domain === "air"`, so this sentence was true
  // of the meaning and false of the identity. web/test/nodes/t029_air_predicate.mjs is what holds it.
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
      const from = site.owner ?? null;
      events.push({ type: "capture", site: site.id, name: site.name, kind, side, from });
      site.owner = side;
      // PB-155: a captured type-3 base or type-4 city is unready for 15 rounds and pays the
      // capturer 2 b (FUN_1c0d_02ce @ 1c0d:02ce, decompiled.c 9169/9179-9182). The owner test
      // above is what makes the reward once per change of hands: a unit that keeps standing on
      // the site never re-enters this branch. A capital (1/2) and an oil field (5) pay nothing.
      const type = siteTypeOf(site);
      if (type === 3 || type === 4) {
        const round = Number(match.round) || 0;
        site.readyRound = round + captureUnreadyRounds();
        const seat = seatOf(match, side);
        const before = seat && Number.isFinite(seat.cash) ? Number(seat.cash) : 0;
        const credited = credit(match, side, captureReward());
        const paid = credited === null ? 0 : Math.max(0, Number(credited) - before);
        events.push({
          type: "capture_reward",
          side,
          site: site.id,
          name: site.name,
          kind,
          from,
          amount: paid,
          readyRound: site.readyRound,
          round,
        });
      }
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
    const type = siteTypeOf(site);
    if (type === 4) row.cities += 1;
    else if (type === 1 || type === 2) row.capitals += 1;
    else if (type === 5) row.wells += 1;
  }

  if (doomed) match.pieces = match.pieces.filter((piece) => !piece || !doomed.has(piece.id));

  match.incomeSummary = tally;
  return events;
}

// --- income ------------------------------------------------------------------------------

// PB-150: the paying count is subtype 4 plus one per extra capital; a type-5 oil field pays
// oil (resources.mjs), never cash, and is reported here for the dialog only.
// PB-233 AC (b): there is NO production cut stacked on the payday. Frodo's ruling (room 8983 §4)
// strikes the flat 25 per cent: FUN_1eb5_0eae has no multiply, so the decoded 5n gate IS the
// manual's "25 per cent or more" and a second, invented cut would be arithmetic nobody measured.
// What the ticket ships is legibility - the gate's skip names the cities it took (pay()).
export function payoutFor(match, side) {
  const counts = incomeCounts(match);
  const row = counts[side] || { paying: 0, wells: 0 };
  const cities = row.paying;
  const wells = row.wells;
  const perCity = cityIncome();
  const gross = cities * perCity;
  return {
    cities, wells, cashWells: 0, amount: gross, gross, perCity,
  };
}

// Both sides' paying-site counts in one pass over the sites. pay() runs every round now, so a
// per-side scan of 84 sites per side per room would be paid for every room every round.
// The per-site term, module-level: the same arithmetic is used by pay()'s fallback walk.
function addToRow(row, site) {
  const type = siteTypeOf(site);
  if (type === 4) row.cities += 1;
  else if (type === 1 || type === 2) row.capitals += 1;
  else if (type === 5) row.wells += 1;
}

function incomeCounts(match) {
  const counts = {
    blue: { cities: 0, capitals: 0, wells: 0, paying: 0 },
    red: { cities: 0, capitals: 0, wells: 0, paying: 0 },
  };
  const add = addToRow;
  for (const site of match.sites) {
    if (!site) continue;
    const side = site.owner;
    if (side !== "blue" && side !== "red") continue;
    add(counts[side], site);
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
      add(counts[side], site);
    }
  }
  // PB-150: paying = count(type 4) + max(0, count(type 1) + count(type 2) - 1).
  for (const side of SIDES) {
    const row = counts[side];
    row.paying = row.cities + Math.max(0, row.capitals - 1);
  }
  return counts;
}

// PB-150 hook / PB-156 body: whether this side's payday happens at all. The original rolls rnd(100)
// once per side per round and pays only if it is at least 5n, where n is the GLOBAL detonation
// count (FUN_15f4_0664 4763 - the line is 4772 in FUN_1eb5_0eae, corrected in PB-233: 4763 writes a
// city's income into 0x144e, 4772 is the 0x148c*5 <= 0x1488 test). With nukes disabled the gate is not
// in play at all, so the default
// config behaves exactly as PB-150 shipped: always paid. The roll comes off the match's own seeded
// stream, so a reload replays the same round instead of re-rolling it.
export function incomeGate(match, side) {
  return incomeGateDetail(match, side).paid;
}

// The same gate, with the numbers it drew. ONE roll, returned rather than re-rolled: PB-156 pinned
// the match's draw order (a launch takes the winter draw first, the paydays the next two), so a
// legibility read that drew a second time would move the decode it already passed.
export function incomeGateDetail(match, side) {
  if (!nukesEnabled()) return { paid: true, detonated: 0, percent: 0, roll: null };
  const n = detonatedCount(match);
  if (n <= 0) return { paid: true, detonated: n, percent: 0, roll: null };
  const percent = incomeSkipPercent(n);
  const roll = nukeRoll(match);
  return { paid: roll >= percent, detonated: n, percent, roll };
}

// The paying sites of a side, by name - the cities whose payday the gate skipped. Same arithmetic
// as incomeCounts (type-4 cities plus every capital after the first), but this one keeps the names
// so the round log can say WHICH cities went unpaid instead of only how many. Sorted by id for a
// stable line; a site with no usable name prints its coordinates.
export function payingCities(match, side) {
  const rows = [];
  for (const site of match.sites) {
    if (!site || site.owner !== side) continue;
    const type = siteTypeOf(site);
    if (type === 4) rows.push(site);
    else if (type === 1 || type === 2) rows.push({ ...site, __capital: true });
  }
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  // The first capital is the free one: it pays only as a city when the side has several capitals.
  const firstCapital = rows.findIndex((row) => row.__capital);
  const paying = rows.filter((row, index) => !row.__capital || index !== firstCapital);
  return paying.map((row) => {
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
    return name || `${row.x},${row.y}`;
  });
}

// PB-151: every CREDIT goes through here, so the original's 0..60000-unit clamp is one rule in
// one place (FUN_23aa_0cba @ 23aa:0cba, decompiled.c 17186-17206). Income, a capture reward, a
// refund and foreign aid all credit a seat; none of them may take the pool past 1500 b. Spending
// does not come through here - a purchase debits and is refused when short, so a side at exactly
// the ceiling can still buy.
export function credit(match, side, millions) {
  const seat = seatOf(match, side);
  const amount = Number(millions);
  if (!seat || !Number.isFinite(amount)) return null;
  const base = Number.isFinite(seat.cash) ? Number(seat.cash) : 0;
  let next = base + amount;
  const ceiling = maxCash();
  if (ceiling !== null && next > ceiling) next = ceiling;
  if (next < 0) next = 0;
  seat.cash = next;
  return next;
}

// Income lands every round (payEvery, Manual p.27): cityIncome millions per paying site. PB-150
// replaced the per-kind "capital pays" flag with the original's expression (type 4 plus every
// capital after the first), so a base and an oil field pay nothing and a second capital pays as a
// city. A finished match pays nothing. A side whose pool was never funded - cash not a number, or
// already short (negative) - is not paid.
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
      const type = siteTypeOf(site);
      if (type === 4) row.cities += 1;
      else if (type === 1 || type === 2) row.capitals += 1;
      else if (type === 5) row.wells += 1;
    }
    tally = { blue, red };
  }
  const perCity = cityIncome();
  for (const side of SIDES) {
    const seat = seatOf(match, side);
    if (!seat) continue;
    if (!Number.isFinite(seat.cash) || seat.cash < 0) {
      events.push({ type: "income_skipped", side, reason: "short", round });
      continue;
    }
    // PB-150's hook: PB-156 replaces the always-true body with the 5n% roll.
    // PB-233 AC (b), legibility only: a skipped payday names the cities it took, and the gate's own
    // numbers (the per cent it needed, the roll it got) so the player can see the rule instead of a
    // purse that silently did not fill. No arithmetic is added here - the gate's percentage is the
    // decoded 5n.
    const gate = incomeGateDetail(match, side);
    if (!gate.paid) {
      const names = payingCities(match, side);
      const shown = names.slice(0, 8);
      const rest = names.length - shown.length;
      events.push({
        type: "income_skipped", side, reason: "gate", round,
        detonated: gate.detonated, percent: gate.percent, roll: gate.roll,
        cities: names.length, cityNames: names,
        note: names.length
          ? `No pay this round: the sky gate needs ${gate.percent} per cent after ${gate.detonated} `
            + `detonations and rolled ${gate.roll}, so ${names.length === 1 ? "this city" : "these cities"} `
            + `went unpaid: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`
          : `No pay this round: the sky gate needs ${gate.percent} per cent after ${gate.detonated} `
            + `detonations and rolled ${gate.roll}, and you hold no paying city.`,
      });
      continue;
    }
    const row = tally[side];
    // PB-150: paying = type 4 + one per extra capital (FUN_2dfc_1246 @ 2dfc:1246).
    const counted = row.cities + Math.max(0, row.capitals - 1);
    const wells = row.wells;
    // Oil short? The original takes the unpaid share off the city count before the payday, so a
    // side out of oil stops producing income (Manual p.27; FUN_15f4_0664 4727-4762). PB-245:
    // during peacetime "a side does not use or generate oil" (p.31), so no oil comes off the city
    // count at all, and "Cash ... still accumulates, and at an accelerated rate" is the multiplier
    // from config (UNVERIFIED - 1 means no change).
    const atPeace = peaceActive(match);
    const oil = atPeace ? { cities: counted, penalty: 0 } : oilIncome(match, side, counted);
    const cities = oil.cities;
    const amount = Math.round(cities * perCity * (atPeace ? peaceRules().cashMultiplier : 1));
    // PB-151: income is a credit, so it clamps at the original's ceiling. The event reports what
    // actually landed, not what the count was worth, so a capped payday is not logged twice over.
    const before = Number.isFinite(seat.cash) ? Number(seat.cash) : 0;
    const credited = credit(match, side, amount);
    const paid = Math.max(0, Number(credited) - before);
    const event = { type: "income", side, round, cities, wells, cashWells: 0, amount: paid, gross: amount };
    if (oil.penalty > 0) {
      event.oilShort = true;
      event.oilPenalty = Number(oil.penalty.toFixed(4));
      event.citiesBeforeOil = counted;
    }
    events.push(event);
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
      const field = oilFieldAt(match, piece.x, piece.y);
      if (field && field.owner !== side) events.push(...capture(match, side, piece.x, piece.y));
    }
  }

  // PB-245 (p.31): "a side does not use or generate oil during peacetime". Both halves are the
  // one ledger, so the whole settlement is skipped rather than the charge alone: skipping only
  // `out` would still let `in` credit a side that the page says uses nothing.
  if (peaceActive(match)) return events;
  return events.concat(upkeepResources(match));
}
