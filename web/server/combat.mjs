// Strength-based combat. Owner: A4. See docs/CONTRACTS.md and Dev Tasks/T-003.
//
// Movement (move.mjs) refuses to let two opposing pieces share a cell: the walker stops one short.
// This module is what happens next. Every round one piece may damage one enemy, every
// `shotEveryRounds` rounds (Manual p.22: every other round), and the damage comes off a strength
// bar the page draws. Nothing here names a number: `combatRules()` reads config.combat, and every
// key in that block carries its own source string.
//
// The rules this file encodes, each with its manual line:
//   - combat when the icons overlap: land engagement is `landEngageCells`, sea is the kind's range
//     (p.22, p.24; sub 2, cruiser below carrier, p.42);
//   - each unit damages one enemy every other round and keeps that target until it dies, moves off,
//     or a closer enemy arrives (p.22);
//   - a second friendly unit deals damage and takes none in return (p.22);
//   - flank and rear hits do extra damage (p.22);
//   - heavily engaged land units become pinned; ships are never pinned and never flanked (p.22, p.24);
//   - entrenched infantry take less damage, stay entrenched in a fight, and lose it when ordered
//     to move (p.22);
//   - city militia damages attackers (p.10, p.23);
//   - a unit dies when a hit meets or exceeds its remaining strength (p.23).
//
// Overrun is the tank's (p.9) and lives in move.mjs, because it is a movement result, not a damage
// rule. A transport is cargo: it neither fires nor survives an exchange.

import { CELL_W } from "./board.mjs";
import { combatRules, seaRangeFor } from "./rules.mjs";

// The words that ride the events. The numbers ride as fields, so a test asserts a figure instead
// of a sentence.
export const SHOT_NOTE = "Strength hit.";
export const FIGHT_OVER_NOTE = "Strength spent. The unit is gone.";
export const ENTRENCH_NOTE = "Dug in. Incoming hits land at the entrenched factor.";
export const MILITIA_NOTE = "City militia.";

// Chebyshev distance 1, X wraps around the board edge, Y does not.
export function adjacent(a, b) {
  if (!a || !b) return false;
  return distance(a, b) === 1;
}

// Chebyshev distance with the board's X wrap.
export function distance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, CELL_W - dx);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return Math.max(wrap, dy);
}

// A piece's strength defaults to full the first time anything reads it, so a piece created before
// T-003 (or by a test) is a full-strength piece rather than an empty one.
export function ensureStrength(piece, max = combatRules().maxStrength) {
  if (!piece) return 0;
  if (piece.strength === undefined || piece.strength === null || !Number.isFinite(Number(piece.strength))) {
    piece.strength = max;
  }
  if (!Number.isFinite(Number(piece.maxStrength))) piece.maxStrength = max;
  return Number(piece.strength);
}

// Take damage. Returns what changed so every caller reports the same bookkeeping.
// `dead` follows p.23: the unit is removed when the hit meets or exceeds what strength remains.
export function applyDamage(piece, amount, max = combatRules().maxStrength) {
  const before = ensureStrength(piece, max);
  const dealt = Math.max(0, Number(amount) || 0);
  const after = Math.max(0, before - dealt);
  piece.strength = after;
  return { before, dealt, after, dead: dealt >= before };
}

// Which way a cell lies from a piece: the compass letter the walker already stamps in `facing`.
export function bearing(from, to) {
  const raw = Number(to.x) - Number(from.x);
  const dx = Math.abs(raw) > CELL_W / 2 ? raw - Math.sign(raw) * CELL_W : raw;
  const dy = Number(to.y) - Number(from.y);
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? "e" : "w";
  if (dy !== 0) return dy > 0 ? "s" : "n";
  return null;
}

// The reach of one piece. An aircraft is a mission, not a board combatant: it never engages.
// `combat` is the already-read block when a loop is about to ask for a thousand reaches: reading
// it per piece cost 8 ms of a 1000-room round in the bench, because every read walks rules().
export function rangeOf(piece, combat = null) {
  if (!piece) return 0;
  if (piece.kind === "aircraft" || piece.domain === "air") return 0;
  if (piece.domain === "sea") return seaRangeFor(piece.kind, combat);
  return (combat || combatRules()).landEngageCells;
}

// Every enemy this piece can reach this round.
export function candidatesFor(piece, pieces) {
  if (!piece) return [];
  const range = rangeOf(piece);
  if (range <= 0) return [];
  const out = [];
  for (const other of pieces || []) {
    if (!other || other.id === piece.id) continue;
    if (other.side === piece.side) continue;
    if (other.kind === "aircraft" || other.domain === "air") continue;
    if (distance(piece, other) <= range) out.push(other);
  }
  return out;
}

// Keep the target the piece already had while it is still in reach; switch only when a closer
// enemy arrives (p.22). Otherwise nearest first, lower id on a tie so the board is deterministic.
// One pass, no allocation: this runs for every piece of every room every round.
export function chooseTarget(piece, pieces, combat = null) {
  if (!piece) return null;
  const range = rangeOf(piece, combat);
  if (range <= 0) return null;
  const px = Number(piece.x);
  const py = Number(piece.y);
  let best = null;
  let bestDistance = Infinity;
  let held = null;
  let heldDistance = Infinity;
  for (const other of pieces || []) {
    if (!other || other.id === piece.id) continue;
    if (other.side === piece.side) continue;
    if (other.kind === "aircraft" || other.domain === "air") continue;
    const raw = Math.abs(px - Number(other.x));
    const dx = raw > CELL_W / 2 ? CELL_W - raw : raw;
    const distanceTo = Math.max(dx, Math.abs(py - Number(other.y)));
    if (distanceTo > range) continue;
    if (other.id === piece.fighting) {
      held = other;
      heldDistance = distanceTo;
    }
    if (distanceTo < bestDistance || (distanceTo === bestDistance && best && String(other.id) < String(best.id))) {
      best = other;
      bestDistance = distanceTo;
    }
  }
  if (held && bestDistance >= heldDistance) return held;
  return best;
}

// Damage one piece deals to another. The modifiers the manual names, in one place: flank/rear
// (land only, p.22) and entrenchment (land only, p.22). Ships are never flanked (p.24).
export function damageFor(attacker, defender) {
  const combat = combatRules();
  const base = Number(combat.baseDamage[String(attacker.kind)] ?? 0);
  let amount = base;
  let flank = false;
  if (attacker.domain !== "sea" && defender.domain !== "sea" && defender.facing) {
    const from = bearing(defender, attacker);
    if (from && from !== defender.facing) {
      amount *= combat.flankMultiplier;
      flank = true;
    }
  }
  let entrenched = false;
  if (defender.domain !== "sea" && defender.entrenched === true) {
    amount *= combat.entrenchDamageFactor;
    entrenched = true;
  }
  return { base, amount, flank, entrenched };
}

function siteAt(map, cell) {
  return map.get(Number(cell.y) * CELL_W + Number(cell.x)) || null;
}

// Target selection for the whole match in one pass over numeric arrays. `chooseTarget` below is
// the readable single-piece form; this is the same rule with each piece's coordinates and flags
// read once, because the 1000-room bench pays for every property conversion.
//   - no target for an aircraft (a mission, not a board combatant) or for a piece with no reach;
//   - friends and non-combatants are skipped;
//   - keep the current target while it is still in reach, switch only when a closer enemy arrives;
//   - otherwise nearest wins, lower id on a tie.
export function computeTargets(pieces) {
  const n = pieces ? pieces.length : 0;
  const targets = new Array(n).fill(null);
  if (n < 2) return targets;
  const combat = combatRules();
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const sides = new Uint8Array(n);
  const armed = new Uint8Array(n);
  const ranges = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    xs[i] = Number(piece.x);
    ys[i] = Number(piece.y);
    sides[i] = piece.side === "blue" ? 1 : piece.side === "red" ? 2 : 0;
    armed[i] = piece.kind === "aircraft" || piece.domain === "air" ? 0 : 1;
    ranges[i] = Math.min(255, Math.max(0, rangeOf(piece, combat)));
  }
  for (let i = 0; i < n; i++) {
    if (!armed[i] || ranges[i] <= 0 || sides[i] === 0) continue;
    const piece = pieces[i];
    const range = ranges[i];
    const px = xs[i];
    const py = ys[i];
    let best = -1;
    let bestDistance = Infinity;
    let held = -1;
    let heldDistance = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || !armed[j]) continue;
      if (sides[j] === sides[i]) continue;
      const raw = Math.abs(px - xs[j]);
      const dx = raw > CELL_W / 2 ? CELL_W - raw : raw;
      const dy = Math.abs(py - ys[j]);
      const distanceTo = dx > dy ? dx : dy;
      if (distanceTo > range) continue;
      const other = pieces[j];
      if (other.id === piece.fighting) {
        held = j;
        heldDistance = distanceTo;
      }
      if (distanceTo < bestDistance || (distanceTo === bestDistance && best >= 0 && other.id < pieces[best].id)) {
        best = j;
        bestDistance = distanceTo;
      }
    }
    if (held >= 0 && bestDistance >= heldDistance) targets[i] = pieces[held];
    else if (best >= 0) targets[i] = pieces[best];
  }
  return targets;
}

// One round of fire. Mutates strength and the fight bookkeeping; never a position. Removal happens
// after every pair has fired, so a piece that dies this round still fires.
export function resolve(match) {
  if (!match || match.over) return [];
  if (!Array.isArray(match.pieces)) return [];

  const round = Number(match.round) || 0;
  const combat = combatRules();
  const max = combat.maxStrength;
  const events = [];

  // Contact bookkeeping runs every round; damage only on the beat. That way a resumed fight starts
  // its own clock while `foughtRound` stays the shared front beat the alternation test pins.
  const pieces = match.pieces;
  for (let i = 0; i < pieces.length; i++) ensureStrength(pieces[i], max);
  // The numeric single pass, not chooseTarget per piece: same rule, one walk over the room.
  const targets = computeTargets(pieces);

  const canFire = round - Number(match.foughtRound ?? -1) >= combat.shotEveryRounds;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const target = targets[i];
    if (target) {
      if (piece.fighting !== target.id) {
        piece.fighting = target.id;
        piece.fightRounds = 0;
      }
      piece.fightRounds = Number(piece.fightRounds || 0) + 1;
      if (
        combat.pinRounds > 0 &&
        piece.domain !== "sea" &&
        piece.transport !== true &&
        piece.fightRounds >= combat.pinRounds &&
        piece.pinned !== true
      ) {
        piece.pinned = true;
        events.push({ type: "pinned", side: piece.side, pieceId: piece.id, x: piece.x, y: piece.y, round });
      }
    } else {
      piece.fighting = null;
      piece.fightRounds = 0;
      // Time, not damage, unpins a land piece that is no longer engaged.
      if (piece.pinned === true) piece.pinned = false;
    }
  }

  if (canFire) {
    const hits = [];
    for (let i = 0; i < pieces.length; i++) {
      const attacker = pieces[i];
      const target = targets[i];
      if (!target) continue;
      // A transport is cargo: it does not fire, and it does not survive the exchange.
      if (attacker.transport === true) continue;
      if (Number(combat.baseDamage[String(attacker.kind)] ?? 0) <= 0) continue;
      hits.push({ attacker, target, ...damageFor(attacker, target) });
    }

    const doomed = new Set();
    const log = [];

    for (const hit of hits) {
      const { attacker, target } = hit;
      // Cargo is lost on the first hit, whatever the numbers are.
      const amount = target.transport === true ? Math.max(hit.amount, ensureStrength(target, max)) : hit.amount;
      const result = applyDamage(target, amount, max);
      log.push({
        type: "shot",
        side: attacker.side,
        pieceId: attacker.id,
        target: target.id,
        amount: Number(Number(amount).toFixed(2)),
        strength: result.after,
        flank: hit.flank,
        entrenched: hit.entrenched,
        at: { x: target.x, y: target.y },
        round,
        note: SHOT_NOTE,
      });
      if (result.dead || target.transport === true) doomed.add(target.id);
    }

    // City militia: a defender standing on its own city, base, dock or capital is helped by the
    // militia, and each attacker pays once that round (p.10, p.23).
    if (combat.militiaDamage > 0) {
      const paid = new Set();
      const byCell = new Map();
      for (const site of match.sites || []) {
        if (!site) continue;
        byCell.set(Number(site.y) * CELL_W + Number(site.x), site);
      }
      for (const hit of hits) {
        const site = siteAt(byCell, hit.target);
        if (!site || site.owner !== hit.target.side) continue;
        if (!["city", "base", "dock", "docks", "capital"].includes(site.kind)) continue;
        if (paid.has(hit.attacker.id)) continue;
        paid.add(hit.attacker.id);
        const militia = applyDamage(hit.attacker, combat.militiaDamage, max);
        log.push({
          type: "shot",
          side: hit.target.side,
          pieceId: "militia:" + (site.id ?? site.name ?? "city"),
          target: hit.attacker.id,
          amount: combat.militiaDamage,
          strength: militia.after,
          flank: false,
          entrenched: false,
          militia: true,
          at: { x: hit.attacker.x, y: hit.attacker.y },
          round,
          note: MILITIA_NOTE,
        });
        if (militia.dead) doomed.add(hit.attacker.id);
      }
    }

    events.push(...log);
    if (log.length) match.foughtRound = round;

    // Removal after every pair has fired.
    if (doomed.size > 0) {
      for (const piece of match.pieces) {
        if (!doomed.has(piece.id)) continue;
        const attacker = hits.find((hit) => hit.target.id === piece.id);
        events.push({
          type: "destroyed",
          side: piece.side,
          pieceId: piece.id,
          by: attacker ? attacker.attacker.id : null,
          x: piece.x,
          y: piece.y,
          strength: 0,
          round,
          note: FIGHT_OVER_NOTE,
        });
      }
      match.pieces = match.pieces.filter((piece) => !doomed.has(piece.id));
      for (const piece of match.pieces) {
        if (piece.fighting && doomed.has(piece.fighting)) {
          piece.fighting = null;
          piece.fightRounds = 0;
        }
      }
    }
  }

  return events;
}

// Infantry digs in after `entrenchRounds` rounds of standing still without fighting (p.22: "an
// infantry that has not moved or fought"). Being attacked does not clear the state; only a move
// order does (move.mjs), which is why this never lowers a flag.
export function tickEntrench(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces)) return events;
  const combat = combatRules();
  if (combat.entrenchRounds <= 0) return events;
  const round = Number(match.round) || 0;
  for (const piece of match.pieces) {
    if (!piece || piece.kind !== "infantry" || piece.domain === "sea" || piece.transport === true) continue;
    const moving = Array.isArray(piece.path) && piece.path.length > 0;
    const fighting = piece.fighting !== null && piece.fighting !== undefined;
    if (moving || fighting) {
      piece.stillRounds = 0;
      continue;
    }
    piece.stillRounds = Number(piece.stillRounds || 0) + 1;
    if (piece.stillRounds >= combat.entrenchRounds && piece.entrenched !== true) {
      piece.entrenched = true;
      piece.dugRound = round;
      events.push({ type: "entrench", side: piece.side, pieceId: piece.id, x: piece.x, y: piece.y, round, note: ENTRENCH_NOTE });
    }
  }
  return events;
}
