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

// PB-223, the 1986 arm. The PM's live failure was era 1986, where `capitalVisible` already returns
// true - so the capital gate cannot be its cause. Measured on live beb0893 (intel bought at round 4,
// speed 6, bot match, 135 full frames): the ack said `reveals: 6`, and the six pieces that reached
// the wire all did so inside ordinary sight. The bar, meanwhile, needs 15.85 s to cross (Q51) and
// was still off the left edge when the purchase round ended - and the reveal was gated on
// `revealedRound >= match.round`, so it expired 0.6 s after it was paid for. This arm advances the
// round past the purchase and then reads the view while the bar covers a column: a pass's lifetime
// is the bar's, not the round's.
function barAt(match, lead) {
  const spec = scanSpec(320);
  return Number(match.scan.startedAt) + Math.round((lead / spec.cellsPerSecond) * 1000);
}

function scanBoard(era, round) {
  const match = openMatch(era, []);
  match.clock = "running";
  match.round = round;
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.seen = {};
  match.capitals = { blue: { x: 0, y: 15 }, red: { x: 260, y: 123 } };
  match.sites = [{ id: 10, name: "Home", kind: "city", owner: "blue", x: 0, y: 15 }];
  return match;
}

function twoPieces(match) {
  return [
    { id: "blue:home", side: "blue", domain: "land", kind: "tank", x: 0, y: 15, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1, strength: 100 },
    { id: "red:far", side: "red", domain: "land", kind: "tank", x: 100, y: 120, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1, strength: 100 },
    { id: "red:far2", side: "red", domain: "land", kind: "tank", x: 260, y: 123, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1, strength: 100 },
  ];
}

function ids(view) {
  return view.pieces.map((entry) => entry.id);
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

  // --- the pass outlives its round (the 1986 arm PM's play-test hit) -------------------------
  // Same board shape for both eras: buy at round 10, then advance the match to round 40 - far past
  // the purchase round, still inside the 15.85 s crossing - and read the view at the instant the
  // bar covers red:far's own column (100). On the pre-fix code this arm is the defect: the reveal
  // was gated on `revealedRound >= match.round` (10 >= 40 false), so the piece was not sent.
  for (const era of ["1986", "9999"]) {
    const late = scanBoard(era, 10);
    late.pieces = twoPieces(late);
    const bought = useTool(late, "blue", "intel");
    if (bought.error) fail("intel was refused in era " + era + ": " + bought.error);
    const event = bought.events.find((entry) => entry.type === "intel");
    if (!event || event.reveals !== 2) {
      fail("intel's count in era " + era + " is not the enemy count: " + JSON.stringify(event));
    }
    late.round = 40;
    const covered = ids(forSeat(late, "blue", barAt(late, 110)));
    if (!covered.includes("red:far")) {
      fail("era " + era + ": the bar covered red:far at column 100 in round 40, after a round-10 purchase, and it was not sent: " + covered.join(","));
    }
    if (covered.includes("red:far2")) {
      fail("era " + era + ": the bar was at columns 90..110 and sent the piece at 260: " + covered.join(","));
    }
    // ... and the pass still ends: at the end of the crossing nothing scanned is sent.
    const ended = ids(forSeat(late, "blue", barAt(late, 340)));
    if (ended.some((id) => id.startsWith("red:"))) {
      fail("era " + era + ": the reveal outlived the bar: " + ended.join(","));
    }
    // ... and it does not open early: at t=0 the bar is off the left edge.
    const early = ids(forSeat(late, "blue", Number(late.scan.startedAt)));
    if (early.some((id) => id.startsWith("red:"))) {
      fail("era " + era + ": a scan sent an enemy before the bar reached it: " + early.join(","));
    }
  }

  // The ordinary-sight half of the 9999 ruling is unchanged: with no reveal at all, the enemy stays
  // hidden even at round 40 while the capital has not been found (PM 8820 §4: keep the gate).
  const concealed = scanBoard("9999", 40);
  concealed.pieces = twoPieces(concealed);
  const plain = ids(forSeat(concealed, "blue", Date.now()));
  if (plain.some((id) => id.startsWith("red:"))) {
    fail("ordinary sight in 9999 sent an enemy with the capital not found: " + plain.join(","));
  }
}
