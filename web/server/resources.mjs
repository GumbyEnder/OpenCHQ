// Resource kinds: holding and consumption, generic over the kind. Owner: resources node.
//
// The 1990 game had oil and nothing else, and oil was wired into the economy module with its
// own field on the seat. A successor that only ever has oil is a design we can no longer
// change without touching four files, so a kind is now a row of data in config/game.json
// (`resources`) and this module is the only code that knows how a reserve is held, spent or
// refilled. Adding a third kind is a config edit, not a new branch here.
//
// Two numbers a kind needs, and only those two, are its own: `reserve` (what a side starts
// with, and what a refill restores) and `burn` (what one running round takes). A third,
// `rate` (what a kind pays out per owned site), is deliberately absent everywhere: the
// archive never recovered a yield, and a default of 1 would be an invented number wearing a
// codepath. `produce` therefore refuses a kind with no rate instead of paying it.
//
// A kind with `eras` exists only in those scenarios. A kind without it exists in all of them.
// A kind with `refillAt` refills while one of that side's pieces stands on a site of a listed
// kind; fuel does this at a well. Nothing here invents an effect for a dry side: `dry` is a
// flag the seat can read, and the module that owns the rules for that kind decides what it
// means. Fuel keeps its old top-level seat fields so the view and the older tests still read
// exactly one thing.

import { rules } from "./rules.mjs";
import { eraOf } from "./match.mjs";
import { cellKeyOf, cellsOfKinds } from "./siteindex.mjs";

const SIDES = Object.freeze(["blue", "red"]);

function isSide(value) {
  return SIDES.includes(value);
}

function seatOf(match, side) {
  const sides = match && match.sides;
  return sides && isSide(side) ? sides[side] : null;
}

// The kinds table, minus any key that starts with "_" (a comment, not a kind). Built once per
// loaded tunables file: rules() hands back the same object until it is reloaded, and the tick
// path runs this for every room every round.
let tableCache = null;
let tableFor = null;

export function resourceTable() {
  const current = rules();
  if (tableCache && tableFor === current) return tableCache;
  const table = current.resources;
  const out = {};
  if (table && typeof table === "object") {
    for (const [kind, spec] of Object.entries(table)) {
      if (kind.startsWith("_")) continue;
      if (!spec || typeof spec !== "object") continue;
      out[kind] = spec;
    }
  }
  tableCache = out;
  tableFor = current;
  return out;
}

export function resourceSpec(kind) {
  const name = String(kind ?? "");
  const table = resourceTable();
  return Object.hasOwn(table, name) ? table[name] : null;
}

export function knownKinds() {
  return Object.keys(resourceTable()).sort();
}

// Kinds per scenario, also cached: `eras` is a list on a spec and never changes until the file
// is reloaded, so the per-round answer is the same list object.
const eraCache = new Map();

export function resourceKinds(era) {
  const year = eraOf(era);
  const table = resourceTable();
  const hit = eraCache.get(year);
  if (hit && hit.table === table) return hit.kinds;
  const out = [];
  for (const [kind, spec] of Object.entries(table)) {
    if (Array.isArray(spec.eras) && !spec.eras.map(String).includes(year)) continue;
    out.push(kind);
  }
  const kinds = Object.freeze(out.sort());
  eraCache.set(year, { table, kinds });
  return kinds;
}

export function kindOpenIn(kind, era) {
  return resourceKinds(era).includes(String(kind));
}

// What one owned site pays of this kind per payment. null means nobody recovered it, and
// null is what the caller must see: not zero, not one.
export function rateOf(kind) {
  const spec = resourceSpec(kind);
  if (!spec) return null;
  if (spec.rate === null || spec.rate === undefined) return null;
  const rate = Number(spec.rate);
  return Number.isFinite(rate) ? rate : null;
}

// --- a side's holding ---------------------------------------------------------------------
// The meter lives on the seat as `seat.resources[kind] = { held, dry }`. It is created on
// first touch and never on a kind the scenario does not carry, so the shape of a seat is a
// consequence of the config rather than of a list of field names in code.
export function meterOf(match, side, kind) {
  const seat = seatOf(match, side);
  const spec = resourceSpec(kind);
  if (!seat || !spec) return null;
  if (!seat.resources || typeof seat.resources !== "object") seat.resources = {};
  let meter = seat.resources[kind];
  if (!meter || typeof meter !== "object") {
    const reserve = Number(spec.reserve);
    meter = { held: Number.isFinite(reserve) ? reserve : null, dry: false };
    seat.resources[kind] = meter;
  }
  // Fuel keeps two older fields on the seat (`fuel`, `dry`) because the seat view and the
  // player's own panel have read them since the oil node. They stay the copy of record for
  // fuel: a restored room, or an older caller that sets `seat.fuel`, wins over the cache here.
  if (kind === "fuel" && seat.fuel !== null && seat.fuel !== undefined && Number.isFinite(Number(seat.fuel))
      && Number(seat.fuel) !== Number(meter.held)) {
    meter.held = Number(seat.fuel);
    meter.dry = seat.dry === true;
  }
  return meter;
}

// Every kind this side holds, for the seat view and for the page. `rate` travels as null when
// it was never recovered, so the page can say "rate unknown" instead of drawing a number.
export function metersFor(match, side) {
  const seat = seatOf(match, side);
  if (!seat) return [];
  const out = [];
  for (const kind of resourceKinds(match && match.era)) {
    const spec = resourceSpec(kind);
    const stored = seat.resources && typeof seat.resources === "object" ? seat.resources[kind] : null;
    const held = stored && Number.isFinite(Number(stored.held)) ? Number(stored.held) : null;
    const reserve = Number(spec.reserve);
    out.push({
      kind,
      held,
      dry: Boolean(stored && stored.dry === true),
      reserve: Number.isFinite(reserve) ? reserve : null,
      rate: rateOf(kind),
    });
  }
  return out;
}

// --- holding, spending, paying out ---------------------------------------------------------

export function hold(match, side, kind, amount) {
  const spec = resourceSpec(kind);
  if (!spec) return { error: `No such resource: ${kind || "(none)"}.` };
  if (!kindOpenIn(kind, match && match.era)) {
    return { error: `${kind} is not in this scenario.` };
  }
  const meter = meterOf(match, side, kind);
  if (!meter) return { error: `Unknown side: ${side}.` };
  const want = Number(amount);
  if (!Number.isFinite(want) || want < 0) return { error: `Not an amount of ${kind}: ${amount}.` };
  const held = Number(meter.held);
  if (!Number.isFinite(held)) {
    return { error: `${kind} has no reserve yet: no holding number was set.` };
  }
  meter.held = held + want;
  if (meter.held > 0) meter.dry = false;
  if (kind === "fuel") seatOf(match, side).fuel = meter.held;
  return { ok: true, kind, held: meter.held, dry: meter.dry };
}

export function consume(match, side, kind, amount) {
  const spec = resourceSpec(kind);
  if (!spec) return { error: `No such resource: ${kind || "(none)"}.` };
  if (!kindOpenIn(kind, match && match.era)) {
    return { error: `${kind} is not in this scenario.` };
  }
  const meter = meterOf(match, side, kind);
  if (!meter) return { error: `Unknown side: ${side}.` };
  const want = Number(amount);
  if (!Number.isFinite(want) || want < 0) return { error: `Not an amount of ${kind}: ${amount}.` };
  const held = Number(meter.held);
  if (!Number.isFinite(held)) {
    return { error: `${kind} has no reserve yet: no holding number was set.` };
  }
  if (held < want) {
    meter.dry = true;
    if (kind === "fuel") {
      seatOf(match, side).fuel = meter.held;
      seatOf(match, side).dry = meter.dry;
    }
    return { error: `Not enough ${kind}.`, kind, held: meter.held, dry: true };
  }
  meter.held = held - want;
  meter.dry = meter.held <= 0;
  if (kind === "fuel") {
    seatOf(match, side).fuel = meter.held;
    seatOf(match, side).dry = meter.dry;
  }
  return { ok: true, kind, held: meter.held, dry: meter.dry };
}

// A payout needs a rate the owner set. With none, this refuses and says why; it never pays a
// default. That refusal is the whole point of the node: an unknown number stays unknown.
export function produce(match, side, kind, sites = 1) {
  const spec = resourceSpec(kind);
  if (!spec) return { error: `No such resource: ${kind || "(none)"}.` };
  if (!kindOpenIn(kind, match && match.era)) {
    return { error: `${kind} is not in this scenario.` };
  }
  const rate = rateOf(kind);
  if (rate === null) {
    return { error: `The rate for ${kind} was never recovered.`, kind, rate: null };
  }
  const count = Number(sites);
  if (!Number.isFinite(count) || count < 0) return { error: `Not a number of sites: ${sites}.` };
  return hold(match, side, kind, rate * count);
}

export function movementBlocked(match, side) {
  if (!match || !match.sides) return null;
  for (const kind of resourceKinds(match.era)) {
    const spec = resourceSpec(kind);
    if (!spec || spec.blocksMovement !== true) continue;
    const meter = meterOf(match, side, kind);
    if (meter && meter.dry === true) return kind;
  }
  return null;
}

// --- one running round ---------------------------------------------------------------------

function refillKinds(spec) {
  const raw = spec && spec.refillAt;
  if (typeof raw === "string") return [raw];
  return Array.isArray(raw) ? raw.map(String) : [];
}

// Which cells carry a refill site for this kind, built once per round rather than scanned per
// piece: a full 1986 board is 84 sites and 40 pieces a side. The cells come off the site index
// the rest of the round already built.
function refillCells(match, kinds) {
  return cellsOfKinds(match.sites, kinds);
}

// One running round for every kind the scenario carries, for both sides, in place. A side
// standing on a refill site gets its reserve back; otherwise it burns. Never below zero, and
// one side's shortage never touches the other.
//
// The plan (kinds, specs, refill cells) and each side's occupied cells are built once per
// round, not once per side per kind: 1,000 rooms ticking every 5 s cannot afford an 84-site
// scan inside the kind loop, and the capacity bench is what says so.
export function upkeepResources(match) {
  if (!match || !match.sides) return [];
  const kinds = resourceKinds(match.era);
  if (kinds.length === 0) return [];

  const plan = [];
  for (const kind of kinds) {
    const spec = resourceSpec(kind);
    if (!spec) continue;
    plan.push({ kind, spec, cells: refillCells(match, refillKinds(spec)) });
  }

  const occupied = { blue: new Set(), red: new Set() };
  if (Array.isArray(match.pieces)) {
    for (const piece of match.pieces) {
      if (!piece || !isSide(piece.side)) continue;
      // A numeric cell, the same key the site index uses: a string key per piece per round was
      // a visible slice of the bench's garbage collector.
      occupied[piece.side].add(cellKeyOf(piece));
    }
  }

  const events = [];
  for (const side of SIDES) {
    const seat = seatOf(match, side);
    if (!seat) continue;
    for (const { kind, spec, cells } of plan) {
      const meter = meterOf(match, side, kind);
      if (!meter) continue;
      const reserve = Number(spec.reserve);
      const burn = Number(spec.burn);
      let standing = false;
      if (cells.size > 0) {
        for (const cell of occupied[side]) {
          if (cells.has(cell)) { standing = true; break; }
        }
      }

      if (standing) {
        const wasShort = meter.dry === true ||
          (Number.isFinite(reserve) && Number.isFinite(Number(meter.held)) && Number(meter.held) < reserve);
        if (Number.isFinite(reserve)) meter.held = reserve;
        meter.dry = false;
        if (wasShort) events.push({ type: "refuel", side, kind, held: meter.held });
      } else if (Number.isFinite(burn) && Number.isFinite(Number(meter.held))) {
        const left = Math.max(0, Number(meter.held) - burn);
        meter.held = left;
        if (left <= 0) {
          if (meter.dry !== true) events.push({ type: "dry", side, kind });
          meter.dry = true;
        } else {
          meter.dry = false;
        }
      }

      if (kind === "fuel") {
        seat.fuel = meter.held;
        seat.dry = meter.dry;
      }
    }
  }
  return events;
}
