// PB-205: named Save Game / Resume Saved War slots (manual p.16 l.416, p.36-37 l.1142-1150).
//
// A slot is a NAMED copy of a room's stored state, kept in the same SQLite file as the rooms. Its
// body is exactly what saveRoom() writes: the seat table, packMatch(room.match), the per-seat
// holds, the room hold and the speed. There is no second serialization - a slot is a paused room
// that was given a name, and resuming it runs the same unpackMatch() path a restart runs.
//
// Two tables, deliberately:
//   `saves`      the named rows. pruneRooms() is a DELETE over `rooms` and must keep taking
//                abandoned autosaves; a named slot is a player's record and no idle sweep may
//                reach it (AC4).
//   `save_seats` the membership index. A two-human save is listed for BOTH accounts that held a
//                seat and only those accounts may resume it (AC3); a bot save lists one account
//                and keeps the bot side a bot.

import { randomBytes } from "node:crypto";
import { db } from "./db.mjs";
import { packMatch, unpackMatch } from "./rooms.mjs";
import { localName } from "./names.mjs";

db.exec(`
  CREATE TABLE IF NOT EXISTS saves (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    era TEXT NOT NULL,
    mode TEXT NOT NULL,
    round INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS saves_owner_name ON saves(username, name_key);
  CREATE TABLE IF NOT EXISTS save_seats (
    slot_id TEXT NOT NULL,
    username TEXT NOT NULL,
    side TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (slot_id, side)
  );
  CREATE INDEX IF NOT EXISTS save_seats_user ON save_seats(username);
`);

const SIDES = ["blue", "red"];
const NAME_MAX = 40;

function nowIso() {
  return new Date().toISOString();
}

// A slot name is a label a player types, not a path or an id. Whitespace is collapsed, control
// characters never reach the row, and the key is case-folded so "Front Line" and "front  line"
// are the same slot - an overwrite has to be a decision about ONE name, not two near-duplicates.
export function cleanSlotName(raw) {
  const name = String(raw === undefined || raw === null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return name;
}

export function slotKey(name) {
  return cleanSlotName(name).toLowerCase();
}

// What a slot row says to a player. Never a piece id: the summary carries counts and the seat's
// own purse, and the piece LABELS are the page's business (AC6).
function summaryOf(row, state, viewer) {
  const seats = state.seats && typeof state.seats === "object" ? state.seats : {};
  const players = [];
  for (const seatSide of SIDES) {
    const seat = seats[seatSide];
    if (!seat) continue;
    players.push({
      side: seatSide,
      kind: seat.kind === "bot" ? "bot" : "human",
      name: seat.kind === "bot" ? "Computer" : localName(seat.username),
    });
  }
  const match = state.match && typeof state.match === "object" ? state.match : {};
  const sides = match.sides && typeof match.sides === "object" ? match.sides : {};
  const mine = viewer ? seatSideOf(seats, viewer) : null;
  const cash = mine && sides[mine] && Number.isFinite(Number(sides[mine].cash))
    ? Number(sides[mine].cash)
    : null;
  return {
    id: row.id,
    name: row.name,
    era: String(row.era),
    mode: row.mode,
    round: Number(row.round) || 0,
    savedAt: row.saved_at,
    side: mine,
    cash,
    players,
    pieces: Array.isArray(match.pieces) ? match.pieces.length : 0,
    over: match.over === true,
  };
}

function seatSideOf(seats, username) {
  for (const side of SIDES) {
    const seat = seats[side];
    if (seat && seat.kind !== "bot" && String(seat.username) === String(username)) return side;
  }
  return null;
}

function parseState(raw) {
  try {
    const state = JSON.parse(raw);
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

// The room state a slot stores. This is saveRoom()'s body, field for field: if a field is added
// there it belongs here too, and a test that compares the two objects is the guard against drift.
function stateOf(room, side) {
  return {
    seats: room.seats ?? {},
    match: packMatch(room.match),
    holds: {
      blue: Boolean(room.holds && room.holds.blue === true),
      red: Boolean(room.holds && room.holds.red === true),
    },
    roomHold: room.holdRoom === true,
    speed: Number.isInteger(room.speed) ? room.speed : 1,
    side,
  };
}

function seatRowsOf(slotId, seats) {
  const rows = [];
  for (const side of SIDES) {
    const seat = seats && seats[side];
    if (!seat || seat.kind === "bot" || !seat.username) continue;
    rows.push({ slotId, username: String(seat.username), side, kind: "human" });
  }
  return rows;
}

function writeSeats(slotId, seats) {
  db.prepare("DELETE FROM save_seats WHERE slot_id = ?").run(slotId);
  const insert = db.prepare("INSERT OR REPLACE INTO save_seats (slot_id, username, side, kind) VALUES (?, ?, ?, ?)");
  for (const row of seatRowsOf(slotId, seats)) insert.run(row.slotId, row.username, row.side, row.kind);
}

// Save a live room under a name. An existing name is an OVERWRITE the caller must ask for with
// `overwrite:true`; without it the answer names the existing slot and nothing is written, so a
// silent duplicate is impossible (AC1).
export function saveSlot({ username, name, room, side, overwrite = false }) {
  const clean = cleanSlotName(name);
  if (!clean) return { error: "A saved war needs a name." };
  if (!room || !room.match) return { error: "Start a match first." };
  const key = slotKey(clean);
  const existing = db.prepare("SELECT * FROM saves WHERE username = ? AND name_key = ?").get(String(username), key);
  if (existing && !overwrite) {
    return {
      error: "A saved war named \"" + existing.name + "\" already exists. Choose Overwrite to replace it.",
      exists: true,
      id: existing.id,
    };
  }
  const state = stateOf(room, side);
  const body = JSON.stringify(state);
  const round = Number(room.match.round) || 0;
  const stamp = nowIso();
  if (existing) {
    db.prepare(
      "UPDATE saves SET name = ?, era = ?, mode = ?, round = ?, state = ?, saved_at = ? WHERE id = ?",
    ).run(clean, String(room.era ?? ""), String(room.mode ?? "bot"), round, body, stamp, existing.id);
    writeSeats(existing.id, room.seats);
    const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(existing.id);
    return { ok: true, overwritten: true, slot: summaryOf(row, state, username) };
  }
  const id = randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO saves (id, username, name, name_key, era, mode, round, state, created_at, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, String(username), clean, key, String(room.era ?? ""), String(room.mode ?? "bot"), round, body, stamp, stamp);
  writeSeats(id, room.seats);
  const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(id);
  return { ok: true, overwritten: false, slot: summaryOf(row, state, username) };
}

// Every named slot this account may resume: the ones it saved and the two-human ones it held a
// seat in. Newest first.
export function listSlots(username) {
  const rows = db.prepare(
    `SELECT s.* FROM saves s
       JOIN save_seats ss ON ss.slot_id = s.id
      WHERE ss.username = ?
      GROUP BY s.id
      ORDER BY s.saved_at DESC, s.rowid DESC`,
  ).all(String(username));
  const out = [];
  for (const row of rows) {
    const state = parseState(row.state);
    if (!state) continue;
    out.push(summaryOf(row, state, username));
  }
  return out;
}

// A slot the caller holds a seat in, with its parsed state. A different account gets the same
// answer as a slot that does not exist, so a slot id is not an account probe.
export function slotFor(username, id) {
  if (!id) return { error: "Choose a saved war." };
  const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(String(id));
  if (!row) return { error: "That saved war is gone." };
  const member = db.prepare("SELECT * FROM save_seats WHERE slot_id = ? AND username = ?").get(row.id, String(username));
  if (!member) return { error: "That saved war belongs to another player." };
  const state = parseState(row.state);
  if (!state || !state.match) return { error: "That saved war cannot be read." };
  return { row, state, side: member.side };
}

// The room a slot restores. Held, always: a resume is not a play command (PB-134), and the
// per-seat holds the slot recorded are kept as they were - resuming lifts nothing.
export function roomFromSlot(row, state) {
  const match = unpackMatch(state.match);
  if (match && typeof match === "object") match.clock = "held";
  const seats = state.seats && typeof state.seats === "object"
    ? JSON.parse(JSON.stringify(state.seats))
    : { blue: null, red: null };
  return {
    id: randomBytes(8).toString("hex"),
    mode: String(row.mode || "bot"),
    era: String(row.era),
    clock: "held",
    holds: {
      blue: Boolean(state.holds && state.holds.blue === true),
      red: Boolean(state.holds && state.holds.red === true),
    },
    holdRoom: true,
    speed: Number.isInteger(state.speed) ? Math.min(6, Math.max(0, state.speed)) : 1,
    note: "Saved war \"" + row.name + "\" resumed. The clock is held.",
    seats,
    match,
    resumedFrom: row.id,
  };
}

// AC2's own equality, as a function the test and a repair tool can both run: packMatch's body
// through JSON (the store's own encoding) and back through unpackMatch must leave the round, every
// piece (path, strength and flags included) and each seat's purse unchanged.
export function roundTrip(match) {
  return unpackMatch(JSON.parse(JSON.stringify(packMatch(match))));
}
