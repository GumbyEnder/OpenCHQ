// The endgame, engine-side: a capital can be taken, and taking the era's whole capital set
// ends the match (B-3b). A pair is not the rule - 1918 has three seats, 1942 six, 1986 four.
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
  const blue = match.capitals.blue;
  const red = match.capitals.red;
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

  // And the win: the era's WHOLE set, not two fixed seats. 1986's four capitals are London,
  // Tokyo, Washington and Moscow; the file hands three of them to blue and the capture above took
  // the fourth, so all four carry blue and the match is won. Prove the boundary too: put one of the
  // four back in red's hands and checkWin must return null, or the check is still reading a pair.
  const winSite = match.sites.find((site) => site.x === blue.x && site.y === blue.y && site.kind === "capital");
  if (winSite) winSite.owner = "blue";
  const set = (match.capitalSet && match.capitalSet.list) || [];
  if (set.length !== 4) fail("1986's capital set is " + set.length + ", expected four");
  // The same join the win check makes: holderOf reads the site record by id, so read it that way
  // here. Two of 1986's four set entries sit on sites of kind "city" (London id 10, Tokyo id 35),
  // so a lookup keyed on kind === "capital" finds nothing and would report them as unheld.
  const siteOf = (capital) => match.sites.find((site) => Number(site.id) === Number(capital.siteId));
  const owners = set.map((capital) => { const site = siteOf(capital); return site ? site.owner : "NO-SITE"; });
  if (!owners.every((owner) => owner === "blue")) fail("blue does not hold all four of 1986's capitals: " + JSON.stringify(owners));
  const winner = checkWin(match);
  if (winner !== "blue") fail("holding all four capitals did not win: " + winner);
  const london = set.find((capital) => capital.name !== "Moscow");
  if (!london) fail("no second blue capital to take back off the set");
  const londonSite = siteOf(london);
  const keptOwner = londonSite.owner;
  londonSite.owner = "red";
  if (checkWin(match) !== null) fail("three of 1986's four capitals won the match - the check still reads a pair");
  londonSite.owner = keptOwner;
  if (checkWin(match) !== "blue") fail("restoring the fourth capital did not restore the win");

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
    "holding the era's whole capital set is the win, and one seat short is not",
    "a ship does not hold a capital",
    "enemy troops near a capital raise an alarm once",
  ];
}
