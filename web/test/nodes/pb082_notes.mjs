// Node PB-082: the note LINE as a page rule - said once, cleared once.
//
// Split from the wire pin (pb082_notes_wire.mjs) because it belongs to the painter's gate, not the
// wire's: this is the page's state machine, driven here with synthetic seat frames and no DOM.
//
// The clear arm, at the level it can be proven honestly: frame A carries ["Moscow has not been
// found."], frame B carries []. The line is said once, held without repeating, and cleared exactly
// once; the frame after the clear is a no-op. The LIVE "found" transition (a blue piece sighting
// Moscow so the server drops the note) is UNPROVEN here: this file never reaches it and no cheat
// route was built to fake it. It is graded live later, in a real match. Whether the 1990 original
// shows that message at all is UNVERIFIED - the line is our UX, not a recovered rule.
import { noteLine, noteStep } from "../../public/notes.mjs";

function fail(message) {
  throw new Error(message);
}
function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

export const name = "pb082_notes";

export async function run() {
  // --- the 1942 control: an unconcealed seat builds no notes ---------------------------------
  eq("a seat with nothing missing has an empty line", noteLine({ notes: [] }), "");
  eq("and the page is told nothing", noteStep("", { notes: [] }), { said: "", say: null, clear: false });

  // --- the clear arm: two synthetic seat frames ----------------------------------------------
  const found = { notes: ["Moscow has not been found."] };
  const gone = { notes: [] };
  let said = "";
  let says = 0;
  let clears = 0;
  const frame = (room) => {
    const step = noteStep(said, room);
    said = step.said;
    if (step.say) says += 1;
    if (step.clear) clears += 1;
    return step;
  };

  eq("frame A says the line once",
    frame(found), { said: "Moscow has not been found.", say: "Moscow has not been found.", clear: false });
  eq("holding the same line says nothing more",
    frame(found), { said: "Moscow has not been found.", say: null, clear: false });
  eq("frame B clears exactly once", frame(gone), { said: "", say: null, clear: true });
  eq("and the frame after that is a no-op", frame(gone), { said: "", say: null, clear: false });
  eq("three frames of the same line said it once", says, 1);
  eq("one frame without the note cleared it once", clears, 1);
  eq("a seat that never had a note is never cleared", noteStep("", gone), { said: "", say: null, clear: false });

  return "the line is said once and cleared once from two synthetic seat frames; "
    + "the live \"found\" transition is UNPROVEN here (graded in a real match)";
}
