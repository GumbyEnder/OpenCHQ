// Where a bought unit may be placed.
//
// The archive's rule was "land and air in any friendly city or base, ships only on docks"
// (Manual.pdf, Placing New Purchases). The owner's rule for this build is wider: land and air go
// anywhere on land inside the seat's own zone, ships go into coastal water within a few cells of a
// coast. Neither reach was ever printed by the archive, so both live in config/game.json as
// labelled stand-ins and are read through rules.placementRules().
//
// This module is the only authority for the rule. The purchase is refused here, and the page paints
// the mask this module returns, so the highlight a player clicks is exactly what the server accepts.
// Nothing here knows about money, readiness or the piece list beyond "a cell is occupied".

import { placementRules } from "./rules.mjs";

const SEA_KINDS = new Set(["cruiser", "carrier", "submarine"]);
// Terrain ids from the board payload's own table: 0 ocean, 2 shallows, 3 lake.
const OCEAN = 0;
const SHALLOWS = 2;
const LAKE = 3;

export function domainOf(kind) {
  return SEA_KINDS.has(String(kind ?? "")) ? "sea" : "land";
}

function isSeaWater(terrainId) {
  const id = Number(terrainId);
  return id === OCEAN || id === SHALLOWS;
}

function wrapX(x, w) {
  return ((x % w) + w) % w;
}

// A cell is occupied when a piece stands on it, whatever its side: two pieces never share a cell.
function occupiedSet(match) {
  const set = new Set();
  for (const piece of Array.isArray(match && match.pieces) ? match.pieces : []) {
    if (!piece) continue;
    set.add(Number(piece.x) + "," + Number(piece.y));
  }
  return set;
}

// The legal placement cells for one purchase, as a bit mask over the board.
export function placementMask(match, side, kind, board) {
  const w = Number(board && board.width) || 0;
  const h = Number(board && board.height) || 0;
  const cells = board && Array.isArray(board.cells) ? board.cells : null;
  if (!cells || w <= 0 || h <= 0 || cells.length !== w * h) {
    return { error: "This host has no board, so there is nowhere to place a unit." };
  }
  const { zone, coast } = placementRules();
  const taken = occupiedSet(match);
  const mask = new Uint8Array(w * h);
  let count = 0;

  if (domainOf(kind) === "sea") {
    // Coastal water is a measured distance, not a guess: one BFS from every land cell, and a water
    // cell is legal while it is no further than `coast` steps from that shore.
    const dist = new Int16Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    for (let id = 0; id < w * h; id++) {
      if (isSeaWater(cells[id]) || Number(cells[id]) === LAKE) continue;
      dist[id] = 0;
      queue[tail++] = id;
    }
    while (head < tail) {
      const id = queue[head++];
      const d = dist[id];
      if (d >= coast) continue;
      const x = id % w;
      const y = (id - x) / w;
      const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dy] of steps) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        const nid = ny * w + wrapX(x + dx, w);
        if (dist[nid] !== -1) continue;
        dist[nid] = d + 1;
        queue[tail++] = nid;
      }
    }
    for (let id = 0; id < w * h; id++) {
      const d = dist[id];
      if (d <= 0 || d > coast) continue;
      if (!isSeaWater(cells[id])) continue; // a lake is not a harbour
      const x = id % w;
      const y = (id - x) / w;
      if (taken.has(x + "," + y)) continue;
      mask[id] = 1;
      count += 1;
    }
    if (!count) return { error: "No coastal water is open for a hull." };
    return { ok: true, width: w, height: h, mask, count, domain: "sea", zone, coast };
  }

  // Land and air: open ground inside the seat's zone, which is measured from the sites it holds.
  const owned = (Array.isArray(match && match.sites) ? match.sites : []).filter((site) => site && site.owner === side);
  if (!owned.length) return { error: "You hold no territory to place a unit in." };
  const reach = new Uint8Array(w * h);
  for (const site of owned) {
    const sx = Number(site.x);
    const sy = Number(site.y);
    if (!Number.isInteger(sx) || !Number.isInteger(sy)) continue;
    for (let dy = -zone; dy <= zone; dy++) {
      const y = sy + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -zone; dx <= zone; dx++) {
        reach[y * w + wrapX(sx + dx, w)] = 1;
      }
    }
  }
  for (let id = 0; id < w * h; id++) {
    if (!reach[id]) continue;
    const t = Number(cells[id]);
    if (isSeaWater(t) || t === LAKE) continue;
    const x = id % w;
    const y = (id - x) / w;
    if (taken.has(x + "," + y)) continue;
    mask[id] = 1;
    count += 1;
  }
  if (!count) return { error: "No open ground inside your zone." };
  return { ok: true, width: w, height: h, mask, count, domain: "land", zone, coast };
}

// The sentence a refused cell gets. It names the rule and the stand-in the rule was set to, so a
// player who wants a different reach knows it is a number and not a wall.
export function placementRefusal(kind, domain, zone, coast) {
  return domain === "sea"
    ? "A " + kind + " goes in coastal water, within " + coast + " cells of land."
    : "A " + kind + " goes on land inside your own zone, within " + zone + " cells of a site you hold.";
}

export function canPlace(match, side, kind, x, y, board) {
  const result = placementMask(match, side, kind, board);
  if (result.error) return result;
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return { error: "A purchase needs whole cells." };
  if (cx < 0 || cx >= result.width || cy < 0 || cy >= result.height) return { error: "That cell is off the board." };
  if (!result.mask[cy * result.width + cx]) {
    return { error: placementRefusal(kind, result.domain, result.zone, result.coast) };
  }
  return result;
}

// The mask as base64 for the wire: 43,520 cells is 5 KB rather than a list of coordinates, and the
// page decodes it back into the same bytes.
export function maskBase64(mask) {
  return Buffer.from(mask.buffer, mask.byteOffset, mask.length).toString("base64");
}
