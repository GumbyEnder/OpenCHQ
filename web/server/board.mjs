import { existsSync, readFileSync } from "node:fs";
import { applyEra } from "./era.mjs";
import { sightCells } from "./rules.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cell grid. X wraps, Y does not. Rows are packed nibbles with a 162 byte stride
// (324 nibbles, so the last four nibbles of every row are padding).
export const CELL_W = 320;
export const CELL_H = 136;
export const ROW_STRIDE = 162;

// Terrain ids in order. The archive's terrain_map.gd uses the same table.
export const TERRAIN = [
  "ocean",
  "docks",
  "shallows",
  "lake",
  "capital",
  "base",
  "city",
  "oilfield",
  "plain",
  "forest",
  "mountain",
  "desert",
  "jungle",
  "polar",
  "wasteland",
  "facility",
];

const PAINT_CENTER = {
  capital: 4,
  base: 5,
  city: 6,
  oilfield: 7,
  plain: 8,
  forest: 9,
  facility: 15,
};

const PAINT_NEIGHBORS = { capital: true, base: true, city: true };

// The two capitals are fixed seats. They are available even when the extract is
// missing, so the page can draw its schematic without any file on disk.
export const SEATS = {
  blue: { name: "Washington", x: 79, y: 44 },
  red: { name: "Moscow", x: 183, y: 25 },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..", "..");

function usable(dir) {
  if (!dir) return false;
  return existsSync(path.join(dir, "data", "tmap.bin")) &&
    existsSync(path.join(dir, "data", "sites.json"));
}

function candidates(text) {
  const out = [];
  const clean = String(text || "").trim().replace(/\\/g, "/");
  if (!clean) return out;
  const absolute = clean.startsWith("/") || /^[A-Za-z]:\//.test(clean);
  if (!absolute) out.push(path.resolve(projectDir, clean));
  out.push(clean);
  return out;
}

// Same order the desktop archive used: OPENCHQ_DATA, then local/data_root.txt,
// then a bundled data/, then the extract that sits beside this project.
//
// OPENCHQ_NO_EXTRACT=1 skips every candidate and returns "". That is the public-host case, and it
// exists so the suite's no-extract leg is reproducible on a machine that does have the extract
// beside the checkout instead of resting on a developer's log.
export function resolveDataRoot(env = process.env) {
  if (String(env.OPENCHQ_NO_EXTRACT || "") === "1") return "";
  const tries = [];
  tries.push(env.OPENCHQ_DATA);
  const localFile = path.join(projectDir, "local", "data_root.txt");
  if (existsSync(localFile)) {
    for (const line of readFileSync(localFile, "utf8").split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      tries.push(text);
    }
  }
  tries.push(path.join(projectDir, "data"));
  tries.push("../Command HQ/modern/extracted");
  for (const attempt of tries) {
    for (const candidate of candidates(attempt)) {
      if (usable(candidate)) return candidate;
    }
  }
  return "";
}

function makeGrid(buf) {
  const bytes = Buffer.from(buf);
  const at = (x, y) => {
    const cx = ((x % CELL_W) + CELL_W) % CELL_W;
    const v = bytes[y * ROW_STRIDE + (cx >> 1)];
    return cx % 2 === 0 ? (v >> 4) & 0x0f : v & 0x0f;
  };
  const set = (x, y, id) => {
    if (y < 0 || y >= CELL_H) return;
    const cx = ((x % CELL_W) + CELL_W) % CELL_W;
    const i = y * ROW_STRIDE + (cx >> 1);
    const v = bytes[i];
    const n = id & 0x0f;
    bytes[i] = cx % 2 === 0 ? ((n << 4) | (v & 0x0f)) : ((v & 0xf0) | n);
  };
  const counts = () => {
    const box = { capitals: 0, docks: 0, cities: 0 };
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const id = at(x, y);
        if (id === 1) box.docks++;
        else if (id === 4) box.capitals++;
        else if (id === 6) box.cities++;
      }
    }
    return box;
  };
  return { bytes, at, set, counts };
}

function sortedSites(sites) {
  return [...sites].sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
}

// The extract's oil layer. Only what the list actually says travels: the id, the name, the
// map position and the region. Its production rating is never copied, because no browser
// rule reads it and the panel says "Rate unknown."
function oilWells(root) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(root, "data", "resources_oil.json"), "utf8"));
  } catch {
    return [];
  }
  const fields = Array.isArray(parsed) ? parsed : Array.isArray(parsed.fields) ? parsed.fields : [];
  const out = [];
  for (const field of fields) {
    if (!field) continue;
    const x = Number(field.map_x);
    const y = Number(field.map_y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (x < 0 || x >= CELL_W || y < 0 || y >= CELL_H) continue;
    out.push({
      id: String(field.id ?? `${x}:${y}`),
      name: field.name ?? null,
      x,
      y,
      kind: field.kind ?? "oilfield",
      region: field.region ?? null,
      era_min: Number.isFinite(Number(field.era_min)) ? Number(field.era_min) : 0,
    });
  }
  return out;
}

// A cell's own neighbour site, so a painted dock inherits the country of the port it serves.
function neighbourSite(sites, x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const ny = y + dy;
      if (ny < 0 || ny >= CELL_H) continue;
      const nx = ((x + dx) % CELL_W + CELL_W) % CELL_W;
      const hit = sites.find((site) => Number(site.x) === nx && Number(site.y) === ny);
      if (hit) return hit;
    }
  }
  return null;
}

// The full site list a match plays on: the asset list's cities, capitals and facilities,
// every docks cell the terrain painter laid down (id 1), and the oil fields the resource
// list places on this board. A dock takes its port's country; a well keeps the region the
// oil list names. Unknown kinds pass through untouched. Ids stay stable per cell.
export function matchSites(era = "1986", board = boardPayload()) {
  // The baked board carries the same grid, site table and wells the extract does, so a host with no
  // extract plays the same 269-site 1986 map as a developer machine. Gating this on source "extract"
  // is what left the public host with the 84-site picture list, no docks, nothing owned and no
  // income at all - a dead economy that looked like a rule bug.
  if (!board || (board.source !== "extract" && board.source !== "bundled") || !Array.isArray(board.sites)) return [];
  const base = board.sites.map((site) => ({
    id: site.id,
    name: site.name,
    x: site.x,
    y: site.y,
    kind: site.kind,
    country_id: site.country_id,
  }));

  // The era's opening, from the baked table: which of the 84 sites exist that year, the subtype
  // each carries, and - for 1918/1942/1986 - who holds it. A year with no entry (????, junk) comes
  // back as the same array, so this is a no-op where the table has nothing to say. Ports are
  // attributed from the whole asset list, before this runs, so a dock keeps its port's country even
  // when the port's town is absent that year.
  const live = applyEra(base, era);
  // The file's owner byte is live from the bell. R6 cleared it as an interim deviation, when the win
  // check still counted the two seats and a held opening would have decided 1942 on the opening
  // bell; the original's turn-0 RAM says otherwise - London is 0x59 and Berlin 0x9A before any order
  // (docs/re/B3_CAPITALS.md §2), and the win check at 1c0d:000c reads that same byte. B-3b moves the
  // win onto the era's whole set, which removes R6's reason: measured on the file, no era opens with
  // every capital held by one side (1918 2 blue / 1 red, 1942 3/3, 1986 3/1), so nothing is decided
  // at the bell and no clear is needed to prevent it. Ruled explicitly here, superseding R6.

  const docks = [];
  if (Array.isArray(board.cells)) {
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        if (board.cells[y * CELL_W + x] !== 1) continue;
        const port = neighbourSite(base, x, y);
        docks.push({
          id: `dock:${x}:${y}`,
          name: `Dock ${x},${y}`,
          x,
          y,
          kind: "dock",
          country_id: port ? port.country_id : null,
        });
      }
    }
  }

  const year = Number(era);
  const limit = Number.isFinite(year) ? year : Number.POSITIVE_INFINITY;
  const wells = [];
  const at = new Map();
  for (const field of Array.isArray(board.wells) ? board.wells : []) {
    if (!field) continue;
    if (Number(field.era_min) > limit) continue;
    const key = `${field.x}:${field.y}`;
    const seen = at.get(key);
    // Two names for one field: the later discovery wins and the old name is dropped, so one
    // cell never carries two wells.
    if (seen) {
      if (Number(field.era_min) > Number(seen.era_min)) {
        wells[wells.indexOf(seen)] = field;
        at.set(key, field);
      }
      continue;
    }
    at.set(key, field);
    wells.push(field);
  }

  return [...live, ...docks, ...wells.map((field) => ({
    id: field.id,
    name: field.name,
    x: field.x,
    y: field.y,
    kind: field.kind,
    region: field.region,
  }))];
}

// Paints site centers, and neighbors for a site that also covers its block.
// A water neighbor becomes docks, any other neighbor becomes city.
function paintSites(grid, sites) {
  for (const place of sortedSites(sites)) {
    const kind = String(place.kind ?? "");
    if (!Object.hasOwn(PAINT_CENTER, kind)) continue;
    const x = Number(place.x ?? 0);
    const y = Number(place.y ?? 0);
    grid.set(x, y, PAINT_CENTER[kind]);
    if (!PAINT_NEIGHBORS[kind]) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ny = y + dy;
        if (ny < 0 || ny >= CELL_H) continue;
        const cur = grid.at(x + dx, ny);
        grid.set(x + dx, ny, cur <= 2 ? 1 : 6);
      }
    }
  }
}

function paintCenters(grid, sites) {
  for (const place of sortedSites(sites)) {
    const kind = String(place.kind ?? "");
    if (!Object.hasOwn(PAINT_CENTER, kind)) continue;
    grid.set(Number(place.x ?? 0), Number(place.y ?? 0), PAINT_CENTER[kind]);
  }
}

// Keeps the archive's rule: the full block paint only while the counts stay
// 2 capitals, 150 docks, and 407 cities. Otherwise the centers alone are painted.
export function buildGrid(rawBytes, sites) {
  const grid = makeGrid(rawBytes);
  paintSites(grid, sites);
  const full = grid.counts();
  if (full.capitals === 2 && full.docks === 150 && full.cities === 407) {
    return { grid, paint: "full", counts: full };
  }
  const centers = makeGrid(rawBytes);
  paintCenters(centers, sites);
  return { grid: centers, paint: "centers", counts: centers.counts() };
}

let cached = null;

// The baked board. The public host has no extract and never will, so the map the player sees there
// comes from this file: the same 320x136 terrain codes, the same sites, the same palette, derived
// from the archive by tools/bake_world.mjs. No picture, executable or data file of the 1990 release
// is shipped - a blank grid is not "the original's board", and it is not what the player is owed.
const bundledFile = path.join(projectDir, "web", "data", "world.json");

function bundledWorld() {
  if (!existsSync(bundledFile)) return null;
  try {
    return JSON.parse(readFileSync(bundledFile, "utf8"));
  } catch {
    return null;
  }
}

function unbundle(world) {
  if (!world || !Array.isArray(world.terrainRuns)) return null;
  const total = CELL_W * CELL_H;
  const cells = new Array(total);
  let at = 0;
  for (const run of world.terrainRuns) {
    if (!Array.isArray(run) || run.length !== 2) return null;
    const [value, count] = run;
    for (let i = 0; i < count && at < total; i++) cells[at++] = value;
  }
  if (at !== total) return null;
  return {
    source: "bundled",
    width: world.width || CELL_W,
    height: world.height || CELL_H,
    stride: world.stride || ROW_STRIDE,
    cells,
    sites: Array.isArray(world.sites) ? world.sites : [],
    wells: Array.isArray(world.wells) ? world.wells : [],
    capitals: world.capitals || { blue: { ...SEATS.blue }, red: { ...SEATS.red } },
    terrain: world.terrain || TERRAIN,
    paint: world.paint || "original",
    counts: world.counts || { capitals: 0, docks: 0, cities: 0 },
    sightCells: sightCells(),
  };
}

export function bundledBoard() {
  return unbundle(bundledWorld());
}



// Everything the page needs to draw the board. No image bytes, no stills, and no
// path to the extract: those stay on this machine.
export function boardPayload(env = process.env) {
  if (cached) return cached;
  const root = resolveDataRoot(env);
  if (!root) {
    const baked = bundledBoard();
    if (baked) {
      cached = baked;
      return cached;
    }
    cached = {
      source: "missing",
      width: CELL_W,
      height: CELL_H,
      stride: ROW_STRIDE,
      cells: null,
      sites: [],
      wells: [],
      capitals: { blue: { ...SEATS.blue }, red: { ...SEATS.red } },
      terrain: TERRAIN,
      paint: "schematic",
      counts: { capitals: 0, docks: 0, cities: 0 },
      // The sight radius travels with the board so the page draws the same rule the server
      // applied instead of guessing a number.
      sightCells: sightCells(),
    };
    return cached;
  }
  const rawBytes = readFileSync(path.join(root, "data", "tmap.bin"));
  if (rawBytes.length < CELL_H * ROW_STRIDE) {
    throw new Error("terrain file is shorter than 136 rows");
  }
  const parsed = JSON.parse(readFileSync(path.join(root, "data", "sites.json"), "utf8"));
  const sites = Array.isArray(parsed) ? parsed : Array.isArray(parsed.sites) ? parsed.sites : [];
  const wells = oilWells(root);
  const { grid, paint, counts } = buildGrid(rawBytes, sites);
  const cells = new Array(CELL_W * CELL_H);
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) cells[y * CELL_W + x] = grid.at(x, y);
  }
  const capitals = {};
  for (const [side, seat] of Object.entries(SEATS)) {
    const found = sites.find((place) => place && place.kind === "capital" &&
      Number(place.x) === seat.x && Number(place.y) === seat.y);
    capitals[side] = {
      name: seat.name,
      x: seat.x,
      y: seat.y,
      siteId: found ? found.id : null,
    };
  }
  cached = {
    source: "extract",
    width: CELL_W,
    height: CELL_H,
    stride: ROW_STRIDE,
    cells,
    sites: sites.map((place) => ({
      id: place.id,
      name: place.name,
      x: place.x,
      y: place.y,
      country_id: place.country_id,
      kind: place.kind,
    })),
    wells,
    capitals,
    terrain: TERRAIN,
    paint,
    counts,
    sightCells: sightCells(),
  };
  return cached;
}

// Same bargain as the board: the decoded atlas rides in the repo so the public host can draw the
// original's lettering. The sheet itself is never shipped.
function bundledFont(file) {
  if (!existsSync(file)) return { source: "missing" };
  try {
    const atlas = JSON.parse(readFileSync(file, "utf8"));
    const glyphs = Array.isArray(atlas.glyphs) ? atlas.glyphs : [];
    if (!glyphs.length) return { source: "missing" };
    return { source: "bundled", _meta: atlas._meta || {}, glyphs };
  } catch {
    return { source: "missing" };
  }
}

// The original's font atlas, decoded from FONTS.CHQ by the reference tree's
// tools/font_decode.py. It rides the same data-root rule as the board: where the extract is absent
// (the public host) this answers source "missing" and the page keeps its system font.
export function fontPayload(env = process.env) {
  const root = resolveDataRoot(env);
  const bakedFont = path.join(projectDir, "web", "data", "font.json");
  if (!root) return bundledFont(bakedFont);
  const file = path.join(root, "data", "font_atlas.json");
  if (!existsSync(file)) return bundledFont(bakedFont);
  const atlas = JSON.parse(readFileSync(file, "utf8"));
  const meta = atlas && atlas._meta ? atlas._meta : {};
  return {
    source: "extract",
    _meta: meta,
    glyphs: Array.isArray(atlas.glyphs) ? atlas.glyphs : [],
  };
}

export function resetBoardCache() {
  cached = null;
}
