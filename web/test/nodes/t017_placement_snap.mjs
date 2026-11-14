// t017_placement_snap - the click target is forgiving, the rule is not (T-017, PB-029, D-019).
//
// What fails if this is removed:
//   - the snap radius is not read from config              -> the number that made Shane's clicks
//     land is a literal in the browser again, and a tuning edit changes nothing
//   - a click three pixels off a city is refused           -> the whole point: at the world fit a
//     cell is one pixel wide and the highlight was one pixel wide
//   - a far click snaps anyway                             -> a mis-click buys a unit in a city the
//     player never pointed at
//   - a land unit snaps to a dock cell                     -> D-019 moved from a rule to a radius
//   - the unready cell loses its ready-at-round sentence   -> the "soon" box becomes a dead click
//   - paintPlacement draws no box                          -> at 1 px per cell there is nothing to
//     aim at and nothing to see (the original draws a box: manual printed p.14)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { configPath, placementRules, resetRules } from "../../server/rules.mjs";
import { canPlace, maskBase64, placementMask } from "../../server/placement.mjs";
import { openMatch } from "../../server/match.mjs";
import { paintPlacement, PLACEMENT_BOX, PLACEMENT_BOX_PX } from "../../public/render.mjs";
import { snapPlacementCell, snapRadiusPx } from "../../public/command.mjs";

export const name = "t017_placement_snap";

const W = 320;
const H = 136;

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function near(message, actual, expected, tolerance = 1e-9) {
  if (!(Math.abs(Number(actual) - Number(expected)) <= tolerance)) {
    fail(message + ": " + actual + " is not " + expected);
  }
}

function board() {
  const terrain = ["ocean", "docks", "shallows", "lake", "capital", "base", "city", "oilfield",
    "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland", "facility"];
  const cells = new Array(W * H).fill(0);
  for (let y = 40; y <= 60; y++) {
    for (let x = 60; x <= 130; x++) cells[y * W + x] = 8;
  }
  return { width: W, height: H, cells, terrain };
}

function matchWith(sites, round = 0) {
  const match = openMatch("1986", []);
  match.sites = sites.map((site) => ({ owner: null, ...site }));
  match.round = round;
  return match;
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
  };
}

// A 2d context that records the outline calls, so the box is measured as geometry and colour
// rather than read off a screenshot (a 10 px box on a 320 px world map is not a vision read).
function recorder() {
  const fills = [];
  const strokes = [];
  const ctx = {
    _fill: "",
    _stroke: "",
    lineWidth: 1,
    set fillStyle(value) { this._fill = value; },
    get fillStyle() { return this._fill; },
    set strokeStyle(value) { this._stroke = value; },
    get strokeStyle() { return this._stroke; },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this._fill }); },
    strokeRect(x, y, w, h) { strokes.push({ x, y, w, h, color: this._stroke, lineWidth: this.lineWidth }); },
  };
  return { ctx, fills, strokes };
}

export async function run(ctx) {
  const grid = board();

  // --- the forgiveness is data ---------------------------------------------------------------
  const rules = placementRules();
  eq("the placement rule is still the friendly site", rules.rule, "friendly-site");
  eq("the snap radius is the config's pixel budget", rules.snapPx, 12);
  eq("the snap radius is the config's cell budget", rules.snapCells, 2);
  eq("the box floor is the config's", rules.boxPx, 10);
  if (!rules.snapSource || !rules.boxSource) fail("a placement forgiveness value has no source line");

  const match = matchWith([
    { id: 1, name: "Home", x: 80, y: 50, kind: "city", owner: "blue" },
    { id: 2, name: "Port", x: 80, y: 45, kind: "dock", owner: "blue" },
    { id: 3, name: "Far", x: 120, y: 50, kind: "city", owner: "blue", readyRound: 9 },
  ], 4);
  const land = placementMask(match, "blue", "infantry", grid);
  if (land.error) fail("the fixture has no legal land cell: " + land.error);
  const sea = placementMask(match, "blue", "cruiser", grid);
  if (sea.error) fail("the fixture has no legal dock: " + sea.error);
  // The server sends the forgiveness with the mask, so the page has one source for the numbers.
  eq("the mask carries the snap radius", land.snap, { px: 12, cells: 2 });
  eq("the mask carries the box size", land.box, { px: 10 });

  const wire = (mask) => ({
    width: mask.width,
    height: mask.height,
    mask: Buffer.from(maskBase64(mask.mask), "base64"),
    snap: mask.snap,
    box: mask.box,
  });

  // --- a click a few pixels off a legal cell snaps to it, at the world fit --------------------
  {
    const placement = wire(land);
    const v = view(1);
    near("the fit zoom radius is the 12 px budget", snapRadiusPx(placement, v), 12);
    const hit = snapPlacementCell({ x: 83, y: 50 }, placement, v);
    if (!hit) fail("a click 3 px off a ready city did not snap");
    eq("the snap lands on the city cell", [hit.x, hit.y], [80, 50]);
    eq("the snapped cell is ready", [hit.value, hit.ready], [1, true]);
    near("the snap reports its distance in screen pixels", hit.distance, 3);

    // 1 to 6 px off, in both axes and diagonally: the acceptance criterion's own numbers.
    for (const [dx, dy] of [[1, 0], [3, 0], [6, 0], [0, 4], [4, 4], [6, 6], [2, 5]]) {
      const at = snapPlacementCell({ x: 80 + dx, y: 50 + dy }, placement, v);
      if (!at) fail("a click " + dx + "," + dy + " px off the city was refused");
      eq("the click " + dx + "," + dy + " px off snapped somewhere else", [at.x, at.y], [80, 50]);
    }

    // A click the player did not aim at a city is still refused.
    eq("a click 20 cells away snapped anyway", snapPlacementCell({ x: 80, y: 70 }, placement, v), null);
    eq("a click on empty ground snapped anyway", snapPlacementCell({ x: 100, y: 100 }, placement, v), null);

    // More than one friendly site can be in range; the nearest wins. (88,50) is 8 from Home and
    // 32 from Far, so Home takes the click and not the unready city.
    const closest = snapPlacementCell({ x: 88, y: 50 }, placement, v);
    eq("the nearest site wins", closest && [closest.x, closest.y], [80, 50]);
    // A click that is nearest to the unready city gets the unready city.
    const unready = snapPlacementCell({ x: 118, y: 50 }, placement, v);
    eq("the unready city takes a click that is nearest to it", unready && [unready.x, unready.y], [120, 50]);
  }

  // --- the radius is a pixel budget, not a cell budget, when zoomed in ------------------------
  {
    const placement = wire(land);
    const v = view(4);
    near("zoom 4 still keeps the 12 px budget", snapRadiusPx(placement, v), 12);
    const twoOff = snapPlacementCell({ x: 122, y: 50 }, placement, v);
    eq("two cells off at zoom 4 (8 px) snaps", twoOff && [twoOff.x, twoOff.y], [120, 50]);
    eq("four cells off at zoom 4 (16 px) is refused", snapPlacementCell({ x: 124, y: 50 }, placement, v), null);
    // The cell budget is what survives a zoom change: at 12x, 2 cells is 24 px, so a 20 px miss
    // still snaps even though the flat budget is 12.
    const deep = view(12);
    near("at 12x the cell budget is the wider one", snapRadiusPx(placement, deep), 24);
    const far = snapPlacementCell({ x: 82, y: 50 }, placement, deep);
    eq("a 24 px miss at 12x snaps to the nearest cell", far && [far.x, far.y], [80, 50]);
    near("the 24 px miss is measured in screen pixels", far.distance, 24);
    eq("a 36 px miss at 12x is refused", snapPlacementCell({ x: 83, y: 50 }, placement, deep), null);
  }

  // --- D-019 is untouched: a land click cannot snap onto a dock, a hull cannot snap onto a city -
  {
    const landPlacement = wire(land);
    const seaPlacement = wire(sea);
    const v = view(1);
    // Clicking the dock cell itself with an infantry armed: the land mask has no dock byte, so the
    // nearest land cell is the city, three cells away - the click moves to the city, never to the
    // water the player actually clicked.
    const fromDock = snapPlacementCell({ x: 80, y: 45 }, landPlacement, v);
    if (!fromDock) fail("an infantry click on a friendly dock was refused instead of snapping to a city");
    eq("an infantry click on a dock snapped to a city cell", [fromDock.x, fromDock.y], [80, 50]);
    // And with a hull armed the same click stays on the dock.
    const hull = snapPlacementCell({ x: 80, y: 47 }, seaPlacement, v);
    if (!hull) fail("a hull click two cells off its dock was refused");
    eq("a hull snaps to its dock", [hull.x, hull.y], [80, 45]);
    // Whatever the mask says is what the server accepts: the snapped cell passes canPlace.
    const ok = canPlace(match, "blue", "infantry", fromDock.x, fromDock.y, grid);
    eq("the snapped cell is one the server accepts", ok.ok, true);
  }

  // --- the unready site keeps its sentence, through the snapped cell -------------------------
  {
    const placement = wire(land);
    const v = view(1);
    // Far sits at 120,50 and is unready (readyRound 9, round 4). A click four cells off it snaps
    // to it and must be refused with the round it comes back - the "soon" box is not a dead click.
    const hit = snapPlacementCell({ x: 124, y: 50 }, placement, v);
    if (!hit) fail("a click beside the unready city did not snap");
    eq("the snap lands on the unready city", [hit.x, hit.y, hit.value, hit.unready], [120, 50, 2, true]);
    const refused = canPlace(match, "blue", "infantry", hit.x, hit.y, grid);
    if (!refused.error) fail("the snapped unready cell was accepted");
    if (!refused.error.includes("ready at round 9")) {
      fail("the unready refusal lost its ready round: " + JSON.stringify(refused.error));
    }
  }

  // --- the box is geometry, not a hope --------------------------------------------------------
  {
    const placement = wire(land);
    for (const scale of [1, 2, 5, 12]) {
      const r = recorder();
      const painted = paintPlacement(r.ctx, placement, view(scale));
      if (painted !== land.count) fail("zoom " + scale + " painted " + painted + " of " + land.count + " cells");
      eq("zoom " + scale + " drew one casing per legal site", r.strokes.length, land.count * 2);
      const casings = r.strokes.filter((s) => s.color === PLACEMENT_BOX.casing);
      const brights = r.strokes.filter((s) => s.color !== PLACEMENT_BOX.casing);
      eq("zoom " + scale + " drew a casing and an outline per site", [casings.length, brights.length], [land.count, land.count]);
      if (r.strokes.some((s) => s.w < PLACEMENT_BOX_PX || s.h < PLACEMENT_BOX_PX)) {
        fail("zoom " + scale + " drew a box smaller than " + PLACEMENT_BOX_PX + " px");
      }
      if (casings.some((s) => !(s.lineWidth > brights[0].lineWidth))) {
        fail("zoom " + scale + " drew the casing no wider than the outline");
      }
    }
    // The box is centred on the cell the player must click, so the target and the ink agree.
    const one = recorder();
    paintPlacement(one.ctx, placement, view(4));
    const cell80 = one.strokes.find((s) => s.color !== PLACEMENT_BOX.casing &&
      Math.abs(s.x + s.w / 2 - (80 + 0.5) * 4) < 0.001);
    if (!cell80) fail("no box was drawn around the city cell at zoom 4");
    near("the box is centred on the cell", cell80.y + cell80.h / 2, (50 + 0.5) * 4);

    // Both readiness colours get a box, not only the "ready" one.
    const colours = new Set(one.strokes.map((s) => s.color));
    if (!colours.has(PLACEMENT_BOX.ready) || !colours.has(PLACEMENT_BOX.unready)) {
      fail("the boxes are not drawn in both readiness colours: " + JSON.stringify([...colours]));
    }
    // A payload asking for a bigger box gets it; one asking for a smaller box is floored at 10 px.
    const big = recorder();
    paintPlacement(big.ctx, { ...placement, box: { px: 16 } }, view(1));
    if (big.strokes.some((s) => s.w !== 16)) fail("a configured 16 px box was not drawn at 16 px");
    const small = recorder();
    paintPlacement(small.ctx, { ...placement, box: { px: 2 } }, view(1));
    if (small.strokes.some((s) => s.w < PLACEMENT_BOX_PX)) fail("a configured 2 px box was drawn under the 10 px floor");
  }

  // --- the whole chain is data: config -> rules -> wire -> page ------------------------------
  const shipped = configPath();
  const dir = mkdtempSync(path.join(tmpdir(), "chq-t017-"));
  try {
    const cfg = JSON.parse(readFileSync(shipped, "utf8"));
    cfg.placement.snap.px = 3;
    cfg.placement.snap.cells = 0;
    cfg.placement.box.px = 18;
    const alt = path.join(dir, "game.json");
    writeFileSync(alt, JSON.stringify(cfg, null, 2));
    process.env.OPENCHQ_CONFIG = alt;
    resetRules();
    eq("a configured 3 px radius reached the rules", placementRules().snapPx, 3);
    eq("a configured 0 cell radius reached the rules", placementRules().snapCells, 0);
    eq("a configured 18 px box reached the rules", placementRules().boxPx, 18);
    const wired = placementMask(match, "blue", "infantry", grid);
    eq("the configured radius reached the wire", wired.snap, { px: 3, cells: 0 });
    eq("the configured box reached the wire", wired.box, { px: 18 });
    const tiny = snapPlacementCell({ x: 81, y: 50 }, wire(wired), view(1));
    if (!tiny) fail("a click 1 px off was refused with a 3 px configured radius");
    eq("a click 5 px off is refused with a 3 px configured radius", snapPlacementCell({ x: 85, y: 50 }, wire(wired), view(1)), null);
    const boxed = recorder();
    paintPlacement(boxed.ctx, wire(wired), view(1));
    if (boxed.strokes.some((s) => s.w !== 18)) fail("the configured box did not reach the painter");
  } finally {
    if (shipped) process.env.OPENCHQ_CONFIG = shipped;
    else delete process.env.OPENCHQ_CONFIG;
    resetRules();
    rmSync(dir, { recursive: true, force: true });
  }

  // --- the page uses the snap, and sends the raw cell when it has none ------------------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes("snapPlacementCell")) fail("the page never calls the placement snap");
  // The click handler snaps first and then buys on the cell it will send, so the cell the purchase
  // names is the one that passed the snap - and a click nothing is near still goes through as the
  // raw cell, which is how "farther away is refused" stays the server's sentence.
  const snapAt = app.indexOf("snapPlacementCell(cell, placement");
  const buyAt = app.indexOf("buyMessage(buying, cell)");
  if (snapAt < 0 || buyAt < 0 || snapAt > buyAt) {
    fail("the page does not snap the click before it buys on that cell");
  }
  if (!app.includes("snap: message.snap") || !app.includes("box: message.box")) {
    fail("the page does not keep the forgiveness the server sent");
  }

  console.log("t017_placement_snap: 12 px / 2 cell snap, " + land.count + " land sites boxed at 1/2/5/12 px, " +
    "dock-vs-city domain held, unready sentence kept, config -> wire -> page pinned");
}
