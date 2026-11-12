// Rules the whole server shares: the tunables file, and the terrain facts that come from
// the archive rather than from tuning. Loaded once per process. No module may hard-code a
// round length, a price, a sight radius or a terrain cost; read it from here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TERRAIN } from "./board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.resolve(here, "..", "..", "config", "game.json");

let cached = null;
let cachedPath = null;

// Resolved once per config load, not per read. `process.env` is a proxy and every read costs a few
// hundred nanoseconds: rules() is read tens of times per piece per round, and the 1000-room bench
// spent 12% of its samples inside this function. resetRules() clears the memo, so a test that
// switches OPENCHQ_CONFIG and calls it (web/test/nodes/resources.mjs) still reads the new file.
let resolvedPath = null;

export function configPath() {
  if (resolvedPath !== null) return resolvedPath;
  resolvedPath = process.env.OPENCHQ_CONFIG || DEFAULT_CONFIG;
  return resolvedPath;
}

export function rules() {
  // The memo is the same string object every call, so this is an identity compare on the fast path.
  if (cached && cachedPath === resolvedPath && resolvedPath !== null) return cached;
  const wanted = configPath();
  if (cached && cachedPath === wanted) return cached;
  cached = JSON.parse(readFileSync(wanted, "utf8"));
  cachedPath = wanted;
  return cached;
}

export function resetRules() {
  cached = null;
  cachedPath = null;
  resolvedPath = null;
}

export function roundSeconds() {
  return Number(rules().roundSeconds);
}

// --- speeds 0-6 (T-004) --------------------------------------------------------------------
//
// The original's game speed runs 0 through 6 (Manual p.34-35). Speed 0 accepts orders and air
// strikes but does not let time pass. The seven round lengths live in config.speeds as an array
// indexed by the speed; they are stand-ins, so only their ordering is binding.
//
// A missing or malformed slot falls back to the old single round length rather than inventing a
// clock: a room whose speed went bad plays at the same pace it always did.
export const SPEED_MIN = 0;
export const SPEED_MAX = 6;

export function speedTable() {
  const list = rules().speeds;
  if (!Array.isArray(list) || list.length < SPEED_MAX + 1) {
    const single = roundSeconds();
    return [0, single, single, single, single, single, single];
  }
  return list.slice(0, SPEED_MAX + 1).map((entry, index) => {
    const value = Number(entry);
    if (!Number.isFinite(value) || value < 0) return index === 0 ? 0 : roundSeconds();
    return value;
  });
}

export function clampSpeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const whole = Math.round(number);
  if (whole < SPEED_MIN || whole > SPEED_MAX) return null;
  return whole;
}

// Seconds per round at this speed. Speed 0 is 0: the room holds, nothing ticks.
export function speedSeconds(speed) {
  const table = speedTable();
  const index = clampSpeed(speed);
  return table[index === null ? 1 : index];
}

// Whether a room at this speed has a round to run after `elapsedMs`. Pure, so the clock rule is one
// function the server and the test both read: speed 0 never becomes due, whatever the elapsed time.
export function speedDue(speed, elapsedMs) {
  const seconds = speedSeconds(speed);
  if (!(seconds > 0)) return false;
  const ms = Math.max(1, Math.round(seconds * 1000));
  const elapsed = Number(elapsedMs);
  return Number.isFinite(elapsed) && elapsed >= ms;
}

// --- per-kind movement (T-004) --------------------------------------------------------------
//
// How many cells a kind may enter in one round. The numbers are stand-ins (config/game.json); the
// manual states only the orderings. `transport` is a land piece that is at sea: p.21 makes it a
// little slower than a warship, and it is still faster than the same piece on foot.
export function moveBlock() {
  return rules().move || {};
}

export function moveValue(key, fallback = null) {
  const entry = moveBlock()[key];
  const value = entry && typeof entry === "object" && Object.hasOwn(entry, "value") ? entry.value : entry;
  return value === undefined || value === null ? fallback : value;
}

export function moveSource(key) {
  const entry = moveBlock()[key];
  const source = entry && typeof entry === "object" ? entry.source : undefined;
  return typeof source === "string" ? source : "";
}

// The rate for a piece. A land unit at sea is a transport; a hull is a warship (the manual's "all
// sea units move at the same rate", p.21), and a submarine is named on its own row so a per-kind
// edit cannot silently give it a transport's pace. The row is called `warship`, not `ship`, because
// `ship` is the retired generic unit kind the repo refuses to let back in (test/nodes/prices.mjs).
export function cellsPerRound(piece) {
  const table = moveValue("cellsPerRound", {}) || {};
  const kind = String((piece && piece.kind) || "");
  let key;
  if (piece && piece.transport === true) key = "transport";
  else if (kind === "submarine") key = "submarine";
  else if (piece && piece.domain === "sea") key = "warship";
  else if (Object.hasOwn(table, kind)) key = kind;
  else key = "infantry";
  const raw = Number(table[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : 1;
}

// Terrain ids that take longer than open ground. From the manual's slowed column, which the
// successor follows: forest (9), mountain (10), jungle (12), polar (13).
//
// T-004 removed shallows (2): it is water, and a land unit never walks on it - the walker boards a
// transport and follows the lanes instead. Keeping it in this set charged a land pace for a cell
// no land piece can stand on (DISPOSITIONS.md, "Terrain id 2").
const SLOW = new Set([9, 10, 12, 13]);
// Wasteland is a blast result and is refused by walkers.
const REFUSED = 14;
// Ocean and lake are transport, and use the same two-beat stand-in as slow ground.
const TRANSPORT = new Set([0, 3]);

// 1 open, 2 slow or transport, -1 refused. The ratio itself was never recovered and stays
// unnamed; this is the archive's own two-beat stand-in.
export function landPace(terrainId) {
  const id = Number(terrainId);
  if (id === REFUSED) return -1;
  if (SLOW.has(id) || TRANSPORT.has(id)) return 2;
  return 1;
}

export function terrainName(id) {
  return TERRAIN[Number(id)] || "unknown";
}

export function isRefused(id) {
  return Number(id) === REFUSED;
}

// Sea walker classes, recovered from the binary's path test.
// Class 0 (transports, land units at sea) may enter ocean, docks and shallows.
// Class 1 (warships) may enter ocean and docks only.
export function seaAccepts(classByte, terrainId) {
  const id = Number(terrainId);
  if (classByte === 0) return id <= 2;
  if (classByte === 1) return id <= 1;
  return false;
}

export function payEvery() {
  return Number(rules().payEvery);
}

// Money is integer millions inside the server. The manual prints billions; the multiplier is a
// tunable so no code file carries a bare 1000. A city pays `money.cityIncome` millions a round.
export function millionsPerBillion() {
  return Number(rules().money?.perBillion);
}

export function cityIncome() {
  return Number(rules().money?.cityIncome);
}

// Whether a capital pays like a city. UNVERIFIED: the manual names only cities, and the code has
// never paid a capital. The flag makes that choice explicit and editable.
export function capitalPays() {
  return rules().money?.capitalPays === true;
}

// A price in integer millions, converted from the manual's billions. A kind with no price has no
// entry at all: undefined, not null, so a caller cannot mistake "unknown" for a free unit.
export function priceOf(kind) {
  const table = rules().prices || {};
  if (!Object.hasOwn(table, kind)) return undefined;
  const billions = Number(table[kind]);
  const factor = millionsPerBillion();
  if (!Number.isFinite(billions) || !Number.isFinite(factor)) return undefined;
  return Math.round(billions * factor);
}

// What an era sells, in the config's order. An era with no roster entry sells nothing rather than
// falling back to a code-side list; the roster is data.
export function rosterFor(era) {
  const table = rules().rosters || {};
  const key = String(era ?? "");
  return Array.isArray(table[key]) ? table[key].map(String) : [];
}

export function sourceOf(path) {
  const sources = rules().sources || {};
  return path.split(".").reduce((node, key) => (node && Object.hasOwn(node, key) ? node[key] : undefined), sources);
}

// Where a bought unit may be placed. Both reaches are stand-ins (see the note in the tunables
// file); this accessor is the only place that reads them, so an edit cannot reach one caller and
// miss another.
export function placementRules() {
  const block = rules().placement || {};
  const zone = Number(block.homeZoneCells);
  const coast = Number(block.coastCells);
  return {
    zone: Number.isFinite(zone) && zone > 0 ? Math.floor(zone) : 8,
    coast: Number.isFinite(coast) && coast > 0 ? Math.floor(coast) : 4,
  };
}

export function sightCells() {
  return Number(rules().sightCells);
}

export function enemyRouteSteps() {
  return Number(rules().enemyRouteSteps);
}

// --- combat block (T-003) -------------------------------------------------------------------
//
// Every number the strength model uses lives in config.combat, and every key there carries its
// own `source` string. A key with a `{ value, source }` shape is read through `combatValue`;
// `combatSource` is what the AC that forbids an unsourced tunable reads back.
export function combatBlock() {
  return rules().combat || {};
}

export function combatKeys() {
  return Object.keys(combatBlock());
}

export function combatValue(key, fallback = null) {
  const entry = combatBlock()[key];
  const value = entry && typeof entry === "object" && Object.hasOwn(entry, "value") ? entry.value : entry;
  return value === undefined || value === null ? fallback : value;
}

export function combatSource(key) {
  const entry = combatBlock()[key];
  const source = entry && typeof entry === "object" ? entry.source : undefined;
  return typeof source === "string" ? source : "";
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// One object per config load, cached against the config object itself. combatRules() is read in
// the hot paths - every piece's strength default, every engagement range - and rebuilding six
// objects per read was measurable in the 1000-room bench. resetRules() makes a new config object,
// so the cache follows an edit without a second key.
const combatCache = new WeakMap();

export function combatRules() {
  const config = rules();
  const cachedCombat = combatCache.get(config);
  if (cachedCombat) return cachedCombat;
  const damage = combatValue("baseDamage", {}) || {};
  const sea = combatValue("seaRangeCells", {}) || {};
  const attrition = combatValue("attritionPerRound", {}) || {};
  const maxStrength = Math.max(1, finiteNumber(combatValue("maxStrength"), 100));
  const built = {
    maxStrength,
    shotEveryRounds: Math.max(1, Math.floor(finiteNumber(combatValue("shotEveryRounds"), 2))),
    baseDamage: Object.fromEntries(Object.entries(damage).map(([kind, value]) => [kind, Math.max(0, finiteNumber(value, 0))])),
    flankMultiplier: Math.max(1, finiteNumber(combatValue("flankMultiplier"), 1)),
    entrenchDamageFactor: finiteNumber(combatValue("entrenchDamageFactor"), 1),
    entrenchRounds: Math.max(0, Math.floor(finiteNumber(combatValue("entrenchRounds"), 0))),
    landEngageCells: Math.max(1, Math.floor(finiteNumber(combatValue("landEngageCells"), 1))),
    seaRangeCells: Object.fromEntries(Object.entries(sea).map(([kind, value]) => [kind, Math.max(0, Math.floor(finiteNumber(value, 0)))])),
    attritionPerRound: Object.fromEntries(Object.entries(attrition).map(([terrain, value]) => [terrain, Math.max(0, finiteNumber(value, 0))])),
    attritionFloor: Math.min(1, Math.max(0, finiteNumber(combatValue("attritionFloor"), 0))),
    repairPerRound: Math.max(0, finiteNumber(combatValue("repairPerRound"), 0)),
    airStrikeLandFactor: Math.min(1, Math.max(0, finiteNumber(combatValue("airStrikeLandFactor"), 0))),
    airStrikeSeaAmount: Math.max(0, finiteNumber(combatValue("airStrikeSeaAmount"), 0)),
    paradropLoss: Math.min(1, Math.max(0, finiteNumber(combatValue("paradropLoss"), 0))),
    bombardFloor: Math.min(1, Math.max(0, finiteNumber(combatValue("bombardFloor"), 0))),
    militiaDamage: Math.max(0, finiteNumber(combatValue("militiaDamage"), 0)),
    pinRounds: Math.max(0, Math.floor(finiteNumber(combatValue("pinRounds"), 0))),
  };
  combatCache.set(config, built);
  return built;
}

// A ranged value for one sea kind. A 0 in the file means "never recovered"; the land range is
// then the floor, so a hull still fights at contact range instead of being unable to shoot.
export function seaRangeFor(kind, combat = null) {
  combat = combat || combatRules();
  const range = combat.seaRangeCells[String(kind)] || 0;
  return range > 0 ? range : combat.landEngageCells;
}

// How much of the config is a stand-in rather than a recovered figure, for the UI and for a
// report. README prose is not a source: this reads only the block.
export function combatUnmeasured() {
  const out = [];
  for (const key of combatKeys()) {
    if (/UNMEASURED|STAND-IN/i.test(combatSource(key))) out.push(key);
  }
  return out;
}


// Opening cash. `startPool[era]` is the player's own side, in billions, recovered from Monitor
// Four on the running original (docs/re/START_MONEY.md); it is not the p.28 "9", which is a
// mid-game snapshot. An era the original never let us read keeps a labelled stand-in in config
// rather than a number invented here, so this function has no fallback but 0.
export function startPool(era) {
  const table = rules().startPool || {};
  const billions = Number(table[String(era)]);
  const factor = millionsPerBillion();
  return Number.isFinite(billions) && Number.isFinite(factor) ? billions * factor : 0;
}

// The opponent's starting-money spinner (Manual p.17: the player may adjust the money the
// OPPONENT begins with, as a handicap). It is a different number from the player's pool - 1942
// starts the player at 50b with the spinner on 030 - so it is stored separately, per era, because
// the default is not constant (010 in 1918, 030 in 1942). 2023 has no spinner: `null`.
export function handicapSpec() {
  const block = rules().handicap || {};
  const min = Number(block.min);
  const max = Number(block.max);
  const step = Number(block.step);
  return {
    unit: String(block.unit || "billion"),
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 999,
    step: Number.isFinite(step) && step > 0 ? step : 1,
    defaults: { ...(block.default || {}) },
  };
}

// The era's spinner default in billions, or null where the original had no spinner.
export function handicapDefault(era) {
  const value = handicapSpec().defaults[String(era)];
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
}

// What the opponent's pool opens at. With a spinner value the opponent gets it; without one the
// opponent gets the same pool the player does (2023, the "large pool" with no handicap).
export function opponentPool(era, spinnerBillions = null) {
  const factor = millionsPerBillion();
  if (spinnerBillions !== null && spinnerBillions !== undefined) {
    const value = Number(spinnerBillions);
    if (Number.isFinite(value) && Number.isFinite(factor)) return value * factor;
  }
  return startPool(era);
}
