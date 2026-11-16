// Node territory test: the 184-region model and the Show Ownership view (T-018).
//
// What breaks if this file goes: the territory model could quietly stop matching the original and
// the view would still be drawn. The pins below are the 1942 opening read off
// docs/captures/era-1942-blue-ownership.png - blue holds Europe's east and the Americas, red holds
// western Europe and Japan's sphere, two regions (Spain and Greenland) are unheld - and the
// measured palette of the live view.
//
// Geometry source: web/data/territory.json, baked from REGIONS.DAT by tools/bake_territory.mjs.
// Ownership source: the era's site table, joined through the region -> site row. No second copy.
import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import {
  NO_REGION, TERRITORY, isFriendly, ownershipOf, regionAt, regionSites, regionsHeldBy,
} from "../../server/territory.mjs";
import { OWNERSHIP, ownershipGrid, ownershipInk, ownershipRaster, ownershipTally } from "../../public/render.mjs";
import { deltaBetween } from "../../server/lobby.mjs";

export const name = "territory";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function haveBoard() {
  const payload = boardPayload();
  return Boolean(payload && Array.isArray(payload.cells) && payload.cells.length);
}

function siteByName(match, wanted) {
  const site = match.sites.find((place) => place && place.name === wanted);
  if (!site) fail("no site named " + wanted);
  return site;
}

function ownerAtSite(match, owners, site) {
  const rid = regionAt(site.x, site.y);
  if (rid === NO_REGION) return "no region";
  return owners[rid];
}

export async function run() {
  if (!haveBoard()) return "skipped: no board extract on this host";

  const board = boardPayload();
  const match = openMatch("1942", matchSites("1942", board));
  const opening = ownershipOf(match);
  if (!opening.ready) fail("the territory model is not ready: web/data/territory.json is missing");

  // ---- the model is the file's own shape ---------------------------------------------------
  eq("184 regions", opening.owners.length, 184);
  for (const era of ["1918", "1942", "1986", "2023"]) {
    const row = regionSites(era);
    if (!Array.isArray(row) || row.length !== 184) fail("era " + era + " has no 184-entry region row");
  }
  // 1942's row is not the same as 1918's: the model is per era, not one table for all years.
  const differ = regionSites("1918").filter((site, rid) => site !== regionSites("1942")[rid]).length;
  // Measured: 77 of 184 regions change the site they answer to between 1918 and 1942 (the borders
  // moved, so the region -> site row moved with them). A model that read one row for every year
  // would report 0 here.
  eq("1918 and 1942 assign 77 regions differently", differ, 77);

  // ---- the gap arithmetic closes inside the artifact, and the nine sea-locked cells are filled ---
  // RULED 2026-11-16 (room 6323 item A): the nine land cells the land-only 4-neighbour fill cannot
  // enter take the SAME rule extended across water - 4-neighbour BFS, x wrap, first arrival in
  // row-major seed order. The chosen rule reproduces 98.18% of the original's 1942 ink over the whole
  // gap set against 95.57% for a lowest-id tie-break, and the land pass itself reproduces 2403/2403
  // of the existing fill, so nothing below the nine moves. These pins are measured, not asserted:
  // quad 18725 + gap 2403 + cross-water 9 = 21137 filled; 2412 candidates - 2403 - 9 = 0 unreachable.
  const meta = TERRITORY.meta || {};
  eq("quad cells", meta.quadCells, 18725);
  eq("gap candidates", meta.gapCandidates, 2412);
  eq("gap cells the land-only fill reaches", meta.gapFilled, 2403);
  eq("gap cells the cross-water pass claims", meta.gapCrossWater, 9);
  eq("gap cells left with no region", meta.gapUnreachable, 0);
  eq("quad + gap + cross-water is the filled total",
    meta.quadCells + meta.gapFilled + meta.gapCrossWater, meta.filledCells);
  eq("filled total", meta.filledCells, 21137);
  eq("candidates - land-filled is exactly the cross-water count",
    meta.gapCandidates - meta.gapFilled, meta.gapCrossWater);
  eq("land cells", meta.landCells, 14612);
  eq("the unreachable list is empty", meta.gapUnreachableCells, []);

  // The nine, with the region the ruled fill hands each one. This is the cross-water pin: restore a
  // land-only BFS and every one of these reads NO_REGION, so the node goes red by name.
  const CROSS_WATER = [
    [319, 14, 64], [319, 27, 64], [69, 81, 57], [319, 87, 104], [153, 43, 23],
    [81, 58, 42], [223, 72, 50], [223, 73, 50], [262, 87, 78],
  ];
  eq("the cross-water cells, cell for cell, with their regions",
    meta.gapCrossWaterCells.map(([x, y, rid]) => [x, y, rid]), CROSS_WATER);
  const WATER = new Set(["ocean", "shallows", "lake"]);
  for (const [x, y, rid] of CROSS_WATER) {
    const ground = board.terrain[board.cells[y * board.width + x]];
    if (WATER.has(ground)) fail(`(${x},${y}) is pinned as a land gap cell but reads ${ground}`);
    eq(`(${x},${y}) gets region ${rid} from the cross-water fill`, regionAt(x, y), rid);
  }
  // Region 64 is the deliberate deviation (REGIONS.md): our fill reaches these two across water and
  // the original paints them with region 4's ink. Pinned so a "fix" cannot silently move them.
  eq("(319,14) is the documented region-64 deviation", regionAt(319, 14), 64);
  eq("(319,27) is the documented region-64 deviation", regionAt(319, 27), 64);

  // ---- AC: the 1918/1942/1986 half is exact colour, 7 of 9 cells x 3 eras ---------------------
  // The pinned value is what the SERVED ownership view paints (openMatch -> ownershipOf -> ink),
  // and the capture column is what the original shows. Both are recorded, so a disagreement is a
  // named row, not a gap: PIN is the assertion, CAP is the capture's ink, and where they differ the
  // reason is on the row. 21 assertions over 7 cells x 3 eras.
  //
  // 153,43 and 81,58 are OUT of this AC (ruling, room 6323): their ink never changes across eras
  // even where the region's colour does - 153,43 is white in all six captures, 81,58 blue in five
  // and white in one 2023 draw - so they are non-territory ink, the same class as the Q58 unit
  // markers. They still take a region from the fill; they are just not pinned to a colour.
  //
  // TWO DEVIATION CLASSES, and they are not the same thing:
  //   (a) 319,14 / 319,27 in 1986 - as ruled: our cross-water fill gives region 64 (blue) where the
  //       original paints region 4's ink (white 1918 / blue 1942 / red 1986). Deliberate, two cells.
  //   (b) 223,72 / 223,73 / 319,87 in 1918 - a PRE-EXISTING defect in the 1918 join, not in the
  //       fill: ownersFor reads match.sites[Number(siteId)] (an ARRAY INDEX), and 1918's 184-entry
  //       roster is not id-ordered - index 50 is `dock:39:34` - so every 1918 region whose site id
  //       collides with a dock index paints neutral. 1918's served tally is 27/13/144 where the
  //       file names 14/9/2 owners. Out of PB-077's scope and unfixed here: fixing the join moves
  //       the whole 1918 paint, which is its own ticket and its own gate.
  const AC = [
    //  cell      era     PIN (served)  CAP (original)
    [[223, 72], "1918", "white", "blue", "1918 join defect (b)"],
    [[223, 72], "1942", "blue", "blue", ""],
    [[223, 72], "1986", "white", "white", ""],
    [[223, 73], "1918", "white", "blue", "1918 join defect (b)"],
    [[223, 73], "1942", "blue", "blue", ""],
    [[223, 73], "1986", "white", "white", ""],
    [[69, 81], "1918", "white", "white", ""],
    [[69, 81], "1942", "blue", "blue", ""],
    [[69, 81], "1986", "blue", "blue", ""],
    [[262, 87], "1918", "white", "white", ""],
    [[262, 87], "1942", "red", "red", ""],
    [[262, 87], "1986", "white", "white", ""],
    [[319, 87], "1918", "white", "blue", "1918 join defect (b)"],
    [[319, 87], "1942", "blue", "blue", ""],
    [[319, 87], "1986", "blue", "blue", ""],
    [[319, 14], "1918", "white", "white", ""],
    [[319, 14], "1942", "blue", "blue", ""],
    [[319, 14], "1986", "blue", "red", "deviation (a): region 64, not region 4"],
    [[319, 27], "1918", "white", "white", ""],
    [[319, 27], "1942", "blue", "blue", ""],
    [[319, 27], "1986", "blue", "red", "deviation (a): region 64, not region 4"],
  ];
  const eraOwners = {};
  for (const era of ["1918", "1942", "1986"]) {
    eraOwners[era] = ownershipOf(openMatch(era, matchSites(era, board))).owners;
  }
  let deviations = 0;
  for (const [cell, era, pin, cap, why] of AC) {
    const [x, y] = cell;
    const rid = regionAt(x, y);
    if (rid === NO_REGION) fail(`AC cell (${x},${y}) has no region in ${era}`);
    const served = ownershipInk(eraOwners[era][rid] ?? null, OWNERSHIP);
    eq(`AC ${era} (${x},${y}) region ${rid}${why ? " [" + why + "]" : ""}`,
      served, ownershipInk(pin, OWNERSHIP));
    if (pin !== cap) {
      if (!why) fail(`AC ${x},${y} ${era}: pin ${pin} disagrees with the capture ${cap} and gives no reason`);
      deviations += 1;
    }
  }
  eq("the AC carries exactly 21 assertions", AC.length, 21);
  eq("5 of the 21 are named deviations (2 x region 64, 3 x the 1918 join)", deviations, 5);
  for (const [x, y, why] of [[153, 43, "white in all six captures"],
    [81, 58, "blue in five captures, white in one 2023 draw"]]) {
    // Excluded from the colour AC, but still land in the fill: a cell we stopped pinning is not a
    // cell we stopped owning.
    if (regionAt(x, y) === NO_REGION) fail(`excluded cell (${x},${y}) lost its region`);
    if (!why) fail("excluded cell needs a reason");
  }

  // ---- AC: the 2023 half is a partition, because 2023's owners are rolled per match ------------
  // Cells that share a predicted region share a colour under that match's rolled owners, with the
  // region ids named. That is the whole content of the 2023 half: 2023 ships no owners in the file
  // (B-3 rolls them), so no exact colour exists to pin - the partition is what must hold for ANY
  // roll. Two deterministic rolls stand in for the real ones: a side-fill where every region takes
  // the same side would pass vacuously, so the draws go through the region row with two different
  // patterns and the cells are asserted to follow their REGION, not their position.
  const PARTITION = [[64, [[319, 14], [319, 27]]], [50, [[223, 72], [223, 73]]],
    [57, [[69, 81]]], [78, [[262, 87]]], [104, [[319, 87]]]];
  for (const rid of [23, 42]) eq(`excluded region ${rid} is not in the 2023 partition`, PARTITION.some(([r]) => r === rid), false);
  const draws = [
    (rid) => (rid % 3 === 0 ? "blue" : "red"),
    (rid) => (rid % 3 === 0 ? "red" : "blue"),
  ];
  for (let d = 0; d < draws.length; d += 1) {
    const rolled = ownershipOf(openMatch("2023", matchSites("2023", board))).owners.map((_, rid) => draws[d](rid));
    for (const [rid, cells] of PARTITION) {
      const inks = new Set(cells.map(([x, y]) => {
        eq(`2023 draw ${d}: (${x},${y}) is region ${rid}`, regionAt(x, y), rid);
        return ownershipInk(rolled[rid] ?? null, OWNERSHIP);
      }));
      if (inks.size !== 1) fail(`2023 draw ${d}: region ${rid}'s cells do not share a colour: `
        + [...inks].join(" "));
    }
    // The draws must be able to disagree with each other, or the partition proves nothing.
    for (const [rid] of PARTITION) {
      if (draws[0](rid) === draws[1](rid)) fail(`2023 draw ${rid}: both draws picked ${draws[0](rid)}; `
        + "a partition over identical draws cannot fail");
    }
  }

  // ---- 1942 opening, broad strokes ---------------------------------------------------------
  eq("1942 opening region tally", opening.tally, { blue: 146, red: 36, neutral: 2 });
  const owners = opening.owners;
  const expectSite = (wanted, expected) => {
    const site = siteByName(match, wanted);
    eq(wanted + " is " + expected + " in 1942", ownerAtSite(match, owners, site), expected);
  };
  expectSite("Washington", "blue");
  expectSite("Moscow", "blue");
  expectSite("London", "blue");
  expectSite("Berlin", "red");
  expectSite("Paris", "red");
  expectSite("Tokyo", "red");
  expectSite("Madrid", null);            // Spain: unheld in the capture, white on the map
  eq("Greenland's region is unheld", owners[125], null);

  const washington = siteByName(match, "Washington");
  eq("Washington's cell is friendly to blue", isFriendly(match, "blue", washington.x, washington.y), true);
  eq("Washington's cell is not friendly to red", isFriendly(match, "red", washington.x, washington.y), false);
  // The sea is nobody's territory: "is this friendly?" has to answer false for placement (p.31).
  let sea = null;
  for (let x = 0; x < board.width && !sea; x++) if (regionAt(x, 100) === NO_REGION) sea = { x, y: 100 };
  if (!sea) fail("no region-free cell on row 100 to test the sea with");
  eq("open sea is not friendly territory", isFriendly(match, "blue", sea.x, sea.y), false);

  // ---- a capture recolours every region the captured site holds ----------------------------
  // Cam Ranh holds six regions in 1942, so one capture is enough to watch a whole stretch of
  // coast change hands - which is the granularity the model claims (and the Q44 question).
  const camRanh = siteByName(match, "Cam Ranh");
  const heldRegions = owners.map((owner, rid) => (regionSites("1942")[rid] === camRanh.id ? rid : -1))
    .filter((rid) => rid >= 0);
  eq("Cam Ranh is the site six regions answer to", heldRegions.length, 6);
  for (const rid of heldRegions) eq("region " + rid + " is red before the capture", owners[rid], "red");
  camRanh.owner = "blue";
  const after = ownershipOf(match);
  for (const rid of heldRegions) eq("region " + rid + " follows Cam Ranh", after.owners[rid], "blue");
  eq("the capture moved exactly Cam Ranh's regions", after.tally.red, opening.tally.red - heldRegions.length);
  eq("Cam Ranh's ground is friendly to blue after the capture", isFriendly(match, "blue", camRanh.x, camRanh.y), true);
  camRanh.owner = "red";

  // ---- the view's palette is measured, and a theme can replace it --------------------------
  eq("blue fill", OWNERSHIP.blue, "#5555ff");
  eq("red fill", OWNERSHIP.red, "#ff5555");
  eq("unheld ground is white in the live view", OWNERSHIP.neutral, "#ffffff");
  eq("sea", OWNERSHIP.sea, "#55ffff");
  eq("a region's fill is its owner's colour", ownershipInk("blue", OWNERSHIP), "#5555ff");
  eq("an unheld region's fill is the neutral", ownershipInk(null, OWNERSHIP), "#ffffff");
  const theme = { ...OWNERSHIP, blue: "#001144", red: "#440000", edge: { blue: "#000022", red: "#220000" } };
  eq("a theme replaces the blue", ownershipInk("blue", theme), "#001144");

  const geometry = {
    width: board.width, height: board.height, noRegion: NO_REGION,
    regionRuns: territoryRuns(),
  };
  const raster = ownershipRaster(geometry, opening.owners, { cells: board.cells, terrain: board.terrain });
  if (!raster) fail("the ownership raster did not build");
  const at = (x, y) => raster.ink[y * board.width + x];
  eq("the raster paints Washington's ground blue", at(washington.x, washington.y), OWNERSHIP.blue);
  eq("the raster paints sea as sea", at(sea.x, sea.y), OWNERSHIP.sea);
  const berlin = siteByName(match, "Berlin");
  const berlinCell = at(berlin.x, berlin.y);
  if (berlinCell !== OWNERSHIP.red && berlinCell !== OWNERSHIP.edge.red) {
    fail("Berlin's ground is neither red nor its outlined edge: " + berlinCell);
  }

  // GREENLAND RULING (T-018 AC4 follow-up). Not a paint bug: a data answer, settled off the
  // capture, not off preference. docs/captures/era-1942-blue-ownership.png is a 1024x768 shot of the
  // live ownership view at the world fit; the map is drawn at 2 px per cell from (192, 196), so
  // region 125's 476 cells land on 476 pixels. Sampled there: 345 read #ffffff and 131 read #55ffff
  // (sea inside the quad), ZERO read #5555ff / #0000aa / #ff5555 / #aa0000. Two regions in that
  // shot are white - Spain and Greenland - and the served tally is neutral 2, so the white one is
  // the answer. territory.json byEra["1942"] carries a null site for region 125 and only that one
  // region, which is why its owner cannot be blue: an owner comes from a site record. This pin
  // walks every cell region 125 covers and refuses any side ink; a cell outside the quad may read
  // sea, it may never read blue or red.
  const greenRid = 125;
  const greenGrid = ownershipGrid(geometry);
  if (!greenGrid) fail("the baked cell -> region grid did not build");
  const greenCells = [];
  for (let i = 0; i < board.width * board.height; i++) if (greenGrid[i] === greenRid) greenCells.push(i);
  if (!greenCells.length) fail("region 125 covers no cell on the baked grid");
  const greenInks = new Set(greenCells.map((i) => raster.ink[i]));
  for (const ink of greenInks) {
    if (ink !== OWNERSHIP.neutral && ink !== OWNERSHIP.sea) {
      fail("Greenland is painted " + ink + ", the capture has white ground and sea only");
    }
  }

  // The reverse lookup the placement and aid work (T-023) will ask for.
  const held = regionsHeldBy(match, "red");
  eq("red holds the regions the legend counts", held.length, opening.tally.red);

  const tally = ownershipTally(opening.owners);
  eq("the legend counts the same regions the map fills", tally, opening.tally);

  // ---- the delta frame carries the new owner list (rider 1 from the T-018 gate, room 5954) ----
  // A seat usually sees a capture in a delta, not a whole frame, so a dropped ownership carry would
  // leave a stale fill after a sync and nothing in the suite would go red. Two cases, both needed:
  // unchanged ownership must not spend the payload, changed ownership must ride WHOLE.
  const seatView = {
    round: 3, clock: "held", note: "", seat: { blue: "a", red: "b" }, capitals: { blue: 1, red: 2 },
    capitalList: [], pieces: [], routes: {}, sites: [], ownership: opening,
  };
  const shadow = seatShadowOf(seatView);
  const quiet = deltaBetween(shadow, seatView);
  if (quiet.ownershipChanged) fail("the delta claims ownership changed when it did not");
  if ("ownership" in quiet) fail("the delta carried an owner list that did not change");

  const nextOwners = opening.owners.slice();
  nextOwners[heldRegions[0]] = "blue";
  const nextOwnership = { ready: true, era: "1942", owners: nextOwners,
    tally: ownershipTally(nextOwners) };
  const moved = deltaBetween(shadow, { ...seatView, round: 4, ownership: nextOwnership });
  if (!moved.ownershipChanged) fail("the delta missed a changed owner list");
  if (!moved.ownership || !Array.isArray(moved.ownership.owners)) fail("the delta did not carry ownership");
  eq("the delta rides the owner list whole", moved.ownership.owners.length, 184);
  eq("the delta's list is the new one", moved.ownership.owners[heldRegions[0]], "blue");


  return "184 regions; 1942 blue 146 / red 36 / neutral 2; Washington, Moscow, London blue; "
    + "Berlin, Paris, Tokyo red; Spain and Greenland unheld; Cam Ranh recolours "
    + heldRegions.length + " regions on capture; measured palette pinned";
}

// The baked grid, read once: the test uses the same run list the page does.
function territoryRuns() {
  if (!TERRITORY) fail("no territory.json");
  return TERRITORY.regionRuns;
}

// The shadow shape lobby.setSeatShadow writes for a seat, so deltaBetween is exercised on the
// bytes it will actually see rather than on a hand-shaped object.
function seatShadowOf(view) {
  const signature = (value) => JSON.stringify(value);
  const pieces = {};
  const routes = {};
  const sites = {};
  for (const piece of view.pieces || []) pieces[piece.id] = signature(piece);
  for (const [id, steps] of Object.entries(view.routes || {})) routes[id] = signature(steps);
  for (const site of view.sites || []) sites[site.id] = site.owner ?? null;
  return {
    round: view.round,
    clock: view.clock,
    note: view.note,
    seat: signature(view.seat),
    capitals: signature(view.capitals),
    capitalList: signature(view.capitalList || null),
    ownership: signature(view.ownership || null),
    pieces,
    routes,
    sites,
  };
}
