// Server-side intel reveal: the payload only carries a scanned unit while the bar covers it.
// Owner: view node (PB-158).
//
// MANUAL p.31: an intel scan reveals the units beneath the moving bar, and tells the opponent it
// was read. Q51 MEASURED the bar in the original (web/public/scan.mjs): one bar 20 of the board's
// 320 columns wide, crossing in 15.85 s, with no lingering after the trailing edge clears a unit.
//
// Until PB-158 the server marked every enemy piece `revealedRound` and shipped all of them; the
// page then drew only the bar-local ones. That made the reveal a client promise: any client (or
// anyone reading a WebSocket frame) could see the whole enemy board for the round. This module
// keeps the bar's span on the server, so `forSeat` decides what leaves the process.
//
// The geometry is NOT re-derived here. config `intel.scanBarCells`/`scanCrossSeconds` are the
// measured numbers, and pb158_intel_server pins them equal to `scanSpec()`. scanCovers/scanState
// are the same pure functions the page draws with, imported from public/ so the two can never
// disagree about where the bar is.

import { CELL_W } from "./board.mjs";
import { rules } from "./rules.mjs";
import { scanSpec, scanState } from "../public/scan.mjs";

function scanConfig() {
  const intel = (rules() && rules().intel) || {};
  const spec = scanSpec(CELL_W);
  const barCells = Number(intel.scanBarCells);
  const crossSeconds = Number(intel.scanCrossSeconds);
  if (Number.isFinite(barCells) && barCells > 0) spec.barCells = Math.max(1, Math.round(barCells));
  if (Number.isFinite(crossSeconds) && crossSeconds > 0) {
    spec.crossSeconds = crossSeconds;
    spec.cellsPerSecond = spec.boardW / crossSeconds;
    spec.holdSeconds = spec.barCells / spec.cellsPerSecond;
  }
  return spec;
}

// Arm a pass for one side. `now` is ms, the same clock the page gets; `round` is the round the
// scan was bought in, so a later pass cannot inherit an older reveal.
export function beginScan(match, side, now, round) {
  if (!match || (side !== "blue" && side !== "red")) return null;
  const spec = scanConfig();
  match.scan = {
    side,
    startedAt: Number(now) || 0,
    round: Number.isFinite(Number(round)) ? Number(round) : Number(match.round) || 0,
    boardW: spec.boardW,
  };
  return match.scan;
}

export function clearScan(match) {
  if (match) delete match.scan;
}

// The pass for this reader, or null when there is none (or it belongs to the other seat/done).
export function scanStateFor(match, side, now) {
  const scan = match && match.scan;
  if (!scan || scan.side !== side) return null;
  const state = scanState(scan.startedAt, Number(now) || 0, scan.boardW || CELL_W);
  return { scan, state };
}

// Is a pass running for this reader (or for anyone in the room)? The lobby samples a running
// pass on its own cadence: a round is 5 s at the shipped speed and the bar crosses in 15.85 s, so
// a payload per ROUND would sample one 20-column slice per 100 columns and most scanned units
// would never be sent at all. The reveal is continuous in the original, so the transport is too.
export function scanActiveFor(match, side, now) {
  const active = scanStateFor(match, side, now);
  return Boolean(active && !active.state.done);
}

export function scanAnyActive(match, now) {
  const scan = match && match.scan;
  if (!scan) return false;
  return !scanState(scan.startedAt, Number(now) || 0, scan.boardW || CELL_W).done;
}

// Is this unit's revealed column under the bar? Returns:
//   null  - the active scan is not this unit's reveal, so callers keep the old rule;
//   true  - the bar covers the column, the unit may be sent;
//   false - the bar has passed/not reached it, or the pass is over: the unit must not be sent.
export function scanGate(match, side, unit, now) {
  const active = scanStateFor(match, side, now);
  if (!active || !unit) return null;
  // Only the pieces the intel use marked belong to this pass. A satellite reveal sets the same
  // field without arming a scan, and sight is decided before this gate is consulted.
  if (Number(unit.revealedRound) !== Number(active.scan.round)) return null;
  if (active.state.done) return false;
  return spanCovers(unit.x, active.state, active.scan.boardW || CELL_W);
}

// The server's span is the plain interval [lead - barCells, lead): the bar begins fully off the
// left edge and leaves fully off the right, so at t=0 and at the end no column is covered. This is
// deliberately NOT `scanCovers` from public/scan.mjs, whose wrap test paints a copy at the seam
// (PB-159 is the client-side fix for that extra strip). Sending the wrap copy would hand the
// scanner the far edge at pass start, which Q51's frames never show.
export function spanCovers(x, state, boardW) {
  if (!state || !Number.isFinite(state.lead) || !Number.isFinite(state.trail)) return false;
  const width = Math.max(1, Math.floor(Number(boardW) || CELL_W));
  const n = ((Math.trunc(Number(x) || 0) % width) + width) % width;
  return n >= state.trail && n < state.lead;
}
