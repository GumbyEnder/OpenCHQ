// Where a bought unit may be placed. D-019: the original's rule, not a radius.
//
// Manual p.27, "General Placement Rules": "every city and base you own is highlighted. Land
// units and aircraft may be placed in any friendly city or base. Ships may be placed only on
// docks, so if all your ports are conquered you can't build ships."
//
// D-003's wider stand-in (land and air anywhere on ground within 8 cells of a held site, hulls
// in coastal water within 4 cells of land) is superseded. There is no reach any more: the legal
// land cells are the cells of the sites this side owns, and the legal sea cells are the cells of
// the docks this side owns. A dock's kind is DERIVED from the extract, not recovered as a rule:
// board.matchSites builds one `kind: "dock"` site on every terrain cell whose id is 1, which is
// the 150 docks the world's own counts report for all 150 paint cells (docs/re/PLACEMENT.md).
//
// Readiness is the second half of the rule and it is per site (readiness.mjs). The mask marks a
// legal cell that is ready with 1 and a legal cell whose city is unready with 2, so the page can
// paint them differently; canPlace refuses the unready one with the round it comes back.
//
// This module is the only authority for the rule. The purchase is refused here, and the page
// paints the mask this module returns, so the highlight a player clicks is exactly what the
// server accepts.

import { readinessRules } from "./rules.mjs";
import { isSiteReady, readyRoundOf, unreadyRefusal } from "./readiness.mjs";

const SEA_KINDS = new Set(["cruiser", "carrier", "submarine"]);
const DOCK_KINDS = new Set(["dock", "docks"]);
// "City or base" in the manual. world.json calls the non-capital settlements `city`; the era
// table and combat also carry `base`, and a facility is a built site that owns ground, so it
// produces like a base. A capital is a city for placement: it is highlighted and it produces.
const LAND_SITE_KINDS = new Set(["city", "capital", "base", "facility"]);

export function domainOf(kind) {
  return SEA_KINDS.has(String(kind ?? "")) ? "sea" : "land";
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

function siteKindsFor(domain) {
  return domain === "sea" ? DOCK_KINDS : LAND_SITE_KINDS;
}

// The site a placement cell belongs to, or null. Sites do not share a cell, and the mask is
// built from this list, so a lookup is exact.
export function placementSite(match, side, kind, x, y) {
  const kinds = siteKindsFor(domainOf(kind));
  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site || site.owner !== side) continue;
    if (!kinds.has(String(site.kind))) continue;
    if (Number(site.x) !== Number(x) || Number(site.y) !== Number(y)) continue;
    return site;
  }
  return null;
}

// How many friendly sites of a domain a side holds. The buy menu turns a hull row off with the
// manual's own reason when this is zero (p.27: "if all your ports are conquered you can't build
// ships"), so the rule is visible before the player clicks a cell and gets refused.
export function friendlySites(match, side, domain) {
  const kinds = siteKindsFor(domain);
  let count = 0;
  for (const site of Array.isArray(match && match.sites) ? match.sites : []) {
    if (!site || site.owner !== side) continue;
    if (!kinds.has(String(site.kind))) continue;
    count++;
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
  const { radius } = readinessRules();
  const rule = domain === "sea"
    ? "Ships go only on a friendly dock."
    : "Land units and aircraft go only on a friendly city or base.";
  const kinds = siteKindsFor(domain);
  const taken = occupiedSet(match);
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
    if (taken.has(x + "," + y)) continue;
    const id = y * w + x;
    const ok = isSiteReady(site, round);
    mask[id] = ok ? 1 : 2;
    count += 1;
    if (ok) ready += 1;
    else unready += 1;
  }

  if (!count) {
    const none = domain === "sea"
      ? "You hold no dock, so a hull cannot be bought."
      : "You hold no city or base to place a land unit in.";
    return { error: none, domain, rule };
  }
  return { ok: true, width: w, height: h, mask, count, ready, unready, domain, rule, radius };
}

// The sentence a refused cell gets. It names the rule; when the cell is a friendly site that is
// merely tired, canPlace names the round instead (readiness.unreadyRefusal).
export function placementRefusal(kind, domain, rule) {
  const what = domain === "sea" ? "a friendly dock" : "a friendly city or base";
  return "That is not a valid place for " + kind + ". " + rule + " That cell is not " + what + " you hold.";
}

export function canPlace(match, side, kind, x, y, board) {
  const result = placementMask(match, side, kind, board);
  if (result.error) return result;
  const cx = Number(x);
  const cy = Number(y);
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) return { error: "A purchase needs whole cells." };
  if (cx < 0 || cx >= result.width || cy < 0 || cy >= result.height) return { error: "That cell is off the board." };
  const value = result.mask[cy * result.width + cx];
  if (!value) {
    return { error: placementRefusal(kind, result.domain, result.rule), domain: result.domain };
  }
  const site = placementSite(match, side, kind, cx, cy);
  if (value === 2) {
    return { error: unreadyRefusal(site), domain: result.domain, site, readyRound: readyRoundOf(site) };
  }
  return { ...result, site, readyRound: 0 };
}

// The mask as base64 for the wire: 43,520 cells is 5 KB rather than a list of coordinates, and
// the page decodes it back into the same bytes.
export function maskBase64(mask) {
  return Buffer.from(mask.buffer, mask.byteOffset, mask.length).toString("base64");
}
