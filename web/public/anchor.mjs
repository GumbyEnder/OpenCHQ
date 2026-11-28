// PB-329: where a transient toast sits when a block of the page must stay readable.
//
// The page has two toasts: the bottom message bar (`#flash`) and the finished-match line
// (`#result`, PB-137). Both are `position: fixed`, so their seat is a number of pixels above the
// viewport floor -- and the floor is not the same thing as "clear of the map's footer". At
// 1024x768 the anchored seat cleared the footer row but still sat 9.3 px into the legend above it
// (measured at 4088c33, all three widths). This module is the rule, kept out of the DOM so a node
// test can grade it without a browser:
//
//   seat = the CSS floor                         when the toast already clears `band`
//   seat = viewport - band.top + gap             when it does not (the toast stacks above the band)
//   seat = viewport - height - MIN_TOP           as the last resort on a short viewport
//
// `band` is the union of the boxes the toast may not cover, in viewport coordinates. Clearing can
// happen on either side: in the lobby the footer sits high on the page, so the default floor is
// already BELOW the band and nothing moves.

/** The toast's top edge never rides higher than this, however short the viewport. */
export const TOAST_MIN_TOP = 4;

/**
 * @param {{viewportHeight:number, band:{top:number,bottom:number}|null, gap:number,
 *          floor:number, height:number}} spec
 * @returns {number} the toast's `bottom` offset in px (css pixels, fractional allowed)
 */
export function toastSeat(spec) {
  const vh = Number(spec && spec.viewportHeight);
  const floor = Number(spec && spec.floor);
  const gap = Number(spec && spec.gap) || 0;
  const height = Number(spec && spec.height) > 0 ? Number(spec.height) : 0;
  if (!Number.isFinite(vh) || !Number.isFinite(floor)) return 0;
  const band = spec && spec.band;
  if (!band || !Number.isFinite(band.top) || !Number.isFinite(band.bottom)) return floor;
  const toastTop = vh - floor - height;
  const toastBottom = vh - floor;
  // Below the band (lobby at 1440) or above it (a band that has scrolled under the toast): clear.
  if (toastTop >= band.bottom || toastBottom <= band.top) return floor;
  const above = vh - band.top + gap;
  const cap = vh - height - TOAST_MIN_TOP;
  return Math.min(Math.max(above, floor), Math.max(cap, 0));
}
