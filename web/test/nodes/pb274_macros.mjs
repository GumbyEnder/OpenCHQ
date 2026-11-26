// PB-274 Screen Macros — the node pin (node id: pb274_macros).
//
// Manual printed p.33-34: "in IBM systems you would press the ALT key plus a number to define the
// macro. From then on, pressing that number alone would send you to the pre-set window location and
// size." / "The first four macro IDs are already programmed into the game, but can be overwritten ...
// They zoom to Europe, the Middle East, Japan, and North America." / "To alter the zoom area of a
// macro, simply re-define it." / Undo Macro returns to the view held before the recall.
//
// What this pin measures, over the module the page runs:
//   1. the four preset boxes are the bounding boxes of the ids the module names, read from the
//      board payload the server actually SERVES (/api/board), not from a fixture — so a table move
//      reds this pin instead of silently moving the preset;
//   2. store -> recall round-trips centre, size and view mode, at the same viewport and at a smaller
//      one (the box keeps its centre and drops only as far as it must to fit);
//   3. the set persists through one browser-wide key, survives a fresh book, and an unreadable value
//      opens empty instead of throwing;
//   4. re-storing a preset overwrites it (the manual's "can be overwritten");
//   5. Undo Macro returns the camera AND the view mode to the view held before the recall;
//   6. the key classifier claims Alt+1..9 and 1..9 only: `0` (Fit), P, T, F, D, S, B, E and +/- are
//      not macro gestures, and Ctrl/Cmd+digit is the browser's.
import { createMacroBook, cameraForMacro, captureMacro, macroKeyAction, presetBox, MACRO_KEY, MACRO_PRESETS } from "../../public/macros.mjs";

export const name = "pb274_macros";

const VIEW = { scale: 1, minScale: 1, left: 0, top: 0, viewW: 640, viewH: 272, boardW: 320, boardH: 136 };

function memoryStorage(initial = {}) {
  const cells = new Map(Object.entries(initial));
  return {
    get: (key) => (cells.has(key) ? cells.get(key) : null),
    set: (key, value) => cells.set(key, String(value)),
    dump: () => Object.fromEntries(cells),
  };
}

export async function run({ fail, base }) {
  function expect(actual, wanted, label) {
    if (actual !== wanted) fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(wanted));
  }
  const close = (actual, wanted, label, tol = 25) => {
    if (!(Math.abs(Number(actual) - Number(wanted)) <= tol)) {
      fail(label + ": got " + actual + ", wanted " + wanted + " (tol " + tol + ")");
    }
  };

  // ---- 1. the presets are the table's own boxes --------------------------------------------------
  const board = await (await fetch(base + "/api/board")).json();
  const sites = Array.isArray(board.sites) ? board.sites : [];
  if (!sites.length) fail("the served board carries no sites, so no preset box can be derived");
  // Recomputed here by hand from web/data's 84-row table (ids and pad as the module names them) so
  // the module's own helper is not grading itself: x/y minima and maxima over the named ids.
  const WANT = {
    1: { label: "Europe", ids: [10, 11, 12, 14, 17, 26, 29, 63], pad: 2, box: { cx: 164.5, cy: 34, w: 43, h: 22 } },
    2: { label: "the Middle East", ids: [30, 45, 47, 72, 73, 75, 77, 79, 80], pad: 2, box: { cx: 186.5, cy: 51.5, w: 31, h: 23 } },
    3: { label: "Japan", ids: [35, 37, 39, 40, 41], pad: 3, box: { cx: 270, cy: 47, w: 12, h: 10 } },
    4: { label: "North America", ids: [18, 20, 24, 25, 27, 28, 32, 33, 44, 53, 62], pad: 2, box: { cx: 62.5, cy: 49.5, w: 51, h: 33 } },
  };
  for (const preset of MACRO_PRESETS) {
    const want = WANT[preset.id];
    if (!want) {
      fail("preset " + preset.id + " is not in the pin's table");
      continue;
    }
    expect(preset.label, want.label, "preset " + preset.id + " label");
    expect(preset.sites.join(","), want.ids.join(","), "preset " + preset.id + " site ids");
    expect(preset.pad, want.pad, "preset " + preset.id + " pad");
    const box = presetBox(preset, sites, board);
    if (!box) {
      fail("preset " + preset.id + " has no box on the served board");
      continue;
    }
    expect(box.cx, want.box.cx, "preset " + preset.id + " centre x");
    expect(box.cy, want.box.cy, "preset " + preset.id + " centre y");
    expect(box.w, want.box.w, "preset " + preset.id + " width in cells");
    expect(box.h, want.box.h, "preset " + preset.id + " height in cells");
    expect(box.mode, "terrain", "preset " + preset.id + " opens on the map view");
  }
  console.log("pb274 preset boxes: " + JSON.stringify(MACRO_PRESETS.map((preset) => presetBox(preset, sites, board))));

  // ---- 2. store -> recall, same and smaller viewport ---------------------------------------------
  const storage = memoryStorage();
  const book = createMacroBook(storage, { sites, board });
  // A camera the player zoomed into: scale 8, 1280x800 device px, centred on cell (100.5, 60.5).
  const camera = cameraForMacro({ cx: 100.5, cy: 60.5, w: 160, h: 100, scale: 8 }, { ...VIEW, scale: 1, viewW: 1280, viewH: 800, minScale: 1 });
  expect(camera.scale, 8, "a recall at the same viewport keeps the zoom");
  const macro = captureMacro(camera, "political");
  expect(macro.mode, "political", "the view mode rides in the macro");
  expect(macro.w, 160, "the macro's width is the view window in cells");
  const stored = book.store(5, camera, "political");
  expect(stored && stored.source, "user", "slot 5 is the player's own");
  expect(book.get(5).mode, "political", "slot 5 reads back with its mode");

  const again = book.recall(5, { ...VIEW, viewW: 1280, viewH: 800 });
  if (!again) fail("slot 5 did not recall");
  expect(again.mode, "political", "recall restores the view mode");
  expect(again.camera.scale, 8, "recall restores the zoom at the same viewport");
  close((again.camera.viewW / 2 - again.camera.left) / again.camera.scale, 100.5, "recall restores the centre cell x", 0.5);
  expect(again.camera.left, camera.left, "recall lands on the stored left pixel");
  expect(again.camera.top, camera.top, "recall lands on the stored top pixel");

  const smaller = book.recall(5, { ...VIEW, viewW: 640, viewH: 272, minScale: 2 });
  expect(smaller.camera.scale, 2, "a smaller viewport drops the zoom to the floor, not below it");
  close((smaller.camera.viewW / 2 - smaller.camera.left) / smaller.camera.scale, 100.5,
    "a smaller viewport still centres on the same cell", 0.5);

  // ---- 3. persistence: one browser-wide key, a fresh book reads it -------------------------------
  const raw = JSON.parse(storage.dump()[MACRO_KEY]);
  expect(raw.v, 1, "the stored value carries a version");
  const reopened = createMacroBook(storage, { sites, board });
  expect(reopened.get(5) && reopened.get(5).scale, 8, "a fresh book reads the saved slot back");
  expect(Object.keys(raw.slots).join(","), "5", "the key holds one slot per macro id, browser-wide");

  const broken = createMacroBook(memoryStorage({ [MACRO_KEY]: "{not json" }), { sites, board });
  expect(Object.keys(broken.entries()).length, 0, "an unreadable value opens an empty book");
  const junk = createMacroBook(memoryStorage({ [MACRO_KEY]: JSON.stringify({ v: 1, slots: { 3: { cx: 1, cy: 2 }, 12: { cx: 1, cy: 2, w: 1, h: 1, scale: 1 } } }) }), { sites, board });
  expect(Object.keys(junk.entries()).length, 0, "slots with no size, or an id past 9, are dropped");

  // ---- 4. a preset can be overwritten ------------------------------------------------------------
  const before = book.resolve(1);
  expect(before.source, "preset", "slot 1 starts as the Europe preset");
  const overwritten = book.store(1, camera, "satellites");
  expect(overwritten.was, "preset", "storing over slot 1 says it was a preset");
  const after = book.resolve(1);
  expect(after.source, "user", "slot 1 is the player's after a store");
  expect(after.mode, "satellites", "the overwritten slot keeps the mode it was stored in");

  // ---- 5. Undo Macro -----------------------------------------------------------------------------
  const start = camera; // scale 8, centred 100.5/60.5
  const elsewhere = cameraForMacro({ cx: 40, cy: 90, w: 160, h: 100, scale: 4 }, { ...VIEW, viewW: 1280, viewH: 800 });
  const recall = book.recall(3, { ...VIEW, viewW: 1280, viewH: 800 }, { camera: elsewhere, mode: "terrain" });
  expect(recall.source, "preset", "slot 3 is still the Japan preset");
  expect(recall.camera.scale, 32, "the Japan preset zooms to the ceiling the box allows");
  close((recall.camera.viewW / 2 - recall.camera.left) / recall.camera.scale, 270, "Japan is centred on the table's box", 0.5);
  expect(book.undoable(), true, "a recall arms Undo Macro");
  const undone = book.undo({ ...VIEW, viewW: 1280, viewH: 800 });
  if (!undone) fail("Undo Macro returned nothing after a recall");
  expect(undone.camera.left, elsewhere.left, "Undo Macro returns to the view held before the recall (left)");
  expect(undone.camera.top, elsewhere.top, "Undo Macro returns to the view held before the recall (top)");
  expect(undone.camera.scale, elsewhere.scale, "Undo Macro returns the zoom it held");
  expect(undone.mode, "terrain", "Undo Macro returns the view mode it held");
  expect(book.undoable(), false, "Undo Macro is one step: it disarms itself");
  expect(book.undo(VIEW), null, "a second Undo Macro has nothing to return to");
  expect(start.scale, 8, "the earlier camera was not mutated by the store or the recall");

  // ---- 6. the key classifier ---------------------------------------------------------------------
  const store = macroKeyAction({ key: "3", code: "Digit3", altKey: true });
  expect(JSON.stringify(store), JSON.stringify({ type: "store", id: 3 }), "Alt+3 stores slot 3");
  expect(JSON.stringify(macroKeyAction({ key: "7", code: "Digit7" })), JSON.stringify({ type: "recall", id: 7 }),
    "7 alone recalls slot 7");
  expect(JSON.stringify(macroKeyAction({ key: "", code: "Numpad4" })), JSON.stringify({ type: "recall", id: 4 }),
    "a numpad press recalls by its code when the key is empty");
  for (const event of [
    { key: "0", code: "Digit0" }, { key: "0", code: "Digit0", altKey: true },
    { key: "p" }, { key: "t" }, { key: "f" }, { key: "d" }, { key: "s" }, { key: "b" }, { key: "e" },
    { key: "+" }, { key: "-" }, { key: "=" }, { key: "_" }, { key: "Escape" }, { key: "ArrowLeft" },
    { key: "3", code: "Digit3", ctrlKey: true }, { key: "3", code: "Digit3", metaKey: true },
    { key: "v", code: "KeyV", ctrlKey: true },
  ]) {
    expect(macroKeyAction(event), null, "not a macro gesture: " + JSON.stringify(event));
  }
  // 0 is Fit's key, and the classifier is what the page asks BEFORE its own handler runs: a digit the
  // module does not claim must fall through, never be swallowed.
  console.log("pb274 keys: Alt+3 store, 3 recall, 0/P/T/F/D/S/B/E/+/- unclaimed");
}
