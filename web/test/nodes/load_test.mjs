// node `load_test`: a thousand rooms inside one round.
//
// Runs the real capacity probe as a child process, so it gets its own throwaway SQLite file
// and cannot touch the harness database, then asserts the numbers the probe printed. The
// probe ticks real matches and stores them with rooms.saveRoom; nothing here is a stand-in.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const name = "load_test";

export function run() {
  let output = "";
  try {
    output = execFileSync(process.execPath, ["tools/bench-rooms.mjs", "1000", "8"], {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const text = String((err && (err.stdout || err.message)) || err);
    throw new Error("bench-rooms failed: " + text.trim().split("\n").slice(-3).join(" | "));
  }

  const line = output.split("\n").find((row) => row.startsWith("BENCH_JSON "));
  if (!line) throw new Error("bench-rooms printed no BENCH_JSON line");
  const report = JSON.parse(line.slice("BENCH_JSON ".length));

  if (report.rooms !== 1000 || report.pieces !== 8) {
    throw new Error("bench measured " + report.rooms + " rooms x " + report.pieces + " pieces, not 1000 x 8");
  }
  if (!(report.tickHeadroom > 10)) {
    throw new Error("tick headroom " + report.tickHeadroom + "x, need >10x inside the 0.14 s round");
  }
  if (!(report.roundHeadroom > 10)) {
    throw new Error("round headroom " + report.roundHeadroom + "x, need >10x including the store slice");
  }
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

  console.log(
    `load_test: ${report.rooms} rooms x ${report.pieces} pieces, tick ${report.tickHeadroom}x, ` +
      `round ${report.roundHeadroom}x, held ${report.heldWrites} writes, ` +
      `durable ${report.durable}/1000, ${report.roundTripSteps} route steps round-tripped`
  );
}
