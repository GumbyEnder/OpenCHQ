// Node test for PB-242: a sea aim is legal, because NO_REGION + water "belongs to no country".
//
// What breaks if this node is removed: 51.4% of the board (22,383 cells) refuses every nuke with
// NUKE_HOME_UNKNOWN, so a fleet at sea can only be hit by aiming at a coastal cell beside it, and
// the refusal reads to a player as "the map is broken" on half the map. PB-229 shipped that
// fail-closed on purpose and it was right for a comments-only head; the ruling (frodo 8985 §1,
// PM 8991 §2) narrows it to the cells that are genuinely unknown.
//
// The line the ruling draws, and this node is the line:
//   NO_REGION + ocean/docks/shallows  -> legal aim, normal price, hulls in the zone die, no scar
//   NO_REGION + land (all 10 are lake) -> still NUKE_HOME_UNKNOWN, 0 charge, and the refusal says
//                                         WHICH reason and WHICH terrain it read
//   a real region with a missing site row / site / country byte -> still NUKE_HOME_UNKNOWN: that is
//                                         a mapping gap, not "belongs to no country"
//   the firer's own home country        -> still NUKE_HOME_COUNTRY (untouched by this ticket)
//
// `docks` is in the water set (board TERRAIN 0-2 are ocean, docks, shallows) but this board has no
// docks cell at all, so the two arms that can run are ocean and shallows; the set is the SAME one
// wastelandCells() skips, so a cell that would be painted land is never the cell we call sea.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, TERRAIN } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { priceOf, resetRules, rules } from "../../server/rules.mjs";
import { useTool } from "../../server/late.mjs";
import {
  NUKE_HOME_COUNTRY, NUKE_HOME_UNKNOWN, cellCountry, homeCountriesOf, nukeTarget, resolvedCapitals,
} from "../../server/nukestrike.mjs";
import { NO_REGION, regionAt, regionSites } from "../../server/territory.mjs";

export const name = "pb242_sea_aim";

const WATER = new Set(["ocean", "docks", "shallows"]);
const CELL_W = 320;

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function must(ok, message) {
  if (!ok) fail(message);
}

// The same config swap the other nuke nodes use: the shipped file keeps nukes off, so a node that
// fires one turns the block on and puts the file back.
function withNukes(on, patch = {}) {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.nukes = { ...(custom.nukes || {}), enabled: on };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete custom.nukes[key];
    else custom.nukes[key] = value;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pb242-"));
  const file = path.join(dir, "game.json");
  writeFileSync(file, JSON.stringify(custom, null, 2));
  const previous = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = file;
  resetRules();
  return () => {
    if (previous === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = previous;
    resetRules();
    rmSync(dir, { recursive: true, force: true });
  };
}

function terrainAt(cells, x, y) {
  const id = cells[Number(y) * CELL_W + (((Number(x) % CELL_W) + CELL_W) % CELL_W)];
  return id === undefined || id === null ? null : TERRAIN[Number(id)] || null;
}

function piece(id, side, kind, x, y, domain = "sea", strength = 100) {
  return { id, side, kind, x, y, domain, path: [], pace: 1, strength };
}

function fixture() {
  const payload = boardPayload();
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  return { match, payload };
}

// A NO_REGION cell of one terrain class, outside every capital ring (so the ring refusal cannot
// preempt the branch under test) and with a full kill square on the board.
function noRegionCell(match, payload, wanted) {
  const capitals = resolvedCapitals(match).list;
  const ring = Number(rules().nukes.exclusion);
  const margin = 3;
  for (let y = margin; y < 136 - margin; y += 1) {
    for (let x = margin; x < CELL_W - margin; x += 1) {
      if (regionAt(x, y) !== NO_REGION) continue;
      const t = terrainAt(payload.cells, x, y);
      if (!wanted(t)) continue;
      let near = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= ring && Math.abs(cap.y - y) <= ring) near = true;
      }
      if (near) continue;
      return { x, y, terrain: t };
    }
  }
  return null;
}

// A named land cell outside every ring and outside Blue's home country - the control for arms that
// must keep refusing, and the spot a mapping-gap fixture is built on.
function landCellCountry(match, payload) {
  const home = homeCountriesOf(match, "blue") || new Set();
  const capitals = resolvedCapitals(match).list;
  const ring = Number(rules().nukes.exclusion);
  for (let y = 3; y < 133; y += 1) {
    for (let x = 3; x < 317; x += 1) {
      const t = terrainAt(payload.cells, x, y);
      if (!t || WATER.has(t)) continue;
      let near = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= ring && Math.abs(cap.y - y) <= ring) near = true;
      }
      if (near) continue;
      const here = cellCountry(match, x, y);
      if (!here || here.country === null) continue;
      if (home.has(here.country)) continue;
      return { x, y, terrain: t, country: here.country, region: here.region };
    }
  }
  return null;
}

export async function run(ctx) {
  const restore = withNukes(true);
  try {
    let payload;
    try {
      payload = boardPayload();
      must(Boolean(payload && payload.cells), "the board has no terrain grid");
    } catch (err) {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }

    // --- 0. the three classes exist, so no arm below can pass by finding nothing ---------------
    {
      const { match } = fixture();
      const ocean = noRegionCell(match, payload, (t) => t === "ocean");
      const shallows = noRegionCell(match, payload, (t) => t === "shallows");
      const lake = noRegionCell(match, payload, (t) => t === "lake");
      must(Boolean(ocean), "no NO_REGION ocean cell outside every capital ring - the census changed");
      must(Boolean(shallows), "no NO_REGION shallows cell outside every capital ring - the census changed");
      must(Boolean(lake), "no NO_REGION lake cell outside every capital ring - the census changed");
      must(!WATER.has(lake.terrain), "the lake fixture reads as water, so it is not the land residue");

      // --- 1. a sea aim is legal, and it costs the normal price --------------------------------
      const { match: seaMatch } = fixture();
      const aim = nukeTarget(seaMatch, "blue", { x: ocean.x, y: ocean.y });
      if (aim.error) fail("an ocean aim was refused: " + aim.error);
      eq("an ocean aim resolves to the aimed cell", aim.cell, { x: ocean.x, y: ocean.y });
      eq("the aim says it was allowed as water", aim.water, true);
      eq("the aim names the terrain it read", aim.terrain, "ocean");

      const cash = seaMatch.sides.blue.cash;
      const fired = useTool(seaMatch, "blue", "nuke", { x: ocean.x, y: ocean.y });
      if (fired.error) fail("a legal sea launch was refused by the tool: " + fired.error);
      eq("a sea launch costs the manual's price", cash - seaMatch.sides.blue.cash, priceOf("nuke"));
      const event = (fired.events || []).find((e) => e.type === "nuke");
      must(Boolean(event), "a sea strike produced no nuke event");
      eq("the event lands where the aim pointed", { x: event.x, y: event.y }, { x: ocean.x, y: ocean.y });
      eq("the event charges what was spent", event.cost, priceOf("nuke"));

      // --- 1b. shallows are water too, not a land cell with a wet name -------------------------
      const { match: shallowMatch } = fixture();
      const shallowAim = nukeTarget(shallowMatch, "blue", { x: shallows.x, y: shallows.y });
      if (shallowAim.error) fail("a shallows aim was refused: " + shallowAim.error);
      eq("the shallows aim names the terrain it read", shallowAim.terrain, "shallows");
    }

    // --- 2. a lake still refuses, and the refusal says why -------------------------------------
    {
      const { match } = fixture();
      const lake = noRegionCell(match, payload, (t) => t === "lake");
      const cash = match.sides.blue.cash;
      const refused = useTool(match, "blue", "nuke", { x: lake.x, y: lake.y });
      eq("a lake aim is still refused", refused.error, NUKE_HOME_UNKNOWN);
      eq("the lake refusal names the reason", refused.reason, "no region");
      eq("the lake refusal names the terrain, so it is not a bare failure", refused.terrain, "lake");
      eq("a refused lake aim costs nothing", match.sides.blue.cash, cash);
      eq("a refused lake aim places no strike", (match.pieces || []).length, 0);

      // The same shape through the aim function, so a caller that reads nukeTarget directly sees it.
      const aimed = nukeTarget(match, "blue", { x: lake.x, y: lake.y });
      eq("the aim function refuses the lake too", aimed.error, NUKE_HOME_UNKNOWN);
      eq("the aim function carries the terrain", aimed.terrain, "lake");
    }

    // --- 3. a hull inside the ring of a water aim dies, and the sea is not painted ------------
    {
      const { match } = fixture();
      const ocean = noRegionCell(match, payload, (t) => t === "ocean");
      const victim = { x: ocean.x + 2, y: ocean.y };
      match.pieces = [piece("sea-1", "red", "submarine", victim.x, victim.y)];
      const fired = useTool(match, "blue", "nuke", { x: ocean.x, y: ocean.y });
      if (fired.error) fail("the sea strike was refused: " + fired.error);
      eq("the submarine two cells from a sea aim dies", (match.pieces || []).map((p) => p.id), []);
      const event = (fired.events || []).find((e) => e.type === "nuke");
      eq("the event lists the submarine as killed", (event.killed || []).map((p) => p.id), ["sea-1"]);

      const painted = event.wasteland || [];
      const wet = painted.filter((key) => {
        const [px, py] = key.split(",").map(Number);
        const t = terrainAt(payload.cells, px, py);
        return t !== null && WATER.has(t);
      });
      eq("a sea strike paints no water cell", wet, []);
      must(painted.length > 0, "a sea strike painted nothing at all - the land in the square was skipped");
      const dry = painted.filter((key) => {
        const [px, py] = key.split(",").map(Number);
        const t = terrainAt(payload.cells, px, py);
        return t !== null && !WATER.has(t);
      });
      eq("every painted cell in a sea strike is land", painted.length, dry.length);
      must(!(match.wasteland || []).includes(ocean.x + "," + ocean.y), "the aim cell itself was painted");
    }

    // --- 4. a mapping gap is not water: the relaxation is NO_REGION + water, nothing wider ----
    {
      const { match } = fixture();
      const spot = landCellCountry(match, payload);
      must(Boolean(spot), "no named land cell outside every ring for the mapping-gap arm");
      const wantedId = regionSites("1986")[spot.region];
      let site = (match.sites || []).find((place) => String(place.id) === String(wantedId));
      if (!site) {
        site = { id: wantedId, kind: "city", name: "no-country fixture", x: spot.x, y: spot.y, owner: "red", country_id: null };
        match.sites.push(site);
      } else {
        site.country_id = null;
      }
      must(cellCountry(match, spot.x, spot.y).country === null, "the no-country fixture still answers a country");
      const cash = match.sides.blue.cash;
      const refused = useTool(match, "blue", "nuke", { x: spot.x, y: spot.y });
      eq("a real region with no country byte still refuses", refused.error, NUKE_HOME_UNKNOWN);
      eq("the mapping-gap refusal names its own reason", refused.reason, "no country byte");
      eq("the mapping-gap refusal costs nothing", match.sides.blue.cash, cash);
      const aimed = nukeTarget(match, "blue", { x: spot.x, y: spot.y });
      eq("the aim function refuses the mapping gap", aimed.error, NUKE_HOME_UNKNOWN);
      eq("the mapping gap carries no water claim", aimed.water, undefined);
    }

    // --- 5. the firer's own home ground is untouched by the relaxation ------------------------
    {
      const { match } = fixture();
      const home = homeCountriesOf(match, "blue");
      must(home && home.size, "Blue's home set did not resolve");
      const capitals = resolvedCapitals(match).list;
      const ring = Number(rules().nukes.exclusion);
      let spot = null;
      for (let y = 3; y < 133 && !spot; y += 1) {
        for (let x = 3; x < 317 && !spot; x += 1) {
          const t = terrainAt(payload.cells, x, y);
          if (!t || WATER.has(t)) continue;
          let near = false;
          for (const cap of capitals) {
            if (Math.abs(cap.x - x) <= ring && Math.abs(cap.y - y) <= ring) near = true;
          }
          if (near) continue;
          const here = cellCountry(match, x, y);
          if (here && here.country !== null && home.has(here.country)) spot = { x, y, country: here.country };
        }
      }
      must(Boolean(spot), "no home-country land cell outside every ring");
      const refused = nukeTarget(match, "blue", { x: spot.x, y: spot.y });
      eq("the firer's own home ground still refuses", refused.error, NUKE_HOME_COUNTRY);
      eq("the home refusal names the country", refused.country, spot.country);
    }
  } finally {
    restore();
  }
}
