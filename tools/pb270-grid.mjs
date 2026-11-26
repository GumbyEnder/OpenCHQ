// PB-270 D1/D2: grade a PB-260 board grid from harness JSON, with the two columns the old grader
// could not carry.
//
//   n_eff   distinct row objects per (step, seat), NOT a seed or block count. The engine has no RNG
//           for the file-owned eras, so 20 seeds are one play per seat; n_eff is 1 there and the
//           grid says so instead of printing five identical "blocks".
//   resolution / flips   verdict counts per step and seat-pair, plus how many (seed, seat) rows
//           changed verdict against the neutral step. A grid whose every step is the same verdict
//           has not resolved the axis it is quoted for.
//
// It also aggregates the unit ledger by rung so a rung-4 row is readable as attrition.
//
// Usage: node tools/pb270-grid.mjs <harness.json> [more.json ...] [--json <out>]
// Exit 1 if any row carries a unit-ledger identity failure, a negative unitsLost, or a rung-4
// verdict whose winner did not lose fewer units. Those are instrument defects, not data.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { distinctCount } from "./lib/pb270-units.mjs";

// A seat cell is (step, which seat A sat in). When both seats are the same LEVEL no seat is "A",
// so the cell is the SIDE (blue/red) and aWins/bWins are null - the same rule the pair printer
// applies to the report: a same-level pairing cannot name a winning level, only a side.
function seatLabel(row, a, b) {
  if (String(a) === String(b)) return "seat";
  return String(row.levels.blue) === String(a) ? "A-blue" : "A-red";
}

function flipKey(row) {
  return String(row.seed) + "|" + String(row.levels.blue) + "v" + String(row.levels.red);
}

function stepOf(row) {
  return row.handicap ? row.handicap.step : "off";
}

export function summariseGrid(report) {
  const blocks = [];
  for (const pair of report.pairs || []) {
    const a = String(pair.pair.split("v")[0]);
    const b = String(pair.pair.split("v")[1] || "");
    const rows = pair.rows || [];
    const steps = [...new Set(rows.map(stepOf))].sort((x, y) => {
      if (x === "off" || y === "off") return 0;
      return Number(x) - Number(y);
    });
    const sameLevel = String(a) === String(b);
    const cells = [];
    for (const step of steps) {
      for (const seat of (sameLevel ? ["seat"] : ["A-blue", "A-red"])) {
        const cellRows = rows.filter((row) => stepOf(row) === step && seatLabel(row, a, b) === seat);
        if (!cellRows.length) continue;
        const rungs = {};
        let aWins = 0;
        let bWins = 0;
        let draws = 0;
        let bySeatBlue = 0;
        let bySeatRed = 0;
        let lostBlue = 0;
        let lostRed = 0;
        let builtBlue = 0;
        let builtRed = 0;
        for (const row of cellRows) {
          if (row.verdict === "blue") bySeatBlue += 1;
          else if (row.verdict === "red") bySeatRed += 1;
          if (sameLevel) {
            if (row.verdict === "draw") draws += 1;
          } else {
            const winner = row.verdict === "draw" ? "draw" : String(row.levels[row.verdict]);
            if (winner === "draw") draws += 1;
            else if (winner === a) aWins += 1;
            else bWins += 1;
          }
          rungs[row.verdictRung] = (rungs[row.verdictRung] || 0) + 1;
          lostBlue += row.unitsLost.blue;
          lostRed += row.unitsLost.red;
          builtBlue += row.unitsBuilt.blue;
          builtRed += row.unitsBuilt.red;
        }
        cells.push({
          step,
          seat,
          rows: cellRows.length,
          seeds: new Set(cellRows.map((row) => row.seed)).size,
          distinctRows: distinctCount(cellRows),
          nEff: distinctCount(cellRows),
          aWins: sameLevel ? null : aWins,
          bWins: sameLevel ? null : bWins,
          bySeat: { blue: bySeatBlue, red: bySeatRed },
          draws,
          rungs,
          unitsLost: { blue: lostBlue, red: lostRed },
          unitsBuilt: { blue: builtBlue, red: builtRed },
        });
      }
    }
    // Verdict flips against the neutral step, keyed by (seed, seat orientation). With an inert seed
    // axis this is one row per seat; that is the honest count, not 20. A same-level pairing cannot
    // name a level, so flips are null there and the bySeat column carries the control instead.
    const neutral = steps.includes(0) ? 0 : steps.includes("off") ? "off" : steps[0];
    const baseVerdict = new Map();
    for (const row of rows.filter((candidate) => stepOf(candidate) === neutral)) {
      baseVerdict.set(flipKey(row), row.verdict);
    }
    for (const cell of cells) {
      if (sameLevel) {
        cell.flipsVsNeutral = null;
        continue;
      }
      let flips = 0;
      for (const row of rows.filter((candidate) => stepOf(candidate) === cell.step && seatLabel(candidate, a, b) === cell.seat)) {
        const before = baseVerdict.get(flipKey(row));
        if (before !== undefined && before !== row.verdict) flips += 1;
      }
      cell.flipsVsNeutral = flips;
    }
    const rungTotals = {};
    for (const row of rows) rungTotals[row.verdictRung] = (rungTotals[row.verdictRung] || 0) + 1;
    blocks.push({
      era: report.era,
      pair: pair.pair,
      neutralStep: neutral,
      rows: rows.length,
      seeds: new Set(rows.map((row) => row.seed)).size,
      cells,
      rungTotals,
      resolved: cells.some((cell) => cell.bySeat.blue + cell.bySeat.red > 0),
      flipsAny: cells.some((cell) => (cell.flipsVsNeutral || 0) > 0),
    });
  }
  return { era: report.era, blocks };
}

function formatCell(cell) {
  const score = cell.aWins === null
    ? "blue " + String(cell.bySeat.blue).padStart(2) + " / red " + String(cell.bySeat.red).padStart(2) + " / D " + String(cell.draws).padStart(2)
    : "A " + String(cell.aWins).padStart(2) + " / B " + String(cell.bWins).padStart(2) + " / D " + String(cell.draws).padStart(2);
  return [
    "step " + String(cell.step).padStart(5),
    cell.seat.padEnd(6),
    "n " + String(cell.rows).padStart(3),
    "n_eff " + String(cell.nEff).padStart(2),
    score,
    "flips " + String(cell.flipsVsNeutral === null ? "n/a" : cell.flipsVsNeutral).padStart(3),
    "lost " + cell.unitsLost.blue + "/" + cell.unitsLost.red,
    "built " + cell.unitsBuilt.blue + "/" + cell.unitsBuilt.red,
  ].join("  ");
}

export function auditRows(reports) {
  const problems = [];
  for (const report of reports) {
    for (const pair of report.pairs || []) {
      for (const row of pair.rows || []) {
        if (row.units.identityFailures.length) {
          problems.push("row " + row.match + " " + report.era + " " + pair.pair + ": unit ledger identity failed " +
            JSON.stringify(row.units.identityFailures));
        }
        for (const side of ["blue", "red"]) {
          if (row.unitsLost[side] < 0) problems.push("row " + row.match + ": negative unitsLost." + side);
          if (row.unitsBuilt[side] < 0) problems.push("row " + row.match + ": negative unitsBuilt." + side);
        }
        if (row.verdictRung === "units lost") {
          const loser = row.verdict === "blue" ? "red" : "blue";
          if (!(row.unitsLost[row.verdict] < row.unitsLost[loser])) {
            problems.push("row " + row.match + ": rung 4 winner did not lose fewer units (" +
              row.unitsLost.blue + "/" + row.unitsLost.red + ")");
          }
        }
      }
    }
  }
  return problems;
}

function main(argv) {
  const jsonIndex = argv.indexOf("--json");
  const out = jsonIndex >= 0 ? argv[jsonIndex + 1] : null;
  const inputs = argv.filter((value, index) =>
    value.endsWith(".json") && !(jsonIndex >= 0 && index === jsonIndex + 1));
  if (!inputs.length) {
    console.error("usage: node tools/pb270-grid.mjs <harness.json> [...] [--json <out>]");
    process.exit(2);
  }
  const reports = inputs.map((file) => JSON.parse(readFileSync(file, "utf8")));
  const summaries = reports.map(summariseGrid);
  const problems = auditRows(reports);
  for (const summary of summaries) {
    console.log("era " + summary.era);
    for (const block of summary.blocks) {
      console.log("pair " + block.pair + ": " + block.rows + " row(s), " + block.seeds + " seed(s), " +
        (block.resolved ? "resolves" : "NO decide step") + ", " + (block.flipsAny ? "flips" : "no flips") +
        " vs neutral step " + block.neutralStep);
      for (const cell of block.cells) console.log("  " + formatCell(cell));
      console.log("  rungs: " + JSON.stringify(block.rungTotals));
      const nEffs = [...new Set(block.cells.map((cell) => cell.nEff))].sort();
      if (nEffs.length === 1 && nEffs[0] === 1) {
        console.log("  n_eff = 1 per step and seat: the seed axis is inert here (engine carries no RNG for this era)");
      }
    }
  }
  if (problems.length) {
    console.error("INSTRUMENT PROBLEMS (" + problems.length + "):");
    for (const problem of problems) console.error("  " + problem);
  } else {
    console.log("audit: 0 instrument problems (" + reports.reduce((sum, report) =>
      sum + (report.pairs || []).reduce((count, pair) => count + pair.rows.length, 0), 0) + " rows)");
  }
  if (out) writeFileSync(out, JSON.stringify({ summaries, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
