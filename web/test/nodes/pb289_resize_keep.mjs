// PB-289 node pin: a WINDOW resize keeps the view the player had; Fit is the only thing that drops it.
//
// The reported page bug (game 9794, PM 9799 s3): the resize listener called refit(), so a window
// resize threw away a zoomed or recalled camera and landed on the whole-world fit. refit() clears
// userCamera on purpose - it IS the Fit control (key 0, camFit button) - so the resize was running
// the Fit command behind the player's back. PB-280's leg and PB-281's pin both stayed green through
// it because neither resizes the window after setting a camera: PB-280 changes the canvas box
// through the stage, and PB-281 stores and recalls at one viewport.
//
// Two camera rules, two functions, because the tickets pin different things:
//   keepCamera      (PB-280, used by sizeCanvas): the canvas changed shape under the same window - a
//                   band row arriving, a panel taking height. Keeps the centre cell AND the zoom,
//                   floored by the new fit; the span may be cropped. PB-280's page leg pins this.
//   keepSpanCamera  (PB-289, used by the resize path): the player changed how much world is on
//                   screen, so the VIEW is kept - centre cell and cell span - which means the zoom
//                   drops to PB-281's "largest that fits" when the window got smaller. Same function
//                   (boxCamera) a macro recall uses, so a resize and a recall cannot disagree.
//
// Arms:
//   1. PB-280 unchanged: a 960x408 -> 640x272 canvas change keeps zoom 18 and the centre cell 164/34;
//   2. PB-289 at the AC's resize: 1280x800 -> 1024x768 leaves the canvas at 960x408 (whole cells), so
//      the span 53.333 x 22.667 fits at 18 - the ONE number the card states - with the fractional
//      centre 164.5/34 still under the middle pixel, read back through cellToPixel/pixelToCell;
//   3. PB-289 on a canvas too small for the span: 640x272 (an 800x600 window) reads 12, the largest
//      zoom that holds the span - the same 12 PB-281's page leg measures for this box;
//   4. a canvas that GROWS does not inflate the zoom - keeping is not fitting;
//   5. the whole-world fit is still the floor (PB-067) for both; the kept camera's ceiling is still
//      the literal sizeCanvas used, and the span camera's is the zoom ceiling the steps use;
//   6. fitCamera(fit) is the Fit landing - the whole world, centre 160,68 - what a resize with NO
//      user camera must still produce, and what the control (refit-on-resize) produces for every
//      camera;
//   7. keepSpanCamera and cameraForMacro read one number for one box, so the rules cannot drift.
import {
  KEEP_ZOOM_CEILING, MAX_ZOOM, MIN_ZOOM, boxCamera, cellToPixel, fitCamera, fitViewport, keepCamera,
  keepSpanCamera, pixelToCell,
} from "../../public/render.mjs";
import { cameraForMacro } from "../../public/macros.mjs";

export const name = "pb289_resize_keep";

// The repro's own numbers (PB-281's leg at 1280x800, preset 1): a 960x408 canvas at zoom 18 with
// the stored centre at cell (164.5, 34).
const STORED = { scale: 18, minScale: 3, left: -2481, top: -408, viewW: 960, viewH: 408, boardW: 320, boardH: 136 };
const BOARD = { boardW: 320, boardH: 136 };

export async function run({ fail }) {
  const expect = (actual, wanted, label) => {
    if (actual !== wanted) fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(wanted));
  };
  const close = (actual, wanted, label, tol) => {
    if (!(Math.abs(actual - wanted) <= tol)) {
      fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(wanted) + " +/- " + tol);
    }
  };
  const centreCell = (camera) => pixelToCell(camera.viewW / 2, camera.viewH / 2, camera);
  const centre = (camera) => ({ x: (camera.viewW / 2 - camera.left) / camera.scale, y: (camera.viewH / 2 - camera.top) / camera.scale });
  // The largest whole zoom at which a cell span still fits a canvas: derived here from the span and
  // the canvas, not read out of boxCamera, so the pin cannot agree with a wrong cap by construction.
  const fitOf = (w, h, canvasW, canvasH) => Math.max(1, Math.floor(Math.min((canvasW + 0.75) / w, (canvasH + 0.75) / h) + 1e-9));
  const sameCell = (a, b) => a.x === b.x && a.y === b.y;

  const before = centreCell(STORED);
  if (before.x !== 164 || before.y !== 34) fail("the stored view's centre cell reads " + JSON.stringify(before) + ", wanted 164,34");
  const span = { w: STORED.viewW / STORED.scale, h: STORED.viewH / STORED.scale };
  const small = fitViewport(640, 272, BOARD.boardW, BOARD.boardH, 64);
  const same = fitViewport(960, 408, BOARD.boardW, BOARD.boardH, 64);
  const bigger = fitViewport(1920, 816, BOARD.boardW, BOARD.boardH, 64);

  // 1. PB-280 unchanged: the sizeCanvas rule keeps the zoom even when the span no longer fits.
  const cropped = keepCamera(STORED, small);
  expect(cropped.scale, 18, "PB-280's keepCamera keeps zoom 18 through a 640x272 canvas change");
  if (!sameCell(centreCell(cropped), before)) fail("PB-280's keepCamera moved the centre cell to " + JSON.stringify(centreCell(cropped)));
  expect(keepCamera({ ...STORED, scale: 80 }, small).scale, KEEP_ZOOM_CEILING, "keepCamera's ceiling is still the literal sizeCanvas used");
  expect(keepCamera({ ...STORED, scale: 2 }, bigger).scale, bigger.scale, "keepCamera's floor is still the whole-world fit");

  // 2. PB-289 at the AC's resize: the canvas is unchanged, the span fits at 18.
  const afterAcResize = keepSpanCamera(STORED, same);
  expect(afterAcResize.scale, 18, "the 1280x800 -> 1024x768 resize keeps zoom 18");
  expect(afterAcResize.scale, fitOf(span.w, span.h, 960, 408), "the kept zoom is the fit of the span on that canvas");
  if (!sameCell(centreCell(afterAcResize), before)) fail("the AC resize moved the centre cell");
  close(centre(afterAcResize).x, 164.5, "the kept camera is centred on cell 164.5", 0.02);
  close(centre(afterAcResize).y, 34, "the kept camera is centred on row 34", 0.02);
  expect(afterAcResize.minScale, Math.max(MIN_ZOOM, same.scale), "the kept camera's floor is the new whole-world fit");
  // The painter agrees: cell 164 draws half a cell left of the middle pixel.
  close(cellToPixel(164, 33, afterAcResize).x, afterAcResize.viewW / 2 - afterAcResize.scale / 2,
    "cell 164 draws half a cell left of the middle pixel", afterAcResize.scale);

  // 3. a canvas too small to hold the span: 640x272 reads 12, the largest zoom that does.
  const capped = keepSpanCamera(STORED, small);
  expect(capped.scale, 12, "the 640x272 canvas takes zoom 12, the largest that holds the 53.333x22.667 span");
  expect(capped.scale, fitOf(span.w, span.h, 640, 272), "the capped zoom is the fit of the span on the smaller canvas");
  if (!sameCell(centreCell(capped), before)) fail("the centre cell moved when the canvas shrank: " + JSON.stringify(centreCell(capped)));

  // 4. keeping is not fitting: a BIGGER canvas must not inflate the zoom.
  const grown = keepSpanCamera(STORED, bigger);
  expect(grown.scale, 18, "a larger canvas keeps the player's 18 instead of inflating towards the fit");
  if (!sameCell(centreCell(grown), before)) fail("the centre cell moved across a growth");

  // 5. floors and ceilings for the span camera.
  expect(keepSpanCamera({ ...STORED, scale: 2 }, bigger).scale, bigger.scale, "a span camera below the new fit comes up to the fit");
  expect(keepSpanCamera({ ...STORED, scale: 80 }, bigger).scale, MAX_ZOOM, "a span camera above the ceiling clamps to MAX_ZOOM");

  // 6. Fit is unchanged and is a whole world, centred on the board.
  const fit = fitCamera(fitViewport(960, 408, BOARD.boardW, BOARD.boardH, 64));
  expect(fit.scale, 3, "Fit on the 1280x800 canvas reads zoom 3");
  expect(fit.minScale, 3, "Fit's floor reads its own 3");
  close(centre(fit).x, 160, "Fit is centred on column 160", 0.5);
  close(centre(fit).y, 68, "Fit is centred on row 68", 1);
  expect(keepSpanCamera(null, small).scale, small.scale, "keepSpanCamera with no camera lands on the fit");
  expect(keepCamera(null, small).scale, small.scale, "keepCamera with no camera lands on the fit");

  // 7. one box, one number: the span camera and a macro recall agree.
  expect(cameraForMacro({ cx: 164.5, cy: 34, w: 53.333, h: 22.667, scale: 18 }, small).scale, capped.scale,
    "the macro recall and the resize read one zoom for one box");
  expect(boxCamera({ cx: 164.5, cy: 34, w: span.w, h: span.h, scale: 18 }, small).scale, capped.scale,
    "keepSpanCamera's span and boxCamera's box agree on the small canvas");

  console.log("pb289 resize: 18 at 960x408 / 12 at 640x272, cell 164.5,34 held, PB-280's crop untouched; Fit is the only drop");
}
