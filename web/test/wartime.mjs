// PB-245b: 1986 and 2023 open in the COLD WAR (manual printed p.31), so a node fixture that asserts
// a WARTIME rule has to leave the peace first - exactly what a player does by pressing Begin
// Hostilities. One helper, so the decision is visible in each file instead of a copied incantation.
//
// The shipped config prints no mandatory length ({}), so `untilRound` is 0 and the war begins on the
// round the fixture already holds. A fixture that loads a config WITH a length is not a wartime
// fixture and should not call this: it is testing the peace itself.
import { openMatch } from "../server/match.mjs";
import { peaceActive, resumeWar } from "../server/peace.mjs";

export function atWar(match) {
  if (!match || !peaceActive(match)) return match;
  const until = Number(match.peace && match.peace.untilRound) || 0;
  const round = Math.max(Number(match.round) || 0, until);
  const out = resumeWar(match, "blue", round);
  if (!out || out.error) throw new Error("could not leave the cold war: " + (out && out.error));
  match.round = round;
  return match;
}

// A fixture's match, already at war. Same arguments as openMatch.
export function warMatch(era, sites, options) {
  return atWar(openMatch(era, sites, options));
}
