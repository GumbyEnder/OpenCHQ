// The original's bottom bar, in numbers measured off WORLD.PIC.
//
// The screen is 320x200 EGA. The map is 320x136 and starts at y=6 — rows 0-5 above it are black.
// Below the map, from y=142, is a black band with one bevelled box at (1,142) measuring 87x50:
// "TIME LEFT" over a bar. Everything here is a proportion of the 320 px screen width, so the band
// keeps the original's shape at any canvas size.
//
// Measured, not remembered: tools/sample_palette.py's sibling measurement in the Command HQ
// reference tree found the map area by matching terrain against the art (85% agreement at y=6) and
// the box by the grey bevel pixels, which occupy x 1..87 and y 142..191.

export const SCREEN = Object.freeze({ width: 320, height: 200, mapTop: 6, mapHeight: 136 });
export const CHROME_BOX = Object.freeze({ x: 1, y: 142, width: 87, height: 50 });
export const TIME_LEFT = "TIME LEFT";

const SPACE_MIN = 1;
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

// Geometry for a canvas whose map is `mapWidthPx` wide. The box keeps 87/320 of that width and 50
// of the same units of height — the original never scaled it independently.
export function chromeGeometry(mapWidthPx) {
  const width = Math.max(SPACE_MIN, Number(mapWidthPx) || 0);
  const scale = width / SCREEN.width;
  return {
    scale,
    boxWidth: Math.round(CHROME_BOX.width * scale),
    boxHeight: Math.round(CHROME_BOX.height * scale),
    boxLeft: Math.round(CHROME_BOX.x * scale),
    label: TIME_LEFT,
  };
}

// A round runs down from full to empty. `elapsedMs` is time since the round began; the result is
// the fraction of the bar still lit, so the box empties as the round ends.
export function roundFraction(roundSeconds, elapsedMs) {
  const length = Number(roundSeconds) * 1000;
  if (!Number.isFinite(length) || length <= 0) return 0;
  return clamp01(1 - (Number(elapsedMs) || 0) / length);
}

// What the box says besides the bar. The countdown comes from the seat's own view (`seat.payIn`),
// so the page never computes a payday the server did not.
export function timeLeftText(seat, roundSeconds) {
  const parts = [TIME_LEFT];
  const payIn = Number(seat && seat.payIn);
  if (Number.isFinite(payIn) && payIn >= 0) {
    parts.push(payIn === 0 ? "PAY NOW" : "PAY IN " + payIn);
  }
  const length = Number(roundSeconds);
  if (Number.isFinite(length) && length > 0) {
    parts.push(Math.round(length) + "S ROUND");
  }
  return parts.join("  ");
}
