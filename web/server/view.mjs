// Per-seat view. Owner: A5 (sight node).
//
// Everything that leaves the server for a seat passes through `forSeat`. The filter is
// subtractive: a piece the seat may not see is *absent* from the payload, never sent with a
// hidden flag, and no count of hidden pieces travels with it. The same rule holds for the
// enemy's route: only its first `rules.enemyRouteSteps()` steps exist in the view.
//
// Radii are read from rules.mjs on every call. Nothing here hard-codes 8 or 3.
//
// Sight originates at the seat's own pieces, Chebyshev distance, X wrapping and Y not.
// A submarine is only visible when it moved this round or is in a fight (a boat that fired
// is not "still"). In era "9999" the other side is withheld entirely until its capital has
// been seen from one of that seat's pieces; that sighting is remembered on the match, so
// pulling the scout back does not un-discover the enemy.

import { CELL_W, SEATS } from "./board.mjs";
import { combatRules, enemyRouteSteps, payEvery, roundSeconds as roundLength, sightCells } from "./rules.mjs";
import { metersFor } from "./resources.mjs";
import { airBriefing, inactiveRounds } from "./air.mjs";
import { unscreenedTransports } from "./escort.mjs";
import { kitBriefing } from "./late.mjs";
import { ensureStrength } from "./combat.mjs";
import { holderOf as capitalHolder } from "./capitals.mjs";
// The payday itself, so the economy dialog shows the figure the tick will pay rather than a page-side
// copy of the rule.
import { payoutFor } from "./economy.mjs";

const SIDES = ["blue", "red"];
const CONCEALED_ERA = "9999";

function otherOf(side) {
  return side === "blue" ? "red" : "blue";
}

function isSeat(side) {
  return side === "blue" || side === "red";
}

// Chebyshev distance with the board's X wrap. Y does not wrap.
export function distance(a, b) {
  const rawX = Math.abs(Number(a.x) - Number(b.x));
  const dx = Math.min(rawX, CELL_W - rawX);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return Math.max(dx, dy);
}

export function withinSight(from, to) {
  return distance(from, to) <= sightCells();
}

// Deliberately not `path.length > 0` alone: a piece that spent its last step this round has
// an empty path but did move. Movement modules may stamp a round on the piece.
function movedThisRound(unit, match) {
  if (Array.isArray(unit.path) && unit.path.length > 0) return true;
  for (const key of ["movedRound", "lastStepRound", "steppedRound"]) {
    if (unit[key] !== undefined && unit[key] !== null && Number(unit[key]) === Number(match.round)) {
      return true;
    }
  }
  return false;
}

function cloneSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => ({ ...step }));
}

function ownRoutes(piece) {
  return cloneSteps(piece.path);
}

function enemyRoutes(piece) {
  return cloneSteps(piece.path).slice(0, enemyRouteSteps());
}

// The match carries one remembered fact beyond the contract's shape: which seats have
// located the other capital in the concealed era. It is a pair of booleans, never a piece.
function seenMemory(match) {
  if (!match.seen || typeof match.seen !== "object") match.seen = {};
  return match.seen;
}

function capitalVisible(match, viewer, enemy, ownPieces) {
  if (match.era !== CONCEALED_ERA) return true;
  const memory = seenMemory(match);
  if (memory[viewer]) return true;
  const capital = match.capitals && match.capitals[enemy];
  if (!capital) return false;
  const found = ownPieces.some((unit) => withinSight(unit, capital));
  if (found) {
    memory[viewer] = true;
    return true;
  }
  return false;
}

function seatPieces(match, side) {
  const own = [];
  const enemy = [];
  for (const unit of match.pieces || []) {
    if (unit.side === side) own.push(unit);
    else enemy.push(unit);
  }
  return { own, enemy };
}

function visibleEnemy(unit, ownPieces, match) {
  // Intel and a satellite pass reveal a piece for the round they were used, submarines included.
  if (Number(unit.revealedRound) >= Number(match.round) && Number(unit.revealedRound) >= 0) return true;
  if (unit.kind === "submarine" && !movedThisRound(unit, match) && !unit.fighting) return false;
  return ownPieces.some((own) => withinSight(own, unit));
}

function viewPiece(unit, steps, round) {
  const max = combatRules().maxStrength;
  const strength = ensureStrength(unit, max);
  return {
    id: unit.id,
    side: unit.side,
    domain: unit.domain,
    kind: unit.kind ?? null,
    x: unit.x,
    y: unit.y,
    path: steps,
    pace: unit.pace,
    facing: unit.facing ?? null,
    fighting: unit.fighting ?? null,
    shots: unit.shots ?? 0,
    // The strength bar (T-003): current and maximum, so the page draws the same fraction the
    // server fights with. Nothing is derived twice.
    strength,
    maxStrength: Number(unit.maxStrength) || max,
    // The five words the unit list uses, plus the pinned state (p.22). Derived, never stored twice.
    transport: unit.transport === true,
    entrenched: unit.entrenched === true,
    pinned: unit.pinned === true,
    // How many rounds until an aircraft can fly again. `state` says "inactive"; the page needs the
    // number, or a mission is an unexplained absence rather than a cost.
    inactive: inactiveRounds(unit, round),
    state: stateOf(unit, round),
  };
}

function stateOf(unit, round) {
  const until = Number(unit.inactiveUntil);
  if (Number.isFinite(until) && until > (Number(round) || 0)) return "inactive";
  if (Array.isArray(unit.path) && unit.path.length > 0) return "moving";
  if (unit.pinned === true) return "pinned";
  if (unit.repairing === true) return "repairing";
  if (unit.entrenched === true) return "digging";
  return "idle";
}

// Hold on - `seat` is a local name above; the exported view calls it `seat` on purpose.
function seatStatus(match, side) {
  const sides = match && match.sides;
  const entry = sides && typeof sides === "object" ? sides[side] : null;
  // null means the economy has not touched this side yet; Number(null) would report 0 and the
  // page would print a false "fuel 0".
  const cash = entry && entry.cash !== null && entry.cash !== undefined ? Number(entry.cash) : NaN;
  const fuel = entry && entry.fuel !== null && entry.fuel !== undefined ? Number(entry.fuel) : NaN;
  const every = Number(payEvery());
  const round = Number(match && match.round) || 0;
  const payIn = Number.isFinite(every) && every > 0 ? every - (round % every) : null;
  return {
    cash: Number.isFinite(cash) ? cash : null,
    fuel: Number.isFinite(fuel) ? fuel : null,
    // Every resource kind this scenario carries, held and dry, plus the rate when the owner
    // set one. A null rate means nobody recovered it, and the page says so instead of
    // drawing a number. Fuel's own field above stays for older readers.
    reserves: metersFor(match, side),
    payIn,
    payEvery: Number.isFinite(every) && every > 0 ? every : null,
    // What the next payday is worth, counted by the economy module's own rule: one per owned city
    // plus one per owned well. The page prints this instead of counting the board itself.
    income: payoutFor(match, side),
    // The aircraft this seat can fly, with each mission's cost in rounds. It rides the seat so the
    // page shows the same choices the server will accept.
    air: airBriefing(match, side),
    // The late kit with its consequences in words: the nuke's guard radius, the launch limit left,
    // and every stand-in named as one. A tool a player cannot understand is a rule they cannot use.
    kit: kitBriefing(match, side),
  };
}

export function forSeat(match, side) {
  if (!match || !Array.isArray(match.pieces)) {
    return { pieces: [], routes: {}, sites: [], capitals: {}, notes: [] };
  }

  // A non-seat caller is a spectator or the harness: no filter to apply, so send the match
  // as it stands. Seats never arrive here without a side.
  if (!isSeat(side)) {
    const routes = {};
    const pieces = match.pieces.map((unit) => {
      const steps = cloneSteps(unit.path);
      if (steps.length) routes[unit.id] = cloneSteps(steps);
      return viewPiece(unit, steps, match.round);
    });
    return {
      pieces,
      routes,
      sites: (match.sites || []).map((site) => ({ ...site })),
      capitals: {
        blue: match.capitals && match.capitals.blue ? { ...match.capitals.blue } : null,
        red: match.capitals && match.capitals.red ? { ...match.capitals.red } : null,
      },
      seat: null,
      notes: [],
      unscreened: [],
      roundSeconds: roundLength(),
    };
  }

  const enemySide = otherOf(side);
  const { own, enemy } = seatPieces(match, side);
  const hidden = !capitalVisible(match, side, enemySide, own);

  const pieces = [];
  const routes = {};

  for (const unit of own) {
    const steps = ownRoutes(unit);
    pieces.push(viewPiece(unit, steps, match.round));
    if (steps.length) routes[unit.id] = cloneSteps(steps);
  }

  if (!hidden) {
    for (const unit of enemy) {
      if (!visibleEnemy(unit, own, match)) continue;
      const steps = enemyRoutes(unit);
      pieces.push(viewPiece(unit, steps, match.round));
      if (steps.length) routes[unit.id] = cloneSteps(steps);
    }
  }

  const sites = (match.sites || [])
    .filter((site) => !(hidden && site.owner === enemySide))
    .map((site) => ({ ...site }));

  const capitals = {};
  for (const name of SIDES) {
    if (name === enemySide && hidden) continue;
    const point = match.capitals && match.capitals[name];
    if (point) capitals[name] = { x: point.x, y: point.y };
  }

  // What the seat can spend and when it next gets paid. Without this the page cannot draw a
  // countdown and the clock is dead time: the player has no way to know a payment is coming.
  const seat = seatStatus(match, side);

  // A transport crossing with no warship able to see it is a loss waiting to happen. The seat is
  // told which of its own transports are in that state, by id, so the page can point at them.
  const unscreened = unscreenedTransports(match, side);

  const notes = [];
  if (hidden) {
    const seatName = (SEATS[enemySide] && SEATS[enemySide].name) || "The other side";
    notes.push(seatName + " has not been found.");
  }

  // The alarm travels with the seat's own view: the page can shout about a capital under threat
  // without the server having to keep a second channel for it.
  const alarm = (match.alarm && match.alarm[side]) || null;

  // The result is part of the view. Without it a served page saw the clock stop and never learned
  // that the match was over, or who won — a harness played on for ten minutes past the end.
  const over = Boolean(match.over);
  const winner = match.winner || null;
  // Who won, why, and the era's capital list with the holder the site records actually carry. The
  // page draws this and never rebuilds the list from what it can see: a seat-side copy would be a
  // second answer to "who holds Berlin", and that is exactly the kind of second answer that ends a
  // match the board does not agree with.
  const result = over ? resultOf(match) : null;
  // The era's capital list, always - with the holder each site record carries. The map already
  // labels the capitals, so this leaks nothing the board does not: what it removes is the page's
  // only reason to guess a holder from a label colour.
  const capitalList = capitalListOf(match);

  // The round the server is actually running, so the page can draw the same clock. A page that
  // keeps its own copy of the round length is a second source of truth for a tunable.
  return {
    pieces, routes, sites, capitals, capitalList, seat, notes, alarm, over, winner, result, unscreened,
    roundSeconds: roundLength(),
  };
}

function sideWord(side) {
  return side === "blue" ? "Blue" : side === "red" ? "Red" : "Nobody";
}

// The era's capitals with the holder the server's own site records carry. Read through the capital
// set's ids, not through the map's kind: two of 1986's four capitals sit on sites the asset list
// calls a city, and a lookup keyed on kind would report them unheld.
export function capitalListOf(match) {
  const list = match && match.capitalSet && Array.isArray(match.capitalSet.list) ? match.capitalSet.list : [];
  return list.map((capital) => ({
    siteId: Number(capital.siteId),
    name: String(capital.name || ""),
    owner: capitalHolder(match, capital),
  }));
}

// The result as a seat reads it. `reason` is "capitals" only when the tick recorded the capture that
// completed the set; a resignation (and any older saved match that ended before this field existed)
// has a winner but no capital to name, and says so instead of inventing one.
export function resultOf(match) {
  if (!match || !match.over) return null;
  const reason = match.winReason && match.winReason.kind === "capitals" ? match.winReason : null;
  return {
    winner: match.winner || null,
    reason: reason ? "capitals" : (match.winner ? "resignation" : "over"),
    lastCapital: reason
      ? { siteId: reason.siteId ?? null, name: String(reason.name || ""), from: reason.from || null, round: reason.round ?? null }
      : null,
    capitals: capitalListOf(match),
    round: Number.isInteger(match.round) ? match.round : null,
  };
}

// The one sentence that ended the match, written once on the server so the end screen and the log
// cannot disagree about why it ended. Resignation keeps its own note, which lobby writes.
export function resultNote(match) {
  const result = resultOf(match);
  if (!result) return "The match is over.";
  const who = sideWord(result.winner);
  if (result.reason === "capitals" && result.lastCapital && result.lastCapital.name) {
    const n = result.capitals.length;
    return who + " wins: " + result.lastCapital.name + " fell at round " + result.lastCapital.round +
      ", and " + who.toLowerCase() + " holds every capital (" + n + " of " + n + ").";
  }
  return result.winner ? who + " wins." : "The match is over.";
}
