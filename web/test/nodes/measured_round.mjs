// measured_round — the original's round clock and speed control, as measured (T-008, AC2/AC3).
//
// What fails if this is removed:
//   - somebody "fixes" config.measured back into a guess  -> the DOSBox numbers stop being
//     distinguishable from the stand-ins they replaced
//   - the deviation is dropped from the label              -> the 5 s round starts looking
//     like a recovered figure instead of an owner's choice
//   - speed 0 quietly becomes "the clock stops"            -> the copy stops matching the
//     manual's wording and the original's measured behaviour (pieces stop, clock does not)
//
// The measured values come from DOSBox 0.74-3 at 3000 cycles, 3 legs per speed, 2026-11-12.
// Evidence: docs/re/MOVEMENT.md.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { speedSeconds, speedTable } from "../../server/rules.mjs";

export const name = "measured_round";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, "..", "..", "..", "config", "game.json");

export async function run(ctx) {
  const { fail } = ctx;
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const m = config.measured;
  if (!m || typeof m !== "object") fail("config.measured is missing");

  // 7646 units of 1/64 s is the panel's 2:00.0. Nominal seconds follow from it, so the two
  // numbers cannot drift apart without this failing.
  if (m.roundLength !== 7646) fail("measured.roundLength is " + m.roundLength + ", not the 0x1dde countdown 7646");
  if (m.clockUnitsPerSecondNominal !== 64) fail("measured.clockUnitsPerSecondNominal is not 64");
  const nominal = m.roundLength / m.clockUnitsPerSecondNominal;
  if (Math.abs(m.roundSecondsNominal - nominal) > 0.1) {
    fail("measured.roundSecondsNominal (" + m.roundSecondsNominal + ") is not roundLength/64 (" + nominal.toFixed(2) + ")");
  }
  // The wall-clock figure is larger only because DOSBox ran 7.5% slow at 3000 cycles. If a
  // later run reports a wall figure below the nominal one, something other than DOSBox is
  // being measured.
  if (!(m.roundSecondsWall > m.roundSecondsNominal)) {
    fail("measured.roundSecondsWall (" + m.roundSecondsWall + ") is not longer than the nominal " + nominal.toFixed(2));
  }
  if (Math.abs(m.clockUnitsPerSecond - m.roundLength / m.roundSecondsWall) > 0.5) {
    fail("measured.clockUnitsPerSecond disagrees with roundLength/roundSecondsWall");
  }
  if (!/3000 cycles/.test(String(m.dosbox))) fail("measured.dosbox does not record the cycles setting");

  // The two findings a reader must not miss.
  if (m.roundLengthIndependentOfSpeed !== true) fail("measured.roundLengthIndependentOfSpeed is not true");
  if (m.speedZeroStopsRoundClock !== false) {
    fail("measured.speedZeroStopsRoundClock must be false: the clock was measured running at 59.16 units/s at speed 0");
  }
  if (m.speedZeroStopsPieceMovement !== true) {
    fail("measured.speedZeroStopsPieceMovement must be true: 0 piece steps were counted in 8 s at speed 0");
  }

  // Pass rates, in the order the speed control makes them.
  const pass = m.piecePassPerSecond || {};
  for (const speed of ["1", "3", "6"]) {
    const rate = Number(pass[speed]);
    if (!Number.isFinite(rate) || rate <= 0) fail("measured.piecePassPerSecond[" + speed + "] is not a positive rate");
  }
  if (!(Number(pass["1"]) < Number(pass["3"]) && Number(pass["3"]) < Number(pass["6"]))) {
    fail("the measured piece pass rates are not ordered 1 < 3 < 6");
  }
  // The piece table base is a disassembly fact, not a pattern hunt: the pass at decompiled.c
  // 4506 indexes DS:0x0de2, and the per-kind allowance it spends comes from DS:0x19a6. If a
  // later pass "finds" a 16-byte record array instead, this fails and forces the evidence to be
  // re-read rather than quietly rewritten.
  const pt = m.pieceTable || {};
  if (pt.visitOrderBase !== "0x0de2") fail("measured.pieceTable.visitOrderBase is not the base the pass indexes (0x0de2)");
  if (pt.walkCursor !== "0x147c") fail("measured.pieceTable.walkCursor is not 0x147c");
  if (pt.passIndex !== "0x147a") fail("measured.pieceTable.passIndex is not 0x147a");
  if (pt.passDelayByte !== "0x3e91") fail("measured.pieceTable.passDelayByte is not 0x3e91");
  if (pt.kindAllowanceBase !== "0x19a6") fail("measured.pieceTable.kindAllowanceBase is not 0x19a6");
  const allow = JSON.stringify(pt.kindAllowance);
  if (allow !== JSON.stringify([0, 12, 24, 0, 0, 36, 36, 40, 40, 40])) {
    fail("measured.pieceTable.kindAllowance is not the ten live bytes 0,12,24,0,0,36,36,40,40,40: " + allow);
  }
  if (JSON.stringify(pt.sideAllowance) !== JSON.stringify([20, 20, 20, 20])) {
    fail("measured.pieceTable.sideAllowance is not the live 0x1976 row 20,20,20,20");
  }

  // AC3 (PM 3495 item 1): the table ships for every kind, keyed on the static allowance byte.
  // A blank cell was the thing being struck, so a missing kind fails rather than skips; and a
  // PREDICTED row is only honest while it is labelled and carries no measurement reference.
  const byKind = m.cellsPerRoundByKind || {};
  const perRound = m.passRatePerRound || {};
  if (!(Number(perRound["1"]) < Number(perRound["3"]) && Number(perRound["3"]) < Number(perRound["6"]))) {
    fail("measured.passRatePerRound is not ordered 1 < 3 < 6");
  }
  if (Number(perRound["0"]) !== 0) fail("measured.passRatePerRound[\"0\"] is not 0 (no pass at speed 0)");
  const predicted = [5, 7, 8, 9];
  for (let kind = 0; kind <= 9; kind += 1) {
    const row = byKind[String(kind)];
    if (!row) fail("measured.cellsPerRoundByKind has no row for kind " + kind + " - every kind ships");
    if (row.allowance !== pt.kindAllowance[kind]) {
      fail("kind " + kind + " row allowance " + row.allowance + " is not byte[0x19a6+" + kind + "] = " + pt.kindAllowance[kind]);
    }
    if (!["MEASURED", "MEASURED-HARNESS", "PREDICTED"].includes(row.status)) {
      fail("kind " + kind + " row status is not MEASURED / MEASURED-HARNESS / PREDICTED: " + row.status);
    }
    if (row.status !== "PREDICTED" && !row.evidenceRef) {
      fail("kind " + kind + " is labelled " + row.status + " but names no evidenceRef");
    }
    if (row.status === "PREDICTED" && row.evidenceRef) {
      fail("kind " + kind + " is PREDICTED (no run) but carries an evidenceRef: " + row.evidenceRef);
    }
    for (const speed of ["1", "3", "6"]) {
      const cell = row.cellsPerRound && row.cellsPerRound[speed];
      if (!Array.isArray(cell) || cell.length !== 2 || !(cell[0] <= cell[1])) {
        fail("kind " + kind + " speed " + speed + " cellsPerRound is not a [low, high] pair");
      }
      if (!(cell[1] <= Number(perRound[speed]) * 2.01)) {
        fail("kind " + kind + " speed " + speed + " predicts " + cell[1] + " cells, more than 2 per pass");
      }
    }
  }
  for (const kind of predicted) {
    if (byKind[String(kind)].status !== "PREDICTED") fail("kind " + kind + " must be labelled PREDICTED (no run)");
  }
  if (byKind["2"].status === "PREDICTED" || byKind["6"].status === "PREDICTED") {
    fail("kinds 2 and 6 were run full rounds; they cannot be PREDICTED");
  }

  // The method section and the manual quote are deliverables (AC1), so their absence is a fail,
  // not a matter of taste: MOVEMENT.md is where the numbers above are argued.
  const docFile = path.resolve(here, "..", "..", "..", "docs", "re", "MOVEMENT.md");
  if (!existsSync(docFile)) fail("docs/re/MOVEMENT.md is missing");
  const doc = readFileSync(docFile, "utf8");
  for (const needle of ["## Method", "DS:0x0de2", "0x19a6", "At speed 0, game-time does not pass at all", "printed page 35", "PREDICTED — static byte only, no run", "Q37"]) {
    if (!doc.includes(needle)) fail("docs/re/MOVEMENT.md does not contain: " + needle);
  }

  // One pass walks all 100 pieces, so cells per round can never exceed passes per round.
  const passesPerRound1 = Number(pass["1"]) * m.roundSecondsNominal / 100;
  if (!(passesPerRound1 > 0)) fail("speed 1 produces no piece pass inside a round");

  // The label has to say both things: these are measured, and what the server runs is a
  // deviation from them.
  const label = String(config.sources && config.sources.speeds);
  if (!/MEASURED/.test(label)) fail("sources.speeds does not carry the measured finding");
  if (!/DEVIATION/.test(label)) fail("sources.speeds does not label roundSeconds/speeds as a deliberate deviation");
  const note = String(config.notes && config.notes.speeds);
  if (!/DEVIATION/.test(note)) fail("notes.speeds does not label the playability ramp as a deviation");

  // The runtime table is the deviation, and it still has to be a usable seven-slot ramp.
  const table = speedTable();
  if (table.length !== 7) fail("the runtime speed table is not seven slots");
  if (table[1] !== config.roundSeconds) {
    fail("speed 1 is " + table[1] + " s, not the configured roundSeconds " + config.roundSeconds);
  }
  if (!(speedSeconds(6) < speedSeconds(1))) fail("the runtime ramp no longer shortens at speed 6");

  console.log(
    "measured_round: original round " + m.roundSecondsNominal + " s nominal / " + m.roundSecondsWall +
      " s wall at " + m.clockUnitsPerSecond + " units/s (" + m.dosbox + "), same at speeds 0-6; " +
      "speed 0 stops pieces but not the clock; pass rates " + pass["1"] + "/" + pass["3"] + "/" + pass["6"] +
      " per second; runtime keeps the " + config.roundSeconds + " s deviation"
  );
}
