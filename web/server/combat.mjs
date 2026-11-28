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
import { footprintCellIndex, layerOf } from "./placement.mjs";
import { combatRules, seaRangeFor, digInIds, terrainTables } from "./rules.mjs";

// "Is this piece on the air layer?" is asked in four places below (reach, two target scans, the
// mass-selection pass) and every one of them used to inline `kind === "aircraft" || domain ===
// "air"`. That expression is placement.layerOf's ground/air split written out a second, third and
// fourth time: same meaning, no shared identity, so a change to the layer rule would leave combat
// behind silently. T-029 imports the one predicate instead. The arm is behaviour-identical -
// layerOf(x) === "air" is the same test, byte for byte - so this is a dedupe, not a rule change.
const onAirLayer = (piece) => layerOf(piece) === "air";

// The words that ride the events. The numbers ride as fields, so a test asserts a figure instead
// of a sentence.
export const SHOT_NOTE = "Strength hit.";
export const FIGHT_OVER_NOTE = "Strength spent. The unit is gone.";
export const ENTRENCH_NOTE = "Dug in. Incoming hits land at the entrenched factor.";
export const MILITIA_NOTE = "City militia.";

// PB-216: the site kinds whose militia defends them. Same list the old hits-loop carried - a city,
// base, dock or capital; a facility has none.
const MILITIA_SITES = new Set(["city", "base", "dock", "docks", "capital"]);

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

// PB-204: the 0x1956 range matrix stores SQUARED distance thresholds (docs/re/COMBAT.md s3), so a
// reach test has to square the offset rather than take Chebyshev cells. Same X wrap as distance();
// this is the ONE squared distance in the server - move.mjs imports it instead of keeping a copy.
export function squaredDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, CELL_W - dx);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return wrap * wrap + dy * dy;
}

// DS:0x194c maps a kind to a range class: kinds 0-4 -> 0, 5-6 -> 1, 7 -> 2, 8 -> 3, 9 -> 4,
// 10-11 -> 5. A transport keeps its land kind, so it is read as the sea cargo class here for the
// same reason PB-202 reads it that way for damage: the sea rows are the ones the table has.
function rangeClassOf(piece, block) {
  if (!piece) return 0;
  let kind = piece.kind;
  if (piece.transport === true) kind = block.transportDamageKind;
  const byte = Number(block.damageKind[String(kind)] ?? (Number(kind) || 0));
  if (byte <= 4) return 0;
  if (byte <= 6) return 1;
  if (byte <= 9) return byte - 5;
  return 5;
}

// The measured engage threshold for an ordered pair, as a SQUARED distance: row = attacker class,
// column = target class. 0 means the pairing never engages (a submarine never acquires land, and
// column 5 is the piece's own contact range, not an engage column).
export function engageRange2(attacker, target, combat = null) {
  const block = combat || combatRules();
  const rows = block && block.rangeMatrix;
  if (!Array.isArray(rows)) return 0;
  const row = rows[rangeClassOf(attacker, block)];
  if (!Array.isArray(row)) return 0;
  const targetClass = rangeClassOf(target, block);
  // Column 5 is the piece's OWN contact range, not an engage column: reading it as a target's
  // threshold would hand a class-5 target (kinds 10-11) its own notice range instead of 0.
  if (targetClass >= 5) return 0;
  return Math.max(0, Number(row[targetClass]) || 0);
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

// PB-211 (D-030): the beat is per PAIR, not per front. Each piece carries the last round it
// exchanged fire in `lastShotRound`; a pair is due only when BOTH of its members are due. The
// `max` is load-bearing, not a detail: without it a piece that fired two rounds ago on another
// front joins a fresh fight and fires at a partner that has never fired, and the partner answers
// out of turn - a one-sided exchange, which is not what p.22's "damages a single enemy unit once
// every other round" describes. `?? -1` covers a piece that has never fired and an older saved
// row, so its first contact is due.
export function pairDue(a, b, round, shotEveryRounds = combatRules().shotEveryRounds) {
  const last = Math.max(Number(a?.lastShotRound ?? -1), Number(b?.lastShotRound ?? -1));
  return Number(round) - last >= Number(shotEveryRounds);
}

// An exchange belongs to a pair, so both members move their clock - never just the shooter.
export function stampPair(a, b, round) {
  const at = Number(round) || 0;
  if (a) a.lastShotRound = at;
  if (b) b.lastShotRound = at;
}

// The noun every log line and event uses for a piece. Cargo is a transport whatever hull carried
// it, and it is the one noun a removed piece can no longer be asked for.
export function kindOf(piece) {
  if (!piece) return null;
  return piece.transport === true ? "transport" : piece.kind;
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
  if (onAirLayer(piece)) return 0;
  if (piece.domain === "sea") return seaRangeFor(piece.kind, combat);
  return (combat || combatRules()).landEngageCells;
}

// Every enemy this piece can reach this round.
export function candidatesFor(piece, pieces) {
  if (!piece) return [];
  const range = rangeOf(piece);
  if (range <= 0) return [];
  const block = combatRules();
  const out = [];
  for (const other of pieces || []) {
    if (!other || other.id === piece.id) continue;
    if (other.side === piece.side) continue;
    if (onAirLayer(other)) continue;
    // PB-204: the matrix column is a squared threshold, so the compare is squared. Chebyshev here
    // admitted (2,2) for a 2-cell hull: a submarine acquired at d^2 = 8 where the table allows 5.
    const reach2 = engageRange2(piece, other, block);
    if (reach2 > 0 && squaredDistance(piece, other) <= reach2) out.push(other);
  }
  return out;
}

// Keep the target the piece already had while it is still in reach; switch only when a closer
// enemy arrives (p.22). Otherwise nearest first, lower id on a tie so the board is deterministic.
// One pass, no allocation: this runs for every piece of every room every round.
export function chooseTarget(piece, pieces, combat = null) {
  if (!piece) return null;
  const block = combat || combatRules();
  const range = rangeOf(piece, combat);
  if (range <= 0) return null;
  let best = null;
  let bestDistance = Infinity;
  let held = null;
  let heldDistance = Infinity;
  for (const other of pieces || []) {
    if (!other || other.id === piece.id) continue;
    if (other.side === piece.side) continue;
    if (onAirLayer(other)) continue;
    // PB-204: reach is the matrix's squared threshold, so the filter is squared. The nearest-first
    // ordering keeps comparing the same quantity, which only re-orders exact ties and keeps the
    // lower-id tie-break deterministic.
    const reach2 = engageRange2(piece, other, block);
    if (reach2 <= 0) continue;
    const distanceTo = squaredDistance(piece, other);
    if (distanceTo > reach2) continue;
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
  const attacker = Number(block.damageKind[String(attackerKind)] ?? (Number(attackerKind) || 0));
  let targetKind = defender && defender.kind;
  // PB-202: a transport is a land piece at sea, so its own kind is infantry/tank and the sea rows
  // in the table were never read. The sea cargo class is the row the original indexes for cargo.
  if (defender && defender.transport === true) targetKind = block.transportDamageKind;
  if (defender && defender.entrenched === true && String(defender.kind) === "infantry") targetKind = "entrenched infantry";
  const target = Number(block.damageKind[String(targetKind)] ?? (Number(targetKind) || 0));
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
  // PB-202: cargo fires with the sea class's row, not its land kind's row (see the config entry).
  const attackerKind = attacker.transport === true ? block.transportDamageKind : attacker.kind;
  const base = baseDamageFor(attackerKind, defender, block);
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
      // 7066 is `local_8 <<= 1`: a shift on the integer cell, so d*2 exactly.
      amount *= block.rearMultiplier;
      rear = true;
    } else if (OPPOSITE[String(attackFacing)] !== String(defendFacing)) {
      // 7070 is `local_8 += (int) local_8 / 2`, integer division on the covered cell. The port used
      // to multiply by 1.5, so a city hit read 19.5 where the original reads 13 + 13/2 = 19. Flank
      // is now the original's form - d + trunc(d * (multiplier - 1)) - and the config value stays
      // the lever: 20 -> 30 on a plain, 13 -> 19 and 15 -> 22 where the cell is odd.
      amount += Math.floor(amount * (Number(block.flankMultiplier) - 1));
      flank = true;
    }
  }
  let entrenched = false;
  if (defender.domain !== "sea" && defender.entrenched === true) {
    amount *= block.entrenchDamageFactor;
    entrenched = true;
  }
  // Shore fire (DS:0x194c path, disassembly only). PB-347: the original (decompiled.c 7082-7093,
  // FUN_194c_000e) is SEQUENTIAL, not either/or - cap = strength - 30; when that cap is under 25 the
  // shot is halved; then min(amount, cap) applies ALWAYS; a result that is not positive is no shot.
  // The range gate is the squared distance from FUN_188b_0216 (`2 < d^2`), not a Chebyshev cell
  // count, so a (2,2) diagonal is in range. Values stay labelled `disassembly` in config and are
  // NOT live-measured - see docs/re/T016_TERRAIN.md s5 and Q47.
  const shore = terrainTables().shoreFire;
  let shoreFire = false;
  if (shore.enabled && attacker.domain === "sea" && defender.domain !== "sea"
      && squaredDistance(attacker, defender) > shore.range2) {
    shoreFire = true;
    const strength = Number(defender.strength);
    const cap = strength - shore.cap;
    if (cap < shore.halveBelow) amount = amount / 2;
    amount = Math.min(amount, Math.max(0, cap));
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
    armed[i] = onAirLayer(piece) ? 0 : 1;
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
      const other = pieces[j];
      // PB-204: the room-wide pass has to read the matrix's squared threshold too, or the fix only
      // exists in the readable chooseTarget and never reaches resolve(). The `ranges[i]` prefilter
      // above stays in CELLS on purpose: it is the Chebyshev bound of the squared disc (d^2 <= 5
      // implies max(|dx|,|dy|) <= 2), so it never skips a pair the squared test would admit.
      const reach2 = engageRange2(piece, other, combat);
      if (reach2 <= 0) continue;
      const raw = Math.abs(px - xs[j]);
      const dx = raw > CELL_W / 2 ? CELL_W - raw : raw;
      const dy = py - ys[j];
      const distanceTo = dx * dx + dy * dy;
      if (distanceTo > reach2) continue;
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

  // PB-211 (D-030): there is no front-wide beat any more. `match.foughtRound` is still written as
  // the record docs/CONTRACTS.md:45 defines, but nothing reads it as a gate; each pair answers for
  // its own clock, so an exchange on one front cannot silence a pair on another for a round.
  {
    const hits = [];
    for (let i = 0; i < pieces.length; i++) {
      const attacker = pieces[i];
      const target = targets[i];
      if (!target) continue;
      // The pair's own beat, and the one refinement the ruling carries: BOTH members must be due,
      // so a piece that fired recently elsewhere cannot fire here while its partner stays silent.
      if (!pairDue(attacker, target, round, combat.shotEveryRounds)) continue;
      // PB-202: cargo is not silent any more. Its row in the table is the sea cargo row (row 5:
      // [0,18,16,14,0,10,10,5,5] over columns 0-8), so a transport fires 5 at a submarine, 10 at
      // another transport and 18 at infantry ashore - numbers the table supplies, not a blanket
      // skip. It still does not survive the exchange (:427).
      const hit = { attacker, target, ...damageFor(attacker, target, combat) };
      if (!(Number(hit.base) > 0)) continue;
      // PB-347: the original refuses a shot whose shore-capped result is not positive
      // (`if (0 < (int)local_8)`, decompiled.c 7082-7093), so base > 0 alone is no longer enough.
      if (hit.shoreFire === true && !(Number(hit.amount) > 0)) continue;
      hits.push(hit);
    }

    const doomed = new Set();
    const log = [];

    for (const hit of hits) {
      const { attacker, target } = hit;
      // Cargo is lost on the first hit, whatever the numbers are.
      const amount = target.transport === true ? Math.max(hit.amount, ensureStrength(target, max)) : hit.amount;
      const result = applyDamage(target, amount, max);
      // PB-202: the status line reads `shots` and nothing ever wrote it, so a resolved fight and a
      // dead one both said 0. Count the shot that landed, on the piece that fired it.
      attacker.shots = Number(attacker.shots || 0) + 1;
      // PB-211 (D-030): both members of the pair move their clock on the exchange. The next due
      // check for either of them - here or on another front - reads this stamp.
      stampPair(attacker, target, round);
      log.push({
        type: "shot",
        side: attacker.side,
        pieceId: attacker.id,
        target: target.id,
        // PB-208: the target's side rides the event. The log has to know whether the piece that
        // took the hit is the reader's own, because a killing hit removes it before the log is
        // built and the seat cannot then discover the side from the board.
        targetSide: target.side,
        // The log names both sides by noun, and the target may already be off the board when the
        // line is written, so the nouns ride the event rather than a post-hoc lookup (PB-202 AC3).
        attackerKind: kindOf(attacker),
        targetKind: kindOf(target),
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
    //
    // PB-216: the militia is the CITY's producer, not a rider on an exchange. It used to walk
    // `hits`, so with the last defender gone there was no hit to hang on and the block never ran -
    // the manual's own case ("Do you see it take damage even after the enemy unit is destroyed?",
    // L246-247) was the one case the code could not express. It also looked the site up on the
    // ANCHOR cell only, so a defender bought on a footprint cell (D-026) got no militia even while
    // it was alive and fighting on its own city. Now every enemy piece standing inside the city
    // pays, on its own militia beat.
    if (combat.militiaDamage > 0) {
      const byCell = footprintCellIndex(match);
      const sites = byCell && Array.isArray(match.sites) ? match.sites : null;
      const paid = new Set();
      // The index carries a site's POSITION in the match's own list (see placement.mjs), so the
      // object - and its live owner - is always this room's.
      const siteOfCell = (piece) => {
        if (!byCell) return null;
        const at = byCell.get(Number(piece.y) * CELL_W + Number(piece.x));
        return at === undefined ? null : sites[at] || null;
      };
      const siteKey = (site) => (site.id === undefined || site.id === null
        ? Number(site.x) + "," + Number(site.y)
        : String(site.id));
      const pay = (piece, site) => {
        if (!piece || paid.has(piece.id) || doomed.has(piece.id)) return;
        // The beat is per piece per city: a piece that walks into a second city starts that
        // city's clock fresh, and a piece that leaves and comes back is a new occupation.
        const key = siteKey(site);
        const last = piece.militiaSite === key ? Number(piece.militiaRound ?? -1) : -1;
        if (Number(round) - last < Number(combat.shotEveryRounds)) return;
        paid.add(piece.id);
        piece.militiaSite = key;
        piece.militiaRound = round;
        const militia = applyDamage(piece, combat.militiaDamage, max);
        log.push({
          type: "shot",
          side: site.owner,
          pieceId: "militia:" + (site.id ?? site.name ?? "city"),
          target: piece.id,
          // PB-211 gate (f): the militia is a producer like any other, and the log/lexicon reads
          // these three fields, not a board lookup - the piece it shot may die this round.
          targetSide: piece.side,
          attackerKind: "militia",
          targetKind: kindOf(piece),
          amount: combat.militiaDamage,
          strength: militia.after,
          flank: false,
          entrenched: false,
          militia: true,
          at: { x: piece.x, y: piece.y },
          round,
          note: MILITIA_NOTE,
        });
        if (militia.dead) doomed.add(piece.id);
      };

      // (a) The occupation: every enemy piece standing inside the city, defender or not. This is
      // the manual's case, and it is the half the old `hits` walk could not express.
      for (let i = 0; byCell && i < pieces.length; i++) {
        const piece = pieces[i];
        const site = piece ? siteOfCell(piece) : null;
        if (!site || !MILITIA_SITES.has(String(site.kind))) continue;
        if (!site.owner || site.owner === piece.side) continue;
        pay(piece, site);
      }

      // (b) is GONE (PB-288, PM 9779 §4 ruling on difference (i)). That arm paid every attacker
      // that had traded shots with a defender standing on its own city, wherever the attacker
      // stood - one cell outside the footprint, or four. The original has no such branch:
      // FUN_1c0d_00b4 walks the pieces that are ON the site's cells. The militia now lands only on
      // an enemy piece standing on the site's cells, which is branch (a) above; a shooter outside
      // the footprint takes nothing back from the city. The per-pass-vs-every-2-rounds pacing
      // (difference (ii)) is untouched and stays D-017.
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
          // PB-208: the line read "lost a unit" for every loss because this event carried no kind;
          // the seat that just lost a submarine could not be told it was a submarine.
          kind: kindOf(piece),
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
