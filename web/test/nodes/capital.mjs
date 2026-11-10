// The endgame, engine-side: a capital can be taken, and taking both ends the match.
//
// A thousand played rounds ended with 162 cities against 69 and no winner, so the win path has to
// be proven directly: put an enemy piece next to a capital, order it in, tick, and read the result.

import { alarmText } from "../../public/command.mjs";
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch, checkWin } from "../../server/tick.mjs";
import { CELL_W } from "../../server/board.mjs";

export const name = "capital";

function fail(message) {
  throw new Error("node test capital: " + message);
}

function openCellBeside(match, target) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = (target.x + dx + CELL_W) % CELL_W;
    const y = target.y + dy;
    if (y < 0 || y > 135) continue;
    const taken = (match.pieces || []).some((piece) => piece.x === x && piece.y === y);
    if (taken) continue;
    return { x, y };
  }
  return null;
}

export async function run() {
  // openMatch(era, sites): without the site list a match has no capitals to hold at all, which is
  // how the first version of this test failed while the board was fine.
  const match = openMatch("1986", matchSites("1986"));
  match.clock = "running";
  const blue = match.capitals.blue[0];
  const red = match.capitals.red[0];
  if (!blue || !red) fail("the 1986 board has no capitals");

  // One blue piece, parked beside the enemy capital, and the enemy left with nothing on it.
  match.pieces = [
    { id: "blue:land", side: "blue", domain: "land", kind: null, x: blue.x, y: blue.y, path: [] },
  ];
  const beside = openCellBeside(match, red);
  if (!beside) fail("no open cell beside the red capital");
  match.pieces[0].x = beside.x;
  match.pieces[0].y = beside.y;

  const order = issueOrder(match, "blue", "blue:land", red.x, red.y);
  if (!order || order.error) fail("the order onto the capital was refused: " + JSON.stringify(order));

  let captured = null;
  for (let i = 0; i < 12 && !captured; i++) {
    const ticked = tickMatch(match);
    const event = (ticked.events || []).find((e) => e.type === "capture" && e.kind === "capital");
    if (event) captured = event;
  }
  const capitalSite = match.sites.find((site) => site.x === red.x && site.y === red.y && site.kind === "capital");
  if (!capitalSite) fail("no capital site sits on the red capital cell");
  if (capitalSite.owner !== "blue") fail("the blue piece stands on the red capital and it is not blue's: owner=" + capitalSite.owner);

  // And the win: both capitals held by blue.
  const winSite = match.sites.find((site) => site.x === blue.x && site.y === blue.y && site.kind === "capital");
  if (winSite) winSite.owner = "blue";
  const winner = checkWin(match);
  if (winner !== "blue") fail("holding both capitals did not win: " + winner);

  // A ship does not hold a capital. A played match once ended at round 27 because a destroyer
  // sailed onto Moscow and the win check counted it.
  const harbour = openMatch("1986", matchSites("1986"));
  harbour.clock = "running";
  harbour.pieces = [
    { id: "blue:land", side: "blue", domain: "land", kind: null, x: blue.x, y: blue.y, path: [] },
    { id: "blue:sea", side: "blue", domain: "sea", kind: null, x: red.x, y: red.y, path: [] },
  ];
  const redSite = harbour.sites.find((site) => site.kind === "capital" && site.x === red.x && site.y === red.y);
  if (redSite) redSite.owner = "red";
  if (checkWin(harbour) !== null) fail("a ship on the enemy capital won the match");

  // The alarm: an enemy land piece inside the sight radius of your capital says so, once, and a
  // new closer approach says so again.
  const watcher = openMatch("1986", matchSites("1986"));
  watcher.clock = "running";
  watcher.pieces = [
    { id: "blue:land", side: "blue", domain: "land", kind: null, x: blue.x, y: blue.y, path: [] },
    { id: "red:land", side: "red", domain: "land", kind: null, x: blue.x + 5, y: blue.y, path: [] },
  ];
  const alarmTick = tickMatch(watcher);
  const threat = (alarmTick.events || []).find((e) => e.type === "threat" && e.side === "blue");
  if (!threat) fail("no threat event with red troops five cells from the blue capital");
  if (threat.distance !== 5) fail("the threat distance reads " + threat.distance);
  const sentence = alarmText(threat);
  if (!/5 cells from/.test(sentence)) fail("the alarm sentence reads: " + sentence);
  // Standing still or backing off does not repeat it every round.
  const quiet = tickMatch(watcher);
  if ((quiet.events || []).some((e) => e.type === "threat")) fail("the alarm repeated without a closer approach");

  return [
    "a capital is taken by standing on it",
    "holding both capitals is the win",
    "a ship does not hold a capital",
    "enemy troops near a capital raise an alarm once",
  ];
}
