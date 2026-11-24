// PB-222 clause 1, moved onto the piece by PB-224: a satellite's recon radius never carries an enemy
// submarine — pinned on the wire, not on the engine's return.
//
// What fails if this is removed: the satellite's per-round pass stamps every enemy piece inside its
// radius, view.forSeat's revealedRound branch then beats the sub rule in visibleEnemy, and the pass
// sends a submarine with its id AND its position inside the seat's frame. The manual keeps the sub
// out of it: L326 "except submarines, which remain hidden", L329 "Submarines are always hidden from
// air and satellite scanning", L936 "all enemy units are exposed except submarines".
//
// PB-224 (PM 8905 §2) changed the MECHANISM, not the rule: the reveal is no longer a worldwide tool
// (`useTool("satellite")`, retired) but the per-round pass of an owned satellite piece with a radius.
// The hull and the sub in this fixture sit INSIDE the same radius, so a correct build reveals exactly
// one of them; a build that still stamps everything reds the count, the stamp and the wire together.
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
import { buySatellite, satelliteRules, tickSatellites } from "../../server/satellite.mjs";

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
// The opening satellite pair (PM 8913 §2) is pinned in pb224_satellite_unit; this fixture starts
// from an EMPTY orbit so "before one was bought" measures the buy and not the p.12 opening.
function fresh() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.round = 7;
  match.satellites = [];
  return match;
}

const SUB_X = 242;
const SUB_Y = 22;
const HULL_X = 240;
const HULL_Y = 20;

export async function run() {
  const match = fresh();
  const own = piece("blue:inf-1", "blue", "land", "infantry", 10, 10);
  const sub = piece("red:sub-9", "red", "sea", "submarine", SUB_X, SUB_Y);
  const hull = piece("red:cruiser-4", "red", "sea", "cruiser", HULL_X, HULL_Y);
  match.pieces = [own, sub, hull];

  // The fixture is only a fair test if the submarine is inside the radius: assert it, so a radius
  // change cannot make this node pass by accident.
  const radius = satelliteRules().scanRadius;
  const subDistance = Math.max(Math.abs(SUB_X - HULL_X), Math.abs(SUB_Y - HULL_Y));
  if (subDistance > radius) fail("the submarine sits outside the scan radius: " + subDistance + " > " + radius);

  // --- before the pass, neither enemy is on the wire ---------------------------------------
  const before = forSeat(match, "blue");
  const beforeIds = before.pieces.map((entry) => entry.id);
  if (beforeIds.includes("red:sub-9") || beforeIds.includes("red:cruiser-4")) {
    fail("an enemy was sent before any reveal: " + beforeIds.join(","));
  }
  if ((before.satellites || []).length !== 0) fail("a satellite was in orbit before one was bought");

  // --- the pass shows the hull and never the sub -------------------------------------------
  const bought = buySatellite(match, "blue", HULL_X, HULL_Y);
  if (bought.error) fail("a recon satellite was refused with a hull on the board: " + bought.error);
  const events = tickSatellites(match);
  const event = events.find((entry) => entry.type === "satellite");
  if (!event) fail("the pass produced no satellite event: " + JSON.stringify(events));

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
  // PB-224 AC5: the satellite itself rides the frame, for the seat that bought it.
  if (!(wire.satellites || []).some((sat) => sat.id === bought.satellite.id)) {
    fail("the bought satellite is not in the seat's own frame");
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

  // --- a pass over only a submarine reveals nothing, and says nothing -----------------------
  const submerged = fresh();
  submerged.pieces = [piece("blue:inf-2", "blue", "land", "infantry", 10, 10),
    piece("red:sub-2", "red", "sea", "submarine", 150, 90)];
  const satBought = buySatellite(submerged, "blue", 150, 90);
  if (satBought.error) fail("a satellite over a submarine was refused: " + satBought.error);
  const subEvents = tickSatellites(submerged);
  if (subEvents.some((entry) => entry.type === "satellite")) {
    fail("a pass over only a submarine produced a reveal: " + JSON.stringify(subEvents));
  }
  if (submerged.pieces[1].revealedRound !== undefined) fail("a sub-only pass stamped the submarine");
  const shown = forSeat(submerged, "blue").pieces.map((entry) => entry.id);
  if (shown.includes("red:sub-2")) fail("a sub-only pass still sent the submarine: " + shown.join(","));

  // --- the retired tool is not a second door ------------------------------------------------
  if (!useTool(fresh(), "blue", "satellite").error) fail("the retired satellite tool still runs");
  const kitNames = kitBriefing(fresh(), "blue").map((entry) => entry.name);
  if (kitNames.includes("satellite")) fail("the kit still offers the retired satellite tool");
}
