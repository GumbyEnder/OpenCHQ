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
//   `save_seats` the account binding, written at save time: which account held which side. A
//                resume reads the saver's side from it and re-seats every human account the slot
//                recorded, so a two-human war comes back two-human (AC3); a bot save keeps the bot
//                side a bot.
//
// A slot belongs to the account that saved it, and only that account sees it. The manual is
// explicit for a two-player game (p.36 l.1145): "both players must save the game, but they don't
// have to save the game under the same name." So each seat saves its own copy under its own name,
// and resuming either copy brings BOTH bound accounts back to the same war - the slot carries the
// seat table, not one seat's half of it. Listing one seat's save for the other would be a
// deviation from that sentence, and a deviation is the PM's call, not this module's.

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
    war_id TEXT,
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

// A store written before the war identity existed has no war_id column. A slot's own id becomes its
// war identity then, which is right for a bot war and for a lone copy.
const saveColumns = db.prepare("PRAGMA table_info(saves)").all().map((column) => column.name);
if (!saveColumns.includes("war_id")) db.exec("ALTER TABLE saves ADD COLUMN war_id TEXT");

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
    // A two-player war is saved only when both seats have saved it (manual p.36-37 l.1145-1150).
    war: warOf(row, state),
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

// The human accounts a slot binds, as its seat table records them.
export function humanSeatsOf(seats) {
  const out = [];
  for (const side of SIDES) {
    const seat = seats && seats[side];
    if (!seat || seat.kind === "bot" || !seat.username) continue;
    out.push({ side, username: String(seat.username) });
  }
  return out;
}

// Key-order independent: two copies of the same moment are equal even if a different build wrote
// their JSON in a different order.
function bodyKey(value) {
  if (Array.isArray(value)) return "[" + value.map(bodyKey).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + bodyKey(value[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

// The `side` field is the viewer's own seat, not part of the war: two seats' copies of one moment
// differ in that field and in nothing else.
function savedBody(state) {
  const copy = { ...state };
  delete copy.side;
  return bodyKey(copy);
}

// Manual p.36-37 l.1145-1150: "both players must save the game, but they don't have to save the
// game under the same name", and "if both players have selected the same game, it restarts at the
// moment it was saved". So a two-human war is complete only when every bound seat has saved a copy
// of the SAME moment; one seat's copy is a complete save only for a bot war.
export function warOf(row, state) {
  const id = String(row.war_id || row.id);
  const seats = humanSeatsOf(state && state.seats);
  if (seats.length < 2) return { id, complete: true, sameMoment: true, waitingOn: [], seats: seats.map((seat) => seat.username) };
  const bodies = new Map();
  const waitingOn = [];
  for (const seat of seats) {
    const copy = db.prepare(
      "SELECT * FROM saves WHERE username = ? AND (war_id = ? OR (war_id IS NULL AND id = ?)) ORDER BY saved_at DESC, rowid DESC",
    ).get(seat.username, id, id);
    const copyState = copy ? parseState(copy.state) : null;
    if (!copyState) {
      waitingOn.push(localName(seat.username));
      continue;
    }
    bodies.set(seat.username, savedBody(copyState));
  }
  const keys = [...bodies.values()];
  const sameMoment = keys.length === seats.length && keys.every((key) => key === keys[0]);
  return {
    id,
    complete: sameMoment,
    sameMoment,
    waitingOn,
    seats: seats.map((seat) => seat.username),
  };
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
  // The war identity is the live room both seats are saving, so two copies of one war meet again
  // at resume even though their names, slots and accounts differ (manual p.36 l.1145).
  const warId = String(room.id ?? "");
  if (existing) {
    db.prepare(
      "UPDATE saves SET name = ?, era = ?, mode = ?, round = ?, state = ?, saved_at = ?, war_id = ? WHERE id = ?",
    ).run(clean, String(room.era ?? ""), String(room.mode ?? "bot"), round, body, stamp, warId, existing.id);
    writeSeats(existing.id, room.seats);
    const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(existing.id);
    return { ok: true, overwritten: true, slot: summaryOf(row, state, username) };
  }
  const id = randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO saves (id, username, name, name_key, era, mode, round, state, war_id, created_at, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, String(username), clean, key, String(room.era ?? ""), String(room.mode ?? "bot"), round, body, warId, stamp, stamp);
  writeSeats(id, room.seats);
  const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(id);
  return { ok: true, overwritten: false, slot: summaryOf(row, state, username) };
}

// Every named slot this account saved, newest first. It is the account's own drawer: the second
// seat of a two-human war has to save its own copy to see one (manual p.36 l.1145).
export function listSlots(username) {
  const rows = db.prepare(
    "SELECT * FROM saves WHERE username = ? ORDER BY saved_at DESC, rowid DESC",
  ).all(String(username));
  const out = [];
  for (const row of rows) {
    const state = parseState(row.state);
    if (!state) continue;
    out.push(summaryOf(row, state, username));
  }
  return out;
}

// A slot the caller saved, with its parsed state and the side that account held when it saved.
// A different account gets the same answer as a slot that does not exist, so a slot id is not an
// account probe - and a seat holder who has not saved does not get the other seat's copy.
export function slotFor(username, id) {
  if (!id) return { error: "Choose a saved war." };
  const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(String(id));
  if (!row) return { error: "That saved war is gone." };
  if (String(row.username) !== String(username)) return { error: "That saved war belongs to another player." };
  const state = parseState(row.state);
  if (!state || !state.match) return { error: "That saved war cannot be read." };
  // The binding written at save time. A row without one (a store written before save_seats) falls
  // back to the seat table itself, which carries the same username.
  const member = db.prepare("SELECT side FROM save_seats WHERE slot_id = ? AND username = ?").get(row.id, String(username));
  const side = member ? member.side : seatSideOf(state.seats, username);
  return { row, state, side };
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
