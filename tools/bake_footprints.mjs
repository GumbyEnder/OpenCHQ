#!/usr/bin/env node
// Bake web/data/footprints.json from the MEASURED painted set (D-026, T-026; PM ruling 2026-11-14
// 20:20 ET, option (a): "Measure the painter first. Bake footprints.json from the measured painted
// set ... and keep the bake derived cells only. Nothing from the original goes in the repo.").
//
// The input is a measured artifact that lives OUTSIDE the repo:
//
//   OPENCHQ_FOOTPRINT_DUMP=<path to the measured footprints json>
//
// produced by /mnt/nas/host-ops/openchq/t026/t026-measured-footprints.py from a live dump of the
// original's runtime tile map (t026-map-dump.py, /proc/<dosbox>/mem). That script measures what
// FUN_20b1_1a24 (decompiled.c:13935-13975) and FUN_20b1_1b42 (13981-14179) actually paint instead
// of re-implementing the shape code, and translates the painted cells into the site-record frame by
// the MEASURED painter offset (2, 0) — block centre = site record + 2 in x, 64 of 64 city-kind
// sites in the dump.
//
// There is no geometric fallback here on purpose: a bake that re-derives the shape is exactly what
// the measurement replaced. A missing dump is a hard failure.
//
// usage: OPENCHQ_FOOTPRINT_DUMP=/path/measured.json node tools/bake_footprints.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const dumpPath = process.env.OPENCHQ_FOOTPRINT_DUMP || "";
const outFile = path.join(projectDir, "web", "data", "footprints.json");

if (!dumpPath) {
  console.error("BAKE_REFUSED: OPENCHQ_FOOTPRINT_DUMP is unset — the footprint list is measured, " +
    "not derived, so there is no fallback to build. See the header of this file.");
  process.exit(2);
}

const measured = JSON.parse(readFileSync(dumpPath, "utf8"));
const meta = measured._meta || {};
const sites = measured.sites || {};

const out = {};
for (const id of Object.keys(sites).sort((a, b) => Number(a) - Number(b))) {
  const row = sites[id];
  if (!Array.isArray(row.cells) || !row.cells.length) {
    console.error("BAKE_REFUSED: site " + id + " (" + row.name + ") has no measured cells");
    process.exit(2);
  }
  out[id] = row.cells.map(([x, y]) => [Number(x), Number(y)]);
}

const world = JSON.parse(readFileSync(path.join(projectDir, "web", "data", "world.json"), "utf8"));
const payload = {
  _meta: {
    task: "T-026 / D-026",
    source: "MEASURED painted set from the live original's runtime tile map — not a re-derivation",
    method: meta.method || "",
    dump: meta.dump || dumpPath,
    era: meta.era,
    side: meta.side,
    measured: meta.date || "",
    pid: meta.pid,
    painter: "FUN_20b1_1a24 @ 20b1:1a24 (centre), FUN_20b1_1b42 @ 20b1:1b42 (ring), decompiled.c:13935-14179",
    frame: "cells are in the SITE-RECORD frame: the painter writes at record + (2,0), measured on " +
      "every city-kind site in the dump. The remake's own painter draws at the site cell, so the " +
      "baked list is the painted set translated back by the measured offset.",
    exclusions: "none. A cell the original's placement check refused is NOT removed here — see " +
      "placement.footprint.deviation in config/game.json for the one measured case (Washington 80,44).",
    kinds: "city, capital, base carry a painted block; a facility has no painted city terrain and " +
      "keeps its own cell (config placement.footprint.kinds)",
  },
  width: Number(world.width),
  height: Number(world.height),
  sites: out,
};
writeFileSync(outFile, JSON.stringify(payload, null, 1) + "\n");
const sizes = {};
for (const cells of Object.values(out)) sizes[cells.length] = (sizes[cells.length] || 0) + 1;
console.log("wrote " + path.relative(projectDir, outFile) + ": " + Object.keys(out).length +
  " measured sites, sizes " + JSON.stringify(sizes));
