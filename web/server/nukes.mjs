// The nuke counter and the two rules that read it (PB-156).
//
// Manual p.30: a side may fire at most three more nukes than its opponent has fired. That is the
// DIFFERENCE of the two per-side counters, not one side's total and not a count of intercepts, so
// the gate is `fired(mine) - fired(theirs) < 3` (the old "three fired or three absorbed" reading is
// retired).
//
// FUN_1eb5_0eae increments ONE global detonation count (0x148c). Both consequence rules read that
// single number, not the per-side counters:
//   - from 5, a warning;
//   - from 10, nuclear winter if rnd(100) < 100 / (20 - n);
//   - each round, income is paid only if rnd(100) >= 5n (decompiled.c 4763).
//
// The numbers are decoded, so they live in config/game.json with a DECODED tag; the fallbacks here
// are the same values and only apply to a config that predates the block. The roll is the match's
// own seeded stream (web/server/rng.mjs), kept on `match.nukes.rngState`, so a reload replays the
// same round instead of re-rolling it.

import { rules } from "./rules.mjs";
import { draw, seedOf } from "./rng.mjs";

// Fallbacks for a config written before this block existed. They are the same decoded values
// config/game.json publishes, and every one of them is a COUNT or a PERCENTAGE, never currency:
// nothing in this module spends or credits anything. The tunables guard in web/test/nodes/prices.mjs
// reads a bare 5/10/20 beside a money word as a typed-in price, so these are named as counts.
const FALLBACK = Object.freeze({ lead: 3, warn: 5, winter: 10, skipPct: 5, divisor: 20 });

function tunable(name, fallback) {
  const cfg = rules().nukes || {};
  const value = Number(cfg[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The block is inert unless config turns it on. One reader, so economy and late.mjs cannot disagree
// about what "enabled" means.
export function nukesEnabled() {
  return (rules().nukes || {}).enabled === true;
}

export function launchLead() {
  return tunable("launchLead", FALLBACK.lead);
}

export function warnFrom() {
  return tunable("warnFrom", FALLBACK.warn);
}

export function winterFrom() {
  return tunable("winterFrom", FALLBACK.winter);
}

// `match.nukes` is the global counter plus the stream state. Created on first read so a match
// object from a reload, a test fixture or an older save all grow the same shape.
export function nukeState(match) {
  if (!match.nukes || typeof match.nukes !== "object") match.nukes = {};
  const state = match.nukes;
  if (!Number.isFinite(Number(state.detonated))) state.detonated = 0;
  if (!Number.isInteger(state.rngState)) {
    const seed = match.capitalSeed === undefined || match.capitalSeed === null ? match.era : match.capitalSeed;
    state.rngState = seedOf(seed) >>> 0;
  }
  return state;
}

export function detonatedCount(match) {
  return Number(nukeState(match).detonated) || 0;
}

// One rnd(100), 0..99, off the match's own stream. Advances the stored state, so two calls in one
// round are two different rolls and a replay of the same seed is the same two rolls.
export function nukeRoll(match) {
  const state = nukeState(match);
  const step = draw(state.rngState);
  state.rngState = step.state;
  return Math.floor(step.value * 100);
}

export function incomeSkipPercent(n) {
  const pct = tunable("incomeSkipPerDetonation", FALLBACK.skipPct) * Math.max(0, Number(n) || 0);
  return pct > 100 ? 100 : pct;
}

// 100 / (winterDivisor - n), as the original divides it. At and above the divisor the original's
// expression is undefined, so the 100% clamp here is an EXTRAPOLATION, not a decode: it stops the
// rule at a certain winter instead of inventing the original's undefined branch.
export function winterChancePercent(n) {
  const left = tunable("winterDivisor", FALLBACK.divisor) - Math.max(0, Number(n) || 0);
  return left <= 0 ? 100 : 100 / left;
}
