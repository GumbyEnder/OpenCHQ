// Node bottom_chrome: the original's bottom bar, measured rather than remembered.
//
// WORLD.PIC is 320x200. The map is 320x136 from y=6; below it, from y=142, a black band holds one
// bevelled box, 87x50 at (1,142), reading TIME LEFT over a bar. These assertions pin the
// proportions at several canvas widths, and pin the bar to the round clock the server reports.
import {
  CHROME_BOX,
  SCREEN,
  TIME_LEFT,
  chromeGeometry,
  roundFraction,
  timeLeftText,
} from "../../public/chrome.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}

function near(message, actual, expected, slack = 1) {
  if (Math.abs(Number(actual) - Number(expected)) > slack) {
    fail(message + ": " + actual + " is not within " + slack + " of " + expected);
  }
}

export const name = "chrome";

export async function run() {
  // --- the geometry is the picture's ----------------------------------------
  eq("the screen is the original's", SCREEN.width + "x" + SCREEN.height, "320x200");
  eq("the map starts at y=6", SCREEN.mapTop, 6);
  eq("the map is 136 rows", SCREEN.mapHeight, 136);
  eq("the box is the measured one", CHROME_BOX.width + "x" + CHROME_BOX.height, "87x50");
  eq("the box sits at the measured origin", CHROME_BOX.x + "," + CHROME_BOX.y, "1,142");
  eq("the label is the original's", TIME_LEFT, "TIME LEFT");

  for (const mapWidth of [320, 640, 762, 1280]) {
    const g = chromeGeometry(mapWidth);
    // 87/320 and 50/320 of the map width, to within a pixel of rounding.
    near("the box keeps 87/320 of the map width at " + mapWidth, g.boxWidth, (mapWidth * 87) / 320, 1);
    near("the box keeps the width/height ratio at " + mapWidth, g.boxHeight / g.boxWidth, 50 / 87, 0.02);
    near("the box keeps its left inset at " + mapWidth, g.boxLeft, mapWidth / 320, 1);
    eq("the box still says TIME LEFT at " + mapWidth, g.label, "TIME LEFT");
  }

  // A box that shrinks with the canvas must never become zero-width or negative.
  const tiny = chromeGeometry(4);
  if (tiny.boxWidth < 1 || tiny.boxHeight < 1) fail("a small canvas gives a box with no size");
  if (!Number.isFinite(chromeGeometry(0).boxWidth)) fail("a zero-width canvas gives a non-finite box");

  // --- the bar is the round clock -------------------------------------------
  eq("a fresh round is a full bar", roundFraction(5, 0), 1);
  eq("half a round is half a bar", roundFraction(5, 2500), 0.5);
  eq("the end of a round is an empty bar", roundFraction(5, 5000), 0);
  eq("past the end stays empty", roundFraction(5, 9000), 0);
  eq("no round length means no bar", roundFraction(0, 100), 0);
  eq("a nonsense length means no bar", roundFraction("x", 100), 0);
  if (!(roundFraction(5, 1000) > roundFraction(5, 4000))) fail("the bar does not run down with time");

  // --- what the box says -----------------------------------------------------
  if (!/PAY IN 6/.test(timeLeftText({ payIn: 6 }, 5))) fail("the box does not name the payday");
  if (!/PAY NOW/.test(timeLeftText({ payIn: 0 }, 5))) fail("a payment due this round is not announced");
  if (!/5S ROUND/.test(timeLeftText({ payIn: 6 }, 5))) fail("the box does not name the round length");
  eq("no seat, no invented countdown", /PAY IN/.test(timeLeftText(null, 5)), false);
  eq("no round length, no invented number", /ROUND/.test(timeLeftText({ payIn: 3 }, null)), false);
}
