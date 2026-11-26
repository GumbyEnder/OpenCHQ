// T-032 Part C / PB-258: the pair summary must not print a rate the pairing cannot measure.
// Owner: game.
//
// PB-258: `20 / 20 for L3 (100%), 20 losses` is not a rate when both seats are the same level:
// winnerLevel names a level, and both aWins and bWins count the same rows. The harness must print
// unmeasurable instead, and the report's verdictRule must name the rung-4 rule it actually runs
// (PB-270: units LOST, not net alive), or the JSON goes on describing the retired rule.
//
// Two spawns would be slow; one run carries both shapes: 3v3 (both seats level 3, unmeasurable)
// and 3v2 (different levels, measurable). 6 matches at 8 rounds is enough for a decided row at the
// pieces-lost rung, which is what makes the seat split non-trivial.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const name = "t032_pair_printer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pair-printer-"));
  const out = path.join(dir, "pair.json");
  try {
    const spawned = spawnSync(
      process.execPath,
      ["tools/t032-bot-vs-bot.mjs", "--era", "1942", "--rounds", "8", "--matches", "6",
        "--pairs", "3:3,3:2", "--out", out],
      { cwd: root, encoding: "utf8", env: { ...process.env, T032_SHA: "pair-printer-test" } }
    );
    if (spawned.status !== 0) {
      fail("harness rc " + spawned.status + ": " + String(spawned.stderr || spawned.stdout).slice(-800));
    }

    const sameLine = spawned.stdout.split("\n").find((line) => line.startsWith("pair 3v3"));
    if (!sameLine) fail("no pair 3v3 line in stdout");
    if (!/unmeasurable/.test(sameLine)) fail("same-level pair printed a rate line: " + sameLine);
    if (/for L3/.test(sameLine)) fail("same-level pair still names a winning level: " + sameLine);

    const report = JSON.parse(readFileSync(out, "utf8"));
    if (!/FEWER UNITS LOST/.test(report.verdictRule)) {
      fail("report verdictRule does not state rung 4 as units lost: " + report.verdictRule);
    }
    if (/more live pieces/.test(report.verdictRule)) {
      fail("report verdictRule still states the pieces-alive rung: " + report.verdictRule);
    }

    const sameLevel = report.pairs[0];
    const measurable = report.pairs[1];
    if (sameLevel.pair !== "3v3" || measurable.pair !== "3v2") {
      fail("pairs out of order: " + report.pairs.map((pair) => pair.pair).join(","));
    }
    if (sameLevel.measurable !== false) fail("3v3 pairing reports measurable");
    for (const key of ["aWins", "bWins", "winRateA", "meets"]) {
      if (sameLevel[key] !== null) fail("3v3 pairing " + key + " = " + JSON.stringify(sameLevel[key]) + ", expected null");
    }
    if (!sameLevel.unmeasurable) fail("3v3 pairing carries no unmeasurable reason");
    const seatSum = sameLevel.bySeat.blue + sameLevel.bySeat.red + sameLevel.draws;
    if (seatSum !== sameLevel.matches) fail("3v3 seat split " + seatSum + " != matches " + sameLevel.matches);
    if (sameLevel.bySeat.blue + sameLevel.bySeat.red === 0) {
      fail("3v3 seat split has no decided row, so the seat column proves nothing");
    }

    if (measurable.measurable !== true) fail("3v2 pairing reports unmeasurable");
    if (typeof measurable.aWins !== "number") fail("3v2 pairing aWins is not a number: " + measurable.aWins);

    for (const pair of report.pairs) {
      for (const row of pair.rows) {
        if ("piecesLost" in row) fail("row " + row.match + " still carries the retired piecesLost column");
        if (!row.units) fail("row " + row.match + " carries no unit ledger");
        if (row.units.identityFailures.length) fail("row " + row.match + " unit ledger identity failed");
        for (const side of ["blue", "red"]) {
          if (!(row.unitsLost[side] >= 0)) fail("row " + row.match + " unitsLost." + side + " is negative");
          const expected = row.units.start[side] + row.units.built[side] + row.units.capturedIn[side]
            - row.units.lost[side] - row.units.capturedOut[side];
          if (expected !== row.units.end[side]) {
            fail("row " + row.match + " " + side + " ledger " + expected + " != end " + row.units.end[side]);
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
