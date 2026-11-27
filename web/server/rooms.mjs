// Durable rooms. A room is a row: id, mode, era, clock, seats and the match blob.
// The process is a cache in front of this table, never the owner of a game.
//
// Writes are one upsert per state change. The probe in tools/bench-rooms.mjs measured a
// 1000-room snapshot at ~11 ms in one transaction against a 140 ms round budget, so
// per-change writes are affordable at the target scale. Two things buy that headroom, and
// neither shrinks the match:
//
//  - The row does not repeat the board's static site table. Sites are rebuilt from
//    board.mjs on load; the row carries which sites the room HAS, which side owns each, and
//    which site is unready. A running room keeps the full site list in memory either way.
//  - created_at is remembered per room, so a round does not SELECT before every upsert.
//
// There is deliberately no index on saved_at: every running room rewrites saved_at every
// round, and maintaining that index cost a third of the snapshot. The 24 h prune is a boot
// time scan of one table, which is cheap at this size.

import { boardPayload, matchSites } from "./board.mjs";
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

// The board's site table, once per process per era. A room row stores its own MEMBERSHIP now
// (PB-124, `siteIds` below) and the static half (name, cell, kind, country, the era's subtype
// `type`) is the same for every room of that era on this board.
//
// Two things live here, and they are different questions:
//  - the era roster is what matchSites(era) hands openMatch at the bell: the year's live rows with
//    their `type`, then the docks and oil wells the asset list does not carry at all. A rebuild
//    from boardPayload().sites alone answered the 84-row picture list, so every resumed room lost
//    its 150 docks and its wells and gained the rows the year drops (PB-124).
//  - `type` is not on the asset list; it is joined in by the baked era table. A rebuilt site that
//    loses it is a site the page cannot classify, which is PB-120's resume path - a stored 1918
//    room came back with no `type` on any row, so capitalMarkers() fell through to the fixed-seat
//    fallback and named the London/Berlin cells "Washington"/"Moscow".
//
// The owner byte applyEra() copies is NOT taken here: the row's own siteOwners carry the live
// owners, and the static half never writes an owner.
let staticsCache = null;
function siteStatics(era) {
  const key = String(era === undefined || era === null ? "" : era);
  if (!staticsCache) staticsCache = new Map();
  if (staticsCache.has(key)) return staticsCache.get(key);
  const map = new Map();
  try {
    // No era (a row from before eras, or the raw-list fallback lookup): the bare asset list.
    const roster = key === "" ? (boardPayload().sites || []) : matchSites(key, boardPayload());
    for (const site of roster || []) {
      if (!site || site.id === undefined) continue;
      const id = String(site.id);
      map.set(id, {
        id: site.id,
        name: site.name,
        x: site.x,
        y: site.y,
        kind: site.kind,
        ...(site.type === undefined ? {} : { type: site.type }),
        ...(site.country_id === undefined ? {} : { country_id: site.country_id }),
        ...(site.region === undefined ? {} : { region: site.region }),
      });
    }
  } catch {
    // No extract on this host: rooms there open with no sites, so there is nothing to add.
  }
  staticsCache.set(key, map);
  return map;
}

// The match with the site table replaced by ownership lists. Everything the match mutates
// (round, clock, pieces, sides, capitals, winner) stays as it is, including routes: a row
// is the paused game, and a route step is not something to drop for a smaller file.
//
// PB-205 exports it: a named save slot's body IS this function's output, so the slot store and the
// room store cannot drift into two serializations.
export function packMatch(match) {
  if (!match || typeof match !== "object") return null;
  const { sites, ...rest } = match;
  const siteOwners = { blue: [], red: [] };
  const sitesUnready = [];
  const siteReadyRounds = {};
  // PB-124: which sites the room HAS is part of the delta, not a property of the board. Without
  // it the restore asked the era and every room came back as that era's whole roster - 1918 lost
  // all 150 docks and 9 wells and gained 59 cities the year does not hold, which is a refused hull
  // for every side whose berths were docks and an income scan over the wrong ground.
  const siteIds = [];
  for (const site of sites || []) {
    if (!site) continue;
    siteIds.push(site.id);
    if (SIDES.includes(site.owner)) siteOwners[site.owner].push(site.id);
    // T-011 replaced the boolean with the round a site comes back. The boolean is still written
    // for a row read by an older build, and the round is what a current build reads back.
    const readyRound = Number(site.readyRound);
    if (Number.isFinite(readyRound) && readyRound > 0) {
      siteReadyRounds[String(site.id)] = Math.floor(readyRound);
      sitesUnready.push(site.id);
    }
  }
  return { ...rest, siteIds, siteOwners, sitesUnready, siteReadyRounds, moneyUnit: "millions" };
}

// Rows written before T-001 stored cash in whole billions and could carry the generic "ship"
// kind. migrate.mjs owns that migration; unpack runs it on every load.

// Rebuild the full site list from the board, then apply the ownership the row recorded.
// A row written before this format (a plain sites array) is passed through untouched, but is
// still migrated for unit kinds and the money scale.
export function unpackMatch(packed) {
  if (!packed || typeof packed !== "object") return null;
  if (!packed.siteOwners && Array.isArray(packed.sites)) return withCapitalSet(migrateMatch({ ...packed }));
  const { siteOwners, sitesUnready, siteIds, sites, ...rest } = packed;
  const owners = new Map();
  for (const side of SIDES) {
    for (const id of (siteOwners && siteOwners[side]) || []) owners.set(String(id), side);
  }
  const unready = new Set(((sitesUnready || [])).map((id) => String(id)));
  const readyRounds = packed.siteReadyRounds && typeof packed.siteReadyRounds === "object" ? packed.siteReadyRounds : {};
  const rebuilt = [];
  // PB-124: a row that recorded its membership rebuilds exactly that list, in that order, with the
  // era's static half (including `type`) on every id the era roster names. Ids the era roster does
  // not carry at all - a dock or a well is not in the 84-row asset list - fall back to the bare
  // board list so a row is never rebuilt thinner than it was saved.
  // A row written before PB-124 recorded no membership; the era's whole roster is the best answer
  // it admits, which is what it got before, minus the rows the year drops.
  const eraMap = siteStatics(rest.era);
  const rawMap = siteStatics();
  const entries = Array.isArray(siteIds) && siteIds.length
    ? siteIds.map((id) => [String(id), eraMap.get(String(id)) || rawMap.get(String(id))])
    : [...eraMap];
  for (const [key, base] of entries) {
    if (!base) continue;
    const owner = owners.get(key) ?? null;
    // A row from before T-011 carries the boolean only, with no duration: the city comes back on
    // the next round rather than staying unready forever, so a loaded room can produce again.
    const legacy = unready.has(key) && !Number.isFinite(Number(readyRounds[key]));
    const readyRound = legacy ? (Number(rest.round) || 0) + 1 : Number(readyRounds[key]);
    rebuilt.push({
      ...base,
      owner,
      ...(Number.isFinite(readyRound) && readyRound > 0 ? { readyRound } : {}),
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
  const state = JSON.stringify({
    seats: room.seats ?? {},
    match: packMatch(room.match),
    resume: room.resume === true,
    // The room's own clock speed (T-004, Manual p.34-35). It lives in the row's state JSON because
    // the table's columns are the room's identity, not its settings.
    speed: Number.isInteger(room.speed) ? room.speed : 1,
    // PB-134: which seat is holding the clock, and whether the room itself is stopped by a
    // disconnect. A restart must not hand a held clock back with no holds: either seat's `run`
    // would then lift a pause the other seat still owns.
    holds: {
      blue: Boolean(room.holds && room.holds.blue === true),
      red: Boolean(room.holds && room.holds.red === true),
    },
    roomHold: room.holdRoom === true,
  });
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
      // A row written before T-004 carries no speed: it plays at the old single clock, which is
      // speed 1.
      speed: Number.isInteger(state.speed) ? Math.min(6, Math.max(0, state.speed)) : 1,
      // PB-134: a restored held room has nobody connected, so it is stopped by the room until a
      // seat rejoins; the holds each seat left are kept, because those are that seat's, not ours.
      holds: {
        blue: Boolean(state.holds && state.holds.blue === true),
        red: Boolean(state.holds && state.holds.red === true),
      },
      holdRoom: resuming ? false : state.roomHold === true || row.clock !== "running",
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
