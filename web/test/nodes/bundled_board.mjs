// Node bundled_board: the map the public host draws is the original's map, not a blank grid.
//
// The board has to come from somewhere on a host that has no extract. web/data/world.json is that
// somewhere: the same 320x136 terrain codes and the same sites, derived from the archive once and
// committed. This test is the guard against the bake going stale behind the extract - if the two
// ever disagree, the live game is painting a world the archive never had.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boardPayload, bundledBoard, fontPayload } from "../../server/board.mjs";

export const name = "bundled_board";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..", "..", "..");

export async function run(ctx) {
  const { fail } = ctx;

  const baked = bundledBoard();
  if (!baked) fail("web/data/world.json is missing or unreadable, so the public host has no map");
  if (baked.source !== "bundled") fail("the baked board reports source " + baked.source);
  if (baked.cells.length !== baked.width * baked.height) {
    fail("the baked board is not " + baked.width + "x" + baked.height + ": " + baked.cells.length + " cells");
  }
  if (baked.paint === "schematic") fail("the baked board would still paint the schematic");

  // The world is not a flat colour: if it were, the render would be a blank grid again.
  const seen = new Set(baked.cells);
  if (seen.size < 6) fail("the baked board carries only " + seen.size + " terrain codes");
  if (!baked.sites.length) fail("the baked board has no sites, so no cities and no economy");
  if (!baked.wells.length) fail("the baked board has no oil wells");
  if (!baked.capitals || !baked.capitals.blue || !baked.capitals.red) fail("the baked board has no capitals");

  // Against the extract, cell for cell, site for site: a stale bake is a lie the page cannot show.
  const live = boardPayload();
  if (live.source === "extract") {
    let firstDiff = -1;
    for (let i = 0; i < live.cells.length; i++) {
      if (live.cells[i] !== baked.cells[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff !== -1) {
      const x = firstDiff % live.width;
      const y = Math.floor(firstDiff / live.width);
      fail("the baked board differs from the extract at " + x + "," + y + " (" + baked.cells[firstDiff] + " vs " + live.cells[firstDiff] + ")");
    }
    if (baked.sites.length !== live.sites.length) {
      fail("the baked board has " + baked.sites.length + " sites, the extract has " + live.sites.length);
    }
    for (let i = 0; i < live.sites.length; i++) {
      const a = baked.sites[i];
      const b = live.sites[i];
      const key = (s) => [s.id, s.name, s.x, s.y, s.kind, s.country_id].join("|");
      if (key(a) !== key(b)) fail("site " + i + " differs: " + key(a) + " vs " + key(b));
    }
    if (baked.wells.length !== live.wells.length) {
      fail("the baked board has " + baked.wells.length + " wells, the extract has " + live.wells.length);
    }
    if (JSON.stringify(baked.counts) !== JSON.stringify(live.counts)) {
      fail("the baked counts differ: " + JSON.stringify(baked.counts) + " vs " + JSON.stringify(live.counts));
    }
  }

  // The terrain runs have to cover exactly one board and no more.
  const file = path.join(projectDir, "web", "data", "world.json");
  const world = JSON.parse(readFileSync(file, "utf8"));
  const total = world.terrainRuns.reduce((sum, run) => sum + run[1], 0);
  if (total !== baked.width * baked.height) fail("the terrain runs cover " + total + " cells, not " + baked.width * baked.height);
  if (!world._meta || !world._meta.not) fail("the baked file does not say what it is not");

  // The original's lettering has to survive the same trip, or the live chrome is a system font.
  const font = fontPayload();
  if (!Array.isArray(font.glyphs) || font.glyphs.length !== 92) {
    fail("the live font atlas has " + (font.glyphs ? font.glyphs.length : 0) + " glyphs, expected 92");
  }
  return { cells: baked.cells.length, codes: seen.size, sites: baked.sites.length, wells: baked.wells.length };
}
