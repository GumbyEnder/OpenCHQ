// Node unit_icons: what the original actually drew for a unit on the board.
//
// The node was written expecting per-type sprites cut from UNITS.PIC. Measuring the shipped screen
// says otherwise: docs/chq-reference/chq_0021.png is a 640x400 capture of the 320x200 game, so two
// screen pixels per cell, and every unit marker in it is a 6x6 block — three cells at map scale — in
// the side's dark colour with one light pixel at its centre. Identical for every unit type: the
// original told units apart in its panels, not on the map. So the marker is a measured block, and
// these assertions pin it.
import { BOARD_W, MARKER_ZOOM, PIECE_MARKER, markerCells, pieceShape } from "../../public/render.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}

export const name = "unit_icons";

export async function run() {
  eq("the marker is three cells across", PIECE_MARKER.size, 3);
  eq("the blue body is the capture's dark blue", PIECE_MARKER.body.blue, "#0000aa");
  eq("the red body is the capture's dark red", PIECE_MARKER.body.red, "#aa0000");
  eq("the centre pixel is the capture's light pixel", PIECE_MARKER.centre, "#ffffff");
  eq("shapes take over above the marker zoom", MARKER_ZOOM, 4);

  // --- nine cells, three by three, one centre ----------------------------------------------
  const blue = markerCells(100, 60, "blue");
  eq("a marker is nine cells", blue.length, 9);
  const xs = blue.map((c) => c.dx);
  const ys = blue.map((c) => c.dy);
  eq("it is three cells wide", Math.max(...xs) - Math.min(...xs) + 1, 3);
  eq("it is three cells tall", Math.max(...ys) - Math.min(...ys) + 1, 3);
  eq("exactly one cell is the centre", blue.filter((c) => c.centre).length, 1);

  const centre = blue.find((c) => c.centre);
  eq("the centre sits on the piece", centre.x + "," + centre.y, "100,60");
  eq("the centre is the light pixel", centre.colour, "#ffffff");
  const body = blue.filter((c) => !c.centre);
  eq("eight cells carry the side's body colour", new Set(body.map((c) => c.colour)).size, 1);
  eq("the body colour is the side's", body[0].colour, "#0000aa");

  // --- the two sides are different markers -------------------------------------------------
  const red = markerCells(100, 60, "red");
  eq("red is the same nine cells", red.length, blue.length);
  eq("red carries red", red.filter((c) => !c.centre)[0].colour, "#aa0000");
  if (red.filter((c) => !c.centre)[0].colour === body[0].colour) fail("both sides draw the same body");

  // --- the seam ----------------------------------------------------------------------------
  const seam = markerCells(0, 10, "blue");
  const seamXs = seam.map((c) => c.x).sort((a, b) => a - b);
  eq("a marker on the seam column still has nine cells", seam.length, 9);
  eq("the seam marker keeps its own column", seamXs.filter((x) => x === 0).length, 3);
  eq("the seam marker wraps into the last column", seamXs.filter((x) => x === BOARD_W - 1).length, 3);
  for (const cell of seam) {
    if (cell.x < 0 || cell.x >= BOARD_W) fail("a wrapped marker cell left the board at " + cell.x);
  }

  // --- zoom decides who draws --------------------------------------------------------------
  eq("a transport is still a ring when zoomed in", pieceShape({ domain: "land", transport: true }), "ring");
  const far = markerCells(5, 5, "blue");
  for (const cell of far) {
    if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)) fail("a marker cell is not a number");
  }
}
