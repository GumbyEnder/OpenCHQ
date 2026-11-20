// Node test: PB-151 — cash is clamped to 1500 b.
//
// Original: FUN_23aa_0cba @ 23aa:0cba (decompiled.c 17186-17206) clamps a side's cash to
// 0..60000 units. perBillion is 1000 units, so the ceiling is 1500 b. Every credit - income, a
// capture reward, a refund, foreign aid - goes through economy.credit().
//
// What this pins:
//   1. a side credited at 1499.98 b ends at exactly 1500 b, and further income leaves it there;
//   2. the income EVENT reports what landed, not what the count was worth;
//   3. spending still works from 1500 b (the clamp is a credit rule, not a purse lock);
//   4. the ceiling is a tunable with its source, not a literal in code.

import { openMatch } from "../../server/match.mjs";
import { boardPayload, matchSites } from "../../server/board.mjs";
import { buy, credit, pay, seedOwners } from "../../server/economy.mjs";
import { maxCash, millionsPerBillion } from "../../server/rules.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "pb151_cash_ceiling";

function fail(message) {
  throw new Error(message);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(label + ": " + a + " !== " + b);
}

function must(cond, label) {
  if (!cond) fail(label);
}

export async function run() {
  // --- the tunable ----------------------------------------------------------
  eq("one billion is 1000 units", millionsPerBillion(), 1000);
  eq("the ceiling is 1500 b in millions", maxCash(), 1500000);
  eq("the ceiling is config, not a literal", rules().money.maxBillions, 1500);
  must(/FUN_23aa_0cba/.test(String(rules().money._comment)),
    "the money block does not cite FUN_23aa_0cba");

  // --- a credit at the edge ------------------------------------------------
  const match = openMatch("1942", matchSites("1942"));
  seedOwners(match);
  const blue = match.sides.blue;
  blue.cash = 1499980; // 1499.98 b
  eq("a credit takes the pool to exactly the ceiling", credit(match, "blue", 50), 1500000);
  eq("a big credit cannot overshoot", credit(match, "blue", 999999), 1500000);
  eq("a debit through credit clamps at zero", credit(match, "blue", -9999999999), 0);
  blue.cash = 1499980;

  // --- income clamps, and the event says what landed -----------------------
  match.round = 1;
  const events = pay(match).filter((event) => event.type === "income" && event.side === "blue");
  eq("blue is paid once at round 1", events.length, 1);
  eq("the pool sits exactly at 1500 b", blue.cash, 1500000);
  eq("the event reports the 20 millions that landed, not the 1550 the counter was worth",
    events[0].amount, 20);

  // A further payday at a round with nothing changed leaves it there.
  match.round = 2;
  const again = pay(match).filter((event) => event.type === "income" && event.side === "blue");
  eq("a further income leaves the pool at the ceiling", blue.cash, 1500000);
  eq("and its event reports nothing landed", again[0].amount, 0);

  // --- spending still works from the ceiling -------------------------------
  // A friendly type-4 city with no ground piece standing on it: the opening roster sits on the
  // capitals, so the first owned city away from them is a legal placement cell.
  const occupied = new Set((match.pieces || [])
    .filter((piece) => piece.side === "blue" && piece.domain === "land")
    .map((piece) => piece.x + "," + piece.y));
  const city = match.sites.find((site) => site && site.owner === "blue" && Number(site.type) === 4 &&
    !occupied.has(site.x + "," + site.y));
  must(city, "the 1942 board has no free blue city to buy on");
  const bought = buy(match, "blue", "infantry", city.x, city.y, boardPayload());
  eq("a 10-billion infantry is bought from a full pool", Boolean(bought.ok), true);
  eq("the purchase debits the pool", blue.cash, 1490000);
}
