// A bot that only marches its opening two pieces is invisible on a 67-round play-test. Within 50
// rounds it must buy at least one unit and move at least one piece, and every decision must be an
// event the server can log and the owner can see.
import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { ordersFor } from "../../server/bot.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { debugRows } from "../../public/shell.mjs";

export const name = "bot_activity";

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("bot_activity: no board cells");

  const match = openMatch("1942", matchSites("1942", board));
  match.seats = {
    blue: { username: "Bot", kind: "bot" },
    red: { username: "Bot", kind: "bot" },
  };
  match.clock = "running";

  const start = new Map(match.pieces.map((piece) => [piece.id, { x: piece.x, y: piece.y }]));
  let bought = 0;
  let ordered = 0;
  let moved = 0;

  for (let round = 1; round <= 50; round++) {
    for (const side of ["blue", "red"]) {
      const events = ordersFor(match, side) || [];
      bought += events.filter((event) => event.type === "bot_buy").length;
      ordered += events.filter((event) => event.type === "bot_order").length;
    }
    tickMatch(match);
    for (const piece of match.pieces) {
      const before = start.get(piece.id);
      if (!before) {
        start.set(piece.id, { x: piece.x, y: piece.y });
        continue;
      }
      if (before.x !== piece.x || before.y !== piece.y) {
        moved += 1;
        start.set(piece.id, { x: piece.x, y: piece.y });
      }
    }
  }

  if (bought < 1) fail("bot_activity: the bot bought nothing in 50 rounds");
  if (ordered < 1) fail("bot_activity: the bot issued no order in 50 rounds");
  if (moved < 1) fail("bot_activity: no bot piece changed cell in 50 rounds");

  // The owner's debug view renders the last actions; a player's room never carries the field.
  const rows = debugRows({
    room: {
      id: "r1",
      era: "1942",
      round: 12,
      pieces: [],
      sites: [],
      botActions: [
        { round: 11, type: "buy", kind: "infantry", at: { x: 5, y: 6 } },
        { round: 12, type: "order", piece: "red:land", to: { x: 7, y: 8 } },
      ],
    },
  });
  const flat = rows.map((row) => row.join(": ")).join(" | ");
  if (!/bot r11: buy infantry at 5,6/.test(flat)) fail("the debug view does not show the bot's buy: " + flat);
  if (!/bot r12: order red:land -> 7,8/.test(flat)) fail("the debug view does not show the bot's order: " + flat);

  // And the lobby sends that field only to the owner account.
  const { readFileSync } = await import("node:fs");
  const lobby = readFileSync(new URL("../../server/lobby.mjs", import.meta.url), "utf8");
  if (!lobby.includes("isOwner(username)")) fail("the lobby does not gate botActions to the owner");

  console.log("bot_activity: within 50 rounds " + bought + " buys, " + ordered +
    " orders, " + moved + " piece moves; debug view renders the last actions");
}
