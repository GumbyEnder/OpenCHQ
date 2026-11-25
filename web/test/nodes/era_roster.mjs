// Node era_roster: what each era sells (Manual p.16), read from the same shop the server sends.
//
// 1918: infantry, cruiser, submarine. 1942 adds tanks, carriers, aircraft and the rest of the
// surface fleet. 1986 and 2023 add the late kit. The ???? era (9999) is not named by the manual,
// so it uses the 1986 set and config labels that UNVERIFIED.
//
// What breaks if this node is removed: a 1918 match could sell a carrier, or a 1986 match could
// lose the satellites, aid and intel that make the late game.

import { shopFor } from "../../server/shop.mjs";
import { rosterFor, sourceOf } from "../../server/rules.mjs";
import { withNukesOff } from "./_nuke_default.mjs";

export const name = "era_roster";

const EARLY = ["infantry", "cruiser", "submarine"];
const MIDDLE = ["infantry", "tank", "submarine", "cruiser", "carrier", "aircraft"];
const LATE = [...MIDDLE, "reconSat", "killerSat", "nuke", "foreignAid", "intelScan"];

function setOf(list) {
  return [...new Set(list)].sort();
}

export async function run(ctx) {
  const { fail } = ctx;
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(`${label}: ${a} !== ${b}`);
  };
  const ok = (cond, message) => {
    if (!cond) fail(message);
  };

  // The roster is the config's, and the shop is the roster in order.
  eq(setOf(rosterFor("1918")), setOf(EARLY), "the 1918 roster");
  eq(setOf(rosterFor("1942")), setOf(MIDDLE), "the 1942 roster");
  eq(setOf(rosterFor("1986")), setOf(LATE), "the 1986 roster");
  eq(setOf(rosterFor("2023")), setOf(LATE), "2023 sells the 1986 set");
  eq(setOf(rosterFor("9999")), setOf(LATE), "the ???? era uses the 1986 set (UNVERIFIED)");

  eq(shopFor("1918").map((row) => row.kind), EARLY, "the 1918 buy list");
  eq(shopFor("1942").map((row) => row.kind), MIDDLE, "the 1942 buy list");
  eq(shopFor("1986").map((row) => row.kind), LATE, "the 1986 buy list");
  eq(shopFor("2023").map((row) => row.kind), LATE, "the 2023 buy list");

  // PB-233 (f): the nuke is ARMED by default now. The shop's refusal path keeps its own pin: a
  // forced-off config must put the refusal back on the row, and killerSat stays the row that is
  // refused by design (its effect is not recovered).
  const late = Object.fromEntries(shopFor("1986").map((row) => [row.kind, row]));
  ok(late.nuke && !late.nuke.refused, "the 1986 shop still refuses a nuke under the shipped armed config");
  {
    const restoreOff = withNukesOff();
    try {
      const off = Object.fromEntries(shopFor("1986").map((row) => [row.kind, row]));
      ok(off.nuke && off.nuke.refused, "an enabled:false config does not put the refusal back on the nuke row");
      ok(String(off.nuke.refused).length > 0, "the refused nuke row states no reason");
      ok(Object.fromEntries(shopFor("1986").map((row) => [row.kind, row])).killerSat.refused,
        "killerSat stopped being refused under the forced-off config");
    } finally {
      restoreOff();
    }
    ok(!Object.fromEntries(shopFor("1986").map((row) => [row.kind, row])).nuke.refused,
      "the armed config did not come back after the forced-off swap");
  }
  for (const kind of ["foreignAid", "intelScan"]) {
    ok(late[kind] && !late[kind].refused, kind + " is not buyable in 1986: " + JSON.stringify(late[kind]));
    ok(late[kind].domain === "tool", kind + " is not routed as a tool");
  }
  // PB-224 (PM 8905 §2): the recon satellite is a UNIT, not a tool. Its row is the shop's "sat"
  // domain, which buys the piece at a picked point; it is not a one-shot reveal on the tool door.
  ok(late.reconSat && !late.reconSat.refused, "reconSat is not buyable in 1986: " + JSON.stringify(late.reconSat));
  ok(late.reconSat.domain === "sat", "reconSat is not routed as a satellite unit: " + JSON.stringify(late.reconSat));
  ok(late.reconSat.tool === undefined, "reconSat still carries a tool door: " + JSON.stringify(late.reconSat));
  ok(late.killerSat && late.killerSat.refused, "killerSat must say its effect is not recovered");

  // 1918 has no late kit and no tanks/aircraft/carriers; 1942 has them but no satellites.
  const early = new Set(shopFor("1918").map((row) => row.kind));
  for (const kind of ["tank", "aircraft", "carrier", "nuke", "reconSat", "intelScan"]) {
    ok(!early.has(kind), "1918 sells " + kind);
  }
  const middle = new Set(shopFor("1942").map((row) => row.kind));
  for (const kind of ["reconSat", "killerSat", "nuke", "foreignAid", "intelScan"]) {
    ok(!middle.has(kind), "1942 sells the late tool " + kind);
  }

  // The ???? label lives in config, not in a comment here.
  ok(/UNVERIFIED/.test(String(sourceOf("rosters.9999"))), "the ???? roster is not labelled UNVERIFIED");
  ok(/p\.16/.test(String(sourceOf("rosters.1918"))), "the 1918 roster has no p.16 source");
}
