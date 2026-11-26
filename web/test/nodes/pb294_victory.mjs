// PB-294 pin: victory, manual_pages.txt l.114 and l.475.
//
//   l.114  the match ends when one side holds EVERY capital on the map;
//   l.475  and not one capital before - a side short of one capital has not won, and a neutral
//          capital (the original's owner byte with neither side's bits) blocks both sides;
//   l.442  in the concealed year the opponent's capital is hidden from the seat's view; the end
//          check must read the REAL capitals, not the visible ones.
//
// The producer is tick.checkWin (web/server/tick.mjs:105-118), which reads match.capitalSet.list
// through capitals.holderOf. The set itself is the era file's for 1918/1942/1986 and rolled for
// 2023/9999 (capitals.capitalSet); web/test/nodes/capitals_table.mjs already pins the neutral-capital
// rule and the table join, so this module pins the END CONDITION and what it reads, not the table.
import { warMatch } from "../wartime.mjs";
import { matchSites } from "../../server/board.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { checkWin, tickMatch } from "../../server/tick.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "pb294_victory";

function opening(era) {
  const match = warMatch(era, matchSites(era));
  seedOwners(match);
  match.pieces = [];
  match.round = 5;
  match.clock = "held";
  if (!match.capitalSet || !Array.isArray(match.capitalSet.list) || !match.capitalSet.list.length) {
    throw new Error("pb294: " + era + " carries no capital set");
  }
  return match;
}

const siteOf = (match, capital) => match.sites.find((site) => Number(site.id) === Number(capital.siteId));
const setOwners = (match, side) => { for (const capital of match.capitalSet.list) siteOf(match, capital).owner = side; };

export async function run(ctx) {
  const { fail } = ctx;

  // ---- l.114: every capital on the map, in both file eras -------------------------------------
  for (const era of ["1942", "1986"]) {
    const match = opening(era);
    const capitals = match.capitalSet.list;
    if (!(capitals.length >= 4)) fail("pb294: " + era + " carries " + capitals.length + " capitals; the arm needs a set worth calling a set");
    setOwners(match, "blue");
    const won = checkWin(match);
    if (won !== "blue") {
      fail("pb294 l.114: " + era + " with blue holding all " + capitals.length + " capitals read winner "
        + JSON.stringify(won) + " (producer: web/server/tick.mjs:105-118 checkWin)");
    }
    setOwners(match, "red");
    if (checkWin(match) !== "red") fail("pb294 l.114: " + era + " with red holding every capital did not read red");
    console.log("pb294 arm (l.114) ok: " + era + " — all " + capitals.length + " capitals one side reads that side, both ways");
  }

  // ---- l.475: NOT one capital before, and a neutral capital blocks ---------------------------
  for (const era of ["1942", "1986"]) {
    const match = opening(era);
    const capitals = match.capitalSet.list;
    const last = capitals[capitals.length - 1];
    setOwners(match, "blue");
    siteOf(match, last).owner = "red";
    if (checkWin(match) !== null) {
      fail("pb294 l.475: " + era + " ended the match with " + last.name + " (site " + last.siteId + ") still red — one capital short is not a victory");
    }
    siteOf(match, last).owner = null;
    if (checkWin(match) !== null) {
      fail("pb294 l.475: " + era + " ended the match with " + last.name + " NEUTRAL — the original's neutral capital blocks both sides (capitals.mjs holderOf)");
    }
    console.log("pb294 arm (l.475) ok: " + era + " — one capital red, then neutral, both read no winner");
  }

  // ---- the tick actually ends the match and names the capital that decided it -----------------
  {
    const match = opening("1986");
    const capitals = match.capitalSet.list;
    const last = capitals[capitals.length - 1];
    setOwners(match, "blue");
    const target = siteOf(match, last);
    target.owner = "red";
    // A blue infantry standing on the last red capital: the round's occupy pass takes it.
    match.pieces = [{
      id: "blue:inf:294", side: "blue", domain: "land", kind: "infantry",
      x: target.x, y: target.y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
      strength: 100, maxStrength: 100,
    }];
    match.round = 6;
    match.clock = "running";
    tickMatch(match);
    if (match.over !== true || match.winner !== "blue") {
      fail("pb294 l.114: taking the last capital did not end the match (over " + JSON.stringify(match.over)
        + ", winner " + JSON.stringify(match.winner) + ", clock " + match.clock + ")");
    }
    const reason = match.winReason || {};
    if (reason.kind !== "capitals" || Number(reason.siteId) !== Number(last.siteId)) {
      fail("pb294 l.114: the end named " + JSON.stringify(reason) + ", not the capital that decided it (site "
        + last.siteId + ", " + last.name + ")");
    }
    console.log("pb294 arm (tick) ok: the round that took " + last.name + " ended the match, winner blue, reason \"capitals\"");
  }

  // ---- l.442: the concealed year's end check reads the REAL capitals --------------------------
  // NOTE, measured: the concealment gate in view.mjs is keyed on era "9999" (CONCEALED_ERA,
  // view.mjs:37), not on "2023". 2023 rolls its two capitals the same way and runs the same
  // checkWin, so the rolled-set half is measured there and the visibility half in "9999". Saying
  // "2023" where the code says "9999" would make this arm vacuous: 2023 is ordinary fog-of-war,
  // where a piece out of sight is hidden for reasons that have nothing to do with the concealed era.
  {
    const concealed = opening("9999");
    if (concealed.capitalSet.source !== "rolled") {
      fail("pb294 l.442: the concealed year's capital set is " + JSON.stringify(concealed.capitalSet.source) + ", expected the rolled draw");
    }
    if (!(concealed.capitalSet.list || []).length === 2) fail("pb294 l.442: the concealed year's set carries no pair");
    const [chome, cenemy] = concealed.capitalSet.list;
    for (const capital of concealed.capitalSet.list) siteOf(concealed, capital).owner = "blue";
    siteOf(concealed, cenemy).owner = "red";
    concealed.pieces = [{
      id: "red:inf:294b", side: "red", domain: "land", kind: "infantry",
      x: siteOf(concealed, cenemy).x, y: siteOf(concealed, cenemy).y, path: [], pace: 1, facing: null,
      fighting: null, shots: 0, strength: 100, maxStrength: 100,
    }];
    const cSeat = forSeat(concealed, "blue");
    const cShown = Array.isArray(cSeat && cSeat.pieces) ? cSeat.pieces : [];
    if (cShown.some((piece) => piece && piece.side === "red")) {
      fail("pb294 l.442: the concealed year showed blue a red piece on red's capital with no blue unit in sight");
    }
    const cBefore = concealed.capitalSet.list.map((c) => String(c.siteId)).join(",");
    if (checkWin(concealed) !== null) {
      fail("pb294 l.442: the concealed year's end check ignored the hidden capital and ended a match blue has not won");
    }
    const cAfter = (concealed.capitalSet.list || []).map((c) => String(c.siteId)).join(",");
    if (cBefore !== cAfter) fail("pb294 l.442: building the hidden seat's view changed the capital set (" + cBefore + " -> " + cAfter + ")");
    siteOf(concealed, chome).owner = "red";
    if (checkWin(concealed) !== "red") fail("pb294 l.442: red holding both concealed capitals did not read red");
    for (const capital of concealed.capitalSet.list) siteOf(concealed, capital).owner = "blue";
    concealed.pieces = [];
    if (checkWin(concealed) !== "blue") fail("pb294 l.442: blue holding both concealed capitals did not read blue");

    const match = opening("2023");
    if (match.capitalSet.source !== "rolled") {
      fail("pb294 l.442: 2023's capital set is " + JSON.stringify(match.capitalSet.source) + ", expected the rolled draw");
    }
    const capitals = match.capitalSet.list;
    if (capitals.length !== 2) fail("pb294 l.442: 2023's capital set carries " + capitals.length + " capitals, expected the pair");
    const [home, enemy] = capitals;
    setOwners(match, "blue");
    siteOf(match, enemy).owner = "red";

    // What the blue seat is SHOWN. The concealed year withholds the enemy until one of the seat's own
    // pieces has it in sight (view.mjs capitalVisible): a red infantry standing on red's capital is
    // invisible to blue here, because blue has no piece anywhere near it.
    match.pieces = [{
      id: "red:inf:294", side: "red", domain: "land", kind: "infantry",
      x: siteOf(match, enemy).x, y: siteOf(match, enemy).y, path: [], pace: 1, facing: null,
      fighting: null, shots: 0, strength: 100, maxStrength: 100,
    }];
    const seat = forSeat(match, "blue");
    const shownPieces = Array.isArray(seat && seat.pieces) ? seat.pieces : [];
    const enemySeen = shownPieces.some((piece) => piece && piece.side === "red");
    if (enemySeen) {
      fail("pb294 l.442: the concealed year showed blue a red piece on red's own capital with no blue unit in sight - the fixture no longer conceals anything");
    }
    // What the END CHECK reads: the real set, untouched by the seat's filter. One red capital blocks.
    const before = capitals.map((capital) => String(capital.siteId)).join(",");
    const after = (match.capitalSet.list || []).map((capital) => String(capital.siteId)).join(",");
    if (before !== after) fail("pb294 l.442: building the hidden seat's view changed the capital set (" + before + " -> " + after + ")");
    if (checkWin(match) !== null) {
      fail("pb294 l.442: the end check ignored the concealed capital " + enemy.name + " (site " + enemy.siteId
        + ") and ended a match blue has not won");
    }
    siteOf(match, home).owner = "red";
    if (checkWin(match) !== "red") fail("pb294 l.442: red holding both capitals did not read red");
    setOwners(match, "blue");
    match.pieces = [];
    if (checkWin(match) !== "blue") {
      fail("pb294 l.442: blue holding both capitals did not read blue after the concealed one was taken");
    }
    console.log("pb294 arm (l.442) ok: concealed \"9999\" — a red piece on red's capital is invisible to blue, the seat's view leaves the capital set unchanged, and the end check still requires that capital; 2023 rolls the same pair and reads " + JSON.stringify([match.capitalSet.list.length, checkWin(match)]));
  }
}
