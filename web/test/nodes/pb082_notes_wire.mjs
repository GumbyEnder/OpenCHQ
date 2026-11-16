// Node PB-082 (F3, room 6312): the notes WIRE. Its own gate, ahead of the painter's.
//
// The server has built a seat's "not found" list since fog shipped (view.forSeat: "Moscow has not
// been found."); until PB-082 no room frame carried it, so the page had nothing to print. Three
// things have to hold on the wire, and they are the whole of this file:
//
//   1. a seat's frame carries notes, as a COPY (a reader must not write through to the view);
//   2. a changed notes list forces a FULL frame - a delta has no notes field, so a lost capital
//      would be announced one round late, or never - and that decision is taken before the delta is
//      built;
//   3. the 1942 control: an era with no concealment carries an empty list, so the page prints
//      nothing there.
//
// The lobby's frame builder is closed over sockets and SQLite, so these pins read the source that
// implements it (the way this repo pins its page rules) and a mutant proves each line load-bearing:
// dropping the .slice() reds pin 1, dropping the frameFor arm reds pin 2. The line's clear arm is a
// page rule and lives in pb082_notes.mjs with the painter's gate.
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(message);
}
function ok(message, value) {
  if (!value) fail(message);
}

const LOBBY = readFileSync(new URL("../../server/lobby.mjs", import.meta.url), "utf8");

export const name = "pb082_notes_wire";

export async function run() {
  // --- 1. a seat's frame carries notes, and carries a copy ----------------------------------
  ok("roomView carries the seat's notes",
    LOBBY.includes("notes: seen && Array.isArray(seen.notes) ? seen.notes.slice() : [],"));
  ok("the notes on the wire are a copy, not the view's array",
    !LOBBY.includes("notes: seen && Array.isArray(seen.notes) ? seen.notes : [],"));

  // --- 2. a notes change forces a full frame -------------------------------------------------
  ok("the seat shadow records the notes signature",
    LOBBY.includes("notes: signature(view.notes || []),"));
  const from = LOBBY.indexOf("function frameFor(");
  const frameFor = LOBBY.slice(from, LOBBY.indexOf("function tellRoom("));
  ok("frameFor was found in the lobby source", from > 0 && frameFor.length > 0);
  ok("frameFor returns a full frame when the notes signature moves",
    frameFor.includes('if (last.notes !== signature(view.notes || [])) return { op: "room", room: view };'));
  ok("the notes frame is decided before the delta is built",
    frameFor.indexOf("if (last.notes !==") < frameFor.indexOf("const delta = deltaFor(room, side, view);"));

  // --- 3. the 1942 control ------------------------------------------------------------------
  // No concealment, no notes on the server ("notes: []" in the non-concealed forSeat branch), so a
  // 1942 frame must carry the empty list and nothing else. Pinned where the server writes it.
  const VIEW = readFileSync(new URL("../../server/view.mjs", import.meta.url), "utf8");
  ok("an unconcealed seat's view builds an empty notes list", VIEW.includes("notes: [],"));

  return "wire pins 3: notes carried as a copy, a notes change forces a full frame ahead of the delta, "
    + "the 1942 control carries an empty list";
}
