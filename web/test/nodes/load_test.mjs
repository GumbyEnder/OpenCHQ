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
// box. PB-232 set this floor above THIS host's steady state, which is high: measured 2026-11-24,
// four 3 s idle windows read 18.7 / 20.4 / 20.4 / 22.7% iowait while busy read 4.8-6.6%, and
// neither an 8-way fsync storm (23.6-24.4%) nor an 8-way NAS read storm (17.8-18.8%) moved it off
// that floor -- so ~20% here is the box (NAS mount plus resident agents).
//
// PB-234: the fixed 0.40 is coarse in BOTH directions on such a host -- a window at 41% on a box
// already sitting at 30% is not the same evidence as 41% on a quiet one -- so the arm is now
// BASELINE-RELATIVE. A quiet window is sampled before any probe and the effective threshold is
// max(IOWAIT_FIXED, baseline + IOWAIT_MARGIN). The fixed floor stays: on a quiet box the cut is
// still 40%, so the PB-232 calibration keeps describing the arm.
export const IOWAIT_FIXED = 0.40;
// The margin is a STAND-IN: it is not decoded from anything and this host has not measured what a
// genuinely starved probe looks like above its own ~20% steady state. 15 points is half again the
// measured steady state, which is enough to keep an ordinary bad window from firing while a real
// disk stall (the fsync storm read 23.6-24.4% on an idle box) still clears it.
export const IOWAIT_MARGIN = 0.15;
// The quiet window at the start of the run. It is skipped, never faked, when /proc/stat is absent.
export const BASELINE_MS = 3000;
// The floor is a calibration, not a knob: the 10x budget still describes the same `busy` number.
export const DEFAULT_HEADROOM = 10;

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

// PB-234 AC2: the effective iowait cut. max(fixed, baseline + margin), and null when the baseline
// could not be read -- an unknown baseline must not silently become the fixed cut, or the verdict
// would claim a baseline-relative threshold it never computed.
export function iowaitThreshold(fixed, baseline, margin) {
  if (!Number.isFinite(baseline) || baseline < 0) return null;
  const f = Number.isFinite(fixed) ? fixed : IOWAIT_FIXED;
  const m = Number.isFinite(margin) ? margin : IOWAIT_MARGIN;
  return Math.max(f, baseline + m);
}

// The quiet window's numbers. null when either field is unreadable (no /proc/stat, or a window
// with no cpu time in it): the caller then SKIPS the baseline rather than inventing one.
export function baselineFrom(before, after) {
  const busy = busyOver(before, after);
  const iowait = shareOver(before, after, "iowait");
  if (busy === null || iowait === null) return null;
  return { busy, iowait };
}

// PB-234 AC2: the three numbers the sample is graded against, in one place so the pure pin and the
// bench run cannot drift apart. A null baseline is carried through as null -- the cut is then null
// and the iowait arm cannot fire, which is the honest answer for a host with no /proc/stat.
export function probeCuts(baseline, fixed = IOWAIT_FIXED, margin = IOWAIT_MARGIN) {
  const baselineIowait = baseline && Number.isFinite(baseline.iowait) ? baseline.iowait : null;
  return {
    fixed,
    margin,
    baseline: baselineIowait,
    threshold: iowaitThreshold(fixed, baselineIowait, margin),
  };
}

// The CONTENDED arms. Separate and pure so the branch pins can drive it without a bench run:
// busy keeps the fixed 0.30, iowait speaks its own arithmetic (fixed, baseline, margin, effective)
// because a label with no number beside it is a guess wearing a verdict.
export function contentionArms({ busy, iowait, load1, cpus, busyCut = CONTENDED, iowaitCut = null,
  iowaitFixed = IOWAIT_FIXED, iowaitBaseline = null, iowaitMargin = IOWAIT_MARGIN }) {
  const arms = [];
  if (busy === null || iowait === null) {
    if (cpus > 0 && load1 / cpus > 0.5) arms.push("load1 " + pct(load1 / cpus) + " of " + cpus + " cpus > 50%");
    return arms;
  }
  if (busy > busyCut) arms.push("busy " + pct(busy) + " > " + pct(busyCut));
  if (iowaitCut !== null && iowait > iowaitCut) {
    arms.push(
      "iowait " + pct(iowait) + " > " + pct(iowaitCut) +
        " (max(" + pct(iowaitFixed) + " fixed, " + pct(iowaitBaseline) + " baseline + " +
        pct(iowaitMargin) + " margin))"
    );
  }
  return arms;
}

// The sentence a red carries. It names the fixed value, the baseline and the effective threshold
// even when nothing fired, so the reader can re-derive the verdict instead of trusting the label.
export function hostText({ busy, iowait, load1, cpus, threshold, baseline, fixed = IOWAIT_FIXED,
  margin = IOWAIT_MARGIN }) {
  const head = busy === null || iowait === null
    ? "busy=unknown iowait=unknown"
    : "host busy " + pct(busy) + " iowait " + pct(iowait) + " during the sample";
  const cut = threshold === null
    ? "; iowait threshold unknown (no baseline window: the fixed " + pct(fixed) + " is NOT applied to a number it never sampled)"
    : "; iowait threshold " + pct(threshold) + " = max(" + pct(fixed) + " fixed, " + pct(baseline) +
      " baseline + " + pct(margin) + " margin)";
  return head + cut + " (load1=" + Number(load1).toFixed(2) + " cpus=" + cpus + ")";
}

export const name = "load_test";

// One probe run. Bench-rooms exits 1 on a capacity failure but still prints BENCH_JSON, so keep
// the numbers: that lets the assertions name the exact budget instead of dying on the exit code.
function probe(baseline) {
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
  // The baseline is the quiet window's iowait, read once at the start of the run. A box with no
  // /proc/stat has no baseline and no iowait arm at all -- it falls back to load1/cpus, and the
  // threshold stays null rather than being faked from the fixed value.
  const cuts = probeCuts(baseline);
  const baselineIowait = cuts.baseline;
  const threshold = cuts.threshold;
  const arms = contentionArms({
    busy, iowait, load1: l1, cpus,
    busyCut: CONTENDED, iowaitCut: threshold,
    iowaitFixed: cuts.fixed, iowaitBaseline: baselineIowait, iowaitMargin: cuts.margin,
  });
  return {
    report,
    busy,
    iowait,
    baseline: baselineIowait,
    threshold,
    contended: arms.length > 0,
    why: arms.join(" and "),
    text: hostText({
      busy, iowait, load1: l1, cpus, threshold, baseline: baselineIowait,
      fixed: IOWAIT_FIXED, margin: IOWAIT_MARGIN,
    }),
  };
}

// PB-234 AC1: a quiet window at the START of the run, before any probe sample. It costs wall time
// by design (the card says so), and it is skipped, not faked, when the host has no /proc/stat.
async function quietWindow() {
  const before = cpuTimes();
  if (!before) return null;
  await new Promise((resolve) => setTimeout(resolve, BASELINE_MS));
  const after = cpuTimes();
  return baselineFrom(before, after);
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

export async function run() {
  const floor = Number(process.env.OPENCHQ_LOAD_HEADROOM) > 0
    ? Number(process.env.OPENCHQ_LOAD_HEADROOM)
    : DEFAULT_HEADROOM;

  // AC1/AC5: the baseline window first, and its own line so a reader sees the number the sample
  // will be graded against. No /proc/stat means it is skipped and said so -- never invented.
  const baseline = await quietWindow();
  if (baseline) {
    const threshold = iowaitThreshold(IOWAIT_FIXED, baseline.iowait, IOWAIT_MARGIN);
    console.log(
      `load_test: quiet window ${(BASELINE_MS / 1000).toFixed(1)} s at start: baseline iowait ${pct(baseline.iowait)} ` +
        `busy ${pct(baseline.busy)}; iowait threshold ${pct(threshold)} = max(${pct(IOWAIT_FIXED)} fixed, ` +
        `${pct(baseline.iowait)} baseline + ${pct(IOWAIT_MARGIN)} margin)`
    );
  } else {
    console.log("load_test: quiet window skipped: no /proc/stat, so busy/iowait stay unknown and the baseline is not faked");
  }

  // Stop at the first sample that clears the floor: an idle run costs one probe, and only a
  // short one pays for the re-takes that tell a spike apart from a slowdown.
  const taken = [];
  for (let i = 1; i <= SAMPLES; i++) {
    const sample = probe(baseline);
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
