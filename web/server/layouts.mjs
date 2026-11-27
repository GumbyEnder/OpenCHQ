// PB-304: Layout Armies and Saved Layouts (manual p.16 l.417, p.37 l.1151-1164).
//
// Layout mode is a PREGAME sandbox: a 1986 room with one human seat, a held clock and no round.
// The player moves units inside friendly territory, gives them starting destinations and buys with
// the era's opening funds; Save Setup stores that setup under a name. Starting a 1986 war then
// offers the standard board or one of these layouts.
//
// Two tables, deliberately:
//   `save_layouts`  the named setup rows, one per account. They are not `saves` rows, so
//                   listSlots()/warOf() can never list a layout as a resumable war.
//
// Naming follows Saved Games (p.37 l.1160-1161 "as in 'Saved Games' above"): the name is cleaned
// and case-folded by the slot module's own functions, and an existing name is an OVERWRITE the
// caller must ask for. There is no silent replacement.
//
// A layout is NOT a match body: it stores the side's pieces (kind, domain, cell, strength,
// starting destination) and that side's remaining purse. Restoring it rebuilds the standard 1986
// board through opened() and replaces that side's pieces, which is why it never runs through
// packMatch/unpackMatch - a pregame setup is not a war at a round.

import { randomBytes } from "node:crypto";
import { db } from "./db.mjs";
import { cleanSlotName, slotKey } from "./slots.mjs";

db.exec(`
  CREATE TABLE IF NOT EXISTS save_layouts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    era TEXT NOT NULL,
    side TEXT NOT NULL,
    pieces TEXT NOT NULL,
    cash REAL,
    created_at TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS save_layouts_owner_name ON save_layouts(username, name_key);
`);

const SIDES = ["blue", "red"];

function nowIso() {
  return new Date().toISOString();
}

function parsePieces(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// What a layout row says to a player: a name, the year and side, how many units and what the side
// had left to spend. Never a piece id, never a side:kind key.
function summaryOf(row) {
  const pieces = parsePieces(row.pieces);
  return {
    id: row.id,
    name: row.name,
    era: String(row.era),
    side: row.side,
    cash: row.cash === null || row.cash === undefined ? null : Number(row.cash),
    pieces: pieces.length,
    savedAt: row.saved_at,
  };
}

// The piece set a layout stores: only what the player may edit. A path is never stored (layout
// mode moves a unit in one step), destinations are.
function layoutBody(room, side) {
  const pieces = Array.isArray(room.match && room.match.pieces) ? room.match.pieces : [];
  const mine = pieces
    .filter((piece) => piece && piece.side === side && piece.domain !== "sat")
    .map((piece) => ({
      kind: String(piece.kind || ""),
      domain: String(piece.domain || "land"),
      x: Number(piece.x),
      y: Number(piece.y),
      strength: Number.isFinite(Number(piece.strength)) ? Number(piece.strength) : null,
      entrenched: piece.entrenched === true,
      startingDestination: piece.startingDestination
        ? { x: Number(piece.startingDestination.x), y: Number(piece.startingDestination.y) }
        : null,
    }));
  const sides = room.match && room.match.sides ? room.match.sides : {};
  const cash = sides[side] && Number.isFinite(Number(sides[side].cash)) ? Number(sides[side].cash) : null;
  return { pieces: mine, cash };
}

// Save Setup: store this layout mode's side under a name. A duplicate is refused unless the caller
// asked for the overwrite, and the overwrite keeps the row's id - exactly the Saved Games rule.
export function saveLayout({ username, name, room, side, overwrite = false }) {
  const clean = cleanSlotName(name);
  if (!clean) return { error: "A saved layout needs a name." };
  if (!room || !room.match) return { error: "Lay out armies first." };
  if (room.mode !== "layout") return { error: "Save Setup is only for a layout you are drawing." };
  if (String(room.era) !== "1986") return { error: "Layouts are for 1986 wars only." };
  if (side !== "blue" && side !== "red") return { error: "That side is not yours." };
  const key = slotKey(clean);
  const existing = db.prepare("SELECT * FROM save_layouts WHERE username = ? AND name_key = ?").get(String(username), key);
  if (existing && !overwrite) {
    return {
      error: "A saved layout named \"" + existing.name + "\" already exists. Choose Overwrite to replace it.",
      exists: true,
      id: existing.id,
    };
  }
  const body = layoutBody(room, side);
  if (!body.pieces.length) return { error: "This setup has no units to save." };
  const stamp = nowIso();
  const piecesJson = JSON.stringify(body.pieces);
  if (existing) {
    db.prepare(
      "UPDATE save_layouts SET name = ?, era = ?, side = ?, pieces = ?, cash = ?, saved_at = ? WHERE id = ?",
    ).run(clean, String(room.era), side, piecesJson, body.cash, stamp, existing.id);
    const row = db.prepare("SELECT * FROM save_layouts WHERE id = ?").get(existing.id);
    return { ok: true, overwritten: true, layout: summaryOf(row) };
  }
  const id = randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO save_layouts (id, username, name, name_key, era, side, pieces, cash, created_at, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, String(username), clean, key, String(room.era), side, piecesJson, body.cash, stamp, stamp);
  const row = db.prepare("SELECT * FROM save_layouts WHERE id = ?").get(id);
  return { ok: true, overwritten: false, layout: summaryOf(row) };
}

// Every named layout this account saved, newest first.
export function listLayouts(username) {
  const rows = db.prepare(
    "SELECT * FROM save_layouts WHERE username = ? ORDER BY saved_at DESC, rowid DESC",
  ).all(String(username));
  return rows.map(summaryOf);
}

// A layout the caller saved. Another account gets the same answer as a layout that does not
// exist, so an id is not an account probe.
export function layoutFor(username, id) {
  if (!id) return { error: "Choose a saved layout." };
  const row = db.prepare("SELECT * FROM save_layouts WHERE id = ?").get(String(id));
  if (!row) return { error: "That saved layout is gone." };
  if (String(row.username) !== String(username)) return { error: "That saved layout belongs to another player." };
  if (String(row.era) !== "1986") return { error: "That layout is for " + row.era + ", not a 1986 war." };
  if (row.side !== "blue" && row.side !== "red") return { error: "That layout cannot be read." };
  return { row, side: row.side, pieces: parsePieces(row.pieces), cash: row.cash === null ? null : Number(row.cash) };
}

// Put a stored setup on the board: that side's pieces replace the standard opening ones, their
// destinations come back, and the purse is what the player left when they saved. The other side is
// untouched, so this works against the computer or any other opponent.
export function applyLayout(match, side, layout) {
  if (!match || !Array.isArray(match.pieces)) return { error: "No match is running." };
  if (side !== "blue" && side !== "red") return { error: "That side is unknown." };
  const rows = Array.isArray(layout && layout.pieces) ? layout.pieces : [];
  if (!rows.length) return { error: "That layout has no units." };
  const max = Number(
    match.pieces.find((piece) => piece && Number.isFinite(Number(piece.maxStrength)))?.maxStrength,
  );
  const built = [];
  rows.forEach((row, index) => {
    const x = Number(row.x);
    const y = Number(row.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const domain = ["land", "sea", "air"].includes(String(row.domain)) ? String(row.domain) : "land";
    const strength = Number.isFinite(Number(row.strength)) && Number(row.strength) > 0
      ? Number(row.strength)
      : (Number.isFinite(max) && max > 0 ? max : 100);
    const piece = {
      id: `${side}:layout:${String(row.kind || "unit")}:${index}`,
      side,
      domain,
      kind: String(row.kind || ""),
      x,
      y,
      path: [],
      pace: 1,
      facing: null,
      fighting: null,
      shots: 0,
      strength,
      maxStrength: Number.isFinite(max) && max > 0 ? max : strength,
      entrenched: row.entrenched === true,
      pinned: false,
    };
    if (row.startingDestination && Number.isInteger(Number(row.startingDestination.x)) &&
      Number.isInteger(Number(row.startingDestination.y))) {
      piece.startingDestination = {
        x: Number(row.startingDestination.x),
        y: Number(row.startingDestination.y),
      };
    }
    built.push(piece);
  });
  if (!built.length) return { error: "That layout has no units." };
  match.pieces = match.pieces.filter((piece) => piece && piece.side !== side).concat(built);
  if (match.sides && match.sides[side] && Number.isFinite(Number(layout.cash))) {
    match.sides[side].cash = Number(layout.cash);
  }
  return { ok: true, count: built.length, side };
}

// Kept beside the store so a repair tool and the leg read the same list of sides.
export const LAYOUT_SIDES = SIDES;
