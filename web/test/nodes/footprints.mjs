// Node footprints: a friendly city's whole painted block is a legal place (D-026, T-026).
//
// The cells are MEASURED, not derived: web/data/footprints.json is the painted set taken from the
// running original's runtime tile map (`t026-map-dump.py` + `t026-measured-footprints.py`, era 1942
// side BLUE, 2026-11-14) and translated into the site-record frame by the measured painter offset
// (2, 0) — the painter writes at record + 2 in x on all 64 city-kind sites. That is PM ruling
// 2026-11-14 20:20 ET option (a). Nothing from the original is in the repo: only the cell lists.
//
// This node pins five things:
//  1. the file covers exactly the city-kind sites and every cell sits inside the painter's 3x3 in
//     the record frame, so the data cannot silently drift into a hand-shaped list;
//  2. the mask accepts every measured cell of a friendly site and the unit lands on the cell that
//     was clicked, not on the centre — the assertion a "centre-only" mutant turns red;
//  3. the Q49 cross-check in the measured frame: Detroit and Chicago hold the two cells that are
//     lake in `tmap.bin` and city on the running board, once translated by (2, 0);
//  4. Q45's two Washington cells, one measured state each, and the (80,44) DEVIATION made explicit:
//     the original's placement check refused a cell its painter painted, and the remake accepts it;
//  5. the config pin: placement.footprint.* is the statement of record (kinds, rule, frame, q45,
//     q54, gate, deviation), the server reads it rather than a frozen array, and the UNVERIFIED
//     tags stay while Q45 keeps its measured record.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canPlace, footprintCells, placementMask } from "../../server/placement.mjs";
import { openMatch } from "../../server/match.mjs";
import { placementRules } from "../../server/rules.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

const W = 320;
const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..", "..", "..");
const CITY_KINDS = ["city", "capital", "base"];

function unbundle(world) {
  const total = world.width * world.height;
  const cells = new Array(total);
  let at = 0;
  for (const [value, count] of world.terrainRuns) {
    for (let i = 0; i < count && at < total; i++) cells[at++] = value;
  }
  if (at !== total) fail("world.json terrainRuns cover " + at + " of " + total + " cells");
  return { width: world.width, height: world.height, cells };
}

export const name = "footprints";

export async function run(ctx) {
  const world = JSON.parse(readFileSync(path.join(projectDir, "web", "data", "world.json"), "utf8"));
  const board = unbundle(world);
  const measured = JSON.parse(readFileSync(path.join(projectDir, "web", "data", "footprints.json"), "utf8"));
  eq("the measured list covers the board size", [measured.width, measured.height], [board.width, board.height]);

  // --- 1. coverage and shape ---------------------------------------------------------------
  const sites = Array.isArray(world.sites) ? world.sites : [];
  if (sites.length !== 84) fail("the shipped board lists " + sites.length + " sites, expected 84");
  const citySites = sites.filter((site) => CITY_KINDS.includes(String(site.kind)));
  if (citySites.length !== 64) fail("the board has " + citySites.length + " city-kind sites, expected 64");
  eq("the measured list covers every city-kind site, and no facility",
    Object.keys(measured.sites).sort((a, b) => Number(a) - Number(b)),
    citySites.map((site) => String(site.id)).sort((a, b) => Number(a) - Number(b)));
  for (const site of citySites) {
    const cells = measured.sites[String(site.id)];
    if (!cells || !cells.length) fail("site " + site.id + " (" + site.name + ") has no measured cells");
    const seen = new Set();
    for (const [x, y] of cells) {
      const dx = Math.abs(x - site.x);
      const wrapped = Math.min(dx, board.width - dx);
      if (wrapped > 1 || Math.abs(y - site.y) > 1) {
        fail("site " + site.id + " (" + site.name + ") cell " + x + "," + y + " is outside the painter's 3x3");
      }
      const key = x + "," + y;
      if (seen.has(key)) fail("site " + site.id + " (" + site.name + ") lists " + key + " twice");
      seen.add(key);
    }
  }
  if (String(measured._meta && measured._meta.era) !== "2") {
    fail("the measured list does not name era 2 (1942): " + JSON.stringify(measured._meta && measured._meta.era));
  }
  eq("the measured list names its side", measured._meta && measured._meta.side, "BLUE");

  // --- 2. Washington: every measured cell is legal, and the unit lands on the clicked cell --
  const washington = sites.find((site) => site.name === "Washington");
  if (!washington) fail("the shipped board has no Washington");
  eq("Washington's site cell", [washington.x, washington.y], [79, 44]);
  const block = measured.sites[String(washington.id)];
  // The painter painted all nine cells of Washington's 3x3 on the running original; the measured
  // list is the record-frame translation of exactly that.
  eq("Washington's measured footprint is the painter's full 3x3", block.length, 9);
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    if (!block.some(([x, y]) => x === washington.x + dx && y === washington.y + dy)) {
      fail("Washington's footprint misses the painter cell " + (washington.x + dx) + "," + (washington.y + dy));
    }
  }

  const match = openMatch("1942", []);
  match.sites = [{ id: washington.id, name: "Washington", x: washington.x, y: washington.y, kind: "capital", owner: "blue" }];
  match.pieces = [];
  match.round = 3;
  const mask = placementMask(match, "blue", "infantry", board);
  if (mask.error) fail("a friendly capital offered no cells: " + mask.error);
  eq("the mask is exactly the measured footprint", mask.count, block.length);
  for (const [x, y] of block) eq("footprint cell " + x + "," + y + " is legal", mask.mask[y * W + x], 1);
  eq("the cell outside the corner of the block is not", mask.mask[(washington.y - 2) * W + washington.x - 2] || 0, 0);

  // The landed cell is the clicked cell: the centre, the north cell and the south-east corner of
  // the block all resolve to their own cell. A "centre-only" mutant makes these three red.
  for (const [x, y] of [[washington.x, washington.y], [washington.x, washington.y - 1], [washington.x + 1, washington.y + 1]]) {
    const placed = canPlace(match, "blue", "infantry", x, y, board);
    if (placed.error) fail("canPlace refused the footprint cell " + x + "," + y + ": " + placed.error);
    eq("the unit lands on the clicked cell " + x + "," + y, [placed.place.x, placed.place.y], [x, y]);
    eq("the clicked cell names its site", placed.site && placed.site.id, washington.id);
  }

  // A cell two rows off the block is outside both the footprint and the T-017 snap range the page
  // is given, so the server refuses it with the D-019 sentence instead of redirecting.
  const off = canPlace(match, "blue", "infantry", washington.x, washington.y - 3, board);
  if (!off.error) fail("canPlace accepted a cell outside the footprint");
  if (!off.error.includes("Can't place infantry here")) fail("the off-footprint refusal is " + JSON.stringify(off.error));

  // --- 3. Q49 in the measured frame: the painter writes at record + (2, 0) -------------------
  // Q49 measured two cells that are lake in tmap.bin and city on the running board: map (76,39) and
  // map (72,41). In the painter frame those are Detroit's and Chicago's blocks; translated back by
  // the measured offset they are record (74,39) and (70,41), which is what the file must hold. This
  // is the frame reconciliation: "Detroit's footprint includes (76,39)" is true in the PAINTED
  // frame and false in the record frame, and the file is the record frame.
  const detroit = sites.find((site) => site.name === "Detroit");
  if (!detroit) fail("the shipped board has no Detroit");
  eq("Detroit's site cell", [detroit.x, detroit.y], [74, 40]);
  const detroitBlock = measured.sites[String(detroit.id)];
  if (!detroitBlock.some(([x, y]) => x === detroit.x && y === detroit.y - 1)) {
    fail("Detroit's footprint misses record 74,39 — the translated Q49 cell map(76,39)");
  }
  if (!detroitBlock.map(([x, y]) => [x + 2, y]).some(([x, y]) => x === 76 && y === 39)) {
    fail("the painter-frame check misses 76,39 in Detroit's block");
  }
  const chicago = sites.find((site) => site.name === "Chicago");
  if (!chicago) fail("the shipped board has no Chicago");
  const chicagoBlock = measured.sites[String(chicago.id)];
  if (!chicagoBlock.some(([x, y]) => x === chicago.x && y === chicago.y - 1)) {
    fail("Chicago's footprint misses record 70,41 — the translated Q49 cell map(72,41)");
  }
  if (!chicagoBlock.map(([x, y]) => [x + 2, y]).some(([x, y]) => x === 72 && y === 41)) {
    fail("the painter-frame check misses 72,41 in Chicago's block");
  }

  // --- 4. Q45's two cells, and the deviation stated as a deviation ---------------------------
  // One measured state per cell: (78,44) IS a city cell (the original answered `READY AT 0744`, the
  // city's own next-ready round, not a placement refusal); (80,44) was REFUSED by the placement
  // check (`MUST BE PLACED IN CITY`) although the painter painted city terrain there.
  if (!block.some(([x, y]) => x === washington.x - 1 && y === washington.y)) {
    fail("Washington's footprint lost (78,44), which Q45 measured as a city cell (READY AT 0744)");
  }
  if (!block.some(([x, y]) => x === washington.x + 1 && y === washington.y)) {
    fail("Washington's footprint lost (80,44), which the MEASURED painted set contains");
  }
  const east = canPlace(match, "blue", "infantry", washington.x + 1, washington.y, board);
  if (east.error) fail("canPlace refused the measured cell 80,44: " + east.error);
  // This is the deviation, asserted so it cannot disappear quietly in either direction: the remake
  // accepts a cell the original's placement check refused, because the painted set contains it and
  // no measurement separates the check's frame from the painter's.
  eq("the remake accepts 80,44 (the recorded deviation)", [east.place.x, east.place.y], [washington.x + 1, washington.y]);

  // --- 5. the config pin: placement.footprint.* is the statement of record ------------------
  const rawConfig = JSON.parse(readFileSync(path.join(projectDir, "config", "game.json"), "utf8"));
  const fp = ((rawConfig.placement || {}).footprint) || {};
  eq("config placement.footprint.kinds", fp.kinds, ["city", "capital", "base"]);
  eq("config placement.footprint.rule", fp.rule, "any-footprint-cell-counts-as-the-site");
  const liveRules = placementRules();
  eq("placementRules() reads kinds from the config, not a frozen array", liveRules.footprintKinds, fp.kinds);
  eq("placementRules() exposes the frame note", liveRules.footprintFrame, fp.frame);
  eq("placementRules() exposes the recorded deviation", liveRules.footprintDeviation, fp.deviation);
  if (!/MEASURED/.test(String(fp.q45 || ""))) fail("placement.footprint.q45 lost its measured record");
  if (!/UNVERIFIED/.test(String(fp.q54 || ""))) fail("placement.footprint.q54 lost its UNVERIFIED tag");
  if (!/UNVERIFIED/.test(String(fp.gate || ""))) fail("placement.footprint.gate lost its UNVERIFIED tag");
  if (!/UNVERIFIED/.test(String(fp.frame || ""))) fail("placement.footprint.frame lost its UNVERIFIED tag");
  if (!/80,\s*44|80,44|\(80,44\)/.test(String(fp.deviation || ""))) {
    fail("placement.footprint.deviation no longer names the measured cell (80,44)");
  }
  if (!/measured/i.test(String(measured._meta && measured._meta.source))) {
    fail("footprints.json no longer declares itself measured: " + JSON.stringify(measured._meta && measured._meta.source));
  }
  // The kinds list is load-bearing, not a comment: a site kind it does not name is painted as a
  // single cell (the configuration branch in the painter), so this asserts the behaviour the list
  // buys. Dropping "capital" would make the nine Washington cells above one cell.
  const facility = { id: "facility-probe", kind: "facility", x: washington.x, y: washington.y };
  eq("a kind outside placement.footprint.kinds is one cell",
    footprintCells(facility, board), [[washington.x, washington.y]]);

  if (!ctx || !ctx.base) return;
}
