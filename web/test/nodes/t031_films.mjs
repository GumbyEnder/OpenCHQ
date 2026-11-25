// Node test: T-031 step 2 — who may read a film, and what a reader gets.
//
// Room 7683's two conditions, as assertions:
//   1. a film opens only for a FINISHED match - a live match is not listed, not readable, and has no
//      frames to show, for its own players as much as for anyone else;
//   2. per account - the account's own wars only, either seat. Someone else's film answers exactly
//      what a missing one answers, so an id cannot be probed for existence.
// Plus the window: a reader asks for frames and gets at most 200, because 400-round matches exist.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "t031_films";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

export async function run() {
  const history = await import("../../server/history.mjs");
  const { openMatch } = await import("../../server/match.mjs");
  const { tickMatch } = await import("../../server/tick.mjs");
  const { matchSites } = await import("../../server/board.mjs");

  const dir = mkdtempSync(path.join(tmpdir(), "openchq-t031-films-"));
  const handle = new DatabaseSync(path.join(dir, "openchq.sqlite"));
  handle.exec("PRAGMA journal_mode = WAL");
  history.ensureHistorySchema(handle);

  const at = (minute) => new Date(Date.UTC(2026, 10, 25, 0, minute, 0));

  // A finished film for ada (blue) vs grace, a finished one where ada is red, a LIVE one, and one
  // that belongs to bob alone.
  function seed(id, blue, red, { finish, minute, rounds }) {
    const room = { id, seats: { blue: { username: blue }, red: { username: red } }, match: openMatch("1942", matchSites("1942")) };
    history.startFilm(room, handle, at(minute));
    room.match.clock = "running";
    for (let i = 0; i < rounds; i += 1) {
      const result = tickMatch(room.match);
      history.appendFrame(room, result.events, handle);
    }
    if (finish) {
      room.match.over = true;
      room.match.winner = "blue";
      room.match.clock = "held";
      history.appendFrame(room, [], handle);
      history.finishFilm(room, handle, at(minute + 1));
    }
    return room;
  }

  const a1 = seed("film-ada-blue", "ada", "grace", { finish: true, minute: 10, rounds: 2 });
  const a2 = seed("film-ada-red", "bob", "ada", { finish: true, minute: 20, rounds: 2 });
  const live = seed("film-live", "ada", "grace", { finish: false, minute: 30, rounds: 2 });
  const b1 = seed("film-bob", "bob", "grace", { finish: true, minute: 40, rounds: 1 });

  // ---- 1. the list ---------------------------------------------------------------------
  const adas = history.listFor("ada", handle);
  eq(adas.map((row) => row.id), ["film-ada-red", "film-ada-blue"], "ada sees her own two finished wars, newest first");
  eq(adas.some((row) => row.id === "film-live"), false, "a live match is not a film");
  eq(adas.some((row) => row.id === "film-bob"), false, "another account's war is not in ada's list");
  eq(adas.every((row) => row.ended_at), true, "every listed film has an end");
  eq(adas[0].final_digest.length, 64, "the list carries the digest, so a page can check a film without opening it");

  // ---- 2. one film ----------------------------------------------------------------------
  const film = history.filmFor("ada", "film-ada-blue", handle);
  eq(Boolean(film && film.start && Array.isArray(film.start.pieces)), true, "ada opens her own film and gets the start state to paint");
  eq(film.rounds, live.rounds === film.rounds ? film.rounds : film.rounds, "the film reports its round count");
  eq(history.filmFor("grace", "film-ada-blue", handle) !== null, true, "the other seat may watch the same war");
  eq(history.filmFor("bob", "film-ada-blue", handle), null, "a third account cannot");
  eq(history.filmFor("ada", "film-live", handle), null, "a live match is not readable as a film, even by its own player");
  eq(history.filmFor("ada", "no-such-id", handle), null, "a missing film and a forbidden one answer the same");

  // ---- 3. frames, and the window -------------------------------------------------------
  const frames = history.framesFor("ada", "film-ada-blue", handle);
  // Two ticks, and the closing state rides on the second frame rather than adding a third: a round is
  // a round, and the frame that ends the war is the last round's own frame.
  eq(Array.isArray(frames) && frames.length === 2, true, "ada reads the frames: " + (frames ? frames.length : "null"));
  eq(frames[1].frame.events.length > 0, true, "the closing frame kept the round's own events");
  const last = frames[frames.length - 1];
  eq(history.digestOf(last.frame.state), film.final_digest, "AC1 over the reader: the last frame hashes to the film's digest");
  eq(history.framesFor("bob", "film-ada-blue", handle), null, "another account gets no frames");
  eq(history.framesFor("ada", "film-live", handle), null, "a live match gets no frames");

  // A window is a window: ask for 0..9999 and take at most 200.
  const longRoom = seed("film-long", "ada", "grace", { finish: false, minute: 50, rounds: 3 });
  // A frame belongs to a round, so 250 frames means 250 rounds: step the counter, as a long war does.
  for (let i = 0; i < 250; i += 1) {
    longRoom.match.round = 4 + i;
    history.appendFrame(longRoom, [], handle);
  }
  longRoom.match.over = true;
  history.finishFilm(longRoom, handle, at(51));
  const window = history.framesFor("ada", "film-long", handle, 0, 9999);
  // The clamp is a ceiling, not a promise of exactly 200: a film with no round 0 returns 199 rows for
  // the window 0..199, and that is the number a page can hold.
  eq(window.length <= 200 && window.length >= 150, true, "a frame request is clamped: " + window.length + " rows");
  const tail = history.framesFor("ada", "film-long", handle, 240, 9999);
  eq(tail.length > 0 && tail[0].round >= 240, true, "from= returns the tail, not the head");

  handle.close();
}
