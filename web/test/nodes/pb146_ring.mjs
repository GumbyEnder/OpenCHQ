// pb146_ring - the reserved selection ring must never cross the selected piece's own cell edge
// (PB-146). With a unit selected, a click anywhere inside an ADJACENT cell is an order to that
// cell, at every reachable zoom; a click inside the piece's own cell is still a re-selection.
//
// What fails if this is removed:
//   - the ring radius alone decides, and since the badge box is wider than its cell past the world
//     fit the ring reaches 0.45-0.60 css over the cell boundary. The near band of the neighbour
//     cell then re-selects the unit: the page says "Click to send the order." and the click sends
//     nothing (measured on the page 2026-11-18, room 7283).
//   - clipping the ring instead of the arm turns an own-cell click outside the radius into an order
//     to the cell the unit already stands on, so the own-cell re-selection (AC2) depends on the
//     radius again.
//   - the T-028/PB-050 badge rule (another own piece's badge wins) must survive: a friend one cell
//     away is still a selection, not a destination.
//
// Units are canvas pixels; every view below is built at dpr 1, where one canvas pixel is one CSS
// pixel. Each assertion prints the view.scale it measured, per AC4.

import { cellToPixel, pixelToCell } from "../../public/render.mjs";
import { badgePx } from "../../public/badges.mjs";
import { clickIntent } from "../../public/command.mjs";

const BOARD_W = 320;
const BOARD_H = 136;
const BLUE_INF = { id: "blue:infantry:1", side: "blue", kind: "infantry", domain: "land", x: 100, y: 70, strength: 100 };
const BLUE_FRIEND = { id: "blue:tank:2", side: "blue", kind: "tank", domain: "land", x: 102, y: 70, strength: 100 };

function viewAt(scale) {
  return { scale, left: 0, top: 0, viewW: BOARD_W * scale, viewH: BOARD_H * scale, boardW: BOARD_W, boardH: BOARD_H };
}

function intentAt(pieces, view, px, py, extra = {}) {
  const cell = extra.cell || pixelToCell(px, py, view);
  return clickIntent(pieces, view, px, py, {
    side: "blue", selectedId: BLUE_INF.id, badgeMinPx: 14, cell, ...extra,
  });
}

// The eight neighbouring cells, as (dx,dy) steps. A click in any of them is a destination.
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function expectedCell(dx, dy) {
  return { x: (BLUE_INF.x + dx + BOARD_W) % BOARD_W, y: BLUE_INF.y + dy };
}

export const name = "pb146_ring";

export function run({ fail }) {
  // ---- AC1: anywhere inside an adjacent cell is an order to that cell -------------------------
  // The probe walks into the neighbour from its near edge (0.05 css past the boundary that the
  // ring used to cross), through 0.25/0.5, the icon centre, and out to the far edge. Every point
  // is inside the adjacent cell by construction, and the destination must be that cell.
  for (const scale of [1, 2, 4, 5, 8]) {
    const view = viewAt(scale);
    const own = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    for (const [dx, dy] of NEIGHBOURS) {
      const want = expectedCell(dx, dy);
      const centre = cellToPixel(want.x, want.y, view);
      // Offsets from the selected icon's centre, in css px, that land inside the neighbour:
      // just past the shared edge, then 0.25/0.5 cells deeper, then the neighbour's own centre.
      const dirX = Math.sign(dx);
      const dirY = Math.sign(dy);
      const edge = scale * 0.5 + 0.05;
      const probes = [
        { x: own.x + dirX * edge, y: own.y + dirY * edge },
        { x: centre.x, y: centre.y },
      ];
      if (dirX) probes.push({ x: own.x + dirX * (scale * 0.5 + scale * 0.25), y: centre.y });
      if (dirY) probes.push({ x: centre.x, y: own.y + dirY * (scale * 0.5 + scale * 0.25) });
      for (const p of probes) {
        const got = intentAt([BLUE_INF], view, p.x, p.y);
        const landed = pixelToCell(p.x, p.y, view);
        if (landed.x !== want.x || landed.y !== want.y) {
          fail("the probe at scale " + scale + " (" + (p.x - own.x).toFixed(2) + "," + (p.y - own.y).toFixed(2)
            + ") is not inside the neighbour cell: the test would measure the wrong frame");
        }
        if (!got || got.kind !== "cell") {
          fail("a click " + (p.x - own.x).toFixed(2) + "," + (p.y - own.y).toFixed(2) + " css inside the neighbour cell ("
            + want.x + "," + want.y + ", view.scale " + scale + ", cell " + scale.toFixed(2) + " css) resolved to "
            + (got ? got.kind : "nothing") + ", not a destination - the reserved ring crossed the cell edge");
        }
        if (got && (got.cell.x !== want.x || got.cell.y !== want.y)) {
          fail("the destination for a click inside cell (" + want.x + "," + want.y + ") at view.scale " + scale
            + " was (" + got.cell.x + "," + got.cell.y + "), not the clicked cell");
        }
      }
    }
  }

  // ---- The two offsets the ticket measured on the page, quoted as they were measured ----------
  // 1440x900: view.scale 4.41 (cell 4.41 css, ring 2.65 css) - +2.65 css east re-selected.
  {
    const scale = 4.41;
    const view = viewAt(scale);
    const own = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    const got = intentAt([BLUE_INF], view, own.x + 2.65, own.y);
    if (!got || got.kind !== "cell" || got.cell.x !== BLUE_INF.x + 1) {
      fail("the reported 1440x900 offset +2.65 css east (view.scale 4.41, cell 4.41 css) resolved to "
        + (got ? got.kind : "nothing") + ", not an order to the next cell");
    }
  }
  // 1919x1112: view.scale 5.91 (cell 5.91 css, ring 3.55 css) - +3.5 css east re-selected while the
  // page said "Click to send the order.".
  {
    const scale = 5.91;
    const view = viewAt(scale);
    const own = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    const got = intentAt([BLUE_INF], view, own.x + 3.5, own.y);
    if (!got || got.kind !== "cell" || got.cell.x !== BLUE_INF.x + 1) {
      fail("the reported 1919x1112 offset +3.5 css east (view.scale 5.91, cell 5.91 css) resolved to "
        + (got ? got.kind : "nothing") + ", not an order to the next cell");
    }
  }

  // ---- AC2: the piece's own cell still re-selects ---------------------------------------------
  // Centre, the four edges just inside the cell, and the corners - the ring's cap intent (a click
  // the pointer rounded short still means "this piece") lives here, inside the cell, and nowhere
  // past it.
  for (const scale of [1, 2, 4, 5, 8]) {
    const view = viewAt(scale);
    const own = cellToPixel(BLUE_INF.x, BLUE_INF.y, view);
    const inner = scale * 0.5 - 0.05;
    const probes = [
      { x: own.x, y: own.y, what: "centre" },
      { x: own.x + inner, y: own.y, what: "+0.5 cell east, inside" },
      { x: own.x - inner, y: own.y, what: "-0.5 cell west, inside" },
      { x: own.x, y: own.y + inner, what: "+0.5 cell south, inside" },
      { x: own.x, y: own.y - inner, what: "-0.5 cell north, inside" },
      { x: own.x + inner, y: own.y + inner, what: "near corner, inside" },
    ];
    for (const p of probes) {
      const cell = pixelToCell(p.x, p.y, view);
      if (cell.x !== BLUE_INF.x || cell.y !== BLUE_INF.y) {
        fail("the own-cell probe " + p.what + " at view.scale " + scale + " fell outside the selected cell");
      }
      const got = intentAt([BLUE_INF], view, p.x, p.y);
      if (!got || got.kind !== "piece" || String(got.piece.id) !== BLUE_INF.id) {
        fail("a click " + p.what + " of the selected piece's own cell at view.scale " + scale + " resolved to "
          + (got ? got.kind : "nothing") + ", not a re-selection");
      }
    }
  }

  // ---- AC2: the badge rule holds - a friend's icon never becomes an order --------------------
  // Exact centre: the click is in the friend's cell, so the selected piece drops out of the
  // candidates and the friend is selected. Anywhere else on the friend's painted badge the answer
  // must still be a selection (the nearer own piece may win - nearest centre is the T-028 rule);
  // what must never happen is a "cell" order. A one-cell friend's overhang is pinned by
  // selection_hit.mjs, which passes the friend's cell explicitly.
  for (const scale of [2, 4, 8]) {
    const view = viewAt(scale);
    const friend = cellToPixel(BLUE_FRIEND.x, BLUE_FRIEND.y, view);
    const half = badgePx(scale, 14) / 2;
    const centre = intentAt([BLUE_INF, BLUE_FRIEND], view, friend.x, friend.y);
    if (!centre || centre.kind !== "piece" || String(centre.piece.id) !== BLUE_FRIEND.id) {
      fail("a click on a friend's icon centre (view.scale " + scale + ") resolved to "
        + (centre ? centre.kind : "nothing") + ", not a selection of that friend");
    }
    for (const [dx, dy] of [[half * 0.9, 0], [-half * 0.9, 0], [0, half * 0.9], [0, -half * 0.9]]) {
      const got = intentAt([BLUE_INF, BLUE_FRIEND], view, friend.x + dx, friend.y + dy);
      if (!got || got.kind !== "piece") {
        fail("a click at (" + dx.toFixed(1) + "," + dy.toFixed(1) + ") on a friend's painted badge (view.scale "
          + scale + ") resolved to " + (got ? got.kind : "nothing") + ", not a selection");
      }
    }
  }

  // ---- AC3: a plain centred click at the fit is unchanged ------------------------------------
  // At the world fit (view.scale 4.4124) the neighbour centre was already a destination before this
  // ticket: the ring (2.65 css) never reached 4.41. This pins that the fit resolution did not move.
  for (const [dx, dy] of NEIGHBOURS) {
    const scale = 4.4124;
    const view = viewAt(scale);
    const want = expectedCell(dx, dy);
    const centre = cellToPixel(want.x, want.y, view);
    const got = intentAt([BLUE_INF], view, centre.x, centre.y);
    if (!got || got.kind !== "cell" || got.cell.x !== want.x || got.cell.y !== want.y) {
      fail("a centred click on the neighbour cell (" + want.x + "," + want.y + ") at the fit view.scale 4.4124 "
        + "resolved to " + (got ? got.kind : "nothing") + ", not that cell - the fit behaviour moved");
    }
  }
}
