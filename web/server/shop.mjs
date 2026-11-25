// The shop: what an era sells, at the recovered prices. Pure - no disk, no database, no match.
//
// The roster comes from config `rosters` (Manual p.16) and the price from config `prices`
// (Manual p.28 + DS:0x2E16), both in the manual's billions and converted to integer millions by
// priceOf(). A row is either a unit (placed on the board), a tool (run by late.mjs, which charges
// it), or a tool that is not wired yet and says so.

import { priceOf, rosterFor, rules } from "./rules.mjs";

export const DOMAIN_BY_KIND = Object.freeze({
  infantry: "land",
  tank: "land",
  aircraft: "land",
  cruiser: "sea",
  carrier: "sea",
  submarine: "sea",
});

const TOOL_OF = Object.freeze({
  killerSat: null,
  nuke: "nuke",
  foreignAid: "aid",
  intelScan: "intel",
});

// PB-224 (PM 8905 §2): reconSat is a UNIT, not a tool. Buying one creates an owned, persistent
// satellite at the point the player picks (manual p.29 "purchased like any other unit"); it is not a
// one-shot worldwide reveal any more. It is kept out of DOMAIN_BY_KIND on purpose: economy.buy's
// placement rules are ground rules (a friendly city or base), and a satellite has neither. The shop
// row is tagged domain "sat" and lobby.buyOp routes it to satellite.buySatellite().
const SAT_KINDS = new Set(["reconSat"]);

export function isSatelliteKind(kind) {
  return SAT_KINDS.has(String(kind ?? ""));
}

export function shopFor(era, options = {}) {
  const key = String(era ?? "1986");
  const shop = [];
  for (const kind of rosterFor(key)) {
    const price = priceOf(kind);
    if (!Number.isFinite(price)) continue;
    if (isSatelliteKind(kind)) {
      shop.push({ kind, price, domain: "sat" });
      continue;
    }
    if (Object.hasOwn(DOMAIN_BY_KIND, kind)) {
      shop.push({ kind, price, domain: DOMAIN_BY_KIND[kind] });
      continue;
    }
    if (!Object.hasOwn(TOOL_OF, kind)) continue;
    const row = { kind, price, domain: "tool", tool: TOOL_OF[kind] };
    if (kind === "nuke" && !(rules().nukes && rules().nukes.enabled === true)) {
      row.refused = "A nuke is refused.";
    }
    if (TOOL_OF[kind] === null) {
      // PB-240(c): the row refuses in a player's words. The provenance that the original's effect was
      // never recovered lives in config/game.json `sources.prices.killerSat`, not in a title a player
      // reads - a tag addressed to a developer is not a reason the player can act on.
      row.refused = "A satellite killer is not in this build.";
    }
    shop.push(row);
  }
  // A hull row is off before the click when the side holds no port: the manual says a side whose
  // ports are all conquered cannot build ships (p.27), so the row states that rather than letting
  // the player arm a unit that can never be placed. A row that already carries a refusal keeps it.
  if (options.seaRefusal) {
    for (const row of shop) {
      if (row.domain !== "sea" || row.refused) continue;
      row.refused = options.seaRefusal;
    }
  }
  return shop;
}
