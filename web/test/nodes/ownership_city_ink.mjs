// Node ownership_city_ink: a city mark has to read over the fill it sits on (PB-098).
//
// Show Ownership paints the region's owner colour over the ground the terrain view drew its cities
// on, so paintSiteTicks restamps every site over the fill (PB-068). It stamped them in the module
// constant PALETTE — Classic's black city square and yellow capital — whatever theme was active.
// On Classic that is fine (black on #5555ff). On Dark tactical the same black landed on #2a2f36
// unheld ground and #1b3f66 blue ground and disappeared, so the PM's hand-check at 0764ff9 found
// no non-capital cities in Show Ownership on the default theme (FB-098).
//
// The contract pinned here: paintSiteTicks draws each site in the ACTIVE THEME's terrain ink when
// the caller passes one, and that ink has usable contrast against every fill the ownership view can
// put behind it. The mutant is one line: drop `inks` from the call (or the fallback in the
// function) and theme C's cities come back black-on-dark, which fails both assertions.
import { PALETTE, fitViewport, paintSiteTicks } from "../../public/render.mjs";
import { themeById } from "../../public/themes.mjs";

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

// WCAG relative luminance and contrast ratio: the question is "can a player see this mark on that
// ground", not "are the bytes different". Distinct hex values can be equally dark.
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/.exec(String(hex).toLowerCase());
  if (!m) fail("not a six-digit hex colour: " + hex);
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

// The ground a city actually stands on: the three fills and the sea. The per-side EDGE shades are
// one-cell borders — a city mark on one is carried by its casing, and demanding full contrast there
// would force Classic's black town square to change, which is the palette the original drew.
function fillSet(theme) {
  const own = theme.ownership;
  return [own.blue, own.red, own.neutral, own.sea];
}

// A tick is a dark casing with the ink square inside it, so it is legible when EITHER the ink reads
// against the ground OR the casing does (and the ink reads against the casing). That is what lets
// C's white city hold on its bright #35d0ff coastal edge without giving up on the real defect:
// black-on-dark fails all three legs at once.
const CASING = "#0b0f14";

function legible(ink, behind) {
  return Math.max(contrast(ink, behind), Math.min(contrast(CASING, behind), contrast(ink, CASING)));
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
    const { ctx, fills } = recorder();
    const drawn = paintSiteTicks(ctx, SITES, [], view, {
      everyVisible: true,
      inks: { city: theme.terrain.city, capital: theme.terrain.capital },
    });
    if (drawn !== SITES.length) fail(themeId + ": expected " + SITES.length + " site marks, drew " + drawn);

    const colours = fills.map((fill) => fill.color);
    if (!colours.includes(theme.terrain.city.toLowerCase())) {
      fail(themeId + ": the city mark is not in this theme's terrain city ink " +
        theme.terrain.city + " (drawn: " + [...new Set(colours)].join(",") + ")");
    }
    if (!colours.includes(theme.terrain.capital.toLowerCase())) {
      fail(themeId + ": the capital mark is not in this theme's terrain capital ink " + theme.terrain.capital);
    }

    for (const ink of [theme.terrain.city, theme.terrain.capital]) {
      for (const behind of fillSet(theme)) {
        const ratio = legible(ink, behind);
        if (ratio < 3) {
          fail(themeId + ": " + ink + " over ownership fill " + behind + " (casing " + CASING +
            ") reads " + ratio.toFixed(2) + ":1, below the 3:1 a board mark needs");
        }
      }
    }

    // The fill grammar of a tick: a dark casing, then the ink square.
    const casing = fills.filter((fill) => fill.color === "#0b0f14");
    if (casing.length !== SITES.length) fail(themeId + ": each site mark should carry its dark casing");
    for (const fill of fills) {
      if (fill.color === "#0b0f14") continue;
      if (fill.w < 2 || fill.h < 2) fail(themeId + ": a site ink square collapsed to " + fill.w + "x" + fill.h);
    }
    seen[themeId] = { city: theme.terrain.city, capital: theme.terrain.capital, drawn };
  }

  if (seen.C.city === seen.D.city) fail("the two themes are supposed to draw different city inks");

  // Over a badge the mark is a notch on the badge's LIGHT rim, and the measured solution there is
  // Classic's black (PB-029/T-014 AC7). Theme C's white city would disappear on #f2f5fb, so the
  // notch must NOT take the theme's fill ink.
  const { ctx: nctx, fills: nfills } = recorder();
  const notchDrawn = paintSiteTicks(nctx, [SITES[0]], [{ x: SITES[0].x, y: SITES[0].y }], view,
    { everyVisible: false, inks: { city: themeById("C").terrain.city, capital: themeById("C").terrain.capital } });
  if (notchDrawn !== 1) fail("a badge-covered site should still get its notch, drew " + notchDrawn);
  if (!nfills.some((fill) => fill.color === PALETTE.city.toLowerCase())) {
    fail("the badge notch is not in Classic's black (" + nfills.map((f) => f.color).join(",") + ")");
  }
  if (nfills.some((fill) => fill.color === themeById("C").terrain.city.toLowerCase())) {
    fail("the badge notch took C's white city ink; it would vanish on the badge's light rim");
  }

  // Why PB-098 existed: the old constant is legible on Classic's bright fills and not on C's.
  const cFills = fillSet(themeById("C"));
  const worst = Math.min(...cFills.map((behind) => legible(PALETTE.city, behind)));
  if (worst >= 3) {
    fail("PALETTE.city no longer disappears on theme C (" + worst.toFixed(2) +
      ":1) — re-measure before removing the per-theme ink");
  }
  const classicWorst = Math.min(...fillSet(themeById("D")).map((behind) => legible(PALETTE.city, behind)));
  if (classicWorst < 3) fail("PALETTE.city is not legible on Classic either: " + classicWorst.toFixed(2) + ":1");
}
