// Node test: T-031 step 3 — the film view model (the four Show toggles and the transport).
//
// The original's War Films (manual p.35, p.38) let a player watch a saved film and toggle Show Red,
// Show Blue, Show Common, Show Both. Those four words are the whole AC for the view half of step 3,
// so they are pinned here against a frame built the way `history.appendFrame` builds one:
//   - Show Both paints every side's units and every side's ownership (the fog-off view);
//   - Show Blue / Show Red paint ONE side's units, and only the ground that side holds - the other
//     ground reads neutral, never the enemy's colour;
//   - Show Common paints the ground alone: no units, no ownership;
//   - a frame's strength lands on the piece, and a frame with no strength entry leaves it alone;
//   - the closing frame carries the result the live seat read, and only the closing frame does;
//   - the transport clamps, steps and stops playing; speed is a fixed table.
//
// What fails if the model is removed: the four toggles become page-side paint flags that can drift
// from the recorded frame, a replay shows the enemy's ground under "Show Blue", and a film's end
// screen stops being the sentence the war ended with.

import {
  FILM_SHOWS,
  FILM_SPEEDS,
  emptyFilm,
  filmEventRows,
  filmNote,
  filmRoomAt,
  frameCount,
  frameDelayMs,
  nextSpeed,
  showKeepsPiece,
  showPaintsOwner,
  stepFilm,
  toggleShow,
} from "../../public/film.mjs";

export const name = "t031_film_view";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function film() {
  const start = {
    era: "1942",
    mode: "human",
    round: 0,
    pieces: [
      { id: "blue:infantry:1", side: "blue", x: 10, y: 10, strength: 100 },
      { id: "blue:tank:1", side: "blue", x: 11, y: 10, strength: 100 },
      { id: "red:infantry:1", side: "red", x: 40, y: 20, strength: 100 },
    ],
    sites: [
      { id: 1, name: "A", kind: "city", owner: "blue" },
      { id: 2, name: "B", kind: "city", owner: "red" },
      { id: 3, name: "C", kind: "city", owner: null },
    ],
    capitals: { blue: { x: 10, y: 10 }, red: { x: 40, y: 20 } },
    capitalList: [{ name: "A", owner: "blue" }],
  };
  const at = emptyFilm();
  at.meta = { id: "film-1", era: "1942" };
  at.start = start;
  at.frames = [
    { round: 1, clock: "running", events: [{ type: "shot", round: 1, note: "a shot" }], strengths: { "blue:infantry:1": 82 }, owners: [[1, "blue"], [2, "red"], [3, null]] },
    { round: 2, clock: "running", events: [{ type: "destroyed", round: 2, note: "red infantry was destroyed" }], strengths: { "blue:infantry:1": 61, "red:infantry:1": 0 }, owners: [[1, "blue"], [2, "blue"], [3, null]] },
    {
      round: 3,
      clock: "held",
      events: [{ type: "ceasefire_accepted", round: 3, note: "Cease fire accepted. The war is over." }],
      strengths: {},
      owners: [[1, "blue"], [2, "blue"], [3, null]],
      state: { era: "1942", over: true, winner: null, winReason: { kind: "ceasefire", by: "blue", round: 3 }, round: 3, capitalList: [{ name: "A", owner: "blue" }] },
    },
  ];
  return at;
}

export async function run() {
  // ---- the four toggles, as a set of words and as a rule ------------------------------------
  eq(FILM_SHOWS, ["both", "blue", "red", "common"], "the four shows, in the original's order");
  eq(showKeepsPiece("both", "red"), true, "both keeps every side");
  eq(showKeepsPiece("blue", "red"), false, "blue hides red's units");
  eq(showKeepsPiece("common", "blue"), false, "common hides both sides' units");
  eq(showPaintsOwner("blue", "red"), null, "blue does not paint red's ground");
  eq(showPaintsOwner("blue", "blue"), "blue", "blue paints its own ground");
  eq(showPaintsOwner("common", "blue"), null, "common paints no ownership");

  const f = film();
  const both = filmRoomAt(f, 0, "both");
  eq(both.pieces.length, 3, "Show Both paints every piece");
  eq(both.pieces[1].strength, 100, "a piece with no entry keeps its start strength");
  eq(both.pieces[0].strength, 82, "a recorded strength lands on the piece");
  eq(both.sites.map((s) => s.owner), ["blue", "red", null], "Show Both paints every owner as recorded");
  eq(both.round, 1, "the room's round is the frame's round");
  eq(both.you, null, "a film has no seat: it is the fog-off view");
  eq(both.over, false, "a middle frame is not over");

  const blue = filmRoomAt(f, 0, "blue");
  eq(blue.pieces.map((p) => p.id), ["blue:infantry:1", "blue:tank:1"], "Show Blue keeps blue's units only");
  eq(blue.sites.map((s) => s.owner), ["blue", null, null], "Show Blue paints only blue's ground");

  const red = filmRoomAt(f, 0, "red");
  eq(red.pieces.map((p) => p.id), ["red:infantry:1"], "Show Red keeps red's units only");
  eq(red.sites.map((s) => s.owner), [null, "red", null], "Show Red paints only red's ground");

  const common = filmRoomAt(f, 0, "common");
  eq(common.pieces.length, 0, "Show Common paints no units");
  eq(common.sites.map((s) => s.owner), [null, null, null], "Show Common paints no ownership");
  eq(common.sites.length, 3, "Show Common still paints the ground");

  // Ownership flips with the frame: site 2 turns blue at round 2 in both views.
  eq(filmRoomAt(f, 1, "both").sites.map((s) => s.owner), ["blue", "blue", null], "ownership flips with the frame");

  // ---- the closing frame is the end screen --------------------------------------------------
  const last = filmRoomAt(f, 2, "both");
  eq(last.over, true, "the frame that ended the war says so");
  eq(last.result.reason, "ceasefire", "the film's end reason is the recorded one");
  eq(last.result.winner, null, "a truce names no winner in the film either");
  eq(last.result.ceasefire.by, "blue", "the film names who offered the truce");
  eq(filmRoomAt(f, 0, "both").result, null, "no earlier frame carries a result");

  // ---- the log is the recorded events, not a re-description ---------------------------------
  const rows = filmEventRows(f.frames[1]);
  eq(rows.length, 1, "one recorded event, one line");
  eq(rows[0].text, "red infantry was destroyed", "the line is the event's own sentence");
  eq(rows[0].round, 2, "the line carries the event's own round");

  // ---- transport ----------------------------------------------------------------------------
  eq(frameCount(f), 3, "frame count");
  eq(stepFilm(f, 1).at, 1, "step forward");
  eq(stepFilm(f, 1).at, 2, "step to the last frame");
  eq(stepFilm(f, 1).at, 2, "step past the end is clamped");
  eq(stepFilm(f, -5).at, 0, "step before the start is clamped");
  eq(f.playing, false, "a manual step stops playback");
  f.at = 0;
  eq(toggleShow(f, "red").show, "red", "the show can be switched");
  eq(toggleShow(f, "nonsense").show, "red", "an unknown show is ignored, not painted");
  eq(FILM_SPEEDS, [0.5, 1, 2, 4], "the speed table");
  eq(nextSpeed(1), 2, "speed cycles up");
  eq(nextSpeed(4), 0.5, "speed wraps");
  eq(frameDelayMs(1), 1000, "1x is one frame a second");
  eq(frameDelayMs(4), 250, "4x is four a second");
  if (!/round 1 of 3|round 2 of 3/.test(filmNote(f, f.frames[0], "both"))) {
    fail("the film's note does not name its round and frame count: " + filmNote(f, f.frames[0], "both"));
  }
}
