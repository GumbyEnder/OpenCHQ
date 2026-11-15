// Where a bought unit may be placed. D-019: the original's rule, not a radius, with D-025's
// coastal-city ship berths on top (T-021) and D-026's multi-cell footprints (T-026).
//
// Manual p.27, "General Placement Rules": "every city and base you own is highlighted. Land
// units and aircraft may be placed in any friendly city or base. Ships may be placed only on
// docks, so if all your ports are conquered you can't build ships."
//
// D-019 (T-011) reads that as the site CELL. D-026 (Q45, measured on the live original) reads it
// as the site's FOOTPRINT: a city is several painted cells, a click on any of them is legal, and
// the unit lands on the cell that was clicked rather than snapping to the centre. The footprint
// comes from the runtime site painter: FUN_20b1_1a24 @ 20b1:1a24 (decompiled.c:13935-13975)
// paints the site centre, then FUN_20b1_1b42 @ 20b1:1b42 (decompiled.c:13981-14179) paints the
// eight ring cells around it, keeping a cell only where the terrain under it is land
// (`2 < get_terrain_type(...)`); a water neighbour is painted as docks instead. So the footprint
// of a city, capital or base is the 3x3 block centred on the site cell, minus its water cells.
// A facility is painted as a centre only (PAINT_NEIGHBORS in board.mjs, and the painter's own
// capital/base/city branch), so its footprint is its cell.
//
// That shape is NOT re-implemented here. `web/data/footprints.json` is the MEASURED painted set,
// taken from the running original's tile map (`t026-map-dump.py` + `t026-measured-footprints.py`,
// era 1942 side BLUE, 2026-11-14) and baked by `tools/bake_footprints.mjs` (PM ruling 2026-11-14
// 20:20 ET, option (a): measure the painter, do not derive it). The painter writes its block at
// site record + (2,0) — measured on all 64 city-kind sites — so the baked cells are translated back
// into the site-record frame, which is the frame the board and this module use. The exported loop
// below survives only as the fallback for a site the measurement does not cover.
//
// D-003's wider stand-in (land and air anywhere on ground within 8 cells of a held site, hulls
// in coastal water within 4 cells of land) is superseded. There is no reach any more: the legal
// land cells are the cells of the sites this side owns, and the legal sea cells are the cells of
// the docks this side owns. A dock's kind is DERIVED from the extract, not recovered as a rule:
// board.matchSites builds one `kind: "dock"` site on every terrain cell whose id is 1, which is
// the 150 docks the world's own counts report for all 150 paint cells (docs/re/PLACEMENT.md).
//
// Two layers, one board (T-021). The original keeps air units in a separate air layer based *at*
// cities, bases and carriers (manual printed p.22: "Air units may only be transferred to cities,
// bases, and aircraft carriers"; p.24: air units are visible in a base, city or carrier; p.9-10
// shows an enemy air unit in Bombay while red infantry defends it). So a plane and a ground or
// sea piece may share a site cell, and neither blocks the other's placement. Ground and sea do NOT
// stack: that rule is unchanged, and nothing here widens it.
//
// D-025 (deliberate deviation from p.28's docks-only wording): a hull may also be bought by
// clicking a friendly city, capital or base that touches water. The ship lands on an ADJACENT
// free water cell, docks first, then the nearest free water cell in the ADJACENT order below
// (a REMAKE CHOICE, not an original rule). The coastal site is a click
// target, using the same snap and box as T-017, and the mask paints it.
//
// Readiness is the second half of the rule and it is per site (readiness.mjs). The mask marks a
// legal cell that is ready with 1 and a legal cell whose city is unready with 2, so the page can
// paint them differently; canPlace refuses the unready one with the round it comes back.
//
// This module is the only authority for the rule. The purchase is refused here, and the page
// paints the mask this module returns, so the highlight a player clicks is exactly what the
// server accepts.

import { readFileSync } from "node:fs";
import { placementRules, readinessRules } from "./rules.mjs";
import { isSiteReady, readyRoundOf, unreadyRefusal } from "./readiness.mjs";

const SEA_KINDS = new Set(["cruiser", "carrier", "submarine"]);
const DOCK_KINDS = new Set(["dock", "docks"]);
// "City or base" in the manual. world.json calls the non-capital settlements `city`; the era
// table and combat also carry `base`, and a facility is a built site that owns ground, so it
// produces like a base. A capital is a city for placement: it is highlighted and it produces.
const LAND_SITE_KINDS = new Set(["city", "capital", "base", "facility"]);
// Aircraft base in a city, base or carrier and never on a dock (manual p.22).
const AIR_SITE_KINDS = LAND_SITE_KINDS;
// D-025: a hull's berth is a dock OR a coastal settlement. Both are click targets; only the
// coastal ones resolve to a water cell beside them.
const SEA_SITE_KINDS = new Set([...DOCK_KINDS, ...LAND_SITE_KINDS]);
// A carrier is a PIECE, not a site, so its berth is the cell the carrier stands on.
const CARRIER_KIND = "carrier";

// Sea terrain ids, the same three board.TERRAIN names the mover treats as water: 0 ocean,
// 1 docks, 2 shallows.
const WATER_MAX_ID = 2;
const DOCK_TERRAIN_ID = 1;
// Adjacent cells, clockwise from north: N, NE, E, SE, S, SW, W, NW. The tie-break between two
// equally near berths is this order, so the same click always lands on the same water cell. This
// order is a REMAKE CHOICE, not an original rule: no manual page or disassembly read gives the
// original's preference, it only makes the same click deterministic.
const ADJACENT = Object.freeze([
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]);

export function domainOf(kind) {
  return SEA_KINDS.has(String(kind ?? "")) ? "sea" : "land";
}

// Which occupancy layer a piece or a kind lives on: "air" or "ground". Ground and sea share one
// layer, which is why a hull and an infantry still cannot stand on one cell.
export function layerOf(value) {
  const kind = value && typeof value === "object" ? String(value.kind ?? "") : String(value ?? "");
  const domain = value && typeof value === "object" ? String(value.domain ?? "") : "";
  return kind === "aircraft" || domain === "air" ? "air" : "ground";
}

// A cell is taken when a piece of the SAME layer stands on it. A plane does not occupy the ground
// of the city it is based in, and a ground unit does not occupy the plane's air slot.
function occupiedSet(match, layer) {
  const set = new Set();
  for (const piece of Array.isArray(match && match.pieces) ? match.pieces : []) {
    if (!piece) continue;
    if (layerOf(piece) !== layer) continue;
    set.add(Number(piece.x) + "," + Number(piece.y));
  }
  return set;
}

// D-026: the site kinds whose painter lays down a 3x3 block, read from the config
// (placement.footprint.kinds). A facility is painted as a centre only, so it is not listed there; a
// dock is a water cell and ships keep D-025. The fallback only covers a config that lost the block.
function footprintKinds() {
  return new Set(placementRules().footprintKinds);
}

// Land terrain ids: everything the painter keeps when it paints a ring cell. Ids 0 ocean,
// 1 docks and 2 shallows are water, and FUN_20b1_1b42's land test (`2 < get_terrain_type`) turns
// those into a dock paint instead of a city one.
const WATER_MAX_ID_LOCAL = 2;

// D-026: the measured per-site footprint list, baked from the ORIGINAL's runtime tile map
// (web/data/footprints.json, baked by tools/bake_footprints.mjs from a live dump — PM ruling
// 2026-11-14 20:20 ET, option (a): measure the painter, do not re-implement it). Cells are in the
// site-record frame, which is the frame the board and this file both use: the painter writes at
// record + (2,0), measured on every city-kind site in the dump.
let measuredFootprints = null;
function measuredFootprintCells(site) {
  if (measuredFootprints === null) {
    try {
      const file = JSON.parse(readFileSync(new URL("../data/footprints.json", import.meta.url), "utf8"));
      measuredFootprints = file && file.sites && typeof file.sites === "object" ? file.sites : {};
    } catch {
      measuredFootprints = {};
    }
  }
  const cells = measuredFootprints[String(site && site.id)];
  if (!Array.isArray(cells) || !cells.length) return null;
  const [sx, sy] = [Number(site.x), Number(site.y)];
  const out = cells.map(([x, y]) => [Number(x), Number(y)]);
  // Identity guard: a site id is only reused with the same coordinates. A synthetic match (or any
  // site that reuses an id) must not be handed another city's measured block, so the list is used
  // only when the site's OWN cell is in it — true for all 64 measured sites.
  if (!out.some(([x, y]) => x === sx && y === sy)) return null;
  return out;
}

function siteKindsFor(domain) {
  if (domain === "air") return AIR_SITE_KINDS;
  return domain === "sea" ? SEA_SITE_KINDS : LAND_SITE_KINDS;
}

// The footprint cells of one site, as [x, y] pairs. For a shipped site this is the measured list.
// A site the measured dump does not know (a synthetic test board, a site added after the bake) gets
// the painter's SHAPE from the exported loop — its 3x3 clipped by the land test — clearly the
// fallback path and never the source of record. A facility has no painted city terrain and keeps
// its own cell. Cell order is row-major so a list and a live mask agree byte for byte.
export function footprintCells(site, board) {
  const x = Number(site && site.x);
  const y = Number(site && site.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return [];
  const w = Number(board && board.width) || 0;
  const h = Number(board && board.height) || 0;
  if (!footprintKinds().has(String(site.kind))) return [[x, y]];
  const measured = measuredFootprintCells(site);
  if (measured) return measured;
  if (w <= 0 || h <= 0) return [[x, y]];
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    const cy = y + dy;
    if (cy < 0 || cy >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ((x + dx) % w + w) % w;
      const id = terrainIdAt(board, cx, cy);
      // No board cell under it (a synthetic board's hole): the painter would not paint it either.
      if (id !== null && id <= WATER_MAX_ID_LOCAL) continue;
      out.push([cx, cy]);
    }
  }
  return out.length ? out : [[x, y]];
}

// Every footprint cell of every site of one domain a side holds, with the site that owns it. A
// cell two sites both claim (two cities one cell apart) resolves to the first site in the match
// list, so the mask and the refusal name one site and never disagree.
export function placementCells(match, side, kind, board) {
  const kinds = siteKindsFor(domainOf(kind));
  const owned = Array.isArray(match && match.sites) ? match.sites : [];
  const seen = new Map();
  for (const site of owned) {
    if (!site || site.owner !== side) continue;
    if (!kinds.has(String(site.kind))) continue;
    // Ships keep D-025: the berth is a dock's own cell or a coastal settlement's own cell, and the
    // hull lands on the water beside it. A footprint would put a hull on land.
    const cells = domainOf(kind) === "sea" ? [[Number(site.x), Number(site.y)]] : footprintCells(site, board);
    for (const [cx, cy] of cells) {
      const key = cx + "," + cy;
      if (!seen.has(key)) seen.set(key, { x: cx, y: cy, site });
    }
  }
  return [...seen.values()];
}

function terrainIdAt(board, x, y) {
  const w = Number(board && board.width) || 0;
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  if (!cells || w <= 0) return null;
  const id = cells[Number(y) * w + Number(x)];
  return Number.isFinite(Number(id)) ? Number(id) : null;
}

function isWaterCell(board, x, y) {
  const id = terrainIdAt(board, x, y);
  return id !== null && id <= WATER_MAX_ID;
}

// A site touches water when any of its eight neighbours is ocean, docks or shallows. The site's
// own cell is the settlement's terrain (city/base/capital), never water.
function touchesWater(board, site) {
  if (!site) return false;
  const w = Number(board && board.width) || 0;
  const h = Number(board && board.height) || 0;
  const x = Number(site.x);
  const y = Number(site.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || w <= 0) return false;
  for (const [dx, dy] of ADJACENT) {
    const nx = ((x + dx) % w + w) % w;
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    if (isWaterCell(board, nx, ny)) return true;
  }
  return false;
}

// The free water cell a hull bought at `site` goes to: an adjacent dock first (terrain id 1),
// then the nearest free water cell, one cell away in the ADJACENT order. `taken` is the layer
// that may not be landed on (ground for a site cell click, since a hull is a ground-layer piece
// for occupancy). Returns null when every adjacent water cell is taken.
export function shipBerth(site, board, taken) {
  if (!site) return null;
  const w = Number(board && board.width) || 0;
  const h = Number(board && board.height) || 0;
  const x = Number(site.x);
  const y = Number(site.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || w <= 0) return null;
  let fallback = null;
  for (const [dx, dy] of ADJACENT) {
    const nx = ((x + dx) % w + w) % w;
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    if (!isWaterCell(board, nx, ny)) continue;
    if (taken.has(nx + "," + ny)) continue;
    const cell = { x: nx, y: ny };
    if (terrainIdAt(board, nx, ny) === DOCK_TERRAIN_ID) return { ...cell, dock: true };
    if (!fallback) fallback = { ...cell, dock: false };
  }
  return fallback;
}

// Any site on a cell, whatever its owner or kind. Used to name the place in a refusal.
function siteAt(match, x, y) {
  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site) continue;
    if (Number(site.x) !== Number(x) || Number(site.y) !== Number(y)) continue;
    return site;
  }
  return null;
}

// The site whose footprint holds a placement cell, or null. A footprint cell is claimed by the
// site that painted it; the site's own cell is the first candidate, so a direct click on a city
// never has to scan.
export function placementSite(match, side, kind, x, y, board = null) {
  const kinds = siteKindsFor(domainOf(kind));
  let hit = null;
  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site || site.owner !== side) continue;
    if (!kinds.has(String(site.kind))) continue;
    if (Number(site.x) === Number(x) && Number(site.y) === Number(y)) {
      hit = site;
      break;
    }
  }
  if (hit || !board) return hit;
  for (const cell of placementCells(match, side, kind, board)) {
    if (Number(cell.x) === Number(x) && Number(cell.y) === Number(y)) return cell.site;
  }
  return null;
}

// What a message calls a site (PB-044). The site's own name when it has one; otherwise its kind
// and the nearest named city, so "a base near Kharkov" beats "78,37".
export function siteLabel(match, site) {
  if (!site) return "";
  const name = String(site.name ?? "").trim();
  if (name) return name;
  const kind = String(site.kind ?? "site");
  const w = 320;
  let best = "";
  let bestGap = Infinity;
  for (const other of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!other || other === site) continue;
    const label = String(other.name ?? "").trim();
    if (!label) continue;
    const dx = Math.abs(Number(other.x) - Number(site.x));
    const gap = Math.max(Math.min(dx, w - dx), Math.abs(Number(other.y) - Number(site.y)));
    if (gap < bestGap) {
      bestGap = gap;
      best = label;
    }
  }
  return best ? kind + " near " + best : kind;
}

// How many friendly sites of a domain a side holds. The buy menu turns a hull row off with the
// manual's own reason when this is zero (p.27: "if all your ports are conquered you can't build
// ships"), and under D-025 a coastal city or base counts as a berth too. Callers that pass no
// board get the docks-only answer, which is the conservative one.
export function friendlySites(match, side, domain, board = null) {
  const kinds = siteKindsFor(domain);
  let count = 0;
  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site || site.owner !== side) continue;
    if (!kinds.has(String(site.kind))) continue;
    if (domain === "sea" && !DOCK_KINDS.has(String(site.kind))) {
      if (!board || !touchesWater(board, site)) continue;
    }
    count += 1;
  }
  return count;
}

// The legal placement cells for one purchase, as a bit mask over the board: 0 illegal,
// 1 legal and ready, 2 legal but its city is unready.
export function placementMask(match, side, kind, board) {
  const w = Number(board && board.width) || 0;
  const h = Number(board && board.height) || 0;
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  if (!cells || w <= 0 || h <= 0 || cells.length !== w * h) {
    return { error: "This host has no board, so there is nowhere to place a unit." };
  }
  const domain = domainOf(kind);
  const layer = layerOf(kind);
  const { radius } = readinessRules();
  // The click forgiveness a page may use, sent with the mask so the page never carries its own
  // copy of the numbers (T-017). They widen the TARGET, never the rule: the mask below is still
  // one byte per friendly site cell, ready or unready.
  const forgiveness = placementRules();
  const rule = layer === "air"
    ? "Aircraft go only on a friendly city, base or carrier."
    : domain === "sea"
      ? "Ships go only at a dock, or on the water beside a coastal city or base."
      : "Land units go only on a friendly city or base.";
  const kinds = siteKindsFor(domain);
  const taken = occupiedSet(match, layer);
  const mask = new Uint8Array(w * h);
  const round = Number(match && match.round) || 0;
  let count = 0;
  let ready = 0;
  let unready = 0;

  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site || site.owner !== side) continue;
    if (!kinds.has(String(site.kind))) continue;
    const x = Number(site.x);
    const y = Number(site.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    // A D-025 berth: a dock is its own cell; a coastal city, capital or base needs an adjacent
    // free water cell for the hull to land on.
    if (domain === "sea" && !DOCK_KINDS.has(String(site.kind))) {
      if (!touchesWater(board, site)) continue;
      if (!shipBerth(site, board, taken)) continue;
    }
    const ok = isSiteReady(site, round);
    // Land and air (D-026): every cell of the site's footprint is a legal click target, and the
    // unit lands on the cell that was clicked. A ship keeps its one-cell berth (D-025).
    const cells = domain === "sea" ? [[x, y]] : footprintCells(site, board);
    for (const [cx, cy] of cells) {
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
      // Only a piece on the SAME layer makes the cell unavailable.
      if (taken.has(cx + "," + cy)) continue;
      const id = cy * w + cx;
      if (mask[id] === 2 && ok) {
        // Two sites claim the cell and one of them is ready: the player's click is legal.
        mask[id] = 1;
        unready -= 1;
        ready += 1;
        continue;
      }
      if (mask[id]) continue; // already counted through another site
      mask[id] = ok ? 1 : 2;
      count += 1;
      if (ok) ready += 1;
      else unready += 1;
    }
  }

  // Aircraft also base on a carrier, and a carrier is a piece: its cell is an air cell with no
  // readiness of its own (a carrier never goes unready).
  if (layer === "air") {
    for (const piece of Array.isArray(match && match.pieces) ? match.pieces : []) {
      if (!piece || piece.side !== side) continue;
      if (String(piece.kind ?? "") !== CARRIER_KIND) continue;
      const x = Number(piece.x);
      const y = Number(piece.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const id = y * w + x;
      if (mask[id]) continue; // a carrier visiting a city cell keeps the city's readiness byte
      mask[id] = 1;
      count += 1;
      ready += 1;
    }
  }

  if (!count) {
    const none = domain === "sea"
      ? "You hold no coastal city or dock, so a hull cannot be bought."
      : layer === "air"
        ? "You hold no city, base or carrier to base an aircraft in."
        : "You hold no city or base to place a land unit in.";
    return { error: none, domain, layer, rule };
  }
  return {
    ok: true, width: w, height: h, mask, count, ready, unready, domain, layer, rule, radius,
    snap: { px: forgiveness.snapPx, cells: forgiveness.snapCells },
    box: { px: forgiveness.boxPx },
  };
}

// The sentence a refused cell gets (PB-044): it names the unit first, never a coordinate, and
// names the site when the cell carries one.
export function placementRefusal(kind, domain, rule = "", detail = "") {
  const head = "Can't place " + String(kind || "that unit") + " here: ";
  // The rule sentence rides along: the named site says WHICH place, the rule says WHY it is
  // refused, and the player needs both.
  if (detail) return head + detail + (rule ? " " + rule : "");
  const what = domain === "sea"
    ? "a friendly coastal city, base or dock you hold"
    : domain === "air"
      ? "a friendly city, base or carrier you hold"
      : "a friendly city or base you hold";
  return head + "that is not " + what + "." + (rule ? " " + rule : "");
}

export function canPlace(match, side, kind, x, y, board) {
  const result = placementMask(match, side, kind, board);
  if (result.error) return result;
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return { error: "A purchase needs whole cells." };
  if (cx < 0 || cx >= result.width || cy < 0 || cy >= result.height) return { error: "That cell is off the board." };
  const domain = result.domain;
  const layer = result.layer;
  const value = result.mask[cy * result.width + cx];
  const occupied = siteAt(match, cx, cy);
  const where = occupied ? siteLabel(match, occupied) : "";
  // D-026: a footprint cell belongs to the site that painted it, so a refusal on one names that
  // site even though no site record stands on the cell.
  // Ships keep their own refusal vocabulary (inland, water taken), so the footprint claim below
  // is only consulted for land and air.
  const claim = value || domain === "sea" ? null : placementSite(match, side, kind, cx, cy, board);
  if (!value) {
    if (claim) {
      const label = siteLabel(match, claim);
      // A cell a piece of the same layer already stands on is held, not merely unready: the
      // stack rule is the reason, and a player who clicked their own unit should read that.
      if (occupiedSet(match, layer).has(cx + "," + cy)) {
        return { error: placementRefusal(kind, domain, result.rule, label + " already holds a unit."), domain, site: claim };
      }
      if (!isSiteReady(claim, Number(match && match.round) || 0)) {
        return { error: unreadyRefusal(claim, label), domain, site: claim, readyRound: readyRoundOf(claim) };
      }
      return { error: placementRefusal(kind, domain, result.rule, label + " cannot base " + nounFor(kind) + "."), domain, site: claim };
    }
    if (occupied) {
      if (occupied.owner !== side) {
        return { error: placementRefusal(kind, domain, result.rule, where + " is not yours."), domain, site: occupied };
      }
      if (!siteKindsFor(domain).has(String(occupied.kind))) {
        return { error: placementRefusal(kind, domain, result.rule, where + " cannot base " + nounFor(kind) + "."), domain, site: occupied };
      }
      if (domain === "sea" && !DOCK_KINDS.has(String(occupied.kind))) {
        const taken = occupiedSet(match, layer);
        if (!touchesWater(board, occupied)) {
          return { error: placementRefusal(kind, domain, result.rule, where + " is inland."), domain, site: occupied };
        }
        if (!shipBerth(occupied, board, taken)) {
          return { error: placementRefusal(kind, domain, result.rule, "the water beside " + where + " is taken."), domain, site: occupied };
        }
      }
      return { error: placementRefusal(kind, domain, result.rule, where + " already holds a unit."), domain, site: occupied };
    }
    if (layer === "air") {
      return { error: placementRefusal(kind, domain, result.rule, "an aircraft bases only in a friendly city, base or carrier."), domain };
    }
    return { error: placementRefusal(kind, domain, result.rule), domain };
  }
  const site = placementSite(match, side, kind, cx, cy, board);
  const label = site ? siteLabel(match, site) : "";
  if (value === 2) {
    return { error: unreadyRefusal(site, label), domain, site, readyRound: readyRoundOf(site) };
  }
  // The cell the unit actually lands on (D-026): the footprint cell the player clicked. For a
  // D-025 hull bought at a coastal city or base it is the water beside it instead (docks first).
  let place = { x: cx, y: cy };
  let berth = null;
  if (domain === "sea" && site && !DOCK_KINDS.has(String(site.kind))) {
    berth = shipBerth(site, board, occupiedSet(match, layer));
    if (!berth) {
      return { error: placementRefusal(kind, domain, result.rule, "the water beside " + label + " is taken."), domain, site };
    }
    place = { x: berth.x, y: berth.y };
  }
  return { ...result, site, place, berth, label, readyRound: 0 };
}

// "an infantry", "a cruiser" - only used inside a sentence, never as a display name.
function nounFor(kind) {
  const text = String(kind ?? "unit");
  return (/^[aeiou]/i.test(text) ? "an " : "a ") + text;
}

// The mask as base64 for the wire: 43,520 cells is 5 KB rather than a list of coordinates, and
// the page decodes it back into the same bytes.
export function maskBase64(mask) {
  return Buffer.from(mask.buffer, mask.byteOffset, mask.length).toString("base64");
}
