// Node test: "tick" (order 100) and "win" (order 210). Owner: A1.
//
// These drive tickMatch and checkWin directly, never the socket and never a timer: a round is
// whatever the caller asks for, so no test here sleeps or waits for an interval. Pieces are
// placed explicitly with an empty path, so the assertions hold whether move.mjs has landed yet
// or not - a piece standing still is not evidence either way, and the round counter is.
import { openMatch } from "../../server/match.mjs";
import { tickMatch, checkWin } from "../../server/tick.mjs";

export const name = "tick";

function piece(id, side, x, y, domain = "land") {
  return { id, side, domain, kind: null, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
}

function capitalSites(match) {
  return [
    { id: "site:blue-capital", name: "Washington", x: match.capitals.blue.x, y: match.capitals.blue.y, kind: "capital" },
    { id: "site:red-capital", name: "Moscow", x: match.capitals.red.x, y: match.capitals.red.y, kind: "capital" },
  ];
}

export async function run(ctx) {
  const fail = ctx.fail;

  // ---- tick: a held clock does nothing, five times over ----------------------------------
  // prove: "The harness holds a room for five direct ticks and sees no movement, then runs it
  // for one tick."
  const held = openMatch("1986");
  const heldBefore = JSON.stringify(held);
  for (let i = 0; i < 5; i++) {
    const out = tickMatch(held);
    if (out.match !== held) fail("a held tick returned a different match object: " + i);
    if (!Array.isArray(out.events)) fail("a held tick returned no events array: " + JSON.stringify(out.events));
    if (out.events.length !== 0) fail("a held tick emitted events: " + JSON.stringify(out.events));
  }
  if (held.round !== 0) fail("five held ticks moved the round to " + held.round);
  if (held.clock !== "held") fail("a held tick changed the clock to " + held.clock);
  if (held.over || held.winner) fail("a held tick ended the match: " + JSON.stringify({ over: held.over, winner: held.winner }));
  if (JSON.stringify(held) !== heldBefore) {
    fail("five held ticks changed the match: " + JSON.stringify({ before: heldBefore, after: JSON.stringify(held) }));
  }
  // economy.upkeep initialises a side's fuel; a held tick must not reach it at all.
  if (held.sides.blue.fuel !== null || held.sides.red.fuel !== null) {
    fail("a held tick ran upkeep: " + JSON.stringify({ blue: held.sides.blue.fuel, red: held.sides.red.fuel }));
  }

  // ---- tick: one running round advances exactly one round ---------------------------------
  const live = openMatch("1986");
  live.clock = "running";
  const first = tickMatch(live);
  if (first.match !== live) fail("a running tick returned a different match object");
  if (!Array.isArray(first.events)) fail("a running tick returned no events array");
  if (live.round !== 1) fail("one running tick produced round " + live.round + ", not 1");
  const second = tickMatch(live);
  if (live.round !== 2) fail("two running ticks produced round " + live.round + ", not 2");
  if (live.winner || live.over) fail("an untouched 1986 match ended on tick " + live.round);
  if (checkWin(live) !== null) fail("an untouched 1986 match reported a winner");

  // A single tick is one round, not two: hold, tick once, and the count moves by one only.
  live.clock = "held";
  const frozenAt = live.round;
  tickMatch(live);
  if (live.round !== frozenAt) fail("a held match advanced from " + frozenAt + " to " + live.round);
  live.clock = "running";
  tickMatch(live);
  if (live.round !== frozenAt + 1) fail("one tick advanced " + (live.round - frozenAt) + " rounds, not 1");

  // ---- win: the side that holds both capitals wins ---------------------------------------
  // prove: "The harness gives one side both capitals, ticks, and sees the winner and a frozen
  // board on the next tick."
  const shape = openMatch("1986");
  const match = openMatch("1986", capitalSites(shape));
  match.clock = "running";
  match.pieces = [
    piece("blue:land", "blue", match.capitals.blue.x, match.capitals.blue.y),
    piece("red:land", "red", match.capitals.red.x, match.capitals.red.y),
  ];
  if (checkWin(match) !== null) fail("one capital each was called a win: " + checkWin(match));
  tickMatch(match);
  if (match.winner !== null || match.over) fail("one capital each ended the match on tick " + match.round);

  // Blue marches onto Moscow; Washington stays blue's, recorded on the capital site.
  const washington = match.sites.find((site) => site.kind === "capital" && site.x === match.capitals.blue.x);
  if (!washington) fail("the match has no Washington site: " + JSON.stringify(match.sites));
  washington.owner = "blue";
  const redLand = match.pieces.find((unit) => unit.id === "red:land");
  redLand.x = match.capitals.red.x + 2; // the defender was met and is not on the capital
  const blueLand = match.pieces.find((unit) => unit.id === "blue:land");
  blueLand.x = match.capitals.red.x;
  blueLand.y = match.capitals.red.y;

  if (checkWin(match) !== "blue") fail("blue held both capitals but checkWin said " + checkWin(match));
  const ending = tickMatch(match);
  if (match.winner !== "blue") fail("the winning side was reported as " + JSON.stringify(match.winner));
  if (match.over !== true) fail("the match did not end: over=" + match.over);
  if (match.clock !== "held") fail("the ended match kept clock " + match.clock);
  if (!ending.events.some((event) => event && event.type === "win" && event.side === "blue")) {
    fail("no win event for blue: " + JSON.stringify(ending.events));
  }
  if (checkWin(match) !== "blue") fail("checkWin forgot the winner after the match ended");

  // ---- win: later ticks do not move, pay or burn ------------------------------------------
  match.sides.blue.cash = 0;
  match.sides.red.cash = 0;
  match.sides.blue.fuel = null;
  match.sides.red.fuel = null;
  const endedBefore = JSON.stringify(match);
  for (let i = 0; i < 3; i++) {
    const after = tickMatch(match);
    if (after.match !== match) fail("a tick after the win returned a different match object");
    if (after.events.length !== 0) fail("a tick after the win emitted events: " + JSON.stringify(after.events));
  }
  if (JSON.stringify(match) !== endedBefore) {
    fail("ticks after the win changed the board: " + JSON.stringify({ before: endedBefore, after: JSON.stringify(match) }));
  }
  // The same freeze applies to a match marked over at the top of a round, held or running.
  const alreadyOver = openMatch("1986");
  alreadyOver.round = 9;
  alreadyOver.clock = "running";
  alreadyOver.over = true;
  alreadyOver.winner = "red";
  const overBefore = JSON.stringify(alreadyOver);
  const quiet = tickMatch(alreadyOver);
  if (quiet.events.length !== 0) fail("a finished match emitted events: " + JSON.stringify(quiet.events));
  if (alreadyOver.round !== 9) fail("a finished match advanced to round " + alreadyOver.round);
  if (JSON.stringify(alreadyOver) !== overBefore) fail("a finished match changed: " + JSON.stringify(alreadyOver));

  // ---- win: recorded ownership alone, and contested or empty capitals hold nobody ---------
  const recorded = openMatch("1986", capitalSites(openMatch("1986")));
  recorded.pieces = [];
  if (checkWin(recorded) !== null) fail("an empty, unowned board reported " + checkWin(recorded));
  for (const site of recorded.sites) site.owner = "red";
  if (checkWin(recorded) !== "red") fail("red owned both capital sites but checkWin said " + checkWin(recorded));
  recorded.sites[1].owner = "blue";
  if (checkWin(recorded) !== null) fail("a split ownership of the capitals was called a win: " + checkWin(recorded));

  // Two sides on one capital cell is contested, and a contested cell wins nobody anything.
  const contested = openMatch("1986", capitalSites(openMatch("1986")));
  contested.pieces = [
    piece("blue:land", "blue", contested.capitals.red.x, contested.capitals.red.y),
    piece("red:land", "red", contested.capitals.red.x, contested.capitals.red.y),
  ];
  for (const site of contested.sites) site.owner = "blue";
  if (checkWin(contested) !== null) fail("a contested capital was handed to " + checkWin(contested));

  // 2023 opens with no pieces, so nothing is held and nothing is won.
  const empty = openMatch("2023");
  empty.clock = "running";
  tickMatch(empty);
  if (empty.round !== 1) fail("the empty 2023 match did not tick: round " + empty.round);
  if (empty.winner !== null) fail("the empty 2023 match was won by " + empty.winner);
}
