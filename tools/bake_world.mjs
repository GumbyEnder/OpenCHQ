// Bake the board into the repo so the public host draws the original's world, not a blank grid.
//
// The rule that kept the extract off the server was about the extract's own files: no TMAP.DAT, no
// WORLD.PIC, no EXE, and no path to any of them. What this writes is a derivation of ours - the
// 320x136 terrain codes, the site list and the decoded glyph atlas - so the live page can paint the
// same world the archive paints, without shipping a byte of the 1990 release.
//
//   node tools/bake_world.mjs
//
// Run it whenever the extract changes. web/test/nodes/bundled_board.mjs fails if the baked copy and
// the extract ever disagree, so a stale bake cannot ship quietly.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boardPayload, fontPayload, resolveDataRoot } from "../web/server/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const outDir = path.join(projectDir, "web", "data");

const root = resolveDataRoot();
if (!root) {
  console.error("BAKE_FAILED: no extract on this machine; the board cannot be re-baked here");
  process.exit(1);
}

const board = boardPayload();
if (!Array.isArray(board.cells) || board.cells.length !== board.width * board.height) {
  console.error("BAKE_FAILED: board payload is missing its cells");
  process.exit(1);
}

// Runs of equal terrain codes. The world is mostly ocean, so this is small and stays readable.
function runs(cells) {
  const out = [];
  let value = cells[0];
  let count = 1;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i] === value) {
      count++;
      continue;
    }
    out.push([value, count]);
    value = cells[i];
    count = 1;
  }
  out.push([value, count]);
  return out;
}

const sourceFiles = ["data/tmap.bin", "data/sites.json", "data/resources_oil.json"];
const hashes = {};
for (const file of sourceFiles) {
  try {
    hashes[file] = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex").slice(0, 16);
  } catch {
    // A missing optional file is not fatal; the hash list just does not carry it.
  }
}

const world = {
  _meta: {
    what: "Derived board: terrain codes, sites and wells, read from the extract by tools/bake_world.mjs",
    not: "This is not the extract. No picture, executable or data file of the 1990 release is shipped.",
    generated: new Date().toISOString(),
    extract: path.basename(path.dirname(root)) + "/" + path.basename(root),
    sha256_16: hashes,
  },
  width: board.width,
  height: board.height,
  stride: board.stride,
  paint: board.paint,
  counts: board.counts,
  terrain: board.terrain,
  capitals: board.capitals,
  sites: board.sites,
  wells: board.wells,
  runEncoding: "terrain:[code,count]* for width*height cells, row-major",
  terrainRuns: runs(board.cells),
};

mkdirSync(outDir, { recursive: true });
const worldPath = path.join(outDir, "world.json");
writeFileSync(worldPath, JSON.stringify(world) + "\n");

const font = fontPayload();
let fontPath = null;
if (font && Array.isArray(font.glyphs) && font.glyphs.length) {
  fontPath = path.join(outDir, "font.json");
  writeFileSync(fontPath, JSON.stringify({
    _meta: {
      what: "Decoded FONTS.CHQ glyph atlas: 6 rows per glyph, 8x6 cell, 92 glyphs from 0x20",
      not: "The bitmap sheet itself is not shipped; these are decoded row bytes.",
      generated: new Date().toISOString(),
    },
    glyphs: font.glyphs,
  }) + "\n");
}

const worldBytes = readFileSync(worldPath).length;
console.log(JSON.stringify({
  wrote: path.relative(projectDir, worldPath),
  bytes: worldBytes,
  runs: world.terrainRuns.length,
  sites: world.sites.length,
  wells: world.wells.length,
  counts: world.counts,
  font: fontPath ? { wrote: path.relative(projectDir, fontPath), bytes: readFileSync(fontPath).length, glyphs: font.glyphs.length } : null,
}, null, 2));
