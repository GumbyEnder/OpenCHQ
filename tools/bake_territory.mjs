// Bake the per-era territory model into the repo: region geometry plus region -> site per era.
//
//   node tools/bake_territory.mjs
//
// Two sources, both of them facts read out of the 1990 data files (docs/re/REGIONS.md has the full
// layout and the checks that pinned it):
//
//   REGIONS.DAT          184 records x 20 bytes. Ten big-endian uint16 per record read as five
//                        (x, y) points: the record's own label point first, then the four corners of
//                        the quad that covers the region. Point 0 is the label; points 1..4 are the
//                        fill. Coordinates are cells on the 320x136 board.
//   data/cbr_region_by_era.json (extract)   184 entries per era: which site id holds each region.
//                        Site owners per era are already in web/data/eras.json (CBR-TYPE.DTn).
//
// What is written is a derivation, not the file: a region id, its four corners, its label point, the
// cell -> region raster, and a region -> site index per era. No original byte, no OMAP.PIC, no
// picture of the map. Same contract as tools/bake_world.mjs: BAKE_FAILED when a source is missing,
// and _meta.generated is pinned to the source hash so a re-run is byte-identical.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boardPayload, resolveDataRoot } from "../web/server/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const outFile = path.join(projectDir, "web", "data", "territory.json");

const W = 320;
const H = 136;
const REGION_COUNT = 184;
const NO_REGION = 255;

function fail(why) {
  console.error("BAKE_FAILED: " + why);
  process.exit(1);
}

// The region file is the 1990 release's own REGIONS.DAT, which never enters the repo. It is looked
// for in the usual places the rest of the tooling uses: an env var, a gitignored pointer file, then
// the extract's neighbour and the two lab copies.
function chqRoot(env = process.env) {
  const tries = [];
  if (env.OPENCHQ_CHQ) tries.push(env.OPENCHQ_CHQ);
  const pointer = path.join(projectDir, "local", "chq_root.txt");
  if (existsSync(pointer)) {
    for (const line of readFileSync(pointer, "utf8").split("\n")) {
      const text = line.trim();
      if (text && !text.startsWith("#")) tries.push(text);
    }
  }
  tries.push("../Command HQ/COMMAND");
  tries.push("/mnt/nas/Projects/Command HQ/COMMAND");
  tries.push("/home/gumbyender/Games/CHQ");
  tries.push("K:/Projects/Command HQ/COMMAND");
  for (const attempt of tries) {
    const clean = String(attempt).trim().replace(/\\/g, "/");
    for (const dir of clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)
      ? [clean] : [path.resolve(projectDir, clean)]) {
      if (existsSync(path.join(dir, "REGIONS.DAT"))) return dir;
    }
  }
  return "";
}

function readRegions(file) {
  const raw = readFileSync(file);
  if (raw.length !== REGION_COUNT * 20) fail(`REGIONS.DAT is ${raw.length} bytes, expected ${REGION_COUNT * 20}`);
  const out = [];
  for (let i = 0; i < REGION_COUNT; i++) {
    const base = i * 20;
    const pts = [];
    for (let k = 0; k < 5; k++) pts.push([raw.readUInt16BE(base + k * 4), raw.readUInt16BE(base + k * 4 + 2)]);
    for (const [x, y] of pts) {
      if (x >= W || y >= H) fail(`region ${i} point (${x},${y}) is off the ${W}x${H} board`);
    }
    out.push({ id: i, label: pts[0], quad: pts.slice(1) });
  }
  return out;
}

// Even-odd point-in-quad on cell centres. The four corners are stored in no particular order, so a
// crossing test is used rather than a winding assumption.
function inside(x, y, quad) {
  let hit = false;
  for (let i = 0, n = quad.length; i < n; i++) {
    const [x1, y1] = quad[i];
    const [x2, y2] = quad[(i + 1) % n];
    if ((y1 > y) !== (y2 > y) && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) hit = !hit;
  }
  return hit;
}

// cell -> region, flat row-major. A cell belongs to the first quad whose box and crossing test
// accept it. Running the raster here (not in the page) keeps the client to a lookup per cell.
function raster(regions) {
  const grid = new Uint8Array(W * H).fill(NO_REGION);
  const boxes = regions.map((r) => {
    const xs = r.quad.map((p) => p[0]);
    const ys = r.quad.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  let filled = 0;
  for (let rid = 0; rid < regions.length; rid++) {
    const [x0, y0, x1, y1] = boxes[rid];
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        const at = y * W + x;
        if (grid[at] !== NO_REGION) continue;
        if (inside(x + 0.5, y + 0.5, regions[rid].quad)) {
          grid[at] = rid;
          filled += 1;
        }
      }
    }
  }
  return { grid, filled };
}

// The quads cover 12200 of the board's 14612 land cells; the rest are coasts and islands the 1990
// file's four corners do not reach. Those cells still belong to the country around them, so every
// land cell with no quad is handed to the nearest region that has one (multi-source BFS, 4-neigh,
// X wrap). Ocean keeps NO_REGION: "is this cell friendly territory?" must answer false at sea.
function fillLandGaps(grid, land, width, height) {
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] !== NO_REGION) queue[tail++] = i;
  const seen = grid.slice();
  let filled = 0;
  while (head < tail) {
    const at = queue[head++];
    const x = at % width;
    const y = (at - x) / width;
    const owner = seen[at];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (y + dy < 0 || y + dy >= height) continue;
      const nx = ((x + dx) % width + width) % width;
      const next = (y + dy) * width + nx;
      if (seen[next] !== NO_REGION || !land[next]) continue;
      seen[next] = owner;
      grid[next] = owner;
      filled += 1;
      queue[tail++] = next;
    }
  }
  return filled;
}

// Runs of equal region ids, row-major, the same shape world.json uses for terrain.
function runs(grid) {
  const out = [];
  let value = grid[0];
  let count = 1;
  for (let i = 1; i < grid.length; i++) {
    if (grid[i] === value) {
      count += 1;
    } else {
      out.push([value, count]);
      value = grid[i];
      count = 1;
    }
  }
  out.push([value, count]);
  return out;
}

const root = resolveDataRoot();
if (!root) fail("no extract on this machine; the era table cannot be read");
const eraFile = path.join(root, "data", "cbr_region_by_era.json");
if (!existsSync(eraFile)) fail("data/cbr_region_by_era.json is missing from the extract");

const chq = chqRoot();
if (!chq) fail("no REGIONS.DAT found; set OPENCHQ_CHQ to the 1990 COMMAND directory");
const regionsPath = path.join(chq, "REGIONS.DAT");

const regions = readRegions(regionsPath);
const board = boardPayload();
const terrain = Array.isArray(board && board.terrain) ? board.terrain : [];
const WATER = new Set(["ocean", "shallows", "lake"]);
const land = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const name = board && Array.isArray(board.cells) ? terrain[board.cells[i]] : null;
  land[i] = name && !WATER.has(name) ? 1 : 0;
}
const { grid, filled: quadCells } = raster(regions);
const filled = quadCells + fillLandGaps(grid, land, W, H);
const byEraRaw = JSON.parse(readFileSync(eraFile, "utf8"));

// Era labels in the order eras.json uses, with the file row each one reads.
const ERA_ROWS = [
  { label: "1918", fileEra: 0 },
  { label: "1942", fileEra: 1 },
  { label: "1986", fileEra: 2 },
  { label: "2023", fileEra: 3 },
];
const byEra = {};
for (const row of ERA_ROWS) {
  const list = byEraRaw[String(row.fileEra)];
  if (!Array.isArray(list) || list.length !== REGION_COUNT) fail(`era row ${row.fileEra} is not ${REGION_COUNT} entries`);
  byEra[row.label] = list.map((v) => (Number(v) >= 84 ? null : Number(v)));
}

// Deliberate political donor, not a recovered rule: the Concealed ("9999") campaign is played on the
// 2023 territory map, so its region -> site row IS the 2023 row. Whether the 1990 original does the
// same is UNVERIFIED (no CBR-REGN row for the hidden era has been dumped); this is a remake choice
// recorded in the room. The row indexes the 84-site roster (world.json / sites.json), not the
// 271-name table - the same ids the ERA_ROWS loop clamps with Number(v) >= 84 -> null. Do not grow a
// fifth ERA_ROWS entry for it: there is no file row behind it, only the donor above.
byEra["9999"] = byEra["2023"];


const sourceHash = createHash("sha256")
  .update(readFileSync(regionsPath))
  .update(readFileSync(eraFile))
  .digest("hex")
  .slice(0, 16);

const payload = {
  _meta: {
    what: "Per-era territory: 184 regions as four-corner quads plus a label point, the cell -> region raster, and region -> site id per era",
    not: "This is a derivation of the 1990 data files, not the files. REGIONS.DAT, OMAP.PIC and the CBR-REGN.DTn text arrays are not in the repo and are not redistributed. There is no picture of the map here, only ids and coordinates.",
    layout: "REGIONS.DAT: 184 records x 20 bytes; ten big-endian uint16 per record = five (x, y) cell points, label first then the four quad corners. docs/re/REGIONS.md.",
    generated: "pinned to source sha256_16 " + sourceHash,
    sha256_16: sourceHash,
    regionCount: REGION_COUNT,
    filledCells: filled,
    quadCells,
    landCells: land.reduce((n, v) => n + v, 0),
  },
  width: W,
  height: H,
  noRegion: NO_REGION,
  regions: regions.map((r) => ({ id: r.id, label: r.label, quad: r.quad })),
  runEncoding: "[regionId,count]* row-major, width*height cells",
  regionRuns: runs(grid),
  byEra,
};

writeFileSync(outFile, JSON.stringify(payload, null, 1) + "\n");
console.log(`regions ${REGION_COUNT}, raster ${filled}/${W * H} cells, eras ${Object.keys(byEra).join(",")}`);
console.log("wrote " + path.relative(projectDir, outFile));
