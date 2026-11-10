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
import { enemyRouteSteps, payEvery, roundSeconds as roundLength, sightCells } from "./rules.mjs";
import { metersFor } from "./resources.mjs";
import { airBriefing, inactiveRounds } from "./air.mjs";
import { unscreenedTransports } from "./escort.mjs";
import { kitBriefing } from "./late.mjs";
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

// The match carries facts beyond the contract's shape: which seats have located the other side,
// which enemy capitals each seat has actually seen, and which sites each seat has seen well enough
// to read a name off. They are booleans and id maps, never pieces.
function seenMemory(match) {
  if (!match.seen || typeof match.seen !== "object") match.seen = {};
  return match.seen;
}

function seenCapitals(match) {
  if (!match.seenCapitals || typeof match.seenCapitals !== "object") match.seenCapitals = {};
  return match.seenCapitals;
}

function seenSites(match) {
  if (!match.seenSites || typeof match.seenSites !== "object") match.seenSites = {};
  return match.seenSites;
}

// The word the original's hover panel prints in place of a name in the concealed era:
// CAPITAL / CITY, with the other types by the same rule.
const TYPE_WORD = {
  capital: "CAPITAL",
  city: "CITY",
  base: "BASE",
  oilfield: "OILFIELD",
  well: "OILFIELD",
  dock: "DOCK",
  docks: "DOCK",
  facility: "FACILITY",
};

function isPlaceholder(name) {
  // The extract's own list has placeholder names for a few sites (site_78 .. site_83). A
  // placeholder is not a place name, so the concealed era conceals it like any other.
  return !name || /^site_\d+$/i.test(String(name).trim());
}

function concealName(site) {
  // A capital is a capital wherever the era names it, even when the asset list calls the cell a
  // city (1918 Paris). The original's panel printed CAPITAL for those.
  if (site && (site.capitalSide === "blue" || site.capitalSide === "red" || site.kind === "capital")) return "CAPITAL";
  const kind = String(site && site.kind);
  return Object.hasOwn(TYPE_WORD, kind) ? TYPE_WORD[kind] : "SITE";
}

function capitalKey(cell) {
  return Number(cell.x) + ":" + Number(cell.y);
}

// In ???? the enemy capital is not in the seat's view until one of the seat's own pieces has seen
// the cell; the sighting is remembered, so pulling the scout back does not un-discover it. Any
// capital seen also reveals that there IS an enemy (the note goes away), but only the capitals
// actually seen travel: one sighting does not hand over the rest of the map.
function capitalSeen(match, viewer, cell, ownPieces) {
  if (match.era !== CONCEALED_ERA) return true;
  const seen = seenCapitals(match);
  if (!seen[viewer] || typeof seen[viewer] !== "object") seen[viewer] = {};
  const key = capitalKey(cell);
  if (seen[viewer][key]) return true;
  if (ownPieces.some((unit) => withinSight(unit, cell))) {
    seen[viewer][key] = true;
    seenMemory(match)[viewer] = true;
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
    // The five words the unit list uses. Derived, never stored twice.
    transport: unit.transport === true,
    entrenched: unit.entrenched === true,
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
        blue: Array.isArray(match.capitals && match.capitals.blue) ? match.capitals.blue.map((cell) => ({ ...cell }))
          : match.capitals && match.capitals.blue ? [{ ...match.capitals.blue }] : [],
        red: Array.isArray(match.capitals && match.capitals.red) ? match.capitals.red.map((cell) => ({ ...cell }))
          : match.capitals && match.capitals.red ? [{ ...match.capitals.red }] : [],
      },
      seat: null,
      notes: [],
      unscreened: [],
      roundSeconds: roundLength(),
    };
  }

  const enemySide = otherOf(side);
  const { own, enemy } = seatPieces(match, side);

  // The enemy's capitals, one by one. In ???? a capital is absent until this seat's own pieces
  // have seen that cell; in every other era all of them travel.
  const capitals = { blue: [], red: [] };
  for (const name of SIDES) {
    const rows = Array.isArray(match.capitals && match.capitals[name])
      ? match.capitals[name]
      : match.capitals && match.capitals[name] ? [match.capitals[name]] : [];
    for (const point of rows) {
      if (!point) continue;
      if (name === enemySide && !capitalSeen(match, side, point, own)) continue;
      capitals[name].push({
        x: point.x,
        y: point.y,
        name: name === enemySide && match.era === CONCEALED_ERA ? "CAPITAL" : (point.name ?? null),
        siteId: point.siteId ?? null,
      });
    }
  }
  // The other side stays off the map entirely until one of its capitals has been seen: pieces and
  // enemy-owned sites included. That is the archive's concealed start.
  const hidden = match.era === CONCEALED_ERA && capitals[enemySide].length === 0;

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

  // Site names are hidden in the concealed era until one of this seat's pieces has seen the cell;
  // the hover/readout prints the type word (CAPITAL / CITY) exactly the way the original's panel
  // did. The sighting is remembered per site, so a scout moving on does not re-conceal the name.
  const seen = seenSites(match);
  if (match.era === CONCEALED_ERA && (!seen[side] || typeof seen[side] !== "object")) seen[side] = {};
  const sites = (match.sites || [])
    .filter((site) => !(hidden && site.owner === enemySide))
    .map((site) => {
      const copy = { ...site };
      if (match.era !== CONCEALED_ERA) return copy;
      const key = String(site.id);
      if (!seen[side][key] && own.some((unit) => withinSight(unit, site))) seen[side][key] = true;
      if (!seen[side][key] || isPlaceholder(site.name)) copy.name = concealName(site);
      return copy;
    });

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

  // The round the server is actually running, so the page can draw the same clock. A page that
  // keeps its own copy of the round length is a second source of truth for a tunable.
  return {
    pieces, routes, sites, capitals, seat, notes, alarm, over, winner, unscreened,
    roundSeconds: roundLength(),
  };
}
