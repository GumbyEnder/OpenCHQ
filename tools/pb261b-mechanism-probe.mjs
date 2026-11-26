// PB-261b mechanism probe: why the early seed changes a FILE era (1942) at all.
//
// COMMITTED INSTRUMENT, NOT PRODUCT HARNESS (frodo 9482 §3): this file is committed so the reading is
// reproducible, but nothing in the shipped server or the bot-vs-bot path imports it and `npm test`
// does not run it. Grade it as an artifact, never as part of the bot-vs-bot harness.
//
// Runs one round of 3v2 planning both ways: (a) lazy seed (pre-fix harness order: snapshot + plan on
// an unseeded live board) and (b) seeded at open (post-fix order, lobby.mjs `opened`). Prints the
// planned rows and the board the planner saw.
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { seedOwners } from "../web/server/economy.mjs";
import { ordersFor } from "../web/server/bot.mjs";

const board = boardPayload();
const sites = matchSites("1942", board);
const clone = (v) => structuredClone(v);

function round1(seedAtOpen) {
  const match = openMatch("1942", sites, { seed: 2023, opponentLevel: 3 });
  match.seats = { blue: { username: "Bot A", kind: "bot" }, red: { username: "Bot B", kind: "bot" } };
  match.clock = "running";
  if (seedAtOpen) seedOwners(match);
  const owned = (m) => m.sites.filter((s) => s && (s.owner === "blue" || s.owner === "red")).length;
  const seen = owned(match);
  const out = { ownedAtPlan: seen, blue: [], red: [] };
  for (const side of ["blue", "red"]) {
    const plan = clone(match);
    plan.opponentLevel = 3;
    const rows = ordersFor(plan, side) || [];
    out[side] = rows.map((r) => ({ type: r.type, kind: r.kind, at: r.at, to: r.to }));
    out[side + "OwnedOnClone"] = owned(plan);
  }
  return out;
}

for (const seeded of [false, true]) {
  const r = round1(seeded);
  console.log("=== seedAtOpen=" + seeded + ": owned sites the planner saw " + r.ownedAtPlan +
    " (blue clone " + r.blueOwnedOnClone + ", red clone " + r.redOwnedOnClone + ")");
  for (const side of ["blue", "red"]) {
    console.log("  " + side + " " + r[side].length + " row(s): " +
      r[side].map((x) => x.type + (x.kind ? ":" + x.kind : "") + "@" + JSON.stringify(x.at || x.to)).join(" "));
  }
}
