// The match object. It lives in the server, in JavaScript; the page only draws what it is
// sent. This module owns the opening position for each era.
//
// The archive's opening was a land piece on each capital plus one ship at sea. 1918, 1942,
// 1986 and the concealed start keep that; 2023 starts empty on purpose. The two sea cells
// are the archive's own ocean cells off the capital-to-capital corridor (match_state.gd:
// SEA_BLUE, SEA_RED) — positions, not combat or economy figures.

import { SEATS } from "./board.mjs";

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
  return { id: `${side}:${domain}`, side, domain, x, y };
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

// A fresh match. Round 0 is held: no clock, no orders, no movement yet.
export function openMatch(era) {
  const year = eraOf(era);
  return {
    era: year,
    round: 0,
    pieces: openingPieces(year),
    capitals: {
      blue: { x: SEATS.blue.x, y: SEATS.blue.y },
      red: { x: SEATS.red.x, y: SEATS.red.y },
    },
  };
}

// The pieces a seat is allowed to see. Until the view node lands, the opening position is
// symmetric and both sides travel in the room view; the filter narrows this later.
export function piecesFor(match) {
  if (!match || !Array.isArray(match.pieces)) return [];
  return match.pieces.map((unit) => ({ ...unit }));
}
