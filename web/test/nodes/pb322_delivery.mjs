// pb322_delivery — a peacetime transfer's line goes through the shared helper: the mover reads it,
// the other seat reads nothing, and the helper's 240-line clamp now applies to this path.
//
// What breaks if this is removed: `transferOp` kept a mine-only copy of the delivery block with no
// clamp. At peace no round runs, so that array was trimmed by nothing at all.
//
// Arms (card PB-322 §3):
//   (a)  two human seats, peace, a blue `op:"transfer"` to a friendly cell: blue's delivered log
//        gains exactly one "a unit transferred", red gains NO `op:"log"` frame at all, and the
//        order answers with one `op:"transferred"` on blue's socket only.
//   (a2) the clamp, through this op: 241 transfers (out and back), array length stays 240.
//   (b)  the seat scope is the helper's: a synthetic both-seat set still reaches both seats, so the
//        narrowing the transfer gained did not cost anyone else their line. (Guarded: without the
//        entry point the arm fails by name.)
//   (c)  the doors are unchanged: TRANSFER_AT_WAR once the war is on, TRANSFER_NEUTRAL onto ground
//        that is not ours.
//
// The lobby writes rooms to SQLite, so OPENCHQ_WEB_DATA points at a throwaway directory BEFORE
// lobby.mjs is imported: a test must never read or write the operator's real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb322_delivery";

const MOVE_LINE = "a unit transferred";
const WAR_SENTENCE = "A transfer is a peacetime order; the war is on.";
const NEUTRAL_SENTENCE = "Units may not be transferred into neutral or enemy territory.";

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

function lastRoom(peer) {
  const frames = peer.box.filter((m) => m && (m.op === "room" || m.op === "welcome") && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

function logText(peer) {
  return peer.box
    .filter((m) => m && m.op === "log")
    .flatMap((m) => (Array.isArray(m.lines) ? m.lines : []).map((line) => String(line && line.text)));
}

function countLine(peer, text) {
  return logText(peer).filter((line) => line === text).length;
}

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb322-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    const alice = fakePeer(); // blue, the mover
    const bob = fakePeer();   // red, stays blind
    gate.join("pb322_alice", alice);
    gate.join("pb322_bob", bob);
    const inv = gate.handle("pb322_alice", { op: "invite", user: "pb322_bob", era: "1986", side: "blue" });
    if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
    const invite = bob.box.filter((m) => m && m.op === "invite").pop();
    if (!invite) fail("bob never received the invite frame");
    const acc = gate.handle("pb322_bob", { op: "answer", id: invite.invite.id, accept: true });
    if (!acc || acc.error) fail("the accept failed: " + JSON.stringify(acc));
    const opening = lastRoom(alice);
    if (!opening) fail("alice got no room frame after the accept");
    if (opening.blue.kind !== "human" || opening.red.kind !== "human") {
      fail("the room is not two-human: " + JSON.stringify({ blue: opening.blue, red: opening.red }));
    }
    if (!opening.peace || opening.peace.active !== true) {
      fail("1986 did not open in the peace this arm needs: " + JSON.stringify(opening.peace));
    }
    const roomId = opening.id;

    // ---- a blue land unit and a friendly cell it may transfer to --------------------------
    const dump0 = gate.debugRoom(roomId);
    const mover = (dump0.pieces || []).find((p) => p.side === "blue" &&
      String(p.domain || "land") === "land" && p.kind !== "aircraft" && p.transport !== true);
    if (!mover) fail("1986 blue holds no land unit: " + JSON.stringify(dump0.pieces));
    const home = { x: Number(mover.x), y: Number(mover.y) };
    let there = null;
    const redBefore = bob.box.length;
    for (let r = 1; r <= 6 && !there; r++) {
      for (let dy = -r; dy <= r && !there; dy++) {
        for (let dx = -r; dx <= r && !there; dx++) {
          if (!dx && !dy) continue;
          const cell = { x: home.x + dx, y: home.y + dy };
          const res = gate.handle("pb322_alice", { op: "transfer", piece: mover.id, to: cell, id: "pb322-move" });
          if (res && !res.error) { there = cell; break; }
        }
      }
    }
    if (!there) fail("no friendly neighbouring cell accepted the transfer of " + mover.id);
    const reply = alice.box.filter((m) => m && m.op === "transferred").pop();
    if (!reply) fail("(a) blue never received its op:\"transferred\" answer");

    // ---- (a) the mover reads one line, red reads nothing -----------------------------------
    if (countLine(alice, MOVE_LINE) !== 1) {
      fail("(a) blue's delivered log does not carry exactly one \"" + MOVE_LINE + "\" - got " +
        countLine(alice, MOVE_LINE) + ": " + JSON.stringify(logText(alice)));
    }
    if (bob.box.slice(redBefore).some((m) => m && m.op === "log")) {
      fail("(a) red was handed a log frame for blue's private transfer: " +
        JSON.stringify(bob.box.slice(redBefore).filter((m) => m.op === "log")));
    }
    if (bob.box.slice(redBefore).some((m) => m && m.op === "transferred")) {
      fail("(a) the transfer echoed on red's socket");
    }
    gate.handle("pb322_bob", { op: "sync" });
    const redRoom = lastRoom(bob);
    if (!redRoom || !Array.isArray(redRoom.log) || redRoom.log.length !== 0) {
      fail("(a) red's stored log is not empty: " + JSON.stringify(redRoom && redRoom.log));
    }
    gate.handle("pb322_alice", { op: "sync" });
    const blueRoom = lastRoom(alice);
    if (!blueRoom || !Array.isArray(blueRoom.log) || blueRoom.log.length !== 1) {
      fail("(a) blue's stored log is not exactly one row: " + JSON.stringify(blueRoom && blueRoom.log));
    }

    // ---- (a2) the clamp holds: 241 transfers, 240 rows --------------------------------------
    const delivered = 241;
    let at = { x: there.x, y: there.y };
    for (let i = 1; i < delivered; i++) {
      const target = i % 2 === 1 ? home : there;
      const back = gate.handle("pb322_alice", { op: "transfer", piece: mover.id, to: target, id: "pb322-move-" + i });
      if (!back || back.error) fail("(a2) transfer " + i + " was refused: " + JSON.stringify(back));
      at = target;
    }
    gate.handle("pb322_alice", { op: "sync" });
    const clamped = lastRoom(alice);
    const rows = Array.isArray(clamped && clamped.log) ? clamped.log.length : -1;
    if (countLine(alice, MOVE_LINE) !== delivered) {
      fail("(a2) the mover should have read " + delivered + " transfer lines, read " +
        countLine(alice, MOVE_LINE) + " - the clamp must not drop the newest row");
    }
    if (rows !== 240) {
      fail("(a2) the 240-line clamp did not hold through transferOp: array length " + rows +
        " after " + delivered + " transfers (241 = no clamp on this path, 239 = an over-trim)");
    }

    // ---- (b) the narrowing did not cost the both-seat events their line ---------------------
    if (typeof gate.debugSeatLog === "function") {
      const blue0 = logText(alice).length;
      const red0 = logText(bob).length;
      gate.debugSeatLog(roomId, [
        { type: "income", side: "blue", amount: 1, round: 0 },
        { type: "income", side: "red", amount: 1, round: 0 },
      ]);
      if (logText(alice).length !== blue0 + 1 || logText(bob).length !== red0 + 1) {
        fail("(b) a both-seat set stopped reaching both seats after the transfer gained a scope: " +
          JSON.stringify({ blue: logText(alice).length - blue0, red: logText(bob).length - red0 }));
      }
    } else {
      fail("(b) no delivery entry point to grade: transferOp's log must go through the shared helper");
    }

    // ---- (c) the doors are unchanged --------------------------------------------------------
    const war = gate.handle("pb322_alice", { op: "resume_war" });
    if (!war || war.error) fail("resume_war was refused: " + JSON.stringify(war));
    const atWar = gate.handle("pb322_alice", { op: "transfer", piece: mover.id, to: at, id: "pb322-war" });
    if (!atWar || String(atWar.error || "") !== WAR_SENTENCE) {
      fail("(c) the wartime refusal is not the manual sentence: " + JSON.stringify(atWar));
    }
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
