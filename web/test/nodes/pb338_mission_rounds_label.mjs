// pb338_mission_rounds_label — a mission button's VISIBLE label carries the aircraft's away rounds,
// and the number is the briefing's `missions[].rounds`, never a literal typed into the page.
//
// What breaks if this is removed (PM 10488 §2): the Air dialog's footer says "A mission takes the
// aircraft out of action for the rounds shown", but the Air door's buttons printed the mission NAME
// only - the duration lived in a hover title, which a touch player never sees - and Paradrop's title
// is the rule's sentence rather than a figure, so its button showed no duration anywhere on screen.
// The Kit door printed the same fact in a different shape ("(8r)"), which is how the two doors
// drifted apart in the first place.
//
// Arms:
//   (a) the producer's shape: "Strike" + 8 -> "Strike · 8"; the mark is one middle dot with a space
//       on each side, and the number is the mission's own (4 stays 4);
//   (b) no duration to show: rounds 0 (a free rebase per config's stand-in), a missing rounds field,
//       or a non-finite one prints the NAME alone - never "\u00b7 0", "\u00b7 NaN" or "\u00b7 undefined";
//   (c) ONE producer, TWO doors: app.js imports the producer and both doors (the Air table and the
//       Kit panel's mission row) assign `button.textContent = missionButtonLabel(mission)`, with no
//       door left composing its own mission text (no `textContent = mission.label`, no `" (" + ...
//       + "r)"`). A door that keeps its own composer is the defect this pin exists for.
//
// The page leg that grades the pixels - the three widths, the parity against a live seat payload,
// and the mutant that drops the number - is tests/e2e/pb338-air-rounds.mjs.

import { readFileSync } from "node:fs";
import { missionButtonLabel, MISSION_ROUNDS_MARK } from "../../public/airlabels.mjs";

export const name = "pb338_mission_rounds_label";

function fail(message) {
  throw new Error("node test pb338_mission_rounds_label: " + message);
}

function eq(label, actual, expected) {
  if (actual !== expected) fail(label + ": got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}

export function run() {
  // (a) the shape, with the briefing's own numbers.
  eq("(a) the mark is a spaced middle dot", MISSION_ROUNDS_MARK, " \u00b7 ");
  eq("(a) Strike 8", missionButtonLabel({ mode: "strike", label: "Strike", rounds: 8 }), "Strike \u00b7 8");
  eq("(a) Scramble keeps its own number", missionButtonLabel({ mode: "patrol", label: "Scramble (CAP)", rounds: 4 }), "Scramble (CAP) \u00b7 4");
  eq("(a) Paradrop carries its drop rounds", missionButtonLabel({ mode: "drop", label: "Paradrop", rounds: 8 }), "Paradrop \u00b7 8");
  eq("(a) a numeric string is read as a number", missionButtonLabel({ label: "Bomb", rounds: "8" }), "Bomb \u00b7 8");

  // (b) nothing to show -> the name alone, never a made-up figure.
  eq("(b) a zero-priced transfer prints the name alone", missionButtonLabel({ mode: "transfer", label: "Transfer", rounds: 0 }), "Transfer");
  eq("(b) a missing rounds field prints the name alone", missionButtonLabel({ label: "Transfer" }), "Transfer");
  eq("(b) a non-finite rounds field prints the name alone", missionButtonLabel({ label: "Bomb", rounds: "many" }), "Bomb");
  eq("(b) a negative rounds field prints the name alone", missionButtonLabel({ label: "Bomb", rounds: -3 }), "Bomb");
  eq("(b) an absent mission prints nothing rather than 'undefined'", missionButtonLabel(null), "");

  // (c) one producer, two doors, and no file-local composer left behind.
  const app = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  const imports = (app.match(/import \{[^}]*missionButtonLabel[^}]*\} from "\.\/airlabels\.mjs";/g) || []).length;
  if (imports !== 1) fail("(c) app.js should import missionButtonLabel from airlabels.mjs exactly once, found " + imports);
  const calls = (app.match(/button\.textContent = missionButtonLabel\(mission\);/g) || []).length;
  if (calls !== 2) fail("(c) both mission doors (Air table + Kit row) must assign missionButtonLabel(mission); found " + calls + " call sites");
  if (/textContent = mission\.label/.test(app)) fail("(c) a door still prints the bare mission.label, so its rounds are invisible");
  if (/mission\.label \+ " \(" \+ mission\.rounds/.test(app)) fail("(c) a door still composes its own '(Nr)' text instead of using the shared producer");
}
