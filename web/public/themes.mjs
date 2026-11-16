// Map themes (T-019, D-022). Cosmetic only.
//
// A theme is a table of inks: the terrain colours, the Show Ownership fills and edges, and the
// small set of page accents that have to stay readable beside them (label ink, route ink, the
// selected-piece mark). Nothing here touches the grid, the cell ids, the sites, the pieces or the
// rules: the painter reads a theme, the server never hears about it. Two clients on different
// themes draw the same game.
//
// C is the first-load default (Shane, D-022: "dark tactical"); D is the Classic option, the
// original's own colours recovered from WORLD.PIC / OMAP.PIC (see paint.mjs and the T-018 notes
// for the measurement those four terrain hues come from). Both are painted from the same cell grid,
// so a theme switch cannot move anything: it changes the ink a cell is filled with, not the cell.

import { PALETTE } from "./paint.mjs";

// C, dark tactical. Dark sea, muted land, a cold cyan coastal edge, white city dots. The four
// accents are the only "light" things on the board, so a unit, a route and a city still read at the
// whole-world fit where a cell is one pixel.
const DARK_TERRAIN = Object.freeze({
  ocean: "#05080f",
  shallows: "#0a1421",
  lake: "#0a1421",
  docks: "#1a2634",
  plain: "#324436",
  forest: "#22402c",
  jungle: "#1e4438",
  mountain: "#4b4b48",
  desert: "#6b5636",
  polar: "#c9d6e4",
  wasteland: "#3a3733",
  city: "#eef4ff",
  oilfield: "#7a5a2a",
  capital: "#ffd166",
  base: "#2b2f36",
  facility: "#2b2f36",
});

// The ownership view in C keeps the same discipline: dark fills, one bright edge per side, and a
// neutral land that is a shade of the sea rather than the white D uses (white islands of unheld
// ground read as fog at night).
const DARK_OWNERSHIP = Object.freeze({
  blue: "#1b3f66",
  red: "#5a232a",
  neutral: "#2a2f36",
  sea: "#05080f",
  edge: Object.freeze({ blue: "#35d0ff", red: "#ff5a5a", neutral: "#6b7684" }),
});

const DARK_SCHEMATIC = Object.freeze({
  water: "#05080f",
  grid: "#132033",
  blue: "#35d0ff",
  red: "#ff5a5a",
});

// D, Classic: the measured original palette, unchanged. `classic: true` is what the page reads to
// name the option in the switch control.
const CLASSIC_TERRAIN = Object.freeze({ ...PALETTE });

const CLASSIC_OWNERSHIP = Object.freeze({
  blue: "#5555ff",
  red: "#ff5555",
  neutral: "#ffffff",
  sea: "#55ffff",
  edge: Object.freeze({ blue: "#0000aa", red: "#aa0000", neutral: "#555555" }),
});

const CLASSIC_SCHEMATIC = Object.freeze({
  water: "#081018",
  grid: "#1a2740",
  blue: "#3d7ec9",
  red: "#c4473a",
});

export const THEMES = Object.freeze([
  Object.freeze({
    id: "C",
    label: "Dark tactical",
    classic: false,
    terrain: DARK_TERRAIN,
    ownership: DARK_OWNERSHIP,
    schematic: DARK_SCHEMATIC,
    // A one-pixel bright coastal edge. Only themes that set it pay for it; D's saturated land
    // already separates from its pale sea without one.
    coast: "#2f6f86",
    // Text and lines that sit on top of the board.
    labelInk: "#f2f7ff",
    labelPlate: "rgba(4, 8, 14, 0.82)",
    routeInk: "#ffd166",
    routeCasing: "rgba(0, 0, 0, 0.72)",
    selectionInk: "#ffe066",
    gridInk: "#132033",
  }),
  Object.freeze({
    id: "D",
    label: "Classic",
    classic: true,
    terrain: CLASSIC_TERRAIN,
    ownership: CLASSIC_OWNERSHIP,
    schematic: CLASSIC_SCHEMATIC,
    coast: null,
    labelInk: "#ffffff",
    labelPlate: "rgba(0, 0, 0, 0.72)",
    routeInk: "#ffd166",
    routeCasing: "rgba(0, 0, 0, 0.65)",
    selectionInk: "#ffe066",
    gridInk: "#1a2740",
  }),
]);

// D-022: dark tactical on first load. A saved preference that names a theme this build does not
// ship falls back to the default rather than to a blank board.
export const DEFAULT_THEME = "C";

export function themeById(id) {
  const key = String(id ?? "").toUpperCase();
  return THEMES.find((theme) => theme.id === key) || THEMES.find((theme) => theme.id === DEFAULT_THEME) || THEMES[0];
}

export function isThemeId(id) {
  const key = String(id ?? "").toUpperCase();
  return THEMES.some((theme) => theme.id === key);
}

// The first-load decision, in one place so the page and its pin read the same rule: nothing saved
// (or an id this build does not ship, or a storage read that threw) opens on C.
export function resolveTheme(saved) {
  const key = String(saved ?? "").toUpperCase();
  return isThemeId(key) ? key : DEFAULT_THEME;
}

// The one-click switch: C -> D -> C. Returned by id so the control and the preference are the same
// string, never an index into a list that a later theme would shift.
export function nextThemeId(id) {
  const current = themeById(id);
  const at = THEMES.findIndex((theme) => theme.id === current.id);
  return THEMES[(at + 1) % THEMES.length].id;
}

// Ink for one terrain name in one theme. Unknown names stay unpainted, exactly as before.
export function terrainInk(theme, name) {
  const key = String(name ?? "").toLowerCase();
  const table = (theme && theme.terrain) || DARK_TERRAIN;
  return Object.hasOwn(table, key) ? table[key] : null;
}

// The ownership palette a painter should use, defaulting to the theme's own.
export function ownershipPalette(theme) {
  return (theme && theme.ownership) || DARK_OWNERSHIP;
}

// The legend a theme can honestly print: every terrain it paints, in its own inks.
export function themeLegend(theme) {
  const names = ["ocean", "shallows", "plain", "forest", "desert", "mountain", "polar", "city", "capital"];
  return names
    .map((name) => ({ label: name, color: terrainInk(theme, name) }))
    .filter((entry) => entry.color);
}
