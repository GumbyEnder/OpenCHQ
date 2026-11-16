// Node PB-082: the sight gate, and the marker layers that used to escape the fog.
//
// The fog is a layer. Anything painted AFTER it is never dimmed by it, so a capital ring, a city
// tick and a city's name were all drawn at full brightness over ground the seat had never seen.
// Era 9999 is the era that promises the opposite. This module pins the gate itself (levels, the x
// seam, the off-board row) and each painter that takes it: no ink at level 0, dimmed ink at level
// 1, untouched at level 2.
//
// The PB-073 withhold (a seat view that does not name a capital has withheld it) is NOT re-pinned
// here: web/test/nodes/pb073_capital_withhold.mjs and tests/e2e/pb073-capital-withhold.mjs own that
// rule, and a second pin of a shipped rule is how it forks.
import {
  fitViewport,
  paintCapitals,
  paintLabels,
  paintMatch,
  paintSiteTicks,
  REMEMBERED_MARKER_ALPHA,
  SIGHT_LIT,
  SIGHT_REMEMBERED,
  SIGHT_UNKNOWN,
  sightGate,
  visibleLabels,
} from "../../public/render.mjs";

function fail(message) {
  throw new Error(message);
}
function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}
function ok(message, value) {
  if (!value) fail(message);
}

const W = 320;
const H = 136;
const view = { ...fitViewport(1280, 544), boardW: W, boardH: H };

// A sight table with two cells set by hand: (79,44) in sight, (150,30) remembered, everything else
// unknown. The gate is the only thing under test here, so no rules module is involved.
function table() {
  const lit = new Uint8Array(W * H);
  const seen = new Uint8Array(W * H);
  lit[44 * W + 79] = 1;
  seen[44 * W + 79] = 1;
  seen[30 * W + 150] = 1;
  return { lit, seen };
}

function recorder() {
  const rects = [];
  const texts = [];
  const strokes = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "", globalAlpha: 1,
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, color: this.fillStyle, alpha: this.globalAlpha }); },
    fillText(text, x, y) { texts.push({ text, x, y, color: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha }); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, fill: noop, save: noop, restore: noop, setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, rects, texts, strokes };
}

const atlas = {
  source: "extract",
  _meta: { count: 2, first: 32, last: 33 },
  glyphs: [
    { code: 32, rows: [0, 0, 0, 0, 0, 0] },
    { code: 65, rows: [0b01110000, 0b10001000, 0b11111000, 0b10001000, 0b10001000, 0] },
  ],
};

export const name = "pb082_sight_gate";

export async function run() {
  // --- the gate itself ---------------------------------------------------------------------
  eq("no fog, no gate: every other era is untouched", sightGate(null, view), null);
  eq("an empty sight table is not a gate", sightGate({ lit: new Uint8Array(0), seen: null }, view), null);

  const fog = table();
  const gate = sightGate(fog, view);
  ok("a concealed frame gets a gate", typeof gate === "function");
  eq("the memory alpha is the pinned 0.45, not whatever the module currently says", REMEMBERED_MARKER_ALPHA, 0.45);
  eq("a lit cell draws", gate(79, 44), SIGHT_LIT);
  eq("a cell that has been seen draws as a memory", gate(150, 30), SIGHT_REMEMBERED);
  eq("a cell neither lit nor seen draws nothing", gate(200, 60), SIGHT_UNKNOWN);
  eq("the gate wraps x across the seam exactly as paintFog does", gate(-170, 30), SIGHT_REMEMBERED);
  eq("a row above the board is unknown, not an exception", gate(79, -1), SIGHT_UNKNOWN);
  eq("a row past the board is unknown", gate(79, H), SIGHT_UNKNOWN);
  eq("a non-finite coordinate is not silently gated out of the board", gate(NaN, 44), SIGHT_LIT);

  // --- the marker layers ask the gate before they paint ------------------------------------
  const markers = [
    { name: "InSight", x: 79, y: 44, color: "#c4473a" },
    { name: "Seen", x: 150, y: 30, color: "#c4473a" },
    { name: "Moscow", x: 200, y: 60, color: "#c4473a" },
  ];
  const rings = recorder();
  eq("only the lit and the remembered capital get a ring", paintCapitals(rings.ctx, markers, view, { sight: gate }), 2);
  eq("...and the unknown capital's name is not on the canvas",
    rings.texts.filter((t) => t.text === "Moscow").length, 0);
  eq("the lit capital is drawn at full ink", rings.texts.find((t) => t.text === "InSight").alpha, 1);
  // The number is pinned, not the constant: a test that reads the constant moves when the
  // constant is mutated (M3 turned 0.45 into 1 and stayed green). Remembered must be dimmer than
  // sight and never opaque.
  const rememberedAlpha = rings.texts.find((t) => t.text === "Seen").alpha;
  eq("the remembered capital draws at the pinned memory alpha", rememberedAlpha, 0.45);
  ok("a remembered marker is dimmer than a sighted one", rememberedAlpha < 1);

  const noGate = recorder();
  eq("with no gate every capital is drawn", paintCapitals(noGate.ctx, markers, view), 3);
  eq("with no gate the ink is opaque", noGate.texts.every((t) => t.alpha === 1), true);

  // City labels: same rule, and a label carries its own cell.
  const sites = [
    { name: "AA", x: 79, y: 44, owner: "blue" },
    { name: "AA", x: 150, y: 30, owner: null },
    { name: "AA", x: 200, y: 60, owner: null },
  ];
  const zoomed = { ...view, scale: 8, left: 0, top: 0, viewW: 2560, viewH: 1088 };
  const labels = visibleLabels(sites, zoomed);
  eq("all three cities are on the zoomed view", labels.length, 3);
  const labelInk = recorder();
  eq("only the lit and the remembered city is named",
    paintLabels(labelInk.ctx, atlas, labels, { sight: gate }), 2);
  const rememberedInk = labelInk.rects.filter((r) => r.alpha === 0.45);
  ok("the remembered name is drawn behind the haze", rememberedInk.length > 0);

  // A city tick under a badge is painted after the fog too, so it takes the same gate.
  const groups = [{ x: 79, y: 44 }, { x: 150, y: 30 }, { x: 200, y: 60 }];
  const tick = recorder();
  eq("a city tick on unknown ground is not drawn",
    paintSiteTicks(tick.ctx, sites, groups, zoomed, { sight: gate }), 2);
  ok("the remembered tick is drawn at the pinned memory alpha",
    tick.rects.some((r) => r.alpha === 0.45));
  const tickAll = recorder();
  eq("with no gate every tick is drawn", paintSiteTicks(tickAll.ctx, sites, groups, zoomed), 3);

  // --- F1 (room 6312): the ORDER of one political + fog frame, pinned whole ------------------
  // A colour-only pin passes while a layer is hidden, and a call-presence pin cannot see order.
  // The fog is the layer that makes every marker above it readable-or-not, so the exact list is
  // asserted deep-equal and the fog's index is checked against each marker layer's, not the list
  // as a whole (a re-order that keeps ten names in some order still reds this).
  const LAYER_ORDER = ["cells", "ownership", "fog", "pending", "preview", "pieces", "siteTicks",
    "capitals", "labels", "selection"];
  const board = { source: "extract", width: W, height: H, terrain: ["ocean", "plain"],
    cells: new Array(W * H).fill(1) };
  const politicalRoom = {
    sites: [
      { id: "washington", name: "Washington", x: 79, y: 44, owner: "blue" },
      { id: "moscow", name: "Moscow", x: 150, y: 30, owner: "red" },
    ],
    // A piece on ground the seat has never seen (200,60 is unknown in the table above) and the
    // selection on it: F2 says these layers are NOT gated, because the server already withholds
    // what a seat may not have (view.mjs visibleEnemy) and the page must draw what it was sent.
    pieces: [{ id: "blue:probe", side: "blue", domain: "land", kind: "tank", x: 200, y: 60 }],
  };
  const frame = recorder();
  const painted = paintMatch(frame.ctx, board, politicalRoom, {
    view: { ...view, scale: 4, left: 0, top: 0, viewW: 1280, viewH: 544 },
    viewMode: "political", fog, atlas, selectedId: "blue:probe",
  });
  eq("one political+fog frame paints the pinned ten layers in order",
    JSON.stringify(painted.layers), JSON.stringify(LAYER_ORDER));
  eq("the frame actually carries ten layers", painted.layers.length, LAYER_ORDER.length);
  const fogAt = painted.layers.indexOf("fog");
  ok("fog is a layer in the frame", fogAt >= 0);
  for (const above of ["pending", "preview", "pieces", "siteTicks", "capitals", "labels", "selection"]) {
    const at = painted.layers.indexOf(above);
    if (!(at > fogAt)) {
      fail("layer " + above + " paints at " + at + ", not above the fog at " + fogAt);
    }
  }
  ok("ownership is UNDER the fog, where the fill cannot light an unknown cell",
    painted.layers.indexOf("ownership") < fogAt);
  // F2 (room 6312): no gate on the layers the server already withholds. The gate is the marker
  // layers' alone, so the pieces/pending/preview/selection painters are called without `sight` -
  // the record is the args those painters got, quoted from the frame's own list, not a promise.
  eq("the fog is drawn, so the gate is live in this frame", painted.fogged > 0, true);
  eq("a piece the server sent still draws on unknown ground", painted.pieces, 1);
  ok("and it draws as a badge, not as nothing", painted.groups > 0);
  ok("the selection on that piece still draws", painted.selection && painted.selection.size > 0);
}
