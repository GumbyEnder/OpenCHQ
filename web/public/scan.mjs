// Intel scan: the original's sweeping bar, measured (Q51, T-022).
//
// Evidence: DOSBox capture of the 1990 original, 450 frames at 10 fps, purchase of "Intel Scan"
// at 1986/BLUE vs computer. Measured from the frames (harness: agents/game/harness/q51-final.py,
// result local/q51/q51-result.json):
//   - one bar, 40 capture px wide on the 624 px capture map = 20 of the board's 320 columns;
//   - leading edge 39.36 px/s on the 624 px capture map (X0..X1 = 200..824) = 20.2 cells/s on the
//     board's 320 columns, i.e. one crossing in 15.85 s (fixture fit, RMSE 2.08 px over 161 frames);
//   - 29 single-run red units tracked: visible 1.00-1.10 s each (median 1.00), and every one went
//     out between 0.21 s before and 0.03 s after the trailing edge cleared its cells -- no
//     measurable persistence past the bar at 10 fps granularity. The ~1 s an earlier note saw
//     was the bar's own dwell over the unit, not a linger after it.
// So the reveal is bar-local: a unit is drawn only while the bar covers it.
//
// Pure maths, no canvas and no clock of its own, so the node test can pin the numbers.

export const SCAN = Object.freeze({
  boardW: 320,
  barCells: 20,
  crossSeconds: 15.85,
  holdSeconds: 1.0,
  shade: "rgba(16, 18, 22, 0.62)",
  barInk: "#dff6ff",
  barEdge: "rgba(223, 246, 255, 0.35)",
});

// The measured constants scaled to whatever board the room is playing on: the ratio is what the
// capture proves, not the pixel count.
export function scanSpec(boardW = SCAN.boardW) {
  const width = Math.max(1, Math.floor(Number(boardW) || SCAN.boardW));
  const barCells = Math.max(1, Math.round((SCAN.barCells * width) / SCAN.boardW));
  const cellsPerSecond = width / SCAN.crossSeconds;
  return {
    boardW: width,
    barCells,
    crossSeconds: SCAN.crossSeconds,
    cellsPerSecond,
    // The dwell over one unit is bar width / speed: constant in time, because both scale with the
    // board. Kept here so the card's "~1 s" is a computed value, not a second constant.
    holdSeconds: barCells / cellsPerSecond,
  };
}

// State at a wall-clock instant. `startedAt` and `now` are ms; negative elapsed clamps to 0 so a
// frame that arrives before the animation is armed draws the bar at the left edge, not off-board.
export function scanState(startedAt, now, boardW = SCAN.boardW) {
  const spec = scanSpec(boardW);
  const elapsed = Math.max(0, (Number(now) || 0) - (Number(startedAt) || 0)) / 1000;
  const lead = elapsed * spec.cellsPerSecond;
  const trail = lead - spec.barCells;
  return {
    spec,
    elapsed,
    lead,
    trail,
    // The pass is over when the trailing edge has left the right of the board.
    done: trail >= spec.boardW,
    progress: Math.min(1, Math.max(0, lead / spec.boardW)),
  };
}

// Is column `x` under the bar? The bar starts fully off the left of the board and leaves fully off
// the right, so it is not clamped: clipping it to the board would reveal the left edge a fifth of
// a second early and the right edge early by the same amount. X wraps, so a bar straddling the
// seam is tested by distance along the wrap rather than by a plain interval compare.
export function scanCovers(x, state, boardW) {
  if (!state || !state.spec) return false;
  const width = Math.max(1, Math.floor(Number(boardW) || state.spec.boardW));
  const n = ((Math.trunc(Number(x) || 0) % width) + width) % width;
  const trail = state.trail;
  const span = state.spec.barCells;
  if (!Number.isFinite(trail)) return false;
  const d = (((n - trail) % width) + width) % width;
  return d <= span;
}

// A remake round ticks in real time while the pass is still running. The original's scan is
// continuous, so a pass that has STARTED finishes even across a round boundary (PM ruling on
// room 7630); only a pass whose trailing edge has already left the board is dropped with the
// round. Returns true = keep the armed pass.
export function scanKeepsAcrossRound(scan, round, now, boardW) {
  if (!scan) return false;
  const width = Math.max(1, Math.floor(Number(boardW) || Number(scan.boardW) || SCAN.boardW));
  if (Number(round) === Number(scan.round)) return true;
  return !scanState(scan.startedAt, now, width).done;
}

// The server's intel reveal is per round and the measured pass is 15.85 s, so the room can stop
// carrying the scanned enemy before the bar has crossed the map. The pass keeps its own snapshot of
// what the reveal put on the board: merged at the ack and on every room message while it runs, and
// drawn bar-locally by render.mjs until the pass is over (T-022, room 7650).
export function scanAddPieces(scan, pieces, own) {
  if (!scan || !Array.isArray(pieces)) return scan;
  scan.intelPieces = Array.isArray(scan.intelPieces) ? scan.intelPieces : [];
  const have = new Set(scan.intelPieces.map((piece) => piece && piece.id));
  const ids = scan.intelIds;
  const has = !ids ? () => false : typeof ids.has === "function" ? (id) => ids.has(id) : (id) => ids.includes(id);
  for (const piece of pieces) {
    if (!piece || piece.side === own || have.has(piece.id) || !has(piece.id)) continue;
    have.add(piece.id);
    scan.intelPieces.push({ ...piece });
  }
  return scan;
}

// A unit is drawn when the bar covers its column. Enemy units a seat can already see by sight are
// not this gate's business: the caller keeps those out of `intelIds`.
export function scanReveals(piece, state, boardW) {
  if (!piece || !Number.isFinite(Number(piece.x))) return false;
  return scanCovers(piece.x, state, boardW);
}
