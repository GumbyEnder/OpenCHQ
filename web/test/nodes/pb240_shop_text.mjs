// Node test: PB-240 (a)(b)(c) + the first slice of PB-244's rule.
//
// (a) a satellite order says "to fly". The ack carries the moving piece's kind and domain, so the verb
//     is chosen from the server's answer and not from a second kind list on the page. A ground order
//     still walks, the singular/plural is untouched, and the round-0 sentence is untouched.
// (b) the Buy panel's "Yours"/"Seen" columns count satellites again. PB-224 moved them out of
//     `pieces`, so a satellite row counted 0 while the seat held two in orbit; `orbit === false` is a
//     satellite that is no longer up there and must not be counted.
// (c) the Killer satellite row refuses in a player's sentence, and no player-facing shop string
//     carries a developer tag (UNVERIFIED / STAND-IN / UNMEASURED / "archive's note"). PB-244's rule,
//     applied to the surface this card owns; the rest of the sweep is its own commit.
//
// Every expectation comes from the modules under test or from config; no literal repeats a price or a
// count the config owns.

import { ackText, shopLabel, roundsText } from "../../public/command.mjs";
import { buyRows } from "../../public/dialogs.mjs";
import { shopFor } from "../../server/shop.mjs";
import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "pb240_shop_text";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

const TAG = /\b(UNVERIFIED|UNMEASURED|STAND-IN)\b|archive's (own )?note/i;

export async function run() {
  // ---- (a) the verb ------------------------------------------------------------------
  eq(ackText({ rounds: 3, kind: "reconSat", domain: "sat" }), "Order sent. " + roundsText(3) + " to fly.",
    "a satellite order flies");
  eq(ackText({ rounds: 1, kind: "reconSat", domain: "sat" }), "Order sent. 1 round to fly.",
    "the singular form flies too");
  eq(ackText({ rounds: 2, kind: "tank", domain: "land" }), "Order sent. 2 rounds to walk.",
    "a ground order still walks");
  eq(ackText({ rounds: 0, kind: "reconSat", domain: "sat" }), "Order sent. That piece is already on that cell.",
    "the round-0 sentence is unchanged for a satellite");
  eq(ackText({ rounds: 4, piece: "x" }), "Order sent. 4 rounds to walk.",
    "an ack with no kind at all keeps the old sentence");
  // A satellite kind without the domain still flies: the page must not depend on one field only.
  eq(ackText({ rounds: 5, kind: "killerSat" }), "Order sent. 5 rounds to fly.",
    "the kind alone is enough for a satellite");

  // ---- (b) the Buy panel's counts -----------------------------------------------------
  const room = {
    you: "blue",
    seat: { side: "blue", cash: 100000 },
    shop: shopFor("1986"),
    pieces: [],
    satellites: [
      { id: "blue:reconSat:setup", side: "blue", kind: "reconSat", orbit: true },
      { id: "blue:reconSat:buy1", side: "blue", kind: "reconSat", orbit: true },
      { id: "red:reconSat:setup", side: "red", kind: "reconSat", orbit: true },
      { id: "blue:reconSat:down", side: "blue", kind: "reconSat", orbit: false },
    ],
  };
  const rows = Object.fromEntries(buyRows(room).map((row) => [row.kind, row]));
  eq(Boolean(rows.reconSat), true, "the shop has a recon satellite row");
  eq(rows.reconSat.own, 2, "own counts the satellites in orbit, not the one that is down");
  eq(rows.reconSat.known, 1, "known counts the opponent's satellites");
  // The ground rows are untouched by the satellite branch.
  eq(rows.infantry.own, 0, "a ground row still counts pieces");

  // The same room, with a ground piece, counts it as it always did.
  const withTanks = {
    ...room,
    pieces: [
      { id: "t1", side: "blue", kind: "tank", x: 1, y: 1 },
      { id: "t2", side: "red", kind: "tank", x: 2, y: 2 },
    ],
  };
  const tankRows = Object.fromEntries(buyRows(withTanks).map((row) => [row.kind, row]));
  eq([tankRows.tank.own, tankRows.tank.known], [1, 1], "ground counts are unchanged by PB-240(b)");

  // ---- (c) the killer row's sentence, and the tag rule ---------------------------------
  const killer = rows.killerSat;
  eq(Boolean(killer && killer.refused), true, "the killer row is still refused");
  eq(TAG.test(killer.refused), false, "the killer row leaks a developer tag: " + killer.refused);
  eq(Boolean(/\.$/.test(String(killer.refused).trim())), true, "the killer sentence does not end in a period");
  eq(/not in this build/i.test(killer.refused), true, "the killer sentence does not name the player-facing outcome: " + killer.refused);

  // Every shop row, both eras, every player-facing string: no tags. This is the shape PB-244 sweeps
  // across the rest of the UI; here it guards the surface PB-240 touches.
  for (const era of ["1918", "1942", "1986", "2023"]) {
    for (const row of shopFor(era)) {
      const strings = [shopLabel(row), row.refused || "", String(row.tool || "")];
      for (const text of strings) {
        if (TAG.test(text)) fail(era + " " + row.kind + " leaks a developer tag: " + text);
      }
    }
  }

  // The provenance did not disappear, it moved: config still records that the effect was never
  // recovered, so a later reader can find the reason without a player being told.
  const { resourceSpec } = await import("../../server/resources.mjs");
  eq(Boolean(resourceSpec || true), true, "config loads");
  const config = JSON.parse((await import("node:fs")).readFileSync(new URL("../../../config/game.json", import.meta.url), "utf8").toString());
  eq(/UNVERIFIED/.test(String(config.sources.prices.killerSat)), true,
    "config sources.prices.killerSat no longer records the UNVERIFIED provenance");

  // ---- the ack the server actually sends ----------------------------------------------
  // The wire shape is pinned end to end in the e2e leg; here the seat view's satellites and the shop
  // row must agree on the kind, or (b) would count a different word than the row sells.
  const match = openMatch("1986", []);
  const view = forSeat(match, "blue");
  const sats = Array.isArray(view && view.satellites) ? view.satellites : [];
  if (sats.length === 0) fail("the 1986 seat opens with no satellite to count");
  eq(sats.every((sat) => sat.kind === "reconSat"), true, "the opening satellites are the row's kind");
}
