// Saved-match migration. Pure: no disk, no database, no board. Loaded rows pass through here so
// a room written by an older build opens under the current rules.
//
// Two migrations, both on load only:
//  - "ship" was one kind; it is now cruiser and carrier. A saved generic ship becomes a cruiser.
//  - money used to be whole billions on the seat. It is integer millions now; a row with no
//    moneyUnit marker is scaled once, and a row already marked "millions" is never scaled twice.

import { millionsPerBillion } from "./rules.mjs";

const SIDES = ["blue", "red"];

export function migrateMatch(match) {
  if (!match || typeof match !== "object") return match;
  for (const piece of Array.isArray(match.pieces) ? match.pieces : []) {
    if (piece && piece.kind === "ship") piece.kind = "cruiser";
  }
  if (match.moneyUnit !== "millions") {
    const factor = millionsPerBillion();
    if (Number.isFinite(factor)) {
      for (const side of SIDES) {
        const seat = match.sides && match.sides[side];
        if (seat && Number.isFinite(Number(seat.cash))) seat.cash = Number(seat.cash) * factor;
      }
    }
    match.moneyUnit = "millions";
  }
  return match;
}

// The pre-split wire name for a hull. Live for old pages and scripts only; every path inside the
// game speaks cruiser/carrier now, and the prices node keeps this the one place the old name lives.
export function compatUnitKind(kind) {
  return kind === "ship" ? "cruiser" : kind;
}
