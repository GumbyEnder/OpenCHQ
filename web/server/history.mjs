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
import { statSync, statfsSync } from "node:fs";
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
  // The round a match ended on carries the state its digest is taken over (AC1).
  if (match.over) frame.state = finalStateOf(match);
  // A round can be appended twice: the tick writes it, and the round that ENDS the match is written
  // once more so its frame carries the closing state (AC1). The second write must not erase the first
  // one's events - a film whose last round lost its kills would be a film that lies. So an empty
  // incoming event list keeps the events already stored for that round.
  const round = Number(match.round) || 0;
  if (!frame.events.length) {
    const existing = handle
      .prepare("SELECT payload FROM match_rounds WHERE match_id = ? AND round = ?")
      .get(String(room.id), round);
    const previous = existing ? ungz(existing.payload) : null;
    if (previous && Array.isArray(previous.events) && previous.events.length) frame.events = previous.events;
  }
  const blob = gz(frame);
  handle
    .prepare("INSERT OR REPLACE INTO match_rounds (match_id, round, payload) VALUES (?, ?, ?)")
    .run(String(room.id), round, blob);
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
  const final = finalStateOf(match);
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

// AC1 needs the last REPLAY FRAME to hash to the recorded digest, which means the frame has to carry
// the state the digest is taken over. One function builds it, the last frame stores it, and
// `finishFilm` hashes the same object - so the two cannot drift apart. Earlier rounds carry no state:
// the per-round strengths/owners are enough to animate them, and a full state per round would triple
// the stored bytes for nothing.
export function finalStateOf(match) {
  const state = packMatch(match);
  if (!state) return null;
  state.over = match.over === true;
  state.winner = match.winner ?? null;
  state.winReason = match.winReason ?? null;
  return state;
}

// ---- restore: a match that crossed a deploy keeps its film -----------------------------
//
// `recordFilm` returns early on `!room.film`, and `room.film` lived only in the process. Every deploy
// restarts the process, so a match that spanned one stopped recording at the restart, `finishFilm`
// never ran, `ended_at` stayed null, and `listFor` never showed the war: the player's match had no
// film at all, and asking for it answered the 404 a stranger's film gets (frodo 9117 §5).
//
// The fix is an INITIALISER, not an open: `startFilm` upserts, and its ON CONFLICT rewrites
// `start_state` - so re-opening a film whose round 0 is already stored would replace the paint a
// replay starts from with a mid-match state, which is worse than the gap. So a restored room re-arms
// ONLY when the header row already exists; a room with no film stays unfilmed, exactly as before.
export function filmExists(roomId, handle = sharedDb) {
  const row = handle.prepare("SELECT 1 AS one FROM matches WHERE id = ?").get(String(roomId));
  return Boolean(row && row.one);
}

export function armRestoredFilm(room, handle = sharedDb) {
  if (!room || !room.id || !room.match) return false;
  // A finished match's film is already closed; re-arming it would append a frame to a finished film.
  if (room.match.over) {
    room.film = false;
    return false;
  }
  try {
    if (filmExists(room.id, handle)) {
      // The header row IS the film: set the flag and leave the row untouched. `startFilm` upserts,
      // and its ON CONFLICT rewrites `start_state` - re-opening here would repaint round 0 with a
      // mid-match state, which is worse than the gap.
      room.film = true;
      return true;
    }
    // No row: this room predates the recorder (or its open failed). Open the film at this round
    // rather than leave the war permanently dark - and because `packMatch` carries `match.round`,
    // the stored start state says which round the film begins at instead of claiming round 0.
    room.film = Boolean(startFilm(room, handle));
    return room.film;
  } catch (err) {
    room.film = false;
    console.warn(`[history] film not re-armed for room ${room.id}: ${err && err.message ? err.message : err}`);
    return false;
  }
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

// ---- step 2: what an account may read -------------------------------------------------
// A film opens only for FINISHED matches (room 7683 condition 1) and only for the account that sat in
// it (condition 2). Every reader takes the username, never a user id: the rows store handles, and a
// lookup that trusts a caller-supplied id is a lookup that leaks someone else's war.

export function listFor(username, handle = sharedDb, limit = 50) {
  const name = String(username || "");
  if (!name) return [];
  const rows = handle
    .prepare(
      `SELECT id, era, mode, blue_user, red_user, started_at, ended_at, winner, rounds, schema,
              final_digest, stored_bytes
       FROM matches
       WHERE ended_at IS NOT NULL AND (blue_user = ? OR red_user = ?)
       ORDER BY ended_at DESC, id DESC LIMIT ?`,
    )
    .all(name, name, Math.max(1, Math.min(200, Number(limit) || 50)));
  return rows.map((row) => ({ ...row, stored_bytes: Number(row.stored_bytes || 0) }));
}

// One film's header and start state, or null. A live match is not a film, and somebody else's film is
// not found - the two answers are the same on purpose.
export function filmFor(username, roomId, handle = sharedDb) {
  const name = String(username || "");
  if (!name) return null;
  const row = handle
    .prepare(
      `SELECT id, era, mode, blue_user, red_user, started_at, ended_at, winner, rounds, schema,
              final_digest, stored_bytes, start_state
       FROM matches
       WHERE id = ? AND ended_at IS NOT NULL AND (blue_user = ? OR red_user = ?)`,
    )
    .get(String(roomId), name, name);
  if (!row) return null;
  const { start_state: blob, ...meta } = row;
  return { ...meta, stored_bytes: Number(meta.stored_bytes || 0), start: ungz(blob) };
}

// A page asks for a window, never "everything": 400-round matches exist, and a client that pulls all
// of one in a single answer is a client that stalls on a phone. 200 frames per call, clamped.
export function framesFor(username, roomId, handle = sharedDb, from = 0, to = Number.POSITIVE_INFINITY) {
  if (!filmFor(username, roomId, handle)) return null;
  const lo = Math.max(0, Number(from) || 0);
  const hi = Number.isFinite(to) ? Math.max(lo, Number(to)) : lo + 199;
  const capped = Math.min(hi, lo + 199);
  return framesOf(roomId, handle, lo, capped);
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

// ---- step 3: the prune, the abandoned class, and the vacuum ------------------------------
//
// Frodo's ruling (room 9117 §6, PM 9124) chose option (a): prune by `stored_bytes` against the
// cap, oldest finished first, never a live match. A DELETE does not shrink the sqlite file (the pages
// are reused), so the file total only moves after a vacuum - which is why this module ALSO owns the
// auto_vacuum pragma and an interval `incremental_vacuum`, and why nothing here asserts that the file
// shrank. It asserts `stored_bytes` and freelist pages, the two numbers that actually move.
//
// Three classes, and only three:
//   1. FINISHED - `ended_at IS NOT NULL`, oldest-first, only when the real file total is over the cap.
//      The newest 100 finished films per account are never pruned (T-031 §2): a player's recent wars
//      are the point of the feature.
//   2. ABANDONED - `ended_at IS NULL`, the room row is GONE, and `started_at < now - X`, X =
//      `OPENCHQ_HISTORY_ABANDONED_HOURS` (default 24, the same idle window `pruneRooms()` uses). This
//      is the class that grows without bound: a room deleted at idle can no longer finish its film,
//      so nothing else will ever close it. It is not live (its room is gone) and it is not finished,
//      so under a finished-only rule it would sit there forever.
//   3. Nothing else. A live match (room row present) is never touched, and neither is a user or
//      session row: this module's DELETE statements name `matches` and `match_rounds` only.
//
// The pass is BOUNDED (default 50 headers per pass) and runs off the tick, on a timer: a delete of
// 500 films inside the beat is the stall condition 3 forbids, just moved from the request to the
// beat. The wal is checkpointed after a pass that deleted anything.

const PRUNE_TRIGGER = 0.8; // the alarm line: 80% of the cap (condition 4)
const ABANDONED_HOURS_DEFAULT = 24;
const PRUNE_BATCH_DEFAULT = 50;
const VACUUM_PAGES_DEFAULT = 256;
const FREE_SPACE_FLOOR = 1_000_000_000; // a vacuum with under 1 GB free is not a maintenance pass

export function historyAbandonedHours(env = process.env) {
  const hours = Number(env.OPENCHQ_HISTORY_ABANDONED_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : ABANDONED_HOURS_DEFAULT;
}

export function historyPruneBatch(env = process.env) {
  const batch = Number(env.OPENCHQ_HISTORY_PRUNE_BATCH);
  return Number.isFinite(batch) && batch > 0 ? Math.min(500, Math.floor(batch)) : PRUNE_BATCH_DEFAULT;
}

function integerOf(row, key) {
  if (!row) return 0;
  const value = row[key] !== undefined ? row[key] : Object.values(row)[0];
  return Number(value) || 0;
}

// The pragma, read as a number. 2 = INCREMENTAL, 0 = NONE, 1 = FULL.
export function autoVacuumMode(handle = sharedDb) {
  try {
    return integerOf(handle.prepare("PRAGMA auto_vacuum").get(), "auto_vacuum");
  } catch {
    return -1;
  }
}

function freelistPages(handle) {
  try {
    return integerOf(handle.prepare("PRAGMA freelist_count").get(), "freelist_count");
  } catch {
    return 0;
  }
}

// The boot flip. `auto_vacuum` cannot be turned on for an existing file without one full VACUUM, so
// this runs BEFORE the server listens (main.mjs): a full VACUUM inside a request is the stall.
// Returns { before, mode, changed, vacuumed } and never throws: a read-only volume must not stop boot,
// it must be LOUD.
export function ensureIncrementalAutoVacuum(handle = sharedDb, log = console) {
  const before = autoVacuumMode(handle);
  const report = { before, mode: before, changed: false, vacuumed: false };
  if (before === 2) {
    log.log("[history] auto_vacuum = 2 (INCREMENTAL): interval vacuum is armed");
    return report;
  }
  try {
    handle.exec("PRAGMA auto_vacuum = INCREMENTAL");
    handle.exec("VACUUM");
    report.changed = true;
    report.vacuumed = true;
    report.mode = autoVacuumMode(handle);
  } catch (err) {
    report.error = err && err.message ? err.message : String(err);
    report.mode = autoVacuumMode(handle);
  }
  if (report.mode !== 2) {
    log.warn(
      `[history] LOUD: auto_vacuum is ${report.mode}, not 2 (INCREMENTAL) - a deleted film will not ` +
      `return its pages to the filesystem. Boot VACUUM ${report.vacuumed ? "ran" : "FAILED"}` +
      (report.error ? `: ${report.error}` : "") + ". The /data volume is probably read-only.",
    );
  } else {
    log.log(`[history] auto_vacuum was ${before}; set to INCREMENTAL and VACUUMed before serving`);
  }
  return report;
}

// The interval vacuum. A page budget, off the beat, and it refuses to run when the volume is nearly
// full (a vacuum needs room to rebuild pages). Asserts freelist pages, never file size.
export function incrementalVacuum(handle = sharedDb, opts = {}) {
  const log = opts.log || console;
  const rootDir = opts.rootDir || dataRoot;
  const pages = Number.isFinite(opts.pages) ? Math.max(0, Math.floor(opts.pages)) : VACUUM_PAGES_DEFAULT;
  const mode = autoVacuumMode(handle);
  if (mode !== 2) {
    log.warn(`[history] LOUD: incremental vacuum skipped - auto_vacuum is ${mode}, not 2`);
    return { skipped: "auto_vacuum", mode, freed: 0 };
  }
  const free = freeBytes(rootDir);
  if (free !== null && free < FREE_SPACE_FLOOR) {
    log.warn(`[history] incremental vacuum skipped - /data has ${free} B free`);
    return { skipped: "free-space", free, freed: 0 };
  }
  const before = freelistPages(handle);
  if (before === 0) return { freed: 0, before, after: 0, mode };
  try {
    handle.exec(`PRAGMA incremental_vacuum(${pages})`);
  } catch (err) {
    log.warn(`[history] incremental vacuum failed: ${err && err.message ? err.message : err}`);
    return { freed: 0, before, after: freelistPages(handle), mode, error: true };
  }
  const after = freelistPages(handle);
  const freed = Math.max(0, before - after);
  if (freed > 0) log.log(`[history] incremental vacuum freed ${freed} pages (freelist ${before} -> ${after})`);
  return { freed, before, after, mode };
}

function freeBytes(dir) {
  try {
    const stat = statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function tableExists(handle, name) {
  const row = handle
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(String(name));
  return Boolean(row && row.one);
}

// The report /api/health carries: real bytes, cap, the ratio, and whether the 80% alarm is lit.
export function historyBudget(handle = sharedDb, rootDir = dataRoot, env = process.env) {
  // A fresh /data has no `matches` table until the first film starts; /api/health must answer the
  // budget anyway (it is the page's one liveness read, not a film request).
  ensureHistorySchema(handle);
  const usage = historyUsage(handle, rootDir);
  const capBytes = historyCapBytes(env);
  const ratio = capBytes > 0 ? usage.totalBytes / capBytes : 0;
  return {
    fileBytes: usage.totalBytes,
    capBytes,
    ratio: Number(ratio.toFixed(4)),
    alarm: ratio >= PRUNE_TRIGGER,
    matches: usage.matches,
    finished: usage.finished,
    abandonedHours: historyAbandonedHours(env),
  };
}

// One bounded pass. Deletes at most `batch` headers total (abandoned first, then finished while over
// the cap), checkpoints the wal when anything went, and returns the numbers a log line needs.
// `roomExists` is injectable so a test can model a deleted room without writing the rooms table.
export function pruneHistory(handle = sharedDb, opts = {}) {
  const env = opts.env || process.env;
  const rootDir = opts.rootDir || dataRoot;
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const capBytes = Number.isFinite(opts.capBytes) ? Number(opts.capBytes) : historyCapBytes(env);
  const batch = Number.isFinite(opts.batch) ? Math.max(1, Math.min(500, Math.floor(opts.batch))) : historyPruneBatch(env);
  const abandonedHours = Number.isFinite(opts.abandonedHours) ? opts.abandonedHours : historyAbandonedHours(env);
  ensureHistorySchema(handle);

  const before = historyUsage(handle, rootDir);
  const report = {
    at: now.toISOString(),
    batch,
    abandonedHours,
    capBytes,
    overCap: before.totalBytes > capBytes,
    alarm: capBytes > 0 ? before.totalBytes / capBytes >= PRUNE_TRIGGER : false,
    usageBeforeBytes: before.totalBytes,
    abandoned: [],
    finished: [],
    freedBytes: 0,
    usageAfterBytes: before.totalBytes,
  };

  const roomsPresent = tableExists(handle, "rooms");
  const cutoff = new Date(now.getTime() - abandonedHours * 3600 * 1000).toISOString();

  // Class 2 first: invisible rows that can never be finished. Their bytes are already in the file,
  // but they still occupy pages a vacuum can only return once the header is gone.
  let left = batch;
  if (left > 0) {
    const rows = roomsPresent
      ? handle
        .prepare(
          `SELECT m.id AS id, m.stored_bytes AS stored_bytes FROM matches m
           LEFT JOIN rooms r ON r.id = m.id
           WHERE m.ended_at IS NULL AND m.started_at < ? AND r.id IS NULL
           ORDER BY m.started_at ASC, m.id ASC LIMIT ?`,
        )
        .all(cutoff, left)
      : handle
        .prepare(
          `SELECT id, stored_bytes FROM matches
           WHERE ended_at IS NULL AND started_at < ? ORDER BY started_at ASC, id ASC LIMIT ?`,
        )
        .all(cutoff, left);
    report.abandoned = rows.map((row) => String(row.id));
    left -= rows.length;
  }

  // Class 1: finished films, oldest first, and only while the real file total is over the cap. The
  // newest 100 per account are excluded by a window over both seats' handles.
  if (left > 0 && report.overCap) {
    const rows = handle
      .prepare(
        `WITH newest AS (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY handle ORDER BY ended_at DESC, id DESC) AS rn
             FROM (
               SELECT id, ended_at, blue_user AS handle FROM matches WHERE ended_at IS NOT NULL AND blue_user <> ''
               UNION ALL
               SELECT id, ended_at, red_user AS handle FROM matches WHERE ended_at IS NOT NULL AND red_user <> ''
             )
           ) WHERE rn <= 100
         )
         SELECT id, stored_bytes FROM matches
         WHERE ended_at IS NOT NULL AND id NOT IN (SELECT id FROM newest)
         ORDER BY ended_at ASC, id ASC LIMIT ?`,
      )
      .all(left);
    report.finished = rows.map((row) => String(row.id));
    left -= rows.length;
  }

  const ids = [...report.abandoned, ...report.finished];
  if (ids.length) {
    const storedBytes = handle
      .prepare(
        `SELECT COALESCE(SUM(stored_bytes), 0) AS bytes FROM matches
         WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .get(...ids);
    report.freedBytes = Number(storedBytes && storedBytes.bytes ? storedBytes.bytes : 0);
    const dropRounds = handle.prepare("DELETE FROM match_rounds WHERE match_id = ?");
    const dropMatch = handle.prepare("DELETE FROM matches WHERE id = ?");
    handle.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        dropRounds.run(id);
        dropMatch.run(id);
      }
      handle.exec("COMMIT");
    } catch (err) {
      handle.exec("ROLLBACK");
      report.error = err && err.message ? err.message : String(err);
      report.abandoned = [];
      report.finished = [];
      report.freedBytes = 0;
      return report;
    }
    try {
      handle.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // A checkpoint is maintenance; a failed one does not undo the deletes.
    }
    report.usageAfterBytes = historyUsage(handle, rootDir).totalBytes;
  }
  return report;
}

// One log line per pass that did something, silent when there was nothing to do (a 5-minute timer
// that prints every tick is noise, and condition 4 asks for a signal, not a heartbeat).
export function logPrune(report, log = console) {
  if (!report) return;
  if (report.error) {
    log.warn(`[history] prune failed: ${report.error}`);
    return;
  }
  if (!report.abandoned.length && !report.finished.length) {
    if (report.alarm) {
      log.warn(
        `[history] ALARM: /data at ${report.usageBeforeBytes} B of ${report.capBytes} B cap; ` +
        `nothing prunable this pass`,
      );
    }
    return;
  }
  log.log(
    `[history] pruned ${report.abandoned.length} abandoned + ${report.finished.length} finished films ` +
    `(${report.freedBytes} stored B); /data ${report.usageBeforeBytes} -> ${report.usageAfterBytes} B, ` +
    `cap ${report.capBytes} B`,
  );
}
