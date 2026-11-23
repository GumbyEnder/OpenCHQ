// PB-197 — a bot unit held for more than three rounds re-plans instead of reporting "moving".
//
// What breaks if this is removed: ordersFor() skipped every piece with a non-empty path, so a bot
// unit whose order could not be walked (a friendly stood on the destination) was never re-ordered.
// It kept "moving" for the rest of the match. The counter is the one advance() keeps on the piece
// (`holdRounds`), incremented per blocked step and cleared by a real step; this leg drives both
// halves through the real modules.

import { openMatch } from "../../server/match.mjs";
import { ordersFor } from "../../server/bot.mjs";
import { issueOrder, advance, wrapX, HOLD_STALL_ROUNDS } from "../../server/move.mjs";

export const name = "pb197_bot_replan";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function infantry(id, side, x, y) {
  return { id, side, kind: "infantry", domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

function botRoom() {
  const match = openMatch("1986");
  match.seats = {
    blue: { username: "Ada", kind: "human" },
    red: { username: "Bot", kind: "bot" },
  };
  match.round = 5;
  return match;
}

export async function run(ctx) {
  // ---- the counter is real: advance() raises it on a blocked step, a step clears it ---------
  {
    const match = botRoom();
    match.pieces = [infantry("red:mover", "red", 100, 100), infantry("blue:wall", "blue", 101, 100)];
    const order = issueOrder(match, "red", "red:mover", 105, 100);
    must(order.ok, "PB-197: the order into the enemy's cell was refused: " + JSON.stringify(order));
    // Pace is terrain's; pin the fixture to open ground so the leg measures the counter, not the map.
    for (const step of match.pieces[0].path) step.pace = 1;
    for (let round = 1; round <= 3; round++) {
      advance(match);
      must(Number(match.pieces[0].holdRounds || 0) === round,
        "PB-197: the blocked counter is " + match.pieces[0].holdRounds + " after " + round + " blocked rounds");
    }
  }

  // ---- more than three blocked rounds: the bot re-plans onto a fresh goal -------------------
  const match = botRoom();
  const bot = match.pieces.find((piece) => piece.side === "red" && piece.domain === "land");
  must(bot, "PB-197: the 1986 bot room has no red land piece");
  // A stationary friend stands on the cell the bot's stored order is aimed at. This is the same
  // shape as the live 78,45 / 77,45 defect, one order later.
  const stander = infantry("red:stander", "red", wrapX(bot.x + 1), bot.y);
  match.pieces.push(stander);
  bot.path = [{ x: stander.x, y: stander.y, pace: 1 }];
  bot.pace = 1;
  bot.credit = 0;
  bot.holdRounds = HOLD_STALL_ROUNDS + 1;
  const heldTo = { x: stander.x, y: stander.y };

  // A path that has NOT been held that long is still left alone (the bot must not re-path every
  // round; the older bot test pins the same rule).
  const fresh = infantry("red:fresh", "red", wrapX(bot.x - 3), bot.y);
  match.pieces.push(fresh);
  fresh.path = [{ x: fresh.x + 1, y: fresh.y, pace: 1 }];
  fresh.holdRounds = HOLD_STALL_ROUNDS;
  const freshPath = JSON.stringify(fresh.path);

  const events = ordersFor(match, "red");
  const replan = events.find((event) => event.type === "bot_replan" && event.pieceId === bot.id);
  must(replan, "PB-197: a bot unit held for " + (HOLD_STALL_ROUNDS + 1) + " rounds was not re-planned: " +
    JSON.stringify(events.map((event) => event.type + ":" + (event.pieceId || ""))));
  must(Number(bot.holdRounds) === 0, "PB-197: the re-plan did not reset the held counter");
  must(JSON.stringify(fresh.path) === freshPath, "PB-197: a unit held exactly " + HOLD_STALL_ROUNDS +
    " rounds was re-pathed; only MORE than " + HOLD_STALL_ROUNDS + " is a stall");

  const order = events.find((event) => event.type === "bot_order" && event.pieceId === bot.id);
  must(order, "PB-197: the re-plan issued no new order: " + JSON.stringify(events.map((event) => event.type)));
  must(Array.isArray(bot.path) && bot.path.length > 0, "PB-197: the re-plan left the unit with no path");
  const newTo = bot.path[bot.path.length - 1];
  must(!(wrapX(newTo.x) === wrapX(heldTo.x) && Number(newTo.y) === Number(heldTo.y)),
    "PB-197: the re-plan picked the SAME held cell again (" + heldTo.x + "," + heldTo.y + ")");

  // ---- and the re-planned unit actually walks ----------------------------------------------
  const start = { x: wrapX(bot.x), y: Number(bot.y) };
  for (let round = 0; round < 3; round++) advance(match);
  const moved = wrapX(bot.x) !== start.x || Number(bot.y) !== start.y;
  must(moved, "PB-197: the re-planned bot unit did not move from " + start.x + "," + start.y +
    " (holdRounds " + bot.holdRounds + ", path " + bot.path.length + ")");

  console.log("pb197_bot_replan: held counter rises per blocked round, a stall of more than " +
    HOLD_STALL_ROUNDS + " rounds re-plans onto a new goal and walks");
}
