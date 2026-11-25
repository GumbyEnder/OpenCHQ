// Node test: PB-248 — a film closes on EVERY transition to `over`, not only inside a tick.
//
// The defect this pins (frodo 9162, PM 9159): `finishFilm` was reachable only from the round loop's
// `recordFilm`, and that loop skips a room whose match is already over. So every ending that happens
// OUTSIDE a tick — a resignation, an accepted cease-fire, a nuclear winter — left the header open:
// `ended_at` null, `final_digest` null, and `listFor` (which requires `ended_at`) never showed the
// war. On live that was 724 open headers and zero finished films.
//
// One class per ending, each on a real room and a real match object, plus the guards that make the
// seam safe: a second close cannot move the digest or add a frame, a header with no film is not
// invented, and the repair closes only what the store can PROVE was finished.
//
// Obligations, one per block below:
//   1. resign: ended_at + final_digest set, rounds == match.round, last frame carries state, and that
//      state hashes to the recorded digest (AC1 of step 1, re-proved for the out-of-tick path);
//   2. cease-fire: the accepted event is IN the closing frame (the film's log keeps the sentence);
//   3. nuclear winter: the tool's queued events ride into the closing frame, and the queue is drained;
//   4. capital capture (the tick path): the frame written by recordFilm keeps its events and its
//      state, and the digest still matches;
//   5. idempotency: a second close changes neither digest nor frame count, and a room with no header
//      gains none;
//   6. restore: armRestoredFilm closes an over match's stranded header instead of re-arming it, and
//      still re-arms a live one.
//
// There is no repair arm here any more: PM 9189 §1a deleted repairStrandedFilms (frodo 9183 §3 - it
// was never wired, and it closed none of live's 731). The endings this file drives at the helper are
// pinned THROUGH the lobby by t031_seams, which is where a removed seam actually reds.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "t031_lifecycle";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function ok(value, label) {
  if (!value) fail(label);
}

export async function run() {
  const history = await import("../../server/history.mjs");
  const { openMatch } = await import("../../server/match.mjs");
  const { matchSites } = await import("../../server/board.mjs");

  const dir = mkdtempSync(path.join(tmpdir(), "openchq-t031-life-"));
  const handle = new DatabaseSync(path.join(dir, "openchq.sqlite"));
  handle.exec("PRAGMA journal_mode = WAL");
  history.ensureHistorySchema(handle);

  const makeRoom = (id) => {
    const match = openMatch("1942", matchSites("1942"));
    match.round = 4;
    return {
      id,
      seats: { blue: { username: "ada", kind: "human" }, red: { username: "grace", kind: "human" } },
      match,
    };
  };

  const lastFrame = (id) => {
    const frames = history.framesOf(id, handle);
    return frames.length ? frames[frames.length - 1].frame : null;
  };
  const header = (id) => history.filmMeta(id, handle);

  // ---- 1. resign ---------------------------------------------------------------
  {
    const room = makeRoom("life-resign");
    ok(history.startFilm(room, handle), "the film starts");
    history.appendFrame(room, [{ type: "income", amount: 3, round: 3 }], handle);
    room.match.over = true;
    room.match.winner = "blue";
    room.match.winReason = { kind: "resignation", side: "red", round: 4 };
    const closed = history.closeFilm(room, [], handle);
    ok(closed && !closed.already, "the resigning room's film closes: " + JSON.stringify(closed));
    const row = header("life-resign");
    ok(row.ended_at, "ended_at is set");
    ok(row.final_digest, "final_digest is set");
    eq(Number(row.rounds), room.match.round, "rounds is the match's own round");
    const frame = lastFrame("life-resign");
    ok(frame && frame.state, "the last frame carries the closing state");
    eq(history.digestOf(frame.state), row.final_digest, "the last frame hashes to the recorded digest");
    eq(frame.state.winner, "blue", "the closing state carries the winner");
    eq(frame.state.winReason.kind, "resignation", "the closing state carries the reason");
  }

  // ---- 2. cease-fire ----------------------------------------------------------
  {
    const { answerCeasefire } = await import("../../server/late.mjs");
    const room = makeRoom("life-ceasefire");
    history.startFilm(room, handle);
    // The engine's OWN transition: a pending offer answered by the other seat sets over/winner/
    // winReason and hands back the event the closing frame must carry.
    room.match.ceasefire = { status: "pending", by: "blue", round: 3, answeredRound: null };
    const answered = answerCeasefire(room.match, "red", true);
    ok(answered && answered.accepted, "the engine accepts the cease-fire: " + JSON.stringify(answered && answered.error));
    ok(room.match.over === true, "answerCeasefire sets over");
    const events = answered.events;
    ok(history.closeFilm(room, events, handle), "the cease-fire room's film closes");
    const frame = lastFrame("life-ceasefire");
    eq(frame.events.map((event) => event.type), ["ceasefire_accepted"], "the closing frame carries the accepted event");
    eq(history.digestOf(frame.state), header("life-ceasefire").final_digest, "digest matches after a cease-fire");
    eq(header("life-ceasefire").winner, "", "a cease-fire records no winner");
  }

  // ---- 3. nuclear winter ------------------------------------------------------
  {
    const room = makeRoom("life-winter");
    history.startFilm(room, handle);
    room.match.over = true;
    room.match.winner = null;
    room.match.winReason = { kind: "nuclear_winter", detonated: 10, round: 4 };
    room.match.pendingEvents = [
      { type: "nuke", side: "blue", round: 4, launched: 10, detonated: 10 },
      { type: "nuclear_winter", side: null, round: 4, detonated: 10 },
    ];
    ok(history.closeFilm(room, [], handle), "the winter room's film closes");
    const frame = lastFrame("life-winter");
    eq(frame.events.map((event) => event.type), ["nuke", "nuclear_winter"],
      "the queued nuke events ride into the closing frame");
    eq(room.match.pendingEvents.length, 0, "the queue is drained by the close");
    eq(history.digestOf(frame.state), header("life-winter").final_digest, "digest matches after a winter");
  }

  // ---- 4. capital capture on the tick path (recordFilm's own shape) ------------
  {
    const room = makeRoom("life-capitals");
    history.startFilm(room, handle);
    const tickEvents = [{ type: "capture", site: 3, side: "red", round: 4 }];
    room.match.over = true;
    room.match.winner = "red";
    room.match.winReason = { kind: "capitals", side: "red", siteId: 3, round: 4 };
    history.appendFrame(room, tickEvents, handle);
    ok(history.closeFilm(room, [], handle), "the capital-capture film closes");
    const frame = lastFrame("life-capitals");
    eq(frame.events.map((event) => event.type), ["capture"], "the tick's own events survive the close");
    eq(history.digestOf(frame.state), header("life-capitals").final_digest, "digest matches after a capture");
  }

  // ---- 5. idempotency ---------------------------------------------------------
  {
    const room = makeRoom("life-idempotent");
    history.startFilm(room, handle);
    room.match.over = true;
    room.match.winner = "blue";
    room.match.winReason = { kind: "resignation", side: "red", round: 4 };
    const first = history.closeFilm(room, [], handle);
    const digest = first.digest;
    const frames = history.framesOf("life-idempotent", handle).length;
    // A later state must not be allowed to move the recorded digest.
    room.match.round = 99;
    room.match.winner = "red";
    const second = history.closeFilm(room, [{ type: "late" }], handle);
    eq(second.already, true, "a second close reports already");
    eq(header("life-idempotent").final_digest, digest, "a second close cannot overwrite the digest");
    eq(history.framesOf("life-idempotent", handle).length, frames, "a second close adds no frame");

    // A room with no header gains none: the seam never invents a film.
    const ghost = makeRoom("life-ghost");
    ghost.match.over = true;
    eq(history.closeFilm(ghost, [], handle), null, "a room with no film returns null");
    eq(header("life-ghost"), null, "no header is invented");

    // An unfinished match is not closed, whatever the room asks.
    const live = makeRoom("life-live");
    history.startFilm(live, handle);
    eq(history.closeFilm(live, [], handle), null, "a live match is not closed");
    eq(header("life-live").ended_at, null, "the live header stays open");
  }

  // ---- 6. restore -------------------------------------------------------------
  {
    // A match restored after its war ended: the stranded header is closed, not re-armed.
    const over = makeRoom("restore-over");
    history.startFilm(over, handle);
    const restored = makeRoom("restore-over");
    restored.match.over = true;
    restored.match.winner = "red";
    restored.match.winReason = { kind: "capitals", side: "red", round: 4 };
    eq(history.armRestoredFilm(restored, handle), false, "an over match is not re-armed");
    ok(header("restore-over").final_digest, "the over match's stranded header is closed on restore");
    eq(history.digestOf(lastFrame("restore-over").state), header("restore-over").final_digest,
      "the restored close still hashes to its frame");

    // A live match restores its film and keeps recording.
    const live = makeRoom("restore-live");
    history.startFilm(live, handle);
    const back = makeRoom("restore-live");
    eq(history.armRestoredFilm(back, handle), true, "a live match re-arms its film");
    eq(back.film, true, "the flag is set");
    eq(header("restore-live").ended_at, null, "the live header stays open");
  }

  handle.close();
}
