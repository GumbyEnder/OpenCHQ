// pb180_purse_summary - the strip's purse is a summary, the ledger stays in the title (PB-180).
//
// What fails if this is removed:
//   - the strip goes back to the whole 412 px economy string -> at 1280x800 it renders ellipsized in
//     an 88 px slot ("pool 50b · oil in 2200 / out 1754 / reserve …"), which is the live defect the
//     PM read on cb83906 and what made the PB-173 geometry leg's PB-180 arm impossible to green.
//   - the balance is read from anything but the player's own cash field -> the opponent's balance is
//     the one number the original keeps secret (Manual p.27); the Alternate Function may swap the
//     income leg, never the balance.
//   - the summary loses the income leg -> the original's Monitor Four carries income in billions per
//     round, and a cash-only chip is a different readout, not a shorter one.
//
// The behaviour in a real page is proved by tests/e2e/pb173-speed-slots.mjs, which measures the two
// legs at 1440/1280/1024 and requires the cash figure never to clip.
import {
  formatBillions,
  formatWholeBillions,
  purseSummary,
  purseSummaryParts,
  purseText,
} from "../../public/command.mjs";

export const name = "pb180_purse_summary";

function fail(message) {
  throw new Error(message);
}

function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(label + ": got " + a + ", want " + b);
}

const seat = {
  cash: 116000,
  fuel: 8,
  payIn: 3,
  income: { cities: 29, wells: 0, cashWells: 0, amount: 1450 },
  oil: { held: 2200, in: 1754, out: 3000, cap: 10000, short: true, uses: true },
  foeOil: { held: 900, in: 800, out: 1000, cap: 10000, short: false, uses: true },
  reserves: [],
};

export async function run() {
  // The shape the PM named: cash in whole billions, then income per round.
  const parts = purseSummaryParts(seat);
  eq("the summary's cash leg", parts.cash, "116b");
  eq("the summary's income leg", parts.income, " +1.45b/rd");
  eq("the summary text", purseSummary(seat), "116b +1.45b/rd");

  // Whole billions, truncated: 116,999 million is still 116 on the main display.
  eq("the cash leg truncates to whole billions", purseSummaryParts({ ...seat, cash: 116999 }).cash, "116b");
  eq("a sub-billion balance prints the billion below it", purseSummaryParts({ ...seat, cash: 949 }).cash, "0b");

  // The ledger is NOT in the strip any more, and the numbers it held are still buildable for the
  // chip's title and the Economy dialogue.
  const full = purseText(seat);
  if (/\bpool\b/.test(purseSummary(seat))) fail("the strip still prints the ledger: " + purseSummary(seat));
  if (!/oil in 1754 \/ out 3000 \/ reserve 2200 of 10000/.test(full)) fail("the full string lost the oil budget: " + full);
  if (!/OIL SHORT/.test(full)) fail("the full string lost the short warning: " + full);
  if (!/payment in 3 rounds/.test(full)) fail("the full string lost the payday countdown: " + full);

  // The Alternate Function swaps the INCOME leg to the other side's public payday and never the
  // balance: the cash field is only ever the player's own.
  const foeParts = purseSummaryParts(seat, { cities: 12, amount: 800 });
  eq("the alternate keeps the player's cash", foeParts.cash, "116b");
  eq("the alternate names the foe income as such", foeParts.income, " +foe 0.8b/rd");
  if (/116b.*116b/.test(purseSummary(seat, { amount: 800 }))) fail("the alternate duplicated the balance");

  // No seat, no invented number.
  eq("no seat, no summary", purseSummary(null), "");
  eq("no seat, no cash leg", purseSummaryParts(null).cash, "");

  // The two formatters the summary is built from, pinned so a later refactor cannot re-round the
  // balance into 0.117b on the main display.
  eq("formatBillions on the income", formatBillions(1450), "1.45");
  eq("formatWholeBillions on the balance", formatWholeBillions(116000), "116");
}
