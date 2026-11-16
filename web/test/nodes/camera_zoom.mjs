// Camera zoom steps (node id: camera_zoom).
//
// T-019 follow-up (PM, room 6107 item 3): a '+' or '-' press is ONE real zoom step, not a factor
// that happens to round onto the same pixel and then gets clamped. The pin walks the presses the PM
// asked for and records every one in an op log:
//
//   * five '+' presses from scale 1, then five '-' presses back down to it, each delta exactly +1/-1;
//   * the first '+' press off the world fit: a real jump to the next scale, never a hold;
//   * a press at the floor and at the ceiling holds, and does not jump;
//   * the cell under the screen point stays under it, at every step.
//
// This is its own camera pin: it does not depend on the theme layer and the theme gate does not
// depend on it.
import { MAX_ZOOM, clampZoom, zoomStepBy } from "../../public/render.mjs";

export const name = "camera_zoom";

export async function run({ fail }) {
  function base(patch) {
    return Object.assign(
      { scale: 1, minScale: 1, left: 0, top: 0, viewW: 640, viewH: 272, boardW: 320, boardH: 136 },
      patch || {}
    );
  }

  const log = [];
  function press(view, key) {
    const before = view;
    const after = key === "+" ? zoomStepBy(view, 1, view.viewW / 2, view.viewH / 2)
      : zoomStepBy(view, -1, view.viewW / 2, view.viewH / 2);
    log.push({ key, before: before.scale, after: after.scale, delta: after.scale - before.scale });
    return after;
  }

  function expect(actual, wanted, label) {
    if (actual !== wanted) fail(label + ": got " + actual + ", wanted " + wanted);
  }

  // --- five '+' and five '-' presses from scale 1 ------------------------------------------------
  let view = base();
  for (let i = 0; i < 5; i++) view = press(view, "+");
  expect(view.scale, 6, "five '+' presses from scale 1 land on 6");
  for (let i = 0; i < 5; i++) view = press(view, "-");
  expect(view.scale, 1, "five '-' presses bring the camera back to scale 1");

  const plus = log.slice(0, 5);
  const minus = log.slice(5, 10);
  for (const [i, step] of plus.entries()) {
    if (step.delta !== 1) fail("'+' press " + (i + 1) + " moved " + step.delta + " scale, not 1 (op log " + JSON.stringify(step) + ")");
  }
  for (const [i, step] of minus.entries()) {
    if (step.delta !== -1) fail("'-' press " + (i + 1) + " moved " + step.delta + " scale, not -1 (op log " + JSON.stringify(step) + ")");
  }

  // --- the jump from the world fit to the first press --------------------------------------------
  const fit = base({ scale: 4, minScale: 4 });
  const firstIn = press(fit, "+");
  if (firstIn.scale !== 5) fail("the first '+' off the fit landed on " + firstIn.scale + ", wanted 5");
  const fitStep = log[log.length - 1];
  if (fitStep.delta !== 1) fail("the first '+' off the fit is a clamp, not a step (op log " + JSON.stringify(fitStep) + ")");
  const firstOut = press(firstIn, "-");
  expect(firstOut.scale, 4, "a '-' press returns to the fit");
  expect(press(firstOut, "-").scale, 4, "a '-' press at the fit is a hold");

  // --- the ends hold, and never jump -------------------------------------------------------------
  expect(press(base({ scale: 3, minScale: 3 }), "-").scale, 3, "'-' at the floor holds");
  expect(zoomStepBy(base({ scale: MAX_ZOOM }), 1, 320, 136).scale, MAX_ZOOM, "'+' at the ceiling holds");
  expect(zoomStepBy(base(), 0, 320, 136).scale, 1, "a zero direction is not a press");

  // --- the cell under the point stays under it ---------------------------------------------------
  // Scale 1 -> 2 about (400, 200): world x = 400, so the new left is 400 - 400*2 = -400.
  const anchored = zoomStepBy(base({ left: 32, top: 16 }), 1, 400, 200);
  const beforeWorld = (400 - 32) / 1;
  const afterWorld = (400 - anchored.left) / anchored.scale;
  if (Math.abs(beforeWorld - afterWorld) > 0.5) {
    fail("the press moved the world point under the screen point: " + beforeWorld + " -> " + afterWorld);
  }
  // clampZoom still owns the bounds; the step is only ever one inside them.
  expect(clampZoom(0, 1), 1, "clampZoom keeps the one-pixel floor");

  console.log("camera_zoom op log: " + JSON.stringify(log));
}
