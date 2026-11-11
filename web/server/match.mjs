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
import { handicapDefault, opponentPool, rosterFor, roundSeconds, startPool } from "./rules.mjs";
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

function piece(side, domain, x, y, kind = null) {
  return { id: `${side}:${domain}`, side, domain, kind, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
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

// Opening pieces for one era. 2023 places none; every other era places a land piece on
// each capital and a ship at sea.
export function openingPieces(era) {
  if (eraOf(era) === "2023") return [];
  const kinds = openingKinds(eraOf(era));
  return [
    piece("blue", "land", SEATS.blue.x, SEATS.blue.y, kinds.land),
    piece("blue", "sea", SEAS.blue.x, SEAS.blue.y, kinds.sea),
    piece("red", "land", SEATS.red.x, SEATS.red.y, kinds.land),
    piece("red", "sea", SEAS.red.x, SEAS.red.y, kinds.sea),
  ];
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
// capital silently dropped would make the win easier than the original's. Rolled years (2023,
// ????) have no rows and get the two rolled capitals, which is the reading that ships.
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
  return {
    era: year,
    round: 0,
    roundSeconds: roundSeconds(),
    clock: "held",
    pieces: openingPieces(year),
    // The two seats are what the page labels and what the player is told to defend. They are not
    // the win condition any more: `capitalSet` is (B-3b), and it is the era's whole list.
    capitals: {
      blue: { x: SEATS.blue.x, y: SEATS.blue.y },
      red: { x: SEATS.red.x, y: SEATS.red.y },
    },
    capitalSet: capitalSetFor(year, opening, options && options.seed),
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
