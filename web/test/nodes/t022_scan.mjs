// Node t022_scan: the intel sweep's measured numbers and the bar-local reveal gate.
//
// The constants under test are the Q51 capture (1990 original, 450 frames at 10 fps): one bar 20
// cells wide, 15.85 s to cross a 320-cell board, a unit on screen ~1 s while the bar covers it and
// nothing after. What this node pins is that the code still says exactly that, and that an enemy
// unit the scan put on the board is drawn only under the bar.
import {
  fitViewport, paintMatch, paintScanBar, paintScanShade, scanVisiblePieces,
} from "../../public/render.mjs";
import { SCAN, scanCovers, scanKeepsAcrossRound, scanSpec, scanState } from "../../public/scan.mjs";
import { openMatch } from "../../server/match.mjs";
import { toolsForEra, useTool } from "../../server/late.mjs";
import { millionsPerBillion, priceOf, rules } from "../../server/rules.mjs";

function fail(message) {
  throw new Error(message);
}

function ok(cond, message) {
  if (!cond) fail(message);
}

function near(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    fail(message + ": " + actual + " not within " + tolerance + " of " + expected);
  }
}

function recorder() {
  const fills = [];
  const seq = [];
  const noop = () => {};
  const ctx = {
    _fill: "",
    _stroke: "",
    lineWidth: 1,
    font: "",
    globalAlpha: 1,
    set fillStyle(value) { this._fill = value; },
    get fillStyle() { return this._fill; },
    set strokeStyle(value) { this._stroke = value; },
    get strokeStyle() { return this._stroke; },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this._fill }); seq.push("rect"); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, save: noop, restore: noop, fillText: noop,
    setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, fills, seq };
}

export const name = "t022_scan";

export async function run() {
  // --- the measured constants ---------------------------------------------------------------
  ok(SCAN.barCells === 20, "the bar is 20 cells wide (40 window px on the 640 px capture)");
  ok(SCAN.crossSeconds === 15.85, "one crossing is 15.85 s");
  const spec = scanSpec(320);
  ok(spec.boardW === 320, "the board is 320 cells");
  near(spec.cellsPerSecond, 20.19, 0.05, "the bar moves ~20.2 cells/s");
  near(spec.holdSeconds, 0.99, 0.03, "a unit is under the bar for ~1 s");

  // --- one pass, left to right, then over ----------------------------------------------------
  const at0 = scanState(1000, 1000, 320);
  near(at0.lead, 0, 1e-9, "at t0 the leading edge is at the left edge");
  ok(!at0.done, "nothing is done at t0");
  const mid = scanState(0, 7925, 320);
  near(mid.lead, 160, 0.5, "half the crossing puts the leading edge at mid-board");
  ok(!mid.done, "the pass is not done at mid-board");
  const end = scanState(0, 15850, 320);
  near(end.lead, 320, 0.2, "one crossing puts the leading edge on the right edge");
  ok(!end.done, "the pass is not done while the bar's trailing edge is still on the board");
  ok(scanState(0, 16850, 320).done, "the pass is done once the trailing edge has left the board");

  // --- a unit's dwell: one interval, ~1 s, no persistence ------------------------------------
  const first = (() => {
    for (let ms = 0; ms <= 20000; ms += 1) if (scanCovers(160, scanState(0, ms, 320), 320)) return ms;
    return null;
  })();
  const last = (() => {
    for (let ms = 20000; ms >= 0; ms -= 1) if (scanCovers(160, scanState(0, ms, 320), 320)) return ms;
    return null;
  })();
  ok(first !== null && last !== null, "the bar covers a mid-board unit at some instant");
  near((last - first) / 1000, 0.99, 0.02, "the unit is covered for ~1 s");
  ok(!scanCovers(160, scanState(0, last + 100, 320), 320),
    "the unit is not drawn after the bar has left it (no persistence, Q51)");
  // Exactly one interval: the sample either side of the window is uncovered.
  ok(!scanCovers(160, scanState(0, first - 1, 320), 320), "the bar had not reached the unit before it");
  let runs = 0;
  let inside = false;
  for (let ms = 0; ms <= 20000; ms += 5) {
    const c = scanCovers(160, scanState(0, ms, 320), 320);
    if (c && !inside) runs += 1;
    inside = c;
  }
  ok(runs === 1, "one pass means one reveal interval, not a second sweep (" + runs + ")");

  // --- the board wraps: a bar straddling the seam covers the far columns ---------------------
  const seam = scanState(0, 15850, 320); // lead 320, trail 300
  ok(scanCovers(305, seam, 320), "the bar covers a column just inside the right edge");
  ok(!scanCovers(5, seam, 320), "and does not reach the far side of the seam");
  const straddle = scanState(0, 16000, 320); // lead ~323, trail ~303
  ok(scanCovers(320 % 320, straddle, 320) || scanCovers(2, straddle, 320),
    "a bar past the right edge wraps onto the left of the board");

  // --- a remake round must not cut a started pass short (T-022, room 7630) -------------------
  // `room.round` ticks while the sweep is in flight: the original is continuous real time, so a
  // pass that has started finishes. Only a pass whose trailing edge is already off the board is
  // dropped, or round N+1's pieces would stay hidden by a sweep that ended in round N.
  const armed = { startedAt: 0, round: 4, boardW: 320 };
  ok(scanKeepsAcrossRound(armed, 4, 15600, 320), "the same round keeps the pass while it runs");
  ok(scanKeepsAcrossRound(armed, 4, 20000, 320), "the same round keeps it even after it is done");
  ok(scanKeepsAcrossRound(armed, 5, 2000, 320),
    "a round tick 2 s into a 15.85 s pass does not cut the pass short");
  ok(scanKeepsAcrossRound(armed, 5, 15600, 320),
    "a tick near the end of the round still keeps the pass (trail is on the board)");
  ok(!scanState(0, 15600, 320).done, "and the pass genuinely is unfinished at that instant");
  ok(!scanKeepsAcrossRound(armed, 5, 16850, 320),
    "a finished pass is dropped by the round tick, so round N+1 is not hidden");
  ok(scanKeepsAcrossRound({ ...armed, startedAt: 900000 }, 5, 900010, 320),
    "the guard reads the pass's own clock, not the round's");
  ok(!scanKeepsAcrossRound(null, 5, 0, 320), "no armed pass means nothing to keep");

  // --- the gate: own and sight-visible pieces are never hidden ------------------------------
  const state = scanState(0, 7925, 320); // bar over the middle of the board
  const pieces = [
    { id: "own", side: "blue", x: 10, y: 40 },
    { id: "seen", side: "red", x: 300, y: 40 },
    { id: "scanned-near", side: "red", x: 160, y: 40 },
    { id: "scanned-far", side: "red", x: 40, y: 40 },
  ];
  const gated = scanVisiblePieces(pieces, { own: "blue", scan: { state, intelIds: new Set(["scanned-near", "scanned-far"]) } })
    .map((piece) => piece.id);
  ok(gated.includes("own"), "an own piece is drawn during a scan");
  ok(gated.includes("seen"), "a red unit the seat can already see is drawn during a scan");
  ok(gated.includes("scanned-near"), "a scanned unit under the bar is drawn");
  ok(!gated.includes("scanned-far"), "a scanned unit the bar has not reached is not drawn");
  const after = scanVisiblePieces(pieces, {
    own: "blue",
    scan: { state: scanState(0, 20000, 320), intelIds: new Set(["scanned-near", "scanned-far"]) },
  }).map((piece) => piece.id);
  ok(!after.includes("scanned-near") && !after.includes("scanned-far"),
    "once the pass is over, the scan's units are hidden again");
  ok(after.includes("seen"), "and the sighted red unit stays");

  // --- the painter: shade under the pieces, bar on top --------------------------------------
  const view = { ...fitViewport(640, 272), scale: 2, left: 0, top: 0, viewW: 640, viewH: 272 };
  const rec = recorder();
  ok(paintScanShade(rec.ctx, view) === 1, "the shade paints");
  ok(rec.fills.length === 1, "the shade is one rect");
  ok(rec.fills[0].w >= 630 && rec.fills[0].h >= 260,
    "the shade covers the board, not the canvas origin only (" + rec.fills[0].w + "x" + rec.fills[0].h + ")");
  const bar = recorder();
  const drawn = paintScanBar(bar.ctx, state, view);
  ok(drawn >= 1, "the bar paints");
  ok(bar.fills.some((f) => f.color === SCAN.barInk), "the bar's body uses the measured ink");
  ok(bar.fills.filter((f) => f.color === SCAN.barInk).every((f) => f.h >= 260), "the bar runs the full map height");

  // --- integration: a frame with a scan carries the two new layers, in order ----------------
  const board = {
    source: "extract", width: 320, height: 136, terrain: ["ocean"],
    cells: new Array(320 * 136).fill(0), capitals: null,
  };
  const room = {
    era: "1986", round: 4, clock: "held", you: "blue",
    pieces: [
      { id: "own", side: "blue", domain: "land", kind: null, x: 10, y: 40 },
      { id: "scanned-near", side: "red", domain: "land", kind: null, x: 160, y: 40 },
      { id: "scanned-far", side: "red", domain: "land", kind: null, x: 40, y: 40 },
    ],
  };
  const frame = recorder();
  const result = paintMatch(frame.ctx, board, room, {
    view, own: "blue",
    scan: { state, active: true, intelIds: new Set(["scanned-near", "scanned-far"]) },
  });
  ok(result.layers.includes("scanShade"), "the frame lists the shade layer");
  ok(result.layers[result.layers.length - 1] === "scanBar", "the bar is the last thing painted");
  ok(result.layers.indexOf("scanShade") < result.layers.indexOf("pieces"), "the shade is under the pieces");
  ok(result.groups === 2, "one own badge and one scanned unit under the bar are drawn (" + result.groups + ")");
  ok(result.scanBar >= 1, "the frame reports the bar it painted");

  // Control: the same frame with no scan draws every piece the view sent.
  const plain = paintMatch(recorder().ctx, board, room, { view, own: "blue" });
  ok(plain.groups === 3, "without a scan every piece is drawn (" + plain.groups + ")");
  ok(!plain.layers.includes("scanShade"), "and no shade is painted");

  // --- AC4: the tool is offered only where the manual puts it, at the recovered price, and it
  // --- touches neither a unit's position nor an owner (T-022 card AC4; room 7639).
  for (const era of ["1918", "1942"]) {
    ok(!toolsForEra(era).includes("intel"), era + " offers the intel scan");
  }
  for (const era of ["1986", "2023"]) {
    ok(toolsForEra(era).includes("intel"), era + " does not offer the intel scan");
  }
  ok(rules().prices.intelScan === 10, "the config price is not the manual's 10 (" + rules().prices.intelScan + ")");
  ok(priceOf("intelScan") === 10 * millionsPerBillion(),
    "the charged price is not 10 billion (" + priceOf("intelScan") + " million)");

  const tool = openMatch("1986", []);
  tool.clock = "running";
  tool.round = 4;
  tool.sides.blue.cash = 50000;
  tool.sides.red.cash = 50000;
  tool.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red" },
  ];
  tool.pieces = [
    { id: "blue:land", side: "blue", domain: "land", kind: "infantry", x: 79, y: 44, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 },
    { id: "red:sea", side: "red", domain: "sea", kind: "submarine", x: 200, y: 100, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 },
  ];
  const unitBoard = () => JSON.stringify(tool.pieces.map((p) => [p.id, p.side, p.kind, p.x, p.y]));
  const owners = () => JSON.stringify(tool.sites.map((s) => [s.id, s.owner]));
  const unitsBefore = unitBoard();
  const ownersBefore = owners();
  const scanUse = useTool(tool, "blue", "intel");
  ok(!scanUse.error, "intel was refused in 1986: " + scanUse.error);
  ok(unitBoard() === unitsBefore, "the intel scan moved a unit");
  ok(owners() === ownersBefore, "the intel scan changed an owner");
  ok(tool.pieces.filter((p) => p.side === "red").every((p) => p.revealedRound === tool.round),
    "the intel scan did not mark the enemy pieces for its own round");
}
