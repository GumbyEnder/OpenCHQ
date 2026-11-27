// Node site_join_1918: the region -> site join follows the site's ID, not its array position (PB-092).
//
// The era rows (CBR-REGN.DT0..DT4, baked into web/data/territory.json) name the site that governs
// each of the 184 regions by id. ownersFor() used to resolve that id with `match.sites[Number(id)]`,
// which is an ARRAY INDEX, and the match roster is not id-ordered: 1918's 184 entries carry string
// ids (`dock:39:34`) inside the first 84 slots, so 183 of the 184 regions resolved to a different
// site record than the row named, 147 of them to a different owner. On the seeded 1918 openMatch
// the served tally was 50 blue / 72 red / 62 neutral where the id join serves 52/24/108 (the row
// leaves one slot empty; it counts neutral on both readings), and Show Ownership painted neutral
// over ground the original hands to a side. The row's 52 distinct ids name 25 distinct sites, 14
// blue / 9 red / 2 neutral. The same join
// is what isFriendly() (peacetime placement, foreign aid) and regionsHeldBy() read, so the defect
// reached two rules and not just the paint.
//
// The pins below are built from an id-keyed Map in this file, never from territory.mjs's own helper,
// so a regression in the join cannot agree with itself. The last block is the discriminator: it
// recomputes the old index reading and refuses to pass unless at least one region in 1918 actually
// differs, which is the shape the ticket was filed on (a roster where ids and positions agree would
// make every assertion here vacuous).
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import {
  NO_REGION, isFriendly, ownershipOf, regionAt, regionLabel, regionSites, regionsHeldBy,
} from "../../server/territory.mjs";

export const name = "site_join_1918";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

// The oracle: the row id names a site, the site record carries the owner. No index arithmetic.
function expectedOwners(match, row) {
  const byId = new Map();
  for (const site of match.sites || []) byId.set(String(site.id), site);
  return row.map((siteId) => {
    if (siteId === null || siteId === undefined) return null;
    const site = byId.get(String(siteId));
    if (!site) return null;
    return site.owner === "blue" || site.owner === "red" ? site.owner : null;
  });
}

// The pre-PB-092 reading, kept only to prove this fixture can see the difference.
function indexOwners(match, row) {
  return row.map((siteId) => {
    if (siteId === null || siteId === undefined) return null;
    const site = match.sites[Number(siteId)];
    if (!site) return null;
    return site.owner === "blue" || site.owner === "red" ? site.owner : null;
  });
}

export async function run() {
  const eras = ["1918", "1942", "1986"];
  const asOf = {};

  for (const era of eras) {
    const row = regionSites(era);
    if (!Array.isArray(row)) fail(era + " has no region row in the bake");
    const match = openMatch(era, matchSites(era));
    if (!match.sites.length) fail(era + " has no sites to join");
    seedOwners(match);

    const owners = ownershipOf(match).owners;
    eq(era + ": one owner entry per region row", owners.length, row.length);
    eq(era + ": the join follows the row's site ID", owners, expectedOwners(match, row));
    asOf[era] = { match, row, owners };
  }

  // 1918 is the era the ticket was filed on, and it must still be a real fixture. If the index
  // reading ever agrees with the id reading here, this test has stopped testing anything.
  const { match, row, owners } = asOf["1918"];
  const viaIndex = indexOwners(match, row);
  const differing = owners.reduce((n, owner, rid) => (owner === viaIndex[rid] ? n : n + 1), 0);
  if (differing < 1) fail("1918: the index reading agrees with the id reading everywhere, so this fixture proves nothing");
  // PB-320: the count moved 147 -> 149 when a dock's owner started following its port (two more
  // regions now read a different owner through the index). The fixture's claim is "the readings
  // differ", not a frozen count, so pin the floor and the direction rather than the number.
  if (differing < 100) fail("1918: the pre-fix index reading puts a different OWNER on only " + differing + " regions; the fixture has stopped proving the join matters");
  let wrongSite = 0;
  for (const siteId of row) {
    if (siteId === null || siteId === undefined) continue;
    const site = match.sites[Number(siteId)];
    if (!site || String(site.id) !== String(siteId)) wrongSite += 1;
  }
  eq("1918: the pre-fix index reading names the wrong SITE for 183 of 184 regions", wrongSite, 183);

  // The named rows from the ticket, read at the region the cells fall in.
  const tally = ownershipOf(match).tally;
  eq("1918: blue regions name a blue governing site", tally.blue, owners.filter((o) => o === "blue").length);
  for (const [x, y, side] of [[223, 72, "blue"], [223, 73, "blue"], [319, 87, "blue"]]) {
    const rid = regionAt(x, y);
    if (rid === NO_REGION) fail(`(${x},${y}) has no region in 1918`);
    eq(`1918 (${x},${y}) region ${rid} is held by ${side}`, owners[rid], side);
  }

  // The two rules that read the same join. isFriendly answers at the region's own label point; the
  // held list must be exactly the regions the owner list names, in region id order.
  const held = regionsHeldBy(match, "blue");
  const named = owners.map((owner, rid) => (owner === "blue" ? rid : -1)).filter((rid) => rid >= 0);
  eq("1918: regionsHeldBy(blue) is the owner list's blue regions, in order", held.map((r) => r.id), named);
  if (!held.length) fail("1918: no region is held by blue, so isFriendly proves nothing");
  let checked = 0;
  for (const region of held) {
    const label = regionLabel(region.id);
    if (!label) continue;
    if (regionAt(label.x, label.y) !== region.id) continue;
    eq(`1918: isFriendly(blue) at region ${region.id}'s label point`, isFriendly(match, "blue", label.x, label.y), true);
    checked += 1;
  }
  if (checked < 3) fail("1918: only " + checked + " held regions could be probed at their label point");
}
