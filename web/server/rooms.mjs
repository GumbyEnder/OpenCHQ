// Durable rooms. A room is a row: id, mode, era, clock, seats and the match blob.
// The process is a cache in front of this table, never the owner of a game.
//
// Writes are one upsert per state change. The probe in tools/bench-rooms.mjs measured a
// 1000-room snapshot at ~11 ms in one transaction against a 140 ms round budget, so
// per-change writes are affordable at the target scale. Two things buy that headroom, and
// neither shrinks the match:
//
//  - The row does not repeat the board's static site table. Sites are rebuilt from
//    board.mjs on load; the row carries only which side owns which site and which site is
//    unready. A running room keeps the full site list in memory either way.
//  - created_at is remembered per room, so a round does not SELECT before every upsert.
//
// There is deliberately no index on saved_at: every running room rewrites saved_at every
// round, and maintaining that index cost a third of the snapshot. The 24 h prune is a boot
// time scan of one table, which is cheap at this size.

import { boardPayload } from "./board.mjs";
import { capitalSetFor } from "./match.mjs";
import { db } from "./db.mjs";
import { migrateMatch } from "./migrate.mjs";

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
  DROP INDEX IF EXISTS rooms_saved_at;
`);

const IDLE_HOURS = 24;
const SIDES = ["blue", "red"];

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

const createdById = new Map();
const existingCreatedStmt = db.prepare("SELECT created_at FROM rooms WHERE id = ?");

function nowIso() {
  return new Date().toISOString();
}

// The board's site table, once per process. A room row only stores the delta; the static
// half (name, cell, kind, country) is the same for every room on this board.
let staticsCache = null;
function siteStatics() {
  if (staticsCache) return staticsCache;
  const map = new Map();
  try {
    for (const site of boardPayload().sites || []) {
      if (!site || site.id === undefined) continue;
      map.set(String(site.id), {
        id: site.id,
        name: site.name,
        x: site.x,
        y: site.y,
        kind: site.kind,
        ...(site.country_id === undefined ? {} : { country_id: site.country_id }),
        ...(site.region === undefined ? {} : { region: site.region }),
      });
    }
  } catch {
    // No extract on this host: rooms there open with no sites, so there is nothing to add.
  }
  staticsCache = map;
  return map;
}

// The match with the site table replaced by ownership lists. Everything the match mutates
// (round, clock, pieces, sides, capitals, winner) stays as it is, including routes: a row
// is the paused game, and a route step is not something to drop for a smaller file.
function packMatch(match) {
  if (!match || typeof match !== "object") return null;
  const { sites, ...rest } = match;
  const siteOwners = { blue: [], red: [] };
  const sitesUnready = [];
  for (const site of sites || []) {
    if (!site) continue;
    if (SIDES.includes(site.owner)) siteOwners[site.owner].push(site.id);
    if (site.unready) sitesUnready.push(site.id);
  }
  return { ...rest, siteOwners, sitesUnready, moneyUnit: "millions" };
}

// Rows written before T-001 stored cash in whole billions and could carry the generic "ship"
// kind. migrate.mjs owns that migration; unpack runs it on every load.

// Rebuild the full site list from the board, then apply the ownership the row recorded.
// A row written before this format (a plain sites array) is passed through untouched, but is
// still migrated for unit kinds and the money scale.
export function unpackMatch(packed) {
  if (!packed || typeof packed !== "object") return null;
  if (!packed.siteOwners && Array.isArray(packed.sites)) return withCapitalSet(migrateMatch({ ...packed }));
  const { siteOwners, sitesUnready, sites, ...rest } = packed;
  const owners = new Map();
  for (const side of SIDES) {
    for (const id of (siteOwners && siteOwners[side]) || []) owners.set(String(id), side);
  }
  const unready = new Set(((sitesUnready || [])).map((id) => String(id)));
  const rebuilt = [];
  for (const [key, base] of siteStatics()) {
    const owner = owners.get(key) ?? null;
    rebuilt.push({
      ...base,
      owner,
      ...(unready.has(key) ? { unready: true } : {}),
    });
  }
  const match = migrateMatch({ ...rest, sites: rebuilt });
  return withCapitalSet(match);
}

// Rows written before B-3b carry no capital set, and without one the win check refuses every set and
// the room could never be finished. Rebuild it from the board the row already carries: the file years
// are the same join as at launch, and a rolled year re-rolls from the recorded owners with its era as
// the seed (deterministic, though not necessarily the rooms' original draw).
//
// This runs on every unpack path, including the pre-T-001 one above: a legacy row hits the same wall
// on load, and putting the rebuild after that early return left exactly the hole this guard exists
// to close.
function withCapitalSet(match) {
  if (!match) return match;
  if (!match.capitalSet || !Array.isArray(match.capitalSet.list)) {
    match.capitalSet = capitalSetFor(match.era, match.sites);
  }
  return match;
}

// The row keeps the seats and anything the match will need. It is JSON so the match shape
// can grow without a migration per node.
export function saveRoom(room) {
  const state = JSON.stringify({ seats: room.seats ?? {}, match: packMatch(room.match), resume: room.resume === true });
  let created = createdById.get(room.id);
  if (!created) {
    try {
      const existing = existingCreatedStmt.get(room.id);
      created = existing ? existing.created_at : nowIso();
    } catch {
      // A room id that is not a string, or a failed read, still gets a stamp.
      created = nowIso();
    }
    createdById.set(room.id, created);
  }
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
  createdById.delete(id);
}

// A room is durable within FLUSH_SECONDS of rounds. The tick marks a room dirty; each round
// writes a slice of the dirty rooms, so 1000 running rooms never all hit the disk in the
// same 0.14 s round. A player action (create, order, run, hold, leave, a win) still saves
// immediately, because those are the changes a player would notice losing.
export const FLUSH_SECONDS = 2;

// How many rounds of the configured length fit in that window. A 5 s round writes every
// dirty room each round; a 0.14 s round writes about a fifteenth.
export function flushWindow(roundSeconds) {
  const round = Math.max(0.001, Number(roundSeconds) || 0.14);
  return Math.max(1, Math.ceil(FLUSH_SECONDS / round));
}

// `window` is how many rounds a dirty room may wait before it is written.
export function flushRooms(list, cursor = 0, window = 1) {
  const dirty = list.filter((room) => room && room.dirty);
  if (!dirty.length) return { cursor, written: 0 };
  const rounds = Math.max(1, Math.floor(window) || 1);
  const slice = Math.max(1, Math.ceil(dirty.length / rounds));
  let written = 0;
  // One transaction for the slice. Without it each upsert is its own commit, which costs
  // more than the state it writes.
  db.exec("BEGIN");
  try {
    for (let i = 0; i < slice; i++) {
      const room = dirty[(cursor + i) % dirty.length];
      saveRoom(room);
      room.dirty = false;
      written += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { cursor: cursor + slice, written };
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
    const match = unpackMatch(state.match ?? null);
    createdById.set(row.id, row.created_at);
    // A restored game is paused, and so is its match: one clock, never two. The one exception
    // is a room that was marked to resume when the process drained for a deploy: that stop was
    // ours, not the player's, so the match comes back running with the clock it had.
    const resuming = state.resume === true && row.clock === "running" && Boolean(state.seats);
    if (match && typeof match === "object") match.clock = resuming ? "running" : "held";
    return {
      id: row.id,
      mode: row.mode,
      era: row.era,
      clock: resuming ? "running" : "held",
      resume: false,
      note: resuming ? "Resumed after a deploy." : String(row.note || ""),
      seats: state.seats ?? {},
      match,
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
