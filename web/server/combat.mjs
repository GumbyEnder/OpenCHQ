// Stop short and fight. Owner: A4. See docs/CONTRACTS.md.
//
// Movement (move.mjs) refuses to let two opposing pieces share a cell: the walker stops one
// cell short. This module is what happens next. Two hostile pieces on adjacent cells are
// engaged; they do not move, they trade fire. A shot falls on every other round of one
// continuous fight - never twice in a row, never a second shot in the same round for the
// same piece.
//
// What is deliberately NOT here: a damage number. The archive's rule (docs/POLISH_LOOP.md)
// is not hit points - it is "after HITS shots in one continuous fight the defender is gone",
// and HITS is 6 in config/game.json. So a shot is still a fact with no digit on it, and the
// only outcome is removal. No health bar, no partial damage, nothing to tune per unit.

import { CELL_W } from "./board.mjs";
import { hitsToKill, overrunEnabled } from "./rules.mjs";

// The desktop archive's voice, kept verbatim. It carries no digit on purpose: there is no
// damage figure to report.
export const SHOT_NOTE = "Stand-in fight. The shot has no damage yet.";

// Said when the count is reached. Also the archive's line.
export const FIGHT_OVER_NOTE = "Stand-in fight. The defender is gone.";

// Chebyshev distance 1, X wraps around the board edge, Y does not.
export function adjacent(a, b) {
  if (!a || !b) return false;
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, CELL_W - dx);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return Math.max(wrap, dy) === 1;
}

// How many of `side` stand next to a cell, not counting the pieces the caller names. The two
// combatants are always excluded, so a plain 1v1 is 0 against 0 and never overruns: the rule is
// about surplus force, not about standing next to someone.
function supportAt(pieces, side, cell, exclude) {
  let count = 0;
  for (const piece of pieces) {
    if (!piece || exclude.has(piece.id) || piece.side !== side) continue;
    if (adjacent(piece, cell)) count++;
  }
  return count;
}

export const OVERRUN_NOTE = "Overrun. More force stood on the cell than held it.";

function keyOf(a, b) {
  return a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
}

// Every unordered pair of hostile pieces that is adjacent this round.
function engagements(pieces) {
  const pairs = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i];
      const b = pieces[j];
      if (a.side === b.side) continue;
      if (!adjacent(a, b)) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

// One round of fire. Mutates only the fight bookkeeping (`fighting`, `shots`) and
// `match.foughtRound`; never a position, never a piece's existence.
export function resolve(match) {
  if (!match || match.over) return [];
  if (!Array.isArray(match.pieces)) return [];

  const round = Number(match.round) || 0;
  const events = [];
  const pairs = engagements(match.pieces);
  const engaged = new Set(); // piece ids that are in a fight this round
  const shotThisRound = new Set(); // one shot per piece per round

  // A shot landed last round means this round is the quiet half of the alternation.
  // `foughtRound` is the last round any shot resolved, so a new fight also falls on the
  // same beat as every other fight: a shared front, not a per-pair timer.
  const canFire = round - Number(match.foughtRound ?? -1) >= 2;
  let firedRound = -1;
  // The archive's stand-in fight (docs/POLISH_LOOP.md): after HITS shots in one continuous
  // fight the defender is removed, not damaged. The defender is the piece that has been
  // stationary longer - the mover is the attacker. When neither has moved (a synthetic pair,
  // or two pieces that met head-on) the lower id defends, which is deterministic and says so.
  const limit = hitsToKill();
  const doomed = new Map(); // pieceId -> attacker id

  for (const [a, b] of pairs) {
    // A piece trades fire with one enemy at a time; a second adjacent enemy waits its turn
    // rather than thrashing the `fighting` field every round.
    if (engaged.has(a.id) || engaged.has(b.id)) continue;
    engaged.add(a.id);
    engaged.add(b.id);

    const continuous = a.fighting === b.id && b.fighting === a.id;
    if (!continuous) {
      // Contact, or a different enemy: this is a new continuous fight. Shots restart at
      // zero, so an interrupted and resumed fight is not credited with old volleys.
      a.fighting = b.id;
      b.fighting = a.id;
      a.shots = 0;
      b.shots = 0;
    }

    if (!canFire) continue;
    if (shotThisRound.has(a.id) || shotThisRound.has(b.id)) continue;

    // A transport is cargo: it does not fire back, and it does not survive being caught.
    // That is the whole reason sea control matters - an unescorted crossing is a loss.
    const aArmed = a.transport !== true;
    const bArmed = b.transport !== true;
    if (!aArmed && !bArmed) continue; // cargo meeting cargo is a standoff, not a battle

    if (aArmed) {
      a.shots = Number(a.shots || 0) + 1;
      shotThisRound.add(a.id);
    }
    if (bArmed) {
      b.shots = Number(b.shots || 0) + 1;
      shotThisRound.add(b.id);
    }
    firedRound = round;

    // Each side fires; the shot lands on the other piece's cell. `at` is a place, not a
    // quantity - there is no damage figure to attach.
    if (aArmed) events.push({ type: "shot", side: a.side, pieceId: a.id, at: { x: b.x, y: b.y }, round, note: SHOT_NOTE });
    if (bArmed) events.push({ type: "shot", side: b.side, pieceId: b.id, at: { x: a.x, y: a.y }, round, note: SHOT_NOTE });

    // The catch: the first exchange sinks the transport.
    if (!aArmed) doomed.set(a.id, b.id);
    if (!bArmed) doomed.set(b.id, a.id);

    const aMoved = Number(a.movedRound ?? -1);
    const bMoved = Number(b.movedRound ?? -1);
    const defender = aMoved < bMoved ? a : bMoved < aMoved ? b : (String(a.id) < String(b.id) ? a : b);
    const attacker = defender === a ? b : a;

    // Overrun: the side with more pieces on the cell breaks it now, rather than grinding.
    // Both sides are counted on the defender's cell, so the comparison is one a player can see.
    if (overrunEnabled() && !doomed.has(defender.id)) {
      const both = new Set([defender.id, attacker.id]);
      const forAttacker = supportAt(match.pieces, attacker.side, defender, both);
      const forDefender = supportAt(match.pieces, defender.side, defender, both);
      if (forAttacker > forDefender) {
        doomed.set(defender.id, attacker.id);
        events.push({ type: "overrun", side: defender.side, pieceId: defender.id, by: attacker.id, x: defender.x, y: defender.y, round, note: OVERRUN_NOTE });
      }
    }

    if (limit > 0 && !doomed.has(defender.id) && Number(defender.shots) >= limit) {
      doomed.set(defender.id, attacker.id);
    }
  }

  // Removal happens after the pairs loop, so a piece that dies this round still fires.
  if (doomed.size > 0) {
    for (const piece of match.pieces) {
      const attacker = doomed.get(piece.id);
      if (attacker === undefined) continue;
      events.push({
        type: "destroyed",
        side: piece.side,
        pieceId: piece.id,
        by: attacker,
        x: piece.x,
        y: piece.y,
        round,
        note: FIGHT_OVER_NOTE,
      });
    }
    match.pieces = match.pieces.filter((piece) => !doomed.has(piece.id));
    for (const piece of match.pieces) {
      if (piece.fighting && doomed.has(piece.fighting)) {
        piece.fighting = null;
        piece.shots = 0;
      }
    }
  }

  // Pieces no longer in contact forget the fight; a later meeting starts fresh.
  for (const unit of match.pieces) {
    if (engaged.has(unit.id)) continue;
    if (unit.fighting !== null && unit.fighting !== undefined) unit.fighting = null;
    if (Number(unit.shots || 0) !== 0) unit.shots = 0;
  }

  if (firedRound >= 0) match.foughtRound = firedRound;
  return events;
}
