// Node capital_win: the win check, the reason it ended, and the one path that moves a capital.
//
// T-010 found a 1942 bot match that ended at round 22 with all six capitals blue and only one
// capture in the log. The engine was right - the harness had snapshotted its baseline too late -
// but the end of the match was still wrong in the way a player meets it: the screen said "The
// match is over." and the log said "you hold every capital (6 of 6)", neither of which names the
// capital whose fall decided it. A win nobody can check against the board reads like an accident.
//
// Pinned here, per the T-012 acceptance criteria:
//   1. round-0 capital owners equal R-MAP-06 for 1918, 1942 and 1986, read off the live site list
//      the match is built from (not a fixture copy of the table);
//   2. a capital's owner changes only through a capture by a land piece standing on it - over a
//      driven 1942 match, every capital owner change has a matching capture event in that round,
//      and no round changes a capital without one;
//   3. the win tests: Paris alone is no win; Berlin, Paris and Tokyo win it for blue on the third
//      capture; London, Washington and Moscow win it for red; 1918 is won by taking Berlin; a
//      neutral capital blocks both sides;
//   4. the result carries the reason: the decisive capital's name and round, the era's capital
//      list with the holder the site records carry, one sentence the end screen prints, and a log
//      line that names the same capital.

import { CELL_W, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder } from "../../server/move.mjs";
import { checkWin, tickMatch } from "../../server/tick.mjs";
import { forSeat, resultNote, resultOf } from "../../server/view.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "capital_win";

// R-MAP-06: the opening holder of every capital the original's data file names.
const EXPECT = {
  1918: { 10: "blue", 11: "red", 17: "blue" },
  1942: { 10: "blue", 11: "red", 17: "red", 35: "red", 62: "blue", 63: "blue" },
  1986: { 10: "blue", 35: "blue", 62: "blue", 63: "red" },
};

function siteId(match, id) {
  const site = (match.sites || []).find((place) => place && Number(place.id) === Number(id));
  if (!site) throw new Error("node test capital_win: the match has no site " + id);
  return site;
}

function capitalIds(match) {
  return ((match.capitalSet && match.capitalSet.list) || []).map((capital) => Number(capital.siteId));
}

function probe(id, side, site) {
  return { id, side, domain: "land", kind: null, x: site.x, y: site.y, path: [] };
}

// One land piece takes one capital, by standing on it: the same write path economy.occupy gives a
// real capture, with no route to walk. Returns the capture event the tick produced.
function take(match, side, id) {
  const site = siteId(match, id);
  const piece = probe(side + ":probe:" + id, side, site);
  const kept = match.pieces;
  match.pieces = [piece];
  const { events } = tickMatch(match);
  match.pieces = kept;
  const capture = (events || []).find((event) => event.type === "capture" && Number(event.site) === Number(id));
  if (!capture) {
    throw new Error("node test capital_win: standing a " + side + " land piece on capital " + id +
      " produced no capture: " + JSON.stringify(events));
  }
  return capture;
}

function fresh(era) {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  match.pieces = [];
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;

  // ---- 1. Seeding: round 0 reads R-MAP-06, per era, off the live site list ----------------
  for (const [era, owners] of Object.entries(EXPECT)) {
    const match = openMatch(era, matchSites(era));
    if (match.round !== 0) fail(era + ": a fresh match opens at round " + match.round + ", not 0");
    const set = (match.capitalSet && match.capitalSet.list) || [];
    const ids = set.map((capital) => Number(capital.siteId)).sort((a, b) => a - b);
    const wanted = Object.keys(owners).map(Number).sort((a, b) => a - b);
    if (ids.join(",") !== wanted.join(",")) {
      fail(era + ": the capital set is " + ids.join(",") + ", R-MAP-06 names " + wanted.join(","));
    }
    for (const id of wanted) {
      const owner = siteId(match, id).owner ?? null;
      if (owner !== owners[id]) {
        fail(era + ": capital " + id + " opens as " + JSON.stringify(owner) + ", R-MAP-06 says " + owners[id]);
      }
    }
    // And no era opens decided: if round 0 were already a win, every match below would be a
    // re-run of that bug rather than a test of the capture rule.
    if (checkWin(match) !== null) fail(era + ": checkWin is " + checkWin(match) + " at round 0");
  }

  // ---- 2. The win tests, one capture at a time --------------------------------------------
  // 1942 blue: Paris alone changes nothing. Paris is red's, and blue already holds London,
  // Washington and Moscow - four of six is not the rule.
  const paris = fresh("1942");
  take(paris, "blue", 17);
  if (checkWin(paris) !== null) fail("1942: Paris alone gave " + checkWin(paris) + " the win");
  if (paris.over) fail("1942: Paris alone ended the match");

  // The third capture wins it, and the win names the capital that completed the set.
  const blue = fresh("1942");
  take(blue, "blue", 11);
  take(blue, "blue", 17);
  if (checkWin(blue) !== null) fail("1942: two of red's three capitals gave blue the win");
  const third = take(blue, "blue", 35);
  if (!blue.over) fail("1942: blue holds every capital and the match is not over");
  if (blue.winner !== "blue") fail("1942: blue holds every capital, winner reads " + blue.winner);
  if (!blue.winReason || blue.winReason.kind !== "capitals") fail("1942: no capital reason on the match: " + JSON.stringify(blue.winReason));
  if (Number(blue.winReason.siteId) !== Number(third.site)) {
    fail("1942: the reason names capital " + blue.winReason.siteId + ", the third capture took " + third.site);
  }
  if (blue.winReason.name !== third.name) {
    fail("1942: the reason names " + JSON.stringify(blue.winReason.name) + ", the capture was " + JSON.stringify(third.name));
  }

  // Red's side of the same rule: London, Washington and Moscow.
  const red = fresh("1942");
  take(red, "red", 10);
  take(red, "red", 62);
  if (checkWin(red) !== null) fail("1942: two of blue's three capitals gave red the win");
  take(red, "red", 63);
  if (!red.over || red.winner !== "red") fail("1942: red holds every capital and the match is not over/red: " + red.over + "/" + red.winner);

  // 1918 is won by taking Berlin: blue already holds London and Paris (D-016).
  const y1918 = fresh("1918");
  take(y1918, "blue", 11);
  if (!y1918.over || y1918.winner !== "blue") fail("1918: Berlin fell and the match is " + y1918.over + "/" + y1918.winner);

  // A neutral capital blocks both sides. Blue takes all three red capitals, which wins it, and
  // then Tokyo is put back to nobody's: five of six is not the rule, and the sixth is not red's
  // either, so neither side may win. This is also the boundary the original's own check keeps.
  const neutral = fresh("1942");
  for (const id of [11, 17, 35]) take(neutral, "blue", id);
  if (!neutral.over) fail("1942: the neutral-capital fixture did not reach a win to begin with");
  neutral.over = false;
  neutral.winner = null;
  neutral.winReason = null;
  siteId(neutral, 35).owner = null;
  if (checkWin(neutral) !== null) fail("1942: a neutral capital did not block the win: " + checkWin(neutral));

  // ---- 3. One path: every capital owner change over a driven match is a capture -----------
  // A clear board: the 1942 opening order of battle puts a red army on Moscow, and it takes that
  // capital in round 1 (measured). That is the engine working, not the fixture being tested, so the
  // driven match keeps only the three tanks it measures.
  const driven = fresh("1942");
  // Three blue tanks beside the three red capitals, ordered in. This is the engine's own path -
  // order, walk, occupy - not a probe dropped on the cell.
  const tanks = [];
  for (const [n, id] of [[0, 11], [1, 17], [2, 35]]) {
    const capital = siteId(driven, id);
    const cell = { x: (capital.x + 1) % CELL_W, y: capital.y };
    const piece = { id: "blue:tank:" + n, side: "blue", domain: "land", kind: "tank", x: cell.x, y: cell.y, path: [] };
    driven.pieces.push(piece);
    tanks.push({ piece, capital });
  }
  const capitals = capitalIds(driven);
  const ownerNow = (id) => siteId(driven, id).owner ?? null;
  const captureByRound = new Map();
  let changes = 0;
  for (let round = 1; round <= 60 && !driven.over; round++) {
    const before = new Map(capitals.map((id) => [id, ownerNow(id)]));
    for (const tank of tanks) {
      const holder = ownerNow(Number(tank.capital.id));
      if (holder === "blue") continue;
      // Re-order every round the capital is still enemy-held: a walker that arrives and loses a
      // round to the garrison should try again, which is what a player would do.
      const order = issueOrder(driven, "blue", tank.piece.id, tank.capital.x, tank.capital.y);
      if (order && order.error) fail("1942 driven: the order onto capital " + tank.capital.id + " was refused: " + order.error);
    }
    const { events } = tickMatch(driven);
    for (const event of events || []) {
      if (event && event.type === "capture" && capitals.includes(Number(event.site))) {
        captureByRound.set(driven.round + ":" + event.site, event);
      }
    }
    for (const id of capitals) {
      const after = ownerNow(id);
      if (after !== before.get(id)) {
        changes += 1;
        const capture = captureByRound.get(driven.round + ":" + id);
        if (!capture) {
          fail("1942 driven: capital " + id + " changed " + JSON.stringify(before.get(id)) + " -> " +
            JSON.stringify(after) + " in round " + driven.round + " with no capture event");
        }
        if (capture.side !== after) {
          fail("1942 driven: capital " + id + " is " + after + " and its capture says " + capture.side);
        }
      }
    }
  }
  if (changes === 0) fail("1942 driven: 60 rounds of ordered tanks took no capital - the fixture is not playing");
  if (!driven.over) fail("1942 driven: the match did not end after taking every red capital");
  const drivenResult = resultOf(driven);
  if (!drivenResult || drivenResult.reason !== "capitals") fail("1942 driven: no capital reason: " + JSON.stringify(drivenResult));

  // ---- 4. The result: reason, capital list, and the sentences that print them -------------
  const result = resultOf(blue);
  const list = (blue.capitalSet && blue.capitalSet.list) || [];
  if (result.capitals.length !== list.length) {
    fail("the result lists " + result.capitals.length + " capitals, the match's set has " + list.length);
  }
  for (const row of result.capitals) {
    const owner = siteId(blue, row.siteId).owner ?? null;
    if (row.owner !== owner) {
      fail("the result says capital " + row.siteId + " is " + JSON.stringify(row.owner) +
        ", the site record says " + JSON.stringify(owner));
    }
    if (!row.name) fail("the result has an unnamed capital " + row.siteId);
  }
  if (!result.capitals.every((row) => row.owner === "blue")) {
    fail("the result of a blue win does not list every capital blue: " + JSON.stringify(result.capitals));
  }
  if (!result.lastCapital || result.lastCapital.round !== blue.round) {
    fail("the result's last capital has no round: " + JSON.stringify(result.lastCapital));
  }

  const note = resultNote(blue);
  if (!/^Blue wins: Tokyo fell at round \d+/.test(note)) fail("the end-screen sentence reads: " + note);

  const lines = logLines(blue, "blue", [{ type: "win", side: "blue", site: blue.winReason.siteId, name: blue.winReason.name, round: blue.round }], blue.round);
  if (lines.length !== 1) fail("a win produced " + lines.length + " log lines");
  if (!/you hold every capital \(6 of 6\); Tokyo fell at round \d+ last/.test(lines[0].text)) {
    fail("the log line reads: " + lines[0].text);
  }

  // The seat's own view carries the same list - the page draws what the server sent, so the page
  // and the server cannot disagree about a holder.
  const seatView = forSeat(blue, "blue");
  if (!seatView.result || seatView.result.reason !== "capitals") fail("the seat view has no result");
  if (JSON.stringify(seatView.result.capitals) !== JSON.stringify(result.capitals)) {
    fail("the seat view's capital list differs from the match result: " + JSON.stringify(seatView.result.capitals));
  }

  // A resignation has a winner and no capital to name. The end screen must say so rather than
  // borrow a capital from the list.
  const resigned = fresh("1942");
  resigned.over = true;
  resigned.winner = "red";
  const resignedResult = resultOf(resigned);
  if (resignedResult.reason !== "resignation") fail("a resignation without a reason reads " + resignedResult.reason);
  if (resignedResult.lastCapital !== null) fail("a resignation invented a last capital: " + JSON.stringify(resignedResult.lastCapital));
  if (!/^Red wins\.$/.test(resultNote(resigned))) fail("a resignation's sentence reads: " + resultNote(resigned));

  return [
    "round 0 reads R-MAP-06 in 1918, 1942 and 1986",
    "Paris alone is no win; the third capital wins it and names itself",
    "red wins on London, Washington and Moscow; 1918 on Berlin; a neutral capital blocks",
    "over a driven 1942 match every capital owner change is a capture",
    "the result, the seat view and the log agree on the last capital and the list",
  ];
}
