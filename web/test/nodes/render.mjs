// Pure-helper tests for the match painter (node id: board_paint, module: render).
// No DOM here: render.mjs is driven with a recording 2d context, so every
// assertion is maths or payload logic. What a browser alone can prove is listed
// at the bottom of this file for the report.
import {
  BOARD_W,
  BOARD_H,
  PIECE_INK,
  capitalMarkers,
  cellToPixel,
  fitViewport,
  focusLeft,
  legendEntries,
  makeView,
  paintMatch,
  paintPiece,
  paletteFor,
  pixelToCell,
  pieceShape,
  statusLine,
  tileLefts,
  sightTable,
  rememberSeen,
  centerOn,
  clampZoom,
  panBy,
  zoomAt,
  paintFog,
  MIN_ZOOM,
  MAX_ZOOM,
  visibleColumns,
  visibleRows,
  wrapDelta,
  wrapX,
} from "../../public/render.mjs";
import { cargoNote } from "../../public/command.mjs";
import { EXTRACT_MISSING, PALETTE, SCHEMATIC } from "../../public/paint.mjs";

function recorder() {
  const fills = [];
  const texts = [];
  const ops = [];
  const ctx = {
    _fill: "",
    _stroke: "",
    lineWidth: 1,
    font: "",
    set fillStyle(value) {
      this._fill = value;
    },
    get fillStyle() {
      return this._fill;
    },
    set strokeStyle(value) {
      this._stroke = value;
    },
    get strokeStyle() {
      return this._stroke;
    },
    fillRect(x, y, w, h) {
      fills.push({ x, y, w, h, color: this._fill });
    },
    clearRect() {},
    beginPath() {
      ops.push({ op: "begin" });
    },
    arc(x, y, r) {
      ops.push({ op: "arc", x, y, r, color: this._fill });
    },
    moveTo(x, y) {
      ops.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      ops.push({ op: "lineTo", x, y });
    },
    closePath() {
      ops.push({ op: "close" });
    },
    rect(x, y, w, h) {
      ops.push({ op: "rect", x, y, w, h, color: this._fill });
    },
    fill() {
      ops.push({ op: "fill", color: this._fill });
    },
    stroke() {
      ops.push({ op: "stroke", color: this._stroke });
    },
    fillText(text, x, y) {
      texts.push({ text, x, y, color: this._fill });
    },
  };
  return { ctx, fills, texts, ops };
}

function eq(fail, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

function ok(fail, label, value) {
  if (!value) fail(label);
}

export const name = "board_paint";

export async function run(ctx) {
  const { base, fail } = ctx;

  // --- the geometry the page stands on ---------------------------------------
  const full = fitViewport(640, 272);
  eq(fail, "fit 640x272", [full.scale, full.left, full.top, full.viewW, full.viewH], [2, 0, 0, 640, 272]);
  const small = fitViewport(300, 200);
  eq(fail, "fit 300x200", [small.scale, small.left, small.top], [1, -10, 32]);
  eq(fail, "fit never goes to zero scale", fitViewport(10, 10).scale, 1);
  const capped = fitViewport(2000, 2000, 320, 136, 3);
  eq(fail, "fit honours the scale cap", capped.scale, 3);

  // cell -> pixel is the cell center; the seam is ordinary arithmetic.
  eq(fail, "cell 0,0 center at scale 2", cellToPixel(0, 0, full), { x: 1, y: 1 });
  eq(fail, "cell 319,135 center at scale 2", cellToPixel(319, 135, full), { x: 639, y: 271 });
  eq(fail, "cell 79,44 center at scale 2", cellToPixel(79, 44, full), { x: 159, y: 89 });
  eq(fail, "pixel 1,1 back to cell", pixelToCell(1, 1, full), { x: 0, y: 0 });
  eq(fail, "pixel 639,271 back to cell", pixelToCell(639, 271, full), { x: 319, y: 135 });

  // --- X wraps, Y does not ---------------------------------------------------
  eq(fail, "wrapX(-1)", wrapX(-1), 319);
  eq(fail, "wrapX(320)", wrapX(320), 0);
  eq(fail, "wrapX(321)", wrapX(321), 1);
  eq(fail, "wrapDelta 319->0 is one step east", wrapDelta(319, 0), 1);
  eq(fail, "wrapDelta 0->319 is one step west", wrapDelta(0, 319), -1);
  eq(fail, "wrapDelta straight across", wrapDelta(10, 30), 20);

  // --- viewport fitting and wrap-around centring ------------------------------
  const camera = makeView({ scale: 2, viewW: 200, viewH: 200, boardW: 320, boardH: 136 });
  eq(fail, "wrapped view width", camera.viewW, 200);
  const leftAtZero = focusLeft(0, camera);
  eq(fail, "focus on column 0 puts it mid-view", leftAtZero, 99);
  eq(fail, "focus pixel is the center", cellToPixel(0, 0, { ...camera, left: leftAtZero }).x, 100);
  const seamLeft = focusLeft(319, camera);
  eq(fail, "focus on the seam column", seamLeft, -539);
  eq(fail, "seam column sits mid-view too", cellToPixel(319, 0, { ...camera, left: seamLeft }).x, 100);
  eq(fail, "tiles needed at the seam", tileLefts(seamLeft, 640, 200), [-539, 101]);
  const tiles = tileLefts(-25, 640, 1300);
  ok(fail, "tiles never start after the viewport", tiles[0] <= 0);
  ok(fail, "tiles cover the viewport", tiles[tiles.length - 1] + 640 >= 1300);
  for (let i = 1; i < tiles.length; i++) {
    eq(fail, "tiles are flush, no gap", tiles[i], tiles[i - 1] + 640);
  }

  // --- what is on screen ------------------------------------------------------
  eq(fail, "columns at scale 2, unpanned", visibleColumns(full), { first: 0, last: 319 });
  eq(fail, "rows at scale 2, unpanned", visibleRows(full), { first: 0, last: 135 });
  eq(fail, "columns panned left of zero", visibleColumns(makeView({ scale: 1, left: -10, viewW: 300 })), { first: 10, last: 309 });
  eq(fail, "rows clamp at the bottom", visibleRows(makeView({ scale: 1, top: -100, viewH: 300, boardH: 136 })), { first: 100, last: 135 });

  // --- palette ---------------------------------------------------------------
  for (const name of ["ocean", "shallows", "city", "capital"]) {
    eq(fail, "palette " + name, paletteFor(name), PALETTE[name]);
  }
  const four = ["ocean", "shallows", "city", "capital"].map((n) => paletteFor(n));
  eq(fail, "ocean, shallows, city and capital are distinct", new Set(four).size, 4);
  eq(fail, "unknown terrain stays unnamed", paletteFor("nonsense"), null);
  const legend = legendEntries();
  eq(fail, "legend names the marks, transport included", legend.length, 7);
  eq(fail, "the legend names a transport", legend[6].label, "transport (cargo)");
  eq(fail, "legend carries both side colors", [legend[4].color, legend[5].color], [SCHEMATIC.blue, SCHEMATIC.red]);

  // --- a transport is a ring, and the page says what that means --------------
  eq(fail, "a land piece at sea is a ring", pieceShape({ domain: "land", transport: true }), "ring");
  eq(fail, "a land piece on land is a square", pieceShape({ domain: "land" }), "square");
  eq(fail, "cargo is explained", /cannot fight back/.test(cargoNote({ transport: true })), true);
  eq(fail, "a land piece is not cargo", cargoNote({ transport: false }), "");

  // --- capitals --------------------------------------------------------------
  const fallbackCaps = capitalMarkers(null);
  eq(fail, "fallback capitals", fallbackCaps.map((c) => [c.name, c.x, c.y]), [["Washington", 79, 44], ["Moscow", 183, 25]]);
  eq(fail, "capital colors", fallbackCaps.map((c) => c.color), [SCHEMATIC.blue, SCHEMATIC.red]);
  const renamed = capitalMarkers({ capitals: { blue: { name: "Washington", x: 79, y: 44 }, red: { name: "Moscow", x: 183, y: 25 } } });
  eq(fail, "capital names survive the payload", renamed.map((c) => c.name), ["Washington", "Moscow"]);

  // --- a piece carries its side, its shape and its owner's outline -----------
  const sea = recorder();
  paintPiece(sea.ctx, { side: "blue", domain: "sea", x: 0, y: 15 }, full, { own: "blue" });
  const arc = sea.ops.find((op) => op.op === "arc");
  ok(fail, "a sea piece is a disc", arc);
  eq(fail, "a blue piece is blue", arc.color, SCHEMATIC.blue);
  eq(fail, "an own piece gets a white outline", sea.ops.find((op) => op.op === "stroke").color, PIECE_INK.own);
  const enemy = recorder();
  paintPiece(enemy.ctx, { side: "red", domain: "land", kind: null, x: 183, y: 25 }, full, { own: "blue" });
  const box = enemy.ops.find((op) => op.op === "rect");
  ok(fail, "a land piece is a square", box);
  eq(fail, "a red piece is red", box.color, SCHEMATIC.red);
  eq(fail, "an enemy piece gets a dark outline", enemy.ops.find((op) => op.op === "stroke").color, PIECE_INK.enemy);
  eq(fail, "a square piece is centered on its cell", [box.x + box.w / 2, box.y + box.h / 2], [367, 51]);

  // --- the real payload paints, with pieces and both capitals ----------------
  const res = await fetch(base + "/api/board");
  if (res.status !== 200) fail("board status " + res.status);
  const board = await res.json();
  if (board.source !== "extract") fail("this host has no extract, got source " + board.source);
  if (board.width !== BOARD_W || board.height !== BOARD_H) fail("board size " + board.width + "x" + board.height);

  const room = {
    era: "1986",
    round: 0,
    clock: "held",
    you: "blue",
    pieces: [
      { id: "blue:land", side: "blue", domain: "land", kind: null, x: 79, y: 44 },
      { id: "blue:sea", side: "blue", domain: "sea", kind: null, x: 0, y: 15 },
      { id: "red:land", side: "red", domain: "land", kind: null, x: 183, y: 25 },
      { id: "red:sea", side: "red", domain: "sea", kind: null, x: 300, y: 70 },
    ],
  };

  const painted = recorder();
  const result = paintMatch(painted.ctx, board, room, { view: full, own: "blue" });
  eq(fail, "real board paints as cells", result.mode, "cells");
  ok(fail, "real board paints most of its cells", result.painted > BOARD_W * BOARD_H * 0.5);
  eq(fail, "all four opening pieces are drawn", result.pieces, 4);
  eq(fail, "both capitals are marked", result.capitals, 2);
  ok(fail, "Washington is labelled", painted.texts.some((t) => t.text === "Washington"));
  ok(fail, "Moscow is labelled", painted.texts.some((t) => t.text === "Moscow"));
  const labels = painted.texts.map((t) => t.text);
  eq(fail, "no third capital is labelled", labels.length, 2);

  // distinct colors for ocean, shallows, city and capital, at their own cells
  const seen = [];
  for (const [terrain, id] of [["ocean", 0], ["shallows", 2], ["city", 6], ["capital", 4]]) {
    const index = board.cells.indexOf(id);
    if (index < 0) fail("board has no " + terrain + " cell");
    const x = index % BOARD_W;
    const y = Math.floor(index / BOARD_W);
    const fill = painted.fills.find((f) => f.x === x * 2 && f.y === y * 2);
    if (!fill) fail("the grid skipped " + terrain + " at " + x + "," + y);
    if (fill.color !== PALETTE[terrain]) fail(terrain + " painted as " + fill.color);
    seen.push(fill.color);
  }
  eq(fail, "grid colors are distinct", new Set(seen).size, 4);

  // pieces are on the grid: each side's mark lands on its own cell center
  const blueMarkAt = painted.ops.find((op) => op.op === "rect" && op.color === SCHEMATIC.blue &&
    op.x + op.w / 2 === 159 && op.y + op.h / 2 === 89);
  ok(fail, "the blue land piece is drawn on Washington", blueMarkAt);
  const redMarkAt = painted.ops.find((op) => op.op === "arc" && op.color === SCHEMATIC.red &&
    op.x === 601 && op.y === 141);
  ok(fail, "the red sea piece is drawn on its ocean cell", redMarkAt);

  // enemy pieces are only the ones sent: dropping them changes the count
  const oneSide = recorder();
  const fewer = paintMatch(oneSide.ctx, board, { ...room, pieces: room.pieces.filter((p) => p.side === "blue") }, { view: full, own: "blue" });
  eq(fail, "the painter draws exactly what the view sent", fewer.pieces, 2);

  // --- the hosted fallback: schematic plus every piece still on the map ------
  const missing = { source: "missing", cells: null, width: BOARD_W, height: BOARD_H, capitals: null, terrain: [] };
  const fallback = recorder();
  const schematic = paintMatch(fallback.ctx, missing, room, { view: full, own: "blue" });
  eq(fail, "a missing extract falls back", schematic.mode, "schematic");
  eq(fail, "the fallback says so", schematic.message, EXTRACT_MISSING);
  eq(fail, "pieces still draw on the schematic", schematic.pieces, 4);
  ok(fail, "the schematic still labels Washington", fallback.texts.some((t) => t.text === "Washington"));
  ok(fail, "the schematic still labels Moscow", fallback.texts.some((t) => t.text === "Moscow"));
  const blueMark = fallback.fills.find((f) => f.x === 79 * 2 && f.y === 44 * 2);
  if (!blueMark || blueMark.color !== SCHEMATIC.blue) fail("schematic does not mark Washington in blue");
  const schematicColors = new Set([...Object.values(PALETTE), ...Object.values(SCHEMATIC)]);
  for (const fill of fallback.fills) {
    if (!schematicColors.has(fill.color)) fail("the schematic invented a color " + fill.color);
  }
  eq(fail, "an unknown board is the schematic too", paintMatch(recorder().ctx, null, room, { view: full }).mode, "schematic");

  // --- the line under the canvas --------------------------------------------
  ok(fail, "missing extract note", statusLine(missing, room, schematic) === EXTRACT_MISSING);
  const line = statusLine(board, room, result);
  ok(fail, "grid note names the extract", line.includes("map extract"));
  ok(fail, "grid note counts the pieces", line.includes("4 pieces"));
  ok(fail, "grid note shows the round", line.includes("round 0"));

  // ---- fog: the sight rule must be drawable, not implied -------------------------------
  // A cell table from the seat's own pieces, Chebyshev with the X wrap - the same rule the
  // server applied when it decided which enemy pieces to send.
  const fogBoard = { width: 320, height: 136, cells: null };
  const lit = sightTable(fogBoard, [{ x: 79, y: 44 }], 8);
  if (lit.length !== 320 * 136) fail("the sight table is not one entry per cell");
  if (lit[44 * 320 + 79] !== 1) fail("a piece's own cell is not lit");
  if (lit[44 * 320 + 87] !== 1) fail("a cell 8 away is not lit");
  if (lit[44 * 320 + 88] !== 0) fail("a cell 9 away is lit, which breaks the radius");
  if (lit[36 * 320 + 79] !== 1 || lit[35 * 320 + 79] !== 0) fail("the radius is not Chebyshev vertically");
  if (lit[0 * 320 + 79] !== 0) fail("sight wrapped in Y, which it must not");
  const seam = sightTable(fogBoard, [{ x: 0, y: 70 }], 8);
  if (seam[70 * 320 + 319] !== 1) fail("sight does not wrap across the seam (319 is one step west of 0)");
  if (seam[70 * 320 + 8] !== 1 || seam[70 * 320 + 9] !== 0) fail("the wrapped radius is the wrong size");

  // Memory: what was once lit stays remembered; what was never lit stays unknown.
  const fogSeen = rememberSeen(null, lit);
  if (fogSeen[44 * 320 + 79] !== 1) fail("a lit cell was not remembered");
  const later = sightTable(fogBoard, [{ x: 150, y: 44 }], 8);
  const remembered = rememberSeen(fogSeen, later);
  if (remembered[44 * 320 + 79] !== 1) fail("a remembered cell was forgotten");
  if (remembered[44 * 320 + 150] !== 1) fail("the new sight did not enter memory");

  // The two darkness levels are different: remembered ground is lighter than unknown ground.
  const view = makeView({ scale: 4, viewW: 320 * 4, viewH: 136 * 4 });
  const rec = recorder();
  const fogged = paintFog(rec.ctx, view, later, remembered);
  const styles = new Set(rec.fills.map((fill) => fill.color));
  if (fogged <= 0) fail("nothing was fogged");
  if (!styles.has("rgba(6, 12, 22, 0.45)")) fail("remembered ground is not drawn at its own level: " + [...styles].join(","));
  if (!styles.has("rgba(4, 8, 15, 0.82)")) fail("unknown ground is not drawn at its own level");
  if (styles.size < 2) fail("fog uses one level for everything, so memory is invisible");

  // ---- camera: 2x is unreadable, so zoom is whole cells and pan may cross the seam -----
  if (clampZoom(1) !== MIN_ZOOM) fail("the camera zoomed below the readable floor");
  if (clampZoom(99) !== MAX_ZOOM) fail("the camera zoomed past its ceiling");
  const fit = makeView({ scale: 2, left: 0, top: 0, viewW: 640, viewH: 272 });
  const centred = centerOn({ x: 79, y: 44 }, fit);
  if (centred.scale !== 2) fail("centring changed the zoom");
  const worldX = centred.left + (79 + 0.5) * centred.scale;
  if (Math.abs(worldX - centred.viewW / 2) > centred.scale) fail("the cell is not centred: " + worldX);
  const zoomed = zoomAt(fit, 2, 100, 100);
  if (zoomed.scale !== 4) fail("a zoom step did not double the scale: " + zoomed.scale);
  const beforeX = (100 - fit.left) / fit.scale;
  const afterX = (100 - zoomed.left) / zoomed.scale;
  if (Math.abs(beforeX - afterX) > 0.51) fail("zoom did not keep the cell under the cursor");
  const panned = panBy(fit, -37, 12);
  if (panned.left !== -37 || panned.top !== 12) fail("pan is not a whole-pixel shift");
  if (panned.scale !== fit.scale) fail("panning changed the zoom");
}

// A browser-only change cannot be proved here: that the served app.js imports
// render.mjs without error, that the socket's room pieces redraw on every
// "room" message, that the canvas is 640x272 CSS-scaled crisply, and that the
// legend DOM picks up the palette. Those need a real page; the harness above
// only proves the maths and the payload logic behind them.
