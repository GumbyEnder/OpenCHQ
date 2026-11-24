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
// iowait gets its own arm. A core stalled on the disk is neither busy nor free, and folding it into
// idle (the old cpuTimes) is how a flush-bound sample printed "host busy 5%" and read as an idle
// box. The threshold sits above THIS host's steady state, which is high: measured 2026-11-24, four
// 3 s idle windows read 18.7 / 20.4 / 20.4 / 22.7% iowait while busy read 4.8-6.6%, and neither an
// 8-way fsync storm (23.6-24.4%) nor an 8-way NAS read storm (17.8-18.8%) moved it off that floor --
// so ~20% here is the box (NAS mount plus resident agents), and only a window well above it is
// evidence that the disk starved the probe.
const IOWAIT_CONTENDED = 0.40;

const pct = (share) => (share * 100).toFixed(0) + "%";

// Busy fraction of the whole host over the window it is asked about. /proc/stat is instant, so it
// sees the probe's own 0.14 s round; loadavg does not. Falls back to load1/cpus where there is no
// /proc/stat (macOS), which is why `contended` is a hint and not an assertion.
// row[3] is idle and row[4] is iowait; they are different facts about a core, so they stay apart.
function cpuTimes() {
  try {
    const row = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const total = row.reduce((a, b) => a + b, 0);
    return { total, idle: row[3] || 0, iowait: row[4] || 0 };
  } catch {
    return null;
  }
}

// Share of the host one /proc/stat field spent over the window. total is the same for every field,
// so one helper covers idle, iowait, and anything added later.
function shareOver(before, after, field) {
  if (!before || !after) return null;
  const dt = after.total - before.total;
  return dt > 0 ? (after[field] - before[field]) / dt : null;
}

// busy keeps its old meaning on purpose -- every point of idle OR iowait is a core this probe did
// not get -- so the calibration behind the 10x floor still describes this number.
function busyOver(before, after) {
  const idle = shareOver(before, after, "idle");
  const iowait = shareOver(before, after, "iowait");
  if (idle === null || iowait === null) return null;
  return 1 - idle - iowait;
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
  const iowait = shareOver(before, after, "iowait");
  const [l1] = os.loadavg();
  const cpus = os.cpus().length;
  // Name the arm that fired: a label with no number beside it is a guess wearing a verdict.
  const arms = [];
  if (busy === null) {
    if (l1 / cpus > 0.5) arms.push("load1 " + pct(l1 / cpus) + " of " + cpus + " cpus > 50%");
  } else {
    if (busy > CONTENDED) arms.push("busy " + pct(busy) + " > " + pct(CONTENDED));
    if (iowait > IOWAIT_CONTENDED) arms.push("iowait " + pct(iowait) + " > " + pct(IOWAIT_CONTENDED));
  }
  return {
    report,
    busy,
    iowait,
    contended: arms.length > 0,
    why: arms.join(" and "),
    text:
      (busy === null
        ? "busy=unknown iowait=unknown"
        : "host busy " + pct(busy) + " iowait " + pct(iowait) + " during the sample") +
      " (load1=" + l1.toFixed(2) + " cpus=" + cpus + ")",
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
        (best.contended ? "; the host was CONTENDED during that sample (" + best.why + "), so re-run alone before reading it as a code regression" : "")
    );
  }
  if (!(report.roundHeadroom > floor)) {
    throw new Error(
      "round headroom " + report.roundHeadroom + "x, need >" + floor + "x including the store slice -- best of " +
        tried + " (" + best.text + ")" +
        (best.contended ? "; the host was CONTENDED during that sample (" + best.why + "), so re-run alone before reading it as a code regression" : "")
    );
  }

  console.log(
    `load_test: headroom floor ${floor}x, ${report.rooms} rooms x ${report.pieces} pieces, tick ${report.tickHeadroom}x, ` +
      `round ${report.roundHeadroom}x, held ${report.heldWrites} writes, ` +
      `durable ${report.durable}/1000, ${report.roundTripSteps} route steps round-tripped (${tried}` +
      (taken.length > 1 ? ", best kept" : "") + ", " + best.text + ")" +
      (best.contended ? "; GREEN TAKEN ON A CONTENDED HOST (" + best.why + ") -- re-run alone to confirm the margin" : "")
  );
}
