// Node test: T-031 step 1 — the War Films recorder (schema, frames, end digest, cap accounting).
//
// What this pins, one line per obligation:
//   1. the schema exists in whatever handle is passed (the production caller passes the rooms' own
//      WAL database; the test passes its own file, so a run never touches a player's data);
//   2. a film starts with the state a replay needs to paint round 0, and its seats;
//   3. one frame per tick, carrying the tick's OWN events - the same objects, same order (AC2's
//      seed: a replay line is the live Log's source, not a re-description);
//   4. the end digest is the canonical hash of the final state, written once; a second finish call
//      cannot overwrite it (AC1: the last replay frame must hash to this);
//   5. the digest does not depend on object insertion order;
//   6. the cap is env-driven and defaults to 20 GB; usage counts REAL FILE BYTES (sqlite + wal + shm),
//      and the film blobs are counted once, inside the file, not a second time.
//
// Pruning is step 2 and is not tested here because it does not exist yet - the commit says why.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "t031_history";

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
  const { createHash } = await import("node:crypto");

  const dir = mkdtempSync(path.join(tmpdir(), "openchq-t031-"));
  const handle = new DatabaseSync(path.join(dir, "openchq.sqlite"));
  handle.exec("PRAGMA journal_mode = WAL");

  // ---- 1. schema ----------------------------------------------------------------------
  eq(history.ensureHistorySchema(handle), 1, "the schema version");
  const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  eq(tables.includes("matches") && tables.includes("match_rounds"), true, "both history tables exist: " + tables.join(","));
  const indexes = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((row) => row.name);
  eq(indexes.includes("matches_blue") && indexes.includes("matches_red"), true, "the two account indexes exist");

  // ---- 2. a film starts ---------------------------------------------------------------
  const match = openMatch("1942", matchSites("1942"));
  const room = {
    id: "film-test-1",
    seats: { blue: { username: "ada", kind: "human" }, red: { username: "grace", kind: "human" } },
    match,
  };
  const started = history.startFilm(room, handle, new Date("2026-11-25T00:00:00.000Z"));
  eq(Boolean(started && started.bytes > 0), true, "the start state was gzipped and stored");
  const meta = history.filmMeta(room.id, handle);
  eq([meta.blue_user, meta.red_user, meta.era, meta.ended_at], ["ada", "grace", "1942", null], "the film's header");
  eq(Boolean(meta.start && Array.isArray(meta.start.pieces) && Array.isArray(meta.start.sites)), true,
    "the start state unpacks to pieces and sites a replay can paint");

  // ---- 3. one frame per tick, carrying the tick's own events ---------------------------
  // A freshly opened match is held until a seat launches it; the clock is the only gate tickMatch
  // reads before it advances a round.
  match.clock = "running";
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    const before = match.round;
    const result = tickMatch(match);
    if (match.round === before) break;
    const frame = history.appendFrame(room, result.events, handle);
    seen.push({ round: frame.round, events: result.events });
    if (match.over) break;
  }
  if (seen.length === 0) fail("the scripted match produced no ticks to record");
  const frames = history.framesOf(room.id, handle);
  eq(frames.length, seen.length, "one frame per tick");
  for (let i = 0; i < frames.length; i += 1) {
    eq(frames[i].round, seen[i].round, "frame " + i + " carries the tick's round");
    // The frame is stored as canonical JSON, so keys come back sorted: compare canonically, which is
    // byte-identity by content rather than by insertion order.
    eq(history.canonicalJson(frames[i].frame.events), history.canonicalJson(seen[i].events),
      "frame " + i + " carries the tick's own events, verbatim");
  }
  const last = frames[frames.length - 1];
  eq(Object.keys(last.frame).sort(), ["clock", "events", "owners", "round", "strengths"], "the frame's shape");

  // ---- 4. the end digest --------------------------------------------------------------
  match.over = true;
  match.winner = "blue";
  match.clock = "held";
  // The round a match ended on is appended WITH its state, which is what AC1 hashes.
  history.appendFrame(room, [], handle);
  const ended = history.finishFilm(room, handle, new Date("2026-11-25T01:00:00.000Z"));
  const expected = createHash("sha256").update(history.canonicalJson(history.finalStateOf(match))).digest("hex");
  eq(ended.digest, expected, "the recorded digest is the canonical hash of the final state");

  // ---- AC1: the last replay frame hashes to the recorded digest ------------------------
  const framesAfter = history.framesOf(room.id, handle);
  const lastFrame = framesAfter[framesAfter.length - 1];
  eq(Boolean(lastFrame.frame.state), true, "the closing frame carries the state the digest is taken over");
  eq(history.digestOf(lastFrame.frame.state), ended.digest,
    "AC1: the last replay frame's canonical hash equals the final_digest written when the match ended");
  // And the earlier frames do not pay for it: no state before the closing round.
  const earlierWithState = framesAfter.slice(0, -1).filter((row) => row.frame.state);
  eq(earlierWithState.length, 0, "a mid-match frame carries no full state");
  const again = history.finishFilm(room, handle);
  eq(again.already === true && again.digest === ended.digest, true, "a second finish call cannot overwrite the digest");
  const row = handle.prepare("SELECT ended_at, winner, rounds, stored_bytes, final_digest FROM matches WHERE id = ?").get(room.id);
  eq([row.winner, row.rounds, row.final_digest], ["blue", match.round, ended.digest], "the row closed with the winner and round count");
  eq(Number(row.stored_bytes) >= Number(ended.bytes) - 1, true, "stored_bytes covers the frames and the final state");

  // AC1's shape, stated as a test: a replay that re-derives the final state from the last frame and
  // the start would need the same hash. Here the store itself is what the hash came from.
  eq(typeof ended.digest === "string" && ended.digest.length === 64, true, "the digest is a sha256 hex string");

  // ---- 5. order independence ----------------------------------------------------------
  const a = { z: 1, a: { y: [1, 2], b: 3 } };
  const b = { a: { b: 3, y: [1, 2] }, z: 1 };
  eq(history.digestOf(a), history.digestOf(b), "the digest does not depend on insertion order");

  // ---- 6. the cap and the accounting --------------------------------------------------
  eq(history.historyCapBytes({}), 20_000_000_000, "the default cap is 20 GB");
  eq(history.historyCapBytes({ OPENCHQ_HISTORY_CAP_GB: "5" }), 5_000_000_000, "the cap is env-driven");
  eq(history.historyCapBytes({ OPENCHQ_HISTORY_CAP_GB: "nonsense" }), 20_000_000_000, "a bad cap falls back to the default");
  const usage = history.historyUsage(handle, dir);
  const files = usage.files.reduce((sum, file) => sum + file.bytes, 0);
  eq(usage.fileBytes, files, "usage counts the real files");
  eq(usage.totalBytes, usage.fileBytes, "the budget is the file total - the blobs live inside it, counted once");
  eq(usage.matches, 1, "one film in the store");
  eq(usage.finished, 1, "and it is finished");
  eq(usage.filmBytes > 0, true, "the per-match stored_bytes is reported for the prune's decision");

  handle.close();
}
