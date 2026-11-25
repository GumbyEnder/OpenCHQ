// T-032 B3 measurement: the counter value beside the observed repeats, behind the pass budget.
//
// The counter (0xe94c) is decided by the level: never set at level 1, `0x1a0*2 - 4` at levels 2-5,
// i.e. 0/2/4/6. Whether a turn actually SPENDS all of it depends on how many dispatches the army
// pass issues, so this prints both: the pool the turn started with, the repeats it spent, the cells
// it recorded, and the gap. A gap is honest data, not a failure.
//
// The pass budget composes with the pool: 1216-1218 enters the army pass only while `local_c < 3`
// and hands it `3 - local_c`, which already carries the buy and the defence pass, and 1218 adds
// every dispatch back. So in one turn the army can spend at most `min(e94c, 3 - spent)` repeats and
// issue at most `3 - spent` dispatches, and one cell can see at most `min(1 + e94c, 3 - spent)` of
// them. This tool counts all three over a campaign and records every turn that breaks a bound in
// `violations`, so the JSON is the artifact a gate reads, not a transcription of a console.
//
// The JSON stamps the commit it ran at (`commit`, `branch`, `worktreeDirty`), because era/rounds/
// levels alone identify no build.
//
// Run: node tools/t032-repeat-census.mjs [rounds]
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import { ordersFor } from "../web/server/bot.mjs";
import { dispatchRepeatPool, spareActionBudget, spareActionPassCap } from "../web/server/rules.mjs";

const ROUNDS = Number(process.argv[2]) || 40;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  try {
    return execSync("git -C " + JSON.stringify(repo) + " " + args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const sha = process.env.T032_SHA || git("rev-parse HEAD");
const branch = git("rev-parse --abbrev-ref HEAD");
const status = git("status --porcelain");
const cap = spareActionPassCap();

const out = {
  task: "T-032 B3",
  tool: "tools/t032-repeat-census.mjs",
  commit: sha,
  commitShort: sha ? sha.slice(0, 7) : null,
  branch,
  worktreeDirty: Boolean(status),
  capturedAt: new Date().toISOString(),
  era: "1942",
  rounds: ROUNDS,
  passCap: cap,
  reachableRule: "per turn: repeats <= min(e94c, 3 - spent), dispatches <= 3 - spent, same-cell <= min(1 + e94c, 3 - spent); spent is the buy plus the defence pass",
  levels: [],
};

for (const level of [1, 2, 3, 4, 5]) {
  const match = openMatch("1942");
  match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
  match.opponentLevel = level;
  match.clock = "running";
  const row = {
    level,
    counterAtTurnStart: dispatchRepeatPool(level),
    spareActionBudget: spareActionBudget(level),
    reachableRepeatsInOneTurn: Math.min(dispatchRepeatPool(level), cap),
    reachableSameCellDispatches: Math.min(1 + dispatchRepeatPool(level), cap),
    turns: 0,
    dispatches: 0,
    repeatsObserved: 0,
    cellsRecorded: 0,
    turnsWithRepeats: 0,
    turnsPoolExhausted: 0,
    maxDispatchesInOneTurn: 0,
    maxRepeatsInOneTurn: 0,
    maxRepeatsWithNothingSpent: 0,
    maxRepeatsWithActionSpent: 0,
    repeatHistogram: {},
    buys: 0,
    defends: 0,
    violations: [],
  };
  for (let round = 1; round <= ROUNDS; round++) {
    const poolAtStart = dispatchRepeatPool(level);
    const events = ordersFor(match, "blue") || [];
    const orders = events.filter((event) => event.type === "bot_order");
    const repeats = orders.filter((event) => event.repeat === true).length;
    const recorded = orders.filter((event) => event.recorded === true).length;
    const buys = events.filter((event) => event.type === "bot_buy").length;
    const defends = events.filter((event) => event.type === "bot_defend").length;
    const spent = buys + defends;
    const room = Math.max(0, cap - spent);
    row.turns += 1;
    row.dispatches += orders.length;
    row.repeatsObserved += repeats;
    row.cellsRecorded += recorded;
    row.buys += buys;
    row.defends += defends;
    if (repeats > 0) row.turnsWithRepeats += 1;
    if (orders.length > row.maxDispatchesInOneTurn) row.maxDispatchesInOneTurn = orders.length;
    if (repeats > row.maxRepeatsInOneTurn) row.maxRepeatsInOneTurn = repeats;
    if (repeats > 0 && spent === 0 && repeats > row.maxRepeatsWithNothingSpent) row.maxRepeatsWithNothingSpent = repeats;
    if (repeats > 0 && spent > 0 && repeats > row.maxRepeatsWithActionSpent) row.maxRepeatsWithActionSpent = repeats;
    row.repeatHistogram[repeats] = (row.repeatHistogram[repeats] || 0) + 1;
    if (poolAtStart > 0 && repeats >= poolAtStart) row.turnsPoolExhausted += 1;
    const repeatRoom = Math.min(poolAtStart, room);
    if (repeats > repeatRoom || orders.length > room) {
      if (row.violations.length < 8) {
        row.violations.push({ round, dispatches: orders.length, repeats, buys, defends, spent, room, repeatRoom });
      }
    }
    tickMatch(match);
    if (match.over) break;
  }
  // Per TURN, not per campaign: the counter is a per-turn allowance, so the comparable figure is
  // the mean repeats a turn and the largest turn, beside the counter that turn started with.
  row.meanRepeatsPerTurn = row.turns ? Number((row.repeatsObserved / row.turns).toFixed(2)) : 0;
  row.meanDispatchesPerTurn = row.turns ? Number((row.dispatches / row.turns).toFixed(2)) : 0;
  row.gapPerTurn = Number((row.counterAtTurnStart - row.meanRepeatsPerTurn).toFixed(2));
  out.levels.push(row);
}

// The campaign above never buys or defends on a fresh 1942 board, so the "spent" half of the rule
// needs its own turn: the same board shape the B3 arm uses, with cash so the buy acts and, in the
// second probe, three threatened sites so the defence pass takes two of the three actions. The army
// then gets `3 - spent`, which is what the rule says it should get.
function probePiece(id, side, x, y) {
  return { id, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1, strength: 100, maxStrength: 100 };
}
function spentTurnFixture(level, threatened) {
  const sites = [1, 2, 3].map((n) => ({ id: "s" + n, name: "S" + n, kind: "city", owner: "blue", x: 20 + n * 20, y: 40 }));
  const probe = {
    era: "1942", round: 1, pieces: [], sites,
    capitals: { blue: { x: 20, y: 40 }, red: { x: 200, y: 40 } },
    capitalSet: { list: sites.map((site) => ({ siteId: site.id, name: site.name })) },
    sides: { blue: { cash: 1e6, bought: 0 }, red: { cash: 0, bought: 0 } },
    seats: { blue: { kind: "bot" }, red: { kind: "human" } },
    opponentLevel: level,
  };
  for (const site of sites) {
    if (threatened) {
      probe.pieces.push(probePiece("red" + site.id + "a", "red", site.x + 1, site.y),
        probePiece("red" + site.id + "b", "red", site.x, site.y + 1));
    }
    for (let k = 0; k < 8; k++) probe.pieces.push(probePiece("blue" + site.id + ":" + k, "blue", site.x - 4 + k, site.y + 25));
  }
  return probe;
}

const probes = [];
for (const level of [2, 3, 4, 5]) {
  for (const [label, threatened] of [["buy only", false], ["buy and two defenders", true]]) {
    const probe = spentTurnFixture(level, threatened);
    const events = ordersFor(probe, "blue") || [];
    const buys = events.filter((event) => event.type === "bot_buy").length;
    const defends = events.filter((event) => event.type === "bot_defend").length;
    const orders = events.filter((event) => event.type === "bot_order");
    const repeats = orders.filter((event) => event.repeat === true).length;
    const spent = buys + defends;
    const room = Math.max(0, cap - spent);
    probes.push({
      level,
      turn: label,
      buys,
      defends,
      spent,
      room,
      dispatches: orders.length,
      repeats,
      withinRoom: orders.length <= room,
    });
  }
}
out.spentTurnProbes = probes;

console.log(JSON.stringify(out, null, 2));
