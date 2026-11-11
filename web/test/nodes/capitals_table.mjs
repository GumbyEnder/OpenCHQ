// Node capitals_table: the era's capital set, before any engine change touches it.
//
// B-3a measured the rule in the original (Ghidra 1c0d:000c, plus turn-0 RAM and screen captures):
// a site is a capital when `byte & 7` is 1 or 2, its owner is `byte & 0xC0` (0x40 blue, 0x80 red,
// 0x00 neutral), and a side has won only when it owns every active capital. This node pins the set
// the engine must use, so B-3b's tick/ownership change cannot quietly invent a different one:
//
//   1918: 3 capitals - 10 London blue, 11 Berlin red, 17 Paris blue
//   1942: 6 capitals - 10 London blue, 11 Berlin red, 17 Paris red, 35 Tokyo red,
//                      62 Washington blue, 63 Moscow blue
//   1986: 4 capitals - 10 London blue, 35 Tokyo blue, 62 Washington blue, 63 Moscow red
//   2023, 9999 (the concealed start, shown as ????): no subtype-1/2 row at all, so two rolled
//                 capitals at launch, drawn after seeding.
//
// The counts and owners come from web/data/eras.json alone, which ships with the repo, so this half
// always runs. The names and cells need the site list (the extract); without it that half is skipped
// by name rather than passed silently.
import { matchSites } from "../../server/board.mjs";
import { capitalRows, capitalSet, capitalsFromFile, rollCapitals } from "../../server/capitals.mjs";

export const name = "capitals_table";

const FIXED = {
  1918: { count: 3, owners: { 10: "blue", 11: "red", 17: "blue" }, names: { 10: "London", 11: "Berlin", 17: "Paris" } },
  1942: {
    count: 6,
    owners: { 10: "blue", 11: "red", 17: "red", 35: "red", 62: "blue", 63: "blue" },
    names: { 10: "London", 11: "Berlin", 17: "Paris", 35: "Tokyo", 62: "Washington", 63: "Moscow" },
  },
  1986: {
    count: 4,
    owners: { 10: "blue", 35: "blue", 62: "blue", 63: "red" },
    names: { 10: "London", 35: "Tokyo", 62: "Washington", 63: "Moscow" },
  },
};

export async function run(ctx) {
  const { fail } = ctx;

  // 1. The table itself: count and owner per era, straight from eras.json.
  for (const [era, want] of Object.entries(FIXED)) {
    const { rows, source } = capitalRows(era);
    if (source !== "file") fail(era + ": owner source is " + source + ", the file wrote one");
    if (rows.length !== want.count) {
      fail(era + " has " + rows.length + " capitals, the original has " + want.count + " (" +
        rows.map((row) => row.id + ":" + row.owner).join(" ") + ")");
    }
    for (const row of rows) {
      const owner = want.owners[row.id];
      if (owner === undefined) fail(era + ": id " + row.id + " is a capital in the table and not in the measured set");
      if (row.owner !== owner) fail(era + ": id " + row.id + " is " + row.owner + " in the table, measured " + owner);
    }
    // Every measured owner is accounted for, so the table can neither add nor drop a capital.
    const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
    const wanted = Object.keys(want.owners).map(Number).sort((a, b) => a - b);
    if (ids.join(",") !== wanted.join(",")) fail(era + ": capital ids " + ids.join(",") + ", measured " + wanted.join(","));
  }

  // 2. The rolled years ship no capital row. If that ever changes, this node says so instead of
  //    letting the roll hide a data change. 2023 has a baked row with no subtype-1/2 entry; 9999 has
  //    no baked row at all (tools/bake_eras.mjs refuses row 4), so its source is "none".
  for (const [era, wantSource] of [["2023", "rolled"], ["9999", "none"]]) {
    const { rows, source } = capitalRows(era);
    if (rows.length) fail(era + " now carries " + rows.length + " subtype-1/2 rows; the roll is no longer the reading");
    if (source !== wantSource) fail(era + " owner source is " + source + ", expected " + wantSource);
  }

  // 3. A neutral capital counts for neither side: the winner is nobody unless one side owns every
  //    capital in the set. Pinned against tick.checkWin - the single implementation - rather than
  //    against a copy in capitals.mjs.
  const { checkWin } = await import("../../server/tick.mjs");
  const matchOf = (list) => ({
    sites: list.map((c) => ({ id: c.siteId, owner: c.owner })),
    capitalSet: { list, missing: [] },
  });
  const mixed = [
    { siteId: 10, owner: "blue" },
    { siteId: 11, owner: null },
  ];
  if (checkWin(matchOf(mixed)) !== null) {
    fail("a neutral capital did not block both sides");
  }
  const blueAll = [
    { siteId: 10, owner: "blue" },
    { siteId: 11, owner: "blue" },
  ];
  if (checkWin(matchOf(blueAll)) !== "blue") {
    fail("owning every capital is not a win");
  }

  // 4. Names and cells, when the site list is on this host.
  const sites = matchSites("1986");
  if (!sites.length) {
    return ctx.skip("no site list on this host, so capital names and cells were not checked");
  }
  const joined = capitalsFromFile("1986", sites);
  if (joined.missing.length) fail("1986: capital ids " + joined.missing.join(",") + " have no live site");
  for (const capital of joined.list) {
    const want = FIXED["1986"].names[capital.siteId];
    if (capital.name !== want) fail("1986: id " + capital.siteId + " is " + capital.name + ", measured " + want);
  }

  // 5. A rolled year gives each side one capital, drawn from the sites that side owns (so on a board
  //    where nobody owns anything yet, both picks fall back to any holdable site and `owner` is null -
  //    the side that drew it is `drawnBy`). The same seed gives the same two capitals twice.
  for (const era of ["2023", "9999"]) {
    const list = matchSites(era);
    if (!list.length) continue;
    const set = capitalSet(era, list, "capitals-table-seed");
    if (set.source !== "rolled") fail(era + ": capital source is " + set.source + ", expected rolled");
    if (set.list.length !== 2) fail(era + ": rolled " + set.list.length + " capitals, the original has 2");
    const sides = new Set(set.list.map((capital) => capital.drawnBy));
    if (sides.size !== 2) fail(era + ": the roll gave both capitals to " + [...sides].join(","));
    const again = capitalSet(era, list, "capitals-table-seed");
    if (JSON.stringify(again.list) !== JSON.stringify(set.list)) fail(era + ": the same seed rolled different capitals");
    for (const capital of set.list) {
      const site = list.find((place) => Number(place.id) === capital.siteId);
      if (!site) fail(era + ": rolled capital " + capital.siteId + " is not a live site");
      if (site.owner !== capital.owner && site.owner) {
        fail(era + ": rolled capital " + capital.siteId + " sits on " + site.owner + " ground for " + capital.owner);
      }
    }
    // Two capitals cannot share a cell.
    if (set.list[0].x === set.list[1].x && set.list[0].y === set.list[1].y) fail(era + ": both capitals are on one cell");
  }

  // A roll of an empty list is no capitals, not a crash.
  if (rollCapitals([], 1).length !== 0) fail("a roll over no sites invented capitals");
}
