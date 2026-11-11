// A site's cell, indexed once per site list instead of searched per piece per round.
//
// economy.upkeep asked `wellAt` for every piece of every room every round, and each answer
// walked all 84 sites with a Number() pair per row: a 1000-room round paid ~672 site visits
// per room for a lookup the board already knows. The index is keyed on the sites array itself
// (a match keeps the same array while it plays; ownership mutates the objects, not the array),
// so the build is amortised over the whole match.
//
// The first site on a cell wins, matching `sites.find(...)` - a duplicated cell must resolve
// the way it did before, not to the last row.

import { CELL_W } from "./board.mjs";

const cache = new WeakMap();

function key(x, y) {
  return Number(y) * CELL_W + Number(x);
}

export function siteIndex(sites) {
  if (!Array.isArray(sites) || sites.length === 0) return null;
  const known = cache.get(sites);
  // The list is not expected to grow mid-match, but a caller that rebuilds it in place would
  // otherwise get a stale answer: length is the cheap guard, and a miss is a rebuild.
  if (known && known.length === sites.length) return known;
  const byCell = new Map();
  // Cells aligned with the sites array (null for a missing row), so a caller that must walk the
  // list - occupy does, because a duplicated cell still names every site - skips the Number()
  // pair per site per round.
  const cells = new Array(sites.length).fill(null);
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    if (!site) continue;
    const at = key(site.x, site.y);
    if (!Number.isFinite(at)) continue;
    cells[i] = at;
    if (byCell.has(at)) continue;
    byCell.set(at, site);
  }
  byCell.length = sites.length;
  byCell.cells = cells;
  cache.set(sites, byCell);
  return byCell;
}

// The cell keys aligned with the sites array, for a caller that has to visit every row.
export function siteCells(sites) {
  const byCell = siteIndex(sites);
  return byCell && byCell.cells ? byCell.cells : null;
}

export function siteAtCell(sites, x, y) {
  const byCell = siteIndex(sites);
  if (!byCell) return null;
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return byCell.get(key(cx, cy)) || null;
}

// A per-kind cell set, for the refill rule: built once per site list per kind, then a piece
// standing on a site is one set hit instead of an 84-row scan. The sets are shared, read-only.
const kindCache = new WeakMap();

export function cellsOfKinds(sites, kinds) {
  const byCell = siteIndex(sites);
  const cells = new Set();
  if (!byCell || !Array.isArray(kinds) || kinds.length === 0) return cells;
  const wanted = new Set(kinds.map(String));
  let known = kindCache.get(sites);
  if (!known) {
    known = new Map();
    kindCache.set(sites, known);
  }
  const stamp = [...wanted].sort().join("|");
  const built = known.get(stamp);
  if (built) return built;
  for (const [cell, site] of byCell) {
    if (wanted.has(String(site.kind))) cells.add(cell);
  }
  known.set(stamp, cells);
  return cells;
}

export function cellKeyOf(piece) {
  return key(piece.x, piece.y);
}
