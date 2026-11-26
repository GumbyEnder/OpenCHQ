// PB-262: the buy's draw site at level 5.
//
// The original's buy, FUN_107e_1612 @ 107e:1612, gates the re-draw on
// `*(int *)0x1a0 < 5 && *(char *)(param_1 + 0x10ae) != 0` (decompiled.c 1632): at levels 2-4 a
// site whose readiness timer is still running sends the buy to ANOTHER of our sites
// (FUN_107e_307a, 1635); at level 5 the same site is used. So the level decides WHICH site's unit
// the buy draws from, and this node pins every side of it:
//
//   1-5  the engine: L4 refuses an unready site; a level-5 buy WITHOUT the intent flag refuses
//        too (level alone is not permission - frodo 9492 §4); the explicit
//        options.allowUnreadySite buys there; the click and L1 still refuse.
//   6    the wiring: botBuy() at L5 takes the unready anchor and sets the flag on its event; at
//        L4 it neither takes the anchor nor sets it. A bot.mjs `>= 5` -> `>= 6` mutant reds the
//        L5 half, `>= 5` -> `>= 1` reds the L4 half.
//   7    the human path: a player's buy() at an unready site is refused, so no allowUnreadySite
//        reaches the shop window; the placement default refuses it too.
//
// What breaks if this file is removed: buy() stops taking the level, level 5 goes back to being
// identical to level 4 on this axis, botBuy stops forwarding the intent, and nothing notices if
// the exception widens to levels 2-4, to every unready site, to a bare level-5 caller, or to the
// player's click.
export const name = "t032_buy_draw_site";

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy } from "../../server/economy.mjs";
import { botBuy } from "../../server/bot.mjs";
import { canPlace } from "../../server/placement.mjs";
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

// A fresh 1942 match with one unready blue city: round 3, the city counting down to round 9.
function unreadyAnchor() {
  const board = boardPayload();
  const match = openMatch("1942", matchSites("1942", board));
  match.seats = { blue: { username: "A", kind: "bot" }, red: { username: "B", kind: "bot" } };
  match.clock = "running";
  const site = freeBlueSite(match);
  if (!site) return { board, match, site: null };
  match.round = 3;
  site.readyRound = 9;
  return { board, match, site };
}

function pieceAt(match, x, y) {
  return match.pieces.find((piece) => piece.x === x && piece.y === y) || null;
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

  // 2. LEVEL 5 ALONE IS NOT PERMISSION (frodo 9492 §4). The exception is keyed on intent, so a
  //    caller that passes the number and nothing else is refused. This is the arm that stops the
  //    rule drifting back to "level >= 5 means any level-5 caller may buy anywhere unready".
  const levelOnly = buy(match, "blue", "infantry", site.x, site.y, board, 5);
  if (!levelOnly || levelOnly.error === undefined) {
    fail("t032_buy_draw_site: a level-5 buy with no intent flag bought at an unready site: "
      + JSON.stringify(levelOnly));
  }
  if (!/isn't ready/.test(String(levelOnly.error))) {
    fail("t032_buy_draw_site: the level-5 refusal is not the readiness one: " + levelOnly.error);
  }
  if (match.sides.blue.cash !== before4) fail("t032_buy_draw_site: a refused level-5 buy charged the pool");

  // 2b. THE CALLERS ARM (PM 9496 §1, frodo 9495 §3): the same level-5 call from a match whose
  //     seats are both kind "human" must REFUSE. The exception belongs to the bot's decision, not
  //     to the seat and not to the number, so a caller that supplies 5 alone gets the readiness
  //     sentence even when no bot is in the match at all.
  //     Scoped so the arm names its own match and board: the whole point is that no bot is in it.
  {
    const humanSeat = unreadyAnchor();
    if (!humanSeat.site) fail("t032_buy_draw_site: no free blue city for the callers arm");
    const match = humanSeat.match;
    const board = humanSeat.board;
    match.seats = { blue: { username: "A", kind: "human" }, red: { username: "B", kind: "human" } };
    const cash = match.sides.blue.cash;
    const pieces = match.pieces.length;
    const callers = buy(match, "blue", "infantry", humanSeat.site.x, humanSeat.site.y, humanSeat.board, 5);
    if (!callers || callers.error === undefined) {
      fail("t032_buy_draw_site: a non-bot caller at level 5 bought at an unready site: " + JSON.stringify(callers));
    }
    if (!/isn't ready/.test(String(callers.error))) {
      fail("t032_buy_draw_site: the callers-arm refusal is not the readiness one: " + callers.error);
    }
    if (match.sides.blue.cash !== cash) fail("t032_buy_draw_site: the callers-arm refusal charged the pool");
    if (match.pieces.length !== pieces) fail("t032_buy_draw_site: the callers-arm refusal filed a piece");
  }

  // 3. THE EXPLICIT INTENT - options.allowUnreadySite. The same cell, the same timer, and the buy
  //    goes through at that site, still reporting the level for the record.
  const allowed = canPlace(match, "blue", "infantry", site.x, site.y, board, { allowUnreadySite: true });
  if (allowed && allowed.error !== undefined) {
    fail("t032_buy_draw_site: canPlace with the intent flag refused an unready site: " + allowed.error);
  }
  // The placement's own readyRound must describe the site, not assert readiness (frodo 9492 §3):
  // a success on the allowed branch used to return a constant 0.
  if (allowed.readyRound !== 9) {
    fail("t032_buy_draw_site: the placement reported readyRound " + JSON.stringify(allowed.readyRound) + ", not 9");
  }
  const before5 = match.sides.blue.cash;
  const bought = buy(match, "blue", "infantry", site.x, site.y, board, 5, { allowUnreadySite: true });
  if (!bought || bought.ok !== true) {
    fail("t032_buy_draw_site: the explicit intent was refused an unready site: " + JSON.stringify(bought));
  }
  if (bought.site !== site.id) fail("t032_buy_draw_site: the level-5 draw came from site " + bought.site + ", not " + site.id);
  if (bought.level !== 5) fail("t032_buy_draw_site: the buy did not report its level: " + bought.level);
  if (bought.piece.x !== site.x || bought.piece.y !== site.y) {
    fail("t032_buy_draw_site: the level-5 buy landed at " + bought.piece.x + "," + bought.piece.y);
  }
  if (before5 - match.sides.blue.cash !== price) {
    fail("t032_buy_draw_site: level 5 changed the charge: " + (before5 - match.sides.blue.cash) + " vs " + price);
  }

  // 4. NO LEVEL, NO OPTIONS (a player's click) - the same site still refuses, so the exception is
  //    the AI's own decision and never the shop window.
  const other = match.sites.find((row) => row && row.owner === "blue" && String(row.kind) === "city"
    && row.id !== site.id && !match.pieces.some((piece) => piece.x === row.x && piece.y === row.y));
  if (!other) fail("t032_buy_draw_site: no second free blue city to test the player's click");
  other.readyRound = 9;
  const player = buy(match, "blue", "infantry", other.x, other.y, board);
  if (!player || player.error === undefined) {
    fail("t032_buy_draw_site: a player's click bought at an unready site: " + JSON.stringify(player));
  }

  // 5. LEVEL 1 - below the gate as well: the exception is the level-5 branch, not "any level".
  const low = buy(match, "blue", "infantry", other.x, other.y, board, 1);
  if (!low || low.error === undefined) fail("t032_buy_draw_site: level 1 bought at an unready site");

  // 6. THE WIRING (bot path). botBuy(match, side, events, urgentSite, level) is the caller that
  //    carries the difficulty into 0x1a0. Two fresh matches, one anchor, two levels: at L5 the
  //    anchor cell is taken, the piece files there, and the bot_buy event carries the intent flag
  //    the census replays; at L4 the anchor cell is not taken (the buy may land at another of our
  //    cities - that is the re-draw - but never at the anchor) and no event claims the flag.
  //    `>= 5` -> `>= 6` reds the L5 half; `>= 5` -> `>= 1` reds the L4 half.
  const wiring5 = unreadyAnchor();
  if (!wiring5.site) fail("t032_buy_draw_site: no free blue city for the wiring arm");
  const cash5 = wiring5.match.sides.blue.cash;
  const events5 = [];
  const took5 = botBuy(wiring5.match, "blue", events5, wiring5.site, 5);
  if (took5 !== true) {
    fail("t032_buy_draw_site: botBuy at level 5 did not buy at the unready anchor: " + JSON.stringify(events5));
  }
  const filed5 = pieceAt(wiring5.match, wiring5.site.x, wiring5.site.y);
  if (!filed5 || filed5.side !== "blue") {
    fail("t032_buy_draw_site: botBuy at level 5 did not file the piece at the anchor " + wiring5.site.id);
  }
  const note5 = events5.find((event) => event.type === "bot_buy");
  if (!note5 || !note5.at || note5.at.x !== wiring5.site.x || note5.at.y !== wiring5.site.y) {
    fail("t032_buy_draw_site: the level-5 bot_buy event is not at the anchor: " + JSON.stringify(events5));
  }
  if (note5.allowUnreadySite !== true) {
    fail("t032_buy_draw_site: the level-5 bot_buy did not carry the intent flag the census replays");
  }
  if (cash5 - wiring5.match.sides.blue.cash !== price) {
    fail("t032_buy_draw_site: the level-5 bot buy charged " + (cash5 - wiring5.match.sides.blue.cash) + ", not " + price);
  }

  const wiring4 = unreadyAnchor();
  if (!wiring4.site) fail("t032_buy_draw_site: no free blue city for the level-4 wiring arm");
  const events4 = [];
  const took4 = botBuy(wiring4.match, "blue", events4, wiring4.site, 4);
  const filed4 = pieceAt(wiring4.match, wiring4.site.x, wiring4.site.y);
  if (filed4) {
    fail("t032_buy_draw_site: botBuy at level 4 bought at the unready anchor " + wiring4.site.id
      + " (piece " + filed4.id + ", took=" + took4 + ")");
  }
  if (took4 === true && events4.some((event) => event.type === "bot_buy"
    && event.at && event.at.x === wiring4.site.x && event.at.y === wiring4.site.y)) {
    fail("t032_buy_draw_site: a level-4 bot_buy event names the unready anchor");
  }
  if (events4.some((event) => event.type === "bot_buy" && event.allowUnreadySite === true)) {
    fail("t032_buy_draw_site: a level-4 bot_buy claimed the unready-site intent: " + JSON.stringify(events4));
  }

  // 7. THE HUMAN PATH. The click comes in as buy(match, side, kind, x, y, board) with no level
  //    (lobby.mjs:1514), so the exception must be unreachable from it: the refusal stays the
  //    readiness one, no cash leaves the pool, no piece is filed. Then the same cell through
  //    canPlace with an options object that does NOT grant the escape - the placement default.
  //    A buy() that reads "no level" as permission reds this arm.
  const human = unreadyAnchor();
  if (!human.site) fail("t032_buy_draw_site: no free blue city for the human arm");
  const cashH = human.match.sides.blue.cash;
  const piecesH = human.match.pieces.length;
  const click = buy(human.match, "blue", "infantry", human.site.x, human.site.y, human.board);
  if (!click || click.error === undefined) {
    fail("t032_buy_draw_site: the player's click bought at an unready site: " + JSON.stringify(click));
  }
  if (!/isn't ready/.test(String(click.error))) {
    fail("t032_buy_draw_site: the click's refusal is not the readiness one: " + click.error);
  }
  if (human.match.sides.blue.cash !== cashH) fail("t032_buy_draw_site: a refused click charged the pool");
  if (human.match.pieces.length !== piecesH) fail("t032_buy_draw_site: a refused click still filed a piece");
  const strict = canPlace(human.match, "blue", "infantry", human.site.x, human.site.y, human.board, {});
  if (!strict || strict.error === undefined) {
    fail("t032_buy_draw_site: canPlace bought at an unready site with an options object: " + JSON.stringify(strict));
  }
  // The sentinel: a click carries NO level, and the buy must report that as null, not as level 0.
  // `Number(null)` is 0, so this assertion is what stops "no level" drifting into a level value.
  const readyHuman = human.match.sites.find((row) => row && row.owner === "blue"
    && String(row.kind) === "city" && row.id !== human.site.id
    && !human.match.pieces.some((piece) => piece.x === row.x && piece.y === row.y));
  if (!readyHuman) fail("t032_buy_draw_site: no ready blue city for the sentinel arm");
  const humanBuy = buy(human.match, "blue", "infantry", readyHuman.x, readyHuman.y, human.board);
  if (!humanBuy || humanBuy.ok !== true) {
    fail("t032_buy_draw_site: a player's buy at a READY site was refused: " + JSON.stringify(humanBuy));
  }
  if (humanBuy.level !== null) {
    fail("t032_buy_draw_site: a player's buy reported level " + JSON.stringify(humanBuy.level) + ", not null");
  }

  console.log("t032_buy_draw_site: L4 refuses an unready site, a bare level 5 refuses too, the explicit"
    + " intent buys there at the site's own readyRound, the click and L1 refuse, botBuy takes the"
    + " anchor at L5 and not at L4, the player's buy is never escaped");
}
