// PB-344: what a city capture actually does, graded against the manual and the economy record.
//
// The capture path is `economy.occupy(match)` inside one full tick (advance, attritionStep,
// resolve, tickEntrench, repairStep, occupy, tickAir, upkeep, pay) - NOT the movement walker and
// not an op. `economy.capture()` (:285) is the oil-well path only, so a leg that waits for a city
// to flip without ticking the whole match reads "never captures".
//
// Every number below carries its source, and the source is the config key plus the measured note
// that sits beside it:
//   - reward 2000 million = 2 b: config/game.json:184 `captureReward`, source string at :540 -
//     80 raw units x 25 M, `FUN_1c0d_02ce @ 1c0d:02ce`, decompiled.c 9179-9182, DOSBox
//     2026-11-19 re3 three city captures (capturer +80, loser +0, round counter unchanged).
//     Paid once per change of hands behind the `site.owner !== side` test (economy.mjs:434); the
//     credit lands at economy.mjs:448. Only types 3 and 4 take the branch, so a capital (1/2) and
//     an oil field (5) pay 0.
//   - unready 15 rounds: config/game.json:647 `captureRounds` (value; the note is :541), source
//     `FUN_1c0d_02ce` writing
//     `0x10ae[site] = 15` (decompiled.c 9169), read back on three captures, decaying one per round.
//     economy.mjs:445 sets `site.readyRound = round + captureUnreadyRounds()` in that branch.
//   - Log: `took <city>` from log.mjs:257-263, `capture reward +2b` from log.mjs:271-277, and the
//     reward line is the capturer's alone (PB-155: `if (!mine) break;`).
//   - a capital or an oil field pays nothing (same source string, last clause) - so the negative
//     arm's city must not be a capital.
//
// The negative arm is the asymmetry in docs/re/B3_CAPITALS.md §4: the win check at `1c0d:000c` is
// called from the capture handler only after `cmpw $3,-0x2(%bp)` at 0xFC2A/0xFC88 - a CAPITAL
// capture triggers it, a city capture never does. The port keeps that shape at tick.mjs:299
// (`capitalCaptures.length ? checkWin(match) : null`). The arm makes the set complete on the site
// table first, so a port that checked the win on every capture would end the match here and go red.
//
// Card: Main Vault/01_Projects/OpenCHQ/Dev Tasks/PB-344 city capture effects graded against the
// manual and the economy record.md

import { matchSites, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch, checkWin } from "../../server/tick.mjs";
import { logLines } from "../../server/log.mjs";
import { forSeat } from "../../server/view.mjs";
import { captureReward } from "../../server/rules.mjs";
import { captureUnreadyRounds, isSiteReady } from "../../server/readiness.mjs";

export const name = "pb344_capture_vs_doc";

// config/game.json:184 / :541, measured notes at :540 / :541.
const REWARD = 2000;
const UNREADY = 15;
const MAX_TICKS = 12;

function fail(message) {
  throw new Error("node test pb344_capture_vs_doc: " + message);
}

function cellTaken(match, x, y) {
  return (match.pieces || []).some((piece) => piece && Number(piece.x) === x && Number(piece.y) === y);
}

function wrapX(x) {
  return ((Number(x) % CELL_W) + CELL_W) % CELL_W;
}

// The card's precondition: a red-owned city with no garrison on it and no enemy piece close
// enough to shoot the mover on the pass it walks in. Strict by choice - one adjacent piece of
// either side disqualifies the cell, so the arm cannot be argued into a firefight it did not mean.
function stageable(match, site, skipIds, kinds) {
  const allowed = kinds || ["city"];
  if (!site || site.owner !== "red" || !allowed.includes(site.kind)) return null;
  if (skipIds && skipIds.has(Number(site.id))) return null;
  if (cellTaken(match, Number(site.x), Number(site.y))) return null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = wrapX(Number(site.x) + dx);
    const y = Number(site.y) + dy;
    if (y < 0 || y > 135) continue;
    if (cellTaken(match, x, y)) continue;
    return { x, y };
  }
  return null;
}

function stage(match, tag, skipIds, kinds) {
  const ordered = match.sites
    .filter(Boolean)
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const site of ordered) {
    const spot = stageable(match, site, skipIds, kinds);
    if (!spot) continue;
    const id = "blue:pb344:" + tag;
    match.pieces.push({ id, side: "blue", domain: "land", kind: "infantry", x: spot.x, y: spot.y, path: [] });
    const order = issueOrder(match, "blue", id, Number(site.x), Number(site.y));
    if (!order || order.error) {
      match.pieces = match.pieces.filter((piece) => piece.id !== id);
      continue;
    }
    return { site, id, spot };
  }
  return null;
}

// One tick, measured on both sides of it: cash before, the events the tick emitted, cash after.
function captureRound(match, staged) {
  const seat = match.sides.blue;
  for (let i = 0; i < MAX_TICKS; i++) {
    const before = Number(seat.cash) || 0;
    const ticked = tickMatch(match);
    const events = (ticked && ticked.events) || [];
    const capture = events.find((event) => event && event.type === "capture"
      && Number(event.site) === Number(staged.site.id));
    if (!capture) continue;
    return {
      events,
      capture,
      reward: events.find((event) => event && event.type === "capture_reward"
        && Number(event.site) === Number(staged.site.id)),
      income: events.find((event) => event && event.type === "income" && event.side === "blue"),
      winner: events.find((event) => event && event.type === "win"),
      before,
      after: Number(seat.cash) || 0,
      round: Number(match.round),
    };
  }
  return null;
}

function gradedEra(era) {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  const staged = stage(match, era, null);
  if (!staged) fail(era + ": no red city on the board is empty with a free adjacent cell");
  const site = staged.site;
  const result = captureRound(match, staged);
  if (!result) fail(era + ": the blue infantry reached the city and the capture never fired in "
    + MAX_TICKS + " ticks");
  const where = era + " " + site.name + " (site " + site.id + ")";

  // Paid once per change of hands: the same piece is still standing on the site after the capture,
  // so the next tick must not re-enter the branch or emit a second reward. The gate is the owner
  // byte (economy.mjs:434), source FUN_1c0d_02ce decompiled.c 9179-9182.
  const repeat = tickMatch(match);
  const repeatEvents = (repeat && repeat.events) || [];
  const repeatHit = repeatEvents.find((event) => event
    && (event.type === "capture" || event.type === "capture_reward")
    && Number(event.site) === Number(site.id));
  if (repeatHit) {
    fail(where + ": site " + site.id + " emitted a second " + repeatHit.type + " while the same piece"
      + " stood on it - the 2 b (decompiled.c 9179-9182) is not paid once per change of hands");
  }

  // 1. The owner byte, and the board view the page draws from. A spectator view carries the whole
  // site table (`forSeat(match, null).sites`), so this is the room's board, not the server's match.
  if (site.owner !== "blue") fail(where + ": owner is " + site.owner + " after the capture round");
  const board = forSeat(match, null).sites.find((row) => Number(row.id) === Number(site.id));
  if (!board) fail(where + ": the board view does not carry the site at all");
  if (board.owner !== "blue") fail(where + ": the board view still paints owner " + board.owner);

  // 2. The capture value, as a delta across exactly the round that flipped it. Income is paid in
  // the same tick (payEvery 1, config/game.json:178), so the reward is asserted as its own event
  // AND the tick's cash movement is decomposed into reward + income; an absolute balance would
  // prove nothing either way.
  // The amount is 2 b: FUN_1c0d_02ce @ 1c0d:02ce, decompiled.c 9179-9182 (DOSBox 2026-11-19 re3:
  // capturer +80 raw units = 2000 M at 25 M/unit), credited at economy.mjs:448. That branch is
  // entered only when the owner BYTE changes (economy.mjs:434) and takes only types 3 and 4, so it
  // pays once per change of hands and a capital (type 1/2) or an oil field (type 5) pays 0.
  if (!result.reward) fail(where + ": no capture_reward event - the reward is 2 b at "
    + "decompiled.c 9179-9182, documented at config/game.json:184 and credited at economy.mjs:448");
  const amount = Number(result.reward.amount);
  if (amount !== REWARD) fail(where + ": the reward event says " + amount + " M, not the 2 b "
    + "(2000 M) of decompiled.c 9179-9182 / config/game.json:184");
  if (captureReward() !== REWARD) fail(era + ": rules.captureReward() no longer reads 2000 M");
  const incomeAmount = result.income ? Number(result.income.amount) : 0;
  const delta = result.after - result.before;
  if (delta !== amount + incomeAmount) {
    fail(where + ": cash moved " + delta + " but reward " + amount + " + income " + incomeAmount
      + " does not add up");
  }
  if (Number(result.reward.round) !== result.round) {
    fail(where + ": the reward event carries round " + result.reward.round + ", the match is at " + result.round);
  }

  // 3. Readiness: the captured site is unready for the decoded 15 rounds, counted from the capture
  // round. Source: FUN_1c0d_02ce @ 1c0d:02ce, decompiled.c 9169 writes `0x10ae[site] = 15`, read
  // back on three DOSBox captures (re3) decaying one per round. The value asserted is
  // config/game.json:647; :541 is its measured note string. UNMEASURED would have been a
  // shape-only arm - the constant is measured, so it is asserted, and the consumer boundary is
  // walked too.
  if (captureUnreadyRounds() !== UNREADY) fail(era + ": rules.captureUnreadyRounds() is no longer 15"
    + " (decompiled.c 9169 / config/game.json:647, note :541)");
  const ready = Number(site.readyRound);
  if (!Number.isFinite(ready)) fail(where + ": readyRound is " + site.readyRound + " - unready rounds are not stamped");
  if (ready - Number(result.reward.round) !== UNREADY) {
    fail(where + ": readyRound " + ready + " is not capture round " + result.reward.round + " + " + UNREADY);
  }
  // The consumer, not just the field: readiness.mjs:52 is what placement and the build report read.
  // A stamped field nobody reads would be a pass for the wrong reason.
  if (isSiteReady(site, result.round)) {
    fail(where + ": the captured site reads ready at r" + result.round + " (readyRound " + ready + ")");
  }
  if (!isSiteReady(site, ready)) {
    fail(where + ": the site is still unready at its own readyRound " + ready + " - the timer never expires");
  }

  // 4. The Log names the city, and the reward line belongs to the capturer alone.
  const mine = (logLines(match, "blue", result.events, result.round) || []).map((line) => line.text || String(line));
  if (!mine.some((text) => text.includes("took " + site.name))) {
    fail(where + ": the blue Log does not name the city it took; lines were " + JSON.stringify(mine.slice(-8)));
  }
  if (!mine.some((text) => /capture reward \+2b/.test(text))) {
    fail(where + ": the blue Log does not carry 'capture reward +2b'; lines were " + JSON.stringify(mine.slice(-8)));
  }
  const theirs = (logLines(match, "red", result.events, result.round) || []).map((line) => line.text || String(line));
  if (theirs.some((text) => text.includes("capture reward"))) {
    fail(where + ": the seat that lost the city is told the amount the other seat was paid");
  }

  return {
    era,
    site: site.id,
    name: site.name,
    cell: site.x + "," + site.y,
    reward: amount,
    income: incomeAmount,
    delta,
    readyRound: ready,
    round: result.round,
  };
}

// The negative arm: a city capture must not evaluate the win check.
function capitalGateArm() {
  const match = openMatch("1986", matchSites("1986"));
  match.clock = "running";
  const set = (match.capitalSet && match.capitalSet.list) || [];
  if (set.length !== 4) fail("1986's capital set is " + set.length + ", expected four");
  if (checkWin(match) === "blue") fail("the 1986 fixture already wins before the arm is set up");
  // Every capital to blue on the site table. This is a fixture, not a capture: no event, no round.
  for (const row of set) {
    const capital = match.sites.find((site) => Number(site.id) === Number(row.siteId));
    if (!capital) fail("capital set row " + row.siteId + " has no live site");
    capital.owner = "blue";
  }
  // The fixture has to survive the tick: a red piece standing on a capital re-takes it in the
  // occupy pass (`site.owner !== side`), which would undo the fixture and leave the arm measuring
  // a checkWin that is false for the wrong reason. Clear those cells - a fixture, named as one.
  match.pieces = (match.pieces || []).filter((piece) => {
    if (!piece) return false;
    return !set.some((row) => {
      const capital = match.sites.find((site) => Number(site.id) === Number(row.siteId));
      return capital && Number(piece.x) === Number(capital.x) && Number(piece.y) === Number(capital.y);
    });
  });
  const satisfied = checkWin(match);
  if (satisfied !== "blue") fail("the arm is vacuous: with every capital blue, checkWin says " + satisfied);

  const skip = new Set(set.map((row) => Number(row.siteId)));
  const staged = stage(match, "gate", skip);
  if (!staged) fail("gate arm: no non-capital red city is empty with a free adjacent cell");
  const result = captureRound(match, staged);
  if (!result) fail("gate arm: the city capture never fired in " + MAX_TICKS + " ticks");
  if (staged.site.owner !== "blue") fail("gate arm: the city did not flip, so the arm measured nothing");
  if (result.winner) fail("gate arm: a CITY capture emitted a win event (site " + staged.site.id + ")");
  if (match.over) fail("gate arm: a CITY capture ended the match");
  if (match.winner) fail("gate arm: a CITY capture stamped winner " + match.winner);
  if (match.clock !== "running") fail("gate arm: a CITY capture held the clock (" + match.clock + ")");
  // Contamination guard: the arm only means something while the fixture still holds after the
  // round. Any capital back in other hands and the negative arm measured a red set, not a gate.
  for (const row of set) {
    const capital = match.sites.find((site) => Number(site.id) === Number(row.siteId));
    if (!capital || capital.owner !== "blue") {
      fail("gate arm contaminated: capital " + row.siteId + " is " + (capital ? capital.owner : "missing")
        + " after the round, so the set was not complete when the city fell");
    }
  }
  return { site: staged.site.id, name: staged.site.name, setSatisfied: satisfied, over: Boolean(match.over) };
}


// The second negative arm: the two site classes the capture branch does NOT pay (AC#2, "capitals and
// oil fields pay 0", same source strings: decompiled.c 9179-9182 takes types 3/4 only).
//   a) an oil field (type 5) changes hands for 0 M, gets no readiness stamp, and does not end the match;
//   b) a capital (type 1/2) changes hands for 0 M and no readiness stamp, and DOES evaluate the win
//      check - the inverse of the gate arm above, which proves the handler is capital-only.
function paysNothingArm() {
  const oilMatch = openMatch("1986", matchSites("1986"));
  oilMatch.clock = "running";
  const oilStaged = stage(oilMatch, "oil", null, ["facility", "oilfield"]);
  if (!oilStaged) fail("oil arm: no empty red oil field with a free adjacent cell");
  const oilSite = oilStaged.site;
  const oil = captureRound(oilMatch, oilStaged);
  if (!oil) fail("oil arm: the capture never fired in " + MAX_TICKS + " ticks");
  if (oilSite.owner !== "blue") fail("oil arm: the oil field did not flip");
  if (oil.reward) fail("oil arm: an oil field (type 5) paid " + oil.reward.amount + " M - decompiled.c"
    + " 9179-9182 pays types 3/4 only");
  if (oilSite.readyRound !== undefined && oilSite.readyRound !== null) {
    fail("oil arm: an oil field was stamped readyRound " + oilSite.readyRound + " - the 15-round timer"
      + " (decompiled.c 9169) is for a city or base, not an oil field");
  }
  if (oil.winner || oilMatch.over) fail("oil arm: taking an oil field ended the match");

  // Capital: force every capital but Berlin blue as a fixture, then take Berlin. The set is complete
  // only after that capture, so a handler that runs on capitals must emit the win here.
  const capMatch = openMatch("1942", matchSites("1942"));
  capMatch.clock = "running";
  const set = (capMatch.capitalSet && capMatch.capitalSet.list) || [];
  if (set.length !== 6) fail("capital arm: 1942's capital set is " + set.length + ", expected six");
  const berlin = capMatch.sites.find((site) => Number(site.id) === 11);
  if (!berlin || berlin.owner !== "red") fail("capital arm: Berlin is not a red capital");
  for (const row of set) {
    const capital = capMatch.sites.find((site) => Number(site.id) === Number(row.siteId));
    if (!capital) fail("capital arm: capital set row " + row.siteId + " has no live site");
    if (Number(capital.id) !== 11) capital.owner = "blue";
  }
  capMatch.pieces = (capMatch.pieces || []).filter((piece) => {
    if (!piece) return false;
    return !set.some((row) => {
      const capital = capMatch.sites.find((site) => Number(site.id) === Number(row.siteId));
      return capital && Number(piece.x) === Number(capital.x) && Number(piece.y) === Number(capital.y);
    });
  });
  if (checkWin(capMatch) === "blue") fail("capital arm: the fixture wins before the last capital falls");
  const onlyBerlin = new Set(capMatch.sites.filter(Boolean)
    .map((site) => Number(site.id))
    .filter((id) => id !== 11));
  const capStaged = stage(capMatch, "cap", onlyBerlin, ["city", "capital"]);
  if (!capStaged) fail("capital arm: Berlin is not stageable");
  const capSite = capStaged.site;
  const cap = captureRound(capMatch, capStaged);
  if (!cap) fail("capital arm: the capital capture never fired in " + MAX_TICKS + " ticks");
  if (capSite.owner !== "blue") fail("capital arm: the capital did not flip");
  if (cap.reward) fail("capital arm: a capital (type " + capSite.type + ") paid " + cap.reward.amount
    + " M - decompiled.c 9179-9182 pays types 3/4 only");
  if (capSite.readyRound !== undefined && capSite.readyRound !== null) {
    fail("capital arm: a capital was stamped readyRound " + capSite.readyRound + " (decompiled.c 9169)");
  }
  if (!cap.winner) fail("capital arm: taking the last red capital emitted no win event - the capital"
    + " handler (1c0d:000c, called after cmpw $3,-0x2(%bp)) was not reached");
  if (checkWin(capMatch) !== "blue") fail("capital arm: the match is not blue-won after the last capital");
  return { oil: oilSite.id, oilName: oilSite.name, capital: capSite.id, capitalName: capSite.name };
}

export async function run() {
  const arms = [];
  const errors = [];
  for (const era of ["1942", "1986"]) {
    try {
      arms.push(gradedEra(era));
    } catch (error) {
      errors.push(String(error && error.message ? error.message : error));
    }
  }
  let gate = null;
  let pays = null;
  try {
    gate = capitalGateArm();
  } catch (error) {
    errors.push(String(error && error.message ? error.message : error));
  }
  try {
    pays = paysNothingArm();
  } catch (error) {
    errors.push(String(error && error.message ? error.message : error));
  }
  for (const arm of arms) {
    console.log("pb344 era ok: " + arm.era + " took " + arm.name + " (site " + arm.site + " at " + arm.cell
      + ") r" + arm.round + " - reward " + arm.reward + " M, income " + arm.income + " M, cash +"
      + arm.delta + ", readyRound r" + arm.readyRound + " (+" + UNREADY + ")");
  }
  if (gate) {
    console.log("pb344 gate ok: city capture did not evaluate the win check - set was already "
      + gate.setSatisfied + ", match still running (site " + gate.site + " " + gate.name + ")");
  }
  if (pays) {
    console.log("pb344 pays-nothing ok: oil field site " + pays.oil + " (" + pays.oilName + ") and capital"
      + " site " + pays.capital + " (" + pays.capitalName + ") changed hands for 0 M; the capital fired"
      + " the win check, the oil field did not");
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    fail(errors.join(" || "));
  }
}

