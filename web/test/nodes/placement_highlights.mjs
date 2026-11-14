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
    strokeRect() {},
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
  // D-019: a hull berths on a friendly dock, so every highlighted sea cell must be the cell of a
  // dock site Blue owns - and one of them must sit near Washington, or the capital cannot build.
  const docks = new Map();
  for (const site of match.sites) {
    if (!site || site.owner !== "blue") continue;
    if (site.kind !== "dock" && site.kind !== "docks") continue;
    docks.set(Number(site.x) + "," + Number(site.y), site);
  }
  let nearWashington = false;
  for (let id = 0; id < sea.mask.length; id++) {
    if (!sea.mask[id]) continue;
    const x = id % 320;
    const y = (id - x) / 320;
    if (!docks.has(x + "," + y)) fail("placement_highlights: a legal hull cell at " + x + "," + y + " is not a friendly dock");
    if (Math.max(Math.abs(x - 79), Math.abs(y - 44)) <= 12) nearWashington = true;
  }
  if (!nearWashington) fail("placement_highlights: no friendly dock within 12 cells of Washington");

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

  // First click places: the highlighted cell passes buy(), an unhighlighted one is refused. Pick a
  // cell whose city has a FREE neighbour inside the readiness radius, so the two-colour check below
  // has an unready cell that is also still a legal placement cell.
  //
  // T-013b: 1942 now opens with the original's garrison army, so 11 of blue's 40 production cities
  // already hold a piece. An unready city that a garrison stands on is not a legal cell, so the
  // plain "some neighbour within 5" search picked a city whose whole readiness ring was occupied
  // and the overlay had nothing two-coloured left to paint.
  const produce = (match.sites || []).filter((site) => site && site.owner === "blue" &&
    ["city", "capital", "base", "facility"].includes(String(site.kind)));
  const near = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, 320 - dx), Math.abs(Number(a.y) - Number(b.y)));
  };
  const held = (site) => match.pieces.some(
    (piece) => Number(piece.x) === Number(site.x) && Number(piece.y) === Number(site.y)
  );
  let legal = null;
  for (let id = 0; id < land.mask.length && !legal; id++) {
    if (!land.mask[id]) continue;
    const cell = { x: id % 320, y: Math.floor(id / 320) };
    const here = produce.find((site) => Number(site.x) === cell.x && Number(site.y) === cell.y);
    if (!here) continue;
    const freeNeighbour = produce.some(
      (other) => other !== here && near(other, here) <= 5 && !held(other)
    );
    if (freeNeighbour) legal = cell;
  }
  if (!legal) fail("placement_highlights: no city with a free friendly neighbour to buy in");
  const bought = buy(match, "blue", "infantry", legal.x, legal.y, board);
  if (!bought.ok) fail("placement_highlights: a highlighted cell was refused: " + JSON.stringify(bought));
  const outside = buy(match, "blue", "infantry", 5, 130, board);
  if (!outside.error) fail("placement_highlights: an unhighlighted cell was accepted");

  // Ready and unready are two colours (AC3). The purchase just marked its city and the friendly
  // cities within the radius, so the next mask carries both bytes and the overlay paints both.
  const after = placementMask(match, "blue", "infantry", board);
  if (!after.unready) fail("placement_highlights: no cell went unready after a purchase");
  const two = recorder();
  paintPlacement(two.ctx, { width: after.width, height: after.height, mask: after.mask }, view(2));
  const colours = new Set(two.fills.map((fill) => fill.color));
  if (colours.size !== 2) fail("placement_highlights: ready and unready painted in " + colours.size + " colour(s)");

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
