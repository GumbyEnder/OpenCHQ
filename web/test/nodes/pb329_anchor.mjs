// PB-329: the toast seat is a function of the band it may not cover, and the page uses it.
//
// The defect (live 4088c33, measured by tests/e2e/pb329-probe.mjs): the anchor cleared the map's
// footer row and stopped there, so every toast sat 9.3 px into the legend above it at 1024x768,
// 1280x800 and 1440x900. The page leg grades the pixels; this node pins the arithmetic and the
// wiring, so a change to the rule is graded without a browser:
//
//   1. no band -> the stylesheet's own floor, untouched;
//   2. a band the toast already clears (the lobby: footer high on the page) -> floor, so nothing
//      moves where nothing was covered;
//   3. a band under the toast -> the seat goes above it with FOOT_GAP of clearance;
//   4. a taller band than the viewport can hold -> clamped, the toast's top never above MIN_TOP;
//   5. the page imports this module and puts #legend in the band (or the rule is decoration).
export const name = "pb329_anchor";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOAST_MIN_TOP, toastSeat } from "../../public/anchor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function near(got, want, message) {
  assert(Math.abs(got - want) < 0.01, message + " (got " + got + ", want " + want + ")");
}

export async function run() {
  // 1. no band: the CSS floor stands.
  near(toastSeat({ viewportHeight: 768, band: null, gap: 8, floor: 10, height: 39.2 }), 10,
    "no band keeps the match floor");

  // 2. the lobby at 1024x768: legend 541-584.7, footer to 631, toast 18+39.2 tall at the bottom.
  //    The toast's top (710.8) is below the band's bottom (631) - clear, so the floor stands.
  near(toastSeat({
    viewportHeight: 768, band: { top: 541, bottom: 631 }, gap: 8, floor: 18, height: 39.2,
  }), 18, "a band above the toast does not move it");

  // 2b. the same band scrolled ABOVE the viewport bottom but under the toast: still clear.
  near(toastSeat({
    viewportHeight: 768, band: { top: 400, bottom: 470 }, gap: 8, floor: 18, height: 39.2,
  }), 18, "a band the toast clears below is left alone");

  // 3. the match band at 1024x768 (legend 694.7-712.1, footer to 730). The old seat was 10 px: the
  //    toast's bottom edge landed at 758, 9.3 px INTO the legend's top when measured at 4088c33.
  const seat = toastSeat({
    viewportHeight: 768, band: { top: 694.7, bottom: 730 }, gap: 8, floor: 10, height: 39.2,
  });
  near(seat, 768 - 694.7 + 8, "the seat is band.top minus the gap");
  const bottom = 768 - seat;
  assert(bottom <= 694.7 - 8 + 0.01, "the toast's bottom edge clears the legend by the gap");
  assert(768 - seat - 39.2 >= 0, "the toast stays inside the viewport");

  // 3b. a taller toast clears the same band: the seat does not depend on the text.
  const tall = toastSeat({ viewportHeight: 768, band: { top: 694.7, bottom: 730 }, gap: 8, floor: 10, height: 70 });
  near(768 - tall, 768 - seat, "clearance is measured to the band, not to the height");

  // 4. a band that leaves no room: the clamp wins and the top edge sits at MIN_TOP.
  const squeezed = toastSeat({ viewportHeight: 300, band: { top: 120, bottom: 290 }, gap: 8, floor: 10, height: 200 });
  near(300 - squeezed - 200, TOAST_MIN_TOP, "the clamp keeps the toast's top on screen");

  // 5. wiring: the page imports the rule, and the band is built from #legend and the mapfoot row.
  const app = readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert(/import \{ toastSeat \} from "\.\/anchor\.mjs"/.test(app), "app.js imports toastSeat from anchor.mjs");
  assert(/add\(document\.getElementById\("legend"\)\)/.test(app), "the band includes #legend");
  assert(/toastSeat\(\{\s*viewportHeight: innerHeight, band, gap: FOOT_GAP, floor, height: flash\.offsetHeight/.test(app),
    "the flash seat is the rule's answer for the measured band");
}
