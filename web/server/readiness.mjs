// Readiness: production pools the timers of the build site and the friendly sites around it.
//
// DECODED from FUN_2dfc_1874 @ 2dfc:1874 (PB-154). The manual's description (p.27) is the
// shape; the archive is the arithmetic:
//   caps  = 1 + the side's owned capitals (type 1/2) anywhere among records 0-63
//   list  = the build site + every site of the side among records 0-63 with d^2 < 401
//           (Euclidean, X wrapped at 320). The build site is listed twice, as in the code.
//   total = sum of the listed sites' current remaining timers
//           + floor(floor(price_b * 80 / 3) / caps)
//   each listed site's new remaining timer = floor(total / count),
//           +1 when total % count > count / 2
// Timers drop by 1 per round, so a site is ready when its readyRound reaches the round.
//
// The old readinessRounds/markUnready stand-ins (roundsPerBillion, cityWeight, capitalWeight,
// Chebyshev radiusCells, minRounds) are gone: their invented numbers are replaced by the decoded
// constants in config/game.json `readiness`, each tagged DECODED with the address.
//
// State is per site: `site.readyRound` is the first round the site may produce again. A site
// with no readyRound, or one whose round has passed, is ready. The boolean `unready` from the
// pre-T-011 build is migrated on load (rooms.unpackMatch), never written by this module.

import { millionsPerBillion, priceOf, readinessRules } from "./rules.mjs";

// PB-153: a type-5 `facility` is an oil field, so it is not a producer and is never listed as a
// readiness neighbour. Cities, capitals and bases produce.
const PRODUCE_KINDS = new Set(["city", "capital", "base"]);
// The 64 city-kind records of the era file. Records 64-83 are the type-5 oil fields (PB-153) and
// carry no timer in the original, so the list stops at record 63. Docks and the world.json wells
// have synthetic ids and are excluded by the same test, not by a second kind check.
const RECORD_LIMIT = 64;
const CAPITAL_TYPES = new Set([1, 2]);
// The concealed era, whose per-side build counter exempts capitals for the first five builds.
const CONCEALED_ERAS = new Set(["9999", "????"]);

const BOARD_W = 320;

function roundOf(match) {
  const round = Number(match && match.round);
  return Number.isFinite(round) && round > 0 ? Math.floor(round) : 0;
}

// What a site's own field says. `readyRound` is the first round the site may produce again;
// 0 (or a missing/NaN field) means ready.
export function readyRoundOf(site) {
  if (!site) return 0;
  const round = Number(site.readyRound);
  if (Number.isFinite(round) && round > 0) return Math.floor(round);
  return 0;
}

export function isSiteReady(site, round) {
  const at = readyRoundOf(site);
  return !(at > 0 && at > roundOf({ round }));
}

// A record site: one of the era file's 0-63 producing rows (city, capital, base). The kind test
// keeps a sketched well or a dock that happens to carry a small numeric id out of the list;
// `Number.isInteger` excludes the synthetic `dock:<x>:<y>` ids.
function isRecordSite(site) {
  const id = Number(site && site.id);
  return Number.isInteger(id) && id >= 0 && id < RECORD_LIMIT && PRODUCE_KINDS.has(String(site.kind));
}

function distanceSq(a, b) {
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, BOARD_W - dx);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return wrap * wrap + dy * dy;
}

function seatOf(match, side) {
  const seat = match && match.sides ? match.sides[side] : null;
  return seat && typeof seat === "object" ? seat : null;
}

// caps = 1 + the side's owned capitals (type 1/2) among records 0-63. The +1 is the original's
// divisor base, so a side with no capital still divides by one.
export function capitalDivisor(match, side) {
  const { capitalBase } = readinessRules();
  let capitals = 0;
  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site || site.owner !== side || !isRecordSite(site)) continue;
    if (!CAPITAL_TYPES.has(Number(site.type))) continue;
    capitals += 1;
  }
  return Math.max(1, capitalBase + capitals);
}

// The unique sites a production pools: the build site plus every site of the side among records
// 0-63 inside d^2 < radiusSq. The build site appears once here; markUnready appends it a second
// time because the original counts it twice.
export function readinessNeighbours(match, side, site) {
  const { radiusSq } = readinessRules();
  const out = [];
  for (const other of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!other || other.owner !== side) continue;
    if (!isRecordSite(other)) continue;
    if (other !== site && distanceSq(other, site) >= radiusSq) continue;
    out.push(other);
  }
  if (site && site.owner === side && !out.includes(site)) out.push(site);
  return out;
}

// The concealed era's first five builds leave capitals untired (per-side counter 0x1580). The
// original's skip sits on the write, so a capital stays in the count and in the pooled sum; it
// just keeps its own timer.
function capitalsExempt(match, side) {
  if (!CONCEALED_ERAS.has(String(match && match.era))) return false;
  const seat = seatOf(match, side);
  return seat !== null && Number(seat.bought || 0) < 5;
}

// Mark the producing site and its neighbours unready from the decoded formula. Returns the round
// they come back on, the pooled timer and the ids that were written, so the caller can report
// exactly what a purchase did. A hull is built at a dock; the site that produces it is the nearest
// friendly city, base or capital, so the dock itself is never the site that goes unready.
export function markUnready(match, side, site, kind) {
  const round = roundOf(match);
  const home = PRODUCE_KINDS.has(String(site && site.kind)) ? site : nearestProducer(match, side, site);
  if (!home) return { round: 0, rounds: 0, sites: [] };

  const { priceScaleNumerator, priceScaleDenominator } = readinessRules();
  const caps = capitalDivisor(match, side);
  const unique = readinessNeighbours(match, side, home);
  // The build site is counted twice: append it once more. `count` is the list length, so the
  // divisor and the modulo both see the duplicate, exactly as the original's loop does.
  const listed = unique.includes(home) ? unique.concat([home]) : [home].concat(unique);

  const price = priceOf(kind);
  const perBillion = Number(millionsPerBillion());
  const billions = Number.isFinite(price) && perBillion > 0 ? price / perBillion : 0;
  const scaled = Math.floor((billions * priceScaleNumerator) / priceScaleDenominator);
  const base = Math.floor(scaled / caps);

  let total = base;
  for (const entry of listed) total += Math.max(0, readyRoundOf(entry) - round);

  const count = listed.length;
  let timer = Math.floor(total / count);
  if (total % count > count / 2) timer += 1;

  const readyAt = round + timer;
  const exempt = capitalsExempt(match, side);
  const written = [];
  for (const entry of new Set(listed)) {
    if (exempt && CAPITAL_TYPES.has(Number(entry.type))) continue;
    entry.readyRound = readyAt;
    written.push(entry);
  }
  return { round: readyAt, rounds: timer, sites: written.map((other) => other.id) };
}

function nearestProducer(match, side, site) {
  if (!site) return null;
  const dxOf = (other) => {
    const dx = Math.abs(Number(other.x) - Number(site.x));
    return Math.min(dx, BOARD_W - dx);
  };
  let best = null;
  let bestGap = Infinity;
  for (const other of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!other || other.owner !== side) continue;
    if (!PRODUCE_KINDS.has(String(other.kind))) continue;
    const gap = Math.max(dxOf(other), Math.abs(Number(other.y) - Number(site.y)));
    if (gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  }
  return best;
}

// The sentence a refusal carries. AC4 asks for "ready at round N" verbatim; PB-044 (T-021 AC8)
// asks for the site's name in front of it, so "Kharkov isn't ready: it will be ready at round 18"
// rather than a guess about which city the player clicked.
export function unreadyRefusal(site, label = "") {
  const readyAt = readyRoundOf(site);
  const name = String(label || (site && site.name) || "").trim();
  const who = name ? name + " isn't ready" : "That city isn't ready";
  return who + ": it will be ready at round " + readyAt + ".";
}
