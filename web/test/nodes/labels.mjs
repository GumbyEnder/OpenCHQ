// Node city_labels: the names the board shows once you are close enough to read them.
//
// The original kept place names in its panels; labels on the map are this page's addition. Three
// rules make them behave: nothing below LABEL_ZOOM pixels per cell, nothing for a city off screen,
// and nothing that would run off an edge. They are drawn from the decoded FONTS.CHQ atlas, so with
// no atlas the board says nothing rather than inventing a second font.
import { LABEL_ZOOM, fitViewport, paintLabels, paintMatch, visibleLabels } from "../../public/render.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}

const SITES = [
  { id: "washington", name: "Washington", x: 79, y: 44, owner: "blue" },
  { id: "moscow", name: "Moscow", x: 183, y: 25, owner: "red" },
  { id: "seam", name: "Seam", x: 0, y: 60, owner: null },
  { id: "noname", x: 100, y: 100 },
];

function recorder() {
  const fills = [];
  // Enough of a 2d context for paintMatch: the full painter is exercised in board_paint, here we
  // only care that labels reach the frame.
  const noop = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1,
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this.fillStyle }); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, save: noop, restore: noop, fillText: noop,
    setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, fills };
}

export const name = "city_labels";

export async function run() {
  eq("labels start at eight pixels per cell", LABEL_ZOOM, 8);

  // --- nothing at map scale ---------------------------------------------------------------
  const world = fitViewport(640, 272); // whole earth, ~2 px per cell
  if (world.scale >= LABEL_ZOOM) fail("the whole-world fit is not below the label zoom");
  eq("a whole-earth view carries no city labels", visibleLabels(SITES, world).length, 0);

  // --- names at zoom ----------------------------------------------------------------------
  // A window big enough for the world at eight pixels per cell, so Washington and Moscow are on it.
  const zoomed = { ...world, scale: 8, left: 0, top: 0, viewW: 2560, viewH: 1088 };
  const labels = visibleLabels(SITES, zoomed);
  const named = labels.map((label) => label.text);
  if (!named.includes("Washington")) fail("Washington is not labelled at zoom: " + named.join(","));
  if (named.includes(undefined)) fail("a label has no text");
  eq("a site with no name is not labelled", labels.filter((l) => !l.text).length, 0);
  eq("one label per city", labels.length, new Set(labels.map((l) => l.cell.x + ":" + l.cell.y)).size);

  const washington = labels.find((label) => label.text === "Washington");
  eq("the label knows its city", washington.cell.x + "," + washington.cell.y, "79,44");
  eq("the label scale is whole pixels", washington.scale, Math.floor(zoomed.scale / LABEL_ZOOM));
  eq("the label width is one atlas cell per character", washington.width, "Washington".length * 8 * washington.scale);

  // --- a label stays inside the view ------------------------------------------------------
  for (const label of labels) {
    if (label.x < 0 || label.y < 0) fail(label.text + " starts outside the view");
    if (label.x + label.width > zoomed.viewW) fail(label.text + " runs off the right edge");
    if (label.y + label.height > zoomed.viewH) fail(label.text + " runs off the bottom");
  }

  // --- a city off screen is not labelled --------------------------------------------------
  const elsewhere = { ...zoomed, left: -2000, top: -2000 };
  eq("cities the camera cannot see are not labelled", visibleLabels(SITES, elsewhere).length, 0);

  // --- drawing needs the original's atlas -------------------------------------------------
  const blank = recorder();
  eq("no atlas, nothing drawn", paintLabels(blank.ctx, null, labels), 0);
  eq("no atlas, no pixels", blank.fills.length, 0);

  const atlas = {
    source: "extract",
    _meta: { count: 2, first: 32, last: 33 },
    glyphs: [
      { code: 32, rows: [0, 0, 0, 0, 0, 0] },
      { code: 65, rows: [0b01110000, 0b10001000, 0b11111000, 0b10001000, 0b10001000, 0] },
    ],
  };
  const one = visibleLabels([{ name: "AA", x: 79, y: 44 }], zoomed);
  eq("the atlas test has one label", one.length, 1);
  const painted = recorder();
  const drawn = paintLabels(painted.ctx, atlas, one);
  eq("a label is drawn once", drawn, 1);
  if (painted.fills.length === 0) fail("the label drew no pixels");
  // Each set pixel is drawn twice: a shadow one pixel down-right, then the ink on top.
  eq("every pixel gets a shadow and an ink", painted.fills.length % 2, 0);
  eq("ink and shadow alternate", painted.fills[0].color === painted.fills[1].color, false);

  // --- and paintMatch draws them in a real frame -------------------------------------------
  const board = { source: "extract", width: 320, height: 136, terrain: ["ocean"], cells: new Array(320 * 136).fill(0) };
  const room = { sites: SITES, pieces: [], routes: {} };
  const frame = recorder();
  frame.ctx.clearRect = () => {};
  const withLabels = paintMatch(frame.ctx, board, room, { view: zoomed, atlas });
  if (!withLabels.labels) fail("paintMatch drew no labels at zoom");
  const noAtlas = recorder();
  noAtlas.ctx.clearRect = () => {};
  const without = paintMatch(noAtlas.ctx, board, room, { view: zoomed, atlas: null });
  eq("without an atlas paintMatch labels nothing", without.labels, 0);
  const worldFrame = recorder();
  worldFrame.ctx.clearRect = () => {};
  const fitted = paintMatch(worldFrame.ctx, board, room, { view: world, atlas });
  eq("the whole-earth fit labels nothing", fitted.labels, 0);

  const empty = recorder();
  eq("an empty label list draws nothing", paintLabels(empty.ctx, atlas, []), 0);
  eq("an empty board labels nothing", visibleLabels([], zoomed).length, 0);
  eq("no view, no labels", visibleLabels(SITES, null).length, 0);
}
