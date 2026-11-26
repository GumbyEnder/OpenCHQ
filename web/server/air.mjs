// Aircraft are a resource, not a piece. Owner: integrator (node `air`, order 275).
//
// A mission costs the aircraft its flying time - it is INACTIVE for a number of rounds and
// cannot be ordered anywhere until that expires. The counts are the booklet's, from
// docs/POLISH_LOOP.md: an air mission is inactive 8 rounds, a scramble 4. Nothing here carries
// a damage number: a strike either catches cargo (which cannot defend itself) or does nothing
// that can be measured, and says so.

import { CELL_W } from "./board.mjs";
import { layerOf } from "./placement.mjs";
import { rules, combatRules } from "./rules.mjs";
import { applyDamage, ensureStrength } from "./combat.mjs";
import { readyRoundOf } from "./readiness.mjs";
import { queueOilLoss } from "./resources.mjs";
import { resourceSpec, spendOil, oilUsesReserve } from "./resources.mjs";

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
  // Manual p.25 (l.777): a CAP flown while the aircraft is still inactive is LESS EFFECTIVE, but the
  // amount was never recovered (decompiled.c has no air path at all) and a scramble resolves no
  // damage here, so there is nothing to scale yet. The file's factor is the lever and its source line
  // says UNVERIFIED; no reduction is invented in code.
  const inactivePatrolFactor = Number(air.inactivePatrolFactor);
  return {
    strike: Number.isFinite(strike) && strike > 0 ? Math.floor(strike) : 0,
    patrol: Number.isFinite(patrol) && patrol > 0 ? Math.floor(patrol) : 0,
    transfer: Number.isFinite(transfer) && transfer >= 0 ? Math.floor(transfer) : 0,
    inactivePatrolFactor: Number.isFinite(inactivePatrolFactor) && inactivePatrolFactor >= 0 && inactivePatrolFactor <= 1
      ? inactivePatrolFactor : 1,
  };
}

function modeFor(name) {
  const costs = missionCosts();
  if (name === "strike") return costs.strike > 0 ? { rounds: costs.strike, type: "strike" } : null;
  // PB-157: the bombing run is the strike's twin in cost and resolution; the original's own
  // strike handler is the one measured (FUN_1ac5_0dbe), so it does not get a second roll or a
  // second round price here.
  if (name === "bomb") return costs.strike > 0 ? { rounds: costs.strike, type: "bomb" } : null;
  if (name === "patrol") return costs.patrol > 0 ? { rounds: costs.patrol, type: "scramble" } : null;
  return null;
}

// PB-157: the bombing run's numbers, read from config like every other tunable.
// FUN_1ac5_0dbe @ 1ac5:0dbe, decompiled.c 8768-8782; MANUAL p.25.
function bombRules() {
  const air = (rules() && rules().air) || {};
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    cashM: number(air.bombCityCashM, 125),
    unreadyRounds: Math.floor(number(air.bombCityUnreadyRounds, 5)),
    oilLoss: number(air.bombOilLoss, 1000),
  };
}

// A bombing run names a city, base, oil field or capital. PB-171: "capital" is in the list because
// the refusal that kept it out was ours, not the archive's - the manual's bombing text names "an
// unoccupied enemy city, base, or oil field" with no capital exception, and FUN_1ac5_0dbe carries no
// subtype 1/2 test (the 125 M / +5 branch is reached by capitals). The kind test itself stays: it is
// what refuses water, a dock and a bare cell. PROVISIONAL, UNVERIFIED pending the DOSBox experiment.
const BOMB_SITE_KINDS = new Set(["city", "base", "facility", "capital"]);

export const STRIKE_NOTE = "Air strike.";
export const BOMB_NOTE = "Bombing run.";
export const REACH_NOTE = "Reach is limited by the aircraft's range.";
export const INACTIVE_CAP_NOTE = "Scramble. The aircraft was still away, so this CAP adds its rounds to the time it owes. It is less effective than a fresh one.";
export const PARADROP_NOTE = "Paradrop. The infantry pays its strength cost.";

// The site kinds an air unit may be based at. ONE list, exported, because three rules read the same
// fact and a duplicate is how they drifted apart: capture destroys the enemy aircraft based on the
// captured strip (below, and `economy.occupy`), a transfer rebases the plane only onto one of these
// (manual printed p.22: "Air units may only be transferred to cities, bases, and aircraft
// carriers"), and a mission has to be flown from one of these or from a carrier. A dock is NOT in
// this list even though the manual names ports for ships: p.22 names cities, bases and carriers.
export const AIRSTRIP_KINDS = new Set(["city", "capital", "base", "facility"]);

export function isAirStrip(kind) {
  return AIRSTRIP_KINDS.has(String(kind));
}

// Is this piece an aircraft? It is the same question placement asks to pick an occupancy layer, so
// this delegates instead of restating it (T-029). The body used to test `kind === "aircraft"` alone
// and silently dropped placement.layerOf's second arm (`domain === "air"`): a piece shaped
// {kind:"tank", domain:"air"} was air to the placement mask, economy's capture pass and combat, and
// ground to this walker. Latent today - no kind in config/game.json carries domain "air" - which is
// exactly why it needed the unit test in web/test/nodes/t029_air_predicate.mjs rather than a board pin.
export function isAircraft(piece) {
  return layerOf(piece) === "air";
}

function airReach() {
  const value = Number((rules().air || {}).reach);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// PB-178: the manual's TWO circles (p.25). `reach` above is the larger "maximum air radius"; a
// mission target has to lie inside the smaller "restricted air radius", and only an UNLOADED
// transfer may use the maximum one. Both sizes are UNVERIFIED port values (air.restrictedReachSource):
// the archive's aircraft range was never recovered. 0 keeps the key optional, which is the old
// behaviour (no target gate), so a config without it cannot silently start refusing orders.
function restrictedReach() {
  const value = Number((rules().air || {}).restrictedReach);
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

// A mission has to be flown from somewhere: a friendly city, base or capital (the same berth list a
// transfer accepts), or the cell a friendly carrier stands on. Manual printed p.22 names exactly
// those: cities, bases and aircraft carriers. This used to accept a `dock`/`docks` site and ANY
// non-transport sea piece, which is the T-021 divergence frodo flagged (room 4890): a plane could
// fly from a base that capture does not treat as an air strip, and from a hull the manual never
// names. Both are gone; the shared list is the point.
function baseFor(match, side, from) {
  const reach = airReach();
  if (reach <= 0) return null;
  const candidate = (cell) => cell && chebyshev(from, cell) <= reach;
  const home = (match.sites || []).find(
    (site) => site && site.owner === side && isAirStrip(site.kind) && candidate(site),
  );
  if (home) return home;
  return (match.pieces || []).find(
    (unit) => unit && unit.side === side && unit.kind === "carrier" && candidate(unit),
  ) || null;
}

// What this seat's aircraft can do right now, as choices rather than as prose: each plane, the
// rounds it still owes, and the two missions with what each one costs. The costs come from config,
// so the page cannot disagree with what the server charges.
export function airBriefing(match, side) {
  const costs = missionCosts();
  const reach = airReach();
  const restricted = restrictedReach();
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
      // A mission needs somewhere to fly from. Without a city, base or carrier in reach the choice
      // exists on the page but is refused by the server, and this says which.
      reach: reach > 0 ? reach : null,
      // PB-178: the smaller circle a mission's target must lie inside (manual p.25). Shipped with
      // the briefing so the PAGE can refuse a far click before it becomes an order; the server
      // refuses it again on its own, which is what makes the rule true for any client.
      restrictedReach: restricted > 0 ? restricted : null,
      base: base ? (base.name || base.id) : null,
      canFly: Boolean(base),
      // PB-293 / manual l.777: a plane that still owes rounds may fly CAP and nothing else, and the
      // CAP ADDS its own rounds to what it owes. `allowed` is the server's answer, not the page's
      // guess, and an inactive plane lists the scramble alone - not three choices the server refuses.
      missions: [
        { mode: "patrol", label: "Scramble (CAP)", rounds: costs.patrol, allowed: true,
          note: left === 0 ? null
            : "Flown while inactive: it adds " + costs.patrol + " rounds to the " + left + " this aircraft already owes." },
        { mode: "strike", label: "Strike", rounds: costs.strike, allowed: left === 0 },
        // A bombing run hits an empty enemy city, base or oil field (PB-157).
        { mode: "bomb", label: "Bomb", rounds: costs.strike, allowed: left === 0 },
        // A transfer rebases the plane instead of flying a mission (manual p.22: "Air units may
        // only be transferred to cities, bases, and aircraft carriers"). Its round cost comes from
        // config and is UNVERIFIED (air.transferRoundsSource): the manual never prints one.
        { mode: "transfer", label: "Transfer", rounds: costs.transfer, allowed: left === 0 },
      ].filter((mission) => mission.allowed && (mission.mode === "transfer" || mission.rounds > 0)),
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
export const TRANSFER_NOTE = "Transfer. The aircraft rebases to the base you pick.";

// An aircraft based at a city, base or capital is DESTROYED when that site is captured, not stranded
// or displaced. This is a RECOVERED RULE, not the remake's choice: Manual printed p.10 ("City
// Conquest") - "note that the enemy air unit was destroyed when you took the city. Capturing the air
// strip is the most certain way of destroying enemy air units." economy.occupy enforces it inside the
// capture pass that flips the owner byte, and emits a `destroyed` event that names the site.
//
// Two cases stay UNVERIFIED and are recorded as Q50 sub-items: an aircraft already airborne on a
// mission when its base falls, and an aircraft based on a carrier (a piece, not a site - out of scope
// for a capture, since carriers change hands only by combat).

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
  const siteOk = Boolean(site) && site.owner === side && isAirStrip(site.kind);
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
    return { error: "That site is out of the aircraft's transfer range (" + reach + " cells)." };
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
  const mission = modeFor(String(mode));
  if (!mission) return { error: "Missions are strike or patrol." };
  // PB-293, manual l.777: an inactive unit may fly NO mission except CAP, and a CAP flown while
  // inactive ADDS its cost to what the unit already owes. So the inactivity gate is per mode, not a
  // blanket refusal: a CAP passes it and pays round + cost on top of the timer it already carries.
  // The manual also calls that CAP "less effective"; the port's patrol resolves no damage, so there
  // is no effect to scale and no factor is invented here (UNVERIFIED - see the card).
  const isCap = String(mode) === "patrol";
  if (remaining > 0 && !isCap) return { error: `That aircraft is inactive for ${remaining} more rounds.` };

  const at = target && Number.isInteger(Number(target.x)) && Number.isInteger(Number(target.y))
    ? { x: Number(target.x), y: Number(target.y) }
    : { x: plane.x, y: plane.y };
  if (at.y < 0 || at.y > 135) return { error: "The target is off the map." };

  const base = baseFor(match, side, plane);
  if (!base) return { error: "No friendly city, base or carrier within reach." };

  // PB-157: validate the bombing target BEFORE the plane or the oil is spent. Every refusal
  // below leaves the aircraft ready, the target untouched and the budget whole.
  let bombTarget = null;
  if (mission.type === "bomb") {
    const wx = ((at.x % CELL_W) + CELL_W) % CELL_W;
    const site = (match.sites || []).find(
      (entry) => entry && Number(entry.x) === wx && Number(entry.y) === at.y,
    );
    if (!site) return { error: "A bombing run needs an enemy city, base or oil field." };
    if (site.owner !== "blue" && site.owner !== "red") {
      return { error: "A bombing run needs an enemy site, not a neutral one." };
    }
    if (site.owner === side) return { error: "That site is yours." };
    // PB-171: a capital IS a bombing target, like any empty enemy city - the kind test below is
    // kept only to refuse kinds a bombing run cannot reach (a dock, water, a bare cell). The
    // mutant that must red `pb157_bomb`'s capital arm is "capital" removed from BOMB_SITE_KINDS.
    // RULING (PM 8131): provisional, UNVERIFIED pending DOSBox; the archive's own target test at
    // 8768-8782 was never recovered (Open RE Questions).
    if (!BOMB_SITE_KINDS.has(String(site.kind))) {
      return { error: "A bombing run hits a city, a base, an oil field or a capital, not a " + String(site.kind || "site") + "." };
    }
    // "Empty" means no ground or sea defender. An aircraft based there is on the air layer and
    // does not shield the site from a bombing run (T-021's layer rule).
    const defender = (match.pieces || []).find(
      (unit) => unit && layerOf(unit) !== "air" &&
        Number(unit.x) === at.x && Number(unit.y) === at.y,
    );
    if (defender) {
      const where = site.name ? String(site.name) : "That site";
      return { error: where + " is defended (" + String(defender.id) + "); a bombing run needs an empty target." };
    }
    bombTarget = site;
  }

  // PB-178 + PB-188 (manual p.25): a mission's target must lie inside the RESTRICTED air radius,
  // the smaller circle. Only an unloaded transfer may use the maximum radius. PB-188 (ruling,
  // room 8383 §4): the circle belongs to the AIR LAYER, not to the Bomb button alone, so a strike
  // is gated here too - the manual's sentence is "the restricted air radius in which most missions
  // must be performed" and a strike is a mission. The gate sits AFTER the bombing run's
  // kind/owner/emptiness tests and BEFORE the oil or the plane is touched, so a far click costs the
  // player nothing. Patrol keeps the open range on purpose: it is the defensive scramble and
  // already defaults to the aircraft's own cell, so gating it would stack a second unverified
  // assumption on the unverified 6. Measured from the aircraft's own cell - its strip while it is
  // on the ground - and wrap-aware, like every other distance on this board.
  if (mission.type === "bomb" || mission.type === "strike") {
    const restricted = restrictedReach();
    if (restricted > 0) {
      const wx = ((at.x % CELL_W) + CELL_W) % CELL_W;
      const away = chebyshev(plane, { x: wx, y: at.y });
      if (away > restricted) {
        const max = airReach();
        const what = mission.type === "strike" ? "an air strike" : "a bombing run";
        return {
          error: "That target is " + away + " cells from the aircraft; " + what
            + " must be inside the restricted air radius (" + restricted
            + " cells). Only a transfer may use the maximum radius (" + max
            + " cells).",
        };
      }
    }
  }

  // Oil (T-033): a mission costs the side's budget 20 before the plane leaves (FUN_15f4_0664
  // 4839 calls FUN_15f4_0d7e(0x14); a side that cannot pay is `dry` and the plane stays on the
  // ground - Manual p.27 "planes can't fly").
  const fuel = resourceSpec("fuel");
  const missionOil = fuel && Number.isFinite(Number(fuel.airMission)) ? Number(fuel.airMission) : 0;
  if (missionOil > 0 && oilUsesReserve(match && match.era)) {
    const bill = spendOil(match, side, missionOil);
    if (!bill.ok) {
      return { error: `Not enough oil to fly a mission: ${missionOil} needed, ${bill.held} in reserve.` };
    }
  }

  const events = [];
  // ADD, not reset: a CAP flown while inactive extends the timer the plane already carries.
  const owedFrom = remaining > 0 && isCap
    ? Math.max(Number(match.round) || 0, Number(plane.inactiveUntil) || 0)
    : (Number(match.round) || 0);
  plane.inactiveUntil = owedFrom + mission.rounds;
  // The manual's "less effective" has no arithmetic here yet (see missionCosts); the factor and its
  // UNVERIFIED source travel with the order so a later RE pass has one lever, not a new literal.
  const capWhileInactive = remaining > 0 && isCap;
  const effectiveness = capWhileInactive ? missionCosts().inactivePatrolFactor : 1;
  if (capWhileInactive) events.push({
    type: "cap_while_inactive",
    side,
    pieceId: plane.id,
    round: Number(match.round) || 0,
    owedBefore: remaining,
    owedAfter: inactiveRounds(plane, match.round),
    effectiveness,
    note: INACTIVE_CAP_NOTE,
  });
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
    inactiveBefore: remaining,
    effectiveness,
    note: mission.type === "strike" ? STRIKE_NOTE : mission.type === "bomb" ? BOMB_NOTE
      : (remaining > 0 ? INACTIVE_CAP_NOTE : REACH_NOTE),
  });

  // PB-157: a bombing run on an empty enemy site takes money and production, or oil. The
  // numbers are config `air.bomb*` (FUN_1ac5_0dbe 8768-8782; MANUAL p.25).
  if (mission.type === "bomb" && bombTarget) {
    const bomb = bombRules();
    const owner = bombTarget.owner;
    const seat = match.sides && match.sides[owner];
    let cash = 0;
    let oil = 0;
    if (String(bombTarget.kind) === "facility") {
      // A type-5 site is an oil field (PB-153): the loss is oil, NOT cash - FUN_1ac5_0dbe
      // 8768-8782 branches on the site type - and it lands on the owner's next settlement.
      const queued = queueOilLoss(match, owner, bomb.oilLoss);
      oil = queued && queued.ok ? bomb.oilLoss : 0;
    } else {
      if (seat) {
        const held = Math.max(0, Number(seat.cash) || 0);
        cash = Math.min(held, bomb.cashM);
        seat.cash = held - cash;
      }
    }
    if (String(bombTarget.kind) !== "facility" && bomb.unreadyRounds > 0) {
      const round = Number(match.round) || 0;
      const base = Math.max(round, readyRoundOf(bombTarget));
      bombTarget.readyRound = base + bomb.unreadyRounds;
    }
    events.push({
      type: "bomb_hit",
      side,
      pieceId: plane.id,
      site: bombTarget.id,
      name: bombTarget.name ?? null,
      kind: bombTarget.kind,
      owner,
      x: bombTarget.x,
      y: bombTarget.y,
      cash,
      oil,
      unready: oil > 0 ? 0 : bomb.unreadyRounds,
      round: Number(match.round) || 0,
      note: BOMB_NOTE,
    });
  }

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
