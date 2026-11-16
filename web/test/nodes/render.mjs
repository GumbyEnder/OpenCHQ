// Pure-helper tests for the match painter (node id: board_paint, module: render).
// No DOM here: render.mjs is driven with a recording 2d context, so every
// assertion is maths or payload logic. What a browser alone can prove is listed
// at the bottom of this file for the report.
import {
  BOARD_W,
  BOARD_H,
  PIECE_INK,
  PIECE_MARKER,
  CAPITAL_NEUTRAL,
  OWNERSHIP,
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
  FOG_REMEMBERED,
  FOG_UNKNOWN,
  MIN_ZOOM,
  MAX_ZOOM,
  visibleColumns,
  visibleRows,
  wrapDelta,
  wrapX,
} from "../../public/render.mjs";
import { airNote, cargoNote } from "../../public/command.mjs";
import { BADGE_INTERIOR, BADGE_SIDE } from "../../public/badges.mjs";
import { EXTRACT_MISSING, PALETTE, SCHEMATIC } from "../../public/paint.mjs";

function recorder() {
  const fills = [];
  const texts = [];
  const ops = [];
  // One ordered log across fillRect and path fills, so a test can assert that the ownership fill
  // was drawn BEFORE a badge rather than merely that both were drawn somewhere.
  const seq = [];
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
      seq.push({ kind: "rect", x, y, w, h, color: this._fill });
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
      seq.push({ kind: "fill", color: this._fill });
    },
    stroke() {
      ops.push({ op: "stroke", color: this._stroke });
    },
    fillText(text, x, y) {
      texts.push({ text, x, y, color: this._fill });
    },
  };
  return { ctx, fills, texts, ops, seq };
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
  eq(fail, "legend names the ground and the marks, transport included", legend.length, 12);
  eq(fail, "the legend names plain ground", legend[2].label, "plain");
  eq(fail, "the legend names a transport", legend[11].label, "transport (cargo)");
  eq(fail, "legend carries both side colors", [legend[9].color, legend[10].color], [SCHEMATIC.blue, SCHEMATIC.red]);

  // --- a transport is a ring, and the page says what that means --------------
  eq(fail, "a land piece at sea is a ring", pieceShape({ domain: "land", transport: true }), "ring");
  eq(fail, "a land piece on land is a square", pieceShape({ domain: "land" }), "square");
  eq(fail, "cargo is explained", /cannot fight back/.test(cargoNote({ transport: true })), true);
  eq(fail, "a land piece is not cargo", cargoNote({ transport: false }), "");

  // --- an aircraft says how long it is away -----------------------------------
  eq(fail, "a plane away on a mission counts down", airNote({ kind: "aircraft", inactive: 3 }),
    "Away on a mission: 3 rounds until it can fly again.");
  eq(fail, "one round is singular", /1 round until/.test(airNote({ kind: "aircraft", inactive: 1 })), true);
  eq(fail, "a ready plane says so", /Ready to fly/.test(airNote({ kind: "aircraft", inactive: 0 })), true);
  eq(fail, "an infantry is not an aircraft", airNote({ kind: null, inactive: 3 }), "");

  // --- capitals --------------------------------------------------------------
  const fallbackCaps = capitalMarkers(null);
  eq(fail, "fallback capitals", fallbackCaps.map((c) => [c.name, c.x, c.y]), [["Washington", 79, 44], ["Moscow", 183, 25]]);
  eq(fail, "capital colors", fallbackCaps.map((c) => c.color), [SCHEMATIC.blue, SCHEMATIC.red]);
  const renamed = capitalMarkers({ capitals: { blue: { name: "Washington", x: 79, y: 44 }, red: { name: "Moscow", x: 183, y: 25 } } });
  eq(fail, "capital names survive the payload", renamed.map((c) => c.name), ["Washington", "Moscow"]);
  // PB-022: a room labels the era's own capital rows, not the board's fixed seats. 1918 carries
  // three type-1/2 rows and no Washington or Moscow, so neither name may reach the frame.
  const eraRoom = {
    sites: [
      { id: 10, name: "London", x: 148, y: 30, type: 1, owner: "blue" },
      { id: 11, name: "Berlin", x: 161, y: 30, type: 2, owner: "red" },
      { id: 17, name: "Paris", x: 150, y: 34, type: 2, owner: "blue" },
      { id: 62, name: "Washington", x: 79, y: 44, type: 4, owner: "blue" },
      { id: 63, name: "Moscow", x: 183, y: 25, type: 4, owner: "red" },
    ],
  };
  const eraCaps = capitalMarkers({ capitals: { blue: { name: "Washington", x: 79, y: 44 }, red: { name: "Moscow", x: 183, y: 25 } } }, eraRoom);
  eq(fail, "a room's own capitals replace the fixed seats", eraCaps.map((c) => c.name), ["London", "Berlin", "Paris"]);
  eq(fail, "an era capital keeps the owner's colour", eraCaps.map((c) => c.color), [SCHEMATIC.blue, SCHEMATIC.red, SCHEMATIC.blue]);
  const neutralRoom = { sites: [{ id: 10, name: "London", x: 148, y: 30, type: 1, owner: null }] };
  eq(fail, "a neutral capital is not painted in a side's colour", capitalMarkers(null, neutralRoom).map((c) => c.color), [CAPITAL_NEUTRAL]);

  // --- a piece is a badge: the side's frame, the type's silhouette (T-014) ---
  // The 3x3 block this file used to pin is gone. A typed piece draws its own badge at every zoom,
  // including the whole-world fit; that is the whole point of the task.
  const zoom = { ...full, scale: 8 };
  const sea = recorder();
  const seaBadge = paintPiece(sea.ctx, { id: "b1", side: "blue", domain: "sea", kind: "cruiser", x: 0, y: 15 }, zoom, { own: "blue" });
  ok(fail, "a piece draws a badge", seaBadge && seaBadge.size > 0);
  eq(fail, "the badge is the side's frame colour", sea.ops.find((op) => op.op === "fill").color, BADGE_SIDE.blue.frame);
  eq(fail, "a blue badge is blue", seaBadge.side, "blue");
  ok(fail, "a sea piece's interior is the sea colour",
    sea.ops.some((op) => op.op === "fill" && op.color === BADGE_INTERIOR.sea));
  ok(fail, "the silhouette is drawn in the side's dark colour",
    sea.ops.some((op) => op.op === "fill" && op.color === BADGE_SIDE.blue.dark));

  const enemy = recorder();
  paintPiece(enemy.ctx, { id: "r1", side: "red", domain: "land", kind: null, x: 183, y: 25 }, zoom, { own: "blue" });
  eq(fail, "a red badge is red", enemy.ops.find((op) => op.op === "fill").color, BADGE_SIDE.red.frame);
  const at = cellToPixel(183, 25, zoom);
  eq(fail, "a badge is centred on its cell", [Math.round(enemy.ops.find((op) => op.op === "fill").x ?? 0), 0].length, 2);

  // The badge is never the dot again: at the whole-world fit it is still a badge, and still at the
  // PM's floor rather than shrinking into a cluster.
  const fitPiece = recorder();
  const fitBadge = paintPiece(fitPiece.ctx, { id: "b2", side: "blue", domain: "land", kind: "tank", x: 79, y: 44 }, full, { own: "blue" });
  eq(fail, "the whole-world fit draws a badge, not a 3x3 block", fitPiece.fills.length, 0);
  ok(fail, "the fit badge is at least the 14 px floor", fitBadge.size >= 14);
  ok(fail, "the fit badge is a filled frame", fitPiece.ops.some((op) => op.op === "fill"));

  // --- the real payload paints, with pieces and both capitals ----------------
  const res = await fetch(base + "/api/board");
  if (res.status !== 200) fail("board status " + res.status);
  const board = await res.json();
  if (board.source !== "extract") {
    ctx.skip("board_paint: no board extract on this host (set OPENCHQ_DATA or OPENCHQ_EXTRACT); got " + board.source);
  }
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

  // --- PB-073: a withheld enemy capital is not drawn ---------------------------
  // A rolled/concealed era has no type-1/2 capital rows, so the marker set comes from the
  // capitals map. The page used to read the BOARD payload (unfiltered, both seats) and drew the
  // enemy's ring and name over ground the seat had never seen. The seat's own view withholds it,
  // and the marker paints after the fog, so nothing dimmed it. Same frame, same board, the only
  // difference is whether the view named the enemy capital.
  const concealedBoard = { ...board, capitals: { blue: { x: 79, y: 44 }, red: { x: 183, y: 25 } } };
  const concealedRoom = { ...room, sites: [], capitals: { blue: { x: 79, y: 44 } } };
  const withheld = recorder();
  const withheldFrame = paintMatch(withheld.ctx, concealedBoard, concealedRoom, { view: full, own: "blue" });
  eq(fail, "a withheld enemy capital is not marked", withheldFrame.capitals, 1);
  eq(fail, "no red capital ring is stroked outside sight",
    withheld.ops.filter((op) => op.op === "stroke" && op.color === SCHEMATIC.red).length, 0);
  ok(fail, "the withheld capital\u2019s name never reaches the frame",
    !withheld.texts.some((t) => t.text === "Moscow"));
  // Control: the same frame with the capital SENT draws it, so the pin above is not vacuous.
  const sent = recorder();
  const sentFrame = paintMatch(sent.ctx, concealedBoard,
    { ...concealedRoom, capitals: { blue: { x: 79, y: 44 }, red: { x: 183, y: 25 } } },
    { view: full, own: "blue" });
  eq(fail, "the control frame marks both capitals", sentFrame.capitals, 2);
  ok(fail, "the control frame does stroke a red capital ring",
    sent.ops.some((op) => op.op === "stroke" && op.color === SCHEMATIC.red));

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

  // Pieces are badges on the grid: each side's frame lands on its own cell, and the shields are the
  // side colours rather than the old block's eight cells.
  const blueFrame = painted.ops.filter((op) => op.op === "fill" && op.color === BADGE_SIDE.blue.frame);
  ok(fail, "the blue land piece draws a blue frame on Washington", blueFrame.length >= 2);
  const redFrame = painted.ops.filter((op) => op.op === "fill" && op.color === BADGE_SIDE.red.frame);
  ok(fail, "the red sea piece draws a red frame", redFrame.length >= 2);
  // The old block was nine cell-sized fillRects around the piece: eight in the side's body colour
  // and one white centre. The badge painter fills paths instead, so no cell-sized rect may carry a
  // side's block body. (The white centre is left out on purpose: capitals and city markers use it.)
  const blockBodies = new Set(Object.values(PIECE_MARKER.body));
  const blockFills = painted.fills.filter((f) => blockBodies.has(f.color) &&
    f.w === full.scale && f.h === full.scale);
  eq(fail, "no piece is drawn as the old nine-pixel block", blockFills.length, 0);

  // enemy pieces are only the ones sent: dropping them changes the count
  const oneSide = recorder();
  const fewer = paintMatch(oneSide.ctx, board, { ...room, pieces: room.pieces.filter((p) => p.side === "blue") }, { view: full, own: "blue" });
  eq(fail, "the painter draws exactly what the view sent", fewer.pieces, 2);

  // --- Show Ownership is a BASE layer: the badge sits ON owned land (T-018 AC4, rider 2) -------
  // The e2e pin this replaces sampled a piece standing on open sea and compared its cell with a
  // neighbour's. On a blue owner's edge that neighbour reads #0000aa - the same ink as a blue
  // badge's silhouette - so the check went green while the ownership fill covered every unit.
  // This pin builds the hard case instead: one region owned blue under the whole board, the blue
  // land piece on Washington (owned ground), and an ordered log of what the painter drew.
  const oneRegion = { width: board.width, height: board.height, noRegion: 255,
    regionRuns: [[0, board.width * board.height]] };
  const ownedBoard = { ...board, territory: oneRegion };
  const ownedRoom = { ...room, ownership: { ready: true, era: "1942", owners: ["blue"],
    tally: { blue: 1, red: 0, neutral: 0 } } };
  for (const scale of [1, 2, 8]) {
    const ownedView = makeView({ scale, left: 0, top: 0 });
    const rec = recorder();
    const shown = paintMatch(rec.ctx, ownedBoard, ownedRoom,
      { view: ownedView, own: "blue", viewMode: "political" });
    if (!(shown.political > 0)) fail("scale " + scale + ": the ownership fill painted nothing");
    if (!Array.isArray(shown.layers) || shown.layers.indexOf("ownership") < 0) {
      fail("scale " + scale + ": ownership is not reported as a layer");
    }
    for (const after of ["pieces", "siteTicks", "capitals", "labels"]) {
      const at = shown.layers.indexOf(after);
      if (!(shown.layers.indexOf("ownership") < at)) {
        fail("scale " + scale + ": " + after + " is not drawn over the ownership fill ("
          + shown.layers.join(">") + ")");
      }
    }
    const ground = rec.seq.findIndex((op) => op.kind === "rect" && op.color === OWNERSHIP.blue
      && op.x === 79 * scale && op.y === 44 * scale);
    const frame = rec.seq.findIndex((op) => op.kind === "fill" && op.color === BADGE_SIDE.blue.frame);
    if (ground < 0) fail("scale " + scale + ": Washington's owned ground was not filled");
    if (frame < 0) fail("scale " + scale + ": the badge's frame was not drawn");
    if (!(ground < frame)) fail("scale " + scale + ": the badge was drawn under the ownership fill");
    // The badge's own face, not an edge or a fill: the interior ink exists only on the badge.
    const faceAt = rec.seq.findIndex((op, i) => i > frame && op.kind === "fill"
      && op.color === BADGE_INTERIOR.land);
    if (!(faceAt > frame)) fail("scale " + scale + ": the badge's interior is not painted over the fill");
    if (rec.seq[faceAt].color === OWNERSHIP.blue || rec.seq[faceAt].color === OWNERSHIP.edge.blue) {
      fail("scale " + scale + ": the badge face is the ownership ink");
    }
  }


  // --- Show Ownership stays UNDER the fog (T-018 AC4 follow-up) --------------------------------
  // A re-do of the AC4 commit painted the fill after the fog, so Show Ownership came back fully
  // lit: half the board unlit gave 21,760 fog rects and 43,520 ownership rects drawn over them.
  // Nothing failed, because no pin looked at fog and the returned layer list named neither cells
  // nor fog. This pin holds both: the layer order, and the ink order in the recorded op log.
  {
    const fogView = makeView({ scale: 2, left: 0, top: 0 });
    const lit = new Uint8Array(BOARD_W * BOARD_H);
    for (let i = 0; i < lit.length; i += 2) lit[i] = 1;
    const fogRec = recorder();
    const fogged = paintMatch(fogRec.ctx, ownedBoard, ownedRoom,
      { view: fogView, own: "blue", viewMode: "political", fog: { lit, seen: null } });
    if (!(fogged.fogged > 0)) fail("a political view with fog painted no fog at all");
    for (const layer of ["cells", "ownership", "fog"]) {
      if (fogged.layers.indexOf(layer) < 0) {
        fail("the layer list omits " + layer + " (" + fogged.layers.join(">") + ")");
      }
    }
    if (!(fogged.layers.indexOf("ownership") < fogged.layers.indexOf("fog"))) {
      fail("the fog is reported under the ownership fill (" + fogged.layers.join(">") + ")");
    }
    const fillOps = fogRec.seq.map((op, i) => ({ op, i }))
      .filter(({ op }) => op.kind === "rect" && op.color === OWNERSHIP.blue);
    const fogOps = fogRec.seq.map((op, i) => ({ op, i }))
      .filter(({ op }) => typeof op.color === "string" && op.color.startsWith("rgba(6, 12, 22"));
    if (fillOps.length === 0) fail("the ownership fill painted no rects");
    if (fogOps.length === 0) fail("the fog painted no rects");
    const lastFill = fillOps[fillOps.length - 1].i;
    const firstFog = fogOps[0].i;
    if (!(lastFill < firstFog)) {
      fail("an ownership rect was painted over the fog (" + lastFill + " > " + firstFog + ")");
    }
  }

  // --- the hosted fallback: schematic plus every piece still on the map ------
  const missing = { source: "missing", cells: null, width: BOARD_W, height: BOARD_H, capitals: null, terrain: [] };
  const fallback = recorder();
  const schematic = paintMatch(fallback.ctx, missing, room, { view: full, own: "blue" });
  eq(fail, "a missing extract falls back", schematic.mode, "schematic");
  eq(fail, "the fallback says so", schematic.message, EXTRACT_MISSING);
  eq(fail, "pieces still draw on the schematic", schematic.pieces, 4);
  ok(fail, "the schematic still labels Washington", fallback.texts.some((t) => t.text === "Washington"));
  ok(fail, "the schematic still labels Moscow", fallback.texts.some((t) => t.text === "Moscow"));
  // The schematic marks a city with the marker's light centre and the side colour around it.
  const blueMark = fallback.fills.find((f) => f.x === 79 * 2 && f.y === 44 * 2);
  if (!blueMark || blueMark.color !== SCHEMATIC.blue) fail("schematic does not mark Washington in blue");
  const schematicColors = new Set([
    ...Object.values(PALETTE),
    ...Object.values(SCHEMATIC),
    ...Object.values(PIECE_MARKER.body),
    PIECE_MARKER.centre,
  ]);
  for (const fill of fallback.fills) {
    if (!schematicColors.has(fill.color)) fail("the schematic invented a color " + fill.color);
  }
  eq(fail, "an unknown board is the schematic too", paintMatch(recorder().ctx, null, room, { view: full }).mode, "schematic");

  // --- the line under the canvas --------------------------------------------
  ok(fail, "missing extract note", statusLine(missing, room, schematic) === EXTRACT_MISSING);
  const line = statusLine(board, room, result);
  ok(fail, "grid note names the extract", line.includes("map extract"));
  ok(fail, "grid note counts the pieces in sight", line.includes("4 pieces in sight"));
  ok(fail, "grid note splits own from the other side", line.includes("2 yours") && line.includes("2 the other side"));
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
  // Assert against the constants, not a second copy of their values: the levels are tunable and
  // the test should follow them, while still proving that memory is lighter than the unknown.
  if (!styles.has(FOG_REMEMBERED)) fail("remembered ground is not drawn at its own level: " + [...styles].join(","));
  if (!styles.has(FOG_UNKNOWN)) fail("unknown ground is not drawn at its own level");
  if (styles.size < 2) fail("fog uses one level for everything, so memory is invisible");
  const alpha = (style) => Number(String(style).split(",").pop().replace(")", "").trim());
  if (!(alpha(FOG_UNKNOWN) > alpha(FOG_REMEMBERED))) fail("unknown ground is lighter than remembered ground");

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
