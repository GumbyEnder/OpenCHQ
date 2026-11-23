// PB-204 — the sea arm: a hull's reach is the 0x1956 matrix's SQUARED threshold, not its cell
// count taken as a Chebyshev radius.
//
// What breaks if this is removed: candidatesFor / chooseTarget / computeTargets compared Chebyshev
// `distance()` against rangeOf(piece), which for a sea hull is seaRangeCells — 2/3/4 CELLS. A
// Chebyshev radius of 2 is a square of side 5, so a submarine acquired at (2,2) (d^2 = 8) where the
// measured table allows d^2 <= 5, a cruiser at (3,3) (d^2 = 18) where it allows 10, and a carrier at
// (4,4) (d^2 = 32) where it allows 17. resolve() reads computeTargets, so the over-reach was live,
// not just in the readable path.
//
// Thresholds are the measured matrix (docs/re/COMBAT.md s3, config combat.measured.value.rangeMatrix):
// class 2 -> 5, class 3 -> 10, class 4 -> 17. They are NOT cells squared: the cell ladder 2/3/4 is a
// label for those thresholds, and 2^2 = 4 would reject a submarine's own (2,1) at d^2 = 5.
//
// Legs:
//   AC1 land   — the land arm as PB-097b filed it, now through the acquisition path: (2,1) d^2 = 5 is
//                a candidate, (2,2) d^2 = 8 is not, and the literal read is 5 (not 4).
//   AC2 sea    — submarine (2,1) in / (2,2) out; cruiser (3,1) d^2 = 10 and (2,2) d^2 = 8 in,
//                (3,2) d^2 = 13 and (3,3) d^2 = 18 out; carrier (4,1) d^2 = 17 in, (4,4) out;
//                a submarine has no land candidate at all; the wrap is measured on the X edge.
//                (2,2) for a cruiser is a CONTROL: both readings admit it (8 <= 10, Chebyshev 2 <= 3),
//                so it cannot discriminate and must not be used as the fix's witness.
//   AC3 no change — `distance()` is still Chebyshev, a diagonal neighbour is still adjacent, the
//                shore-fire range is still 2 CELLS (a squared swap there would silently red it), and
//                computeTargets — the pass resolve() actually reads — shows both the in and out arms.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { adjacent, candidatesFor, computeTargets, distance, engageRange2, squaredDistance } from "../../server/combat.mjs";
import { combatRules, terrainTables } from "../../server/rules.mjs";
import { inEngageRange } from "../../server/move.mjs";

export const name = "pb204_sea_engage_squared";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

const ship = (id, side, kind, x, y) => ({ id, side, kind, domain: "sea", x, y, path: [], credit: 0,
  pace: 1, strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false,
  fighting: null });

const troop = (id, side, kind, x, y) => ({ id, side, kind, domain: "land", x, y, path: [], credit: 0,
  pace: 1, strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false,
  fighting: null });

const ids = (list) => list.map((p) => String(p.id)).sort().join(",");

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "PB-204 needs the board cells");
  const block = combatRules();
  must(Array.isArray(block.rangeMatrix) && block.rangeMatrix.length === 6,
    "PB-204: combatRules() is not carrying the 6x6 range matrix");
  // The engage columns are 0-4; column 5 is the piece's own contact range and is NOT a target
  // threshold, which is why the reader refuses a class-5 target instead of reading that column.
  must(block.rangeMatrix[2][1] === 5 && block.rangeMatrix[3][2] === 10 && block.rangeMatrix[4][2] === 17,
    "PB-204: the matrix's engage columns are not the measured 5/10/17 for classes 2/3/4");
  must(block.rangeMatrix[2][5] === 17,
    "PB-204: column 5 is no longer the own-contact column; the reader's refusal of it needs re-checking");

  // An open stretch of water away from both capitals, wide enough for a (4,4) offset.
  let sea = null;
  for (let y = 4; y < 150 && !sea; y++) {
    for (let x = 4; x < 300 && !sea; x++) {
      let ok = true;
      for (let i = 0; i <= 5 && ok; i++) {
        for (let j = 0; j <= 5 && ok; j++) {
          const terrainId = Number(board.cells[(y + j) * CELL_W + (x + i)]);
          if (terrainId !== 0) ok = false; // 0 = ocean in board.TERRAIN
        }
      }
      if (ok) sea = { x, y };
    }
  }
  must(sea, "PB-204: no open six-by-six ocean block on the board, the test cannot run");

  // ---- AC1: land, through the acquisition path -------------------------------------------------
  {
    const tank = troop("blue:tank", "blue", "tank", sea.x, sea.y);
    const near = troop("red:near", "red", "infantry", sea.x + 2, sea.y + 1);
    const diag = troop("red:diag", "red", "infantry", sea.x + 2, sea.y + 2);
    must(squaredDistance(tank, near) === 5, "AC1: the (2,1) offset is d^2 = " + squaredDistance(tank, near));
    must(squaredDistance(tank, diag) === 8, "AC1: the (2,2) offset is d^2 = " + squaredDistance(tank, diag));
    must(engageRange2(tank, near) === 5,
      "AC1: land's threshold reads " + engageRange2(tank, near) + ", not the measured 5 (4 is cells squared)");
    must(ids(candidatesFor(tank, [tank, near])) === "red:near", "AC1: the (2,1) infantry is not a candidate");
    must(ids(candidatesFor(tank, [tank, diag])) === "", "AC1: the (2,2) infantry IS a candidate at d^2 = 8");
  }

  // ---- AC2: the sea ladder, squared ------------------------------------------------------------
  {
    const sub = ship("blue:sub", "blue", "submarine", sea.x, sea.y);
    must(engageRange2(sub, ship("red:x", "red", "cruiser", sea.x + 1, sea.y)) === 5,
      "AC2: a submarine's threshold is not 5");
    const at5 = ship("red:at5", "red", "cruiser", sea.x + 2, sea.y + 1);
    const at8 = ship("red:at8", "red", "cruiser", sea.x + 2, sea.y + 2);
    must(ids(candidatesFor(sub, [sub, at5])) === "red:at5", "AC2: a submarine does not acquire at (2,1) d^2 = 5");
    must(ids(candidatesFor(sub, [sub, at8])) === "",
      "AC2: a submarine acquired at (2,2) d^2 = 8 — that is the Chebyshev radius, not the table");

    const cruiser = ship("blue:cruiser", "blue", "cruiser", sea.x, sea.y);
    must(engageRange2(cruiser, at5) === 10, "AC2: a cruiser's threshold is not 10");
    const c10 = ship("red:c10", "red", "cruiser", sea.x + 3, sea.y + 1);
    const c8 = ship("red:c8", "red", "submarine", sea.x + 2, sea.y + 2);
    const c13 = ship("red:c13", "red", "cruiser", sea.x + 3, sea.y + 2);
    const c18 = ship("red:c18", "red", "carrier", sea.x + 3, sea.y + 3);
    must(ids(candidatesFor(cruiser, [cruiser, c10])) === "red:c10", "AC2: the cruiser's boundary (3,1) d^2 = 10 is not a candidate");
    // Control, not witness: both readings admit (2,2) for a cruiser, so it only proves the fix did
    // not over-tighten.
    must(ids(candidatesFor(cruiser, [cruiser, c8])) === "red:c8", "AC2: the cruiser lost its (2,2) control at d^2 = 8");
    must(ids(candidatesFor(cruiser, [cruiser, c13])) === "", "AC2: the cruiser acquired at (3,2) d^2 = 13");
    must(ids(candidatesFor(cruiser, [cruiser, c18])) === "", "AC2: the cruiser acquired at (3,3) d^2 = 18");

    const carrier = ship("blue:carrier", "blue", "carrier", sea.x, sea.y);
    must(engageRange2(carrier, c10) === 17, "AC2: a carrier's threshold is not 17");
    const k17 = ship("red:k17", "red", "carrier", sea.x + 4, sea.y + 1);
    const k32 = ship("red:k32", "red", "carrier", sea.x + 4, sea.y + 4);
    must(ids(candidatesFor(carrier, [carrier, k17])) === "red:k17", "AC2: the carrier's boundary (4,1) d^2 = 17 is not a candidate");
    must(ids(candidatesFor(carrier, [carrier, k32])) === "", "AC2: the carrier acquired at (4,4) d^2 = 32");

    // A submarine never acquires land — column 0 of its row is 0, and 0 is not "unset".
    const ashore = troop("red:ashore", "red", "infantry", sea.x + 1, sea.y + 1);
    must(engageRange2(sub, ashore) === 0, "AC2: a submarine's row against land is " + engageRange2(sub, ashore) + ", not 0");
    must(ids(candidatesFor(sub, [sub, ashore])) === "", "AC2: a submarine acquired a land unit ashore");

    // The X wrap is part of the distance, so it is part of the threshold.
    const edge = ship("blue:edge", "blue", "cruiser", 0, sea.y);
    const wrapped9 = ship("red:w9", "red", "cruiser", CELL_W - 3, sea.y);
    const wrapped13 = ship("red:w13", "red", "cruiser", CELL_W - 3, sea.y + 2);
    must(squaredDistance(edge, wrapped9) === 9, "AC2: the wrap reads d^2 = " + squaredDistance(edge, wrapped9) + ", not 9");
    must(ids(candidatesFor(edge, [edge, wrapped9])) === "red:w9", "AC2: the cruiser lost its across-the-seam (3,0) target");
    must(ids(candidatesFor(edge, [edge, wrapped13])) === "", "AC2: the cruiser acquired across the seam at d^2 = 13");

    // The completion rule shares the same threshold.
    must(inEngageRange(sub, at5, block.seaRangeCells.submarine), "AC2: inEngageRange says a submarine at d^2 = 5 is out");
    must(!inEngageRange(sub, at8, block.seaRangeCells.submarine), "AC2: inEngageRange says a submarine at d^2 = 8 is in");
  }

  // ---- AC3: what must NOT have moved ----------------------------------------------------------
  {
    must(distance({ x: 0, y: 0 }, { x: 3, y: 2 }) === 3,
      "AC3: distance() is no longer Chebyshev — a squared swap here reds adjacency and shore fire");
    must(adjacent({ x: 5, y: 5 }, { x: 6, y: 6 }) === true,
      "AC3: a diagonal neighbour is no longer adjacent — distance() was moved to squared semantics");
    const shore = terrainTables().shoreFire;
    must(Number(shore.range) === 2,
      "AC3: shore fire range is " + shore.range + ", not 2 CELLS — it compares distance() and must not be squared");
  }

  // ---- AC3 (behaviour): the pass resolve() reads, both arms -----------------------------------
  {
    const match = openMatch("1986");
    const cruiser = ship("blue:cruiser", "blue", "cruiser", sea.x, sea.y);
    const out = ship("red:out", "red", "cruiser", sea.x + 3, sea.y + 2);
    const inn = ship("red:in", "red", "cruiser", sea.x + 3, sea.y + 1);
    match.pieces = [cruiser, out];
    match.round = 1;
    let targets = computeTargets(match.pieces);
    must(targets[0] === null, "AC3: computeTargets acquired at (3,2) d^2 = 13 — resolve() is still on Chebyshev");
    match.pieces = [cruiser, inn];
    targets = computeTargets(match.pieces);
    must(targets[0] === inn, "AC3: computeTargets lost the (3,1) d^2 = 10 target that the matrix admits");
  }
}
