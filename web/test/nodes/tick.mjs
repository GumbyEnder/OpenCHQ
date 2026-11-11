// Node test: "tick" (order 100) and "win" (order 210). Owner: A1.
//
// These drive tickMatch and checkWin directly, never the socket and never a timer: a round is
// whatever the caller asks for, so no test here sleeps or waits for an interval. Pieces are
// placed explicitly with an empty path, so the assertions hold whether move.mjs has landed yet
// or not - a piece standing still is not evidence either way, and the round counter is.
//
// The win half is B-3b: the set is the era's whole capital list (the file's subtype-1/2 rows), the
// holder is the site record's owner that economy.occupy writes, and the check runs when a capital
// changes hands. So the match here is a real 1986 board, not two synthetic seat cells: three of
// 1986's four capitals sit on sites the asset list calls a city, and a win check keyed on
// kind === "capital" would never see them.
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { tickMatch, checkWin } from "../../server/tick.mjs";

export const name = "tick";

function piece(id, side, x, y, domain = "land") {
  return { id, side, domain, kind: null, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
}

function siteOf(match, capital) {
  return match.sites.find((site) => Number(site.id) === Number(capital.siteId));
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

  // ---- win: the era's whole capital set, decided on a capture -----------------------------
  // prove: "The harness gives one side every capital in the era's set and takes the last one with
  // troops; the capture ends the match and the next tick freezes the board."
  const sites = matchSites("1986");
  if (!sites.length) return ctx.skip("no site list on this host, so the era's capital set cannot be built");

  const match = openMatch("1986", sites);
  match.clock = "running";
  const set = match.capitalSet;
  if (!set || set.source !== "file") fail("1986 capital set source is " + (set && set.source) + ", the file wrote the owners");
  if (set.missing.length) fail("1986: capital ids " + set.missing.join(",") + " have no live site");
  const ids = set.list.map((capital) => Number(capital.siteId)).sort((a, b) => a - b).join(",");
  if (ids !== "10,35,62,63") fail("the 1986 win set is " + ids + ", the file's capitals are 10,35,62,63");
  if (checkWin(match) !== null) fail("an opening 1986 match reported " + checkWin(match) + " as the winner");
  for (const capital of set.list) {
    const site = siteOf(match, capital);
    if (!site) fail("the set names " + capital.siteId + ", the match has no such site");
    if (Number(site.x) !== Number(capital.x) || Number(site.y) !== Number(capital.y)) {
      fail("the set's cell for " + capital.siteId + " disagrees with the match's site");
    }
  }

  // Three of the four are blue's, recorded the way economy.occupy records a capture. The fourth
  // is still neutral, so the set is incomplete and nobody has won - most of the capitals is not
  // all of them, and a neutral capital blocks both sides.
  for (const capital of set.list.slice(1)) siteOf(match, capital).owner = "blue";
  const last = siteOf(match, set.list[0]);
  last.owner = null;
  if (checkWin(match) !== null) fail("three of four capitals was called a win: " + checkWin(match));

  // Blue walks onto the last one. That capture is what triggers the check - and the last capital
  // is a city-kind site, so this also pins that the trigger is set membership, not site kind.
  match.pieces = [piece("blue:land", "blue", last.x, last.y)];
  const ending = tickMatch(match);
  const capture = ending.events.find(
    (event) => event && event.type === "capture" && Number(event.site) === Number(last.id)
  );
  if (!capture) fail("walking onto the last capital produced no capture event: " + JSON.stringify(ending.events));
  if (match.winner !== "blue") fail("the winning side was reported as " + JSON.stringify(match.winner));
  if (match.over !== true) fail("the match did not end: over=" + match.over);
  if (match.clock !== "held") fail("the ended match kept clock " + match.clock);
  if (!ending.events.some((event) => event && event.type === "win" && event.side === "blue")) {
    fail("no win event for blue: " + JSON.stringify(ending.events));
  }
  if (checkWin(match) !== "blue") fail("checkWin forgot the winner after the match ended");

  // ---- win: a quiet round does not end a won-on-paper set --------------------------------
  // Every capital is blue's and nobody takes one this round. The pre-B-3b engine checked on every
  // tick and would end the match here; the capture-handler check must not.
  const quiet = openMatch("1986", matchSites("1986"));
  quiet.clock = "running";
  quiet.pieces = [];
  for (const capital of quiet.capitalSet.list) siteOf(quiet, capital).owner = "blue";
  if (checkWin(quiet) !== "blue") fail("owning every 1986 capital did not report blue: " + checkWin(quiet));
  tickMatch(quiet);
  if (quiet.winner !== null || quiet.over) {
    fail("a quiet round ended the match on the per-tick path: " + JSON.stringify({ winner: quiet.winner, over: quiet.over }));
  }

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
  const silent = tickMatch(alreadyOver);
  if (silent.events.length !== 0) fail("a finished match emitted events: " + JSON.stringify(silent.events));
  if (alreadyOver.round !== 9) fail("a finished match advanced to round " + alreadyOver.round);
  if (JSON.stringify(alreadyOver) !== overBefore) fail("a finished match changed: " + JSON.stringify(alreadyOver));

  // ---- win: recorded ownership alone, and a neutral capital blocks both sides -------------
  const recorded = openMatch("1986", matchSites("1986"));
  recorded.pieces = [];
  if (checkWin(recorded) !== null) fail("an unowned 1986 board reported " + checkWin(recorded));
  for (const capital of recorded.capitalSet.list) siteOf(recorded, capital).owner = "red";
  if (checkWin(recorded) !== "red") fail("red owned every 1986 capital but checkWin said " + checkWin(recorded));
  siteOf(recorded, recorded.capitalSet.list[0]).owner = "blue";
  if (checkWin(recorded) !== null) fail("a split ownership of the capitals was called a win: " + checkWin(recorded));
  siteOf(recorded, recorded.capitalSet.list[0]).owner = null;
  if (checkWin(recorded) !== null) fail("a neutral capital handed the match to " + checkWin(recorded));

  // A set the site list only partly carries decides nothing: a capital silently dropped would make
  // the win easier than the original's, so the check refuses rather than counting a partial list.
  const partial = openMatch("1986", matchSites("1986"));
  partial.capitalSet = { ...partial.capitalSet, missing: [63] };
  for (const capital of partial.capitalSet.list) siteOf(partial, capital).owner = "blue";
  if (checkWin(partial) !== null) fail("a partial capital set decided a match: " + checkWin(partial));

  // 2023 has no subtype-1/2 row, so its set is two rolled capitals, one each: no round-0 win.
  const rolled = openMatch("2023", matchSites("2023"));
  rolled.clock = "running";
  if (!rolled.capitalSet || rolled.capitalSet.list.length !== 2) {
    fail("2023 rolled " + (rolled.capitalSet ? rolled.capitalSet.list.length : "no") + " capitals, the reading has 2");
  }
  if (checkWin(rolled) !== null) fail("the 2023 opening was already won by " + checkWin(rolled));
  tickMatch(rolled);
  if (rolled.round !== 1) fail("the empty 2023 match did not tick: round " + rolled.round);
  if (rolled.winner !== null) fail("the empty 2023 match was won by " + rolled.winner);
}
