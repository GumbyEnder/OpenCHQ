// The nuke's AFTER-EFFECTS (PB-233): what a strike does after the ground stops burning.
// Owner: game, 2026-11-24.
//
// Manual p.30, quoted:
//   * "World opinion is heavily against the use of nuclear weapons. Therefore, whenever a nuke is
//     used, some number of cities in [the attacked country] switch to neutral if part of the
//     offending alliance, or shifting to the enemy if already neutral. The number of cities that
//     switch is partly random, and partly determined by civilian casualties (represented by
//     destruction of cities) and friendly casualties caused by the nuke. Also, the first side to
//     use nukes suffers an additional penalty in this regard."
//   * "After a certain number of nukes have been dropped, the overall deleterious effect on the
//     Earth's biosphere begins to be felt. All city production is reduced by 25 per cent or more
//     when this occurs."
//   * nuclear winter is PB-156's and is NOT rebuilt here (nukes.mjs + late.mjs).
//
// WHAT IS DECODED AND WHAT IS A STAND-IN
//   * The attitude arithmetic is FUN_1eb5_0eae, decompiled.c 12133-12166: a signed byte per nation
//     at 0x13e4 is moved by `(0x13be[nation] & 0xf) * sign`, halved when that magnitude is no bigger
//     than the referenced attitude, nudged by one when the halved value is 0 and the gate byte is
//     odd, then clamped to +-0x7f. That SHAPE is ported exactly.
//   * The magnitude's source - a per-nation nibble 0x13be[nation] & 0xf (1..15) - has no table in
//     this build, so `nukes.attitudeShift` is a STAND-IN drawn from that range, not a decode.
//   * Which attitude entry 12135's reference (`local_8 & 0x3f`) names is NOT resolved by the export.
//     This build compares the magnitude against the COUNTRY'S OWN current attitude, which is the
//     monotone reading (a country already firmly against the use takes a smaller further hit).
//     PORT DECISION, named here rather than hidden.
//   * The city count is the manual's sentence and nothing else: the archive's owner flip at
//     12167-12185 walks 100 PIECE slots, not cities, so no count there maps onto "some number of
//     cities". `switchChance`, `switchPerCity`, `switchPerLoss` and `firstStrikePenalty` are
//     STAND-INS with the manual's sentence quoted in config.
//   * The production cut is NOT arithmetic in this build. There is no `*0.75` anywhere in
//     FUN_1eb5_0eae, and its only income arithmetic is the 5n payday gate (decompiled.c 4772,
//     DECODED, already shipped) - so the 5n gate IS the manual's "25 per cent or more" and the
//     manual's growth past it. Frodo's ruling of 2026-11-24 (room 8983 §4) strikes the flat cut
//     and its `productionCutPercent` / `productionCutFrom` keys rather than deferring them. What
//     AC (b) ships is LEGIBILITY: the gate's skip is logged with the cities whose payday it took,
//     in economy.mjs, with no new multiply anywhere.

import { rules } from "./rules.mjs";
import { draw, seedOf } from "./rng.mjs";

// Fallbacks for a config that predates this block. They are the same values config/game.json
// publishes, and every one is a COUNT or a PER CENT, never currency.
const FALLBACK = Object.freeze({
  attitudeShift: 4,
  switchChance: 50,
  switchPerCity: 1,
  switchPerLoss: 1,
  firstStrikePenalty: 2,
});

function tunable(name, fallback, { min = 0 } = {}) {
  const cfg = rules().nukes || {};
  const value = Number(cfg[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

// The per-strike magnitude the archive reads from a per-nation nibble (`0x13be[nation] & 0xf`,
// 1..15). This build has no such table, so config carries the number and marks it STAND-IN.
export function attitudeShift() {
  return Math.floor(tunable("attitudeShift", FALLBACK.attitudeShift, { min: 1 }));
}

// The manual's "partly random": one rnd(100) against this per cent. STAND-IN.
export function switchChance() {
  const value = tunable("switchChance", FALLBACK.switchChance);
  return value > 100 ? 100 : value;
}

// Cities that switch per civilian casualty (a city the strike levelled) and per friendly unit the
// firer lost. STAND-IN; the manual names both terms and neither a rate.
export function switchPerCity() {
  return Math.floor(tunable("switchPerCity", FALLBACK.switchPerCity));
}

export function switchPerLoss() {
  return Math.floor(tunable("switchPerLoss", FALLBACK.switchPerLoss));
}

// "the first side to use nukes suffers an additional penalty" - cities, on top of the count above.
export function firstStrikePenalty() {
  return Math.floor(tunable("firstStrikePenalty", FALLBACK.firstStrikePenalty));
}

// --- the attitude ledger -------------------------------------------------------------------

// One signed byte per country, on the match, so a reload keeps world opinion. Created lazily: a
// country no strike has touched has no entry at all, which is what makes "the country outside the
// effect is byte-identical" measurable rather than asserted.
export function attitudeLedger(match) {
  if (!match) return {};
  if (!match.attitude || typeof match.attitude !== "object" || Array.isArray(match.attitude)) {
    match.attitude = {};
  }
  return match.attitude;
}

// A read. Never creates an entry: the seat frame and the arms both read this.
export function attitudeOf(match, country) {
  if (!match || country === null || country === undefined) return 0;
  const ledger = match.attitude;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return 0;
  const value = Number(ledger[String(country)]);
  return Number.isFinite(value) ? value : 0;
}

const ATTITUDE_LIMIT = 0x7f;

// The archive's move, one country at a time:
//   magnitude = base, HALVED when base <= |before|; a halved-to-zero hit on an odd attitude still
//   moves by 1 (12146-12164); the result is clamped to +-0x7f.
// The sign is uniform - 12137 reads ONE global (`*0xe978`) - and it points AGAINST the firer, which
// is the manual's "world opinion is heavily against the use of nuclear weapons".
export function shiftAttitude(match, countries, { base = attitudeShift() } = {}) {
  const ledger = attitudeLedger(match);
  const moved = [];
  const unique = [...new Set(countries.filter((country) => country !== null && country !== undefined))]
    .map(Number)
    .sort((a, b) => a - b);
  for (const country of unique) {
    const before = attitudeOf(match, country);
    let magnitude = base;
    if (magnitude <= Math.abs(before)) {
      magnitude = Math.floor(magnitude / 2);
      if (magnitude === 0 && (Math.abs(before) & 1) === 1) magnitude = 1;
    }
    let after = before - magnitude;
    if (after > ATTITUDE_LIMIT) after = ATTITUDE_LIMIT;
    if (after < -ATTITUDE_LIMIT) after = -ATTITUDE_LIMIT;
    ledger[String(country)] = after;
    moved.push({ country, before, after, shift: after - before });
  }
  return moved;
}

// --- the city switch -----------------------------------------------------------------------

// Its OWN stream, deliberately. PB-156 pinned the match's draw order (a launch takes the winter
// draw first, then the paydays take the next two), and that order is a decode this ticket must not
// move. The switch is "partly random" per the manual, so it needs a roll - it gets one off a second
// state seeded from the same match seed, and the income/winter stream is untouched.
function switchState(match) {
  if (!match.nukes || typeof match.nukes !== "object") match.nukes = {};
  const state = match.nukes;
  if (!Number.isInteger(state.aftermathState)) {
    const seed = match.capitalSeed === undefined || match.capitalSeed === null ? match.era : match.capitalSeed;
    state.aftermathState = seedOf(seed) >>> 0;
  }
  return state;
}

export function switchRoll(match) {
  const state = switchState(match);
  const step = draw(state.aftermathState);
  state.aftermathState = step.state;
  return Math.floor(step.value * 100);
}

// The first side to fire: it has fired once and the other side has not fired at all. Read from the
// same counters the lead rule uses, so "first" cannot mean two different things in one match.
function isFirstFirer(match, firer) {
  const launched = (match && match.late && match.late.launched) || {};
  const mine = Number((launched[firer] || {}).fired) || 0;
  const theirs = Number((launched[firer === "blue" ? "red" : "blue"] || {}).fired) || 0;
  return mine === 1 && theirs === 0;
}

// Cities that a strike can move: the manual's sentence is about the ATTACKED country, so only
// cities standing in a country the blast touched qualify. A city the firer holds goes NEUTRAL; a
// neutral one goes to the ENEMY; a city the enemy already holds is not a switch and is skipped.
// The picks are rotated by the roll instead of always taking the lowest ids (PB-226's lesson: the
// lowest-id stand-in turned a city nobody chose).
export function switchCities(match, firer, countries, { struckCities = [], friendlyLosses = 0 } = {}) {
  const enemy = firer === "blue" ? "red" : "blue";
  // A null country is NOT country 0: `Number(null)` is 0, which would make the first real nation on
  // the board the blast's target every time a cell had no nation. Filtered before the map, and a
  // non-finite id is dropped for the same reason (the a2(vi) arm pins this).
  const touched = new Set((Array.isArray(countries) ? countries : [])
    .filter((country) => country !== null && country !== undefined && Number.isFinite(Number(country)))
    .map(Number));
  const roll = switchRoll(match);
  const chance = switchChance();
  const first = isFirstFirer(match, firer);
  const random = roll < chance ? 1 : 0;
  const wanted = random
    + switchPerCity() * Math.max(0, Number(struckCities) || 0)
    + switchPerLoss() * Math.max(0, Number(friendlyLosses) || 0)
    + (first ? firstStrikePenalty() : 0);
  if (wanted <= 0) return { roll, chance, first, wanted: 0, switched: [] };

  const sites = Array.isArray(match.sites) ? match.sites : [];
  const eligible = sites
    .filter((site) => site && site.kind === "city")
    .filter((site) => site.country_id !== undefined && site.country_id !== null)
    .filter((site) => touched.has(Number(site.country_id)))
    .filter((site) => site.owner === firer || site.owner === null || site.owner === undefined)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!eligible.length) return { roll, chance, first, wanted, switched: [] };

  const start = roll % eligible.length;
  const switched = [];
  for (let i = 0; i < eligible.length && switched.length < wanted; i += 1) {
    const site = eligible[(start + i) % eligible.length];
    const from = site.owner === firer ? firer : null;
    const to = from === firer ? null : enemy;
    site.owner = to;
    switched.push({
      id: site.id, name: site.name || null, x: site.x, y: site.y,
      country: Number(site.country_id), from, to,
    });
  }
  return { roll, chance, first, wanted, switched };
}

// --- provenance ----------------------------------------------------------------------------

// Every key this ticket added, each of which must carry its OWN source string. The block-level
// `nukes.source` cannot stand in for these: it predates them and names PB-156's decode, so a new
// number hidden behind it would read as decoded.
export const OWN_SOURCE_KEYS = Object.freeze([
  "attitudeShift",
  "switchChance",
  "switchPerCity",
  "switchPerLoss",
  "firstStrikePenalty",
]);

// A key's provenance: its own `...Source`, else the block's `source`. Null when neither exists.
export function sourceFor(key) {
  const cfg = rules().nukes || {};
  const own = cfg[key + "Source"];
  if (typeof own === "string" && own.trim()) return own;
  const block = cfg.source;
  return typeof block === "string" && block.trim() ? block : null;
}

// Every NUMERIC nukes key has to resolve to a sentence, or the config is publishing a number with
// no provenance. This is the guard PB-230's `killRadiusSource` check was a one-key version of.
export function missingSources() {
  const cfg = rules().nukes || {};
  return Object.keys(cfg).filter((key) => typeof cfg[key] === "number" && !sourceFor(key));
}

// The keys this ticket added that do not carry their own sentence.
export function ownSourceMissing() {
  const cfg = rules().nukes || {};
  return OWN_SOURCE_KEYS.filter((key) => {
    const own = cfg[key + "Source"];
    return !(typeof own === "string" && own.trim());
  });
}

// A source sentence has to name where the number came from: a Ghidra anchor, a manual page, or the
// word STAND-IN. A sentence that says nothing is worse than a missing key, because it looks sourced.
export function unlabelledSources() {
  const out = [];
  for (const key of Object.keys(rules().nukes || {})) {
    if (!String(key).endsWith("Source")) continue;
    const text = String((rules().nukes || {})[key] || "");
    if (!/Ghidra|decompiled\.c|FUN_[0-9a-f]+|STAND-IN|Manual p\.\d+/.test(text)) out.push(key);
  }
  return out;
}
