// Match history (T-031, step 1): the schema, the recorder and the end digest.
//
// The original's War Films (manual p.35, p.38) are a recording of a match, not a new game: every
// round's events, the state at the start, the state at the end, and a hash that proves a replay ends
// where the match did. This module is the server half only - the endpoints and the replay view are
// steps 2 and 3. Nothing here is read by a live page, so a bug in it cannot change a match.
//
// Storage lives in the SAME WAL database the rooms already use (`db.mjs`), because `/data` is one
// volume with one budget:
//   - `matches`      one row per match: seats, era, mode, start/final state, final digest, bytes;
//   - `match_rounds` one row per tick: the round, the events verbatim, strengths and owners.
// Every blob is gzip(JSON). `canonicalJson` sorts object keys at every level so the digest of a
// replay frame does not depend on insertion order.
//
// /data CAP (frodo's five conditions, room 7697). `historyUsage()` counts REAL FILE BYTES - the
// sqlite file, its -wal and its -shm - and NOT the Railway dashboard's `currentSizeMB`, which is
// platform allocation: a reviewer comparing our counter against that number will otherwise call a
// working prune broken. The film blobs are INSIDE the sqlite file, so they are counted once, through
// the file; `stored_bytes` is kept per match for reporting and for pruning decisions, not added to
// the total. The cap is `OPENCHQ_HISTORY_CAP_GB` (default 20), never a constant: lowering it is a
// variable change, not a deploy.
//
// Pruning (step 2, called by the tick) deletes only FINISHED matches, oldest-first by `ended_at`,
// in bounded batches outside a long write transaction, then checkpoints the wal. A live match is
// never a prune candidate and neither is a user or session row.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { db as sharedDb, dataRoot } from "./db.mjs";

const SCHEMA = 1;
const DEFAULT_CAP_GB = 20;

export function ensureHistorySchema(handle = sharedDb) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, era TEXT, mode TEXT,
      blue_user TEXT, red_user TEXT,
      started_at TEXT, ended_at TEXT, winner TEXT,
      rounds INTEGER, schema INTEGER DEFAULT ${SCHEMA},
      start_state BLOB, final_state BLOB, final_digest TEXT, stored_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS match_rounds (
      match_id TEXT, round INTEGER, payload BLOB,
      PRIMARY KEY (match_id, round)
    );
    CREATE INDEX IF NOT EXISTS matches_blue ON matches(blue_user, ended_at);
    CREATE INDEX IF NOT EXISTS matches_red ON matches(red_user, ended_at);
  `);
  return SCHEMA;
}

// Stable JSON: object keys sorted at every depth, arrays in order. The digest of a frame and of a
// state must not depend on how a caller happened to build the object.
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function digestOf(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// What a film starts from: everything a replay needs to paint round 0 without the live room.
export function packMatch(match) {
  if (!match || typeof match !== "object") return null;
  return {
    era: match.era ?? null,
    mode: match.mode ?? null,
    sites: match.sites || [],
    pieces: match.pieces || [],
    capitals: match.capitals || {},
    capitalList: match.capitalList || null,
    satellites: match.satellites || [],
    sides: {
      blue: match.sides && match.sides.blue ? { cash: match.sides.blue.cash ?? null } : null,
      red: match.sides && match.sides.red ? { cash: match.sides.red.cash ?? null } : null,
    },
    round: match.round ?? 0,
    clock: match.clock ?? null,
    seed: match.seed ?? null,
  };
}

function gz(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"));
}

function ungz(blob) {
  if (!blob) return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(blob)).toString("utf8"));
  } catch {
    return null;
  }
}

export function startFilm(room, handle = sharedDb, now = new Date()) {
  if (!room || !room.id || !room.match) return null;
  ensureHistorySchema(handle);
  const match = room.match;
  const blue = room.seats && room.seats.blue ? String(room.seats.blue.username || "") : "";
  const red = room.seats && room.seats.red ? String(room.seats.red.username || "") : "";
  const start = packMatch(match);
  const blob = gz(start);
  handle
    .prepare(
      `INSERT INTO matches (id, era, mode, blue_user, red_user, started_at, ended_at, winner, rounds,
        schema, start_state, final_state, final_digest, stored_bytes)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET era=excluded.era, blue_user=excluded.blue_user,
         red_user=excluded.red_user, start_state=excluded.start_state, stored_bytes=excluded.stored_bytes`,
    )
    .run(String(room.id), String(match.era ?? ""), String(match.mode ?? "bot"), blue, red,
      now.toISOString(), SCHEMA, blob, blob.length);
  match.filmStartedAt = now.toISOString();
  return { id: String(room.id), bytes: blob.length };
}

// The per-round frame. `events` are the tick's own objects, verbatim: AC2 wants a replay line to be
// the SAME events the live Log derived from, not a re-description of them.
export function appendFrame(room, events, handle = sharedDb) {
  if (!room || !room.id || !room.match) return null;
  const match = room.match;
  const strengths = {};
  for (const piece of Array.isArray(match.pieces) ? match.pieces : []) {
    if (piece && piece.id !== undefined) strengths[String(piece.id)] = piece.strength ?? null;
  }
  const owners = [];
  for (const site of Array.isArray(match.sites) ? match.sites : []) {
    if (site && site.id !== undefined) owners.push([site.id, site.owner ?? null]);
  }
  const frame = {
    round: match.round,
    clock: match.clock ?? null,
    events: Array.isArray(events) ? events : [],
    strengths,
    owners,
  };
  const blob = gz(frame);
  handle
    .prepare("INSERT OR REPLACE INTO match_rounds (match_id, round, payload) VALUES (?, ?, ?)")
    .run(String(room.id), Number(match.round) || 0, blob);
  return { round: frame.round, bytes: blob.length };
}

// The end of the film: the final state, its digest, and the round count. Called when `match.over`
// first becomes true, and idempotent - a second call cannot overwrite the digest with a later state.
export function finishFilm(room, handle = sharedDb, now = new Date()) {
  if (!room || !room.id || !room.match) return null;
  ensureHistorySchema(handle);
  const match = room.match;
  const existing = handle.prepare("SELECT final_digest FROM matches WHERE id = ?").get(String(room.id));
  if (existing && existing.final_digest) return { id: String(room.id), digest: existing.final_digest, already: true };
  const final = packMatch(match);
  final.over = match.over === true;
  final.winner = match.winner ?? null;
  final.winReason = match.winReason ?? null;
  const blob = gz(final);
  const digest = digestOf(final);
  const frames = handle.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM match_rounds WHERE match_id = ?").get(String(room.id));
  const bytes = Number(frames && frames.bytes ? frames.bytes : 0) + blob.length;
  handle
    .prepare(
      `UPDATE matches SET ended_at = ?, winner = ?, rounds = ?, final_state = ?, final_digest = ?,
        stored_bytes = ? WHERE id = ?`,
    )
    .run(now.toISOString(), String(match.winner ?? ""), Number(match.round) || 0, blob, digest, bytes, String(room.id));
  return { id: String(room.id), digest, bytes, rounds: Number(match.round) || 0 };
}

export function filmMeta(roomId, handle = sharedDb) {
  const row = handle
    .prepare(
      `SELECT id, era, mode, blue_user, red_user, started_at, ended_at, winner, rounds, schema,
              final_digest, stored_bytes, LENGTH(start_state) AS start_bytes
       FROM matches WHERE id = ?`,
    )
    .get(String(roomId));
  if (!row) return null;
  return {
    ...row,
    start: ungz(handle.prepare("SELECT start_state AS blob FROM matches WHERE id = ?").get(String(roomId)).blob),
  };
}

export function framesOf(roomId, handle = sharedDb, from = 0, to = Number.POSITIVE_INFINITY) {
  const rows = handle
    .prepare("SELECT round, payload FROM match_rounds WHERE match_id = ? AND round >= ? AND round <= ? ORDER BY round")
    .all(String(roomId), Number(from) || 0, Number.isFinite(to) ? Number(to) : 2147483647);
  return rows.map((row) => ({ round: row.round, frame: ungz(row.payload) }));
}

// Real file bytes: the sqlite file and its wal/shm beside it. NOT the platform's allocation number.
export function historyUsage(handle = sharedDb, rootDir = dataRoot) {
  let fileBytes = 0;
  const files = [];
  for (const name of ["openchq.sqlite", "openchq.sqlite-wal", "openchq.sqlite-shm"]) {
    const file = path.join(rootDir, name);
    try {
      const size = statSync(file).size;
      fileBytes += size;
      files.push({ name, bytes: size });
    } catch {
      // A missing wal is normal on a quiet database: 0 bytes, not an error.
    }
  }
  const films = handle
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(stored_bytes), 0) AS bytes, COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS done FROM matches")
    .get();
  return {
    files,
    fileBytes,
    filmBytes: Number(films && films.bytes ? films.bytes : 0),
    matches: Number(films && films.n ? films.n : 0),
    finished: Number(films && films.done ? films.done : 0),
    capBytes: historyCapBytes(),
    // The blobs live INSIDE the sqlite file, so the budget is the file total, not file + blobs.
    totalBytes: fileBytes,
  };
}

export function historyCapBytes(env = process.env) {
  const gb = Number(env.OPENCHQ_HISTORY_CAP_GB);
  const value = Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_CAP_GB;
  return Math.round(value * 1_000_000_000);
}

// Pruning is deliberately NOT in this commit. A DELETE does not shrink the sqlite file - the pages
// are reused - so a prune that "frees bytes" by file size will not show it until a VACUUM, and a
// VACUUM under the single-writer lock is exactly the stall frodo's condition 3 forbids inside a
// request. The cap needs a measured decision (file bytes vs stored_bytes, and when to vacuum), so
// step 2 brings the prune with the numbers that justify it. What exists here is the accounting the
// decision needs: `historyUsage()` counts the real files, and `historyCapBytes()` reads the env.
