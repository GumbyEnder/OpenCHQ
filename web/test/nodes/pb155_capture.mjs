// Node test: PB-155 - capture pays 2 b and leaves the site unready for 15 rounds.
//
// Decoded from FUN_1c0d_02ce @ 1c0d:02ce (decompiled.c 9169, 9179-9182):
//   - when a city or base changes hands, 0x10ae[site] = 15, i.e. the captured site is unready
//     for 15 rounds;
//   - if the site is type 4 (city) or type 3 (base), the CAPTURING side is paid 80 raw units.
//     The original's raw unit is 25 million (60000 units = 1500 b), so 80 raw = 2000 million = 2 b;
//   - capitals (type 1/2) and oil fields (type 5) pay nothing.
//
// What this pins:
//   1. a neutral or enemy city pays +2000 M ONCE, not every round the unit stands there, and the
//      site's readyRound is round + 15;
//   2. the readiness gate refuses a purchase until round + 15 and allows it at round + 15;
//   3. a type-3 base pays too, a capital and an oil field pay nothing (and take no capture timer);
//   4. the reward is a credit, so PB-151's 1500 b ceiling clamps it;
//   5. the seat that took the site reads a "capture reward" line; the other seat does not.
//
// Sign of the reward (who gains) is RE-E3's confirm-or-refute leg: the code assumes the capturer
// gains, and a DOSBox capture that shows the loser gaining reverts this rule. It is not verified
// here and no unit test can verify it.

import { openMatch } from "../../server/match.mjs";
import { occupy } from "../../server/economy.mjs";
import { isSiteReady, readyRoundOf, unreadyRefusal, captureUnreadyRounds } from "../../server/readiness.mjs";
import { captureReward, maxCash } from "../../server/rules.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "pb155_capture";

function must(cond, message, fail) {
  if (!cond) fail(message);
}

function eq(actual, expected, label, fail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function site(id, type, owner, x = 10, y = 10) {
  const kind = type === 5 ? "facility" : type === 3 ? "base" : type === 1 || type === 2 ? "capital" : "city";
  return { id, name: `${kind} ${id}`, kind, type, owner, x, y };
}

function room(sites, round = 0) {
  const match = openMatch("1986", []);
  match.sites = sites;
  match.pieces = [];
  match.round = round;
  match.over = false;
  match.sides.blue.cash = 0;
  match.sides.red.cash = 0;
  return match;
}

function stand(match, side, x, y) {
  match.pieces = [{ id: `${side}:infantry:1`, side, kind: "infantry", domain: "land", x, y, path: [] }];
}

const rewards = (events) => events.filter((event) => event && event.type === "capture_reward");

export async function run(ctx) {
  const { fail } = ctx;
  const REWARD = 2000;
  const ROUNDS = 15;

  // ---- 1. the constants are the decoded ones ------------------------------------------------
  {
    eq(captureReward(), REWARD, "money.captureReward is 80 raw units = 2000 M", fail);
    eq(captureUnreadyRounds(), ROUNDS, "readiness.captureRounds is 15", fail);
    console.log("pb155 constants ok: captureReward 2000 M (2 b), captureRounds 15");
  }

  // ---- 2. a city pays once, and only once, and takes the 15-round timer ---------------------
  {
    const match = room([site(10, 4, "blue", 10, 10), site(11, 4, "blue", 20, 20)], 7);
    stand(match, "red", 10, 10);

    const first = occupy(match);
    eq(match.sites[0].owner, "red", "the red infantry must take the blue city", fail);
    eq(rewards(first).length, 1, "one capture must emit one capture_reward event", fail);
    eq(rewards(first)[0].amount, REWARD, "the capture reward is 2000 M", fail);
    eq(match.sides.red.cash, REWARD, "the capturer's pool must hold the reward", fail);
    eq(match.sides.blue.cash, 0, "the loser must not be paid", fail);
    eq(readyRoundOf(match.sites[0]), 7 + ROUNDS, "the captured city must be unready for 15 rounds", fail);

    // The same unit keeps standing there for the next rounds: no second payment.
    match.round = 8;
    const second = occupy(match);
    eq(rewards(second).length, 0, "a unit standing on a site it already holds must not be paid again", fail);
    eq(match.sides.red.cash, REWARD, "the pool must not grow while the unit stands still", fail);
    match.round = 9;
    occupy(match);
    eq(match.sides.red.cash, REWARD, "still one reward after two more rounds", fail);
    console.log("pb155 city capture ok: +2000 M once, loser 0, readyRound round+15");
  }

  // ---- 3. the readiness gate refuses until round + 15 ---------------------------------------
  {
    const match = room([site(10, 4, "blue", 10, 10), site(11, 4, "blue", 20, 20)], 7);
    stand(match, "red", 10, 10);
    occupy(match);
    const taken = match.sites[0];
    // placement.canPlace() consults exactly this pair at web/server/placement.mjs:497-498, so the
    // gate is pinned at the module the purchase path calls, without a terrain board in the fixture.
    eq(isSiteReady(taken, 7), false, "the captured city is unready on the round it was taken", fail);
    eq(isSiteReady(taken, 7 + ROUNDS - 1), false, "unready one round before round+15", fail);
    eq(isSiteReady(taken, 7 + ROUNDS), true, "ready exactly on round+15", fail);
    eq(unreadyRefusal(taken), "city 10 isn't ready: it will be ready at round 22.", "refusal names round+15", fail);
    console.log("pb155 gate ok: unready at 21, ready at 22 for a capture on round 7");
  }

  // ---- 4. base pays, capital and oil field do not -------------------------------------------
  {
    const base = room([site(12, 3, "red", 30, 30), site(13, 4, "red", 40, 40)], 3);
    stand(base, "blue", 30, 30);
    const baseEvents = occupy(base);
    eq(rewards(baseEvents).length, 1, "a captured type-3 base must pay", fail);
    eq(base.sides.blue.cash, REWARD, "the base's capturer must be paid 2000 M", fail);
    eq(readyRoundOf(base.sites[0]), 3 + ROUNDS, "a captured base takes the 15-round timer", fail);

    const capital = room([site(13, 1, "red", 40, 40), site(14, 4, "red", 41, 40)], 3);
    stand(capital, "blue", 40, 40);
    const capitalEvents = occupy(capital);
    eq(capital.sites[0].owner, "blue", "the capital must still change hands", fail);
    eq(rewards(capitalEvents).length, 0, "a captured capital pays nothing", fail);
    eq(capital.sides.blue.cash, 0, "the capital's capturer must not be paid", fail);
    eq(readyRoundOf(capital.sites[0]), 0, "a capital takes no capture timer", fail);

    const oil = room([site(64, 5, "red", 50, 50), site(15, 4, "red", 51, 50)], 3);
    stand(oil, "blue", 50, 50);
    const oilEvents = occupy(oil);
    eq(oil.sites[0].owner, "blue", "the oil field must still change hands", fail);
    eq(rewards(oilEvents).length, 0, "a captured oil field pays nothing", fail);
    eq(readyRoundOf(oil.sites[0]), 0, "an oil field takes no capture timer", fail);
    console.log("pb155 types ok: base pays, capital and oil field pay nothing and take no timer");
  }

  // ---- 5. the reward is a credit: PB-151's ceiling clamps it ---------------------------------
  {
    const ceiling = Number(maxCash());
    must(Number.isFinite(ceiling), "maxCash() must be readable", fail);
    const match = room([site(10, 4, "blue", 10, 10), site(11, 4, "blue", 20, 20)], 2);
    match.sides.red.cash = ceiling - REWARD / 2; // 1499 b: the reward would overshoot by 1 b
    stand(match, "red", 10, 10);
    const events = occupy(match);
    eq(match.sides.red.cash, ceiling, "the capture reward must clamp at the 1500 b ceiling", fail);
    eq(rewards(events)[0].amount, REWARD / 2, "the event reports what actually landed", fail);
    console.log(`pb155 ceiling ok: ${ceiling - REWARD / 2} + ${REWARD} clamps to ${ceiling} M`);
  }

  // ---- 6. the log line is the capturer's ------------------------------------------------
  {
    const match = room([site(10, 4, "blue", 10, 10), site(11, 4, "blue", 20, 20)], 4);
    stand(match, "red", 10, 10);
    const events = occupy(match);
    const redLines = logLines(match, "red", events, 4).map((line) => line.text);
    const blueLines = logLines(match, "blue", events, 4).map((line) => line.text);
    must(redLines.some((line) => /capture reward \+2b/.test(line)), `the capturer's log must show the reward, got ${JSON.stringify(redLines)}`, fail);
    must(!blueLines.some((line) => /capture reward/.test(line)), `the loser's log must not show the reward, got ${JSON.stringify(blueLines)}`, fail);
    console.log("pb155 log ok: red reads 'capture reward +2b', blue does not");
  }

  console.log("pb155_capture ok: once-only 2 b reward, 15-round capture timer, types, ceiling, log");
}
