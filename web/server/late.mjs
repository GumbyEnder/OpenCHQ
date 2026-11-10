// The 1986 kit. Owner: integrator (node `late_kit`, order 280).
//
// The tools are era-gated exactly as the archive gated them (docs/POLISH_LOOP.md): 1918 and
// 1942 hide nuke, satellites, foreign aid, intel and cease-fire; 1986 and 2023 have them; the
// concealed start has oil and the tools it already refuses. Where the original printed no
// number - a radius, a cost, a damage figure - nothing is invented here: a nuke is refused by
// default and, when enabled, still deals no damage. The only tool that changes the board is
// foreign aid, and the archive's own note says it flips a city's owner.

import { millionsPerBillion, priceOf, rules } from "./rules.mjs";

const LATE_ERAS = new Set(["1986", "2023", "9999"]);

// The booklet's limit, from docs/POLISH_LOOP.md: "after three nukes fired or three absorbed
// without reply, further launches stop".
const LAUNCH_LIMIT = 3;

export const INTEL_NOTE = "Intel. Every unit is revealed, and the other side is told.";
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

// Whether this side may still launch. Exported so the rule can be read without launching.
export function nukeStatus(match, side) {
  const cfg = (rules().nukes || {});
  if (cfg.enabled !== true) return { allowed: false, reason: NUKE_NOTE };
  const mine = launchedBy(match, side);
  if (Number(mine.fired) >= LAUNCH_LIMIT) {
    return { allowed: false, reason: `Three launches are already away. No further launches.` };
  }
  if (Number(mine.absorbed) >= LAUNCH_LIMIT) {
    return { allowed: false, reason: `Three were absorbed without reply. No further launches.` };
  }
  return { allowed: true };
}

// A capital may not be targeted: the archive keeps a guard around home ground.
function nearCapital(match, cell) {
  const cfg = (rules().nukes || {});
  const radius = Number(cfg.exclusion);
  if (!Number.isFinite(radius) || radius < 1) return false;
  for (const side of ["blue", "red"]) {
    const row = match.capitals && match.capitals[side];
    const capitals = Array.isArray(row) ? row : row ? [row] : [];
    for (const capital of capitals) {
      if (!capital) continue;
      if (Math.abs(capital.x - cell.x) <= radius && Math.abs(capital.y - cell.y) <= radius) return true;
    }
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
  const mine = match ? launchedBy(match, side) : { fired: 0, absorbed: 0 };
  const left = Math.max(0, LAUNCH_LIMIT - Number(mine.fired || 0));
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
    const limitText = `Launches stop after ${LAUNCH_LIMIT} fired or ${LAUNCH_LIMIT} absorbed without reply (the booklet's count). ` +
      `This side has ${left} of ${LAUNCH_LIMIT} left.`;
    const damageText = `A launch deals no damage and paints no wasteland — a ${STAND_IN}, because the archive's own nuke did neither.`;
    add("nuke", "Nuke", [radiusText, limitText, damageText].join(" "), status.allowed, status.reason);
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
    events.push({
      type: name === "intel" ? "intel" : "satellite",
      side,
      round,
      reveals: foes.length,
      cost: paid.price,
      note: name === "intel" ? INTEL_NOTE : SATELLITE_NOTE,
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
    // No wasteland, no flipped city, no damage: the archive's own rule for this stand-in.
    events.push({ type: "nuke", side, x: at.x, y: at.y, round, launched: mine.fired, cost: paid.price, note: "Stand-in nuke. It paints nothing and deals no damage." });
    return { ok: true, events };
  }

  return { error: `${name} is not a tool this module runs.` };
}
