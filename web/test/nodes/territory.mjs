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
import { readFileSync } from "node:fs";
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


  // ---- the concealed era rides the 2023 territory row (PB-087, room 6300) -----------------------
  // Concealed ("9999") has no CBR-REGN row of its own, so the bake donates the 2023 row by name:
  // byEra["9999"] = byEra["2023"] in tools/bake_territory.mjs. That is a deliberate remake choice
  // (whether the 1990 original does the same is UNVERIFIED), not a recovered rule. Without the row
  // the whole Concealed campaign's Show Ownership view answers ready:false and paints nothing.
  const concealed = regionSites("9999");
  if (!Array.isArray(concealed)) fail("the concealed era has no region row: regionSites(\"9999\") is null");
  eq("the concealed era covers 184 regions", concealed.length, 184);
  eq("the concealed era's row is the 2023 row", concealed, regionSites("2023"));
  const concealedMatch = openMatch("9999", matchSites("9999", board));
  const concealedOwnership = ownershipOf(concealedMatch);
  if (!concealedOwnership.ready) fail("ownershipOf is not ready on the concealed era");
  eq("concealed ownership follows every region", concealedOwnership.owners.length, 184);

  // The row indexes the roster the era actually builds, and that roster is NOT 84 long: the modern
  // eras append dock records, so 2023 and Concealed carry 271 sites (62 city + 2 capital +
  // 20 facility + 150 dock + 37 oilfield) while the era row's ids stop at 83. Pin the prefix, not
  // the length, or a dock-heavy roster reads as a broken row (PB-087, frodo 6295 item 7b).
  eq("the concealed roster is the modern 271-site roster", concealedMatch.sites.length, 271);
  const prefix = (list) => list.slice(0, 84).map((s) => s.id + "|" + s.name).join(";");
  eq("the first 84 of the concealed roster are the 2023 sites", prefix(concealedMatch.sites),
    prefix(openMatch("2023", matchSites("2023", board)).sites));
  const highestAssigned = Math.max(...concealed.filter((v) => v !== null));
  if (!(highestAssigned < concealedMatch.sites.length)) {
    fail("the concealed row assigns site " + highestAssigned + " of " + concealedMatch.sites.length);
  }

  // The donor is a COPY, not an alias (room 6312 item 4). JSON serialisation splits the two rows
  // whatever the bake did, so the served artifact cannot tell a copy from an alias; the pin belongs
  // on the bake source, which is what a re-run uses.
  const bakeSrc = readFileSync(new URL("../../../tools/bake_territory.mjs", import.meta.url), "utf8");
  if (!bakeSrc.includes('byEra["9999"] = byEra["2023"].slice();')) {
    fail("the bake aliases the concealed row to 2023 instead of copying it");
  }

  // Negative control: a label with no baked row must still answer null / not ready, or the pin above
  // is a fallback that answers for any year rather than a row the bake actually wrote.
  if (regionSites("8888") !== null) fail("an era with no baked row returned a region row");
  if (ownershipOf({ era: "8888", sites: [] }).ready) fail("ownershipOf claims ready for an era with no row");

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
