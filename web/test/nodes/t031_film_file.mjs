// Node test: T-031 step 3 §4 (i) and (ii) — the digest the client shows, and the .film file.
//
// (i) The page recomputes the digest of the film's LAST frame and compares it with the header's
//     finalDigest, so a film whose closing frame disagrees with its recorded digest is VISIBLE. The
//     same object must hash to the same bytes on both sides: this test pins the page's canonical JSON
//     to the server's `digestOf` over one fixture, so a drift in either sort order reds here.
// (ii) A film saved as a .film file and loaded back must give the SAME digest; a file that is not an
//     OpenCHQ film, is the wrong version, has no frames, or has been edited on disk must be refused or
//     must fail the check - never quietly pass.
//
// The closing state here is built by the server's own `finalStateOf` over a real match, so the fixture
// is the object the recorder actually stores, not a hand-typed shape.

import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "t031_film_file";

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
  const filmModel = await import("../../public/film.mjs");

  const dir = mkdtempSync(path.join(tmpdir(), "openchq-t031-file-"));
  const handle = new DatabaseSync(path.join(dir, "openchq.sqlite"));
  handle.exec("PRAGMA journal_mode = WAL");
  history.ensureHistorySchema(handle);

  const match = openMatch("1986", matchSites("1986"));
  match.round = 3;
  match.over = true;
  match.winner = "blue";
  match.winReason = { kind: "resignation", side: "red", round: 3 };
  const room = {
    id: "file-film-1",
    seats: { blue: { username: "ada", kind: "human" }, red: { username: "grace", kind: "human" } },
    match,
  };
  history.startFilm(room, handle);
  history.appendFrame(room, [{ type: "income", amount: 2, round: 2 }], handle);
  const closed = history.closeFilm(room, [{ type: "resignation", side: "red", round: 3 }], handle);
  ok(closed && closed.digest, "the fixture film closes with a digest");

  const meta = history.filmMeta("file-film-1", handle);
  const frames = history.framesOf("file-film-1", handle).map((row) => row.frame);
  const film = { meta, start: meta.start || {}, frames, at: 0, playing: false, speed: 1, show: "both" };

  // ---- 1. one canonical form, one digest ---------------------------------------
  const state = frames[frames.length - 1].state;
  ok(state, "the closing frame carries a state");
  eq(filmModel.canonicalJson(state), history.canonicalJson(state), "the page's canonical JSON is the server's");
  eq(await filmModel.digestOf(state), history.digestOf(state), "the page's digest is the server's");
  eq(await filmModel.digestOf({ b: 1, a: [2, { d: 4, c: 3 }] }),
    history.digestOf({ a: [2, { c: 3, d: 4 }], b: 1 }), "key order does not change the digest");

  // ---- 2. the check the page shows ---------------------------------------------
  const good = await filmModel.digestCheck(film);
  eq(good.ok, true, "a real film's last frame verifies against its recorded digest");
  eq(good.expected, closed.digest, "the expected digest is the header's");
  eq(good.actual, closed.digest, "the computed digest agrees");
  eq(filmModel.digestText(good), "digest verified", "the bar says verified");

  const tampered = { ...film, frames: frames.map((frame, i) => (i === frames.length - 1
    ? { ...frame, state: { ...frame.state, winner: "red" } }
    : frame)) };
  const bad = await filmModel.digestCheck(tampered);
  eq(bad.ok, false, "a tampered closing frame does not verify");
  eq(filmModel.digestText(bad), "DIGEST MISMATCH", "the bar says MISMATCH");
  ok(bad.actual && bad.actual !== bad.expected, "the mismatch names two different digests");

  const noState = { ...film, frames: frames.slice(0, -1) };
  const blunt = await filmModel.digestCheck(noState);
  eq(blunt.ok, false, "a film with no closing frame does not verify");
  eq(filmModel.digestText(blunt), "digest unverified", "an unproven film is not called verified");

  const noDigest = { ...film, meta: { ...meta, final_digest: null } };
  eq((await filmModel.digestCheck(noDigest)).ok, false, "a header with no digest cannot verify");

  // ---- 3. save and load a .film file -------------------------------------------
  const envelope = filmModel.filmEnvelope(film);
  ok(envelope && envelope.format === filmModel.FILM_FILE_FORMAT, "the file carries the format marker");
  eq(envelope.version, filmModel.FILM_FILE_VERSION, "the file carries the version");
  eq(envelope.film.frames.length, frames.length, "every frame is in the file");
  eq(envelope.film.meta.finalDigest, closed.digest, "the file carries the recorded digest");
  ok(/\.film$/.test(filmModel.filmFileName(film)), "the download name ends .film: " + filmModel.filmFileName(film));

  const back = filmModel.filmFromEnvelope(JSON.stringify(envelope));
  ok(back.film && !back.error, "the file loads back: " + JSON.stringify(back.error || "ok"));
  eq(back.film.frames.length, frames.length, "the re-imported film has every frame");
  const reimported = await filmModel.digestCheck(back.film);
  eq(reimported.ok, true, "the re-imported film verifies");
  eq(reimported.actual, good.actual, "the re-imported film gives the SAME digest");
  eq(back.film.at, 0, "a loaded film opens at its first frame");

  // ---- 4. refusals name the defect ---------------------------------------------
  const notJson = filmModel.filmFromEnvelope("this is not json");
  ok(/not JSON/.test(notJson.error), "a non-JSON file is refused by name: " + notJson.error);
  const notFilm = filmModel.filmFromEnvelope(JSON.stringify({ hello: "world" }));
  ok(/not an OpenCHQ film/.test(notFilm.error), "a non-film JSON is refused by name: " + notFilm.error);
  const wrongVersion = filmModel.filmFromEnvelope(JSON.stringify({ ...envelope, version: 99 }));
  ok(/version 99/.test(wrongVersion.error), "a future version is refused by number: " + wrongVersion.error);
  const noFrames = filmModel.filmFromEnvelope(JSON.stringify({ ...envelope, film: { ...envelope.film, frames: [] } }));
  ok(/no frames/.test(noFrames.error), "an empty film is refused by name: " + noFrames.error);
  // An edited file still PARSES; the digest is what refuses it.
  const edited = JSON.parse(JSON.stringify(envelope));
  edited.film.frames[edited.film.frames.length - 1].state.winner = "red";
  const editedRead = filmModel.filmFromEnvelope(JSON.stringify(edited));
  ok(editedRead.film && !editedRead.error, "an edited file still parses (the digest is the guard)");
  eq((await filmModel.digestCheck(editedRead.film)).ok, false, "an edited file does not verify");

  handle.close();
}
