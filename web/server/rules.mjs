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

// Terrain ids that take longer than open ground. From the manual's slowed column, which the
// successor follows: shallows (2), forest (9), mountain (10), jungle (12), polar (13).
const SLOW = new Set([2, 9, 10, 12, 13]);
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
