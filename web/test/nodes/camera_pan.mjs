// Node camera_pan: the pan is wired for every button and a pan is not an order (PB-083).
//
// The behavioural proof is the browser leg (tests/e2e/pb083-camera.mjs): it drags the map with the
// primary, middle and right buttons at dpr 1 and 2 and asserts the camera moved by the drag in
// canvas pixels, and that a click after a pan still selects. This file is the STRUCTURAL half, the
// same split in_match_controls.mjs uses: it makes the node suite red if the wiring is reverted,
// which the browser leg cannot do because tests/e2e/run.mjs does not run it.
//
// What it pins, on web/public/app.js:
//   1. pointerdown accepts the primary and middle buttons, not only the right one. A right-only
//      guard is exactly the defect: a trackpad has no right button, so no drag panned.
//   2. pointermove hands panBy a delta scaled to canvas pixels (`dx * ratio`). A raw client-pixel
//      delta makes the map lag the pointer by the device pixel ratio.
//   3. the click handler consults suppressClick, so the click that ends a pan is not an order.
//   4. the context menu is still prevented, so a right-drag cannot open it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, "..", "..", "public", "app.js"), "utf8");

function fail(message) {
  throw new Error(message);
}

export const name = "camera_pan";

// The listener body up to its closing `});`, comments stripped so prose cannot satisfy a pin.
function block(startPattern) {
  const at = SRC.search(startPattern);
  if (at < 0) fail("app.js has no " + startPattern + " listener");
  const rest = SRC.slice(at);
  const end = rest.indexOf("\n});");
  if (end < 0) fail("the " + startPattern + " listener is not closed");
  return rest.slice(0, end).replace(/\/\/[^\n]*/g, "");
}

export async function run({ fail: red }) {
  const down = block(/board\.addEventListener\("pointerdown"/);
  const move = block(/board\.addEventListener\("pointermove"/);
  const click = block(/board\.addEventListener\("click"/);

  if (/if\s*\(\s*event\.button\s*!==\s*2\s*\)\s*return/.test(down)) {
    red("pointerdown still returns for every button but the right one, so a trackpad cannot pan");
  }
  for (const button of ["0", "1", "2"]) {
    if (!new RegExp("button\\s*!==\\s*" + button + "\\b").test(down)) {
      red("pointerdown does not name button " + button + " - a drag with it is not accepted");
    }
  }
  if (/px\s*=\s*event\.clientX\s*-\s*panFrom\.x/.test(move) && !/\*\s*ratio/.test(move)) {
    red("pointermove pans by a raw client-pixel delta: the map lags the pointer at dpr > 1");
  }
  if (!/panBy\(viewForCanvas\(\),\s*dx\s*\*\s*ratio/.test(move.replace(/\n/g, " "))) {
    red("pointermove does not scale the drag into canvas pixels before panBy");
  }
  if (!/canvasScale\(\)/.test(move)) {
    red("pointermove does not read the canvas scale");
  }
  if (!/suppressClick/.test(click)) {
    red("the click handler does not consult suppressClick, so the click that ends a pan is an order");
  }
  if (!/contextmenu"[^\n]*preventDefault/.test(SRC)) {
    red("the context menu is not prevented: a right-drag opens it");
  }
  // The slop is what keeps a click a click. It must exist and it must gate the pan.
  if (!/PAN_SLOP\s*=\s*4/.test(SRC)) {
    red("there is no PAN_SLOP: every click would start a pan");
  }
}
