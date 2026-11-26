// PB-270 (b/a): rung 4 reads units LOST, not net alive — and the grid counts n_eff per (step, seat).
// Owner: game.
//
// What breaks if this file is removed: `aliveStart - aliveEnd` goes back to being called "pieces
// lost". That number is negative wherever a side produces (1918 blue -460, 1986 both seats
// -1040/-1060 on the PB-269 arms), so rung 4 awarded the side that BUILT more. The fixtures below
// pin the two cases that separate production from attrition, and the spawn pins the harness to the
// shared ledger so the two cannot drift.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distinctCount, resolveVerdict, unitLedger } from "../../../tools/lib/pb270-units.mjs";
import { auditRows, summariseGrid } from "../../../tools/pb270-grid.mjs";

export const name = "pb270_unit_ledger";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const unit = (id, side) => ({ id, side, strength: 100, domain: "land" });

function fixture({ blueBuilt = 0, redBuilt = 0, blueLost = 0, redLost = 0, capturedBlue = 0 } = {}) {
  const startSides = new Map();
  // Blue opens with 2 units, red with 3 (1942's real opening is 29/31, same shape).
  const start = { blue: ["b1", "b2"], red: ["r1", "r2", "r3"] };
  for (const side of ["blue", "red"]) for (const id of start[side]) startSides.set(id, side);
  const builtIds = { blue: new Set(), red: new Set() };
  const blueBuild = Array.from({ length: blueBuilt }, (_, index) => "bb" + index);
  const redBuild = Array.from({ length: redBuilt }, (_, index) => "rb" + index);
  for (const id of blueBuild) builtIds.blue.add(id);
  for (const id of redBuild) builtIds.red.add(id);
  const pieces = [];
  start.blue.forEach((id, index) => {
    if (index < capturedBlue) pieces.push(unit(id, "red"));
    else if (index < capturedBlue + blueLost) return; // gone: no record
    else pieces.push(unit(id, "blue"));
  });
  start.red.forEach((id, index) => { if (index >= redLost) pieces.push(unit(id, "red")); });
  // A captured blue unit stays alive as a red unit, so it is not a loss for red's count of its own.
  for (const id of blueBuild) pieces.push(unit(id, "blue"));
  for (const id of redBuild) pieces.push(unit(id, "red"));
  return unitLedger({ startSides, builtIds, pieces });
}

export async function run(ctx) {
  const { fail } = ctx;

  // (b1) HIGH PRODUCTION, ZERO LOSSES: blue builds 12 and loses none; red builds none and loses 2.
  // Under the retired net rule blue's "piecesLost" would be 2 - 14 = -12, i.e. the bigger builder
  // would LOSE the attrition tiebreak to red's +2. Rung 4 must award blue.
  const builder = fixture({ blueBuilt: 12, redLost: 2 });
  if (builder.lost.blue !== 0) fail("builder fixture: blue lost " + builder.lost.blue + ", expected 0");
  if (builder.built.blue !== 12) fail("builder fixture: blue built " + builder.built.blue + ", expected 12");
  if (builder.lost.red !== 2) fail("builder fixture: red lost " + builder.lost.red + ", expected 2");
  const builtVerdict = resolveVerdict({
    over: false, winner: null, citiesTaken: { blue: 0, red: 0 }, capitalsLost: { blue: 0, red: 0 },
    unitsLost: builder.lost,
  });
  if (builtVerdict.verdict !== "blue" || builtVerdict.rung !== "units lost") {
    fail("rung 4 gave the high-production, zero-loss side " + JSON.stringify(builtVerdict) + ", expected blue on units lost");
  }
  const retiredNet = { blue: 2 - 14, red: 3 - 1 };
  if (!(retiredNet.blue < retiredNet.red)) fail("fixture no longer separates the two rules: " + JSON.stringify(retiredNet));

  // (b2) NO NEGATIVE LOSSES. Every ledger column is a count.
  for (const side of ["blue", "red"]) {
    for (const key of ["built", "lost", "capturedOut", "capturedIn", "end", "start"]) {
      if (!(builder[key][side] >= 0)) fail("ledger " + key + "." + side + " is negative: " + builder[key][side]);
    }
  }

  // (b3) IDENTITY on every fixture: start + built + capturedIn - lost - capturedOut === end.
  const captured = fixture({ blueBuilt: 3, redBuilt: 1, blueLost: 0, redLost: 1, capturedBlue: 1 });
  for (const ledger of [builder, captured]) {
    if (ledger.identityFailures.length) {
      fail("unit ledger identity failed: " + JSON.stringify(ledger.identityFailures));
    }
  }
  if (captured.capturedOut.blue !== 1 || captured.capturedIn.red !== 1) {
    fail("capture fixture: expected 1 blue unit captured by red, got out " + JSON.stringify(captured.capturedOut) +
      " in " + JSON.stringify(captured.capturedIn));
  }
  if (captured.lost.blue !== 0) fail("a captured unit must not be counted as destroyed: lost.blue " + captured.lost.blue);

  // (b4) Fewer losses still wins when both sides build nothing: the rung is not a production prize.
  const attrition = resolveVerdict({
    over: false, winner: null, citiesTaken: { blue: 0, red: 0 }, capitalsLost: { blue: 0, red: 0 },
    unitsLost: { blue: 3, red: 0 },
  });
  if (attrition.verdict !== "red") fail("rung 4 gave 3 losses vs 0 to " + attrition.verdict + ", expected red");

  // (a) THE FINGERPRINT IGNORES THE SEED. Four rows identical except seed are ONE play; a changed
  // verdict is a second. This is what makes the grid's n_eff 1 per step and seat rather than 20.
  const makeRow = (seed, verdict = "blue", over = {}) => ({
    seed, match: seed, levels: { blue: 3, red: 2 }, verdict, verdictRung: "cities taken",
    citiesEnd: { blue: 40, red: 23 }, citiesTaken: { blue: 0, red: 0 }, capitalsLost: { blue: 0, red: 0 },
    units: { lost: { blue: 1, red: 2 }, built: { blue: 0, red: 0 }, end: { blue: 29, red: 29 } },
    unitsLost: { blue: 1, red: 2 }, unitsBuilt: { blue: 0, red: 0 },
    events: { blue: { buy: 0, order: 0, defend: 0 }, red: { buy: 0, order: 0, defend: 0 } },
    handicap: { step: 0 }, ...over,
  });
  const samePlay = [1, 2, 3, 4].map((seed) => makeRow(seed));
  if (distinctCount(samePlay) !== 1) fail("seed-only differences produced " + distinctCount(samePlay) + " distinct rows, expected 1");
  if (distinctCount([...samePlay, makeRow(5, "red")]) !== 2) fail("a changed verdict did not produce a second distinct row");

  // (a2) THE GRID GRADES n_eff PER (STEP, SEAT) and names the inert axis.
  const report = {
    era: "1942",
    pairs: [{ pair: "3v2", rows: [...[1, 2, 3, 4].map((seed) => makeRow(seed)), ...[1, 2, 3, 4].map((seed) => makeRow(seed, "red", { handicap: { step: 0.1 } }))] }],
  };
  const grid = summariseGrid(report);
  const cells = grid.blocks[0].cells;
  if (cells.length !== 2) fail("grid cells " + cells.length + ", expected 2 (one per step)");
  for (const cell of cells) {
    if (cell.nEff !== 1) fail("grid n_eff " + cell.nEff + " at step " + cell.step + ", expected 1");
    if (cell.seeds !== 4) fail("grid seeds " + cell.seeds + " at step " + cell.step + ", expected 4");
  }
  if (!cells.some((cell) => cell.flipsVsNeutral > 0)) fail("grid did not register a verdict flip against the neutral step");
  if (!grid.blocks[0].resolved) fail("grid with a decided row reports unresolved");

  // (harness) THE SPAWN: the real harness writes the shared ledger, the report states the rule, and
  // --seed-axis measures the deterministic era at 1 distinct row object.
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb270-"));
  const out = path.join(dir, "grid.json");
  try {
    const spawned = spawnSync(
      process.execPath,
      ["tools/t032-bot-vs-bot.mjs", "--era", "1942", "--rounds", "8", "--matches", "2",
        "--pairs", "3:2", "--seed-axis", "--out", out],
      { cwd: root, encoding: "utf8", env: { ...process.env, T032_SHA: "pb270-test" } }
    );
    if (spawned.status !== 0) fail("harness rc " + spawned.status + ": " + String(spawned.stderr || spawned.stdout).slice(-800));
    const harness = JSON.parse(readFileSync(out, "utf8"));
    if (!/FEWER UNITS LOST/.test(harness.verdictRule)) fail("verdictRule does not state rung 4 as units lost: " + harness.verdictRule);
    if (/aliveStart - aliveEnd/.test(harness.verdictRule)) fail("verdictRule still quotes the retired net rule");
    if (!harness.unitLedger || harness.unitLedger.rows < 1) fail("report carries no unit ledger");
    if (harness.unitLedger.identityFailures.length) fail("harness ledger identity failures: " + JSON.stringify(harness.unitLedger.identityFailures));
    for (const pair of harness.pairs) {
      for (const row of pair.rows) {
        if ("piecesLost" in row) fail("row still carries the retired piecesLost column");
        if (!row.units || !row.units.lost) fail("row " + row.match + " carries no units.lost");
        for (const side of ["blue", "red"]) {
          if (row.unitsLost[side] < 0) fail("row " + row.match + " unitsLost." + side + " negative");
          if (row.unitsBuilt[side] < 0) fail("row " + row.match + " unitsBuilt." + side + " negative");
        }
      }
    }
    const problems = auditRows([harness]);
    if (problems.length) fail("grid audit: " + problems.join("; "));
    if (!harness.seedAxis) fail("--seed-axis wrote no block");
    if (harness.seedAxis.distinctRows !== 1) {
      fail("1942 seed axis produced " + harness.seedAxis.distinctRows + " distinct row objects, expected 1 (engine carries no RNG)");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
