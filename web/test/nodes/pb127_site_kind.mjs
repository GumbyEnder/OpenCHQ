// Node pb127_site_kind: the era's subtype demotes a capital-kind site to city, and income pays it.
//
// PB-127 row 1. web/data/world.json calls 62 Washington and 63 Moscow capitals for every year, but
// the 1918 file row carries subtype 4 (city) for both. economy.incomeCounts counts only CITY_KINDS
// (economy.mjs:31) unless money.capitalPays is on, and it is off (game.json:182), so each side was
// short one city's income per round in 1918 (cityIncome 50). The fix is DEMOTE-ONLY on a
// file-sourced row with subtype 4; the win condition stays capitalSet, which reads subtype 1/2.
//
// Pinned here:
//   1. 1918: 62/63 arrive kind city with their file owners and payoutFor pays them as cities; a
//      copy of the same match with kind put back to capital pays 50 less per city, which is the
//      defect this leg exists to catch.
//   2. 1942 and 1986: no capital is demoted and no city is promoted - London (type 1 at 1918 and
//      1942) and Tokyo (type 2 at 1942, type 1 at 1986) stay kind city exactly as they were.
//   3. 1986 asserts ZERO kind changes over all 84 ids and names each of the 14 eras.json _meta
//      disagreements one by one (the 12 type-3 sites plus London and Tokyo), with its type and the
//      asset list's word.
//   4. 2023 is skipped on source: its row carries subtype 4 for 62/63, but it rolls owners and
//      capitals, so machine kinds do not move.
//   5. capitalSet and the win check keep reading subtype 1/2: 1918's set is 10/11/17 and does not
//      contain 62 or 63.

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { applyEra } from "../../server/era.mjs";
import { payoutFor } from "../../server/economy.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { unpackMatch } from "../../server/rooms.mjs";

export const name = "pb127_site_kind";

function fail(message) {
  throw new Error("node test pb127_site_kind: " + message);
}

function siteOf(list, id) {
  const site = (list || []).find((place) => place && Number(place.id) === Number(id));
  if (!site) fail("no site " + id + " in the list");
  return site;
}

function kindMap(list) {
  const map = new Map();
  // Docks and oil wells carry string ids ("dock:181:12"), so the key is the id as written.
  for (const site of list || []) if (site) map.set(String(site.id), site.kind);
  return map;
}

// eras.json _meta, as the bake wrote it: 1986 disagrees with world.json on 14 of 84 sites.
const META_1986 = [
  { id: 0, type: 3 }, { id: 1, type: 3 }, { id: 2, type: 3 }, { id: 4, type: 3 },
  { id: 21, type: 3 }, { id: 22, type: 3 }, { id: 51, type: 3 }, { id: 52, type: 3 },
  { id: 54, type: 3 }, { id: 55, type: 3 }, { id: 57, type: 3 }, { id: 58, type: 3 },
  { id: 10, type: 1 }, { id: 35, type: 1 },
];

export async function run() {
  const base = boardPayload().sites || [];
  if (!base.length) fail("the board carries no sites, so the era table cannot be tested");
  const worldKind = kindMap(base);

  // 1. 1918: the two capitals are demoted and paid.
  const sites1918 = matchSites("1918");
  const w = siteOf(sites1918, 62);
  const m = siteOf(sites1918, 63);
  if (w.kind !== "city") fail("1918 Washington (62) is " + JSON.stringify(w.kind) + ", not city");
  if (m.kind !== "city") fail("1918 Moscow (63) is " + JSON.stringify(m.kind) + ", not city");
  if (w.owner !== "blue" || m.owner !== "red") {
    fail("1918 62/63 owners are " + JSON.stringify([w.owner, m.owner]) + ", expected blue/red");
  }

  const match1918 = openMatch("1918", sites1918);
  const paid = payoutFor(match1918, "blue");
  // The same match with the pre-fix kind on 62: the defect shape, kept local.
  const regressed = {
    ...match1918,
    sites: match1918.sites.map((site) => (Number(site.id) === 62 ? { ...site, kind: "capital" } : site)),
  };
  const unpaid = payoutFor(regressed, "blue");
  if (paid.cities !== unpaid.cities + 1 || paid.amount !== unpaid.amount + 50) {
    fail("1918 blue pays " + paid.cities + " cities/" + paid.amount + "M with 62 as city and " +
      unpaid.cities + " cities/" + unpaid.amount + "M with it as capital; expected exactly one city and 50M more");
  }
  if (paid.cities < 2) fail("1918 blue pays " + paid.cities + " cities, so the leg cannot see 62 among them");

  // 2. No promotion, no demotion outside 1918's two.
  const kinds1942 = kindMap(matchSites("1942"));
  for (const id of [10, 35]) {
    if (kinds1942.get(String(id)) !== worldKind.get(String(id))) {
      fail("1942 promoted site " + id + " from " + JSON.stringify(worldKind.get(String(id))) + " to " + JSON.stringify(kinds1942.get(String(id))));
    }
  }
  for (const id of [62, 63]) {
    if (kinds1942.get(String(id)) !== "capital") fail("1942 site " + id + " is " + JSON.stringify(kinds1942.get(String(id))) + ", not capital");
  }

  const kinds1986 = kindMap(matchSites("1986"));
  const changed = [];
  // Compare the 84-row asset list only: matchSites also carries the 150 docks and the wells the
  // asset list does not name at all, and those have no world.json kind to compare against.
  for (const [id, kind] of worldKind) {
    if (kinds1986.get(id) !== kind) changed.push("id " + id + " " + JSON.stringify(kind) + " -> " + JSON.stringify(kinds1986.get(id)));
  }
  if (changed.length) fail("1986 changed " + changed.length + " kinds (" + changed.join(", ") + "); the rule is a no-op there");

  // 3. The 14 _meta rows, named one at a time. Each keeps world.json's word and carries the type
  //    the bake read; a silent 3->city mapping would move the eleven (plus 0) *and* pass a bare
  //    "zero changes" count only if it agreed with world.json by accident.
  const table1986 = matchSites("1986");
  const named = [];
  for (const row of META_1986) {
    const site = siteOf(table1986, row.id);
    if (Number(site.type) !== row.type) {
      fail("1986 disagreement id " + row.id + " carries type " + JSON.stringify(site.type) + ", the _meta says " + row.type);
    }
    if (site.kind !== worldKind.get(String(row.id))) {
      fail("1986 disagreement id " + row.id + " changed kind from " + JSON.stringify(worldKind.get(String(row.id))) + " to " + JSON.stringify(site.kind));
    }
    named.push("id " + row.id + " (type " + row.type + ", world.json " + worldKind.get(String(row.id)) + ") kept its kind");
  }
  if (named.length !== 14) fail("named " + named.length + " of the 14 _meta disagreements");

  // 4. A rolled era is skipped on source, not on year: 2023's row says subtype 4 for 62/63 and its
  //    capitals are rolled, so kind must not move.
  const rolled = applyEra(base, "2023");
  const kinds2023 = kindMap(rolled);
  for (const id of [62, 63]) {
    if (kinds2023.get(String(id)) !== worldKind.get(String(id))) {
      fail("2023 moved rolled site " + id + " from " + JSON.stringify(worldKind.get(String(id))) + " to " + JSON.stringify(kinds2023.get(String(id))));
    }
  }
  for (const [id, kind] of worldKind) {
    if (kinds2023.get(id) !== kind) fail("2023 moved site " + id + " from " + JSON.stringify(kind) + " to " + JSON.stringify(kinds2023.get(id)));
  }

  // 5. The win set is still subtype 1/2. 1918's three capitals are 10/11/17 and 62/63 are not in it.
  const set = match1918.capitalSet && match1918.capitalSet.list;
  if (!Array.isArray(set) || set.length !== 3) {
    fail("1918 capitalSet is " + JSON.stringify(set && set.map((capital) => capital.siteId)) + ", expected three entries");
  }
  const ids = set.map((capital) => Number(capital.siteId)).sort((a, b) => a - b);
  if (JSON.stringify(ids) !== JSON.stringify([10, 11, 17])) {
    fail("1918 capitalSet ids are " + JSON.stringify(ids) + ", expected [10,11,17]");
  }
  if (ids.includes(62) || ids.includes(63)) fail("capitalSet picked up a demoted site: " + JSON.stringify(ids));

  // 6. The alarm names a capital by membership, not by kind. 1918's blue seat is London (10), and
  //    world.json calls it a city, so `kind === "capital"` never named it even before the demotion;
  //    the pin is that a red piece two cells away produces a threat event carrying "London", not
  //    the "your capital" fallback.
  const alarm = openMatch("1918", matchSites("1918"));
  const london = siteOf(alarm.sites, 10);
  alarm.clock = "running";
  alarm.pieces = [{
    id: "red:probe:1", side: "red", domain: "land", kind: "infantry",
    x: Number(london.x) + 2, y: Number(london.y), strength: 100, path: [],
  }];
  const tick = tickMatch(alarm);
  const threat = (tick.events || []).find((event) => event && event.type === "threat" && event.side === "blue");
  if (!threat) fail("1918 placed no blue threat event for a red piece 2 cells from London");
  if (threat.name !== "London") {
    fail("the 1918 blue alarm named " + JSON.stringify(threat.name) + ", expected London (membership, not kind)");
  }

  // 7. PB-124 condition (PM 6795): a RESUMED 1918 room keeps 62/63 as city. The resume path rebuilds
  //    its statics through siteStatics(era) -> matchSites(era), so the demotion in applyEra is the
  //    one place the kind is decided; this asserts the load, not just the launch.
  const saved = openMatch("1918", matchSites("1918"));
  const packed = {
    era: saved.era,
    round: 3,
    roundSeconds: saved.roundSeconds,
    clock: "held",
    pieces: [],
    sides: saved.sides,
    capitals: saved.capitals,
    capitalSet: saved.capitalSet,
    foughtRound: -1,
    winner: null,
    over: false,
    siteIds: saved.sites.map((site) => site.id),
    siteOwners: {
      blue: saved.sites.filter((site) => site.owner === "blue").map((site) => site.id),
      red: saved.sites.filter((site) => site.owner === "red").map((site) => site.id),
    },
    sitesUnready: [],
    siteReadyRounds: {},
    moneyUnit: "millions",
  };
  const resumed = unpackMatch(packed);
  const resumedSites = (resumed && Array.isArray(resumed.sites)) ? resumed.sites : [];
  const resume62 = resumedSites.find((site) => site && Number(site.id) === 62);
  const resume63 = resumedSites.find((site) => site && Number(site.id) === 63);
  if (!resume62 || !resume63) fail("a resumed 1918 room has no site 62 or 63");
  if (resume62.kind !== "city" || resume63.kind !== "city") {
    fail("a resumed 1918 room has 62/63 as " + JSON.stringify([resume62.kind, resume63.kind]) + ", expected city/city");
  }
  if (resume62.owner !== "blue" || resume63.owner !== "red") {
    fail("a resumed 1918 room lost the owners: " + JSON.stringify([resume62.owner, resume63.owner]));
  }
  if (resumedSites.length !== saved.sites.length) {
    fail("a resumed 1918 row rebuilt " + resumedSites.length + " sites, saved " + saved.sites.length);
  }

  console.log("pb127_site_kind ok: 1918 62/63 city + paid (" + paid.cities + " cities/" + paid.amount + "M blue, " +
    "regressed shape " + unpaid.cities + "/" + unpaid.amount + "M); 1942/1986 kinds unmoved; " + named.length +
    " _meta rows named; 2023 rolled skipped; 1918 capitalSet " + JSON.stringify(ids) + "; alarm names " + threat.name +
    "; resumed 62/63 " + [resume62.kind, resume63.kind].join("/"));
}
