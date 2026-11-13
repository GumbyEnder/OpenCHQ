// The match object. It lives in the server, in JavaScript; the page only draws what it is
// sent. This module owns the opening position for each era and the shape everything else
// reads. See docs/CONTRACTS.md.
//
// The archive's opening was a land piece on each capital plus one ship at sea. 1918, 1942,
// 1986 and the concealed start keep that; 2023 starts empty on purpose. The two sea cells
// are the archive's own ocean cells off the capital-to-capital corridor (match_state.gd:
// SEA_BLUE, SEA_RED) - positions, not combat or economy figures.

import { SEATS } from "./board.mjs";
import { capitalRows, capitalSet, capitalsFromFile } from "./capitals.mjs";
import { openingForce } from "./dispositions.mjs";
import { combatRules, handicapDefault, opponentPool, rosterFor, roundSeconds, startPool } from "./rules.mjs";
import { DOMAIN_BY_KIND } from "./shop.mjs";

export const ERAS = ["1918", "1942", "1986", "2023", "9999"];

// Ocean cells off the corridor. X wraps, Y does not.
export const SEAS = {
  blue: { x: 0, y: 15 },
  red: { x: 300, y: 70 },
};

export function eraOf(value) {
  const era = String(value ?? "1986");
  return ERAS.includes(era) ? era : "1986";
}

function piece(side, domain, x, y, kind = null, extra = {}) {
  // Strength is part of the piece's shape now (T-003): a unit opens at the config's maximum and
  // the page draws the bar from these two fields.
  const max = combatRules().maxStrength;
  const strength = Number(extra.strength) > 0 ? Math.min(Number(extra.strength), max) : max;
  const out = {
    id: extra.id || `${side}:${domain}`,
    side,
    domain,
    kind,
    x,
    y,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
    strength,
    maxStrength: max,
    pinned: false,
  };
  // The original's kind 3 is infantry that stood still long enough to dig in; every setup piece on
  // eligible ground opens that way (docs/re/COMBAT.md). Carried as the remake's own flag, not as a
  // second kind name.
  if (extra.entrenched === true) out.entrenched = true;
  return out;
}

// The opening force used to carry `kind: null`, so the Buy panel said "two opening units have no
// recorded type" (T-007 AC9). The archive's order of battle was never recovered, but the roster
// was: an era's first land unit and first sea unit are the honest names for the piece the setup
// puts on each capital and at sea, and they are the era's own names, not invented ones.
function openingKinds(era) {
  const roster = rosterFor(era) || [];
  const firstOf = (domain, fallback) =>
    roster.find((kind) => DOMAIN_BY_KIND[kind] === domain) || fallback;
  return { land: firstOf("land", "infantry"), sea: firstOf("sea", "cruiser") };
}

// Opening pieces for one era. 2023 places none. A year the original's round-0 capture covers
// spawns the captured army exactly - same kinds, same cells, same side, dug-in infantry included
// (T-013b). Every year without a capture keeps the four-piece opening: a land piece on each seat
// and a ship at sea, labelled UNMEASURED in web/data/dispositions.json.
//
// `seats` is the era's own seats (eraSeats below). Without it the archive's fixed pair is used,
// which is what a rolled year draws from anyway.
export function openingPieces(era, seats = SEATS) {
  const year = eraOf(era);
  if (year === "2023") return [];
  const force = openingForce(year);
  if (force) {
    const out = [];
    for (const side of ["blue", "red"]) {
      let serial = 0;
      for (const row of force.sides[side]) {
        // `open` keeps these ids out of the namespace a purchase uses (`<side>:<kind>:<n>`, from
        // seat.bought), so a bought unit can never collide with a setup piece (T-013b).
        let id = `${side}:open:${row.kind}:${serial}`;
        while (out.some((unit) => unit.id === id)) id = `${side}:open:${row.kind}:${++serial}`;
        out.push(piece(side, row.domain, row.x, row.y, row.kind, {
          id,
          strength: row.strength,
          entrenched: row.entrenched,
        }));
        serial += 1;
      }
    }
    return out;
  }
  const kinds = openingKinds(year);
  const blue = seats.blue || SEATS.blue;
  const red = seats.red || SEATS.red;
  return [
    piece("blue", "land", blue.x, blue.y, kinds.land),
    piece("blue", "sea", SEAS.blue.x, SEAS.blue.y, kinds.sea),
    piece("red", "land", red.x, red.y, kinds.land),
    piece("red", "sea", SEAS.red.x, SEAS.red.y, kinds.sea),
  ];
}

// The era's two seats: one capital per side, and never a capital the other side owns.
//
// The archive's fixed pair is Washington/Moscow. Moscow is a BLUE capital in 1942, so the red seat
// standing on it handed red a blue capital on the first pass - a free capture in round 1 that the
// original never gives (T-013 AC5 cause 2).
//
// The seat is only moved when it has to be. A seat that is still the side's own capital in this
// era's file stays exactly where the archive puts it (1986 keeps Washington/Moscow, and 1942 blue
// keeps Washington); a seat the file does not give that side is replaced by the side's lowest-id
// capital in the file (1942 red becomes Berlin instead of blue Moscow). A year whose capitals are
// rolled (2023, the concealed start) has no rows and keeps the archive pair untouched.
export function eraSeats(era, sites = []) {
  const out = { blue: { ...SEATS.blue }, red: { ...SEATS.red } };
  const year = eraOf(era);
  const { rows } = capitalRows(year);
  if (!rows.length) return out;
  const byId = new Map((sites || []).map((site) => [String(site && site.id), site]));
  for (const side of ["blue", "red"]) {
    const seat = out[side];
    const owned = rows.filter((entry) => entry.owner === side && byId.has(String(entry.id)));
    const onSeat = owned.find((entry) => {
      const site = byId.get(String(entry.id));
      return Number(site.x) === seat.x && Number(site.y) === seat.y;
    });
    if (onSeat) {
      // Keep the archive's seat but name the file's own row, so a caller can find the site by id.
      out[side] = { ...seat, siteId: onSeat.id };
      continue;
    }
    const row = owned[0];
    const site = row ? byId.get(String(row.id)) : null;
    if (!site) continue;
    out[side] = { name: String(site.name), x: Number(site.x), y: Number(site.y), siteId: site.id };
  }
  return out;
}

// One side's opening state. `cash` is passed in by openMatch because the two sides no longer open
// on the same number: the player's side gets the era's recovered pool, and the opponent's side gets
// the starting-money spinner (Manual p.17), which is the handicap and not the player's cash.
function sideState(era, cash = null) {
  return {
    cash: cash === null || cash === undefined ? startPool(era) : cash,
    fuel: null, // set from rules().fuel.reserve by economy; null means untouched
    dry: false,
    cities: [],
    wells: [],
    bought: 0,
  };
}

// The era's capital set for this match: the file's subtype-1/2 rows joined to the live sites.
// `tick.checkWin` reads this list, so it is membership and nothing else - the holder is the site
// record's owner, written by `economy.occupy` when troops take the cell (B-3b ruling).
//
// A file year whose site list does not carry every row keeps the gap in `missing` rather than
// rolling replacements: the win check refuses to decide a match on a partial set, because a
// capital silently dropped would make the win easier than the original's. The years with no capital
// rows (2023 and the concealed 9999) get the two rolled capitals, which is the reading that ships.
// The literal "????" label is not an era id: eraOf sends it to 1986, so it inherits 1986's four
// file capitals rather than rolling - a test-only path, pinned in capital_open.
export function capitalSetFor(year, sites, seed) {
  const { rows } = capitalRows(year);
  if (!rows.length) return capitalSet(year, sites, seed);
  const joined = capitalsFromFile(year, sites);
  return { era: joined.era, source: "file", list: joined.list, missing: joined.missing };
}

// A fresh match. Round 0 is held: no clock, no orders, no movement yet. `sites` is the board
// asset list with an owner per site, filled by the economy module when oil lands.
//
// `options.handicapSide` names the side that is NOT the player, and `options.opponentPool` is the
// spinner value in billions. Without them both sides open on the recovered player pool, which is
// what a two-human match does: p.17's spinner handicaps an opponent, and there is no bot to
// handicap when two people sit down.
export function openMatch(era, sites = [], options = {}) {
  const year = eraOf(era);
  const side = options && (options.handicapSide === "blue" || options.handicapSide === "red")
    ? options.handicapSide
    : null;
  // The spinner the original would have shown. 2023 has none at all (handicapDefault returns null),
  // so no value - not even 0 - is applied there: both sides open on the p.16 large pool.
  const eraSpinner = side === null ? null : handicapDefault(year);
  const spinner = eraSpinner === null
    ? null
    : (options.opponentPool === undefined || options.opponentPool === null
      ? eraSpinner
      : Number(options.opponentPool));
  const opponentCash = side === null ? null : opponentPool(year, spinner);
  // The site records every other module reads: the asset list's cell, kind and country, plus the
  // era table's subtype and opening owner (R2: `type` beside `kind`, never inside it).
  const opening = sites.map((site) => ({
    id: site.id,
    name: site.name,
    x: site.x,
    y: site.y,
    kind: site.kind,
    // The era table's subtype travels beside `kind`, never inside it, and the table's owner is
    // the opening for the years the original wrote one from a file. Docks and oil wells are not
    // in the table: neither field reaches them, and the economy seeds them from country/region.
    ...(site.type === undefined ? {} : { type: site.type }),
    owner: site.owner === "blue" || site.owner === "red" ? site.owner : null,
    // A dock or a well carries the country or region the asset list named, so ownership
    // seeds from the board rather than from a guess.
    ...(site.country_id === undefined ? {} : { country_id: site.country_id }),
    ...(site.region === undefined ? {} : { region: site.region }),
  }));
  // The era's own seats, read from the file rows joined to those sites (T-013b).
  const seats = eraSeats(year, opening);
  return {
    era: year,
    round: 0,
    roundSeconds: roundSeconds(),
    clock: "held",
    pieces: openingPieces(year, seats),
    // The two seats are what the page labels and what the player is told to defend. They are not
    // the win condition any more: `capitalSet` is (B-3b), and it is the era's whole list. T-013b:
    // they are the era's own capitals (eraSeats), so a 1942 red seat is Berlin, never blue Moscow.
    capitals: {
      blue: { x: seats.blue.x, y: seats.blue.y },
      red: { x: seats.red.x, y: seats.red.y },
    },
    // The original's site array. `capitalSet` is the win condition (B-3b); `capitalSeed` is what a
    // rolled era drew it with, kept on the match so a reload re-rolls the same two capitals.
    capitalSet: capitalSetFor(year, opening, options && options.seed),
    capitalSeed: options && options.seed,
    sides: {
      blue: sideState(year, side === "blue" ? opponentCash : null),
      red: sideState(year, side === "red" ? opponentCash : null),
    },
    // What the slot actually holds, so the report and the Economy dialog can say what was set.
    handicap: side === null || spinner === null || !Number.isFinite(spinner)
      ? null
      : { side, billions: spinner, unit: "billion" },
    sites: opening,
    foughtRound: -1,
    winner: null,
    over: false,
  };
}

// What a seat may see. The view module narrows this; until then the opening position is
// symmetric and both sides travel in the room view.
export function piecesFor(match, side = null) {
  if (!match || !Array.isArray(match.pieces)) return [];
  const list = side ? match.pieces.filter((unit) => unit.side === side) : match.pieces;
  return list.map((unit) => ({ ...unit }));
}
