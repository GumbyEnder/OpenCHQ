// Node test for PB-224's OPENING PAIR ON THE WIRE: the lobby ROOM frame - not the per-seat payload -
// is what the page draws from, so a start-of-match satellite that exists in match.satellites but
// never reaches `room.satellites` is invisible in Show Satellites until somebody buys one.
//
// Why this label exists separately from pb224_satellite_start: that arm reads forSeat() directly.
// view.forSeat has carried satellites since 8882c14, while the lobby's roomView only started
// forwarding them in 301e7fa (web/server/lobby.mjs, the one-hunk `satellites:` line). An arm built on
// forSeat is green under a roomView that drops the field - measured: mutant m3 (that line deleted)
// SURVIVED the whole suite at 301e7fa. So this arm drives createLobby() through a real invite/accept
// and asserts on the frames the server actually sends each seat.
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

export const name = "pb224_satellite_room";

function fail(message) {
  throw new Error("node test pb224_satellite_room: " + message);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(label + ": " + a + " !== " + b);
}

function fakePeer() {
  const box = [];
  return {
    box,
    closed: false,
    send(message) { box.push(message); },
    close() { this.closed = true; },
    onclose: null,
  };
}

// A rejoin answers with a full `welcome`, not a `room` frame: both carry the room view.
function lastRoom(peer) {
  const frames = peer.box.filter((m) => m && (m.op === "room" || m.op === "welcome") && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

function openRoom(gate, era, tag) {
  const blue = fakePeer();
  const red = fakePeer();
  gate.join(tag + "_blue", blue);
  gate.join(tag + "_red", red);
  const invite = gate.handle(tag + "_blue", { op: "invite", user: tag + "_red", era, side: "blue" });
  if (!invite || invite.error) fail("the invite for " + era + " failed: " + JSON.stringify(invite));
  const sent = red.box.filter((m) => m && m.op === "invite").pop();
  if (!sent) fail("the red seat never received the invite frame for " + era);
  const accept = gate.handle(tag + "_red", { op: "answer", id: sent.invite.id, accept: true });
  if (!accept || accept.error) fail("the accept for " + era + " failed: " + JSON.stringify(accept));
  for (const [who, peer] of [["blue", blue], ["red", red]]) {
    if (!lastRoom(peer)) fail("the " + who + " seat got no room frame after the accept (" + era + ")");
  }
  return { blue, red };
}

export async function run() {
  const cfg = satelliteRules();
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb224-room-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    // Dynamic import so db.mjs and rooms.mjs see the isolated data directory, not the operator's store.
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    // --- 1986: both seats' ROOM frames carry the whole opening pair, at round 0 ------------------
    const { blue, red } = openRoom(gate, "1986", "pb224_room");
    const blueRoom = lastRoom(blue);
    const redRoom = lastRoom(red);
    eq("the 1986 room opens at round 0", [blueRoom.round, redRoom.round], [0, 0]);
    for (const [who, room] of [["blue", blueRoom], ["red", redRoom]]) {
      const sats = Array.isArray(room.satellites) ? room.satellites : [];
      eq("the " + who + " seat's ROOM frame carries one satellite per side", sats.map((sat) => sat.side).sort(),
        ["blue", "red"]);
      for (const sat of sats) {
        eq("the " + who + " seat's ROOM frame puts the " + sat.side + " satellite on its start cell",
          [sat.x, sat.y], [cfg.startCells[sat.side].x, cfg.startCells[sat.side].y]);
        eq("the " + who + " seat's ROOM frame opens the " + sat.side + " satellite in orbit with a full tank",
          [sat.orbit, sat.fuel, sat.fuelCapacity], [true, cfg.fuelCapacity, cfg.fuelCapacity]);
      }
    }
    // The manual's p.12 frame is a CROSS-SEAT picture (blue over the Atlantic, red over Europe):
    // red's frame must carry blue's satellite and blue's must carry red's, by id, not just a count.
    const ids = (room) => (room.satellites || []).map((sat) => sat.id + ":" + sat.side).sort();
    eq("red's ROOM frame carries blue's satellite and blue's carries red's", ids(redRoom), ids(blueRoom));
    if (!(redRoom.satellites || []).some((sat) => sat.side === "blue")) {
      fail("red's ROOM frame has no blue satellite (the p.12 picture is not what the server sends)");
    }
    // A start-of-match satellite is not a ground piece: it must not ride the pieces list.
    if ((blueRoom.pieces || []).some((unit) => unit.domain === "sat" || unit.kind === "reconSat")) {
      fail("a satellite is on the room's pieces list");
    }

    // --- 1942: the era gate reaches the SERVED frame, not just openMatch -------------------------
    const none = openRoom(gate, "1942", "pb224_room442");
    for (const [who, peer] of [["blue", none.blue], ["red", none.red]]) {
      eq("the 1942 " + who + " ROOM frame carries no satellite",
        (lastRoom(peer).satellites || []).map((sat) => sat.id), []);
    }

    // --- the purse: the opening pair is free, a purchase is not ----------------------------------
    const match = openMatch("1986", []);
    eq("a 1986 start opens with one satellite per side (the purse arm reads a real opening pair)",
      match.satellites.length, 2);
    eq("the opening pair did not debit either pool",
      [match.sides.blue.cash, match.sides.red.cash], [startPool("1986"), startPool("1986")]);
    const price = priceOf("reconSat");
    if (!Number.isFinite(price) || price <= 0) fail("reconSat has no positive price: " + price);
    const bought = buySatellite(match, "blue", 40, 20);
    if (bought.error) fail("a satellite could not be bought beside the opening pair: " + bought.error);
    eq("a purchase DOES debit the pool by the config price, so the free-opening arm discriminates",
      match.sides.blue.cash, startPool("1986") - price);
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not evidence */ }
  }
}
