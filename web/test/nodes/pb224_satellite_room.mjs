// PB-224 §1/AC5 ON THE WIRE: the lobby ROOM frame - not the per-seat payload - is what the page
// draws from, so a start-of-match satellite that exists in match.satellites but never reaches
// `room.satellites` is invisible in Show Satellites until somebody buys one.
//
// Why this label exists separately from pb224_satellite_start and pb224_ac5_view: both read
// forSeat()/the payload shape. view.forSeat has carried satellites since 8882c14, while the lobby's
// roomView only started forwarding them in 301e7fa (web/server/lobby.mjs, the one-hunk
// `satellites:` line). An arm built on forSeat is green under a roomView that drops the field -
// measured: frodo's m3 (that line deleted) SURVIVED the whole suite at 301e7fa. So this arm drives
// createLobby() through a real invite/accept and asserts on the frames the server actually sends
// each seat.
//
// What fails if this is removed: deleting `satellites: seen && Array.isArray(seen.satellites) ...`
// from roomView leaves every seat's frame with an empty orbit at round 0 and nothing reds.
//
// PB-224 §1 also pins the purse here: a start-of-match satellite is not a purchase, so it must not
// debit the pool - and a bought one must, or the arm would pass on a build where nothing is charged.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openMatch } from "../../server/match.mjs";
import { buySatellite, satelliteRules } from "../../server/satellite.mjs";
import { priceOf, startPool } from "../../server/rules.mjs";
import { lastRoom, makeAsserts, openRoom } from "../pb224_helpers.mjs";

export const name = "pb224_satellite_room";

export async function run() {
  const t = makeAsserts(name);
  const cfg = satelliteRules();
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb224-room-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    // Dynamic import so db.mjs and rooms.mjs see the isolated data directory, not the operator's store.
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    // --- 1986: both seats' ROOM frames carry the whole opening pair, at round 0 ------------------
    const opened = openRoom(gate, "1986", "pb224_room", name);
    const blueRoom = lastRoom(opened.blue);
    const redRoom = lastRoom(opened.red);
    t.eq("the 1986 room opens at round 0", [blueRoom.round, redRoom.round], [0, 0]);
    for (const [who, room] of [["blue", blueRoom], ["red", redRoom]]) {
      const sats = Array.isArray(room.satellites) ? room.satellites : [];
      t.eq("the " + who + " seat's ROOM frame carries one satellite per side", sats.map((sat) => sat.side).sort(),
        ["blue", "red"]);
      for (const sat of sats) {
        t.eq("the " + who + " seat's ROOM frame puts the " + sat.side + " satellite on its start cell",
          [sat.x, sat.y], [cfg.startCells[sat.side].x, cfg.startCells[sat.side].y]);
        t.eq("the " + who + " seat's ROOM frame opens the " + sat.side + " satellite in orbit with a full tank",
          [sat.orbit, sat.fuel, sat.fuelCapacity], [true, cfg.fuelCapacity, cfg.fuelCapacity]);
      }
    }
    // The manual's p.12 frame is a CROSS-SEAT picture (blue over the Atlantic, red over Europe):
    // red's frame must carry blue's satellite and blue's must carry red's, by id, not just a count.
    const ids = (room) => (room.satellites || []).map((sat) => sat.id + ":" + sat.side).sort();
    t.eq("red's ROOM frame carries blue's satellite and blue's carries red's", ids(redRoom), ids(blueRoom));
    t.ok("red's ROOM frame has a blue satellite (the p.12 picture is what the server sends)",
      (redRoom.satellites || []).some((sat) => sat.side === "blue"));
    // A start-of-match satellite is not a ground piece: it must not ride the pieces list.
    t.ok("a satellite is not on the room's pieces list",
      !(blueRoom.pieces || []).some((unit) => unit.domain === "sat" || unit.kind === "reconSat"));

    // --- 1942: the era gate reaches the SERVED frame, not just openMatch -------------------------
    const none = openRoom(gate, "1942", "pb224_room442", name);
    for (const [who, peer] of [["blue", none.blue], ["red", none.red]]) {
      t.eq("the 1942 " + who + " ROOM frame carries no satellite",
        (lastRoom(peer).satellites || []).map((sat) => sat.id), []);
    }
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not evidence */ }
  }

  // --- the purse: the opening pair is free, a purchase is not ----------------------------------
  const match = openMatch("1986", []);
  t.eq("a 1986 start opens with one satellite per side (the purse arm reads a real opening pair)",
    match.satellites.length, 2);
  t.eq("the opening pair did not debit either pool",
    [match.sides.blue.cash, match.sides.red.cash], [startPool("1986"), startPool("1986")]);
  const price = priceOf("reconSat");
  t.ok("reconSat has a positive price (" + price + ")", Number.isFinite(price) && price > 0);
  const bought = buySatellite(match, "blue", 40, 20);
  if (bought.error) t.fail("a satellite could not be bought beside the opening pair: " + bought.error);
  t.eq("a purchase DOES debit the pool by the config price, so the free-opening arm discriminates",
    match.sides.blue.cash, startPool("1986") - price);

  console.log(t.line());
}
