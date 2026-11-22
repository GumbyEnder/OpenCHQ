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
import { isOilField, payingCount, siteTypeOf } from "./sitetype.mjs";
// The air predicate is placement's (T-029), the same one combat and capture call: an aircraft is
// `kind === "aircraft"` OR `domain === "air"`, never a third spelling here.
import { isAirPiece } from "./placement.mjs";

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

// --- the oil budget (T-033) ----------------------------------------------------------------
//
// The 1990 game's oil is a SIDE-WIDE BUDGET, not per-unit fuel: owned oilfields produce ("In"),
// cities and bases consume ("Out"), and the reserve is what is left. The numbers and their
// addresses are in docs/re/ECONOMY_RE.md (the old docs/re/ECONOMY.md has wrong addresses and is
// superseded) and config/game.json's `resources.fuel`; this section only
// applies them. `upkeepResources` below settles the budget once a round, `chargeOil` takes the
// per-unit spend as pieces move, and `oilReadout` is what the page draws.
//
// Oil only bites from 1986 on: for scenario index < 2 the original rewrites the reserve to the
// 10,000 cap at the top of every recompute (FUN_15f4_0664 4699-4701), which is why 1918 and 1942
// list their budget but never run short.

const OIL = "fuel";

// Site kinds the budget counts come from the subtype table, not the asset list's `kind`
// (sitetype.mjs): a type-5 site is an oil field (PB-153), a paying city is the PB-150 count.
// world.json's 38 sketched `wells` carry no subtype and drive nothing here.

export function oilSpec() {
  const spec = resourceSpec(OIL);
  if (!spec) return null;
  return Number.isFinite(Number(spec.inPerWell)) ? spec : null;
}

function oilEra(match) {
  return String(eraOf(match && match.era) || "");
}

// The free-era list is a Set built once per loaded tunables file: this runs per side per round,
// and rebuilding an array from config on every call showed up in the round bench.
let freeEraSpec = null;
let freeEraSet = new Set();

export function oilUsesReserve(era) {
  const spec = oilSpec();
  if (!spec) return false;
  if (spec !== freeEraSpec) {
    freeEraSpec = spec;
    freeEraSet = new Set((Array.isArray(spec.freeEras) ? spec.freeEras : []).map(String));
  }
  return !freeEraSet.has(String(era || ""));
}

// Owned wells and cities, counted once per room per round into `match.oilSummary` (the tick's
// order is advance, ..., occupy, air, upkeep, pay, so the counts are post-capture for both the
// settlement and the payday). A room asked outside a tick - a test, a direct pay() - falls back
// to counting its own sites, because a stale summary is worse than a scan.
function countSites(match, side) {
  let fields = 0;
  let pieces = 0;
  let air = 0;
  const owned = [];
  for (const site of match.sites) {
    if (!site || site.owner !== side) continue;
    owned.push(site);
    if (isOilField(site)) fields += 1;
  }
  for (const piece of Array.isArray(match.pieces) ? match.pieces : []) {
    if (!piece || piece.side !== side) continue;
    pieces += 1;
    if (isAirPiece(piece)) air += 1;
  }
  return { fields, cities: payingCount(owned), pieces, air };
}

// A WeakMap, never a field on the match: adding a key to the match object mid-match pushes it
// into dictionary mode and tripled JSON.stringify in the store bench (19 ms -> 40 ms for 1,000
// rooms). Nothing here may change the shape of a serialized room.
const summaryByMatch = new WeakMap();

function oilCounts(match, side) {
  const cache = match && summaryByMatch.get(match);
  const round = Number(match && match.round) || 0;
  if (cache && cache.round === round && cache[side]) return cache[side];
  return countSites(match, side);
}

// One pass over the board for both sides, stored under the round it measured.
export function buildOilSummary(match) {
  const summary = {
    round: Number(match && match.round) || 0,
    blue: { fields: 0, type4: 0, caps: 0, cities: 0, pieces: 0, air: 0 },
    red: { fields: 0, type4: 0, caps: 0, cities: 0, pieces: 0, air: 0 },
  };
  for (const site of (match && match.sites) || []) {
    const row = summary[site && site.owner];
    if (!row) continue;
    const type = siteTypeOf(site);
    if (type === 5) row.fields += 1;
    else if (type === 4) row.type4 += 1;
    else if (type === 1 || type === 2) row.caps += 1;
  }
  for (const piece of (match && match.pieces) || []) {
    const row = summary[piece && piece.side];
    if (!row) continue;
    row.pieces += 1;
    if (isAirPiece(piece)) row.air += 1;
  }
  // paying = count(type 4) + max(0, count(type 1) + count(type 2) - 1) (PB-150).
  for (const side of SIDES) summary[side].cities = summary[side].type4 + Math.max(0, summary[side].caps - 1);
  return summary;
}

// In and Out for one side, from what it owns. Counts are of owned sites, the same list the rest
// of the economy uses; a well held by nobody produces for nobody.
export function oilFlow(match, side) {
  const spec = oilSpec();
  if (!spec || !match || !Array.isArray(match.sites)) return null;
  const counted = oilCounts(match, side);
  const fields = counted.fields;
  const cities = counted.cities;
  const pieces = counted.pieces;
  // Air units are their own Out term, 20 each (7668 Out list, FUN_15f4_0664 4704-4723). A side
  // that owns no aircraft pays nothing for them; the mission charge (airMission) is separate.
  const air = Number(counted.air) || 0;
  const minWells = Number.isFinite(Number(spec.inMinWells)) ? Number(spec.inMinWells) : 0;
  const inRate = Number(spec.inPerWell);
  const outRate = Number(spec.outPerCity);
  const base = Number.isFinite(Number(spec.outBase)) ? Number(spec.outBase) : 0;
  const perPiece = Number.isFinite(Number(spec.perPiece)) ? Number(spec.perPiece) : 0;
  const perAir = Number.isFinite(Number(spec.outPerAirUnit)) ? Number(spec.outPerAirUnit) : 0;
  const countedWells = Math.max(minWells, fields);
  const inAmount = Number.isFinite(inRate) ? countedWells * inRate : null;
  const cityOut = Number.isFinite(outRate) ? cities * outRate + base : null;
  const outAmount = Number.isFinite(cityOut) ? cityOut + perPiece * pieces + perAir * air : null;
  return { fields, cities, pieces, air, cityOut, in: inAmount, out: outAmount };
}

// What the page draws for one side. `in`/`out` are the per-round flow, `held` the reserve, and
// `short` the one condition the red OIL warning is allowed to mean: consumption above what the
// reserve plus production can pay.
export function oilReadout(match, side) {
  const spec = oilSpec();
  if (!spec) return null;
  const flow = oilFlow(match, side);
  const meter = meterOf(match, side, OIL);
  if (!flow || !meter) return null;
  const cap = Number.isFinite(Number(spec.reserveCap)) ? Number(spec.reserveCap) : Number(spec.reserve);
  const uses = oilUsesReserve(oilEra(match));
  const held = Number(meter.held);

  const short = uses && (meter.dry === true || (Number.isFinite(flow.out) && Number.isFinite(held) && held + flow.in < flow.out));
  return {
    side,
    held: Number.isFinite(held) ? held : null,
    cap: Number.isFinite(cap) ? cap : null,
    in: flow.in,
    out: flow.out,
    wells: flow.fields,
    fields: flow.fields,
    cities: flow.cities,
    pieces: flow.pieces,
    air: flow.air,
    uses,
    dry: meter.dry === true,
    short,
    divisor: Number.isFinite(Number(spec.displayDivisor)) ? Number(spec.displayDivisor) : null,
  };
}

// The per-cell price for a kind, as a plain number: the moving-piece base (5, FUN_15f4_0d7e
// at 4798) plus, for land kinds, the kind allowance already folded into moveCostByKind
// (infantry 5+12=17, tank 5+24=29). A ship has no allowance (kinds 7-9 are >= 5 in DS:0x19a6),
// so it costs the 5 base. RE-E5 MEASURED this in DOSBox 1986 Blue: ordering one submarine one
// leg raised Out 1812 -> 1817 and cut that round's reserve delta by exactly 5, so ships are
// charged; the capture is docs/re/evidence/re5/ and ECONOMY_RE.md carries the numbers. Free in
// the two scenarios whose reserve is rewritten every round (1918/1942).
const costCache = new Map();
let costCacheSpec = null;

export function oilCostPerCell(match, kind) {
  const spec = oilSpec();
  if (!spec) return 0;
  if (spec !== costCacheSpec) { costCacheSpec = spec; costCache.clear(); }
  const key = oilEra(match) + "|" + String(kind || "");
  const hit = costCache.get(key);
  if (hit !== undefined) return hit;
  const name = String(kind || "");
  let value;
  if (!oilUsesReserve(oilEra(match))) value = 0;
  else {
    const table = spec.moveCostByKind && typeof spec.moveCostByKind === "object" ? spec.moveCostByKind : {};
    value = Number.isFinite(Number(table[name]))
      ? Number(table[name])
      : Number.isFinite(Number(spec.moveCostPerCell)) ? Number(spec.moveCostPerCell) : 0;
  }
  costCache.set(key, value);
  return value;
}

// The meter a walker debits, resolved once per piece per round. `syncOilSeat` writes the old
// seat fields back after a piece's walk, so the view and the older tests still read one value.
export function oilMeterFor(match, side) {
  return oilSpec() ? meterOf(match, side, OIL) : null;
}

export function syncOilSeat(match, side, meter) {
  if (meter) syncFuel(match, side, meter);
}

// The per-unit charge as a call: one cell entered costs `moveCostPerCell` for the kind.
// move.mjs uses the split form above (price once, arithmetic per step) for speed; tests and
// one-off callers use this.
export function chargeOil(match, side, kind, cells = 1) {
  const perCell = oilCostPerCell(match, kind);
  const count = Number.isFinite(Number(cells)) ? Math.max(0, Number(cells)) : 0;
  const cost = perCell * count;
  if (cost <= 0) return { ok: true, cost: 0 };
  const meter = oilMeterFor(match, side);
  if (!meter) return { ok: true, cost: 0 };
  const held = Number(meter.held);
  if (!Number.isFinite(held)) return { ok: true, cost: 0 };
  if (held < cost) {
    meter.held = 0;
    meter.dry = true;
    syncFuel(match, side, meter);
    return { ok: false, cost, held: 0, dry: true };
  }
  meter.held = held - cost;
  meter.dry = meter.held <= 0;
  syncFuel(match, side, meter);
  return { ok: true, cost, held: meter.held, dry: meter.dry };
}

// A flat charge out of the budget (an air mission buys 20 oil before it leaves). Unlike
// `consume`, a short reserve refuses rather than flagging the kind for the whole round: the
// plane simply does not fly.
export function spendOil(match, side, amount) {
  const spec = oilSpec();
  const meter = spec ? meterOf(match, side, OIL) : null;
  const want = Number(amount);
  if (!meter || !Number.isFinite(want) || want <= 0) return { ok: true, cost: 0 };
  const held = Number(meter.held);
  if (!Number.isFinite(held) || held < want) return { ok: false, cost: want, held: Number.isFinite(held) ? held : 0 };
  meter.held = held - want;
  meter.dry = meter.held <= 0;
  syncFuel(match, side, meter);
  return { ok: true, cost: want, held: meter.held, dry: meter.dry };
}

// PB-157: a bombing run on a type-5 oil field takes oil out of the owner's NEXT settlement
// (FUN_1ac5_0dbe 8768-8782: 1000 raw units, 8 on the panel's /125 scale). It is queued on the
// meter, not taken now: the owner may be in another round's flow, and the brief's wording is
// "next-round oil available". settleOil consumes and clears the queue in the same read.
export function queueOilLoss(match, side, amount) {
  const spec = oilSpec();
  const want = Number(amount);
  if (!spec || !Number.isFinite(want) || want <= 0) return { ok: true, queued: 0 };
  const meter = meterOf(match, side, OIL);
  if (!meter) return { ok: false, queued: 0 };
  meter.bombed = Math.max(0, Number(meter.bombed) || 0) + Math.floor(want);
  return { ok: true, queued: meter.bombed };
}

function syncFuel(match, side, meter) {
  const seat = seatOf(match, side);
  if (!seat) return;
  seat.fuel = meter.held;
  seat.dry = meter.dry;
}

// One round of the budget for one side: production in, consumption out, clamped to the cap.
// The return is an event only when the side crosses into or out of "dry", so a quiet round adds
// no log line. For 1918/1942 the original rewrites the reserve to the cap every round, so the
// budget is listed but never runs short (FUN_15f4_0664 4699-4701).
function settleOil(match, side, spec) {
  const meter = meterOf(match, side, OIL);
  if (!meter) return null;
  const cap = Number.isFinite(Number(spec.reserveCap)) ? Number(spec.reserveCap) : Number(spec.reserve);
  if (!oilUsesReserve(oilEra(match))) {
    if (Number.isFinite(cap)) meter.held = cap;
    meter.dry = false;
    syncFuel(match, side, meter);
    return null;
  }
  const flow = oilFlow(match, side) || { in: 0, cityOut: 0, out: 0, pieces: 0 };
  const held = Number.isFinite(Number(meter.held)) ? Number(meter.held) : 0;
  // PB-157: oil taken by a bombing run last round is not available this round. One-shot: the
  // queue is cleared here, whether or not the loss empties the pool.
  const bombed = Math.max(0, Number(meter.bombed) || 0);
  if (bombed > 0) meter.bombed = 0;
  const available = Math.max(0, held + Number(flow.in || 0) - bombed);
  const cityOut = Number(flow.cityOut || 0);
  const perAir = Number.isFinite(Number(spec.outPerAirUnit)) ? Number(spec.outPerAirUnit) : 0;
  const airBill = perAir * Number(flow.air || 0);
  const perPiece = Number.isFinite(Number(spec.perPiece)) ? Number(spec.perPiece) : 0;
  const pieceBill = perPiece * Number(flow.pieces || 0);
  // The terms are paid in the brief's order (7668 Out list: cities, then each air unit, then each
  // piece) out of what is available; a shortfall in any one leaves the reserve at 0 rather than
  // draining it to the floor.
  const paidCity = Math.min(available, cityOut);
  let residual = available - paidCity;
  const airPaid = Math.min(residual, airBill);
  residual -= airPaid;
  const piecePaid = Math.min(residual, pieceBill);
  residual -= piecePaid;
  const floor = Number.isFinite(Number(spec.reserveFloor)) ? Number(spec.reserveFloor) : 0;
  const short = paidCity < cityOut || airPaid < airBill || piecePaid < pieceBill;
  let next = short ? 0 : Math.max(residual, floor);
  if (Number.isFinite(cap) && next > cap) next = cap;
  const wasDry = meter.dry === true;
  meter.held = next;
  meter.dry = next <= 0;
  // 0x1452 as the round ended is the divisor of next round's city-loss term (4735-4740).
  meter.lastOut = Number(flow.out || 0);
  syncFuel(match, side, meter);
  if (meter.dry && !wasDry) return { type: "dry", side, kind: OIL };
  if (!meter.dry && wasDry) return { type: "refuel", side, kind: OIL, held: meter.held };
  return null;
}

// How many cities still pay when the budget cannot cover consumption. The original takes the
// unpaid share off the city count before the payday (FUN_15f4_0664 4727-4762, 2023 scaled 3/2),
// so a short side does not lose all income at once - it loses the cities the oil did not cover.
// Returns {cities, penalty} where penalty is 0 for a side that is not short.
export function oilIncome(match, side, cities) {
  const spec = oilSpec();
  const count = Number(cities) || 0;
  if (!spec || !oilUsesReserve(oilEra(match))) return { cities: count, penalty: 0 };
  // No readout object here: pay() asks this per side per room per round, and oilReadout builds the
  // page's payload (cap, divisor, labels) that this question never reads. Same numbers, same test.
  const flow = oilFlow(match, side);
  const oilMeter = flow ? meterOf(match, side, OIL) : null;
  if (!flow || !oilMeter) return { cities: count, penalty: 0 };
  const held = Number(oilMeter.held);
  const out = Number(flow.out);
  const available = (Number.isFinite(held) ? held : 0) + (Number(flow.in) || 0);
  const short = oilMeter.dry === true || (Number.isFinite(out) && Number.isFinite(held) && held + flow.in < out);
  if (!short) return { cities: count, penalty: 0 };
  if (!Number.isFinite(out) || out <= 0) return { cities: count, penalty: 0 };
  const deficit = out - available;
  if (!(deficit > 0)) return { cities: count, penalty: 0 };
  // lost = floor(deficit x cities / lastOut), the original's 32-bit division at 4735-4740.
  // lastOut is 0x1452 as the settlement left it; fall back to this round's Out when a caller
  // asks before any settlement has stored one.
  const meter = meterOf(match, side, OIL);
  const storedOut = Number(meter && meter.lastOut);
  const lastOut = Number.isFinite(storedOut) && storedOut > 0 ? storedOut : out;
  const scaleRaw = spec.incomePenaltyEraScale && spec.incomePenaltyEraScale[oilEra(match)];
  const scale = Number.isFinite(Number(scaleRaw)) ? Number(scaleRaw) : 1;
  let lost = Math.floor((deficit * count) / lastOut);
  if (scale !== 1) lost = Math.floor(lost * scale);
  if (lost > count) lost = count;
  return { cities: Math.max(0, count - lost), penalty: deficit / out };
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
  // The oil budget's site counts, one pass per room per round, shared by the settlement and the
  // payday that follows it.
  if (Array.isArray(match.sites) && oilSpec()) summaryByMatch.set(match, buildOilSummary(match));

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
      // Oil is a budget, not a burn: it settles as production minus consumption once a round,
      // and its per-unit spend was already charged as the pieces moved (chargeOil).
      if (kind === OIL && oilSpec()) {
        const settled = settleOil(match, side, spec);
        if (settled) events.push(settled);
        continue;
      }
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
