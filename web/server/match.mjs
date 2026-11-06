// The match object. It lives in the server, in JavaScript; the page only draws what it is
// sent. This module owns the opening position for each era and the shape everything else
// reads. See docs/CONTRACTS.md.
//
// The archive's opening was a land piece on each capital plus one ship at sea. 1918, 1942,
// 1986 and the concealed start keep that; 2023 starts empty on purpose. The two sea cells
// are the archive's own ocean cells off the capital-to-capital corridor (match_state.gd:
// SEA_BLUE, SEA_RED) - positions, not combat or economy figures.

import { SEATS } from "./board.mjs";
import { roundSeconds, startPool } from "./rules.mjs";

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

function piece(side, domain, x, y) {
  return { id: `${side}:${domain}`, side, domain, kind: null, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
}

// Opening pieces for one era. 2023 places none; every other era places a land piece on
// each capital and a ship at sea.
export function openingPieces(era) {
  if (eraOf(era) === "2023") return [];
  return [
    piece("blue", "land", SEATS.blue.x, SEATS.blue.y),
    piece("blue", "sea", SEAS.blue.x, SEAS.blue.y),
    piece("red", "land", SEATS.red.x, SEATS.red.y),
    piece("red", "sea", SEAS.red.x, SEAS.red.y),
  ];
}

function sideState(era) {
  return {
    cash: startPool(era),
    fuel: null, // set from rules().fuel.reserve by economy; null means untouched
    dry: false,
    cities: [],
    wells: [],
    bought: 0,
  };
}

// A fresh match. Round 0 is held: no clock, no orders, no movement yet. `sites` is the board
// asset list with an owner per site, filled by the economy module when oil lands.
export function openMatch(era, sites = []) {
  const year = eraOf(era);
  return {
    era: year,
    round: 0,
    roundSeconds: roundSeconds(),
    clock: "held",
    pieces: openingPieces(year),
    capitals: {
      blue: { x: SEATS.blue.x, y: SEATS.blue.y },
      red: { x: SEATS.red.x, y: SEATS.red.y },
    },
    sides: { blue: sideState(year), red: sideState(year) },
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      x: site.x,
      y: site.y,
      kind: site.kind,
      owner: null,
      // A dock or a well carries the country or region the asset list named, so ownership
      // seeds from the board rather than from a guess.
      ...(site.country_id === undefined ? {} : { country_id: site.country_id }),
      ...(site.region === undefined ? {} : { region: site.region }),
    })),
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
