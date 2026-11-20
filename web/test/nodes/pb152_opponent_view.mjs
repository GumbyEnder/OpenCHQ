// Node test: PB-152 — show the opponent's income, never their cash.
//
// Original: MANUAL p.27 (Alternate Function) and FUN_3711_16a8 (START_MONEY.md). A second press
// shows the other side's income; their balance prints ???. So the seat payload may carry the
// opponent's payday COUNT and must not carry their purse, reserves or fuel anywhere - the page
// draws ??? from the absence rather than hiding a number it was sent.
//
// What this pins:
//   1. forSeat(match, "blue").opponent.income is the economy module's own payout for red;
//   2. the opponent block in the JSON has no cash/reserve/fuel field (grepped, not eyeballed);
//   3. the dialog model copies the payday and nothing else;
//   4. the page has the toggle and prints ??? for the balance.

import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { payoutFor, seedOwners } from "../../server/economy.mjs";
import { forSeat } from "../../server/view.mjs";
import { economyModel } from "../../public/dialogs.mjs";

export const name = "pb152_opponent_view";

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

export async function run(ctx) {
  const match = openMatch("1986", matchSites("1986"));
  seedOwners(match);

  const blue = forSeat(match, "blue");
  const red = forSeat(match, "red");
  must(blue.opponent, "the blue seat carries no opponent block");
  const payday = payoutFor(match, "red");
  eq("the opponent's income is the economy module's payout for red",
    blue.opponent.income, { cities: payday.cities, amount: payday.amount });
  eq("and it is the red SEAT's own payday figure",
    [blue.opponent.income.cities, blue.opponent.income.amount],
    [red.seat.income.cities, red.seat.income.amount]);

  // The payload is the boundary. Grep it: no purse, no reserves, no fuel, no oil.
  const raw = JSON.stringify(blue.opponent);
  for (const forbidden of ["cash", "reserve", "fuel", "oil", "dry", "payIn"]) {
    must(!raw.includes('"' + forbidden), "the opponent payload carries " + forbidden + ": " + raw);
  }
  must(blue.opponent.income.amount > 0, "the 1986 opponent payday is zero, so the check proves nothing");

  // The dialog model copies the payday counts and adds no field of its own.
  const model = economyModel({ you: "blue", sites: blue.sites, seat: blue.seat, pieces: blue.pieces, opponent: blue.opponent });
  eq("the model carries the opponent payday", model.opponent, {
    income: { cities: blue.opponent.income.cities, amount: blue.opponent.income.amount },
  });
  must(!JSON.stringify(model.opponent).includes("cash"), "the dialog model invented an opponent purse");

  // A view with no opponent block (an older save, a spectator) yields no toggle rather than a
  // panel of zeros.
  eq("no opponent block means no opponent view",
    economyModel({ you: "blue", sites: blue.sites, seat: blue.seat, pieces: blue.pieces }).opponent, null);

  // --- the page -------------------------------------------------------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  must(app.includes("dataset.economyView"), "the page has no economy view toggle");
  must(app.includes('"Opponent balance"'), "the opponent view has no balance row");
  must(app.includes('"???"'), "the opponent balance does not print ???");
  must(app.includes('"Opponent income"'), "the opponent view has no income row");
  must(!/Opponent balance", [^?]*formatWholeBillions/.test(app),
    "the opponent balance row formats a real number");
}
