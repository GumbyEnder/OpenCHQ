// PB-245: peacetime is a STATE the war can leave again, not the end of the match.
//
// Manual printed p.31: "At the start of the 1986 and 2023 scenarios, and at any time during those
// scenarios that both players agree, peacetime conditions prevail. At the start of the game, this
// is called the cold war. During a war, it is called a cease-fire." One condition, two entry
// points - which is exactly the original's `DS:0xc34e` = 1 (peacetime) / 2 (wartime), a
// two-valued flag (docs/re/START_MONEY.md, FUN_2bad_034e @ 2bad:034e). So peace is modelled as
// one boolean on the match, never as an outcome: `over` and `winner` do not move when a cease fire
// is accepted.
//
// p.31 Duration: "Peace lasts for a pre-set amount of time, depending upon the scenario. A counter
// in Monitor One tells you how much time remains in mandatory peace; after that, either player can
// start the war by pressing Begin Hostilities/Cease Fire." p.32 War Status repeats the gate:
// "allows you to begin hostilities, but only after the mandatory time has elapsed." The length is
// printed nowhere; it comes from config `peace.mandatoryRounds` per scenario (UNVERIFIED) and the
// resume arms set it explicitly rather than inheriting a default.
//
// p.31 also sets what peace does to the rest of the round, and each of those hooks asks this
// module first: production does not make a city unready, a side neither uses nor generates oil,
// cash keeps accruing, enemy troops are invisible except to an Intel Scan, and transfers are
// instant.

import { eraOf } from "./match.mjs";
import { peaceRules } from "./rules.mjs";

export const PEACE_ACCEPTED_NOTE = "Cease fire accepted. The war is at peace.";
export const NOT_AT_PEACE = "The war is not at peace.";
export const PEACE_NOT_ELAPSED = "The mandatory peace has not elapsed";

// PB-245b: the scenarios that OPEN in the cold war. Manual printed p.31 names exactly two - "At the
// start of the 1986 and 2023 scenarios ... peacetime conditions prevail. At the start of the game,
// this is called the cold war" - so 1918 and 1942 are not in this list and still open at war. The
// list is a rule, not a tunable: a page that printed no other year cannot be widened by editing a
// number, and AC5 is exactly the absence of the two older years from it.
export const COLD_WAR_ERAS = Object.freeze(["1986", "2023"]);

export function opensAtPeace(year) {
  return COLD_WAR_ERAS.includes(String(year ?? ""));
}

// The sentence the other seat reads when the peace is broken. The original's own wording is
// archived as "Our warmonger enemy has broken the peace!" (exe_strings.txt:458); this build puts
// the acting seat's name where the original put "our warmonger enemy".
export function peaceBrokenNote(side) {
  const who = side === "blue" ? "Blue" : side === "red" ? "Red" : "The other side";
  return who + " has broken the peace: the war is on again.";
}

const SIDES = Object.freeze(["blue", "red"]);

function roundOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// How long mandatory peace lasts in THIS scenario. A scenario with no key gets no mandatory
// window, which is the only honest reading of a page that prints no numbers.
export function mandatoryRoundsForEra(year) {
  const { mandatoryRounds } = peaceRules();
  const scenario = String(eraOf(year));
  if (Object.hasOwn(mandatoryRounds, scenario)) return mandatoryRounds[scenario];
  if (Object.hasOwn(mandatoryRounds, "default")) return mandatoryRounds["default"];
  return 0;
}

export function mandatoryRoundsFor(match) {
  return mandatoryRoundsForEra(match && match.era);
}

// PB-245b: the state a scenario OPENS with (p.31 "At the start of the game, this is called the cold
// war"). Same shape as an accepted cease fire, with no seat named: nobody broke anything, and `by`
// stays null so the page cannot print "proposed by" for a peace the scenario itself started. The
// deadline is the config's per-scenario length (UNVERIFIED, {} by default), and `since` is round 0
// because that is where the clock is when the match is dealt.
export function openingPeace(year) {
  if (!opensAtPeace(year)) return null;
  const length = mandatoryRoundsForEra(year);
  return { active: true, since: 0, untilRound: length, by: null, brokenBy: null, coldWar: true };
}

export function peaceActive(match) {
  return Boolean(match && match.peace && match.peace.active === true);
}

// The state as one seat reads it. `canResume` is the counter's answer, not the page's guess:
// resume is legal only once the mandatory peace has elapsed (p.31 Duration, p.32 War Status).
export function peaceOf(match) {
  if (!match || !match.peace || typeof match.peace !== "object") return null;
  const since = roundOf(match.peace.since);
  const until = Number(match.peace.untilRound);
  const untilRound = Number.isFinite(until) && until > 0 ? Math.floor(until) : 0;
  const round = roundOf(match.round);
  return {
    active: match.peace.active === true,
    since,
    untilRound,
    remaining: Math.max(0, untilRound - round),
    canResume: match.peace.active === true && round >= untilRound,
    // The label Monitor One's counter prints. An agreed cease fire is a cease fire; a scenario that
    // OPENS at peace (PB-245b, p.31 "At the start of the game, this is called the cold war") sets
    // its own flag, and until then this reads false and the counter says "cease-fire".
    coldWar: match.peace.coldWar === true,
    by: SIDES.includes(match.peace.by) ? match.peace.by : null,
    brokenBy: SIDES.includes(match.peace.brokenBy) ? match.peace.brokenBy : null,
  };
}

// An accepted cease fire, or a scenario that opens in the cold war (PB-245b), lands here. The
// clock keeps running: nothing in this module touches `clock`, `over` or `winner`.
export function enterPeace(match, by, round) {
  const at = roundOf(round);
  match.peace = {
    active: true,
    since: at,
    untilRound: at + mandatoryRoundsFor(match),
    by: SIDES.includes(by) ? by : null,
    brokenBy: null,
  };
  return match.peace;
}

// Begin hostilities again. Refused before the mandatory counter reaches zero; one log line to
// the other seat when it is allowed (the event, not this function, carries the sentence).
export function resumeWar(match, side, round) {
  if (!match) return { error: "There is no match." };
  if (!SIDES.includes(side)) return { error: "Unknown side: " + side + "." };
  if (match.over) return { error: "The match is over." };
  if (!peaceActive(match)) return { error: NOT_AT_PEACE };
  const at = roundOf(round);
  const until = Number(match.peace.untilRound);
  const untilRound = Number.isFinite(until) && until > 0 ? Math.floor(until) : 0;
  if (at < untilRound) {
    return { error: PEACE_NOT_ELAPSED + ": " + (untilRound - at) + " round(s) remain.", remaining: untilRound - at };
  }
  match.peace.active = false;
  match.peace.brokenBy = side;
  match.peace.brokenRound = at;
  return {
    ok: true,
    peace: peaceOf(match),
    events: [{ type: "peace_broken", side, round: at, note: peaceBrokenNote(side) }],
  };
}
