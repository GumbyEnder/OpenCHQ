// Aircraft are a resource, not a piece. Owner: integrator (node `air`, order 275).
//
// A mission costs the aircraft its flying time - it is INACTIVE for a number of rounds and
// cannot be ordered anywhere until that expires. The counts are the booklet's, from
// docs/POLISH_LOOP.md: an air mission is inactive 8 rounds, a scramble 4. Nothing here carries
// a damage number: a strike either catches cargo (which cannot defend itself) or does nothing
// that can be measured, and says so.

import { CELL_W } from "./board.mjs";
import { rules, combatRules } from "./rules.mjs";
import { applyDamage, ensureStrength } from "./combat.mjs";

// The mission costs in rounds. They are tunables, so they live in config/game.json's air block and
// nowhere else: this module used to keep its own copy (8 and 4), which is a second source of truth
// for the same number. The booklet's 8 and 4 are what the config file records; the file wins.
function missionCosts() {
  const air = (rules() && rules().air) || {};
  const strike = Number(air.strikeRounds);
  const patrol = Number(air.patrolRounds);
  // A transfer's round cost is UNVERIFIED (air.transferRoundsSource): the manual names the sites a
  // plane may transfer to, never a price in rounds. 0 is read from config like the other two, so
  // the assumption is tunable in one place instead of being written into this module.
  const transfer = Number(air.transferRounds);
  return {
    strike: Number.isFinite(strike) && strike > 0 ? Math.floor(strike) : 0,
    patrol: Number.isFinite(patrol) && patrol > 0 ? Math.floor(patrol) : 0,
    transfer: Number.isFinite(transfer) && transfer >= 0 ? Math.floor(transfer) : 0,
  };
}

function modeFor(name) {
  const costs = missionCosts();
  if (name === "strike") return costs.strike > 0 ? { rounds: costs.strike, type: "strike" } : null;
  if (name === "patrol") return costs.patrol > 0 ? { rounds: costs.patrol, type: "scramble" } : null;
  return null;
}

export const STRIKE_NOTE = "Air strike.";
export const REACH_NOTE = "Stand-in reach. The aircraft range was not recovered.";
export const PARADROP_NOTE = "Paradrop. The infantry pays its strength cost.";

export function isAircraft(piece) {
  return Boolean(piece) && piece.kind === "aircraft";
}

function airReach() {
  const value = Number((rules().air || {}).reach);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// The counts the badge shows: rounds left before this aircraft can fly again.
export function inactiveRounds(piece, round) {
  if (!piece) return 0;
  const until = Number(piece.inactiveUntil);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.floor(until - (Number(round) || 0)));
}

function chebyshev(a, b) {
  const dx = Math.abs(Number(a.x) - Number(b.x));
  const wrap = Math.min(dx, CELL_W - dx);
  return Math.max(wrap, Math.abs(Number(a.y) - Number(b.y)));
}

// A mission has to be flown from somewhere: a friendly city, dock or ship within reach.
function baseFor(match, side, from) {
  const reach = airReach();
  if (reach <= 0) return null;
  const candidate = (cell) => cell && chebyshev(from, cell) <= reach;
  const home = (match.sites || []).find(
    (site) => site && site.owner === side && (site.kind === "city" || site.kind === "dock" || site.kind === "docks") && candidate(site),
  );
  if (home) return home;
  return (match.pieces || []).find(
    (unit) => unit && unit.side === side && unit.domain === "sea" && unit.transport !== true && candidate(unit),
  ) || null;
}

// What this seat's aircraft can do right now, as choices rather than as prose: each plane, the
// rounds it still owes, and the two missions with what each one costs. The costs come from config,
// so the page cannot disagree with what the server charges.
export function airBriefing(match, side) {
  const costs = missionCosts();
  const reach = airReach();
  const planes = (match && Array.isArray(match.pieces) ? match.pieces : [])
    .filter((piece) => piece && piece.side === side && isAircraft(piece));
  return planes.map((plane) => {
    const left = inactiveRounds(plane, match.round);
    const base = baseFor(match, side, plane);
    return {
      id: plane.id,
      kind: plane.kind || null,
      x: Number(plane.x),
      y: Number(plane.y),
      roundsLeft: left,
      ready: left === 0,
      // A mission needs somewhere to fly from. Without a city, dock or ship in reach the choice
      // exists on the page but is refused by the server, and this says which.
      reach: reach > 0 ? reach : null,
      base: base ? (base.name || base.id) : null,
      canFly: Boolean(base),
      missions: [
        { mode: "patrol", label: "Scramble (CAP)", rounds: costs.patrol },
        { mode: "strike", label: "Strike", rounds: costs.strike },
        // A transfer rebases the plane instead of flying a mission (manual p.22: "Air units may
        // only be transferred to cities, bases, and aircraft carriers"). Its round cost comes from
        // config and is UNVERIFIED (air.transferRoundsSource): the manual never prints one.
        { mode: "transfer", label: "Transfer", rounds: costs.transfer },
      ].filter((mission) => mission.mode === "transfer" || mission.rounds > 0),
    };
  });
}

// A transfer rebases the aircraft (manual printed p.22: "Air units may only be transferred to
// cities, bases, and aircraft carriers"). The target is a friendly city, base, capital or
// facility cell, or the cell a friendly carrier stands on. A ground or sea piece already on that
// cell does not block the transfer: the air layer is separate from the ground one (T-021).
//
// The range is the same stand-in `air.reach` the missions use, because the original's transfer
// range was not recovered (air.reachSource, UNMEASURED); every refusal says so. The round cost is
// air.transferRounds, UNVERIFIED (air.transferRoundsSource) - the manual prints none, so 0 is an
// assumption recorded in Q50, not a recovered rule. How many aircraft may base on one site is
// Q50's first sub-item and is deliberately NOT capped here.
export const TRANSFER_NOTE = "Transfer. The aircraft rebases; the original's transfer range (stand-in reach, UNMEASURED) and round cost (UNVERIFIED) were not recovered.";

export function transferPlane(match, side, pieceId, target) {
  if (!match || !Array.isArray(match.pieces)) return { error: "There is no match to rebase in." };
  if (match.over) return { error: "The match is over." };
  const plane = match.pieces.find((piece) => piece && piece.id === String(pieceId));
  if (!plane) return { error: "No such aircraft: " + pieceId + "." };
  if (plane.side !== side) return { error: "That aircraft belongs to " + plane.side + "." };
  if (!isAircraft(plane)) return { error: "Only an aircraft is transferred." };
  const remaining = inactiveRounds(plane, match.round);
  if (remaining > 0) return { error: `That aircraft is inactive for ${remaining} more rounds.` };

  const x = Number(target && target.x);
  const y = Number(target && target.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { error: "A transfer needs a whole cell." };
  const wx = ((x % CELL_W) + CELL_W) % CELL_W;
  if (y < 0 || y > 135) return { error: "That site is off the map." };

  // The site on that cell, if any: a friendly city/base/capital/facility is a berth.
  const site = (match.sites || []).find(
    (entry) => entry && Number(entry.x) === wx && Number(entry.y) === y,
  );
  const siteOk = Boolean(site) && site.owner === side &&
    ["city", "capital", "base", "facility"].includes(String(site.kind));
  const carrier = (match.pieces || []).find(
    (unit) => unit && unit !== plane && unit.side === side && unit.kind === "carrier" &&
      Number(unit.x) === wx && Number(unit.y) === y,
  );
  const where = site && site.name ? String(site.name) : (site ? String(site.kind) : "");
  if (!siteOk && !carrier) {
    if (site && site.owner !== side) return { error: "Can't transfer there: " + where + " is not yours." };
    return { error: "Can't transfer there: air units go only to a friendly city, base or carrier." };
  }

  const reach = airReach();
  if (reach > 0 && chebyshev(plane, { x: wx, y }) > reach) {
    return { error: "That site is out of the aircraft's transfer range (" + reach + " cells; stand-in reach, UNMEASURED)." };
  }

  const from = { x: Number(plane.x), y: Number(plane.y) };
  plane.x = wx;
  plane.y = y;
  plane.path = [];
  plane.pace = 1;
  plane.readyAnnounced = false;
  // The round cost is charged from config, like the missions': 0 today, tagged UNVERIFIED
  // (air.transferRoundsSource). A non-zero value in the file charges the plane, so this module
  // never hard-codes either a free transfer or a price.
  const cost = missionCosts().transfer;
  if (cost > 0) plane.inactiveUntil = (Number(match.round) || 0) + cost;
  return {
    ok: true,
    piece: plane,
    events: [{
      type: "transfer",
      side,
      pieceId: plane.id,
      x: wx,
      y: y,
      from,
      round: Number(match.round) || 0,
      note: TRANSFER_NOTE,
    }],
  };
}

// Send one mission. Returns { ok, piece, events } or { error }.
export function sendMission(match, side, pieceId, mode, target) {
  if (String(mode) === "transfer") return transferPlane(match, side, pieceId, target);
  if (!match || !Array.isArray(match.pieces)) return { error: "There is no match to fly in." };
  if (match.over) return { error: "The match is over." };
  const plane = match.pieces.find((piece) => piece && piece.id === String(pieceId));
  if (!plane) return { error: "No such aircraft: " + pieceId + "." };
  if (plane.side !== side) return { error: "That aircraft belongs to " + plane.side + "." };
  if (!isAircraft(plane)) return { error: "Only an aircraft flies a mission." };

  const remaining = inactiveRounds(plane, match.round);
  if (remaining > 0) return { error: `That aircraft is inactive for ${remaining} more rounds.` };

  const mission = modeFor(String(mode));
  if (!mission) return { error: "Missions are strike or patrol." };

  const at = target && Number.isInteger(Number(target.x)) && Number.isInteger(Number(target.y))
    ? { x: Number(target.x), y: Number(target.y) }
    : { x: plane.x, y: plane.y };
  if (at.y < 0 || at.y > 135) return { error: "The target is off the map." };

  const base = baseFor(match, side, plane);
  if (!base) return { error: "No friendly city, dock or ship within reach." };

  const events = [];
  plane.inactiveUntil = (Number(match.round) || 0) + mission.rounds;
  plane.facing = plane.facing ?? null;
  events.push({
    type: mission.type,
    side,
    pieceId: plane.id,
    mode: String(mode),
    x: at.x,
    y: at.y,
    rounds: mission.rounds,
    until: plane.inactiveUntil,
    note: mission.type === "strike" ? STRIKE_NOTE : REACH_NOTE,
  });

  // What a strike actually does (Manual p.25): a land unit loses half its remaining strength; a
  // sea unit takes a constant amount, so three strikes from full sink it. Cargo still cannot
  // defend itself and is lost.
  if (mission.type === "strike") {
    const combat = combatRules();
    const max = combat.maxStrength;
    const doomed = new Set();
    const caught = (match.pieces || []).filter(
      (piece) => piece && piece.side !== side && Number(piece.x) === at.x && Number(piece.y) === at.y,
    );
    for (const target of caught) {
      if (target.transport === true) {
        doomed.add(target.id);
        events.push({ type: "destroyed", side: target.side, pieceId: target.id, by: plane.id, x: target.x, y: target.y, strength: 0, round: Number(match.round) || 0, note: "Strike. The transport is gone." });
        continue;
      }
      const before = ensureStrength(target, max);
      if (target.domain === "sea") {
        const amount = Number((max * combat.airStrikeSeaAmount).toFixed(2));
        const hit = applyDamage(target, amount, max);
        events.push({ type: "strike_hit", side, pieceId: plane.id, target: target.id, domain: "sea", amount, before, strength: hit.after, round: Number(match.round) || 0, note: STRIKE_NOTE });
        if (hit.dead) doomed.add(target.id);
      } else {
        target.strength = Number((before * combat.airStrikeLandFactor).toFixed(2));
        events.push({ type: "strike_hit", side, pieceId: plane.id, target: target.id, domain: target.domain, factor: combat.airStrikeLandFactor, before, strength: target.strength, round: Number(match.round) || 0, note: STRIKE_NOTE });
        if (target.strength <= 0) doomed.add(target.id);
      }
    }
    if (doomed.size > 0) {
      for (const target of match.pieces || []) {
        if (!doomed.has(target.id)) continue;
        if (target.transport === true) continue; // already reported
        events.push({ type: "destroyed", side: target.side, pieceId: target.id, by: plane.id, x: target.x, y: target.y, strength: 0, round: Number(match.round) || 0, note: "Strike. The unit is gone." });
      }
      match.pieces = match.pieces.filter((piece) => !doomed.has(piece.id));
    }
  }

  return { ok: true, piece: plane, events };
}

// A paradrop costs the infantry 25% of the strength it had before the drop (Manual p.50). The unit
// lands on the named cell; nothing else about the order is invented here, so a caller that has no
// paradrop UI yet can still exercise the rule.
export function paradrop(match, side, pieceId, cell) {
  if (!match || !Array.isArray(match.pieces)) return { error: "There is no match to drop into." };
  if (match.over) return { error: "The match is over." };
  const piece = match.pieces.find((unit) => unit && unit.id === String(pieceId));
  if (!piece) return { error: "No such piece: " + pieceId + "." };
  if (piece.side !== side) return { error: "That piece belongs to " + piece.side + "." };
  if (piece.kind !== "infantry") return { error: "Only infantry can drop." };
  if (piece.domain === "sea" || piece.transport === true) return { error: "A transport cannot drop." };
  const x = Number(cell && cell.x);
  const y = Number(cell && cell.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y > 135) return { error: "The drop cell is off the map." };
  const held = match.pieces.find((unit) => unit !== piece && Number(unit.x) === ((x % CELL_W) + CELL_W) % CELL_W && Number(unit.y) === y);
  if (held) return { error: "Another piece holds that cell (" + held.id + ")." };

  const combat = combatRules();
  const max = combat.maxStrength;
  const before = ensureStrength(piece, max);
  const loss = Number((before * combat.paradropLoss).toFixed(2));
  piece.strength = Math.max(0, Number((before - loss).toFixed(2)));
  piece.x = ((x % CELL_W) + CELL_W) % CELL_W;
  piece.y = y;
  piece.path = [];
  piece.pace = 1;
  piece.movedRound = Number(match.round) || 0;
  piece.entrenched = false;
  return {
    ok: true,
    piece,
    events: [{
      type: "paradrop",
      side,
      pieceId: piece.id,
      x: piece.x,
      y: piece.y,
      loss,
      before,
      strength: piece.strength,
      round: Number(match.round) || 0,
      note: PARADROP_NOTE,
    }],
  };
}

// Called once a round: says when an aircraft is flyable again, so the badge has an event.
export function tickAir(match) {
  const events = [];
  if (!match || !Array.isArray(match.pieces)) return events;
  const round = Number(match.round) || 0;
  for (const piece of match.pieces) {
    if (!isAircraft(piece)) continue;
    if (!Number.isFinite(Number(piece.inactiveUntil))) continue;
    if (inactiveRounds(piece, round) > 0) continue;
    if (piece.readyAnnounced === true) continue;
    piece.readyAnnounced = true;
    events.push({ type: "ready", side: piece.side, pieceId: piece.id, x: piece.x, y: piece.y });
  }
  return events;
}
