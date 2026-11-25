// Node test for PB-234: the CONTENDED iowait threshold is baseline-relative.
//
// What breaks if this node is removed: `load_test` falls back to grading a sample against one fixed
// 40% iowait cut, so a window at 41% on a box already sitting at 30% reads the same as 41% on a
// quiet one, and a genuinely worse steady state needs the constant edited. PB-234 makes the
// effective cut max(fixed, baseline + margin) off a quiet window sampled at the start of the run.
//
// This node is TESTS-ONLY and drives the pure arithmetic the bench run uses -- it never spawns a
// bench. The bench leg (`load_test`) prints the same numbers at run time; this node pins the
// branches that a healthy host would not visit on its own (a raised baseline suppressing the arm,
// a low fixed cut still firing, an unreadable /proc/stat skipping the baseline instead of faking it).
//
// Arms:
//   1. a quiet box keeps the fixed floor: max(40%, 20% + 15%) = 40% (AC2, AC4);
//   2. a raised baseline lifts the cut above a number the fixed value alone would label CONTENDED
//      (42% > 40% fixed, but 42% < 45% effective) -- the arm PB-234 exists for (AC2, AC6);
//   3. a low fixed threshold still fires, and the arm names fixed, baseline, margin and effective
//      (AC3, AC6);
//   4. the busy arm is unchanged at its fixed 30% and fires independently of the iowait cut (AC3);
//   5. no /proc/stat: busy=unknown iowait=unknown, threshold null, no iowait arm, load1/cpus
//      fallback, and the baseline is skipped rather than faked as 0 (AC5);
//   6. the reported sentence names all three numbers, so a verdict cannot be a bare label (AC2);
//   7. busy stays 1 - idle - iowait and the headroom floor stays 10x (AC4).

import {
  BASELINE_MS,
  DEFAULT_HEADROOM,
  IOWAIT_FIXED,
  IOWAIT_MARGIN,
  baselineFrom,
  contentionArms,
  hostText,
  iowaitThreshold,
  probeCuts,
} from "./load_test.mjs";

export const name = "pb234_threshold";

const EPS = 1e-9;

function fail(message) {
  throw new Error(message);
}

function near(message, actual, expected) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > EPS) {
    fail(message + ": " + actual + " !== " + expected);
  }
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function must(ok, message) {
  if (!ok) fail(message);
}

export async function run() {
  // --- 0. the constants are the shipped ones, and the margin says it is a stand-in in code ------
  eq("fixed iowait cut is the PB-232 value", IOWAIT_FIXED, 0.40);
  eq("baseline margin is the shipped 15 points", IOWAIT_MARGIN, 0.15);
  must(BASELINE_MS > 0, "the quiet window has no wall time: " + BASELINE_MS);
  eq("the headroom floor stays 10x", DEFAULT_HEADROOM, 10);

  // --- 1. a quiet baseline leaves the fixed floor in charge -----------------------------------
  near("max(40% fixed, 20% baseline + 15% margin) is 40%", iowaitThreshold(IOWAIT_FIXED, 0.20, IOWAIT_MARGIN), 0.40);
  near("a baseline below the floor never lowers the cut", iowaitThreshold(IOWAIT_FIXED, 0.0, IOWAIT_MARGIN), 0.40);

  // --- 2. a raised baseline lifts the cut over a number the fixed value would call CONTENDED ---
  const raised = iowaitThreshold(IOWAIT_FIXED, 0.30, IOWAIT_MARGIN);
  near("max(40% fixed, 30% baseline + 15% margin) is 45%", raised, 0.45);
  const sample = { busy: 0.10, iowait: 0.42, load1: 1.0, cpus: 8 };
  const fixedOnly = contentionArms({ ...sample, iowaitCut: IOWAIT_FIXED, iowaitBaseline: null });
  eq("fixed alone labels a 42% window CONTENDED (the control)", fixedOnly.length, 1);
  must(/iowait 42% > 40%/.test(fixedOnly[0]), "the control arm does not name its own numbers: " + fixedOnly[0]);
  const relative = contentionArms({
    ...sample, iowaitCut: raised, iowaitBaseline: 0.30,
    iowaitFixed: IOWAIT_FIXED, iowaitMargin: IOWAIT_MARGIN,
  });
  eq("the raised baseline suppresses the same window", relative, []);

  // ...and the arm text, when it does fire, names fixed, baseline, margin and effective ---------
  const firing = contentionArms({
    busy: 0.05, iowait: 0.50, load1: 1.0, cpus: 8, iowaitCut: raised, iowaitBaseline: 0.30,
    iowaitFixed: IOWAIT_FIXED, iowaitMargin: IOWAIT_MARGIN,
  });
  eq("a window above the effective cut still fires", firing.length, 1);
  must(/iowait 50% > 45%/.test(firing[0]), "the firing arm does not name the effective cut: " + firing[0]);
  must(/40% fixed/.test(firing[0]), "the firing arm does not name the fixed value: " + firing[0]);
  must(/30% baseline/.test(firing[0]), "the firing arm does not name the baseline: " + firing[0]);
  must(/15% margin/.test(firing[0]), "the firing arm does not name the margin: " + firing[0]);

  // --- 3. a LOW fixed threshold still fires (the other branch of max()) ------------------------
  const low = iowaitThreshold(0.10, 0.02, IOWAIT_MARGIN);
  near("max(10% fixed, 2% baseline + 15% margin) is 17%", low, 0.17);
  const lowArms = contentionArms({
    busy: 0.01, iowait: 0.20, load1: 1.0, cpus: 8, iowaitCut: low, iowaitBaseline: 0.02,
    iowaitFixed: 0.10, iowaitMargin: IOWAIT_MARGIN,
  });
  eq("a low fixed cut still fires", lowArms.length, 1);
  must(/iowait 20% > 17%/.test(lowArms[0]), "the low-cut arm does not name its numbers: " + lowArms[0]);
  must(/10% fixed/.test(lowArms[0]), "the low-cut arm does not name its fixed value: " + lowArms[0]);

  // --- 4. the busy arm is unchanged and independent of the iowait decision --------------------
  const busyOnly = contentionArms({
    busy: 0.35, iowait: 0.05, load1: 1.0, cpus: 8, iowaitCut: 0.60, iowaitBaseline: 0.45,
  });
  eq("busy above its fixed 30% fires even with a high iowait cut", busyOnly, ["busy 35% > 30%"]);
  eq("busy exactly at 30% does not fire (strict)", contentionArms({ busy: 0.30, iowait: 0.0, load1: 1.0, cpus: 8, iowaitCut: null }), []);

  // --- 5. no /proc/stat: unknown stays unknown, and the baseline is skipped --------------------
  eq("an unreadable baseline yields no threshold", iowaitThreshold(IOWAIT_FIXED, null, IOWAIT_MARGIN), null);
  eq("an unreadable baseline yields no threshold on undefined either", iowaitThreshold(IOWAIT_FIXED, undefined, IOWAIT_MARGIN), null);
  eq("baselineFrom(null, x) is null, not zero", baselineFrom(null, { total: 10, idle: 5, iowait: 0 }), null);
  eq("a window with no cpu time is null, not zero", baselineFrom({ total: 10, idle: 5, iowait: 1 }, { total: 10, idle: 5, iowait: 1 }), null);
  const unknownText = hostText({ busy: null, iowait: null, load1: 2.0, cpus: 8, threshold: null, baseline: null });
  must(/busy=unknown iowait=unknown/.test(unknownText), "the unknown verdict does not say unknown: " + unknownText);
  must(/no baseline window/.test(unknownText), "the unknown verdict does not say the baseline was skipped: " + unknownText);
  must(/load1=2\.00 cpus=8/.test(unknownText), "the unknown verdict does not print the load1/cpus fallback: " + unknownText);
  eq("no iowait arm can fire on an unknown sample",
    contentionArms({ busy: null, iowait: null, load1: 1.0, cpus: 8, iowaitCut: null }), []);
  eq("the load1 fallback fires only above half the cpus",
    contentionArms({ busy: null, iowait: null, load1: 8.0, cpus: 8, iowaitCut: null }),
    ["load1 100% of 8 cpus > 50%"]);

  // --- 6. the verdict sentence names fixed, baseline and effective -----------------------------
  const read = hostText({ busy: 0.05, iowait: 0.41, load1: 1.2, cpus: 8, threshold: raised, baseline: 0.30 });
  must(/iowait threshold 45% = max\(40% fixed, 30% baseline \+ 15% margin\)/.test(read),
    "the verdict does not name all three numbers: " + read);
  must(/host busy 5% iowait 41%/.test(read), "the verdict does not name the sample: " + read);

  // --- 7. busy keeps its meaning, and the floor's calibration still describes it ---------------
  // before -> after: 1000 total units, 800 idle, 100 iowait; then 1600 idle and 150 iowait over the
  // second 1000 units. idle 80%, iowait 5%, busy 15%.
  const quiet = baselineFrom(
    { total: 1000, idle: 800, iowait: 100 },
    { total: 2000, idle: 1600, iowait: 150 }
  );
  must(Boolean(quiet), "baselineFrom returned null on readable counters");
  near("baseline busy is 1 - idle - iowait", quiet.busy, 0.15);
  near("baseline iowait is the sampled share", quiet.iowait, 0.05);

  // --- 8. the BENCH path reads the baseline (probeCuts), not just the pure helpers -------------
  // The mutant that drops the baseline read lives here: probe() grades every sample through
  // probeCuts(), so if this returns a fixed cut for a 30% baseline the run silently reverts to
  // PB-232 while the pure helpers above still pass.
  const benchCuts = probeCuts({ busy: 0.05, iowait: 0.30 });
  near("probeCuts reads the quiet window's iowait", benchCuts.baseline, 0.30);
  near("probeCuts produces max(40%, 30% + 15%) for the bench run", benchCuts.threshold, 0.45);
  const noProc = probeCuts(null);
  eq("probeCuts on no /proc/stat has no baseline", noProc.baseline, null);
  eq("probeCuts on no /proc/stat has no threshold", noProc.threshold, null);
  eq("probeCuts on a NaN baseline has no threshold", probeCuts({ iowait: NaN }).threshold, null);

  console.log(
    "pb234 threshold: fixed 40%, margin 15% (stand-in), baseline-relative; " +
      "raised 30% -> 45% suppresses 42%, low 10% fixed -> 17% fires, unknown stays unknown"
  );
}
