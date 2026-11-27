// pb321_delivery — `destinationOp` must deliver through the ONE seat-log helper, and the mover's
// private order must still reach the mover and nobody else.
//
// What breaks if this is removed: `destinationOp` kept its own mine-only copy of the delivery block
// (room.log[mine].push + one `op:"log"` send). PB-316 copied that template once already, and the
// copy carries no clamp — a seat's log can only be trimmed by a round, so at peace (where no round
// runs) a destination-heavy room grew the array without a ceiling. This pin grades the BEHAVIOUR;
// the source-text identity lives in pb321_log_scope.mjs.
//
// Arms (card PB-321 §3), in the order a base tree must red on:
//   (a)  two human seats, peacetime `op:"destination"` from blue — blue reads exactly one line,
//        red reads NOTHING (no `op:"log"` frame at all), and the answer comes back on blue's
//        socket only. (Green on base too: this is the invariant, not the fix.)
//   (a2) THE CLAMP, through this op: 241 deliveries, array length 240. Base has no clamp on this
//        path and reads 241. This is the red that names the defect.
//   (b1) the scope function narrows a `destination_set` set to the mover's seat.
//   (b2) a both-seat event set reaches BOTH seats, each in its own wording.
//   (b3) PB-196 ordering: `logLines` still runs for the unaddressed seat, so its sight memory is
//        refreshed (a skipped call re-reports a lost cell next round).
//   (c)  the doors are unchanged: the war turns the destination away with the manual sentence, and
//        an aircraft is refused with "Air missions cannot be predetermined." (module-level arm — the
//        1986 board ships no aircraft).
//
// The (b)/(b3) arms read the debug entry point PB-321 adds, so they are guarded: on a tree without
// it the arm fails BY NAME instead of throwing, and the behaviour arms above have already run.
//
// The lobby writes rooms to SQLite, so OPENCHQ_WEB_DATA points at a throwaway directory BEFORE
// lobby.mjs is imported: a test must never read or write the operator's real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb321_delivery";

const DEST_LINE = "a destination is set; it moves when the war begins";
const WAR_SENTENCE = "A starting destination is a peacetime order; the war is on.";
const AIR_SENTENCE = "Air missions cannot be predetermined.";

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
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb321-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const { setStartingDestination } = await import("../../server/move.mjs");
    const { openMatch } = await import("../../server/match.mjs");
    const gate = createLobby();

    const alice = fakePeer(); // blue, the mover
    const bob = fakePeer();   // red, must stay blind
    gate.join("pb321_alice", alice);
    gate.join("pb321_bob", bob);
    const inv = gate.handle("pb321_alice", { op: "invite", user: "pb321_bob", era: "1986", side: "blue" });
    if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
    const invite = bob.box.filter((m) => m && m.op === "invite").pop();
    if (!invite) fail("bob never received the invite frame");
    const acc = gate.handle("pb321_bob", { op: "answer", id: invite.invite.id, accept: true });
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

    // ---- a blue land unit and one cell the preview accepts --------------------------------
    const dump0 = gate.debugRoom(roomId);
    const mover = (dump0.pieces || []).find((p) => p.side === "blue" &&
      String(p.domain || "land") === "land" && p.kind !== "aircraft" && p.transport !== true);
    if (!mover) fail("1986 blue holds no land unit: " + JSON.stringify(dump0.pieces));
    const tries = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) tries.push({ x: mover.x + dx, y: mover.y + dy });
    const redBefore = bob.box.length;
    let accepted = null;
    for (const candidate of tries) {
      const res = gate.handle("pb321_alice", { op: "destination", piece: mover.id, to: candidate, id: "pb321-dest" });
      if (res && !res.error) { accepted = res; break; }
    }
    if (!accepted) fail("no neighbouring cell was accepted as a starting destination for " + mover.id);
    const reply = alice.box.filter((m) => m && m.op === "destination").pop();
    if (!reply || !reply.to) fail("(a) the answer carries no stored cell: " + JSON.stringify(reply));
    const cell = { x: Number(reply.to.x), y: Number(reply.to.y) };

    // ---- (a) the mover reads exactly one line, red reads nothing --------------------------
    if (countLine(alice, DEST_LINE) !== 1) {
      fail("(a) blue's delivered log does not carry exactly one \"" + DEST_LINE + "\" - got " +
        countLine(alice, DEST_LINE) + ": " + JSON.stringify(logText(alice)));
    }
    const redFrames = bob.box.slice(redBefore).filter((m) => m && m.op === "log");
    if (redFrames.length) fail("(a) red was handed a log frame for blue's private order: " + JSON.stringify(redFrames));
    if (bob.box.slice(redBefore).some((m) => m && m.op === "destination")) {
      fail("(a) the order echoed on red's socket: " + JSON.stringify(bob.box.slice(redBefore)));
    }
    if (String(reply.piece) !== String(mover.id)) {
      fail("(a) the answer does not echo the piece: " + JSON.stringify(reply));
    }
    gate.handle("pb321_bob", { op: "sync" });
    const redRoom = lastRoom(bob);
    if (!redRoom || !Array.isArray(redRoom.log) || redRoom.log.length !== 0) {
      fail("(a) red's stored log is not empty after blue's private order: " + JSON.stringify(redRoom && redRoom.log));
    }
    gate.handle("pb321_alice", { op: "sync" });
    const blueRoom = lastRoom(alice);
    if (!blueRoom || !Array.isArray(blueRoom.log) || blueRoom.log.length !== 1) {
      fail("(a) blue's stored log is not exactly one row: " + JSON.stringify(blueRoom && blueRoom.log));
    }

    // ---- (a2) the clamp holds through this op: 241 deliveries, 240 rows -------------------
    const delivered = 241;
    for (let i = 0; i < delivered - 1; i++) {
      const again = gate.handle("pb321_alice", { op: "destination", piece: mover.id, to: cell, id: "pb321-dest-" + i });
      if (!again || again.error) fail("(a2) repeat destination " + i + " was refused: " + JSON.stringify(again));
    }
    gate.handle("pb321_alice", { op: "sync" });
    const clamped = lastRoom(alice);
    const rows = Array.isArray(clamped && clamped.log) ? clamped.log.length : -1;
    if (countLine(alice, DEST_LINE) !== delivered) {
      fail("(a2) the mover should have read " + delivered + " destination lines, read " +
        countLine(alice, DEST_LINE) + " - the clamp must not drop the newest row");
    }
    if (rows !== 240) {
      fail("(a2) the 240-line clamp did not hold through destinationOp: array length " + rows +
        " after " + delivered + " deliveries (241 = no clamp on this path, 239 = an over-trim)");
    }
    if (Array.isArray(clamped.log) && clamped.log.length &&
      String(clamped.log[clamped.log.length - 1].text) !== DEST_LINE) {
      fail("(a2) the newest row is not the destination line after the clamp: " +
        JSON.stringify(clamped.log[clamped.log.length - 1]));
    }

    // ---- (b) one seat-scope owner ---------------------------------------------------------
    if (typeof gate.debugSeatLog !== "function") {
      fail("(b1) no delivery entry point to grade: destinationOp's log must go through the shared helper");
    } else {
      const blue0 = logText(alice).length;
      const red0 = logText(bob).length;
      gate.debugSeatLog(roomId, [{ type: "destination_set", side: "blue", pieceId: mover.id, x: cell.x, y: cell.y, round: 0 }]);
      if (logText(alice).length !== blue0 + 1) {
        fail("(b1) a destination_set set did not reach the mover exactly once: " + (logText(alice).length - blue0));
      }
      if (logText(bob).length !== red0) {
        fail("(b1) a destination_set set leaked to the other seat: " + JSON.stringify(logText(bob).slice(red0)));
      }
      const blue1 = logText(alice).length;
      const red1 = logText(bob).length;
      gate.debugSeatLog(roomId, [
        { type: "income", side: "blue", amount: 1, round: 0 },
        { type: "income", side: "red", amount: 1, round: 0 },
      ]);
      if (logText(alice).length !== blue1 + 1) {
        fail("(b2) a both-seat set did not reach blue: " + (logText(alice).length - blue1));
      }
      if (logText(bob).length !== red1 + 1) {
        fail("(b2) a both-seat set did not reach red: " + JSON.stringify(logText(bob).slice(red1)));
      }
      // (b3) PB-196: the builder ran for the unaddressed seat too, so its sight memory moved.
      const sight = gate.debugRoom(roomId).sightSeen;
      if (!sight || !Array.isArray(sight.blue) || !Array.isArray(sight.red)) {
        fail("(b3) the seat-log builder's sight memory is not on the dump: " + JSON.stringify(sight));
      }
    }

    // ---- (c1) the war turns the door away with the manual sentence ------------------------
    const war = gate.handle("pb321_alice", { op: "resume_war" });
    if (!war || war.error) fail("resume_war was refused: " + JSON.stringify(war));
    const atWar = gate.handle("pb321_alice", { op: "destination", piece: mover.id, to: cell, id: "pb321-war" });
    if (!atWar || String(atWar.error || "") !== WAR_SENTENCE) {
      fail("(c) the wartime refusal is not the manual sentence: " + JSON.stringify(atWar));
    }

    // ---- (c2) an aircraft destination is refused, unchanged -------------------------------
    // 1986 ships no aircraft, so this arm is module-level on a peacetime match that has one.
    const probe = openMatch("1986");
    const plane = { id: "probe:air", side: "blue", domain: "air", kind: "aircraft", x: 10, y: 10 };
    probe.pieces = [{ id: "probe:land", side: "blue", domain: "land", kind: "infantry", x: 10, y: 10 }, plane];
    const air = setStartingDestination(probe, "blue", plane.id, 11, 10);
    if (!air || String(air.error || "") !== AIR_SENTENCE) {
      fail("(c) an aircraft destination was not refused with the manual sentence: " + JSON.stringify(air));
    }
    if (plane.startingDestination) fail("(c) a refused aircraft kept a stored destination");
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
