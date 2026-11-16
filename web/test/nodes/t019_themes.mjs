// T-019 selectable map themes (node id: t019_themes).
//
// Two questions, both answered without a browser:
//
//   1. Is a theme only ink? Paint one board and one room frame twice, in the dark tactical theme and
//      in Classic, and require the payload, the piece positions, the counts, the labels and the
//      layer ORDER to be identical - only the colours may differ. That is AC1 ("game state is
//      identical across the shipped themes") in the form this repo can prove: the painter is a pure
//      function of the frame it is given, so the frame cannot move because of what it is painted in.
//   2. Do the PB-066/067/068/069 fixes bite? The camera floor, the seam copies of a route, the
//      ownership border rule, the placement box and the label placement are all pure helpers, so
//      each one is measured here rather than asserted in prose.
import {
  BOARD_H,
  BOARD_W,
  capitalLabels,
  clampZoom,
  fitViewport,
  ownershipRaster,
  paintMatch,
  paintPlacement,
  paintPreview,
  paintSiteTicks,
  visibleLabels,
  zoomAt,
} from "../../public/render.mjs";
import { readFileSync } from "node:fs";
import { DEFAULT_THEME, THEMES, isThemeId, nextThemeId, ownershipPalette, resolveTheme, terrainInk, themeById } from "../../public/themes.mjs";

function recorder() {
  const fills = [];
  const strokes = [];
  const moves = [];
  const texts = [];
  const ctx = {
    _fill: "",
    _stroke: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    set fillStyle(value) {
      this._fill = value;
    },
    get fillStyle() {
      return this._fill;
    },
    set strokeStyle(value) {
      this._stroke = value;
    },
    get strokeStyle() {
      return this._stroke;
    },
    fillRect(x, y, w, h) {
      fills.push({ x, y, w, h, color: this._fill });
    },
    strokeRect(x, y, w, h) {
      strokes.push({ x, y, w, h, color: this._stroke, lineWidth: this.lineWidth });
    },
    clearRect() {},
    beginPath() {},
    closePath() {},
    rect() {},
    arc() {},
    moveTo(x, y) {
      moves.push({ x, y });
    },
    lineTo(x, y) {
      moves.push({ x, y });
    },
    fill() {},
    stroke() {},
    fillText(text, x, y) {
      texts.push({ text, x, y, color: this._fill });
    },
  };
  return { ctx, fills, strokes, moves, texts };
}

function eq(fail, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

function ok(fail, label, value) {
  if (!value) fail(label);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// A real-shaped board: every terrain the themes paint, on a grid small enough to reason about.
const TERRAIN = ["ocean", "shallows", "plain", "forest", "desert", "mountain", "polar", "city", "capital", "lake"];
function board() {
  const cells = [];
  for (let i = 0; i < BOARD_W * BOARD_H; i++) {
    const x = i % BOARD_W;
    const y = Math.floor(i / BOARD_W);
    // A land mass in the middle-left, water everywhere else, cities sprinkled on the land.
    const land = x > 40 && x < 150 && y > 20 && y < 110;
    if (!land) cells.push(x % 7 === 0 ? 1 : 0);
    else if ((x + y) % 23 === 0) cells.push(7);
    else cells.push(2 + (x % 4));
  }
  return { source: "extract", width: BOARD_W, height: BOARD_H, terrain: TERRAIN, cells };
}

const SITES = [
  { id: "w", name: "Washington", x: 79, y: 44, type: 1, owner: "blue" },
  { id: "l", name: "London", x: 148, y: 40, type: 1, owner: "blue" },
  { id: "b", name: "Berlin", x: 163, y: 38, type: 1, owner: "red" },
  { id: "p", name: "Paris", x: 157, y: 44, type: 2, owner: "blue" },
];

function room() {
  return {
    you: "blue",
    round: 7,
    clock: "held",
    era: "1986",
    sites: SITES.map((site) => ({ ...site })),
    pieces: [
      { id: "blue:land", side: "blue", kind: "infantry", domain: "land", x: 79, y: 44, strength: 20 },
      { id: "blue:sea", side: "blue", kind: "destroyer", domain: "sea", x: 60, y: 90, strength: 30 },
      { id: "red:land", side: "red", kind: "infantry", domain: "land", x: 163, y: 38, strength: 18,
        path: [{ x: 164, y: 38 }, { x: 165, y: 39 }] },
    ],
    ownership: null,
  };
}

export const name = "t019_themes";

export async function run(ctx) {
  const { fail } = ctx;

  // --- the theme table is data, and the default is the dark one (D-022) -----------------------
  eq(fail, "two themes ship", THEMES.map((theme) => theme.id), ["C", "D"]);
  eq(fail, "C is the first-load default", DEFAULT_THEME, "C");
  eq(fail, "D is the Classic option", themeById("D").classic, true);
  eq(fail, "C is not Classic", themeById("C").classic, false);
  eq(fail, "an unknown id falls back to the default", themeById("zzz").id, "C");
  eq(fail, "an unknown saved preference is not a theme", isThemeId("zzz"), false);
  eq(fail, "C switches to D", nextThemeId("C"), "D");
  eq(fail, "D switches back to C", nextThemeId("D"), "C");
  for (const theme of THEMES) {
    for (const terrain of ["ocean", "plain", "city", "capital"]) {
      ok(fail, theme.id + " paints " + terrain, Boolean(terrainInk(theme, terrain)));
    }
    eq(fail, theme.id + " has an ownership table", typeof ownershipPalette(theme).edge.blue, "string");
  }
  // --- D-022 in the form the PM asked for: an EMPTY localStorage opens on C -------------------
  // The page's first-load decision is `resolveTheme(localStorage.getItem(...))`, so the pin is on
  // the resolver AND on the page calling it: a resolver that defaults to C while app.js still reads
  // a second copy of the rule would leave the real first load unpinned.
  eq(fail, "nothing saved opens on the dark tactical theme (D-022)", resolveTheme(null), "C");
  eq(fail, "an empty string is the same as nothing saved", resolveTheme(""), "C");
  eq(fail, "a saved D is respected", resolveTheme("D"), "D");
  eq(fail, "lowercase is the same preference", resolveTheme("c"), "C");
  eq(fail, "an id this build does not ship falls back to C", resolveTheme("zzz"), "C");
  {
    const source = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
    ok(fail, "the page resolves its theme through resolveTheme", /themeId\s*=\s*\(\(\)\s*=>\s*\{/.test(source) &&
      /return resolveTheme\(localStorage\.getItem\(THEME_KEY\)\)/.test(source));
    ok(fail, "the page has no second copy of the first-load default",
      !/isThemeId\(saved\)\s*\?/.test(source));
  }

  // The two themes must actually differ, or the switch is a no-op nobody would notice.
  const differing = ["ocean", "plain", "city"].filter((terrain) => terrainInk(themeById("C"), terrain) !== terrainInk(themeById("D"), terrain));
  eq(fail, "the themes differ on the sea, the ground and the cities", differing.length, 3);

  // --- AC1: the same frame painted in two themes is the same game -----------------------------
  {
    const view = fitViewport(640, 272);
    const boardPayload = board();
    const frame = room();
    const before = JSON.stringify({ board: boardPayload, room: frame });
    const c = recorder();
    c.ctx.clearRect = () => {};
    const paintedC = paintMatch(c.ctx, boardPayload, frame, { view, own: "blue", theme: themeById("C") });
    const afterC = JSON.stringify({ board: boardPayload, room: frame });
    ok(fail, "painting the dark theme does not touch the frame", before === afterC);
    const d = recorder();
    d.ctx.clearRect = () => {};
    const paintedD = paintMatch(d.ctx, boardPayload, frame, { view, own: "blue", theme: themeById("D") });
    const afterD = JSON.stringify({ board: boardPayload, room: frame });
    ok(fail, "painting the classic theme does not touch the frame", before === afterD);
    eq(fail, "both themes painted the same cells", paintedC.painted, paintedD.painted);
    eq(fail, "both themes drew the same pieces", paintedC.pieces, paintedD.pieces);
    eq(fail, "both themes drew the same badge groups", paintedC.groups, paintedD.groups);
    eq(fail, "both themes marked the same capitals", paintedC.capitals, paintedD.capitals);
    eq(fail, "both themes stamped the same site ticks", paintedC.siteTicks, paintedD.siteTicks);
    eq(fail, "both themes labelled the same names", paintedC.labels, paintedD.labels);
    eq(fail, "both themes drew the same pending paths", paintedC.pending, paintedD.pending);
    // The layer ORDER is the contract the painter's own pins hold; a theme must not move a layer.
    eq(fail, "a theme does not reorder the layers", paintedC.layers, paintedD.layers);
    eq(fail, "the frame reports the theme it was painted in", [paintedC.theme, paintedD.theme], ["C", "D"]);
    // Every piece is on the same pixel in both themes: the ink changed, the board did not.
    eq(fail, "same piece cells in both themes",
      paintedC.view && paintedD.view ? JSON.stringify(paintedC.view) : "", JSON.stringify(paintedD.view));
    const inkC = new Set(c.fills.map((fill) => fill.color));
    const inkD = new Set(d.fills.map((fill) => fill.color));
    ok(fail, "the two themes do not paint the same colours", [...inkC].some((color) => !inkD.has(color)));
    ok(fail, "the dark theme paints its own sea", c.fills.some((fill) => fill.color === terrainInk(themeById("C"), "ocean")));
    ok(fail, "the classic theme paints its own sea", d.fills.some((fill) => fill.color === terrainInk(themeById("D"), "ocean")));
  }

  // --- PB-066 / PB-067: the fit is the camera's floor, and '+' is never a dead key -------------
  {
    const fit = { scale: 2, minScale: 2, left: 0, top: 0, viewW: 640, viewH: 272, boardW: 320, boardH: 136 };
    eq(fail, "a step out at the floor stays at the fit", zoomAt(fit, 0.7, 10, 10).scale, 2);
    eq(fail, "a step in at the floor moves one pixel", zoomAt(fit, 1.4, 10, 10).scale, 3);
    const tiny = { ...fit, scale: 1, minScale: 1 };
    eq(fail, "'+' off a one-pixel cell is not dead (PB-066)", zoomAt(tiny, 1.4, 10, 10).scale, 2);
    eq(fail, "clampZoom honours the floor", clampZoom(0.4, 2), 2);
    eq(fail, "clampZoom still honours the ceiling", clampZoom(99, 2), 32);
    eq(fail, "clampZoom keeps the old one-pixel minimum with no floor", clampZoom(0), 1);
    // The margins: with the whole board on screen a route draws one copy, not a seam copy per side.
    const wide = { ...fit, scale: 2, viewW: 900, left: 100 };
    const preview = { from: { x: 10, y: 10 }, to: { x: 14, y: 10 }, path: [{ x: 11, y: 10 }, { x: 12, y: 10 }] };
    const r = recorder();
    paintPreview(r.ctx, preview, wide, {});
    ok(fail, "a route was traced", r.moves.length > 0);
    const band = [wide.left, wide.left + wide.boardW * wide.scale];
    ok(fail, "no route ink outside the board (PB-067)",
      r.moves.every((point) => point.x >= band[0] - 1 && point.x <= band[1] + 1));
  }

  // --- PB-064: a coast is not a border, so no dark specks inside a country ----------------------
  {
    // 5x3 cells. The middle row is: blue land, a lake, blue land, blue land, red land.
    const geometry = { width: 5, height: 3, noRegion: 255, regionRuns: [[0, 6], [1, 1], [0, 2], [2, 1], [0, 5]] };
    const owners = [null, null, null];
    owners[0] = "blue";
    owners[1] = "blue";
    owners[2] = "red";
    const cells = new Array(15).fill(0);
    cells[6] = 1; // terrain index 1 = lake, at (1,1)
    const raster = ownershipRaster(geometry, owners, { cells, terrain: ["plain", "lake"] }, ownershipPalette(themeById("D")));
    ok(fail, "the ownership raster was built", Boolean(raster));
    const palette = ownershipPalette(themeById("D"));
    eq(fail, "a lake is painted as sea", raster.ink[6], palette.sea);
    eq(fail, "the cell beside the lake is not a border (PB-064)", raster.ink[7], palette.blue);
    eq(fail, "a red land neighbour is still a border", raster.ink[8], palette.edge.blue);
  }

  // --- PB-068: every site is findable in Show Ownership ----------------------------------------
  {
    const view = { scale: 2, left: 0, top: 0, viewW: 640, viewH: 272, boardW: 320, boardH: 136 };
    const sites = SITES;
    const blind = recorder();
    eq(fail, "no badges and no ownership view stamps nothing (the old rule)", paintSiteTicks(blind.ctx, sites, [], view), 0);
    const painted = recorder();
    eq(fail, "Show Ownership stamps every site on the board (PB-068)",
      paintSiteTicks(painted.ctx, sites, [], view, { everyVisible: true }), sites.length);
  }

  // --- PB-069 / PB-026: names are placed, never stamped over a piece ---------------------------
  {
    // A view where Washington's own badge covers the cells around the capital: at scale 2 the
    // badge floor is 14 screen pixels, i.e. seven cells across.
    const view = { scale: 2, left: 0, top: 0, viewW: 640, viewH: 272, boardW: 320, boardH: 136 };
    const badgeAtWashington = { x: 79 * 2 - 7, y: 44 * 2 - 7, width: 14, height: 14 };
    const labels = capitalLabels([{ name: "Washington", x: 79, y: 44 }], view, { occupied: [badgeAtWashington] });
    eq(fail, "the capital still has a name at the fit", labels.length, 1);
    const box = { x: labels[0].x, y: labels[0].y, width: labels[0].width, height: labels[0].height };
    ok(fail, "the capital's name is not on top of the piece standing on it (PB-069)", !overlaps(box, badgeAtWashington));
    // The occupied list must actually be read: with the whole view already taken, a capital name
    // has nowhere to go and is dropped. Without this the "not on top of the badge" assertion above
    // passes even when capitalLabels ignores `occupied` entirely (the first spread spot happens to
    // clear a 14 px badge at scale 2) - measured as the m7 mutant staying green.
    eq(fail, "a capital name with no free spot is dropped, not stamped over the board",
      capitalLabels([{ name: "Washington", x: 79, y: 44 }], view,
        { occupied: [{ x: 0, y: 0, width: 640, height: 272 }] }).length, 0);

    // Two cities two cells apart at the label zoom: the second name must move or drop, never overlap.
    const zoomed = { scale: 8, left: 0, top: 0, viewW: 600, viewH: 400, boardW: 320, boardH: 136 };
    const pair = visibleLabels([
      { name: "London", x: 20, y: 20 },
      { name: "Berlin", x: 24, y: 20 },
    ], zoomed);
    ok(fail, "at least one of the neighbouring names is drawn", pair.length >= 1);
    for (let i = 0; i < pair.length; i++) {
      for (let j = i + 1; j < pair.length; j++) {
        ok(fail, "two city names never share a pixel (PB-026)",
          !overlaps(pair[i], pair[j]));
      }
    }
    // A name with nowhere to go is dropped rather than drawn over the badge it would cover.
    const blocked = visibleLabels([{ name: "London", x: 20, y: 20 }], zoomed, {
      occupied: [{ x: 0, y: 0, width: 600, height: 400 }],
    });
    eq(fail, "a name with no free spot is dropped", blocked.length, 0);
  }

  // --- PB-045: the placement box outgrows its floor with the cell ------------------------------
  {
    const placement = { width: BOARD_W, height: BOARD_H, mask: new Uint8Array(BOARD_W * BOARD_H).fill(0) };
    placement.mask[3 * BOARD_W + 3] = 1;
    const view = { scale: 12, left: 0, top: 0, viewW: 800, viewH: 400, boardW: 320, boardH: 136 };
    const box = recorder();
    eq(fail, "one legal cell painted", paintPlacement(box.ctx, placement, view), 1);
    ok(fail, "the box is drawn", box.strokes.length > 0);
    ok(fail, "a zoomed box outlines the whole cell (PB-045)",
      box.strokes.every((stroke) => stroke.w >= 12 && stroke.h >= 12));
    const fitBox = recorder();
    paintPlacement(fitBox.ctx, placement, { scale: 1, left: 0, top: 0, viewW: 320, viewH: 136, boardW: 320, boardH: 136 });
    ok(fail, "the fit keeps the ten-pixel floor", fitBox.strokes.every((stroke) => stroke.w >= 10));
  }
}
