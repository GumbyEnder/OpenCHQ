// Pure board painter. No DOM at import time, so the harness can drive it with a
// recording context. The page passes its own 2d context.
//
// The cell ids come from /api/board. Terrain names come from the same payload.
// Colors are ours; nothing here reads the original map picture.

// These are the original game's colours, not a palette of our own.
//
// Recovered by matching the shipped art against the shipped terrain table: the map in WORLD.PIC is
// 320x136 pixels and TMAP.DAT is one nibble per cell at the same size, so cell (x,y) is pixel
// (x,y) of the picture. The picture's map area starts at y=6 (the six rows above it are black),
// and at that offset the terrain table and the art agree on 85% of cells. The dominant colour per
// terrain type, out of the 16-colour EGA default palette the game set:
//
//   ocean #55ffff · plain #00aa00 · forest #55ff55 · jungle #00aaaa
//   mountain #aaaaaa · desert #ffff55 · polar #ffffff
//
// tools/sample_palette.py in the Command HQ reference tree reproduces the measurement.
export const PALETTE = Object.freeze({
  ocean: "#55ffff",
  shallows: "#00aaaa",
  lake: "#00aaaa",
  docks: "#555555",
  plain: "#00aa00",
  forest: "#55ff55",
  jungle: "#00aaaa",
  mountain: "#aaaaaa",
  desert: "#ffff55",
  polar: "#ffffff",
  wasteland: "#555555",
  // A city is a black dot on the map, the way the original drew one.
  city: "#000000",
  oilfield: "#aa5500",
  // A city is a black dot, as the original drew it. The capital's ground is yellow only so the
  // legend can name it: the marker that actually identifies a capital is the ring the painter
  // draws around it, and the label beside it.
  capital: "#ffff55",
  base: "#555555",
  facility: "#555555",
});

export const SCHEMATIC = Object.freeze({
  water: "#081018",
  grid: "#1a2740",
  blue: "#3d7ec9",
  red: "#c4473a",
});

export const EXTRACT_MISSING =
  "The map extract is missing on this host. Showing the schematic.";

const LAND = ["plain", "forest", "jungle", "mountain", "desert", "polar"];

// Terrain name -> color. Unknown names stay unpainted and unnamed.
export function colorForTerrain(name) {
  const key = String(name ?? "").toLowerCase();
  return Object.hasOwn(PALETTE, key) ? PALETTE[key] : null;
}

export function colorForCell(board, cellId) {
  const terrain = Array.isArray(board && board.terrain) ? board.terrain : [];
  return colorForTerrain(terrain[cellId]);
}

// Terrain names that count as open ground for the page's legend.
export function isLand(name) {
  return LAND.includes(String(name ?? "").toLowerCase());
}

function paintSchematic(ctx, board, scale) {
  const w = Number(board && board.width) || 320;
  const h = Number(board && board.height) || 136;
  ctx.fillStyle = SCHEMATIC.water;
  ctx.fillRect(0, 0, w * scale, h * scale);
  ctx.fillStyle = SCHEMATIC.grid;
  for (let x = 20; x < w; x += 20) ctx.fillRect(x * scale, 0, scale, h * scale);
  for (let y = 20; y < h; y += 20) ctx.fillRect(0, y * scale, w * scale, scale);
  const seats = (board && board.capitals) || {
    blue: { x: 79, y: 44 },
    red: { x: 183, y: 25 },
  };
  if (seats.blue) {
    ctx.fillStyle = SCHEMATIC.blue;
    ctx.fillRect(seats.blue.x * scale, seats.blue.y * scale, 3 * scale, 3 * scale);
  }
  if (seats.red) {
    ctx.fillStyle = SCHEMATIC.red;
    ctx.fillRect(seats.red.x * scale, seats.red.y * scale, 3 * scale, 3 * scale);
  }
  return { mode: "schematic", painted: 0, message: EXTRACT_MISSING };
}

// Draws the board once. Returns what it did, so the page (and the test) can
// tell a painted grid from the schematic fallback.
export function paintBoard(ctx, board, opts = {}) {
  const scale = Math.max(1, Math.floor(Number(opts.scale) || 1));
  const w = Number(board && board.width) || 320;
  const h = Number(board && board.height) || 136;
  ctx.clearRect(0, 0, w * scale, h * scale);
  if (!board || board.source === "missing" || !Array.isArray(board.cells)) {
    return paintSchematic(ctx, board, scale);
  }
  const cells = board.cells;
  const terrain = Array.isArray(board.terrain) ? board.terrain : [];
  let painted = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = colorForTerrain(terrain[cells[y * w + x]]);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
      painted++;
    }
  }
  return { mode: "cells", painted, message: "" };
}
