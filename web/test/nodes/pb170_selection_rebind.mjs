// PB-170 node: the selected piece is re-bound to the current room frame by id.
//
// The defect: `selected = intent.piece` stored an OBJECT out of one room frame. The server replaces
// room.pieces every frame, so that object froze at the moment of the click — the board note went on
// saying the aircraft was away (and "Ready to fly" while it was away, in the other direction) because
// `selected.inactive` never changed again. The note itself (airNote) was always right about the piece
// it was given; the piece it was given was simply from an old frame.
//
// What is measured here:
//   1. refreshSelection returns the CURRENT frame's piece (a different object, same id);
//   2. the note built off that piece counts down ("Away on a mission: 8 rounds") and reads
//      "Ready to fly" at 0;
//   3. the stale object still reads "Ready to fly" while the plane is away — the failure mode;
//   4. an id that is no longer in the frame selects nothing, and a selection with no id is dropped.
export const name = "pb170_selection_rebind";

import { airNote, refreshSelection } from "../../public/command.mjs";

function eq(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

export async function run() {
  // The click snapshot: the plane was ready when it was clicked.
  const clicked = { id: "blue:aircraft:1", side: "blue", domain: "air", kind: "aircraft", inactive: 0 };
  // The frame that follows the mission: the server says it is away for 8 rounds.
  const away = { id: "blue:aircraft:1", side: "blue", domain: "air", kind: "aircraft", inactive: 8 };

  if (airNote(clicked).includes("Away")) throw new Error("the clicked snapshot already reads away");
  if (!airNote(away).includes("8 rounds")) throw new Error("the current frame does not read 8 rounds: " + airNote(away));

  const rebound = refreshSelection([away], clicked);
  if (rebound !== away) throw new Error("refreshSelection did not return the current frame's own object");
  eq("the rebound note counts down", airNote(rebound), "Away on a mission: 8 rounds until it can fly again.");
  // The stale object is the defect: the note has no way to know the plane has gone.
  if (!airNote(clicked).includes("Ready to fly")) throw new Error("the stale snapshot is not the 'Ready to fly' failure");

  // The countdown is the frame's number, not a page-side subtraction: 1 round, then 0.
  eq("one round left", airNote(refreshSelection([{ ...away, inactive: 1 }], clicked)),
    "Away on a mission: 1 round until it can fly again.");
  const ready = refreshSelection([{ ...away, inactive: 0 }], clicked);
  if (!airNote(ready).includes("Ready to fly")) throw new Error("a returned aircraft does not read ready: " + airNote(ready));

  // A piece that left the board, and a selection that never had an id.
  eq("a piece gone from the frame selects nothing", refreshSelection([{ ...away, id: "blue:aircraft:2" }], clicked), null);
  eq("an empty frame selects nothing", refreshSelection(null, clicked), null);
  eq("a selection with no id is dropped", refreshSelection([away], { kind: "aircraft" }), null);
  // Ids are compared as strings: the wire carries one and the page another.
  const numeric = refreshSelection([{ ...away, id: "7" }], { ...clicked, id: 7 });
  if (!numeric || String(numeric.id) !== "7") throw new Error("a numeric selected id did not match its string form");

  console.log("pb170_selection_rebind: the selection follows the frame, so the note counts down and reads ready at 0");
}
