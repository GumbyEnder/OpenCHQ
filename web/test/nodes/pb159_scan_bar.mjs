// Node pb159_scan_bar: the intel bar is painted once, inside the board, at every lead.
//
// PB-159: the remake drew the bar at -board, 0 and +board "for the wrap". Near the start of a pass
// the +board copy landed inside the viewport on the RIGHT edge, and near the seam the -board copy
// landed on the LEFT, so a pass showed an edge pair the Q51 capture never does (one bar, 450
// frames, no frame with ink at the opposite edge). The map's seam is an edge, not a doorway: the
// pass enters from off the left, crosses once, and leaves past the right.
import { cellToPixel, fitViewport, paintScanBar } from "../../public/render.mjs";
import { SCAN, scanSpec, scanState } from "../../public/scan.mjs";

export const name = "pb159_scan_bar";

function fail(message) {
  throw new Error(message);
}

function ok(cond, message) {
  if (!cond) fail(message);
}

function recorder() {
  const fills = [];
  const noop = () => {};
  const ctx = {
    _fill: "",
    set fillStyle(value) { this._fill = value; },
    get fillStyle() { return this._fill; },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this._fill }); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, save: noop, restore: noop, fillText: noop,
    setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, fills };
}

// The same viewport the other painter nodes use: 640x272 at scale 2 is the 320x136 board exactly.
function viewport() {
  return { ...fitViewport(640, 272), scale: 2, left: 0, top: 0, viewW: 640, viewH: 272 };
}

function boardSpan(view) {
  const a = cellToPixel(0, 0, view);
  const b = cellToPixel(view.boardW || 320, view.boardH || 136, view);
  return { x: Math.max(0, Math.min(a.x, b.x)), right: Math.min(view.viewW, Math.max(a.x, b.x)) };
}

// Bar-body ink that lands inside the board, as x ranges clipped to the board rect. The soft edge is
// a different colour and is excluded: the body is the bar the capture measures.
function bodySpans(fills, board) {
  return fills
    .filter((f) => f.color === SCAN.barInk)
    .map((f) => ({ x1: f.x, x2: f.x + f.w }))
    .filter((s) => s.x2 > board.x && s.x1 < board.right)
    .map((s) => [Math.max(board.x, s.x1), Math.min(board.right, s.x2)]);
}

function atLead(lead, boardW = 320) {
  const spec = scanSpec(boardW);
  return { spec, lead, trail: lead - spec.barCells };
}

export async function run() {
  const view = viewport();
  const board = boardSpan(view);
  const originX = cellToPixel(0, 0, view).x;
  const expectedWidth = Math.min(view.viewW, originX + 320 * view.scale) - board.x;
  ok(board.right - board.x === expectedWidth,
    "the test viewport is the board exactly (" + (board.right - board.x) + " px, expected " + expectedWidth + ")");
  const barPx = scanSpec(320).barCells * view.scale;

  // lead 0: the leading edge is on the left board edge; the bar is entirely off the left. The
  // original's first ink appears only as it enters (Q51 f26 shows a sliver at the left edge), and
  // the right edge stays dark.
  const start = recorder();
  const drawnStart = paintScanBar(start.ctx, atLead(0), view);
  ok(drawnStart === 0, "lead 0 reports no bar painted (" + drawnStart + ")");
  ok(bodySpans(start.fills, board).length === 0,
    "lead 0 paints ink inside the board: " + JSON.stringify(bodySpans(start.fills, board)));

  // lead 20: the bar sits exactly at the left edge, one full band inside the board.
  ok(paintScanBar(recorder().ctx, atLead(20), view) === 1, "lead 20 reports the bar");

  // Mid-pass: one bar, no ghost.
  const mid = recorder();
  ok(paintScanBar(mid.ctx, scanState(0, 7925, 320), view) === 1, "mid-pass reports the bar");
  const midSpans = bodySpans(mid.fills, board);
  ok(midSpans.length === 1, "mid-pass draws " + midSpans.length + " bar spans, not one");
  ok(midSpans[0][1] - midSpans[0][0] === barPx, "the mid-pass bar is not the measured width: " + JSON.stringify(midSpans[0]));

  // The seam: trail 310 of 320, so the bar's tail is still on the right edge while its head is off
  // board. The old -board copy painted a second strip at the left edge here.
  const seam = recorder();
  ok(paintScanBar(seam.ctx, atLead(330), view) === 1, "the seam reports the bar");
  const seamSpans = bodySpans(seam.fills, board);
  ok(seamSpans.length === 1, "the seam draws " + seamSpans.length + " bar spans: " + JSON.stringify(seamSpans));
  ok(seamSpans[0][0] === originX + 310 * view.scale,
    "the seam bar is not against the right edge: " + JSON.stringify(seamSpans[0]));
  ok(seam.fills.filter((f) => f.color === SCAN.barInk).every((f) => f.x >= board.right - barPx),
    "the seam paints bar ink at the left edge too: " + JSON.stringify(bodySpans(seam.fills, board)));

  // The tail leaving: the bar is fully past the right edge, so the board is dark again.
  const end = recorder();
  ok(paintScanBar(end.ctx, atLead(340), view) === 0, "after the pass the bar is gone");
  ok(bodySpans(end.fills, board).length === 0,
    "after the pass a wrap copy is still painted: " + JSON.stringify(bodySpans(end.fills, board)));

  // No lead in the crossing may show two spans inside the board, and none may show ink at the
  // opposite edge from the head.
  for (let lead = -10; lead <= 350; lead += 1) {
    const frame = recorder();
    paintScanBar(frame.ctx, atLead(lead), view);
    const spans = bodySpans(frame.fills, board);
    ok(spans.length <= 1, "lead " + lead + " draws " + spans.length + " bar spans");
    const expected = lead > 0 && lead < 320 + SCAN.barCells;
    ok((spans.length === 1) === expected,
      "lead " + lead + " bar presence is wrong (spans " + spans.length + ", expected " + expected + ")");
  }
}
