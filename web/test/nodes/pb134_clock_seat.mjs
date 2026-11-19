// pb134_clock_seat — the clock is held by a SEAT, not by whoever sent the last op (PB-134).
//
// What breaks if this is removed: `setClock` takes no seat consent, so in a two-human room one
// seat's `pause` is undone by the other seat's next `run` in one assignment. Measured RED at the
// base control (0f7aade): A hold -> clock held, B run -> {"ok":true}, clock running.
//
// The rule this leg pins, as ruled in openchq-pm 7439 (which takes frodo's 4a/4b/4c over the
// earlier 7431 wording):
//   - a hold from either seat takes effect at once, and both seats see the room held;
//   - `run` releases only the SENDER's own hold, and is refused while the other seat's hold stands,
//     with the holder named to the sender in the ticket's sentence, byte for byte;
//   - if both seats hold, each run clears that seat's own hold, so the last one to run starts the
//     clock and the first is refused naming the other;
//   - a dropped socket CLEARS that seat's hold and holds the room, and the present seat's run is
//     ACCEPTED with no refusal frame - an absent seat can never gate the clock (4a/4b);
//   - a rejoin restores the seat and leaves the clock held until someone runs (4c);
//   - human + bot is unchanged (AC2): the bot never sends a clock op, so hold then run still works.
//
// The lobby writes rooms to SQLite, so this node points OPENCHQ_WEB_DATA at a throwaway directory
// BEFORE importing lobby.mjs: a test must never read or write the operator's real room store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb134_clock_seat";

// The ticket's own sentence, with the seat substituted. openchq-pm 7439 ruled this the ONLY refusal
// string, verbatim and trimmed; frodo's AC4 arm 2 diffs the served string against the ticket line.
const SEAT_REFUSAL = "The clock is held by pb134_alice. Only pb134_alice can resume it.";
const SEAT_REFUSAL_B = "The clock is held by pb134_bob. Only pb134_bob can resume it.";

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
  // A rejoin answers with a full `welcome`, not a `room` frame: both carry the room view.
  const frames = peer.box.filter((m) => m && (m.op === "room" || m.op === "welcome") && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

function refused(result, fail, label, expected) {
  if (!result || !result.error) fail(label + " was not refused at all: " + JSON.stringify(result));
  if (result.error !== expected) {
    fail(label + " refusal is not the ticket's sentence:\n  served:  " + JSON.stringify(result.error) +
      "\n  expected:" + JSON.stringify(expected));
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb134-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    // Dynamic import so db.mjs sees the isolated data directory, not the operator's store.
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    const alice = fakePeer();
    const bob = fakePeer();
    gate.join("pb134_alice", alice);
    gate.join("pb134_bob", bob);
    const inv = gate.handle("pb134_alice", { op: "invite", user: "pb134_bob", era: "1986", side: "blue" });
    if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
    const invite = bob.box.filter((m) => m && m.op === "invite").pop();
    if (!invite) fail("bob never received the invite frame");
    const acc = gate.handle("pb134_bob", { op: "answer", id: invite.invite.id, accept: true });
    if (!acc || acc.error) fail("the accept failed: " + JSON.stringify(acc));
    const first = lastRoom(alice);
    if (!first) fail("alice got no room frame after the accept");
    const roomId = first.id;

    // ---- 1. A hold holds the room for BOTH seats -------------------------------------------
    const held = gate.handle("pb134_alice", { op: "hold" });
    if (!held || held.error) fail("A's hold was refused: " + JSON.stringify(held));
    for (const [who, peer] of [["alice", alice], ["bob", bob]]) {
      const room = lastRoom(peer);
      if (!room || room.clock !== "held") {
        fail(who + " does not see the clock held after A's hold: " + (room ? room.clock : "no frame"));
      }
    }

    // ---- 2. B's run is refused, in the ticket's words, and the clock stays held -------------
    const bobRun = gate.handle("pb134_bob", { op: "run" });
    refused(bobRun, fail, "B's run against A's hold", SEAT_REFUSAL);
    if (/or both seats/i.test(String(bobRun.error))) {
      fail("the refusal still offers a two-seat clear, which hold-immediate does not have");
    }
    for (const [who, peer] of [["alice", alice], ["bob", bob]]) {
      const room = lastRoom(peer);
      if (!room || room.clock !== "held") fail(who + " sees the clock leave held after a refused run");
    }

    // ---- 3. the restart shape: the hold table and the room hold are durable ------------------
    // A restart comes back with nobody connected. The row must carry A's hold (from step 1) and the
    // room hold, or either seat's first `run` after a deploy lifts a pause the other seat owns.
    const { loadRooms } = await import("../../server/rooms.mjs");
    const stored = loadRooms().find((room) => room.id === roomId);
    if (!stored) fail("the room is not in the store after the hold");
    if (stored.holds.blue !== true || stored.holds.red !== false) {
      fail("the stored hold table lost A's hold: " + JSON.stringify(stored.holds));
    }
    if (stored.holdRoom !== true) fail("a held room restored with nobody connected is not a room hold");
    if (stored.clock !== "held") fail("the stored room came back " + stored.clock);

    // ---- 4. both seats hold: each run clears only its own, and the last one starts the clock -
    const bHold = gate.handle("pb134_bob", { op: "hold" });
    if (!bHold || bHold.error) fail("B's hold was refused: " + JSON.stringify(bHold));
    const aRun = gate.handle("pb134_alice", { op: "run" });
    refused(aRun, fail, "A's run while B holds", SEAT_REFUSAL_B);
    if (lastRoom(alice).clock !== "held") fail("the clock left held while B still held it");
    const bRun = gate.handle("pb134_bob", { op: "run" });
    if (!bRun || bRun.error) fail("B's run after A's own hold was cleared was refused: " + JSON.stringify(bRun));
    for (const [who, peer] of [["alice", alice], ["bob", bob]]) {
      const room = lastRoom(peer);
      if (!room || room.clock !== "running") fail(who + " does not see the clock running after both holds cleared");
    }

    // ---- 5. a dropped seat clears its hold and holds the ROOM, and never gates a run ----------
    // (4a) A holds, then A's socket closes: the clock is held, and A's seat hold does not survive.
    const dropHold = gate.handle("pb134_alice", { op: "hold" });
    if (!dropHold || dropHold.error) fail("A's hold before the drop was refused: " + JSON.stringify(dropHold));
    alice.closed = true;
    alice.onclose();
    if (lastRoom(bob).clock !== "held") fail("a dropped seat left the clock running");

    // (4b) B's run is ACCEPTED with no refusal frame. If A's dropped hold had survived, this would
    // be refused naming A - so this single assertion is also 4a's "no seat hold survives" proof.
    const afterDrop = gate.handle("pb134_bob", { op: "run" });
    if (!afterDrop || afterDrop.error) {
      fail("B's run after A dropped was refused - the absent seat gated the clock: " + JSON.stringify(afterDrop));
    }
    if (lastRoom(bob).clock !== "running") fail("B's run after A dropped did not start the clock");

    // (4c) A rejoin restores the seat and leaves the clock held until someone runs.
    const aliceBack = fakePeer();
    gate.join("pb134_alice", aliceBack);
    if (!lastRoom(aliceBack)) fail("A's rejoin carried no room frame");
    if (lastRoom(aliceBack).clock !== "running") fail("A's rejoin changed a clock B had started");
    // A holds, takes the clock down, then drops: nobody runs while the seat is away.
    gate.handle("pb134_alice", { op: "hold" });
    aliceBack.closed = true;
    aliceBack.onclose();
    const syncB = gate.handle("pb134_bob", { op: "sync" });
    if (!syncB || syncB.error) fail("B's sync after A's second drop failed: " + JSON.stringify(syncB));
    if (lastRoom(bob).clock !== "held") fail("A's second drop left the clock running");
    const aliceBack2 = fakePeer();
    gate.join("pb134_alice", aliceBack2);
    const backRoom = lastRoom(aliceBack2);
    if (!backRoom) fail("A's rejoin carried no room frame");
    if (backRoom.clock !== "held") {
      fail("A's rejoin started the clock on its own: " + backRoom.clock);
    }
    const afterRejoinRun = gate.handle("pb134_alice", { op: "run" });
    if (!afterRejoinRun || afterRejoinRun.error) fail("A's run after rejoining was refused: " + JSON.stringify(afterRejoinRun));
    if (lastRoom(bob).clock !== "running") fail("B does not see the clock running after A rejoined and ran");

    // ---- 6. AC2 control: human + bot is exactly as it was -----------------------------------
    const solo = fakePeer();
    gate.join("pb134_solo", solo);
    const botRoom = gate.handle("pb134_solo", { op: "bot", era: "1986", side: "blue" });
    if (!botRoom || botRoom.error) fail("the bot room failed: " + JSON.stringify(botRoom));
    const h = gate.handle("pb134_solo", { op: "hold" });
    const r = gate.handle("pb134_solo", { op: "run" });
    if (!h || h.error) fail("human+bot hold was refused: " + JSON.stringify(h));
    if (!r || r.error) fail("human+bot run was refused: " + JSON.stringify(r));
    const soloRoom = lastRoom(solo);
    if (!soloRoom || soloRoom.clock !== "running") fail("human+bot clock is not running after hold+run");

    // ---- 7. a seat-less sender cannot move the room's clock --------------------------------
    const stranger = fakePeer();
    gate.join("pb134_stranger", stranger);
    const foreign = gate.handle("pb134_stranger", { op: "run" });
    if (!foreign || !foreign.error) fail("a sender with no seat in the room moved the clock: " + JSON.stringify(foreign));
    if (lastRoom(aliceBack2).clock !== "running") fail("a sender with no seat changed the room's clock");
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}
