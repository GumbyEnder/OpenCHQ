// pb349b_docks_rate — PB-349's D10 carve-out: a piece on real DOCKS ground paid no attrition.
//
// What fails if this node is removed:
//   - config's attritionPerRound loses the terrain-name key and keeps only the site KIND
//     spelling ("dock"), so a piece standing on a docks cell takes 0 and the 1986 campaign's
//     150 ownerless dock sites drain nothing                   -> exempts_on_real_ground reds
//   - the rate lookup starts reading the site kind instead of the terrain name
//                                                              -> terrain_name_is_the_key reds
//   - the D10 site branch stops draining an unowned site row    -> unowned_site_row reds
//
// The point of this file is the SEAM. PB-349's own D10 arms in combat_vs_doc build the terrain
// with `(p) => "city"`, so no arm ever asked the real grid for a docks cell, and 9/9 mutants
// passed while the campaign board paid nothing. This arm asks the grid: the coordinate comes from
// boardPayload().cells (the extract), and attritionStep is called with NO lookup.
//
// Skip reachability (NIT-1, frodo 10587): skips when no board resolves at all, bundled included.
// An absent extract does NOT skip it - boardPayload() falls through to the baked world and this
// node grades that real board, so the suite must read it green there, never "skipped".
//
// frodo's probe (room 10579) found 33/36 rows; the three reds were these.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CELL_W, TERRAIN, boardPayload } from "../../server/board.mjs";
import { attritionStep, terrainNameAt } from "../../server/move.mjs";

export const name = "pb349b_docks_rate";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, "..", "..", "..", "config", "game.json");

export function run() {
  const fail = (message) => {
    throw new Error(message);
  };
  const must = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(message + ": " + a + " !== " + b);
  };
  const skip = (reason) => {
    const error = new Error(reason);
    error.skip = true;
    throw error;
  };
  const piece = (x, y, strength = 100) => ({ id: "blue:foot", side: "blue", kind: "infantry", x, y, strength });

  const docksId = TERRAIN.indexOf("docks");
  must(docksId >= 0, "board.mjs TERRAIN no longer names a docks id");

  // The first docks cell on the shipped board, found the way the runtime finds terrain - from the
  // published payload, not from a lambda.
  let payload = null;
  try {
    payload = boardPayload();
  } catch (err) {
    skip("no extract: boardPayload() failed (" + (err && err.message ? err.message : err) + ")");
  }
  if (!payload || !Array.isArray(payload.cells)) skip("no extract: boardPayload() has no cells");
  let docks = null;
  for (let index = 0; index < payload.cells.length; index += 1) {
    if (Number(payload.cells[index]) !== docksId) continue;
    docks = { x: index % CELL_W, y: Math.floor(index / CELL_W) };
    break;
  }
  if (!docks) skip("the board carries no docks cell, so this arm has nothing to grade");

  // Arm 1: the terrain name is the key the runtime reads.
  eq(terrainNameAt(docks.x, docks.y), "docks",
    "the runtime calls terrain id " + docksId + " by its name, not \"dock\"");

  // Arm 2: config carries that exact name, and the site KIND spelling stays for the site branch.
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const block = config && config.combat && config.combat.attritionPerRound;
  must(block && block.value, "config/game.json carries no combat.attritionPerRound.value");
  const rates = block.value;
  must(Object.prototype.hasOwnProperty.call(rates, "docks"),
    "attritionPerRound has no `docks` key, so a piece on real docks ground matches no rate (keys: " +
    JSON.stringify(Object.keys(rates)) + ")");
  eq(rates.docks, rates.dock, "attritionPerRound.docks must equal attritionPerRound.dock - one rate, two spellings");
  must(rates.docks > 0, "attritionPerRound.docks is " + rates.docks + ", which still exits at rate <= 0");
  const source = String(block.source || "");
  must(/terrain name/i.test(source), "attritionPerRound's source no longer says the key is the TERRAIN NAME");
  must(/site kind/i.test(source), "attritionPerRound's source no longer warns that `dock` is the site KIND");

  // Arm 3: on the REAL grid, with no lookup seam, a non-owner piece on that cell drains.
  const walker = piece(docks.x, docks.y, 100);
  const events = attritionStep({ round: 1, pieces: [walker], sites: [] });
  const drain = events.find((event) => event.type === "attrition" && event.pieceId === "blue:foot");
  must(drain, "a piece on docks ground at " + docks.x + "," + docks.y + " took no attrition event (rate " +
    rates.docks + ")");
  eq(walker.strength, 100 - rates.docks,
    "a piece on docks ground drains by the configured rate at " + docks.x + "," + docks.y);
  eq(drain.terrain, "docks", "the event names the terrain it charged: docks");

  // Arm 4: the D10 site branch also runs on docks - the 1986 board's 150 dock sites are all
  // ownerless, and a no-owner row must pay exactly like a city row with no owner.
  const unowned = piece(docks.x, docks.y, 100);
  const unownedSites = [{ id: 900, name: "Dockside", kind: "dock", owner: null, x: docks.x, y: docks.y }];
  attritionStep({ round: 1, pieces: [unowned], sites: unownedSites });
  eq(unowned.strength, 100 - rates.docks,
    "an UNOWNED dock site row drains at " + docks.x + "," + docks.y + " (the 1986 campaign's 150 rows)");

  // Arm 5: and an own dock site is still exempt - D10 exempts the site the piece OWNS.
  const own = piece(docks.x, docks.y, 100);
  attritionStep({ round: 1, pieces: [own], sites: [{ id: 901, name: "Dockside", kind: "dock", owner: "blue", x: docks.x, y: docks.y }] });
  eq(own.strength, 100, "an OWN dock site is exempt, so docks ground must not drain the owner");
}
