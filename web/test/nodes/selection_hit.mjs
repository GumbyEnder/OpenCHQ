// selection_hit - a click anywhere on a piece's DRAWN icon selects that piece (T-028, PB-050).
//
// What fails if this is removed:
//   - a click inside the icon but on a neighbouring cell selects nothing -> the hit test is back to
//     ownPieceAt's single-cell equality, which is PB-050 itself (184 of 196 positions missed at the
//     world fit)
//   - the icon box is a cell box, not the painted badge box -> a click on the badge's own corner
//     misses at the whole-world fit, where the badge is larger than its cell
//   - a click on an enemy piece or on empty map selects one of yours -> the side filter is gone
//   - two overlapping badges resolve to the farther centre -> the nearest-centre rule is gone
//   - a second click on an air/ground stack does not reach the ground piece -> the stack cycle is
//     gone and the ground unit under a based plane is unreachable (T-021 made that stack legal)

import { badgePx } from "../../public/badges.mjs";
import { cellToPixel } from "../../public/render.mjs";
import { pickPieceAt, piecesAtPoint, layerOfPiece } from "../../public/command.mjs";

const BOARD_W = 320;
const BOARD_H = 136;

function viewAt(scale) {
  return { scale, left: 0, top: 0, viewW: BOARD_W * scale, viewH: BOARD_H * scale, boardW: BOARD_W, boardH: BOARD_H };
}

const BLUE_INF = { id: "blue:infantry:1", side: "blue", kind: "infantry", domain: "land", x: 79, y: 44, strength: 100 };
const BLUE_TANK = { id: "blue:tank:2", side: "blue", kind: "tank", domain: "land", x: 79, y: 44, strength: 100 };
const BLUE_PLANE = { id: "blue:aircraft:3", side: "blue", kind: "aircraft", domain: "air", x: 80, y: 44, strength: 100 };
const BLUE_NEAR = { id: "blue:tank:4", side: "blue", kind: "tank", domain: "land", x: 80, y: 44, strength: 100 };
const RED_INF = { id: "red:infantry:9", side: "red", kind: "infantry", domain: "land", x: 60, y: 30, strength: 100 };

// The 196-position sweep: a 14x14 grid at half-pixel offsets centred on the icon, the same shape
// PB-050 was measured with (14 x 14 = 196 positions inside the drawn badge). Every one of them is
// inside the badge box at every zoom this test names.
function sweep(piece, scale, pieces) {
  const view = viewAt(scale);
  const centre = cellToPixel(piece.x, piece.y, view);
  const half = badgePx(scale) / 2;
  let tried = 0;
  let hit = 0;
  for (let iy = 0; iy < 14; iy++) {
    for (let ix = 0; ix < 14; ix++) {
      const dx = ix - 6.5;
      const dy = iy - 6.5;
      if (Math.abs(dx) > half || Math.abs(dy) > half) continue;
      tried++;
      const got = pickPieceAt(pieces, view, centre.x + dx, centre.y + dy, { side: "blue", badgeMinPx: 14 });
      if (got && String(got.id) === String(piece.id)) hit++;
    }
  }
  return { tried, hit, percent: (100 * hit) / tried };
}

export const name = "selection_hit";

export function run({ fail }) {
  // ---- AC1: the icon box selects at the three zooms the sweep reports ----------------------
  for (const scale of [4, 6, 8]) {
    const one = sweep(BLUE_INF, scale, [BLUE_INF]);
    if (one.hit !== one.tried) {
      fail("at scale " + scale + " only " + one.hit + " of " + one.tried + " positions inside the drawn icon selected the piece (" + one.percent.toFixed(1) + "%)");
    }
    if (one.percent < 95) {
      fail("at scale " + scale + " the icon box selects " + one.percent.toFixed(1) + "%, under the 95% floor");
    }
  }

  // A click on the cell CENTRE must always work, whatever the zoom.
  for (const scale of [1, 2, 4, 6, 8, 16, 32]) {
    const view = viewAt(scale);
    const centre = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    const got = pickPieceAt([BLUE_INF], view, centre.x, centre.y, { side: "blue", badgeMinPx: 14 });
    if (!got || got.id !== BLUE_INF.id) fail("the cell centre did not select the piece at scale " + scale);
  }

  // The badge is bigger than its cell at the world fit, so a click ONE CELL OFF the piece, but
  // still on the painted icon, selects it. This is the position PB-050 lost.
  {
    const view = viewAt(4);
    const neighbour = cellToPixel(BLUE_INF.x + 1, BLUE_INF.y, view);
    const got = pickPieceAt([BLUE_INF], view, neighbour.x, neighbour.y, { side: "blue", badgeMinPx: 14 });
    if (!got || got.id !== BLUE_INF.id) fail("a click on the painted icon one cell right of the piece did not select it at the world fit");
    const far = cellToPixel(BLUE_INF.x + 4, BLUE_INF.y, view);
    const missed = pickPieceAt([BLUE_INF], view, far.x, far.y, { side: "blue", badgeMinPx: 14 });
    if (missed) fail("a click four cells away was swallowed by the icon box");
  }

  // ---- AC3: an enemy piece and empty map never select one of yours -------------------------
  {
    const view = viewAt(4);
    const enemy = cellToPixel(RED_INF.x, RED_INF.y, view);
    if (pickPieceAt([BLUE_INF, RED_INF], view, enemy.x, enemy.y, { side: "blue", badgeMinPx: 14 })) {
      fail("a click on an enemy piece selected a blue piece");
    }
    const empty = cellToPixel(200, 100, view);
    if (pickPieceAt([BLUE_INF, RED_INF], view, empty.x, empty.y, { side: "blue", badgeMinPx: 14 })) {
      fail("a click on empty map selected a piece");
    }
    if (pickPieceAt([BLUE_INF], view, enemy.x, enemy.y, { side: "", badgeMinPx: 14 })) {
      fail("a seat with no side selected a piece");
    }
  }

  // ---- AC2: nearest icon centre wins between overlapping badges ----------------------------
  {
    const view = viewAt(4);
    const a = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    const b = cellToPixel(BLUE_NEAR.x, BLUE_NEAR.y, view);
    // Three quarters of the way to the neighbour: inside both boxes, nearer the neighbour.
    const px = a.x + (b.x - a.x) * 0.75;
    const py = a.y + (b.y - a.y) * 0.75;
    const hits = piecesAtPoint([BLUE_INF, BLUE_NEAR], view, px, py, { side: "blue", badgeMinPx: 14 });
    if (hits.length !== 2) fail("the overlapping-badge probe expected two candidate icons, saw " + hits.length);
    const got = pickPieceAt([BLUE_INF, BLUE_NEAR], view, px, py, { side: "blue", badgeMinPx: 14 });
    if (!got || got.id !== BLUE_NEAR.id) fail("an overlapping click did not select the piece whose icon centre is nearest");
    const back = pickPieceAt([BLUE_INF, BLUE_NEAR], view, a.x + (b.x - a.x) * 0.25, py, { side: "blue", badgeMinPx: 14 });
    if (!back || back.id !== BLUE_INF.id) fail("an overlapping click nearer the first piece selected the other one");
  }

  // ---- AC2: the same-cell air/ground stack is defined and cycles ---------------------------
  {
    const view = viewAt(4);
    const centre = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    if (layerOfPiece(BLUE_PLANE) !== "air" || layerOfPiece(BLUE_INF) !== "land") {
      fail("the layer reader does not name air and land for a plane and an infantry");
    }
    const stacked = [{ ...BLUE_INF, x: BLUE_PLANE.x }, BLUE_PLANE];
    const first = pickPieceAt(stacked, view, cellToPixel(BLUE_PLANE.x, BLUE_PLANE.y, view).x,
      cellToPixel(BLUE_PLANE.x, BLUE_PLANE.y, view).y, { side: "blue", badgeMinPx: 14 });
    if (!first || first.id !== BLUE_PLANE.id) fail("the first click on an air/ground stack did not select the air piece");
    const second = pickPieceAt(stacked, view, cellToPixel(BLUE_PLANE.x, BLUE_PLANE.y, view).x,
      cellToPixel(BLUE_PLANE.x, BLUE_PLANE.y, view).y,
      { side: "blue", selectedId: first.id, badgeMinPx: 14 });
    if (!second || second.id !== BLUE_INF.id) fail("a second click on the stack did not reach the ground piece under the plane");
    const third = pickPieceAt(stacked, view, cellToPixel(BLUE_PLANE.x, BLUE_PLANE.y, view).x,
      cellToPixel(BLUE_PLANE.x, BLUE_PLANE.y, view).y,
      { side: "blue", selectedId: second.id, badgeMinPx: 14 });
    if (!third || third.id !== BLUE_PLANE.id) fail("the stack cycle did not wrap back to the air piece");
    // A click inside the stack's icon but off its centre still resolves to the same order.
    const off = pickPieceAt(stacked, view, centre.x + 4, centre.y - 4, { side: "blue", selectedId: first.id, badgeMinPx: 14 });
    if (!off || off.id !== BLUE_INF.id) fail("a click off-centre inside a stack did not continue the cycle");
  }
}
