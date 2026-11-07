import { existsSync, readFileSync } from "node:fs";
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
export function resolveDataRoot(env = process.env) {
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
  if (!board || board.source !== "extract" || !Array.isArray(board.sites)) return [];
  const base = board.sites.map((site) => ({
    id: site.id,
    name: site.name,
    x: site.x,
    y: site.y,
    kind: site.kind,
    country_id: site.country_id,
  }));

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

  return [...base, ...docks, ...wells.map((field) => ({
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

// Everything the page needs to draw the board. No image bytes, no stills, and no
// path to the extract: those stay on this machine.
export function boardPayload(env = process.env) {
  if (cached) return cached;
  const root = resolveDataRoot(env);
  if (!root) {
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

// The original's font atlas, decoded from FONTS.CHQ by the reference tree's
// tools/font_decode.py. It rides the same data-root rule as the board: where the extract is absent
// (the public host) this answers source "missing" and the page keeps its system font.
export function fontPayload(env = process.env) {
  const root = resolveDataRoot(env);
  if (!root) return { source: "missing" };
  const file = path.join(root, "data", "font_atlas.json");
  if (!existsSync(file)) return { source: "missing" };
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
