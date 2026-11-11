// The opening bell for the two seats: who holds each capital at round 0, and what taking one does.
//
// R6 was overturned: the file's owner byte is a holder byte, so a capital opens held by the side
// CBR-TYPE.DTn names. That makes two things testable that were not before:
//
//   1. no seat starts the match having already won or lost - 1942 hands BOTH seats to blue, which
//      would be a round-0 blue win if "holds both" alone were the win;
//   2. taking one enemy capital flips exactly that site and nothing else.
//
// The win rule this pins: a side wins by holding both capitals AND having captured at least one -
// a seat it opened holding was not captured by it. 1918 opens Washington blue / Moscow red, 1986
// the same, 1942 opens both blue, 2023 opens both unowned.

import { CELL_W, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { checkWin, tickMatch } from "../../server/tick.mjs";
import { issueOrder } from "../../server/move.mjs";

export const name = "capital_open";

const ERAS = ["1918", "1942", "1986", "2023", "9999"];
// The opening each capture measured, straight off CBR-TYPE.DT0..2: Washington 62, Moscow 63.
const OPEN = {
  1918: { blue: "blue", red: "red" },
  1942: { blue: "blue", red: "blue" },
  1986: { blue: "blue", red: "red" },
  2023: { blue: null, red: null },
  9999: { blue: null, red: null },
};

function fail(message) {
  throw new Error("node test capital_open: " + message);
}

function owners(sites) {
  return sites.map((site) => site.id + ":" + (site.owner ?? ""));
}

function openCellBeside(match, target) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = (target.x + dx + CELL_W) % CELL_W;
    const y = target.y + dy;
    if (y < 0 || y > 135) continue;
    if ((match.pieces || []).some((piece) => piece.x === x && piece.y === y)) continue;
    return { x, y };
  }
  return null;
}

// One land piece beside a seat, ordered onto it, ticked until the capture lands.
function takeSeat(match, seat, side = "blue") {
  match.clock = "running";
  const beside = openCellBeside(match, seat);
  if (!beside) fail("no open cell beside " + seat.x + "," + seat.y);
  const unit = { id: side + ":probe", side, domain: "land", kind: null, x: beside.x, y: beside.y, path: [] };
  // Opening pieces park a land unit on each seat; the probe replaces them so the capture is the
  // only thing moving and a defender cannot turn the walk into a fight.
  match.pieces = [unit];
  const order = issueOrder(match, side, unit.id, seat.x, seat.y);
  if (!order || order.error) fail("the order onto the seat was refused: " + JSON.stringify(order));
  for (let i = 0; i < 12; i++) {
    const ticked = tickMatch(match);
    const event = (ticked.events || []).find((e) => e.type === "capture" && e.kind === "capital");
    if (event) return event;
  }
  return null;
}

export async function run() {
  const reported = {};

  for (const era of ERAS) {
    const sites = matchSites(era);
    if (!sites.length) fail(era + " has no sites");
    const match = openMatch(era, sites);
    seedOwners(match);

    // 1. The seats open held by the side the file names.
    const want = OPEN[era];
    const got = match.capitalOpen || {};
    for (const key of ["blue", "red"]) {
      if ((got[key] ?? null) !== want[key]) {
        fail(era + ": the " + key + " seat opened " + (got[key] ?? "unowned") + ", the file says " +
          (want[key] ?? "unowned"));
      }
    }
    const seatSites = match.sites.filter((site) => site.kind === "capital");
    if (seatSites.length !== 2) fail(era + " should carry two capital sites, has " + seatSites.length);
    for (const site of seatSites) {
      const key = site.name === "Washington" ? "blue" : "red";
      const held = site.owner === "blue" || site.owner === "red" ? site.owner : null;
      if (held !== want[key]) fail(era + ": " + site.name + " opened " + (held ?? "unowned") + ", the file says " + (want[key] ?? "unowned"));
    }

    // 2. No seat starts the match having already won or lost. 1942 is the reason this line exists:
    //    both seats are blue's, and a win that only counted ownership would end it at round 0.
    const round0 = checkWin(match);
    if (round0 !== null) fail(era + ": the match is already " + round0 + "'s at round 0");

    reported[era] = { blue: want.blue, red: want.red, win: round0 };
  }

  // 3. Taking one enemy capital flips exactly that site, and wins for the side that then holds both.
  const match = openMatch("1986", matchSites("1986"));
  seedOwners(match);
  const before = owners(match.sites);
  const redSeat = match.capitals.red;
  if (checkWin(match) !== null) fail("1986 is decided before the first order");
  const event = takeSeat(match, redSeat);
  if (!event) fail("the blue piece never captured the red capital");
  if (event.from !== "red") fail("the capture event says the seat was " + event.from + ", not red");
  const after = owners(match.sites);
  const changed = before.map((value, index) => (value === after[index] ? null : after[index])).filter(Boolean);
  if (changed.length !== 1) fail("one capture changed " + changed.length + " sites: " + JSON.stringify(changed));
  if (changed[0] !== String(redSeat && event.site) + ":blue") {
    fail("the capture changed " + changed[0] + ", not the red seat " + event.site + " to blue");
  }
  const win = checkWin(match);
  if (win !== "blue") fail("blue holds both seats and the win is " + win);

  // 4. 1942: blue opens holding both and has not won. Red taking Washington must not hand blue the
  //    match either - red holds one seat, blue the other, so nobody holds both. Red taking Moscow as
  //    well is two captures and the scenario is red's.
  const m42 = openMatch("1942", matchSites("1942"));
  seedOwners(m42);
  if (checkWin(m42) !== null) fail("1942 is blue's at round 0");
  const blueSeat = m42.capitals.blue;
  const redSeat42 = m42.capitals.red;
  if (!takeSeat(m42, blueSeat, "red")) fail("red never captured Washington in 1942");
  if (checkWin(m42) !== null) {
    fail("1942: red holding Washington and blue holding Moscow produced a " + checkWin(m42) + " win");
  }
  const m42b = openMatch("1942", matchSites("1942"));
  seedOwners(m42b);
  if (!takeSeat(m42b, m42b.capitals.blue, "red")) fail("red never captured Washington in 1942 (second run)");
  if (!takeSeat(m42b, redSeat42, "red")) fail("red never captured Moscow in 1942");
  const win42 = checkWin(m42b);
  if (win42 !== "red") fail("red holds both 1942 seats and the win is " + win42);

  console.log("capital owners at round 0: 1918 blue=" + reported["1918"].blue + " red=" + reported["1918"].red +
    " | 1942 blue=" + reported["1942"].blue + " red=" + reported["1942"].red +
    " | 1986 blue=" + reported["1986"].blue + " red=" + reported["1986"].red +
    " | 2023 unowned/unowned; no era decided at round 0");
  return reported;
}
