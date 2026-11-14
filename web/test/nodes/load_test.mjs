// node `load_test`: a thousand rooms inside one round.
//
// Runs the real capacity probe as a child process, so it gets its own throwaway SQLite file
// and cannot touch the harness database, then asserts the numbers the probe printed. The
// probe ticks real matches and stores them with rooms.saveRoom; nothing here is a stand-in.
//
// This node measures wall-clock headroom, so it measures the machine too: a concurrent Playwright
// run took the same commit from 12.2x to 8.9x and failed (69/1/0), while an idle box at load ~3.7
// read 12.2-12.7x three times running. A pin that goes red because another shell is busy is not a
// regression pin, so a short sample is re-taken -- a spike loses, a real slowdown does not -- and
// every number that can turn red says how busy the host was while it was taken.
//
// The instrument is the host's own busy fraction across the probe window, not the 1-minute load
// average. Calibrated on a 32-cpu box against 0/4/8/16/24/32 spinning cores: load1 read 8.1 while
// headroom collapsed to 5.7x, because a 0.14 s probe is invisible to a 60 s average; busy% tracked
// the collapse (8% -> 11.9x, 36% -> 5.7x, 83% -> 6.5x). So load1 is printed for context and busy%
// decides whether a red is trustworthy.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// A contended host is the likeliest cause of a short sample, so name it rather than guess: the
// bench medians five passes internally and still lost 3x of headroom to a parallel browser.
const SAMPLES = 3;
// Above this share of the host's cores busy during the sample, a red says "re-run alone first".
const CONTENDED = 0.30; // calibration: ambient 8%, first collapse at 36%

// Busy fraction of the whole host over the window it is asked about. /proc/stat is instant, so it
// sees the probe's own 0.14 s round; loadavg does not. Falls back to load1/cpus where there is no
// /proc/stat (macOS), which is why `contended` is a hint and not an assertion.
function cpuTimes() {
  try {
    const row = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const total = row.reduce((a, b) => a + b, 0);
    return { total, idle: (row[3] || 0) + (row[4] || 0) };
  } catch {
    return null;
  }
}

function busyOver(before, after) {
  if (!before || !after) return null;
  const dt = after.total - before.total;
  return dt > 0 ? 1 - (after.idle - before.idle) / dt : null;
}

export const name = "load_test";

// One probe run. Bench-rooms exits 1 on a capacity failure but still prints BENCH_JSON, so keep
// the numbers: that lets the assertions name the exact budget instead of dying on the exit code.
function probe() {
  const before = cpuTimes();
  const bench = spawnSync(process.execPath, ["tools/bench-rooms.mjs", "1000", "8"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
  });
  const after = cpuTimes();
  const output = String(bench.stdout || "");
  const line = output.split("\n").find((row) => row.startsWith("BENCH_JSON "));
  if (!line) {
    const text = String(bench.stderr || bench.error || "exit " + bench.status);
    throw new Error("bench-rooms failed: " + text.trim().split("\n").slice(-3).join(" | "));
  }
  const report = JSON.parse(line.slice("BENCH_JSON ".length));
  if (report.rooms !== 1000 || report.pieces !== 8) {
    throw new Error("bench measured " + report.rooms + " rooms x " + report.pieces + " pieces, not 1000 x 8");
  }
  // Correctness readings are not timing: they must hold on the first sample, and a retry must
  // never paper over a held room being written or a lost round trip.
  assertCorrect(report);
  // Measured across the probe's own window, so it describes the machine this sample raced.
  const busy = busyOver(before, after);
  const [l1] = os.loadavg();
  return {
    report,
    busy,
    contended: busy === null ? l1 / os.cpus().length > 0.5 : busy > CONTENDED,
    text:
      (busy === null ? "busy=unknown" : "host busy " + (busy * 100).toFixed(0) + "% during the sample") +
      " (load1=" + l1.toFixed(2) + " cpus=" + os.cpus().length + ")",
  };
}

function assertCorrect(report) {
  if (report.heldWrites !== 0) throw new Error("a held room was written " + report.heldWrites + " times");
  if (report.heldChanged !== 0) throw new Error("a held room's row changed");
  if (report.heldRoundsMoved !== 0) throw new Error("a held room's clock moved");
  if (report.durable !== 1000) {
    throw new Error("only " + report.durable + "/1000 rooms were durable inside " + report.flushRounds + " rounds");
  }
  if (!report.roundTrip) throw new Error("a saved room did not restore its routes and owners");
  if (!(report.roundTripSteps >= 6 * 60)) {
    throw new Error("round trip restored only " + report.roundTripSteps + " route steps");
  }
}

export function run() {
  const floor = Number(process.env.OPENCHQ_LOAD_HEADROOM) > 0
    ? Number(process.env.OPENCHQ_LOAD_HEADROOM)
    : 10;

  // Stop at the first sample that clears the floor: an idle run costs one probe, and only a
  // short one pays for the re-takes that tell a spike apart from a slowdown.
  const taken = [];
  for (let i = 1; i <= SAMPLES; i++) {
    const sample = probe();
    sample.score = Math.min(sample.report.tickHeadroom, sample.report.roundHeadroom);
    taken.push(sample);
    const budgetS = Number(sample.report.budgetMs) > 0 ? (Number(sample.report.budgetMs) / 1000).toFixed(2) : "the";
    console.log(
      `load_test: sample ${i}/${SAMPLES} tick ${sample.report.tickHeadroom}x / round ${sample.report.roundHeadroom}x ` +
        `(${sample.score > floor ? "clears" : "short of"} >${floor}x in the ${budgetS} s round), ${sample.text}`
    );
    if (sample.score > floor) break;
  }

  const best = taken.reduce((a, b) => (b.score > a.score ? b : a), taken[0]);
  const report = best.report;
  const tried = taken.length === 1 ? "1 sample" : taken.length + " samples";

  if (!(report.tickHeadroom > floor)) {
    throw new Error(
      "tick headroom " + report.tickHeadroom + "x, need >" + floor + "x inside the " +
        (Number(report.budgetMs) / 1000).toFixed(2) + " s round -- best of " + tried + " (" + best.text + ")" +
        (best.contended ? "; the host was CONTENDED during that sample, so re-run alone before reading it as a code regression" : "")
    );
  }
  if (!(report.roundHeadroom > floor)) {
    throw new Error(
      "round headroom " + report.roundHeadroom + "x, need >" + floor + "x including the store slice -- best of " +
        tried + " (" + best.text + ")" +
        (best.contended ? "; the host was CONTENDED during that sample, so re-run alone before reading it as a code regression" : "")
    );
  }

  console.log(
    `load_test: headroom floor ${floor}x, ${report.rooms} rooms x ${report.pieces} pieces, tick ${report.tickHeadroom}x, ` +
      `round ${report.roundHeadroom}x, held ${report.heldWrites} writes, ` +
      `durable ${report.durable}/1000, ${report.roundTripSteps} route steps round-tripped (${tried}` +
      (taken.length > 1 ? ", best kept" : "") + ", " + best.text + ")" +
      (best.contended ? "; GREEN TAKEN ON A CONTENDED HOST -- re-run alone to confirm the margin" : "")
  );
}
