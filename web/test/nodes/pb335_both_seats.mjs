// pb335_both_seats — a resignation puts the end-of-war line on BOTH seats' logs, not only the
// resigning seat's.
//
// PB-199 (b) made resignOp push one {round,text} line and loop over both sides. The node leg that
// landed with it (pb199_endgame.mjs) resigns from a bot match, so it can only read the resigning
// seat's own log: the other seat is a bot with no socket and no readable store. The both-seats push
// was therefore asserted by reading resignOp's loop, not by an arm - a loop that quietly keeps one
// side would leave every leg green (frodo 10397 nit (a), card 10399).
//
// This file owns that arm, in two rooms so it cannot pass by favouring one side:
//   room 1  alice (blue) resigns -> "Blue resigned. Red wins."
//   room 2  bob (red) resigns    -> "Red resigned. Blue wins."
// and, for each resignation, on BOTH seats:
//   (a) the live delivery: exactly one `op:"log"` push carrying the end line;
//   (b) the stored seat log (read back through `op:"sync"`): exactly one end line, at the round
//       the room reports.
//
// The defect this names: an end line delivered to the resigning seat only. A mutant that pushes
// and stores to `mine` alone turns (a) and (b) red on the "other seat" arm in both rooms, and a
// mutant hardcoded to one side is caught by the room where that side is the observer.
//
// The lobby writes rooms to SQLite, so OPENCHQ_WEB_DATA points at a throwaway directory BEFORE
// lobby.mjs is imported: a test must never read or write the operator's real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb335_both_seats";

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

// Every line the seat's socket was handed as a live push, in arrival order.
function pushedLines(peer, from) {
  return peer.box
    .slice(from)
    .filter((m) => m && m.op === "log")
    .flatMap((m) => (Array.isArray(m.lines) ? m.lines : []));
}

// The seat's own stored log, as the room frame carries it after a sync.
function endRows(room, text) {
  const rows = room && Array.isArray(room.log) ? room.log : [];
  return rows.filter((row) => String(row && row.text || "") === text);
}

async function openRoom(gate, fail, inviter, invitee, peers, era, side) {
  const inv = gate.handle(inviter, { op: "invite", user: invitee, era, side });
  if (!inv || inv.error) fail("the invite from " + inviter + " failed: " + JSON.stringify(inv));
  const invite = peers[invitee].box.filter((m) => m && m.op === "invite").pop();
  if (!invite) fail(invitee + " never received the invite frame");
  const acc = gate.handle(invitee, { op: "answer", id: invite.invite.id, accept: true });
  if (!acc || acc.error) fail("the accept by " + invitee + " failed: " + JSON.stringify(acc));
  const opening = lastRoom(peers[inviter]);
  if (!opening) fail(inviter + " got no room frame after the accept");
  if (!(opening.blue && opening.blue.kind === "human") || !(opening.red && opening.red.kind === "human")) {
    fail("the room is not two-human: " + JSON.stringify({ blue: opening.blue, red: opening.red }));
  }
  return opening;
}

// One resignation, graded on both seats: the live push and the stored log.
function gradeResignation(gate, fail, room, resigner, observer, peers, text, label) {
  const seat = {};
  seat[resigner] = peers[resigner];
  seat[observer] = peers[observer];
  const before = { resigner: seat[resigner].box.length, observer: seat[observer].box.length };

  const res = gate.handle(resigner, { op: "resign" });
  if (!res || res.error) fail(label + " the resignation failed: " + JSON.stringify(res));

  // (a) the live delivery: exactly one end line on each socket.
  const onResigner = pushedLines(seat[resigner], before.resigner).filter((l) => String(l && l.text || "") === text);
  if (onResigner.length !== 1) {
    fail(label + " (PB-335 a) the resigning seat's live log got " + onResigner.length +
      " end lines, expected 1: " + JSON.stringify(pushedLines(seat[resigner], before.resigner).slice(-4)));
  }
  const onObserver = pushedLines(seat[observer], before.observer).filter((l) => String(l && l.text || "") === text);
  if (onObserver.length !== 1) {
    fail(label + " (PB-335 a) the OTHER seat's live log got " + onObserver.length +
      " end lines, expected 1: " + JSON.stringify(pushedLines(seat[observer], before.observer).slice(-4)));
  }

  // (b) the stored seat log, read back through a sync so it comes from room.log[seat].
  gate.handle(resigner, { op: "sync" });
  gate.handle(observer, { op: "sync" });
  const resignerRoom = lastRoom(seat[resigner]);
  const observerRoom = lastRoom(seat[observer]);
  if (!resignerRoom) fail(label + " (PB-335 b) the resigning seat's sync carried no room");
  if (!observerRoom) fail(label + " (PB-335 b) the other seat's sync carried no room");

  const storedOnResigner = endRows(resignerRoom, text);
  if (storedOnResigner.length !== 1) {
    fail(label + " (PB-335 b) the resigning seat's stored log carries " + storedOnResigner.length +
      " end lines, expected 1: " + JSON.stringify((resignerRoom.log || []).slice(-4)));
  }
  const storedOnObserver = endRows(observerRoom, text);
  if (storedOnObserver.length !== 1) {
    fail(label + " (PB-335 b) the OTHER seat's stored log carries " + storedOnObserver.length +
      " end lines, expected 1: " + JSON.stringify((observerRoom.log || []).slice(-4)));
  }

  // Both seats name the same round: the line is one event, not two sentences.
  const round = Number(resignerRoom.round || 0);
  if (Number(storedOnObserver[0].round) !== round) {
    fail(label + " (PB-335 b) the other seat's end line is round " + JSON.stringify(storedOnObserver[0].round) +
      " against the room's round " + round);
  }
  if (resignerRoom.over !== true || observerRoom.over !== true) {
    fail(label + " (PB-335 b) a seat does not read the match as over: " +
      JSON.stringify({ resigner: resignerRoom.over, observer: observerRoom.over }));
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb335-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();

    const alice = fakePeer(); // blue in room 1
    const bob = fakePeer();   // red in room 1
    const peers = { pb335_alice: alice, pb335_bob: bob };
    gate.join("pb335_alice", alice);
    gate.join("pb335_bob", bob);

    // ---- room 1: the blue seat resigns ---------------------------------------------------
    const one = await openRoom(gate, fail, "pb335_alice", "pb335_bob", peers, "1942", "blue");
    gradeResignation(gate, fail, one, "pb335_alice", "pb335_bob", peers,
      "Blue resigned. Red wins.", "room 1 (blue resigns):");

    // ---- room 2: the red seat resigns, so a one-side push cannot hide --------------------
    gate.handle("pb335_alice", { op: "leave" });
    gate.handle("pb335_bob", { op: "leave" });
    const two = await openRoom(gate, fail, "pb335_bob", "pb335_alice", peers, "1942", "red");
    gradeResignation(gate, fail, two, "pb335_bob", "pb335_alice", peers,
      "Red resigned. Blue wins.", "room 2 (red resigns):");
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
