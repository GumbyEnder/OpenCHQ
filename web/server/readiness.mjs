// Readiness: production tires the city it happened in and the friendly cities around it.
//
// Manual p.27, "Readiness": "each production makes that city and several surrounding cities
// unready. The unready time is proportional to the unit's cost and to the number of friendly
// cities (especially capitals) nearby. Placing in an unready city shows a mode-bar message
// giving the round it will be ready."
//
// The archive's radius and duration were never recovered: FUN_107e_4140 is the arrival/berth
// search, not the readiness rule (docs/re/PLACEMENT.md), and no capture times a city coming
// back. So every constant here is an UNMEASURED stand-in carried in config/game.json under
// `readiness`, and the sentence a player reads names the round, which is exact regardless of
// the constant.
//
// State is per site: `site.readyRound` is the first round the site may produce again. A site
// with no readyRound, or one whose round has passed, is ready. The boolean `unready` from the
// pre-T-011 build is migrated on load (rooms.unpackMatch), never written by this module.

import { millionsPerBillion, priceOf, readinessRules } from "./rules.mjs";

const CITY_KINDS = new Set(["city"]);
const CAPITAL_KINDS = new Set(["capital"]);
const PRODUCE_KINDS = new Set(["city", "capital", "base", "facility"]);

const BOARD_W = 320;

function roundOf(match) {
  const round = Number(match && match.round);
  return Number.isFinite(round) && round > 0 ? Math.floor(round) : 0;
}

// What a site's own field says. `Infinity` is a conveniences for a row that asked to be unready
// with no round; nothing in this tree writes one, but a legacy row may carry the boolean only.
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

// Chebyshev distance on the wrapping board, the same measure placement used before T-011.
function distance(a, b) {
  const dx = Math.abs(Number(a.x) - Number(b.x));
  return Math.max(Math.min(dx, BOARD_W - dx), Math.abs(Number(a.y) - Number(b.y)));
}

// The friendly cities a production tires: the producing site plus every friendly city, capital
// or base inside `radiusCells`. Capitals are counted separately because the manual says they
// weigh more.
export function readinessNeighbours(match, side, site) {
  const { radius } = readinessRules();
  const out = [];
  for (const other of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!other || other.owner !== side) continue;
    if (!PRODUCE_KINDS.has(String(other.kind))) continue;
    if (other !== site && distance(other, site) > radius) continue;
    out.push(other);
  }
  if (site && site.owner === side && !out.includes(site)) out.push(site);
  return out;
}

// How many rounds one production costs, from the cost of the unit and the friendly cities in
// the radius. All weights are labelled stand-ins in config; the shape is the manual's.
export function readinessRounds(match, side, site, kind) {
  const { roundsPerBillion, cityWeight, capitalWeight, minRounds } = readinessRules();
  const price = priceOf(kind);
  if (!Number.isFinite(price)) return minRounds;
  const perBillion = Number(millionsPerBillion());
  const billions = perBillion > 0 ? price / perBillion : price;
  const neighbours = readinessNeighbours(match, side, site);
  let cities = 0;
  let capitals = 0;
  for (const other of neighbours) {
    if (CAPITAL_KINDS.has(String(other.kind))) capitals += 1;
    else if (CITY_KINDS.has(String(other.kind))) cities += 1;
  }
  const weight = 1 + cityWeight * cities + capitalWeight * capitals;
  const rounds = Math.ceil(roundsPerBillion * billions * weight);
  return Math.max(minRounds, rounds);
}

// Mark the producing city and its neighbours unready. Returns the round they come back on and
// the ids that were written, so the caller can report exactly what a purchase did. A hull is
// built at a dock; the city that produces it is the nearest friendly city, base or capital, so
// the dock itself is never the site that goes unready.
export function markUnready(match, side, site, kind) {
  const round = roundOf(match);
  const home = PRODUCE_KINDS.has(String(site && site.kind)) ? site : nearestProducer(match, side, site);
  if (!home) return { round: 0, rounds: 0, sites: [] };
  const rounds = readinessRounds(match, side, home, kind);
  const readyAt = round + rounds;
  const sites = readinessNeighbours(match, side, home);
  for (const other of sites) {
    const already = readyRoundOf(other);
    if (already < readyAt) other.readyRound = readyAt;
  }
  return { round: readyAt, rounds, sites: sites.map((other) => other.id) };
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

// The sentence a refusal carries. AC4 asks for "ready at round N" verbatim.
export function unreadyRefusal(site) {
  const readyAt = readyRoundOf(site);
  return "That city is not ready: it will be ready at round " + readyAt + ".";
}
