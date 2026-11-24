// Node test for PB-158: an intel scan's enemy positions stay on the server.
//
// What breaks if this node is removed: the an intel scan once again marks every enemy piece and
// `forSeat` ships all of them, so any client (or anyone reading a WebSocket frame) has the whole
// enemy board for the round while the page draws only a bar-local slice. The card's requirement is
// payload-level: at elapsed t the scanner's view contains exactly the enemy pieces whose column is
// in [lead - barCells, lead), and none of the others appears anywhere in the JSON.
//
// Rule: MANUAL p.31 (units are revealed beneath the moving bar) and the Q51 MEASURED geometry in
// web/public/scan.mjs (20 of 320 columns, 15.85 s crossing, no lingering). The server's copy of
// those two numbers lives in config `intel.scanBarCells` / `scanCrossSeconds` and is pinned equal
// to scanSpec() below; the bar's span itself is computed by the same scanState() the page draws.

import { openMatch } from "../../server/match.mjs";
import { useTool } from "../../server/late.mjs";
import { forSeat } from "../../server/view.mjs";
import { scanSpec, scanState } from "../../public/scan.mjs";
import { scanActiveFor, scanAnyActive, scanGate, spanCovers } from "../../server/scan.mjs";
import { rules } from "../../server/rules.mjs";
// PB-224: the satellite is a piece now, so its reveal is produced by the piece's own round.
import { buySatellite, tickSatellites } from "../../server/satellite.mjs";

export const name = "pb158_intel_server";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function tank(id, side, x, y) {
  return {
    id, side, domain: "land", kind: "tank", x, y, path: [], pace: 1,
    facing: null, fighting: null, shots: 0, movedRound: -1, strength: 100,
  };
}

// Blue has one piece at the west edge and no enemy within sight; every red piece is placed at a
// column this test changes, so sight never explains a reveal.
function board() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.round = 7;
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.sites = [
    { id: 10, name: "New York", x: 0, y: 15, kind: "city", type: 4, owner: "blue" },
  ];
  match.pieces = [
    tank("blue:home", "blue", 0, 15),
    tank("red:a", "red", 100, 120),
    tank("red:b", "red", 180, 121),
    tank("red:c", "red", 200, 122),
    tank("red:d", "red", 260, 123),
  ];
  match.capitals = { blue: { x: 0, y: 15 }, red: { x: 260, y: 123 } };
  return match;
}

// The wall-clock instant at which the bar's leading edge reaches `lead` columns, in ms.
function at(match, lead) {
  const spec = scanSpec(320);
  return Number(match.scan.startedAt) + Math.round((lead / spec.cellsPerSecond) * 1000);
}

export async function run() {
  // --- the server's geometry is the page's measured geometry --------------------------
  const spec = scanSpec(320);
  const intel = rules().intel || {};
  eq("config bar width matches the Q51 measurement", Number(intel.scanBarCells), spec.barCells);
  eq("config crossing time matches the Q51 measurement", Number(intel.scanCrossSeconds), spec.crossSeconds);
  eq("the bar is 20 of 320 columns", spec.barCells, 20);

  // --- intel arms a pass and still tells the opponent --------------------------------
  const match = board();
  const used = useTool(match, "blue", "intel");
  if (used.error) fail("intel was refused in 1986: " + used.error);
  if (!used.events.some((event) => event.type === "intel_seen" && event.side === "red")) {
    fail("intel no longer tells the opponent it was read");
  }
  if (!match.scan || match.scan.side !== "blue") fail("the intel use did not arm a server-side pass");
  if (match.scan.round !== match.round) fail("the pass was not stamped with the round it was bought in");
  // The lobby samples a running pass on its own 250 ms cadence; the predicate it reads is this.
  if (!scanAnyActive(match, match.scan.startedAt)) fail("a fresh pass does not read as active");
  if (!scanActiveFor(match, "blue", match.scan.startedAt)) fail("the scanner's pass does not read as active");
  if (scanActiveFor(match, "red", match.scan.startedAt)) fail("the opponent's read armed the scanner's pass");
  if (scanAnyActive(match, at(match, 340))) fail("a finished pass still reads as active");

  // --- at t, exactly the pieces under the bar ----------------------------------------
  // lead 110 -> span [90, 110): red:a at 100 is in, b/c/d are out.
  const mid = at(match, 110);
  const state = scanState(match.scan.startedAt, mid, 320);
  if (Math.abs(state.lead - 110) >= 1 || Math.abs(state.trail - 90) >= 1) {
    fail("the fixture is not mid-pass at lead 110: lead " + state.lead + ", trail " + state.trail);
  }
  eq("the server sends exactly the piece under the bar",
    forSeat(match, "blue", mid).pieces.map((p) => p.id).sort(),
    ["blue:home", "red:a"]);

  // The payload's own bytes, not just its parsed shape: no out-of-bar red id anywhere.
  const payload = JSON.stringify(forSeat(match, "blue", mid));
  for (const id of ["red:b", "red:c", "red:d"]) {
    if (payload.includes('"' + id + '"')) fail("an out-of-bar enemy piece leaked into the payload: " + id);
  }

  // --- the span advances with the clock ----------------------------------------------
  eq("lead 195 covers [175,195), so red:b only",
    forSeat(match, "blue", at(match, 195)).pieces.map((p) => p.id).sort(),
    ["blue:home", "red:b"]);
  eq("lead 210 covers [190,210), so red:c only",
    forSeat(match, "blue", at(match, 210)).pieces.map((p) => p.id).sort(),
    ["blue:home", "red:c"]);
  eq("lead 270 covers [250,270), so red:d only",
    forSeat(match, "blue", at(match, 270)).pieces.map((p) => p.id).sort(),
    ["blue:home", "red:d"]);

  // --- no wrap copy at pass start, no lingering after the trailing edge --------------
  eq("at t=0 the bar is fully off the left, so nothing is sent",
    forSeat(match, "blue", match.scan.startedAt).pieces.map((p) => p.id).sort(),
    ["blue:home"]);
  eq("once the pass is over, nothing scanned is still sent",
    forSeat(match, "blue", at(match, 340)).pieces.map((p) => p.id).sort(),
    ["blue:home"]);
  if (spanCovers(310, scanState(match.scan.startedAt, match.scan.startedAt, 320), 320)) {
    fail("the server span wraps to the right edge at pass start");
  }

  // --- a satellite's reveal arms no bar, and is anchored to the piece (PB-224) ----------
  // The satellite used to be a worldwide tool; it is a unit with a radius now, so this arm proves
  // the two halves that survive: the reveal arms no intel bar, and it reaches only the enemies
  // inside the piece's own scan radius (the red tank it was placed over, not the three far ones).
  const quiet = board();
  const bought = buySatellite(quiet, "blue", 100, 120);
  if (bought.error) fail("a recon satellite was refused: " + bought.error);
  const satEvents = tickSatellites(quiet);
  if (quiet.scan) fail("a satellite pass armed an intel bar");
  if (!satEvents.some((event) => event.type === "satellite")) fail("the satellite revealed nothing: " + JSON.stringify(satEvents));
  eq("a satellite reveals only the enemies inside its own radius",
    forSeat(quiet, "blue", Date.now()).pieces.filter((p) => p.side === "red").map((p) => p.id), ["red:a"]);
  eq("no scan means no gate", scanGate(quiet, "blue", quiet.pieces[1], Date.now()), null);
  eq("the retired satellite tool is not a door", Boolean(useTool(board(), "blue", "satellite").error), true);

  // --- the scanned side's own view is untouched --------------------------------------
  eq("the scanned seat still sees all four of its own pieces",
    forSeat(match, "red", at(match, 210)).pieces.filter((p) => p.side === "red").length, 4);
}
