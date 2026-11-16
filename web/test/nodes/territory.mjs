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
import { OWNERSHIP, ownershipInk, ownershipRaster, ownershipTally } from "../../public/render.mjs";

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
  // The reverse lookup the placement and aid work (T-023) will ask for.
  const held = regionsHeldBy(match, "red");
  eq("red holds the regions the legend counts", held.length, opening.tally.red);

  const tally = ownershipTally(opening.owners);
  eq("the legend counts the same regions the map fills", tally, opening.tally);

  return "184 regions; 1942 blue 146 / red 36 / neutral 2; Washington, Moscow, London blue; "
    + "Berlin, Paris, Tokyo red; Spain and Greenland unheld; Cam Ranh recolours "
    + heldRegions.length + " regions on capture; measured palette pinned";
}

// The baked grid, read once: the test uses the same run list the page does.
function territoryRuns() {
  if (!TERRITORY) fail("no territory.json");
  return TERRITORY.regionRuns;
}
