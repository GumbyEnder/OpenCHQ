// Site subtype: the one place the numeric `type` byte is interpreted.
//
// PB-150/PB-153/T-033 all read the same 84-row era table (web/data/eras.json). The table's
// `type` is the original's site subtype, low three bits of the site byte:
//
//   0 absent   1/2 capital   3 base   4 city   5 oil field
//
// `kind` is the asset list's word and disagrees with the subtype on 14 of 84 sites at 1986
// (era.mjs's header has the full list), so every rule that the ORIGINAL keys on the subtype
// must read `type`, not `kind`. Docks and the sketched `wells` from world.json carry no
// subtype: they are 0 for every rule here (they never pay, never produce oil, never count as
// an oil field). A synthetic site with no `type` is mapped from its kind, which is the only
// honest fallback for a test board.
//
// Sources: PB-150 (income = count(4) + max(0, count(1) + count(2) − 1), FUN_2dfc_1246 @
// 2dfc:1246); PB-153 (type 5 = the 20 `facility` sites, ids 64-83); T-033 (In = type 5).

// The numeric subtype for a site, or 0 when it has none. `site.type` wins when it is an
// integer: the era table wrote it, and kind is only the fallback for boards built by hand.
//
// This runs once per site per room per round on the bench's hot path (buildOilSummary), so it
// is written without Number()/String() calls or an object lookup: `String(undefined)` and
// `Number(undefined)` per site across 1000 rooms cost ~6 ms of a 0.14 s round on their own.
// The direct `kind === "..."` compares allocate nothing.
export function siteTypeOf(site) {
  if (!site) return 0;
  const type = site.type;
  if (typeof type === "number" && Number.isInteger(type) && type >= 0) return type;
  const kind = site.kind;
  if (kind === "city") return 4;
  if (kind === "facility") return 5;
  if (kind === "capital") return 1;
  if (kind === "base") return 3;
  return 0;
}

// A type-5 site: the original's oil field (PB-153). world.json's `oilfield`/`well` rows are a
// hand-placed sketch and are NOT oil fields under this rule; they carry no subtype.
export function isOilField(site) {
  return siteTypeOf(site) === 5;
}

// A paying city: subtype 4. Bases (3), oil fields (5), docks (0) and capitals (1/2) never pay
// on their own; a side's capitals pay through the "one extra" rule below.
export function isPayingCity(site) {
  return siteTypeOf(site) === 4;
}

export function isCapitalSite(site) {
  const type = siteTypeOf(site);
  return type === 1 || type === 2;
}

// The paying count for one side from its owned sites, the original's expression:
//     count(type 4) + max(0, count(type 1) + count(type 2) − 1)
// i.e. every city pays and the side's extra capitals pay as cities, one of them free.
export function payingCount(sites) {
  let cities = 0;
  let capitals = 0;
  for (const site of Array.isArray(sites) ? sites : []) {
    const type = siteTypeOf(site);
    if (type === 4) cities += 1;
    else if (type === 1 || type === 2) capitals += 1;
  }
  return cities + Math.max(0, capitals - 1);
}
