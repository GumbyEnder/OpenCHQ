// PB-224 ruling 2 (PM 8913 §2): a 1986 or 2023 start opens with ONE recon satellite per side
// already in orbit, on the standing-in start cells; every other era opens with none.
//
// This arm reads the SERVED round-0 frame - the lobby's ROOM view, through a real invite/accept,
// for both seats - not the per-seat payload (PM 8918 §3 / 8919 §3). view.forSeat has carried
// satellites since 8882c14, so an arm built on it is green under a resolver that seeds nothing
// (frodo's m4) and under a config key that is read but never placed (m5). Both must red HERE.
//
// Manual p.12 L326-328 ("You'll see your satellite (in blue) over the Atlantic... The red satellite
// is over Europe") and p.16 L439 / p.29 L924 (satellites are a 1986/2023 feature). Both the COUNT
// and the CELLS are STAND-INS: p.12 is a tutorial and the archive prints no start position, so the
// DOSBox check is owed (Open RE Q-new).
//
// The purse/id half is the same AC's other edge: the opening pair is SETUP, not a purchase, so it
// debits nothing, and the first real purchase lands in the `<side>:<kind>:<n>` namespace at
// blue:reconSat:1 with both `<side>:reconSat:setup` records still in the orbit list.
//
// What fails if this is removed: openMatch stops seeding, 2023 and the second zero era go unpinned
// on the wire, and a purchase that collides with the setup ids goes unnoticed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openMatch } from "../../server/match.mjs";
import { buySatellite, satelliteRules } from "../../server/satellite.mjs";
import { priceOf, startPool } from "../../server/rules.mjs";
import { lastRoom, makeAsserts, openRoom } from "../pb224_helpers.mjs";

export const name = "pb224_satellite_start";

const SETUP_IDS = ["blue:reconSat:setup", "red:reconSat:setup"];

export async function run() {
  const t = makeAsserts(name);
  const cfg = satelliteRules();

  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb224-start-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    // Dynamic import so db.mjs and rooms.mjs see the isolated data directory, not the operator's store.
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    // --- the two eras the ruling names, on the SERVED round-0 frame, both seats -------------------
    for (const era of ["1986", "2023"]) {
      const { blue, red } = openRoom(gate, era, "pb224_start" + era, name);
      for (const [who, peer] of [["blue", blue], ["red", red]]) {
        const room = lastRoom(peer);
        t.eq(era + " " + who + "'s ROOM frame opens at round 0", room.round, 0);
        const sats = Array.isArray(room.satellites) ? room.satellites : [];
        t.eq(era + " " + who + "'s ROOM frame carries one satellite per side",
          sats.map((sat) => sat.side).sort(), ["blue", "red"]);
        t.eq(era + " " + who + "'s ROOM frame names the setup records",
          sats.map((sat) => sat.id).sort(), SETUP_IDS);
        for (const sat of sats) {
          const cell = cfg.startCells[sat.side];
          t.eq(era + " " + who + "'s ROOM frame puts the " + sat.side + " satellite on its start cell",
            [sat.x, sat.y], [cell.x, cell.y]);
          t.eq(era + " " + who + "'s ROOM frame opens the " + sat.side + " satellite in orbit with a full tank",
            [sat.orbit, sat.fuel, sat.fuelCapacity], [true, cfg.fuelCapacity, cfg.fuelCapacity]);
        }
      }
      // The p.12 stand-in is blue over the Atlantic, red over Europe: blue sits WEST of red on this
      // board, or the frame is mirrored and the test pins a coordinate pair without the picture.
      const sats = lastRoom(blue).satellites || [];
      const blueSat = sats.find((sat) => sat.side === "blue");
      const redSat = sats.find((sat) => sat.side === "red");
      t.ok(era + ": the blue satellite is west of the red one", blueSat.x < redSat.x);
      // A start-of-match satellite is not a ground piece: it must not ride the pieces list.
      t.ok(era + ": no satellite is on the ROOM frame's pieces list",
        !(lastRoom(blue).pieces || []).some((unit) => unit.domain === "sat" || unit.kind === "reconSat"));
    }

    // --- every other era opens with none, ON THE SERVED FRAME: two zero eras beside 1942, because
    // 1942 alone pins one entry of the per-era map rather than the map's default (PM 8919 §1).
    for (const era of ["1918", "1942", "9999"]) {
      const { blue, red } = openRoom(gate, era, "pb224_start" + era, name);
      for (const [who, peer] of [["blue", blue], ["red", red]]) {
        t.eq("the " + era + " " + who + " ROOM frame carries no satellite",
          (lastRoom(peer).satellites || []).map((sat) => sat.id), []);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not evidence */ }
  }

  // --- the purse and the id namespace -----------------------------------------------------------
  const match = openMatch("1986", []);
  t.eq("a 1986 start opens with the setup pair, by id",
    match.satellites.map((sat) => sat.id).sort(), SETUP_IDS);
  t.eq("the opening pair did not debit either pool",
    [match.sides.blue.cash, match.sides.red.cash], [startPool("1986"), startPool("1986")]);
  const price = priceOf("reconSat");
  t.ok("reconSat has a positive price (" + price + ")", Number.isFinite(price) && price > 0);
  const bought = buySatellite(match, "blue", 40, 20);
  if (bought.error) t.fail("a satellite could not be bought beside the opening pair: " + bought.error);
  t.eq("the first purchase after the opening pair is blue:reconSat:1", bought.satellite.id, "blue:reconSat:1");
  t.eq("the purchase debits exactly the price, so the free-opening arm discriminates",
    match.sides.blue.cash, startPool("1986") - price);
  t.eq("both setup records survive the purchase",
    match.satellites.filter((sat) => String(sat.id).endsWith(":setup")).map((sat) => sat.id).sort(), SETUP_IDS);
  t.eq("the bought satellite sits on its picked cell", [bought.satellite.x, bought.satellite.y], [40, 20]);

  console.log(t.line());
}
