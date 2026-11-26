// PB-281 node pin: a macro recalled at its own viewport keeps its stored zoom.
//
// The reported page bug: at 1280x800 Alt+5 stored 53.333 by 22.667 cells at zoom 18; 0 (Fit) then 5
// recalled at 17. captureMacro rounds the cell span to three decimals on purpose (PB-274), so
// 408 / 22.667 = 17.9997. cameraForMacro's "does the box still fit" test floored that to 17 and the
// recall silently lost a zoom step at an unchanged viewport.
//
// This pin grades both halves of the rule, because the easy fix for the first breaks the second:
//   1. capture -> recall at the SAME viewport keeps the stored zoom 18, not 17, and the stored centre;
//   2. a box that is genuinely bigger than the window still drops to the zoom that fits (640x272 and
//      a 160x100 box -> 2; a 2 px shorter canvas -> 17), so the tolerance widens exact-fit only.
import { cameraForMacro, captureMacro, createMacroBook, MACRO_KEY } from "../../public/macros.mjs";

export const name = "pb281_macro_fit";

const VIEW = { scale: 18, minScale: 3, left: -2481, top: -408, viewW: 960, viewH: 408, boardW: 320, boardH: 136 };

function memoryStorage(initial = {}) {
  const cells = new Map(Object.entries(initial));
  return {
    get: (key) => (cells.has(key) ? cells.get(key) : null),
    set: (key, value) => cells.set(key, String(value)),
  };
}

export async function run({ fail }) {
  function expect(actual, wanted, label) {
    if (actual !== wanted) fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(wanted));
  }
  const close = (actual, wanted, label, tol = 0.5) => {
    if (!(Math.abs(actual - wanted) <= tol)) {
      fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(wanted) + " +/- " + tol);
    }
  };
  const centreOf = (camera) => ({
    x: (camera.viewW / 2 - camera.left) / camera.scale,
    y: (camera.viewH / 2 - camera.top) / camera.scale,
  });

  // 1. The reported shape, through the module the page runs: a preset-1 view (zoom 18 on a 960x408
  //    canvas) stored and recalled at that same canvas.
  const stored = captureMacro({ ...VIEW }, "terrain");
  close(stored.w, 53.333, "the stored window is 960/18 cells across, rounded to 1/1000", 0.001);
  close(stored.h, 22.667, "the stored window is 408/18 cells down, rounded to 1/1000", 0.001);
  expect(stored.scale, 18, "capture keeps the zoom the player had");
  const same = cameraForMacro(stored, { ...VIEW, scale: 3 });
  expect(same.scale, 18, "a recall at the viewport the macro was stored at keeps zoom 18, not the 17 the raw division floors to");
  close(centreOf(same).x, stored.cx, "the recall keeps the stored centre cell x", 0.5);
  close(centreOf(same).y, stored.cy, "the recall keeps the stored centre cell y", 0.5);

  // 2. The same round trip through a persisted book, so the pin covers the sanitize/JSON path too.
  const book = createMacroBook(memoryStorage({ [MACRO_KEY]: JSON.stringify({ v: 1, slots: { 5: stored } }) }), {});
  const back = book.recall(5, { ...VIEW, scale: 3 });
  if (!back) fail("slot 5 did not recall from the persisted book");
  expect(back.camera.scale, 18, "a persisted slot recalls at its stored zoom at an unchanged viewport");

  // 3. The cap still bites: a box that is genuinely bigger than the window drops to the zoom that
  //    fits it. 640/160 = 4, 272/100 = 2.72, so the whole box shows at zoom 2.
  const big = cameraForMacro({ cx: 100, cy: 60, w: 160, h: 100, scale: 8 }, { ...VIEW, scale: 1, minScale: 1, viewW: 640, viewH: 272 });
  expect(big.scale, 2, "a box taller than the window still caps to the zoom that fits it");

  // 4. And the tolerance is bounded: a canvas 2 px shorter than the stored window drops the step,
  //    because the box no longer fits by more than the 1/1000-cell rounding error.
  const shorter = cameraForMacro(stored, { ...VIEW, viewH: 406 });
  expect(shorter.scale, 17, "a canvas 2 px shorter than the stored window drops to 17 instead of clipping the box");

  // 5. The centre is read the painter's way before and after a capped recall, so the cap moves the
  //    zoom and not the view.
  close(centreOf(big).x, 100, "the capped recall keeps its centre cell x", 0.5);
  close(centreOf(big).y, 60, "the capped recall keeps its centre cell y", 0.5);

  console.log("pb281 fit: zoom 18 survives an exact-viewport recall; a genuinely bigger box still caps");
}
