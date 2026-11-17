// Node ownership_city_ink: a city mark has to read over the fill it sits on (PB-098).
//
// Show Ownership paints the region's owner colour over the ground the terrain view drew its cities
// on, so paintSiteTicks restamps every site over the fill (PB-068). It stamped them in the module
// constant PALETTE — Classic's black city square and yellow capital — whatever theme was active.
// On Classic that is fine (black on #5555ff, or on #ffffff for unheld ground). On Dark tactical the
// same black landed on #2a2f36 unheld ground and #1b3f66 blue ground with a #0b0f14 casing, so it
// had neither interior nor rim contrast and disappeared: the PM's hand-check at 0764ff9 found no
// non-capital cities in Show Ownership on the default theme (PB-098).
//
// The contract pinned here: paintSiteTicks takes the ink for a mark over the ownership fill from the
// THEME's terrain table (terrainInk), that ink is not any of the ownership fills, and it reads
// against every one of them. The mutant is one argument: drop `theme` from the call and C's cities
// come back #000000, which fails the first two assertions.
//
// A mark over a BADGE is a different ground: a corner notch on the badge's light interior, measured
// in PB-029/T-014 AC7 as Classic's black with a light rim. That notch must NOT take C's white city
// ink, or the same defect reappears mirrored on a light background.
import { PALETTE, fitViewport, paintMatch, paintSiteTicks } from "../../public/render.mjs";
import { terrainInk, themeById } from "../../public/themes.mjs";

function fail(message) {
  throw new Error(message);
}

function recorder() {
  const fills = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1,
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: String(this.fillStyle).toLowerCase() }); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, save: noop, restore: noop, fillText: noop,
    setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, fills };
}

const hex = (value) => String(value).toLowerCase();

// WCAG relative luminance and contrast ratio: the question is "can a player see this mark on that
// ground", not "are the bytes different". Two distinct hex values can be equally dark.
function luminance(value) {
  const m = /^#([0-9a-f]{6})$/.exec(hex(value));
  if (!m) fail("not a six-digit hex colour: " + value);
  const v = m[1];
  const channel = (i) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The ground a city actually stands on: the three ownership fills and the sea. The per-side EDGE
// shades are one-cell borders, and a mark there is carried by its casing.
function fillSet(theme) {
  const own = theme.ownership;
  return [own.blue, own.red, own.neutral, own.sea];
}

const SITES = [
  { id: "town", name: "Town", x: 40, y: 60, type: 0 },
  { id: "seat", name: "Seat", x: 70, y: 60, type: 1 },
];

export const name = "ownership_city_ink";

export async function run() {
  const view = { ...fitViewport(640, 272), scale: 6, left: 0, top: 0, viewW: 3840, viewH: 1632 };
  const seen = {};

  for (const themeId of ["C", "D"]) {
    const theme = themeById(themeId);
    const city = terrainInk(theme, "city");
    const capital = terrainInk(theme, "capital");
    if (!city || !capital) fail(themeId + ": the theme has no city/capital terrain ink");
    if (city === capital) fail(themeId + ": a city and a capital cannot share one ink");

    const { ctx, fills } = recorder();
    const drawn = paintSiteTicks(ctx, SITES, [], view, { everyVisible: true, theme });
    if (drawn !== SITES.length) fail(themeId + ": expected " + SITES.length + " site marks, drew " + drawn);

    const colours = fills.map((fill) => fill.color);
    if (!colours.includes(hex(city))) {
      fail(themeId + ": the city mark is not in this theme's terrain city ink " + city +
        " (drawn: " + [...new Set(colours)].join(",") + ")");
    }
    if (!colours.includes(hex(capital))) {
      fail(themeId + ": the capital mark is not in this theme's terrain capital ink " + capital);
    }

    // The PM's assertion, in node form: the ink the page puts on a city cell is NOT the ownership
    // fill that cell already has. Equality here is the whole defect — a mark the colour of its
    // ground is not a mark.
    // A city has nothing but its square, so it needs the full 3:1 against every fill. A capital
    // only has to differ: Classic's measured capital square is #ffff55, which sits at 1.07:1 on
    // Classic's own white neutral ground, and the capital's identification rides on its ring and
    // name (paintCapitals), not on the square's contrast. Grading the capital at 3:1 would demand
    // changing the original's palette.
    for (const ink of [city, capital]) {
      for (const behind of fillSet(theme)) {
        if (hex(ink) === hex(behind)) {
          fail(themeId + ": the site ink equals the ownership fill " + behind + " — the mark is invisible");
        }
      }
    }
    for (const behind of fillSet(theme)) {
      const ratio = contrast(city, behind);
      if (ratio < 3) {
        fail(themeId + ": the city ink " + city + " on ownership fill " + behind + " reads " +
          ratio.toFixed(2) + ":1, below the 3:1 a board mark needs");
      }
    }

    // The casing is the theme's plate ink, and every ink square is at least 2x2.
    const theme_casing = hex(theme.labelPlate);
    if (!colours.includes(theme_casing)) {
      fail(themeId + ": the site casing is not the theme's labelPlate " + theme.labelPlate);
    }
    for (const fill of fills) {
      if (fill.color === theme_casing) continue;
      if (fill.w < 2 || fill.h < 2) fail(themeId + ": a site ink square collapsed to " + fill.w + "x" + fill.h);
    }
    seen[themeId] = { city, capital, drawn };
  }

  if (seen.C.city === seen.D.city) fail("the two themes are supposed to draw different city inks");

  // Over a badge the mark is a notch on the badge's LIGHT rim, and the measured solution there is
  // Classic's black (PB-029/T-014 AC7). Theme C's white city would disappear on #f2f5fb, so the
  // notch must NOT take the theme's fill ink.
  const { ctx: nctx, fills: nfills } = recorder();
  const notchDrawn = paintSiteTicks(nctx, [SITES[0]], [{ x: SITES[0].x, y: SITES[0].y }], view,
    { everyVisible: false, theme: themeById("C") });
  if (notchDrawn !== 1) fail("a badge-covered site should still get its notch, drew " + notchDrawn);
  if (!nfills.some((fill) => fill.color === hex(PALETTE.city))) {
    fail("the badge notch is not in Classic's black (" + nfills.map((f) => f.color).join(",") + ")");
  }
  if (nfills.some((fill) => fill.color === hex(terrainInk(themeById("C"), "city")))) {
    fail("the badge notch took C's white city ink; it would vanish on the badge's light rim");
  }

  // --- the wiring, not only the painter: paintMatch has to pass the theme through ---------------
  // The 0764ff9 defect lived in the CALL, not inside paintSiteTicks: the argument was absent, so
  // the page fell back to PALETTE whatever theme was on screen. A node test that only ever calls
  // paintSiteTicks WITH a theme cannot see that — delete `theme` from the paintMatch call and every
  // assertion above still passes. So drive a whole frame and read its recorded fills.
  const frameBoard = { source: "extract", width: 320, height: 136, terrain: ["ocean", "plain"],
    cells: new Array(320 * 136).fill(1) };
  const frameRoom = { sites: SITES, pieces: [], era: "1942", round: 1 };
  const frameView = { ...fitViewport(640, 272), scale: 6, left: 0, top: 0, viewW: 3840, viewH: 1632 };
  const frames = {};
  for (const themeId of ["C", "D"]) {
    const { ctx: fctx, fills: ffills } = recorder();
    const painted = paintMatch(fctx, frameBoard, frameRoom,
      { view: frameView, viewMode: "political", themeId });
    if (painted.mode === "schematic") fail(themeId + ": the ownership frame fell back to " + painted.mode);
    const want = hex(terrainInk(themeById(themeId), "city"));
    const colours = ffills.map((fill) => fill.color);
    if (!colours.includes(want)) {
      fail(themeId + ": a whole Show Ownership frame does not paint the theme's city ink " + want +
        " — paintMatch is not passing the theme to paintSiteTicks");
    }
    // No piece stands on a site here, so the only city marks on this frame are paintSiteTicks'.
    frames[themeId] = { city: want, drawn: painted.siteTicks };
  }
  if (frames.C.city === frames.D.city) fail("paintMatch drew the same city ink on both themes");

  // Why PB-098 existed: the old constant is legible on Classic's bright fills and not on C's.
  const cFills = fillSet(themeById("C"));
  const worst = Math.min(...cFills.map((behind) => contrast(PALETTE.city, behind)));
  if (worst >= 3) {
    fail("PALETTE.city no longer disappears on theme C (" + worst.toFixed(2) +
      ":1) — re-measure before removing the per-theme ink");
  }
  const classicWorst = Math.min(...fillSet(themeById("D")).map((behind) => contrast(PALETTE.city, behind)));
  if (classicWorst < 3) fail("PALETTE.city is not legible on Classic either: " + classicWorst.toFixed(2) + ":1");
}
