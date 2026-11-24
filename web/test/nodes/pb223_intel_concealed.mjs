// PB-223: in the concealed era an intel scan charged, counted and drew a bar — and sent nothing.
//
// What fails if this is removed: `forSeat`'s whole enemy loop sits behind `if (!hidden)` where
// `hidden = !capitalVisible(...)`. In era 9999 the enemy capital is deliberately withheld until one
// of the seat's own pieces has seen it, so a paid intel scan stamped every enemy piece, reported
// "N units revealed", and then nothing crossed the gate. Measured on the live fog playtest (b5d02f1)
// as "7 units revealed, no red piece over 16 rounds".
//
// The manual does not hang the bar on the capital: p.31 "A single bar runs across the screen, beneath
// which all units are revealed — including your opponents'". So the gate keeps withholding ORDINARY
// SIGHT (that is the concealed era's own rule) and a reveal still crosses it.
//
// The discriminating arm is in this file: the same board, the same scan, one boolean (`match.seen`).
// Every reading is taken at the moment the bar covers that piece's own column, so PB-158's scan gate
// is never what is being measured.

import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { scanSpec } from "../../public/scan.mjs";
import { useTool } from "../../server/late.mjs";

export const name = "pb223_intel_concealed";

function fail(message) {
  throw new Error("node test pb223_intel_concealed: " + message);
}

function piece(id, side, domain, kind, x, y) {
  return {
    id, side, domain, kind, x, y,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1,
  };
}

function fresh() {
  const match = openMatch("9999", []);
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.round = 4;
  match.seen = {};
  match.capitals = { blue: { x: 79, y: 44 }, red: { x: 260, y: 90 } };
  match.sites = [
    { id: 10, name: "Home", kind: "city", owner: "blue", x: 79, y: 44 },
    { id: 12, name: "Theirs", kind: "city", owner: "red", x: 260, y: 90 },
  ];
  return match;
}

function ids(view) {
  return view.pieces.map((entry) => entry.id);
}

export async function run() {
  const match = fresh();
  const own = piece("blue:land", "blue", "land", "infantry", 80, 44);
  const neighbour = piece("red:neighbour", "red", "land", "infantry", 81, 45); // inside blue's sight
  const far1 = piece("red:far1", "red", "land", "infantry", 100, 50);
  const far2 = piece("red:far2", "red", "sea", "cruiser", 140, 70);
  match.pieces = [own, neighbour, far1, far2];

  // --- the concealed era still withholds ordinary sight --------------------------------------
  const before = forSeat(match, "blue", Date.now());
  const beforeIds = ids(before);
  if (beforeIds.some((id) => id.startsWith("red:"))) {
    fail("the concealed era sent an enemy before any reveal: " + beforeIds.join(","));
  }
  if (before.capitals && before.capitals.red) fail("the enemy capital was sent while unknown");
  if (!(before.notes || []).some((note) => /has not been found/i.test(String(note.text || note)))) {
    fail("the seat was not told the enemy has not been found: " + JSON.stringify(before.notes));
  }
  if ((before.sites || []).some((site) => site.owner === "red")) {
    fail("an enemy site was sent while the enemy is concealed");
  }

  // --- the scan is paid for and stamps every enemy ------------------------------------------
  const scan = useTool(match, "blue", "intel");
  if (scan.error) fail("intel was refused: " + scan.error);
  const event = scan.events.find((entry) => entry.type === "intel");
  if (!event) fail("intel produced no event: " + JSON.stringify(scan.events));
  if (event.reveals !== 3) fail("intel's count is not the enemy count: " + event.reveals);
  const stamped = match.pieces.filter((entry) => entry.side === "red" && entry.revealedRound === match.round);
  if (stamped.length !== 3) fail("intel stamped " + stamped.length + " of 3 enemies");

  // --- the reveal crosses the gate, one column at a time (PB-158's geometry intact) ---------
  const spec = scanSpec(320);
  const atColumn = (x) => Number(match.scan.startedAt) + Math.round((x / spec.cellsPerSecond) * 1000) + 120;
  for (const unit of [neighbour, far1, far2]) {
    const covered = ids(forSeat(match, "blue", atColumn(unit.x)));
    if (!covered.includes(unit.id)) {
      fail("the bar covered " + unit.id + " at column " + unit.x + " and it was not sent: " + covered.join(","));
    }
    // ... and it is not sent before its own column (t = 0 has the bar off the left edge).
    const early = ids(forSeat(match, "blue", Number(match.scan.startedAt)));
    if (early.includes(unit.id)) {
      fail("intel sent " + unit.id + " before the bar reached its column: " + early.join(","));
    }
  }
  // The gate's own withholding is unchanged: the capital, the enemy sites and the note.
  const during = forSeat(match, "blue", Date.now());
  if (during.capitals && during.capitals.red) fail("the scan leaked the enemy capital");
  if ((during.sites || []).some((site) => site.owner === "red")) fail("the scan leaked an enemy site");
  if (!(during.notes || []).some((note) => /has not been found/i.test(String(note.text || note)))) {
    fail("the scan removed the 'not found' note");
  }

  // --- the discriminating arm: same board, same scan, one boolean ---------------------------
  const open = fresh();
  open.pieces = [piece("blue:land", "blue", "land", "infantry", 80, 44), piece("red:neighbour", "red", "land", "infantry", 81, 45)];
  const openScan = useTool(open, "blue", "intel");
  if (openScan.error) fail("intel was refused on the control board: " + openScan.error);
  const gated = ids(forSeat(open, "blue", Number(open.scan.startedAt) + 20));
  if (gated.some((id) => id.startsWith("red:"))) {
    fail("a scan sent an enemy before the bar covered it on the control board: " + gated.join(","));
  }
  // With the capital seen, ordinary sight works again: the neighbour is a cell away.
  open.seen.blue = true;
  const openView = forSeat(open, "blue", Date.now());
  if (!ids(openView).includes("red:neighbour")) {
    fail("a red piece a cell away was not sent once the enemy was found: " + ids(openView).join(","));
  }
}
