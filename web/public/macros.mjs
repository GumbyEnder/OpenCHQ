// PB-274 Screen Macros — manual printed p.33-34:
//   "in IBM systems you would press the ALT key plus a number to define the macro. From then on,
//    pressing that number alone would send you to the pre-set window location and size."
//   "The first four macro IDs are already programmed into the game, but can be overwritten ... They
//    zoom to Europe, the Middle East, Japan, and North America."
//   "To alter the zoom area of a macro, simply re-define it."
//   (Undo Macro is the menu command that returns to the view held before the recall.)
//
// Everything here is pure: a camera goes in and four numbers come out (where the view is centred,
// how many cells it spans, at what zoom, in which view mode), and those four numbers go back into a
// camera. The page owns the keys, the localStorage write and the repaint; this module is what the
// node pin grades against the real table.

import { boxCamera } from "./render.mjs";

// One browser-wide key, the THEME_KEY shape (PB-263's per-seat message level is deliberately a
// different thing: a message level belongs to a seat, a macro set belongs to the browser — manual
// p.34 "saved throughout the game, and between games").
export const MACRO_KEY = "openchq.macros";
export const MACRO_MAX = 9;

// The four presets the manual names, expressed as ids in the board's own 84-row site table
// (`web/data` sites, the same list /api/board serves as `boardPayload.sites`). A preset is the
// bounding box over those cells plus `pad` cells of margin, clamped to the board — there is no
// hand-picked rectangle in this file, so the boxes are reproducible from the table alone.
//
//   Europe          cities 10 London, 11 Berlin, 12 Warsaw, 14 Kiev, 17 Paris, 26 Rome, 29 Madrid,
//                   63 Moscow
//   Middle East     cities 30 Istanbul, 45 Jerusalem, 47 Cairo, and the facilities the extract puts
//                   in the same region — 72, 73, 75, 77, 79, 80 (type 5, the original's oil fields,
//                   PB-153). p.34's "Middle East" is where the oil is; a box without those cells
//                   would zoom past the ground the macro exists for.
//   Japan           cities 35 Tokyo, 37 Nagoya, 39 Yokohama, 40 Hiroshima, 41 Osaka
//   North America   cities 18 Seattle, 32 San Francisco, 44 Los Angeles, 33 Denver, 27 Chicago,
//                   24 Detroit, 28 New York, 25 Boston, 20 Toronto, 62 Washington, 53 Mexico City
export const MACRO_PRESETS = Object.freeze([
  { id: 1, label: "Europe", pad: 2, sites: [10, 11, 12, 14, 17, 26, 29, 63] },
  { id: 2, label: "the Middle East", pad: 2, sites: [30, 45, 47, 72, 73, 75, 77, 79, 80] },
  { id: 3, label: "Japan", pad: 3, sites: [35, 37, 39, 40, 41] },
  { id: 4, label: "North America", pad: 2, sites: [18, 20, 24, 25, 27, 28, 32, 33, 44, 53, 62] },
]);

export const PRESET_BY_ID = new Map(MACRO_PRESETS.map((preset) => [preset.id, preset]));

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// A preset's box on the board the server actually served. `null` when none of its sites exist in
// this table (a host whose board payload carries no sites at all), so the page can say a preset is
// unavailable instead of pointing the camera at cell 0,0.
export function presetBox(preset, sites, board = {}) {
  const row = preset && typeof preset === "object" ? preset : PRESET_BY_ID.get(Number(preset));
  if (!row) return null;
  const wanted = new Set(row.sites.map((id) => String(id)));
  const cells = (Array.isArray(sites) ? sites : []).filter((site) => site && wanted.has(String(site.id)));
  if (!cells.length) return null;
  const boardW = Math.max(1, Math.round(finite(board.width, 320)));
  const boardH = Math.max(1, Math.round(finite(board.height, 136)));
  const pad = Math.max(0, Math.round(finite(row.pad, 0)));
  const xs = cells.map((site) => Math.round(finite(site.x, 0)));
  const ys = cells.map((site) => Math.round(finite(site.y, 0)));
  const x0 = Math.max(0, Math.min(...xs) - pad);
  const x1 = Math.min(boardW - 1, Math.max(...xs) + pad);
  const y0 = Math.max(0, Math.min(...ys) - pad);
  const y1 = Math.min(boardH - 1, Math.max(...ys) + pad);
  return {
    cx: (x0 + x1 + 1) / 2,
    cy: (y0 + y1 + 1) / 2,
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    // A preset is the original's map box; the original has three views and the box does not say
    // which one it was in, so a preset opens on the map view it was programmed for.
    mode: "terrain",
    label: row.label,
    source: "preset",
  };
}

// The camera -> macro direction. `w`/`h` are the view window in CELLS, so the stored size means the
// same thing at any device pixel ratio; `scale` keeps the zoom the player had.
export function captureMacro(camera, mode) {
  if (!camera) return null;
  const scale = Math.max(1, Math.round(finite(camera.scale, 1)));
  const viewW = Math.max(1, finite(camera.viewW, scale));
  const viewH = Math.max(1, finite(camera.viewH, scale));
  const left = finite(camera.left, 0);
  const top = finite(camera.top, 0);
  // The view's centre in cell space: the painter draws cell i at left + (i + 0.5) * scale, so the
  // world point under the middle of the canvas is (viewW / 2 - left) / scale.
  return {
    cx: round3((viewW / 2 - left) / scale),
    cy: round3((viewH / 2 - top) / scale),
    // The window in cells, kept fractional on purpose: rounding it to whole cells makes a re-store at
    // a zoom that does not divide the canvas (960 / 5 = 192 by 81.6) recall one zoom step short,
    // because the recalled "fits" test then divides by 82 instead of 81.6.
    w: round3(Math.max(1, viewW / scale)),
    h: round3(Math.max(1, viewH / scale)),
    scale,
    mode: String(mode || "terrain"),
  };
}

// The macro -> camera direction, against the viewport the page has NOW: the box keeps its centre,
// and the zoom is the stored one unless the whole box no longer fits this window, in which case it
// drops to the zoom that fits. Never below the whole-world fit — the camera's floor (PB-067).
export function cameraForMacro(macro, view) {
  // PB-281's rule lives in render.mjs boxCamera so PB-289's kept camera and a recall cannot drift;
  // this wrapper keeps the macro API (null for no macro) and the stored-box shape.
  if (!macro) return null;
  return boxCamera({ cx: macro.cx, cy: macro.cy, w: macro.w, h: macro.h, scale: macro.scale }, view);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// Which key gesture this event is, if any. Alt+1..9 stores; 1..9 alone recalls. Nothing else is a
// macro key — `0` is Fit and must stay Fit, and the letters (P, T, F, D, S, B, E, +/-) never reach
// this function's digit test at all.
export function macroKeyAction(event) {
  const e = event || {};
  // Ctrl+V is the original's Alternate Function (manual p.27) and Ctrl/Cmd+digit belongs to the
  // browser's own tabs; neither is a macro gesture.
  if (e.ctrlKey || e.metaKey) return null;
  const id = digitId(e);
  if (!id) return null;
  return e.altKey ? { type: "store", id } : { type: "recall", id };
}

function digitId(event) {
  const key = String(event.key ?? "");
  if (/^[1-9]$/.test(key)) return Number(key);
  // Some layouts report the modified character (or an empty key) for Alt+digit; the physical key
  // still says which number the player pressed (a German Alt+3 is "³" with code Digit3).
  const code = /^(?:Digit|Numpad)([1-9])$/.exec(String(event.code ?? ""));
  return code ? Number(code[1]) : null;
}

// The book: nine slots, one browser-wide storage key, and the one view undo needs (the view held
// before the last recall — the manual's Undo Macro). Pure apart from the storage object handed in.
export function createMacroBook(storage, options = {}) {
  const presets = Array.isArray(options.presets) ? options.presets : MACRO_PRESETS;
  const sites = Array.isArray(options.sites) ? options.sites : [];
  const board = options.board && typeof options.board === "object" ? options.board : {};
  let slots = read(storage);
  let undoState = null;

  function read(store) {
    if (!store || typeof store.get !== "function") return {};
    let raw = null;
    try {
      raw = store.get(MACRO_KEY);
    } catch (err) {
      return {};
    }
    if (!raw) return {};
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // A key a build this one does not ship wrote is not a crash: an unreadable store opens empty.
      return {};
    }
    const saved = parsed && typeof parsed === "object" && parsed.slots && typeof parsed.slots === "object"
      ? parsed.slots : {};
    const out = {};
    for (const [key, macro] of Object.entries(saved)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id < 1 || id > MACRO_MAX || !macro || typeof macro !== "object") continue;
      const clean = sanitize(macro);
      if (clean) out[id] = clean;
    }
    return out;
  }

  function sanitize(macro) {
    const cx = Number(macro.cx);
    const cy = Number(macro.cy);
    const w = Number(macro.w);
    const h = Number(macro.h);
    const scale = Number(macro.scale);
    if (![cx, cy, w, h, scale].every((n) => Number.isFinite(n))) return null;
    if (w <= 0 || h <= 0 || scale <= 0) return null;
    return { cx, cy, w, h, scale, mode: typeof macro.mode === "string" ? macro.mode : "terrain" };
  }

  function persist() {
    if (!storage || typeof storage.set !== "function") return;
    const saved = {};
    for (const [id, macro] of Object.entries(slots)) saved[id] = macro;
    try {
      storage.set(MACRO_KEY, JSON.stringify({ v: 1, slots: saved }));
    } catch (err) {
      // A private-mode page still recalls what it stored this session; it just will not remember it.
    }
  }

  function lookup(id) {
    const mine = slots[Number(id)];
    if (mine) return { ...mine, source: "user", label: "macro " + id };
    return presetOf(Number(id));
  }

  function presetOf(id) {
    const preset = presets.find((row) => Number(row.id) === Number(id)) || null;
    return preset ? presetBox(preset, sites, board) : null;
  }

  return {
    key: MACRO_KEY,
    max: MACRO_MAX,
    // The stored slots, as a plain object a leg can read.
    entries() {
      const copy = {};
      for (const [id, macro] of Object.entries(slots)) copy[id] = { ...macro };
      return copy;
    },
    get(id) {
      return slots[Number(id)] ? { ...slots[Number(id)] } : null;
    },
    // What a recall of this id would land on, and where it came from: the player's own slot wins over
    // the pre-programmed preset, which is what "can be overwritten" means.
    resolve(id) {
      return lookup(Number(id));
    },
    store(id, camera, mode) {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1 || n > MACRO_MAX) return null;
      const macro = captureMacro(camera, mode);
      if (!macro) return null;
      slots[n] = macro;
      persist();
      return {
        ...macro,
        source: "user",
        label: "macro " + n,
        // What the slot had been, so the page can say "overwrote preset 1" instead of pretending.
        was: presetOf(n) ? "preset" : null,
      };
    },
    // Recall against the current viewport; `current` is the view held now, which is what Undo Macro
    // goes back to.
    recall(id, view, current = {}) {
      const macro = lookup(id);
      const camera = cameraForMacro(macro, view);
      if (!camera) return null;
      undoState = {
        camera: current.camera ? { ...current.camera } : null,
        mode: String(current.mode || macro.mode || "terrain"),
      };
      return { camera, mode: macro.mode, source: macro.source, label: macro.label };
    },
    undoable() {
      return Boolean(undoState);
    },
    // Undo Macro: the view held before the last recall. The camera is re-derived against the current
    // viewport for the same reason a recall is; the mode is restored with it.
    undo(view) {
      if (!undoState || !undoState.camera) return null;
      const back = undoState;
      undoState = null;
      const camera = cameraForMacro(captureMacro(back.camera, back.mode), view);
      return camera ? { camera, mode: back.mode } : null;
    },
  };
}

// Exported so the page's title/help text and the pin quote one list, not two.
// PM 9723 §2 + frodo 9729 §5(a): the panel footnote carries both markers. Both are written for a
// player: pb244_plain_text forbids the maintainer tags (UNVERIFIED / UNMEASURED) in player text, so
// the provenance is said as "this port's reconstruction" and the browser limit as what the player
// will actually see. The literal UNVERIFIED marker lives in the ticket card and in config.
export const MACRO_HELP = "Alt+1-9 stores the current view; 1-9 recalls it; 1-4 start as "
  + MACRO_PRESETS.map((preset) => preset.label).join(", ")
  + ". The four start-up boxes are this port's reconstruction of the original's views."
  + " Alt plus a digit is tested in Chrome; Firefox may keep that gesture for switching tabs.";