// PB-222 clause 1: a satellite pass never carries an enemy submarine — pinned on the wire, not on
// the engine's return.
//
// What fails if this is removed: `useTool("satellite")` stamps every enemy piece, view.forSeat's
// revealedRound branch then beats the sub rule in visibleEnemy, and the pass sends a submarine with
// its id AND its position inside the seat's frame — the live playtest frame that listed all 8 red
// units worldwide (match 238994d45b223bfa, red:sea at (79,74)). The manual keeps the sub out of it:
// L326 "except submarines, which remain hidden", L329 "Submarines are always hidden from air and
// satellite scanning", L936 "all enemy units are exposed except submarines".
//
// The frame asserted here is `forSeat(match, "blue")` — the object the socket sends — so a fix that
// only skips the sub in a count, or only filters in the page, still reds this node.
//
// Intel is the control arm: L329 is about air and satellite scanning, not the p.31 bar, so intel
// keeps its own stamp and its sub does appear once the bar covers its column.

import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { scanSpec } from "../../public/scan.mjs";
import { kitBriefing, useTool } from "../../server/late.mjs";

export const name = "pb222_satellite_sub";

function fail(message) {
  throw new Error("node test pb222_satellite_sub: " + message);
}

function piece(id, side, domain, kind, x, y) {
  return {
    id, side, domain, kind, x, y,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1,
  };
}

// Era 1986, not 9999: the concealed start's capital gate would withhold the whole enemy loop and
// the pass would look correct for the wrong reason (see PB-223).
function fresh() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.round = 7;
  return match;
}

const SUB_X = 200;
const SUB_Y = 100;
const HULL_X = 240;
const HULL_Y = 20;

export async function run() {
  const match = fresh();
  const own = piece("blue:inf-1", "blue", "land", "infantry", 10, 10);
  const sub = piece("red:sub-9", "red", "sea", "submarine", SUB_X, SUB_Y);
  const hull = piece("red:cruiser-4", "red", "sea", "cruiser", HULL_X, HULL_Y);
  match.pieces = [own, sub, hull];

  // --- before the pass, neither enemy is on the wire ---------------------------------------
  const before = forSeat(match, "blue");
  const beforeIds = before.pieces.map((entry) => entry.id);
  if (beforeIds.includes("red:sub-9") || beforeIds.includes("red:cruiser-4")) {
    fail("an enemy was sent before any reveal: " + beforeIds.join(","));
  }

  // --- the pass shows the hull and never the sub -------------------------------------------
  const pass = useTool(match, "blue", "satellite");
  if (pass.error) fail("a satellite pass was refused with a hull on the board: " + pass.error);
  const event = pass.events.find((entry) => entry.type === "satellite");
  if (!event) fail("the pass produced no satellite event: " + JSON.stringify(pass.events));

  // The payload pin comes first: the frame the seat receives must not carry the sub at all. Any
  // engine-side leak (a missing kind test, or a stamp loop left over the unfiltered set) reds here.
  const wire = forSeat(match, "blue");
  const wireIds = wire.pieces.map((entry) => entry.id);
  if (!wireIds.includes("red:cruiser-4")) {
    fail("the satellite pass did not reveal the surface hull: " + wireIds.join(","));
  }
  if (wireIds.includes("red:sub-9")) {
    fail("the satellite pass sent the submarine: " + wireIds.join(","));
  }
  // Not the id and not the position, anywhere in the frame.
  const text = JSON.stringify(wire);
  if (text.includes("red:sub-9")) fail("the submarine's id is somewhere in the wire frame");
  if (text.includes('"submarine"')) fail("the word submarine survived in the wire frame");
  for (const entry of wire.pieces) {
    if (Number(entry.x) === SUB_X && Number(entry.y) === SUB_Y) {
      fail("a piece sits on the submarine's cell in the wire frame: " + entry.id);
    }
  }
  if (wire.routes && Object.prototype.hasOwnProperty.call(wire.routes, "red:sub-9")) {
    fail("the submarine's route is in the wire frame");
  }

  // The mechanism, stated on the piece: the pass did not stamp the sub, and did stamp the hull.
  if (sub.revealedRound !== undefined) {
    fail("the satellite pass stamped the submarine: revealedRound=" + String(sub.revealedRound));
  }
  if (hull.revealedRound !== match.round) {
    fail("the satellite pass did not stamp the surface hull: " + String(hull.revealedRound));
  }
  // And the count the event carries is the number the frame shows, not the number on the board.
  if (event.reveals !== 1) fail("reveals must count the hull only, not the sub: " + event.reveals);

  // --- intel keeps its own stamp (L329 is air and satellite scanning, not the p.31 bar) ----
  const intel = useTool(match, "blue", "intel");
  if (intel.error) fail("intel was refused: " + intel.error);
  if (sub.revealedRound !== match.round) {
    fail("intel did not stamp the submarine: revealedRound=" + String(sub.revealedRound));
  }
  const cover = Number(match.scan && match.scan.startedAt) +
    Math.round((SUB_X / scanSpec(320).cellsPerSecond) * 1000) + 500;
  const scanned = forSeat(match, "blue", cover).pieces.map((entry) => entry.id);
  if (!scanned.includes("red:sub-9")) {
    fail("intel's bar never reached the submarine: " + scanned.join(","));
  }

  // --- a board with only a submarine has nothing for a pass to show, and is not charged ------
  const submerged = fresh();
  submerged.pieces = [piece("blue:inf-2", "blue", "land", "infantry", 10, 10),
    piece("red:sub-2", "red", "sea", "submarine", 150, 90)];
  const cashBefore = submerged.sides.blue.cash;
  const empty = useTool(submerged, "blue", "satellite");
  if (!empty.error) fail("a pass with only a submarine was accepted: " + JSON.stringify(empty));
  if (submerged.sides.blue.cash !== cashBefore) {
    fail("a refused pass charged the seat: " + cashBefore + " -> " + submerged.sides.blue.cash);
  }
  const row = kitBriefing(submerged, "blue").find((entry) => entry.name === "satellite");
  if (!row) fail("the kit lost its satellite row");
  if (row.allowed !== false) fail("the kit offers a pass with only a submarine on the board: " + JSON.stringify(row));
  if (!/submarine/i.test(row.text)) fail("the satellite row does not say submarines stay hidden: " + row.text);
  const shown = forSeat(submerged, "blue").pieces.map((entry) => entry.id);
  if (shown.includes("red:sub-2")) fail("a refused pass still sent the submarine: " + shown.join(","));
}
