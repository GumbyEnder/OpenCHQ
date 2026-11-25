// Node test: T-031 step 3 — the prune (three classes, bounded), the budget, and the vacuum shape.
//
// Frodo's ruling (room 9117 §6) chose option (a): prune by `stored_bytes` against the cap, oldest
// finished first, never a live match. The conditions this module pins, each as a fact:
//   1. an ABANDONED film (ended_at IS NULL, room row gone, started before now - X) is pruned; X is
//      `OPENCHQ_HISTORY_ABANDONED_HOURS` (default 24) and a film inside that window is kept;
//   2. a LIVE film (room row still present) is never pruned, however old it is;
//   3. FINISHED films are pruned oldest-first ONLY when the real /data total is over the cap, and the
//      newest 100 finished films per account are never pruned;
//   4. a pass deletes at most `batch` headers and also drops their `match_rounds` rows;
//   5. `historyBudget()` reports real bytes, the cap, and the 80% alarm;
//   6. `ensureIncrementalAutoVacuum()` flips the pragma only with a full VACUUM, and
//      `incrementalVacuum()` frees freelist pages - the file total is never the assertion.
//
// What fails if this is removed: a film whose room was deleted grows forever (nothing else closes
// it), a live match gets deleted under a player, and "the cap is env-driven" becomes a constant.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as history from "../../server/history.mjs";

export const name = "t031_prune";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-t031-prune-"));
  const handle = new DatabaseSync(path.join(dir, "openchq.sqlite"));
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, mode TEXT, era TEXT, clock TEXT, note TEXT, state TEXT,
    created_at TEXT, saved_at TEXT)`);
  history.ensureHistorySchema(handle);
  return { dir, handle };
}

const NOW = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
const iso = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600 * 1000).toISOString();

function put(handle, id, { blue = "ada", red = "grace", ended, started = 48, stored = 1000 } = {}) {
  handle
    .prepare(
      `INSERT INTO matches (id, era, mode, blue_user, red_user, started_at, ended_at, winner, rounds,
        schema, start_state, final_state, final_digest, stored_bytes)
       VALUES (?, '1942', ?, ?, ?, ?, ?, ?, 3, 1, ?, NULL, NULL, ?)`,
    )
    .run(id, blue === red ? "bot" : "human", blue, red, iso(started), ended === null ? null : iso(ended),
      ended === null ? null : "blue", Buffer.from("start"), stored);
  handle
    .prepare("INSERT INTO match_rounds (match_id, round, payload) VALUES (?, 1, ?)")
    .run(id, Buffer.from("frame"));
}

function liveRoom(handle, id) {
  handle
    .prepare("INSERT INTO rooms (id, mode, era, clock, note, state, created_at, saved_at) VALUES (?, 'human', '1942', 'running', 'n', 's', ?, ?)")
    .run(id, iso(30), iso(0));
}

const ids = (rows) => rows.map((row) => String(row && row.id !== undefined ? row.id : row));

export async function run() {
  // ---- 1-2. abandoned and live, under the cap (so no finished class runs at all) -------------
  {
    const { dir, handle } = open();
    put(handle, "abandoned-old", { ended: null, started: 30 });
    put(handle, "abandoned-fresh", { ended: null, started: 1 });
    put(handle, "live-old", { ended: null, started: 72 });
    liveRoom(handle, "live-old");
    put(handle, "finished", { ended: 40, started: 45 });

    const report = history.pruneHistory(handle, { now: NOW, rootDir: dir, capBytes: 10_000_000_000, batch: 10 });
    eq(ids(report.abandoned), ["abandoned-old"], "only the abandoned film past X is pruned");
    eq(report.finished, [], "nothing finished is pruned while the volume is under the cap");
    eq(ids(handle.prepare("SELECT id FROM matches ORDER BY id").all()), ["abandoned-fresh", "finished", "live-old"],
      "the fresh abandoned film, the finished film and the live war all survive");
    eq(handle.prepare("SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = 'abandoned-old'").get().n, 0,
      "the abandoned film's frames go with its header");
    eq(handle.prepare("SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = 'live-old'").get().n, 1,
      "a live war keeps its frames");

    // X is env-driven: a 2-hour window keeps the 30-hour film too.
    const wide = history.pruneHistory(handle, { now: NOW, rootDir: dir, capBytes: 10_000_000_000, batch: 10, abandonedHours: 2 });
    eq(ids(wide.abandoned), [], "a wider X keeps everything inside it");
  }

  // ---- 3-4. over the cap: oldest finished first, bounded, frames dropped ---------------------
  // The newest-100-per-account floor is why this seeds 106: with a library under 100 nothing
  // finished is ever a candidate, however small the cap - that IS the card's rule (T-031 §2), and
  // a 6-film fixture would have tested the floor instead of the delete.
  {
    const { dir, handle } = open();
    for (let i = 0; i < 106; i += 1) {
      put(handle, "finished-" + String(i).padStart(3, "0"), { ended: 200 - i, started: 210 - i, stored: 1000 });
    }
    const report = history.pruneHistory(handle, { now: NOW, rootDir: dir, capBytes: 1, batch: 3 });
    eq(report.overCap, true, "a 1-byte cap puts the pass over the cap");
    eq(report.finished.length, 3, "a pass deletes at most its batch");
    eq(ids(report.finished), ["finished-000", "finished-001", "finished-002"], "oldest finished first");
    eq(report.freedBytes, 3000, "the report counts the stored bytes it freed");
    eq(handle.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 103, "103 headers remain");
    eq(handle.prepare("SELECT COUNT(*) AS n FROM match_rounds").get().n, 103, "and their frames only");
    const again = history.pruneHistory(handle, { now: NOW, rootDir: dir, capBytes: 1, batch: 1 });
    eq(ids(again.finished), ["finished-003"], "the next pass continues where the last one stopped");
  }

  // ---- 3b. the newest 100 per account are never pruned --------------------------------------
  {
    const { dir, handle } = open();
    for (let i = 0; i < 101; i += 1) put(handle, "war-" + String(i).padStart(3, "0"), { ended: 200 - i, started: 210 - i, stored: 10 });
    const report = history.pruneHistory(handle, { now: NOW, rootDir: dir, capBytes: 1, batch: 5 });
    eq(ids(report.finished), ["war-000"], "only the one film older than the newest 100 is prunable");
    eq(handle.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 100, "the newest 100 survive");
  }

  // ---- 5. the budget the health endpoint carries --------------------------------------------
  {
    const { dir, handle } = open();
    const budget = history.historyBudget(handle, dir, { OPENCHQ_HISTORY_CAP_GB: "0.000001" });
    eq(budget.capBytes, 1000, "the cap is the env value, in decimal bytes");
    eq(budget.alarm, true, "a file past 80% of the cap is an alarm");
    const roomy = history.historyBudget(handle, dir, { OPENCHQ_HISTORY_CAP_GB: "20" });
    eq(roomy.alarm, false, "20 GB of cap on a small file is not an alarm");
    eq(roomy.capBytes, 20_000_000_000, "the default is 20 GB decimal");
  }

  // ---- 6. the pragma flip needs the full VACUUM, and the interval vacuum moves pages --------
  {
    const { dir, handle } = open();
    const quiet = { log() {}, warn() {} };
    eq(history.autoVacuumMode(handle), 0, "a fresh file starts at auto_vacuum = NONE");
    const flip = history.ensureIncrementalAutoVacuum(handle, quiet);
    eq(flip.changed, true, "the boot flip reports the change");
    eq(history.autoVacuumMode(handle), 2, "the pragma is INCREMENTAL after the boot VACUUM");
    eq(history.ensureIncrementalAutoVacuum(handle, quiet).changed, false, "a second boot does not vacuum again");

    for (let i = 0; i < 40; i += 1) put(handle, "bulk-" + i, { ended: 50 });
    handle.exec("DELETE FROM match_rounds WHERE match_id LIKE 'bulk-%'");
    handle.exec("DELETE FROM matches WHERE id LIKE 'bulk-%'");
    const freed = history.incrementalVacuum(handle, { rootDir: dir, pages: 512, log: quiet });
    if (!(freed.freed > 0)) fail("the interval vacuum freed no pages after a bulk delete: " + JSON.stringify(freed));
  }

  // A 5-minute pass with nothing to do is silent; the alarm line is the only thing it may say.
  {
    const lines = [];
    history.logPrune({ abandoned: [], finished: [], alarm: false, error: null }, { log: (m) => lines.push(m), warn: (m) => lines.push(m) });
    eq(lines, [], "an idle pass logs nothing");
  }
}
