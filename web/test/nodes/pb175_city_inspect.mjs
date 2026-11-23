// pb175_city_inspect - a city with a unit on it can be inspected at the world fit (PB-175).
//
// What fails if this is removed:
//   - a second click on the selected unit's own cell returns nothing the page can read as a site ->
//     the cycle is gone and the city under a garrison is uninspectable again (PB-175 as filed: at
//     the world fit the badge is 14 px over 4.41 px cells, so every click on the city resolved to
//     the piece and PB-163's site line, which only ran when nothing was selected, never appeared)
//   - the site lookup keys on the badge box instead of the piece's own cell -> a click one cell
//     away returns the city, so a move order off a garrisoned city would be swallowed (PB-146)
//   - the lookup forgets wrapX on the piece's x -> a unit standing over the world seam is never
//     inspectable, because the click's cell is wrapped and the piece's x is not
//
// The precedence rule the page runs is in web/public/app.js: click 1 selects the unit, click 2 on
// that same cell says siteInspectText and keeps the unit selected. This leg binds the two halves the
// page's branch depends on: clickIntent's answer (which piece the click resolved to) and
// siteUnderPiece's answer (whether that piece's cell is a site).
import { cellToPixel, pixelToCell } from "../../public/render.mjs";
import { clickIntent, siteInspectText, siteUnderPiece } from "../../public/command.mjs";

const BOARD_W = 320;
const BOARD_H = 136;

// The world fit this ticket was filed at (PB-050's own number: 14 px badge over 4.4124 px cells).
const FIT = 4.4124;

function viewAt(scale) {
  return {
    scale, left: 0, top: 0, viewW: BOARD_W * scale, viewH: BOARD_H * scale,
    boardW: BOARD_W, boardH: BOARD_H,
  };
}

const CITY = { id: 23, name: "Detroit", kind: "city", owner: "blue", x: 79, y: 44, type: 3 };
const GARRISON = { id: "blue:infantry:1", side: "blue", kind: "infantry", domain: "land", x: 79, y: 44, strength: 100 };
const SEAM_GARRISON = { ...GARRISON, id: "blue:infantry:2", x: BOARD_W + 7, y: 44 };
const NEIGHBOUR_SITE = { id: 24, name: "Chicago", kind: "city", owner: "blue", x: 80, y: 44, type: 3 };

function clickAt(piece, cell, scale, selectedId) {
  const view = viewAt(scale);
  const centre = cellToPixel(cell.x, cell.y, view);
  const intent = clickIntent([piece], view, centre.x, centre.y, {
    side: "blue", selectedId, badgeMinPx: 14, cell,
  });
  return { intent, cell, view };
}

export const name = "pb175_city_inspect";

export function run({ fail }) {
  // ---- 1. the lookup itself ---------------------------------------------------------------
  if (siteUnderPiece([CITY], GARRISON, { x: 79, y: 44 }, BOARD_W) !== CITY) {
    fail("a garrison on a city cell does not resolve to that city");
  }
  if (siteUnderPiece([CITY, NEIGHBOUR_SITE], GARRISON, { x: 80, y: 44 }, BOARD_W) !== null) {
    fail("a click on a neighbouring cell that holds another city resolved to a site for a piece that is not standing there");
  }
  if (siteUnderPiece([CITY], GARRISON, { x: 80, y: 44 }, BOARD_W) !== null) {
    fail("a click one cell off the piece returned a city: a move order off a garrisoned city would be swallowed (PB-146)");
  }
  if (siteUnderPiece([CITY], GARRISON, { x: 79, y: 45 }, BOARD_W) !== null) {
    fail("a click one row off the piece returned a city");
  }
  const seam = siteUnderPiece([{ ...CITY, x: 7 }], SEAM_GARRISON, { x: 7, y: 44 }, BOARD_W);
  if (!seam) {
    fail("a unit whose x is past the board width (wrapped cell 7) did not resolve to the site: wrapX is missing from the lookup");
  }
  if (siteUnderPiece([CITY], null, { x: 79, y: 44 }, BOARD_W) !== null
    || siteUnderPiece([CITY], GARRISON, null, BOARD_W) !== null) {
    fail("the lookup answered for a missing piece or a missing cell");
  }
  if (siteUnderPiece([CITY], GARRISON, { x: 79, y: 44 }, undefined) !== CITY) {
    fail("the lookup did not fall back to 320 columns when the board width is absent");
  }

  // ---- 2. click 1 selects the unit at the world fit (the cycle's first half) ---------------
  const first = clickAt(GARRISON, { x: 79, y: 44 }, FIT, null);
  if (!first.intent || first.intent.kind !== "piece"
    || String(first.intent.piece.id) !== String(GARRISON.id)) {
    fail("the first click on a garrisoned city at the world fit did not select the unit: "
      + JSON.stringify(first.intent && first.intent.kind));
  }

  // ---- 3. click 2 on the same cell resolves to the SAME piece, and the cell is the city -----
  const second = clickAt(GARRISON, { x: 79, y: 44 }, FIT, GARRISON.id);
  if (!second.intent || String(second.intent.piece.id) !== String(GARRISON.id)) {
    fail("the second click on the same cell did not resolve to the already-selected piece, so the page's cycle branch cannot fire");
  }
  const site = siteUnderPiece([CITY], second.intent.piece, second.cell, second.view.boardW);
  if (site !== CITY) {
    fail("the second click's cell did not read as the city it stands on");
  }

  // ---- 4. the sentence the cycle prints is the site line, not the selection toast -----------
  const ready = siteInspectText(CITY, 0);
  if (ready !== "Detroit — city, blue. Ready.") {
    fail("a ready city's inspect line changed: " + JSON.stringify(ready));
  }
  const unready = siteInspectText({ ...CITY, readyRound: 12 }, 3);
  if (!/Unready — ready at round 12/.test(unready)) {
    fail("the cycle would print a sentence without the ready round: " + JSON.stringify(unready));
  }

  // ---- 5. the regression arm: a neighbour cell is a destination, not an inspect -------------
  const neighbour = clickAt(GARRISON, { x: 80, y: 44 }, FIT, GARRISON.id);
  if (!neighbour.intent || neighbour.intent.kind !== "cell") {
    fail("a click one cell away from the selected unit is no longer a move order (kind "
      + JSON.stringify(neighbour.intent && neighbour.intent.kind) + ")");
  }
  if (siteUnderPiece([CITY, NEIGHBOUR_SITE], neighbour.intent.piece, neighbour.cell, BOARD_W) !== null) {
    fail("the neighbour click read as a site: the move order would be eaten by the inspect branch");
  }

  // ---- 6. and the click's cell is the cell clickIntent saw (no half-cell drift) --------------
  const roundTrip = pixelToCell(cellToPixel(79, 44, viewAt(FIT)).x, cellToPixel(79, 44, viewAt(FIT)).y, viewAt(FIT));
  if (roundTrip.x !== 79 || roundTrip.y !== 44) {
    fail("the world-fit cell centre does not round-trip to its own cell");
  }
}
