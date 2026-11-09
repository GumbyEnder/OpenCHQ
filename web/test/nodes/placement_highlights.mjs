// Placement is a promise the page keeps: the server returns the legal cells, the page paints every
// one of them at every zoom, and the first click on a painted cell buys the unit.
import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { buy } from "../../server/economy.mjs";
import { priceOf } from "../../server/rules.mjs";
import { maskBase64, placementMask } from "../../server/placement.mjs";
import { paintPlacement } from "../../public/render.mjs";

export const name = "placement_highlights";

function recorder() {
  const fills = [];
  const ctx = {
    _style: "",
    set fillStyle(value) { this._style = value; },
    get fillStyle() { return this._style; },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this._style }); },
  };
  return { ctx, fills };
}

function view(scale) {
  return {
    scale,
    left: 0,
    top: 0,
    viewW: 320 * scale,
    viewH: 136 * scale,
    boardW: 320,
    boardH: 136,
    offsetX: 0,
    offsetY: 0,
  };
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("placement_highlights: no board cells");

  const match = openMatch("1942", matchSites("1942", board));
  seedOwners(match);
  // Fund the fixture: pool and prices are both held in integer millions, infantry costs 10 billion
  // (manual p.28) and the stand-in startPool is 9 (T-001 leaves startPool alone), so an unfunded
  // seat cannot afford a single unit.
  match.sides.blue.cash = priceOf("infantry") * 3;

  // A unit set that must be non-empty in 1942, on the real board.
  const land = placementMask(match, "blue", "infantry", board);
  if (land.error || !land.count) fail("placement_highlights: infantry has no legal cell in 1942: " + JSON.stringify(land));
  const sea = placementMask(match, "blue", "cruiser", board);
  if (sea.error || !sea.count) fail("placement_highlights: a hull has no berth at Washington in 1942: " + JSON.stringify(sea));
  // And a specific berth near Washington, not just somewhere on the map.
  let nearWashington = false;
  for (let id = 0; id < sea.mask.length; id++) {
    if (!sea.mask[id]) continue;
    const x = id % 320;
    const y = (id - x) / 320;
    if (Math.max(Math.abs(x - 79), Math.abs(y - 44)) <= 8) { nearWashington = true; break; }
  }
  if (!nearWashington) fail("placement_highlights: no hull berth within 8 cells of Washington");

  // The overlay paints at every zoom the game offers, including the one-pixel fit.
  const wire = {
    width: land.width,
    height: land.height,
    mask: Buffer.from(maskBase64(land.mask), "base64"),
  };
  for (const scale of [1, 2, 5, 12]) {
    const r = recorder();
    const painted = paintPlacement(r.ctx, wire, view(scale));
    if (painted !== land.count) {
      fail("placement_highlights: zoom " + scale + " painted " + painted + " of " + land.count + " cells");
    }
    if (r.fills.length !== land.count) fail("placement_highlights: zoom " + scale + " made " + r.fills.length + " rectangles");
    if (r.fills.some((fill) => fill.w < 1 || fill.h < 1)) {
      fail("placement_highlights: zoom " + scale + " drew a cell smaller than a pixel");
    }
  }
  const one = recorder();
  paintPlacement(one.ctx, wire, view(1));
  if (!one.fills.every((fill) => fill.w >= 1 && fill.h >= 1)) fail("placement_highlights: a cell vanished at the fit zoom");
  // The overlay is strong enough to read: the live report was "no highlights at all".
  const alpha = Number((/rgba\([^)]*,\s*([0-9.]+)\)/.exec(one.fills[0].color) || [])[1]);
  if (!(alpha >= 0.5)) fail("placement_highlights: the overlay alpha is " + one.fills[0].color);

  // First click places: the highlighted cell passes buy(), an unhighlighted one is refused.
  let legal = null;
  for (let id = 0; id < land.mask.length; id++) if (land.mask[id]) { legal = { x: id % 320, y: Math.floor(id / 320) }; break; }
  const bought = buy(match, "blue", "infantry", legal.x, legal.y, board);
  if (!bought.ok) fail("placement_highlights: a highlighted cell was refused: " + JSON.stringify(bought));
  const outside = buy(match, "blue", "infantry", 5, 130, board);
  if (!outside.error) fail("placement_highlights: an unhighlighted cell was accepted");

  // The page asks for the mask and paints it, rather than re-deriving the rule.
  const app = await (await fetch(ctx.base + "/app.js")).text();
  const render = await (await fetch(ctx.base + "/render.mjs")).text();
  if (!app.includes('op: "placement"') || !app.includes("paintPlacement")) {
    fail("placement_highlights: the page no longer asks for and paints placement cells");
  }
  if (!/paintPlacement\(ctx, placement, view/.test(app)) fail("placement_highlights: the page does not paint the server's mask");

  console.log("placement_highlights: infantry " + land.count + " cells, hull " + sea.count +
    " berths, painted at 1/2/5/12 px, first click placed");
}
