#!/usr/bin/env node
// Capacity probe for the OpenCHQ room model. No game code is imported: this measures the
// shape of the work (per-room tick cost, and the cost of snapshotting rooms to SQLite) at
// the target scale, so the storage decision rests on numbers instead of vibes.
//
//   node tools/bench-rooms.mjs [rooms] [piecesPerRoom]

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOMS = Number(process.argv[2] || 1000);
const PIECES = Number(process.argv[3] || 8);
const ROUND = 0.14; // seconds per running round, per the game rules

// A room as the loop will hold it: a small grid of pieces and a couple of routes.
function makeRoom(i) {
  const pieces = [];
  for (let p = 0; p < PIECES; p++) {
    pieces.push({ id: `${i}-${p}`, side: p % 2 ? "red" : "blue", x: (i * 7 + p * 13) % 320, y: (i + p * 3) % 136, path: [], pace: 1 });
  }
  return { id: `room-${i}`, round: 0, clock: "running", blue: 9, red: 9, fuelBlue: 10000, fuelRed: 10000, pieces, orders: [] };
}

// One tick: advance pieces along their path, roughly the work a real tick does per piece.
function tick(room) {
  room.round += 1;
  for (const piece of room.pieces) {
    if (!piece.path.length) continue;
    const step = piece.path.shift();
    piece.x = step.x;
    piece.y = step.y;
  }
  return room;
}

function timeIt(label, fn, iters = 100) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  console.log(`${label}: ${ms.toFixed(2)} ms per pass`);
  return ms;
}

const rooms = Array.from({ length: ROOMS }, (_, i) => makeRoom(i));

// Give every piece a short route so the tick loop has real work to do.
for (const room of rooms) {
  for (const piece of room.pieces) {
    piece.path = Array.from({ length: 20 }, (_, k) => ({ x: (piece.x + k + 1) % 320, y: piece.y }));
  }
}

const tickMs = timeIt(`tick ${ROOMS} rooms x ${PIECES} pieces`, () => {
  for (const room of rooms) tick(room);
}, 40);

const budgetMs = ROUND * 1000;
console.log(`  budget per round: ${budgetMs.toFixed(0)} ms -> ${(budgetMs / tickMs).toFixed(1)}x headroom with one core`);

// ---- SQLite snapshot cost --------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "openchq-bench-"));
const db = new DatabaseSync(path.join(dir, "bench.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE rooms (id TEXT PRIMARY KEY, round INTEGER, clock TEXT, state TEXT);
`);

const upsert = db.prepare("INSERT INTO rooms (id, round, clock, state) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET round=excluded.round, clock=excluded.clock, state=excluded.state");

function snapshotBatch() {
  db.exec("BEGIN");
  for (const room of rooms) upsert.run(room.id, room.round, room.clock, JSON.stringify(room.pieces));
  db.exec("COMMIT");
}

const batchMs = timeIt(`snapshot ${ROOMS} rooms, ONE transaction`, snapshotBatch, 10);
console.log(`  one transaction per round -> ${(budgetMs / batchMs).toFixed(1)}x headroom`);

function snapshotPerRoom() {
  for (const room of rooms) {
    db.exec("BEGIN");
    upsert.run(room.id, room.round, room.clock, JSON.stringify(room.pieces));
    db.exec("COMMIT");
  }
}

const perRoomMs = timeIt(`snapshot ${ROOMS} rooms, ONE transaction EACH`, snapshotPerRoom, 3);
console.log(`  one transaction per room -> ${(budgetMs / perRoomMs).toFixed(2)}x headroom (${perRoomMs > budgetMs ? "TOO SLOW" : "fits"})`);

const size = db.prepare("SELECT COUNT(*) AS n FROM rooms").get();
console.log(`rows: ${size.n}`);

db.close();
rmSync(dir, { recursive: true, force: true });
