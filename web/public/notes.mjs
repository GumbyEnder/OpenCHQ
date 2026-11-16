// The seat's "not found" notes, as a state machine rather than a per-frame print.
//
// The server builds a seat's notes (view.forSeat: "Moscow has not been found.") and PB-082 puts them
// on the wire. The page has to say the line once, keep it while it holds, and take it back down on
// the frame it goes - not print it every frame and not leave a stale banner over a capital the seat
// has since found. Keeping that rule here, out of app.js, is what lets a node test drive it with two
// synthetic seat frames and no DOM (room 6312 item 3).

// The line a room frame asks for, in the server's own words, joined once.
export function noteLine(room) {
  const list = room && Array.isArray(room.notes) ? room.notes.filter(Boolean).map(String) : [];
  return list.join(" ");
}

// One frame's decision. `said` is the line the page currently holds from this rule.
//   { said: <next held line>, say: <text to print, or null>, clear: <true when the line must go> }
// Clearing happens exactly once: after the clear, `said` is "" and the next frame with no notes is a
// no-op. A frame that clears only if this rule owns the line is the caller's job (the flash may be
// carrying somebody else's message), which is why the caller's `said` is the only state here.
export function noteStep(said, room) {
  const line = noteLine(room);
  const held = typeof said === "string" ? said : "";
  if (line === held) return { said: held, say: null, clear: false };
  if (line) return { said: line, say: line, clear: false };
  return { said: "", say: null, clear: held !== "" };
}
