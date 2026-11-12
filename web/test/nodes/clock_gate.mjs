// clock_gate — the REAL per-room speed gate (T-004, AC6), not a re-implementation.
//
// What breaks if this is removed: `lobby.tickRooms(now)` is the only thing that decides whether a
// running room advances. speeds.mjs re-implements that decision with speedDue + tickMatch, which
// proves the rule but not the wiring. This node drives the live gate at the server's 50 ms beat:
//   - speed 0 accepts orders and never advances the round, whatever the elapsed time;
//   - speed 6 (0.6 s a round) runs more rounds than speed 1 (5 s a round) over the same beats.
//
// The lobby writes rooms to SQLite, so this node points OPENCHQ_WEB_DATA at a throwaway directory
// BEFORE importing lobby.mjs: a test must never read or write the operator's real room store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "clock_gate";

const BEAT_MS = 50;
const BEATS = 140; // 7 s of wall clock: enough for speed 1 (5 s) to be due once.

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

function roundsIn(box) {
  const rounds = box
    .filter((message) => message && message.op === "room" && message.room && Number.isFinite(Number(message.room.round)))
    .map((message) => Number(message.room.round));
  return rounds.length ? Math.max(...rounds) : null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-clock-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  let lobby;
  try {
    // Dynamic import so db.mjs sees the isolated data directory, not the operator's store.
    ({ createLobby: lobby } = await import("../../server/lobby.mjs"));
    const create = typeof lobby === "function" ? lobby : null;
    if (!create) fail("lobby.mjs exports no createLobby");
    const gate = create();

    const users = { 0: "clock_zero", 1: "clock_one", 6: "clock_six" };
    const peers = {};
    for (const [speed, user] of Object.entries(users)) {
      const peer = fakePeer();
      peers[speed] = peer;
      gate.join(user, peer);
      const room = gate.handle(user, { op: "bot", era: "1986", side: "blue" });
      if (!room || room.error) fail("could not open a bot room for " + user + ": " + JSON.stringify(room));
      // Full frames every tick: the gate's tick count is read from the round in the room view.
      gate.handle(user, { op: "fullframes", on: true });
      const runResult = gate.handle(user, { op: "run" });
      if (!runResult || runResult.error) fail("could not start the clock for " + user + ": " + JSON.stringify(runResult));
      const speedResult = gate.handle(user, { op: "speed", speed: Number(speed) });
      if (!speedResult || speedResult.error) fail("could not set speed " + speed + ": " + JSON.stringify(speedResult));
    }

    const start = Date.now() + 100;
    for (let beat = 0; beat <= BEATS; beat++) gate.tickRooms(start + beat * BEAT_MS);

    const scores = {};
    for (const [speed, user] of Object.entries(users)) {
      const box = peers[speed].box;
      const frames = box.filter((message) => message && message.op === "room" && message.room);
      if (!frames.length) fail("speed " + speed + " received no room frame at all");
      const first = Number(frames[0].room.round);
      const latest = frames[frames.length - 1].room;
      const last = Number(latest.round);
      const room = latest;
      if (room.clock !== "running") fail("speed " + speed + " room is not running: " + room.clock);
      if (Number(room.speed) !== Number(speed)) fail("room reports speed " + room.speed + ", not " + speed);
      const seen = roundsIn(box);
      if (seen === null) fail("speed " + speed + " sent no round number");
      scores[speed] = { first, last, ticks: last - first, seen };
      if (scores[speed].ticks < 0) fail("speed " + speed + " round went backwards");
    }

    if (scores[0].ticks !== 0) {
      fail("speed 0 advanced " + scores[0].ticks + " round(s) over " + (BEATS * BEAT_MS) + " ms; game time must not pass");
    }
    if (scores[1].ticks < 1) {
      fail("speed 1 advanced " + scores[1].ticks + " rounds over " + (BEATS * BEAT_MS) + " ms; a 5 s round should be due");
    }
    if (!(scores[6].ticks > scores[1].ticks)) {
      fail("speed 6 (" + scores[6].ticks + " rounds) did not outrun speed 1 (" + scores[1].ticks + ")");
    }

    console.log(
      "clock gate: " + BEATS + " beats of " + BEAT_MS + " ms, speed 0 = " + scores[0].ticks +
      " rounds, speed 1 = " + scores[1].ticks + " rounds, speed 6 = " + scores[6].ticks + " rounds"
    );
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a test failure */ }
  }
}
