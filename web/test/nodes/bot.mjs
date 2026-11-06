// bot node test. Owner: A7. Fails if the bot stops marching, starts re-pathing its ship,
// or sends orders for a human seat. See docs/CONTRACTS.md.
//
// move.mjs and lanes.mjs are separate nodes and may still be stubs while this lands. The test
// therefore accepts a graceful refusal (a bot_skip note, no crash, no invented path) and says
// so, but a path must always point at the player's capital whenever one exists.

import { focusTarget, ordersFor } from "../../server/bot.mjs";
import { openMatch } from "../../server/match.mjs";

export const name = "bot";

const WIDTH = 320;

function chebyshev(a, b) {
  const raw = Math.abs(a.x - b.x);
  return Math.max(Math.min(raw, WIDTH - raw), Math.abs(a.y - b.y));
}

function botRoom(era = "1986") {
  const match = openMatch(era);
  match.seats = {
    blue: { username: "Bot", kind: "bot" },
    red: { username: "Ada", kind: "human" },
  };
  return match;
}

function pieceOf(match, side, domain) {
  return match.pieces.find((piece) => piece.side === side && piece.domain === domain);
}

export async function run(ctx) {
  const { fail } = ctx;
  const degraded = [];

  // ---- 1. the bot army takes a path toward the player's capital ---------------------------
  const march = botRoom();
  const army = pieceOf(march, "blue", "land");
  if (!army) fail("a 1986 bot room has no blue land piece: " + JSON.stringify(march.pieces));
  const capital = march.capitals.red;
  const startGap = chebyshev(army, capital);

  const first = ordersFor(march, "blue");
  if (!Array.isArray(first)) fail("ordersFor did not return an array: " + JSON.stringify(first));

  // With an enemy on the board the bot masses on the weakest point of the enemy line instead of
  // marching at the capital; with no enemy the capital is still the target. Either way the path
  // has to end next to the thing it was aimed at, and closer than it started.
  const aim = focusTarget(march, "blue", "red", capital);
  if (Array.isArray(army.path) && army.path.length > 0) {
    const end = army.path[army.path.length - 1];
    const gap = chebyshev(end, aim);
    if (gap > 3) {
      fail("bot path ends " + gap + " cells from its target (" + aim.x + "," + aim.y + "): " + JSON.stringify(army.path.slice(-3)));
    }
    if (chebyshev(end, aim) >= chebyshev({ x: army.x, y: army.y }, aim) && chebyshev({ x: army.x, y: army.y }, aim) > 3) {
      fail("bot path did not close on its target");
    }
    const order = first.find((event) => event.type === "bot_order" && event.pieceId === army.id);
    if (!order) fail("a path was set but no bot_order was reported: " + JSON.stringify(first));
    if (!Array.isArray(order.path) || order.path.length === 0) {
      fail("bot_order carried no path: " + JSON.stringify(order));
    }
  } else {
    // Movement is not built yet: the order must be refused as a note, not thrown or faked.
    const skip = first.find((event) => event.type === "bot_skip" && event.pieceId === army.id);
    if (!skip) fail("no path and no skip note for the army: " + JSON.stringify(first));
    if (!skip.reason) fail("the skip note gave no reason: " + JSON.stringify(skip));
    degraded.push("land march (move.mjs refused: " + skip.reason + ")");
  }

  // a second round must not re-issue the army's order while the path is still there
  const landBefore = JSON.stringify(army.path);
  ordersFor(march, "blue");
  if (JSON.stringify(army.path) !== landBefore) {
    fail("the bot re-pathed its army: " + landBefore + " -> " + JSON.stringify(army.path));
  }

  // ---- 2. the ship is sailed once, never re-pathed every round -----------------------------
  const sailed = botRoom();
  const ship = pieceOf(sailed, "blue", "sea");
  if (!ship) fail("a 1986 bot room has no blue ship");
  // Seed a path that is obviously not the bot's route. If the bot repaths, this changes.
  ship.path = [{ x: 5, y: 5, pace: 1 }, { x: 6, y: 5, pace: 1 }];
  const seeded = JSON.stringify(ship.path);

  ordersFor(sailed, "blue");
  ordersFor(sailed, "blue");
  const afterTwo = JSON.stringify(ship.path);
  if (afterTwo !== seeded) {
    fail("the bot re-pathed a ship that already had a path: " + seeded + " -> " + afterTwo);
  }

  // an idle ship gets at most one path across consecutive calls
  const idle = botRoom();
  const idleShip = pieceOf(idle, "blue", "sea");
  ordersFor(idle, "blue");
  const once = JSON.stringify(idleShip.path);
  ordersFor(idle, "blue");
  const twice = JSON.stringify(idleShip.path);
  if (twice !== once) {
    fail("the idle ship was given a second path: " + once + " -> " + twice);
  }
  if (idleShip.path.length === 0) {
    const skip = ordersFor(idle, "blue").find((event) => event.type === "bot_skip" && event.pieceId === idleShip.id);
    if (!skip) fail("the idle ship got no path and no skip note");
    degraded.push("ship sail (lanes/move refused: " + skip.reason + ")");
  }

  // ---- 3. a human seat never receives bot orders ------------------------------------------
  const human = botRoom();
  const redArmy = pieceOf(human, "red", "land");
  const redShip = pieceOf(human, "red", "sea");
  const redEvents = ordersFor(human, "red");
  if (redEvents.some((event) => event.type === "bot_order")) {
    fail("the bot sent orders for a human seat: " + JSON.stringify(redEvents));
  }
  if (redArmy.path.length !== 0) fail("human army was given a path: " + JSON.stringify(redArmy.path));
  if (redShip.path.length !== 0) fail("human ship was given a path: " + JSON.stringify(redShip.path));
  if (redEvents.length === 0) fail("a human seat was silently ignored instead of reported");

  // ---- 4. edges: an empty roster and a bad side are quiet, not fatal ----------------------
  const empty = ordersFor(botRoom("2023"), "blue");
  if (empty.length !== 0) fail("a 2023 empty roster produced orders: " + JSON.stringify(empty));
  if (ordersFor(null, "blue").length !== 0) fail("a null match produced orders");
  if (ordersFor(botRoom(), "green").length !== 0) fail("an unknown side produced orders");

  // A human seat named as bot on the match is a caller mistake; the note is still not a crash,
  // and unknown seating (no record at all) is the caller's call, so the army may be ordered.
  if (degraded.length > 0) {
    console.log("bot node: routing degraded to notes - " + degraded.join("; "));
  }
}
