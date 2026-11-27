// pb315_pause_handshake — a held clock in a TWO-HUMAN war is two seats' answer, and the frame has
// to carry whose hold stands so the page can word it (PB-315, manual p.34).
//
// What breaks if this is removed: PB-134 holds the clock per seat, but the frame carried only
// `clock`, so both seats were told the same thing ("Paused - press Play to resume") no matter which
// of them had pressed Pause. The manual's two strings — "Opponent Waiting" (the opponent has
// unpaused and you have not) and "Waiting for Opponent" (you have unpaused and he has not) — had no
// source in the server's view at all; live app.js at 88f913a contains neither. Measured RED here
// before the change: `room.hold` is undefined on every frame.
//
// The rule this leg pins:
//   (a) either seat's hold holds the clock for both (PB-134's rule, re-read here, not re-graded);
//   (b) the clock runs again only after BOTH seats run;
//   (c) between the presses each seat's frame says which side of the handshake it is on: the seat
//       that pressed Play and was refused reads hold.other === true (so the page can say "Waiting
//       for Opponent"), and the seat holding reads hold.you === true, hold.other === false ("Opponent
//       Waiting"). Both holding is neither — nobody is waiting on anybody;
//   (d) a bot room is unchanged and carries hold {you:false, other:false}: one Play resumes;
//   (e) a dropped seat does not leave the other stuck, and the frame stops claiming the opponent is
//       waiting the moment the opponent is gone.
//
// The lobby writes rooms to SQLite, so this node points OPENCHQ_WEB_DATA at a throwaway directory
// BEFORE importing lobby.mjs: a test must never read or write the operator's real room store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb315_pause_handshake";

const SEAT_REFUSAL = (seat) => "The clock is held by " + seat + ". Only " + seat + " can resume it.";

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

// A delta is a frame too: the seat that did not act sees the change on the delta, so a hold that
// only rode whole frames would leave that seat's sentence one frame stale.
function lastHold(peer) {
  for (let i = peer.box.length - 1; i >= 0; i -= 1) {
    const frame = peer.box[i];
    if (frame && (frame.op === "room" || frame.op === "welcome") && frame.room) return frame.room.hold;
    if (frame && frame.op === "delta") return frame.hold;
  }
  return undefined;
}

function holdsAre(peer, who, you, other, fail, when) {
  const hold = lastHold(peer);
  if (!hold || typeof hold !== "object") {
    fail("(c) " + when + ": " + who + "'s frame carries no hold block at all: " + JSON.stringify(hold));
    return;
  }
  if (hold.you !== you || hold.other !== other) {
    fail("(c) " + when + ": " + who + " reads hold " + JSON.stringify(hold) +
      ", expected " + JSON.stringify({ you, other }));
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb315-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    const alice = fakePeer();
    const bob = fakePeer();
    gate.join("pb315_alice", alice);
    gate.join("pb315_bob", bob);
    const inv = gate.handle("pb315_alice", { op: "invite", user: "pb315_bob", era: "1986", side: "blue" });
    if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
    const invite = bob.box.filter((m) => m && m.op === "invite").pop();
    if (!invite) fail("bob never received the invite frame");
    const acc = gate.handle("pb315_bob", { op: "answer", id: invite.invite.id, accept: true });
    if (!acc || acc.error) fail("the accept failed: " + JSON.stringify(acc));
    const first = lastRoom(alice);
    if (!first) fail("alice got no room frame after the accept");
    if (first.blue.kind !== "human" || first.red.kind !== "human") {
      fail("the room is not two-human, so the handshake arms cannot run: " +
        JSON.stringify({ blue: first.blue, red: first.red }));
    }

    // ---- (in) the pre-game: held, nobody has pressed anything, nobody is waiting --------------
    holdsAre(alice, "alice", false, false, fail, "opening frame");
    holdsAre(bob, "bob", false, false, fail, "opening frame");

    // ---- (b) the clock starts when one seat runs and nobody holds -----------------------------
    const aRun0 = gate.handle("pb315_alice", { op: "run" });
    if (!aRun0 || aRun0.error) fail("A's run on a room nobody holds was refused: " + JSON.stringify(aRun0));
    if (lastRoom(bob).clock !== "running") fail("B does not see the clock running after A's run");

    // ---- (a) A's hold holds it for both ------------------------------------------------------
    const aHold = gate.handle("pb315_alice", { op: "hold" });
    if (!aHold || aHold.error) fail("A's hold was refused: " + JSON.stringify(aHold));
    for (const [who, peer] of [["alice", alice], ["bob", bob]]) {
      if (lastRoom(peer).clock !== "held") fail(who + " does not see the clock held after A's hold");
    }
    holdsAre(alice, "alice", true, false, fail, "A has held");
    holdsAre(bob, "bob", false, true, fail, "A has held");

    // ---- (b)+(c) B's Play is refused, and each seat can word its own side --------------------
    const bRun = gate.handle("pb315_bob", { op: "run" });
    const expected = SEAT_REFUSAL("pb315_alice");
    if (!bRun || !bRun.error) fail("(b) B's Play against A's hold was accepted: " + JSON.stringify(bRun));
    else if (bRun.error !== expected) {
      fail("(b) B's refusal is not the ticket's sentence:\n  served:  " + JSON.stringify(bRun.error) +
        "\n  expected:" + JSON.stringify(expected));
    }
    if (lastRoom(bob).clock !== "held") fail("(b) the clock left held after a refused Play");
    // The seat that pressed Play and was refused: the opponent holds, this seat does not.
    holdsAre(bob, "bob", false, true, fail, "B was refused");
    holdsAre(alice, "alice", true, false, fail, "B was refused");

    // ---- (b) the last holder's Play starts it, and both holds are cleared --------------------
    const aRun1 = gate.handle("pb315_alice", { op: "run" });
    if (!aRun1 || aRun1.error) fail("(b) A's Play was refused by its own hold: " + JSON.stringify(aRun1));
    for (const [who, peer] of [["alice", alice], ["bob", bob]]) {
      if (lastRoom(peer).clock !== "running") fail("(b) " + who + " does not see the clock running after A's Play");
    }
    holdsAre(alice, "alice", false, false, fail, "clock running");
    holdsAre(bob, "bob", false, false, fail, "clock running");

    // ---- both seats hold: neither side of the handshake, and the first Play is refused -------
    gate.handle("pb315_alice", { op: "hold" });
    const bHold = gate.handle("pb315_bob", { op: "hold" });
    if (!bHold || bHold.error) fail("B's hold was refused: " + JSON.stringify(bHold));
    holdsAre(alice, "alice", true, true, fail, "both have held");
    holdsAre(bob, "bob", true, true, fail, "both have held");
    const aRunBoth = gate.handle("pb315_alice", { op: "run" });
    const expectedB = SEAT_REFUSAL("pb315_bob");
    if (!aRunBoth || !aRunBoth.error) fail("(b) A's Play while B also holds was accepted: " + JSON.stringify(aRunBoth));
    else if (aRunBoth.error !== expectedB) {
      fail("(b) the both-hold refusal is not the ticket's sentence:\n  served:  " +
        JSON.stringify(aRunBoth.error) + "\n  expected:" + JSON.stringify(expectedB));
    }
    holdsAre(alice, "alice", false, true, fail, "A played under both holds");
    holdsAre(bob, "bob", true, false, fail, "A played under both holds");
    const bRunBoth = gate.handle("pb315_bob", { op: "run" });
    if (!bRunBoth || bRunBoth.error) fail("(b) B's Play rendered B's own hold down: " + JSON.stringify(bRunBoth));
    if (lastRoom(alice).clock !== "running") fail("(b) the clock is not running after the last holder played");

    // ---- (e) a dropped seat stops claiming the opponent is waiting --------------------------
    gate.handle("pb315_alice", { op: "hold" });
    alice.closed = true;
    alice.onclose();
    if (lastRoom(bob).clock !== "held") fail("(e) a dropped seat left the clock running");
    const afterDrop = lastRoom(bob);
    if (String(afterDrop.note || "").indexOf("disconnected") < 0) {
      fail("(e) the present seat is given no sentence about the drop: " + JSON.stringify(afterDrop.note));
    }
    holdsAre(bob, "bob", false, false, fail, "A dropped");
    const bobRunDrop = gate.handle("pb315_bob", { op: "run" });
    if (!bobRunDrop || bobRunDrop.error) {
      fail("(e) the present seat is stuck behind an absent seat: " + JSON.stringify(bobRunDrop));
    }

    // ---- (d) a bot room is unchanged: one Play resumes, and the block says nobody holds ------
    const solo = fakePeer();
    gate.join("pb315_solo", solo);
    const botRoom = gate.handle("pb315_solo", { op: "bot", era: "1986", side: "blue" });
    if (!botRoom || botRoom.error) fail("the bot room failed: " + JSON.stringify(botRoom));
    holdsAre(solo, "the bot room", false, false, fail, "bot room opened");
    const h = gate.handle("pb315_solo", { op: "hold" });
    const r = gate.handle("pb315_solo", { op: "run" });
    if (!h || h.error) fail("(d) human+bot hold was refused: " + JSON.stringify(h));
    if (!r || r.error) fail("(d) human+bot run was refused: " + JSON.stringify(r));
    if (lastRoom(solo).clock !== "running") fail("(d) human+bot clock is not running after hold+run");
    holdsAre(solo, "the bot room", false, false, fail, "bot room running");

    // ---- a sender with no seat reads no hold block at all -----------------------------------
    const stranger = fakePeer();
    gate.join("pb315_stranger", stranger);
    const foreign = gate.handle("pb315_stranger", { op: "run" });
    if (!foreign || !foreign.error) fail("a sender with no seat moved the clock: " + JSON.stringify(foreign));
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}
