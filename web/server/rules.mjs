// Rules the whole server shares: the tunables file, and the terrain facts that come from
// the archive rather than from tuning. Loaded once per process. No module may hard-code a
// round length, a price, a sight radius or a terrain cost; read it from here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TERRAIN } from "./board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.OPENCHQ_CONFIG || path.resolve(here, "..", "..", "config", "game.json");

let cached = null;

export function rules() {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return cached;
}

export function resetRules() {
  cached = null;
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

export function sightCells() {
  return Number(rules().sightCells);
}

export function enemyRouteSteps() {
  return Number(rules().enemyRouteSteps);
}

// The archive's HITS: how many shots in one continuous fight remove the defender.
// See docs/POLISH_LOOP.md - it is a stand-in fight, not a damage model.
export function hitsToKill() {
  const value = Number(rules().hits);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Overrun. The owner's own list of what combat is missing names overrun, so the archive had it;
// how much more force it took was never recovered. The rule used here invents no number: the
// attacker overruns when it has strictly more friendly pieces on the defender's cell than the
// defender has - a comparison a player can count on the screen.
export function overrunEnabled() {
  return rules().overrun !== false;
}

export function priceOf(kind) {
  const table = rules().prices || {};
  return Object.hasOwn(table, kind) ? Number(table[kind]) : null;
}

export function startPool(era) {
  const table = rules().startPool || {};
  return String(era) === "2023" ? Number(table["2023"]) : Number(table.early);
}
