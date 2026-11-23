// The 1986 kit. Owner: integrator (node `late_kit`, order 280).
//
// The tools are era-gated exactly as the archive gated them (docs/POLISH_LOOP.md): 1918 and
// 1942 hide nuke, satellites, foreign aid, intel and cease-fire; 1986 and 2023 have them; the
// concealed start has oil and the tools it already refuses. Where the original printed no
// number - a radius, a cost, a damage figure - nothing is invented here: a nuke is refused by
// default and, when enabled, still deals no damage. The only tool that changes the board is
// foreign aid, and the archive's own note says it flips a city's owner.

import { millionsPerBillion, priceOf, rules } from "./rules.mjs";
import { beginScan } from "./scan.mjs";
// PB-156: the launch gate is the DIFFERENCE of two counters, and one global detonation count drives
// the income roll and the winter check. Both live in nukes.mjs so economy.incomeGate reads the same
// numbers this module writes.
import { launchLead, warnFrom, winterFrom, nukeState, nukeRoll, winterChancePercent } from "./nukes.mjs";

const LATE_ERAS = new Set(["1986", "2023", "9999"]);

// Manual p.30: at most three more nukes than the opponent has fired. The old booklet paraphrase
// ("three fired or three absorbed without reply") counted one side's total and an intercept count;
// PB-156 replaces it with the difference. The number is config's `nukes.launchLead` (DECODED).

// PB-160: the banner is the transcript line the ack's note becomes (app.js `say(event.note)`).
// It says what the scan actually does - the bar reveals units as it passes, bar-local (Q51, T-022) -
// and carries the price the event charged, so the copy cannot drift from `prices.intelScan`.
export const INTEL_NOTE = "Intel: the scan bar reveals enemy units as it passes; the other side is told.";
export function intelNote(cost) {
  const per = Number(millionsPerBillion()) || 1000;
  const value = Number(cost);
  const billions = Number.isFinite(value)
    ? (value / per).toFixed(3).replace(/\.?0+$/, "")
    : "";
  return INTEL_NOTE + " " + (billions === "" || billions === "-0" ? "0" : billions) + "b";
}
export const SATELLITE_NOTE = "Satellite overhead. Its pass is quiet.";
export const AID_NOTE = "Foreign aid. The city changed hands.";
export const CEASEFIRE_NOTE = "Cease fire accepted.";
export const NUKE_NOTE = "A nuke is refused.";

export const TOOLS = Object.freeze(["buy", "entrench", "intel", "satellite", "aid", "ceasefire", "nuke", "oil"]);

// Deduct a priced tool's cost from the seat's pool, in integer millions. Validation of whether a
// tool would do anything happens before this call, so a refused no-op never spends.
function charge(match, side, tool) {
  const kind = PRICE_KIND[tool];
  if (!kind) return { ok: true, price: 0 };
  const price = priceOf(kind);
  if (!Number.isFinite(price)) return { ok: true, price: 0 };
  const seat = match.sides && match.sides[side];
  if (!seat) return { error: `Unknown side: ${side}.` };
  if (!Number.isFinite(seat.cash) || seat.cash < price) {
    const factor = millionsPerBillion();
    const billions = Number.isFinite(factor) && factor > 0 ? price / factor : price;
    return { error: `Not enough in ${side}'s pool for ${tool} (${billions} billion).` };
  }
  seat.cash -= price;
  return { ok: true, price };
}

// Oil is its own case: 1918 and 1942 hide it, 1986 and 2023 show it, and the concealed start
// (9999) shows the 1986 set too, labelled UNVERIFIED in config.
const OIL_ERAS = new Set(["1986", "2023", "9999"]);

// What a tool costs, as a priced kind in config/game.json's table (Manual p.28 + DS:0x2E16).
// A tool with no price entry costs nothing; a tool with a price is charged from the seat's pool.
const PRICE_KIND = Object.freeze({
  intel: "intelScan",
  satellite: "reconSat",
  aid: "foreignAid",
  nuke: "nuke",
  ceasefire: null,
});

function eraHas(era, tool) {
  if (tool === "buy" || tool === "entrench") return true;
  if (tool === "oil") return OIL_ERAS.has(String(era));
  return LATE_ERAS.has(String(era));
}

// The tools an era's command bar shows.
export function toolsForEra(era) {
  return TOOLS.filter((tool) => eraHas(era, tool));
}

function counters(match) {
  if (!match.late || typeof match.late !== "object") match.late = {};
  if (!match.late[String()]) match.late.launched = match.late.launched || {};
  return match.late;
}

function launchedBy(match, side) {
  const late = counters(match);
  late.launched = late.launched || {};
  late.launched[side] = late.launched[side] || { fired: 0, absorbed: 0 };
  return late.launched[side];
}

function otherSide(side) {
  return side === "blue" ? "red" : "blue";
}

// How many launches this side leads by: fired(mine) - fired(theirs). Negative when the other side
// is ahead, which is why a side that has already fired three may fire again once its opponent does.
export function launchEdge(match, side) {
  const mine = launchedBy(match, side);
  const theirs = launchedBy(match, otherSide(side));
  return Number(mine.fired || 0) - Number(theirs.fired || 0);
}

// Whether this side may still launch. Exported so the rule can be read without launching.
export function nukeStatus(match, side) {
  const cfg = (rules().nukes || {});
  if (cfg.enabled !== true) return { allowed: false, reason: NUKE_NOTE };
  const lead = launchLead();
  const edge = launchEdge(match, side);
  if (edge >= lead) {
    return {
      allowed: false,
      reason: `${lead} more launches than the other side are already away. No further launches until they fire one.`,
    };
  }
  return { allowed: true };
}

// A capital may not be targeted: the archive keeps a guard around home ground.
function nearCapital(match, cell) {
  const cfg = (rules().nukes || {});
  const radius = Number(cfg.exclusion);
  if (!Number.isFinite(radius) || radius < 1) return false;
  for (const side of ["blue", "red"]) {
    const capital = match.capitals && match.capitals[side];
    if (!capital) continue;
    if (Math.abs(capital.x - cell.x) <= radius && Math.abs(capital.y - cell.y) <= radius) return true;
  }
  return false;
}

// What the kit does, said out loud, with every unascertained number labelled.
//
// The tools existed and the buttons existed; the consequences were only in this file. A player could
// fire a nuke without being told it deals no damage, or wonder why a launch was refused. This
// briefing is the text: a label, a sentence, whether the tool is available right now, and for a
// nuke the radius the config guards and how many launches are left. Anything the archive never
// printed is called STAND-IN in the sentence itself, not in a comment.
export const STAND_IN = "STAND-IN";

export function kitBriefing(match, side) {
  const cfg = (rules().nukes || {});
  const radius = Number(cfg.exclusion);
  const status = nukeStatus(match, side);
  const lead = launchLead();
  const edge = match ? launchEdge(match, side) : 0;
  const left = Math.max(0, lead - edge);
  const kit = [];

  const add = (name, label, text, allowed, reason) => {
    kit.push({ name, label, text, allowed: Boolean(allowed), reason: reason || null });
  };

  const foes = (match && Array.isArray(match.pieces) ? match.pieces : [])
    .filter((piece) => piece && piece.side !== side).length;
  const turnable = (match && Array.isArray(match.sites) ? match.sites : [])
    .filter((site) => site && site.kind === "city" && site.owner && site.owner !== side).length;

  add("intel", "Intel scan", "Every enemy unit is revealed for one round, and the other side is told it was read.",
    foes > 0, foes > 0 ? null : "There is nothing to reveal.");
  add("satellite", "Satellite pass", "The same reveal, and it is quiet: nobody is told.",
    foes > 0, foes > 0 ? null : "There is nothing to reveal.");
  add("aid", "Foreign aid", "Turns one enemy city. The archive's own note says aid flips a city's owner.",
    turnable > 0, turnable > 0 ? null : "There is no city to turn.");
  add("ceasefire", "Cease fire", "Accepted, and it changes nothing: no movement, no damage, no income.", true);

  if (eraHas(match && match.era, "nuke")) {
    const radiusText = Number.isFinite(radius) && radius >= 1
      ? `A capital and the ${radius} cells around it cannot be targeted. That radius is a ${STAND_IN}: the archive kept a guard but never printed its size.`
      : "No home-ground guard is set in this match.";
    const limitText = `Launches stop once this side has ${lead} more fired than the other side (Manual p.30). ` +
      `This side may fire ${left} more before the other side answers.`;
    const damageText = `A launch deals no damage and paints no wasteland — a ${STAND_IN}, because the archive's own nuke did neither.`;
    // PB-156: the global count is not decoration. Every launch feeds it, and it is what turns the
    // sky on both sides: income can be skipped from the first detonation, the warning comes at 5,
    // and winter can end the war from 10.
    const parked = match ? nukeState(match) : null;
    const detonated = parked ? Number(parked.detonated) || 0 : 0;
    const countText = `Detonations so far: ${detonated}. From ${warnFrom()} the sky is warned; from ${winterFrom()} each launch can end the war for both sides.`;
    add("nuke", "Nuke", [radiusText, limitText, countText, damageText].join(" "), status.allowed, status.reason);
  }

  return kit;
}

// One tool use. Returns { ok, events } or { error }.
export function useTool(match, side, tool, target) {
  if (!match) return { error: "There is no match." };
  if (match.over) return { error: "The match is over." };
  const name = String(tool || "");
  if (!TOOLS.includes(name)) return { error: "No such tool: " + (name || "(none)") + "." };
  if (!["blue", "red"].includes(side)) return { error: "Unknown side: " + side + "." };
  if (!eraHas(match.era, name)) return { error: `${name} is not in this era.` };

  const round = Number(match.round) || 0;
  const events = [];

  if (name === "intel" || name === "satellite") {
    const foes = (match.pieces || []).filter((piece) => piece && piece.side !== side);
    if (name === "intel" && foes.length === 0) return { error: "There is nothing to reveal." };
    const paid = charge(match, side, name);
    if (paid.error) return paid;
    for (const piece of foes) piece.revealedRound = round;
    // PB-158: the reveal is the bar's, so the pass is armed on the server at the same instant.
    // `view.forSeat` then sends only the pieces whose column the bar covers, and stops sending
    // them once the trailing edge has passed (no lingering: Q51). A satellite pass stays a quiet
    // whole-round reveal and does not arm this.
    if (name === "intel") beginScan(match, side, Date.now(), round);
    events.push({
      type: name === "intel" ? "intel" : "satellite",
      side,
      round,
      reveals: foes.length,
      cost: paid.price,
      note: name === "intel" ? intelNote(paid.price) : SATELLITE_NOTE,
    });
    if (name === "intel") {
      // Intel tells the opponent it was read. The satellite pass is quiet.
      events.push({ type: "intel_seen", side: side === "blue" ? "red" : "blue", by: side, round });
    }
    return { ok: true, events };
  }

  if (name === "aid") {
    // The archive's aid flips a city's owner. Pick the enemy city with the lowest id so the
    // choice is deterministic rather than a hidden policy.
    const city = (match.sites || [])
      .filter((site) => site && site.kind === "city" && site.owner && site.owner !== side)
      .sort((a, b) => Number(a.id) - Number(b.id))[0];
    if (!city) return { error: "There is no city to turn." };
    const paid = charge(match, side, name);
    if (paid.error) return paid;
    const from = city.owner;
    city.owner = side;
    events.push({ type: "aid", side, site: city.id, name: city.name, x: city.x, y: city.y, from, round, cost: paid.price, note: AID_NOTE });
    return { ok: true, events };
  }

  if (name === "ceasefire") {
    // Accepted, and deliberately changes nothing: no movement, no damage, no income.
    events.push({ type: "ceasefire", side, round, note: CEASEFIRE_NOTE });
    return { ok: true, events };
  }

  if (name === "nuke") {
    const status = nukeStatus(match, side);
    if (!status.allowed) return { error: status.reason };
    const at = target && Number.isInteger(Number(target.x)) && Number.isInteger(Number(target.y))
      ? { x: Number(target.x), y: Number(target.y) }
      : null;
    if (!at) return { error: "A launch needs a target cell." };
    if (at.y < 0 || at.y > 135) return { error: "The target is off the map." };
    if (nearCapital(match, at)) return { error: "Home ground is not a target." };
    const paid = charge(match, side, name);
    if (paid.error) return paid;
    const mine = launchedBy(match, side);
    mine.fired = Number(mine.fired || 0) + 1;
    // FUN_1eb5_0eae: one global count, incremented by the detonation itself, whatever the side.
    const state = nukeState(match);
    state.detonated = Number(state.detonated || 0) + 1;
    const detonated = state.detonated;
    // No wasteland, no flipped city, no damage: the archive's own rule for this stand-in.
    events.push({
      type: "nuke", side, x: at.x, y: at.y, round, launched: mine.fired, detonated, cost: paid.price,
      note: "Stand-in nuke. It paints nothing and deals no damage.",
    });
    // From 5, a warning. Both seats read it: the count is global, not the launcher's business.
    if (detonated >= warnFrom()) {
      events.push({
        type: "nuke_warning", side: null, round, detonated,
        note: `${detonated} detonations. Nuclear winter can end the war from ${winterFrom()}.`,
      });
    }
    // From 10, winter if rnd(100) < 100 / (20 - n). The game ends as a loss for BOTH sides: no
    // winner is recorded, because neither side survives the sky.
    if (detonated >= winterFrom()) {
      const roll = nukeRoll(match);
      const chance = winterChancePercent(detonated);
      if (roll < chance) {
        match.over = true;
        match.clock = "held";
        match.winner = null;
        match.winReason = { kind: "nuclear_winter", side: null, detonated, round, chance, roll };
        events.push({
          type: "nuclear_winter", side: null, round, detonated, roll, chance,
          note: "Nuclear winter. Neither side goes on.",
        });
      }
    }
    return { ok: true, events };
  }

  return { error: `${name} is not a tool this module runs.` };
}
