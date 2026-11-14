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

import { CELL_W, boardPayload } from "./board.mjs";
import { combatRules, seaRangeFor, digInIds, terrainTables } from "./rules.mjs";
import { siteIndex } from "./siteindex.mjs";

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

// The facing opposite a compass letter; the original flips a facing with XOR 1 (2<->3, 4<->5).
const OPPOSITE = { n: "s", s: "n", e: "w", w: "e" };

// The original's damage byte for a pairing: matrix cell attacker*9 + target (`0x18f0`). An
// entrenched infantry DEFENDER is kind 3 - that is where the entrench discount lives, so there is
// no separate multiplier. Returns 0 for a pairing the table zeroes (a submarine against land, a
// transport). `baseDamage` is read only for a kind the table has no row for.
export function baseDamageFor(attackerKind, defender, combat = null) {
  const block = combat || combatRules();
  const attacker = Number(block.damageKind[String(attackerKind)] ?? 0);
  let targetKind = defender && defender.kind;
  if (defender && defender.entrenched === true && String(defender.kind) === "infantry") targetKind = "entrenched infantry";
  const target = Number(block.damageKind[String(targetKind)] ?? 0);
  if (attacker > 0 && target === 9) return Number(block.kindNine[attacker] ?? 0);
  if (attacker > 0 && target > 0 && Array.isArray(block.damageMatrix[attacker])) {
    return Number(block.damageMatrix[attacker][target]) || 0;
  }
  return Number(block.baseDamage[String(attackerKind)] ?? 0);
}

// The terrain byte under a piece, as the board serves it. Cached: `damageFor` runs once per
// pairing per beat, and boardPayload() re-reads the extract root on every call otherwise.
let cellsCache;
function terrainIdAt(x, y) {
  if (cellsCache === undefined) {
    try {
      cellsCache = boardPayload().cells || null;
    } catch {
      cellsCache = null;
    }
  }
  if (!cellsCache) return null;
  const raw = Number(x);
  const wx = ((raw % CELL_W) + CELL_W) % CELL_W;
  return cellsCache[Number(y) * CELL_W + wx] ?? null;
}

// Terrain cover, read exactly as `FUN_194c_000e` @ 194c:000e does it (decompiled.c 7032-7046):
// the DEFENDER's terrain byte (unit+0x836), applied to the matrix cell BEFORE flank/rear.
//   mountain (10): infantry kinds 1/3 lose a quarter of the cell, tanks (2) a sixth;
//   lake/capital/base/city (4..6): infantry kinds 1/3 lose (cell+1)/3, tanks (2) a fifth.
// Integer arithmetic, so 20 is 15 on a mountain and 13 in a city, and a 17 against a tank is
// 14 in a city. IDs are board.TERRAIN; the original's 0x836 is the same terrain map.
export function coverFor(base, terrainId, defenderKind) {
  const amount = Number(base) || 0;
  if (terrainId === null || terrainId === undefined) return amount;
  const id = Number(terrainId);
  const tables = terrainTables();
  const kind = String(defenderKind) === "tank" ? 2 : 1;   // 1 = kinds 1/3 (infantry and dug-in)
  if (tables.mountain.has(id)) {
    return kind === 2 ? amount - Math.floor(amount / 6) : amount - (amount >> 2);
  }
  if (tables.cityLike.has(id)) {
    return kind === 2 ? amount - Math.floor(amount / 5) : amount - Math.floor((amount + 1) / 3);
  }
  return amount;
}

export function coverDamage(base, defender) {
  if (!defender) return Number(base) || 0;
  return coverFor(base, terrainIdAt(defender.x, defender.y), defender.kind);
}

// Damage one piece deals to another. The modifiers the manual names, in one place: terrain
// cover (the defender's cell), flank/rear (land only, p.22) and entrenchment (land only, p.22,
// through the defender's kind-3 column). Ships are never flanked (p.24).
//
// Flank/rear is read exactly as `FUN_194c_000e` does it (decompiled.c 7064-7071): compare the
// ATTACKER's facing with the defender's. Same facing = the attacker is behind the defender, x2.
// Otherwise, if the attacker's facing is not the defender's opposite (they are not facing each
// other), x1.5. Facing each other = x1. The bonus only applies while the defender is already
// fighting a third piece: the original requires the defender's target link to be set and to not
// be the attacker.
export function damageFor(attacker, defender, combat = null) {
  const block = combat || combatRules();
  const base = baseDamageFor(attacker.kind, defender, block);
  let amount = coverDamage(base, defender);
  let flank = false;
  let rear = false;
  // The original compares two facing bytes. A piece the remake has not faced yet carries none, so
  // it is read as facing the defender (the geometry the walker would have stamped).
  const attackFacing = attacker.facing || bearing(attacker, defender);
  const defendFacing = defender.facing || null;
  const busy = defender.fighting !== null && defender.fighting !== undefined && defender.fighting !== attacker.id;
  if (attacker.domain !== "sea" && defender.domain !== "sea" && attackFacing && defendFacing && busy) {
    if (String(attackFacing) === String(defendFacing)) {
      amount *= block.rearMultiplier;
      rear = true;
    } else if (OPPOSITE[String(attackFacing)] !== String(defendFacing)) {
      amount *= block.flankMultiplier;
      flank = true;
    }
  }
  let entrenched = false;
  if (defender.domain !== "sea" && defender.entrenched === true) {
    amount *= block.entrenchDamageFactor;
    entrenched = true;
  }
  // Shore fire (DS:0x194c path, disassembly only): a ship firing farther than `range` has its shot
  // halved while the target is under `halveBelow` strength, and is otherwise capped at
  // max(0, strength - cap). With `halveBelow` 25 and `cap` 30 the clauses meet at 25: from 25 to 30
  // strength the halving no longer applies and the cap branch wins with max(0, s - 30) = 0, so that
  // band takes NO shore fire at all (s=31 takes 1, s=45+ takes the full shot). The cap is therefore
  // a floor on the target's REMAINING strength, not on the damage. This is labelled `disassembly`
  // in config and is NOT live-measured - see docs/re/T016_TERRAIN.md s5 and Q47.
  const shore = terrainTables().shoreFire;
  let shoreFire = false;
  if (shore.enabled && attacker.domain === "sea" && defender.domain !== "sea"
      && distance(attacker, defender) > shore.range) {
    shoreFire = true;
    const strength = ensureStrength(defender, block.maxStrength);
    if (strength < shore.halveBelow) amount = amount / 2;
    else amount = Math.min(amount, Math.max(0, strength - shore.cap));
  }
  return { base, covered: coverDamage(base, defender), amount, flank, rear, entrenched, shoreFire };
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
  // Per-side bounding box of the armed pieces, and how many each side has. A piece whose nearest
  // possible enemy is farther than its own reach cannot have a target, and one scan of the box
  // says so without walking the rest of the room: this is what keeps the pass cheap in a real
  // 40-piece match, where the pair scan is the whole cost.
  const box = [
    null, // unused, sides are numbered from 1
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 },
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 },
  ];
  for (let i = 0; i < n; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    xs[i] = Number(piece.x);
    ys[i] = Number(piece.y);
    sides[i] = piece.side === "blue" ? 1 : piece.side === "red" ? 2 : 0;
    armed[i] = piece.kind === "aircraft" || piece.domain === "air" ? 0 : 1;
    ranges[i] = Math.min(255, Math.max(0, rangeOf(piece, combat)));
    const side = sides[i];
    if (!armed[i] || side === 0 || ranges[i] <= 0) continue;
    const b = box[side];
    if (xs[i] < b.minX) b.minX = xs[i];
    if (xs[i] > b.maxX) b.maxX = xs[i];
    if (ys[i] < b.minY) b.minY = ys[i];
    if (ys[i] > b.maxY) b.maxY = ys[i];
    b.count += 1;
  }
  // A circle of circumference CELL_W: the nearest point of an arc is an endpoint when the piece
  // is outside it, so the gap to the enemy box's x-span is exact under the board's wrap.
  const half = CELL_W / 2;
  for (let i = 0; i < n; i++) {
    if (!armed[i] || ranges[i] <= 0 || sides[i] === 0) continue;
    const piece = pieces[i];
    const range = ranges[i];
    const px = xs[i];
    const py = ys[i];
    const enemy = box[sides[i] === 1 ? 2 : 1];
    // No armed enemy at all: no contact, no scan.
    if (enemy.count === 0) continue;
    const yGap = py < enemy.minY ? enemy.minY - py : py > enemy.maxY ? py - enemy.maxY : 0;
    if (yGap > range) continue;
    let xGap = 0;
    if (px < enemy.minX || px > enemy.maxX) {
      const toMin = Math.abs(px - enemy.minX);
      const toMax = Math.abs(px - enemy.maxX);
      xGap = Math.min(toMin > half ? CELL_W - toMin : toMin, toMax > half ? CELL_W - toMax : toMax);
    }
    if (xGap > range) continue;
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
      // The pairing decides whether a shot exists at all: the matrix zeroes a submarine against
      // land and a sub's kind-7 column of 0 is not a damage number, it is "no engagement".
      const hit = { attacker, target, ...damageFor(attacker, target, combat) };
      if (!(Number(hit.base) > 0)) continue;
      hits.push(hit);
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
        rear: hit.rear === true,
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
      // The board's cell index, not a fresh Map of every site every round: the bench builds 1000
      // rooms' indexes once and then pays one lookup per hit.
      const byCell = siteIndex(match.sites);
      for (const hit of hits) {
        const site = byCell ? byCell.get(Number(hit.target.y) * CELL_W + Number(hit.target.x)) || null : null;
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
//
// T-016: the ground decides whether the state is available at all. DS:0x1996 bit 0x20 marks the
// dig-in terrains (plain, forest, mountain, oilfield, desert, jungle) and the config carries that
// list; a city, base, capital, lake, polar or wasteland cell carries no bit 0x20, so infantry
// standing there does not entrench. A tree with no board extract cannot name a terrain and is
// treated like open plain — the same fallback the walker uses — so a test without data still runs.
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
    const terrain = terrainIdAt(piece.x, piece.y);
    if (terrain !== null && terrain !== undefined && !digInIds().has(Number(terrain))) {
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
