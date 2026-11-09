#!/usr/bin/env node
// Capacity probe for the OpenCHQ room model (node `load_test`).
//
// This measures the real thing: rooms opened by match.mjs, advanced by tick.mjs and stored
// by rooms.mjs saveRoom into a throwaway SQLite file. No stand-in tick, no stand-in store,
// no room with its routes quietly drained to make the number small.
//
//   node tools/bench-rooms.mjs [rooms] [piecesPerRoom]
//
// A round is what main.mjs does every beat: tick every running room, then let the store take
// its slice of the dirty rooms (rooms.flushRooms, one second of rounds). The probe reports
// that round, the tick on its own, the one-off cost of snapshotting every room at once (the
// pause/shutdown path, which no round pays for), and that a held room costs nothing.
//
// It exits 1 if the bar is missed: 10x headroom on the tick pass and on the round's store
// work, a held room that does not tick or write, and every dirty room durable inside the
// flush window. The round budget is the loop's 0.14 s, stricter than the configured 5 s.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOMS = Number(process.argv[2] || 1000);
const PIECES = Number(process.argv[3] || 8);
const ROUND_SECONDS = 0.14; // the loop's round budget
const BUDGET_MS = ROUND_SECONDS * 1000;
const FLOOR = Number(process.env.OPENCHQ_LOAD_HEADROOM) > 0
  ? Number(process.env.OPENCHQ_LOAD_HEADROOM)
  : 10; // headroom multiple the node must clear; a slow host may lower it deliberately

if (!Number.isInteger(ROOMS) || ROOMS < 1 || !Number.isInteger(PIECES) || PIECES < 2) {
  console.error("usage: node tools/bench-rooms.mjs [rooms>=1] [pieces>=2]");
  process.exit(2);
}

// The store is a throwaway directory, never ~/.local/share/openchq and never the repo tree.
const dir = mkdtempSync(path.join(tmpdir(), "openchq-bench-"));
process.env.OPENCHQ_WEB_DATA = dir;

const { boardPayload } = await import("../web/server/board.mjs");
const { openMatch } = await import("../web/server/match.mjs");
const { tickMatch } = await import("../web/server/tick.mjs");
const { flushRooms, flushWindow, loadRooms, saveRoom } = await import("../web/server/rooms.mjs");
const { db } = await import("../web/server/db.mjs");

// The server's durability window for a 0.14 s round.
const WINDOW = flushWindow(ROUND_SECONDS);

// A single pass on a shared NAS host measures the machine's mood as much as the code: the same
// tick read 9.6x and 11.3x headroom within an hour. Take the median of several passes so a
// build or a browser in another shell does not turn a passing bench red.
function once(fn, iterations) {
  fn(0); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
}

function timePass(fn, iterations, passes = 5) {
  const samples = [];
  for (let p = 0; p < passes; p++) samples.push(once(fn, iterations));
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// The board's own sites, so site scans (income, fuel, capitals) cost what they cost in a
// real room. With no extract only the two capitals exist; the count is printed either way.
let sites = [];
let siteSource = "capitals-only";
try {
  const payload = boardPayload();
  if (Array.isArray(payload.sites) && payload.sites.length) {
    sites = payload.sites;
    siteSource = payload.source || "extract";
  }
} catch {
  sites = [];
}
if (!sites.length) {
  sites = [
    { id: "cap-blue", name: "Washington", x: 79, y: 44, kind: "capital" },
    { id: "cap-red", name: "Moscow", x: 183, y: 25, kind: "capital" },
  ];
}

// Route steps in the room. A real order walks a route of dozens to hundreds of cells, and
// those steps are part of the stored state; a handful of steps would be the fake number.
const ROUTE_STEPS = 60;

function lane(x, y) {
  return Array.from({ length: ROUTE_STEPS }, (_, step) => ({ x: (x + step + 1) % 320, y, pace: 1 }));
}

// Extra pieces are the same shape economy.buy produces, on their own lane so they do not
// block each other and the routes survive many passes.
function addPiece(match, room, k) {
  const side = k % 2 ? "red" : "blue";
  const y = 60 + k * 5;
  const x = (room * 13 + k * 17) % 320;
  match.pieces.push({
    id: `${side}:bench:${k}`,
    side,
    domain: "land",
    kind: "infantry",
    x,
    y,
    path: lane(x, y),
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
  });
}

function makeRoom(i) {
  const match = openMatch("1986", sites);
  match.clock = "running";
  for (const piece of match.pieces) {
    if (piece.domain === "land") piece.path = lane(piece.x, piece.y);
  }
  for (let k = 0; match.pieces.length < PIECES; k++) addPiece(match, i, k);
  return { id: `bench-${i}`, mode: "bot", era: "1986", clock: "running", note: "", seats: {}, match };
}

const rooms = Array.from({ length: ROOMS }, (_, i) => makeRoom(i));

// ---- a tick pass: one round of movement for every running room --------------------------
const tickMs = timePass(() => {
  for (const room of rooms) tickMatch(room.match);
}, 6);
const tickHeadroom = BUDGET_MS / tickMs;

// ---- a full round: the tick, then the store's slice of the dirty rooms ------------------
let cursor = 0;
const roundMs = timePass(() => {
  for (const room of rooms) {
    tickMatch(room.match);
    room.dirty = true;
  }
  cursor = flushRooms(rooms, cursor, WINDOW).cursor;
}, 20);
const roundHeadroom = BUDGET_MS / roundMs;

// ---- the one-off: every room written in one transaction (pause / shutdown path) ---------
function batchSnapshot() {
  db.exec("BEGIN");
  for (const room of rooms) {
    saveRoom(room);
    room.dirty = false;
  }
  db.exec("COMMIT");
}
const batchMs = timePass(batchSnapshot, 5);
const batchHeadroom = BUDGET_MS / batchMs;

// ---- held rooms cost nothing: no tick, no write ----------------------------------------
for (const room of rooms) {
  room.clock = "held";
  room.match.clock = "held";
  saveRoom(room);
  room.dirty = false;
}
const writes = { n: 0 };
const snapshotRows = () => db.prepare("SELECT id, clock, state, saved_at FROM rooms ORDER BY id").all();
const beforeRows = JSON.stringify(snapshotRows());
const roundsBefore = rooms.map((room) => room.match.round).join(",");
cursor = 0;

// The server's per-round pass: a held or finished room is skipped before any work.
const heldMs = timePass(() => {
  for (const room of rooms) {
    if (!room.match || room.match.over || room.clock !== "running") continue;
    tickMatch(room.match);
    room.dirty = true;
    writes.n += 1;
  }
  cursor = flushRooms(rooms, cursor, WINDOW).cursor;
}, 20);
const heldChanged = JSON.stringify(snapshotRows()) === beforeRows ? 0 : 1;
const heldRoundsMoved = rooms.map((room) => room.match.round).join(",") === roundsBefore ? 0 : 1;

// ---- durability: every dirty room is written inside the flush window --------------------
for (const room of rooms) {
  room.clock = "running";
  room.match.clock = "running";
  room.dirty = true;
}
cursor = 0;
const written = new Set();
for (let round = 0; round < WINDOW; round++) {
  for (const room of rooms) {
    tickMatch(room.match);
    room.dirty = true;
  }
  const result = flushRooms(rooms, cursor, WINDOW);
  cursor = result.cursor;
  for (const room of rooms) if (!room.dirty) written.add(room.id);
}
const durable = written.size;

// ---- round trip: the row must give back the same routes and the same owners ------------
const probe = makeRoom(0);
probe.id = "roundtrip";
probe.clock = "held";
probe.match.clock = "held";
probe.match.sites[0].owner = "blue";
probe.match.sites[1].unready = true;
saveRoom(probe);
const restored = loadRooms().find((room) => room.id === "roundtrip");
const restoredMatch = restored && restored.match;
const samePath = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  a.every((step, i) => step.x === b[i].x && step.y === b[i].y && step.pace === b[i].pace);
const roundTrip =
  !!restoredMatch &&
  restored.clock === "held" &&
  restoredMatch.clock === "held" &&
  restoredMatch.pieces.length === probe.match.pieces.length &&
  probe.match.pieces.every((piece, i) => samePath(piece.path, restoredMatch.pieces[i].path)) &&
  restoredMatch.sites.length === probe.match.sites.length &&
  restoredMatch.sites[0].owner === "blue" &&
  restoredMatch.sites[1].unready === true;
const roundTripSteps = restoredMatch
  ? restoredMatch.pieces.reduce((sum, piece) => sum + piece.path.length, 0)
  : 0;

const report = {
  rooms: ROOMS,
  pieces: PIECES,
  sites: sites.length,
  siteSource,
  routeSteps: ROUTE_STEPS,
  budgetMs: Number(BUDGET_MS.toFixed(0)),
  flushRounds: WINDOW,
  tickMs: Number(tickMs.toFixed(3)),
  tickHeadroom: Number(tickHeadroom.toFixed(1)),
  roundMs: Number(roundMs.toFixed(3)),
  roundHeadroom: Number(roundHeadroom.toFixed(1)),
  fullSnapshotMs: Number(batchMs.toFixed(3)),
  fullSnapshotHeadroom: Number(batchHeadroom.toFixed(1)),
  heldMs: Number(heldMs.toFixed(3)),
  heldWrites: writes.n,
  heldChanged,
  heldRoundsMoved,
  durable,
  roundTrip,
  roundTripSteps,
};

console.log(`rooms ${ROOMS} x ${PIECES} pieces, ${sites.length} sites (${siteSource}), routes ${ROUTE_STEPS} steps`);
console.log(`tick pass: ${report.tickMs} ms per round -> ${report.tickHeadroom}x headroom`);
console.log(`round pass (tick + store slice 1/${WINDOW}): ${report.roundMs} ms -> ${report.roundHeadroom}x headroom`);
console.log(`full snapshot, all rooms in one transaction (pause path, not a round): ${report.fullSnapshotMs} ms -> ${report.fullSnapshotHeadroom}x`);
console.log(`held pass: ${report.heldMs} ms, ${report.heldWrites} writes, ${report.heldChanged} rows changed, ${report.heldRoundsMoved} rounds moved`);
console.log(`durable: ${report.durable}/${ROOMS} rooms written within ${WINDOW} rounds`);
console.log(`round trip: ${roundTrip ? "ok" : "BROKEN"}, ${roundTripSteps} route steps restored`);
console.log(`BENCH_JSON ${JSON.stringify(report)}`);

const ok =
  tickHeadroom > FLOOR &&
  roundHeadroom > FLOOR &&
  writes.n === 0 &&
  heldChanged === 0 &&
  report.heldRoundsMoved === 0 &&
  durable === ROOMS &&
  roundTrip;

db.close();
rmSync(dir, { recursive: true, force: true });

if (!ok) {
  console.error(`BENCH_FAILED: need >${FLOOR}x on the tick and the round, a held room that does nothing, and every room durable`);
  process.exit(1);
}
