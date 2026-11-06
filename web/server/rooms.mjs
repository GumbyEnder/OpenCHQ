// Durable rooms. A room is a row: id, mode, era, clock, seats and the match blob.
// The process is a cache in front of this table, never the owner of a game.
//
// Writes are one upsert per state change. The probe in tools/bench-rooms.mjs measured a
// 1000-room snapshot at ~1.6 ms in one transaction and ~3.2 ms one-by-one, against a 140 ms
// round budget, so per-change writes are affordable at the target scale.

import { db } from "./db.mjs";

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    era TEXT NOT NULL,
    clock TEXT NOT NULL,
    note TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rooms_saved_at ON rooms (saved_at);
`);

const IDLE_HOURS = 24;

const upsertStmt = db.prepare(`
  INSERT INTO rooms (id, mode, era, clock, note, state, created_at, saved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    mode = excluded.mode,
    era = excluded.era,
    clock = excluded.clock,
    note = excluded.note,
    state = excluded.state,
    saved_at = excluded.saved_at
`);

function nowIso() {
  return new Date().toISOString();
}

// The row keeps the seats and anything the match will need. It is JSON so the match shape
// can grow without a migration per node.
export function saveRoom(room) {
  const state = JSON.stringify({ seats: room.seats ?? {}, match: room.match ?? null });
  const existing = db.prepare("SELECT created_at FROM rooms WHERE id = ?").get(room.id);
  const created = existing ? existing.created_at : nowIso();
  upsertStmt.run(
    room.id,
    String(room.mode ?? "bot"),
    String(room.era ?? "1986"),
    String(room.clock ?? "held"),
    String(room.note ?? ""),
    state,
    created,
    nowIso()
  );
  return true;
}

export function deleteRoom(id) {
  db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
}

export function roomCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n;
}

// A room always comes back paused. Nothing may keep a clock running across a restart: the
// server owns the clock, and a fresh process must not resume rounds nobody asked for.
export function loadRooms() {
  const rows = db.prepare("SELECT * FROM rooms ORDER BY saved_at").all();
  return rows.map((row) => {
    let state = {};
    try {
      state = JSON.parse(row.state) || {};
    } catch {
      state = {};
    }
    return {
      id: row.id,
      mode: row.mode,
      era: row.era,
      clock: "held",
      note: String(row.note || ""),
      seats: state.seats ?? {},
      match: state.match ?? null,
      savedAt: row.saved_at,
    };
  });
}

// Games nobody has touched in a day are not worth the row.
export function pruneRooms(hours = IDLE_HOURS) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const done = db.prepare("DELETE FROM rooms WHERE saved_at < ?").run(cutoff);
  return Number(done.changes || 0);
}
