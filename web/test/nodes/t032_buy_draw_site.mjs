// PB-262: the buy's draw site at level 5.
//
// The original's buy, FUN_107e_1612 @ 107e:1612, gates the re-draw on
// `*(int *)0x1a0 < 5 && *(char *)(param_1 + 0x10ae) != 0` (decompiled.c 1632): at levels 2-4 a
// site whose readiness timer is still running sends the buy to ANOTHER of our sites
// (FUN_107e_307a, 1635); at level 5 the same site is used. So the level decides WHICH site's unit
// the buy draws from, and this node pins both sides of it.
//
// What breaks if this file is removed: buy() stops taking the level, level 5 goes back to being
// identical to level 4 on this axis, and nothing notices if the exception widens to levels 2-4 or
// to every unready site.
export const name = "t032_buy_draw_site";

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy } from "../../server/economy.mjs";
import { priceOf } from "../../server/rules.mjs";

// A blue city that no piece stands on: the buy needs a free cell, and 1942's file owns plenty.
function freeBlueSite(match) {
  for (const site of match.sites) {
    if (!site || site.owner !== "blue") continue;
    if (String(site.kind) !== "city") continue;
    const taken = match.pieces.some((piece) => piece.x === site.x && piece.y === site.y);
    if (!taken) return site;
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  const match = openMatch("1942", matchSites("1942", board));
  match.seats = { blue: { username: "A", kind: "bot" }, red: { username: "B", kind: "bot" } };
  match.clock = "running";
  const site = freeBlueSite(match);
  if (!site) fail("t032_buy_draw_site: no free blue city in the 1942 opening");

  // Round 3 with the city counting down to round 9: unready by every reading of 0x10ae the port has.
  match.round = 3;
  site.readyRound = 9;
  const price = priceOf("infantry");

  // 1. LEVEL 4 - the pick is not available, and the buy refuses by name (the re-draw is the
  //    caller's job at this level; FUN_107e_307a is where the source sends it).
  const before4 = match.sides.blue.cash;
  const refused = buy(match, "blue", "infantry", site.x, site.y, board, 4);
  if (!refused || refused.error === undefined) {
    fail("t032_buy_draw_site: level 4 bought at an unready site: " + JSON.stringify(refused));
  }
  if (!/isn't ready/.test(String(refused.error))) {
    fail("t032_buy_draw_site: level 4 refusal is not the readiness one: " + refused.error);
  }
  if (match.sides.blue.cash !== before4) fail("t032_buy_draw_site: a refused buy charged the pool");

  // 2. LEVEL 5 - the same cell and the same timer, and the buy goes through at that site.
  const before5 = match.sides.blue.cash;
  const bought = buy(match, "blue", "infantry", site.x, site.y, board, 5);
  if (!bought || bought.ok !== true) {
    fail("t032_buy_draw_site: level 5 refused an unready site: " + JSON.stringify(bought));
  }
  if (bought.site !== site.id) fail("t032_buy_draw_site: level 5 drew from site " + bought.site + ", not " + site.id);
  if (bought.level !== 5) fail("t032_buy_draw_site: the buy did not report its level: " + bought.level);
  if (bought.piece.x !== site.x || bought.piece.y !== site.y) {
    fail("t032_buy_draw_site: the level-5 buy landed at " + bought.piece.x + "," + bought.piece.y);
  }
  if (before5 - match.sides.blue.cash !== price) {
    fail("t032_buy_draw_site: level 5 changed the charge: " + (before5 - match.sides.blue.cash) + " vs " + price);
  }

  // 3. NO LEVEL (a player's click) - unchanged: the same site still refuses, so the exception is
  //    the AI's level and never the shop window.
  const other = match.sites.find((row) => row && row.owner === "blue" && String(row.kind) === "city"
    && row.id !== site.id && !match.pieces.some((piece) => piece.x === row.x && piece.y === row.y));
  if (!other) fail("t032_buy_draw_site: no second free blue city to test the player's click");
  other.readyRound = 9;
  const player = buy(match, "blue", "infantry", other.x, other.y, board);
  if (!player || player.error === undefined) {
    fail("t032_buy_draw_site: a player's click bought at an unready site: " + JSON.stringify(player));
  }

  // 4. LEVEL 1 - below the gate as well: the exception is 0x1a0 >= 5, not "any level".
  const low = buy(match, "blue", "infantry", other.x, other.y, board, 1);
  if (!low || low.error === undefined) fail("t032_buy_draw_site: level 1 bought at an unready site");

  console.log("t032_buy_draw_site: L4 refuses an unready site, L5 draws from it, the click and L1 still refuse");
}
