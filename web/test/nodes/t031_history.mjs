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
//   6. the cap is env-driven and defaults to 10 GB (PB-249); usage counts REAL FILE BYTES (sqlite + wal + shm),
//      and the film blobs are counted once, inside the file, not a second time.
//
// Pruning is step 2 and is not tested here because it does not exist yet - the commit says why.

import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  eq(history.historyCapBytes({}), 10_000_000_000, "the default cap is 10 GB (PB-249)");
  eq(history.historyCapBytes({ OPENCHQ_HISTORY_CAP_GB: "5" }), 5_000_000_000, "the cap is env-driven");
  eq(history.historyCapBytes({ OPENCHQ_HISTORY_CAP_GB: "nonsense" }), 10_000_000_000, "a bad cap falls back to the default");
  const usage = history.historyUsage(handle, dir);
  const files = usage.files.reduce((sum, file) => sum + file.bytes, 0);
  eq(usage.fileBytes, files, "usage counts the real files");
  eq(usage.totalBytes, usage.fileBytes, "the budget is the file total - the blobs live inside it, counted once");
  eq(usage.matches, 1, "one film in the store");
  eq(usage.finished, 1, "and it is finished");
  eq(usage.filmBytes > 0, true, "the per-match stored_bytes is reported for the prune's decision");

  // ---- 7. the film survives a restart (frodo 9117 §2) --------------------------------
  // `loadRooms()` returns objects with NO `film` key and `recordFilm()` early-returns on a falsy
  // `room.film`, so before the restore initialiser a match that crossed a deploy stopped
  // recording at the restart, `finishFilm` never ran, `ended_at` stayed null and the war never
  // reached `listFor`. This is a REAL restore, not a mock: a child process owns its own store
  // (`OPENCHQ_WEB_DATA` points at a temp dir, so a player's database is never touched), builds a
  // film, saves the room the way a deploy drain does, then a lobby is created over that same
  // store and the production beat is run. A second room with no `matches` row pins the other
  // half: restore must NOT invent a film, because `startFilm` upserts and its ON CONFLICT would
  // rewrite `start_state` with a mid-match paint.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..");
  const serverUrl = pathToFileURL(path.join(repoRoot, "web", "server")).href;
  const restoreDir = mkdtempSync(path.join(tmpdir(), "openchq-t031-restore-"));
  const childSource = `
const u = (name) => ${JSON.stringify(serverUrl)} + "/" + name;
const history = await import(u("history.mjs"));
const { db } = await import(u("db.mjs"));
const rooms = await import(u("rooms.mjs"));
const { openMatch } = await import(u("match.mjs"));
const { tickMatch } = await import(u("tick.mjs"));
const { matchSites } = await import(u("board.mjs"));
const { createLobby } = await import(u("lobby.mjs"));
const { gunzipSync: gunzip } = await import("node:zlib");
const report = {};
const hex = (blob) => Buffer.from(blob).toString("hex");
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

const filmRoom = {
  id: "restore-film",
  mode: "human",
  era: "1942",
  clock: "running",
  speed: 1,
  resume: true,
  seats: { blue: { username: "ada", kind: "human" }, red: { username: "grace", kind: "human" } },
  match: openMatch("1942", matchSites("1942")),
};
history.startFilm(filmRoom, db);
report.startState = hex(db.prepare("SELECT start_state FROM matches WHERE id = ?").get(filmRoom.id).start_state);
filmRoom.match.clock = "running";
for (let i = 0; i < 2; i += 1) {
  const step = tickMatch(filmRoom.match);
  history.appendFrame(filmRoom, step.events, db);
}
report.roundBefore = filmRoom.match.round;
report.framesBefore = count("SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ?", filmRoom.id);
// A drain marks the room to resume; the row's clock is running. That is the deploy case.
rooms.saveRoom(filmRoom);

const bareRoom = {
  id: "restore-nofilm",
  mode: "human",
  era: "1942",
  clock: "running",
  speed: 1,
  resume: true,
  seats: { blue: { username: "bob", kind: "human" }, red: { username: "eve", kind: "human" } },
  match: openMatch("1942", matchSites("1942")),
};
bareRoom.match.clock = "running";
for (let i = 0; i < 2; i += 1) tickMatch(bareRoom.match);
rooms.saveRoom(bareRoom);
report.bareRoundBefore = bareRoom.match.round;

// The restart: a new lobby over the same store, then the beat that records frames.
const lobby = createLobby();
const t0 = Date.now();
lobby.tickRooms(t0);
lobby.tickRooms(t0 + 20000);
const filmAfter = lobby.debugRoom("restore-film");
const bareAfter = lobby.debugRoom("restore-nofilm");
report.filmRoundAfter = filmAfter ? filmAfter.round : null;
report.bareRoundAfter = bareAfter ? bareAfter.round : null;
report.framesAfter = count("SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ?", "restore-film");
report.newestRound = db.prepare("SELECT MAX(round) AS r FROM match_rounds WHERE match_id = ?").get("restore-film").r;
report.startStateAfter = hex(db.prepare("SELECT start_state FROM matches WHERE id = ?").get("restore-film").start_state);
report.bareRows = count("SELECT COUNT(*) AS n FROM matches WHERE id = ?", "restore-nofilm");
const bareRow = db.prepare("SELECT start_state FROM matches WHERE id = ?").get("restore-nofilm");
report.bareStartRound = bareRow ? JSON.parse(gunzip(Buffer.from(bareRow.start_state)).toString("utf8")).round : null;
report.bareFrames = count("SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ?", "restore-nofilm");
report.bareNewest = db.prepare("SELECT MAX(round) AS r FROM match_rounds WHERE match_id = ?").get("restore-nofilm").r;
lobby.flushAll();
db.close();
console.log("RESTORE_REPORT " + JSON.stringify(report));
`;
  const childRun = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: repoRoot,
    env: { ...process.env, OPENCHQ_WEB_DATA: restoreDir },
    encoding: "utf8",
    timeout: 120000,
  });
  if (childRun.status !== 0) {
    fail("the restore child exited " + childRun.status + ": " + String(childRun.stderr || childRun.stdout).slice(-1200));
  }
  const line = String(childRun.stdout || "").split("\n").find((row) => row.startsWith("RESTORE_REPORT "));
  if (!line) fail("the restore child printed no report: " + String(childRun.stdout).slice(-800) + String(childRun.stderr).slice(-800));
  const restored = JSON.parse(line.slice("RESTORE_REPORT ".length));
  eq(restored.framesBefore, 2, "two rounds were filmed before the restart");
  eq(restored.filmRoundAfter, restored.roundBefore + 1, "the restored room's beat advanced one round");
  eq(restored.framesAfter, restored.framesBefore + 1, "a frame was written for the round after the restart");
  eq(restored.newestRound, restored.filmRoundAfter, "the new frame belongs to that round");
  eq(restored.startStateAfter, restored.startState,
    "round 0's start_state was NOT rewritten: restore re-arms the recorder, it does not reopen the film");
  eq(restored.bareRoundAfter > restored.bareRoundBefore, true,
    "the film-less room ran under the same beat (" + restored.bareRoundBefore + " -> " + restored.bareRoundAfter + ")");
  // The no-row arm: a room that predates the recorder is filmed from the restart on, and its start
  // state says WHICH round that was - it does not claim round 0.
  eq(restored.bareRows, 1, "a restored room with no matches row opens a film at the restart");
  eq(restored.bareStartRound, restored.bareRoundBefore, "the opened film's start state names the round it opened at");
  eq(restored.bareFrames, 1, "and the round after the restart is recorded for it");
  eq(restored.bareNewest, restored.bareRoundAfter, "the film-less room's first frame is the round the beat ran");

  handle.close();
}
