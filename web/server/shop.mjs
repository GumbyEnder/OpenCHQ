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
  reconSat: "satellite",
  killerSat: null,
  nuke: "nuke",
  foreignAid: "aid",
  intelScan: "intel",
});

export function shopFor(era) {
  const key = String(era ?? "1986");
  const shop = [];
  for (const kind of rosterFor(key)) {
    const price = priceOf(kind);
    if (!Number.isFinite(price)) continue;
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
      row.refused = "A satellite killer has no effect recovered: UNVERIFIED.";
    }
    shop.push(row);
  }
  return shop;
}
