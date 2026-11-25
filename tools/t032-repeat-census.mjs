// T-032 B3 measurement: the counter value beside the observed repeats.
//
// The counter (0xe94c) is decided by the level: never set at level 1, `0x1a0*2 - 4` at levels 2-5,
// i.e. 0/2/4/6. Whether a turn actually SPENDS all of it depends on how many dispatches the army
// pass issues, so this prints both: the pool the turn started with, the repeats it spent, the cells
// it recorded, and the gap. A gap is honest data, not a failure.
//
// Run: node tools/t032-repeat-census.mjs [rounds]
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import { ordersFor } from "../web/server/bot.mjs";
import { dispatchRepeatPool, spareActionBudget } from "../web/server/rules.mjs";

const ROUNDS = Number(process.argv[2]) || 40;
const out = { era: "1942", rounds: ROUNDS, levels: [] };

for (const level of [1, 2, 3, 4, 5]) {
  const match = openMatch("1942");
  match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
  match.opponentLevel = level;
  match.clock = "running";
  const row = {
    level,
    counterAtTurnStart: dispatchRepeatPool(level),
    spareActionBudget: spareActionBudget(level),
    turns: 0,
    dispatches: 0,
    repeatsObserved: 0,
    cellsRecorded: 0,
    turnsWithRepeats: 0,
    turnsPoolExhausted: 0,
    maxRepeatsInOneTurn: 0,
    repeatHistogram: {},
    buys: 0,
    defends: 0,
  };
  for (let round = 1; round <= ROUNDS; round++) {
    const poolAtStart = dispatchRepeatPool(level);
    const events = ordersFor(match, "blue") || [];
    const orders = events.filter((event) => event.type === "bot_order");
    const repeats = orders.filter((event) => event.repeat === true).length;
    const recorded = orders.filter((event) => event.recorded === true).length;
    row.turns += 1;
    row.dispatches += orders.length;
    row.repeatsObserved += repeats;
    row.cellsRecorded += recorded;
    row.buys += events.filter((event) => event.type === "bot_buy").length;
    row.defends += events.filter((event) => event.type === "bot_defend").length;
    if (repeats > 0) row.turnsWithRepeats += 1;
    if (repeats > row.maxRepeatsInOneTurn) row.maxRepeatsInOneTurn = repeats;
    row.repeatHistogram[repeats] = (row.repeatHistogram[repeats] || 0) + 1;
    if (poolAtStart > 0 && repeats >= poolAtStart) row.turnsPoolExhausted += 1;
    tickMatch(match);
  }
  // Per TURN, not per campaign: the counter is a per-turn allowance, so the comparable figure is
  // the mean repeats a turn and the largest turn, beside the counter that turn started with.
  row.meanRepeatsPerTurn = row.turns ? Number((row.repeatsObserved / row.turns).toFixed(2)) : 0;
  row.gapPerTurn = Number((row.counterAtTurnStart - row.meanRepeatsPerTurn).toFixed(2));
  out.levels.push(row);
}

console.log(JSON.stringify(out, null, 2));
