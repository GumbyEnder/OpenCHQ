// T-032 Part C: headless bot-vs-bot harness, 1942.
//
// What this measures, per the card's amended ACs:
//   C1  levels 3, 4 and 5 each beat the level below in >= 70% of 20 matches;
//   C3  the pre-port bot (git c20dba7:web/server/bot.mjs) loses to level 3 in >= 80% of 20;
//   C4  per match: win rate, cities taken by round 50, capital losses, whether unitCap bound;
//   C5  every seed is recorded, so a match can be re-run.
//
// C2 (level 1 issues no orders and no buys over 50 rounds) is the B2 arm of
// web/test/nodes/t032_bot_level.mjs, not a match here: a match needs two acting seats.
//
// Verdict rule, stated because the engine has no capital-set win inside 50 rounds on this board:
//   1. a capital-set win, if the match produced one;
//   2. else the side holding more CITIES (city + capital sites) at the round limit;
//   3. else total sites; 4. else surviving pieces; 5. else a draw.
// Sides are mirrored: every seed is played twice, once with each level as blue. The 1942 opening
// is asymmetric (blue opens with more sites), so an unmirrored win rate would measure the board,
// not the opponent. Note that 1942's capitals come from the file and the engine carries no RNG, so
// the 20 matches are 2 distinct games repeated 10x each; the seed list is still recorded (C5) and
// the report says how many distinct outcomes were actually sampled.
//
// The pre-port seat imports web/server/bot-c20dba7.mjs, a VERBATIM copy of
// `git show c20dba7:web/server/bot.mjs` (md5 cf1913649108c3b45be367fbd224efb2, equal to the blob).
// It sits beside the engine modules so its relative imports resolve; it is not the shipped bot and
// nothing in the server imports it.
//
// Usage:
//   node tools/t032-bot-vs-bot.mjs [--rounds 50] [--matches 20] [--out <path>] [--pairs 3:2,4:3,5:4]
//                                 [--c3] [--seed-base 1942]

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import { ordersFor } from "../web/server/bot.mjs";
import { ordersFor as prePortOrdersFor } from "../web/server/bot-c20dba7.mjs";
import { dispatchGroupSize, spareActionBudget, spareActionPassCap } from "../web/server/rules.mjs";

const CITY_KINDS = new Set(["city", "capital"]);

function arg(name, fallback) {
  const hit = process.argv.find((row) => row.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

const ROUNDS = Math.max(1, Number(arg("rounds", 50)));
const MATCHES = Math.max(1, Number(arg("matches", 20)));
const SEED_BASE = Number(arg("seed-base", 1942));
const PAIRS = String(arg("pairs", "3:2,4:3,5:4"))
  .split(",")
  .map((row) => row.split(":").map((value) => Number(value)))
  .filter((row) => row.length === 2 && row.every(Number.isInteger));
const RUN_C3 = process.argv.includes("--c3");
const OUT = arg("out", "local/evidence/t032c/bot-vs-bot.json");

const board = boardPayload();
const sites = matchSites("1942", board);

function cityCount(match, side) {
  return match.sites.filter((site) => site && site.owner === side && CITY_KINDS.has(String(site.kind))).length;
}

function siteCount(match, side) {
  return match.sites.filter((site) => site && site.owner === side).length;
}

function capitalLosses(match, openingOwner, side) {
  let lost = 0;
  for (const [id, owner] of openingOwner) {
    if (owner !== side) continue;
    const now = match.sites.find((site) => String(site.id) === id);
    if (!now || now.owner !== side) lost += 1;
  }
  return lost;
}

// The capital set is the match's own list (1942: six file capitals), never the site kind: two of
// 1986's capitals sit on rows the asset list calls a city.
function openingCapitals(match) {
  const map = new Map();
  const list = (match.capitalSet && Array.isArray(match.capitalSet.list)) ? match.capitalSet.list : [];
  for (const capital of list) {
    const site = match.sites.find((row) => String(row.id) === String(capital.siteId));
    if (site) map.set(String(site.id), site.owner);
  }
  return map;
}

// One match. `levels` is {blue, red}; a level of "pre" plays the frozen c20dba7 bot.
function playMatch({ seed, index, levels }) {
  const match = openMatch("1942", sites, { seed, opponentLevel: 3 });
  match.seats = { blue: { username: "Bot A", kind: "bot" }, red: { username: "Bot B", kind: "bot" } };
  match.clock = "running";
  const opening = openingCapitals(match);
  const start = { blue: cityCount(match, "blue"), red: cityCount(match, "red") };
  const events = { blue: { buy: 0, order: 0, defend: 0 }, red: { buy: 0, order: 0, defend: 0 } };
  let capBound = 0; // no production cap exists (T-032 B7): nothing can bind. Kept as a printed 0.
  while (!match.over && match.round < ROUNDS) {
    for (const side of ["blue", "red"]) {
      const level = levels[side];
      let rows;
      if (level === "pre") {
        rows = prePortOrdersFor(match, side) || [];
      } else {
        // `opponentLevel` is a match field; the harness sets it for the side whose orders it asks
        // for. title: the engine reads botLevel(match) inside ordersFor and caches nothing.
        match.opponentLevel = level;
        rows = ordersFor(match, side) || [];
      }
      for (const event of rows) {
        if (event.type === "bot_buy") events[side].buy += 1;
        if (event.type === "bot_order") events[side].order += 1;
        if (event.type === "bot_defend") events[side].defend += 1;
      }
    }
    tickMatch(match);
  }
  const citiesEnd = { blue: cityCount(match, "blue"), red: cityCount(match, "red") };
  const sitesEnd = { blue: siteCount(match, "blue"), red: siteCount(match, "red") };
  const capitalsLost = {
    blue: capitalLosses(match, opening, "blue"),
    red: capitalLosses(match, opening, "red"),
  };
  const alive = {
    blue: match.pieces.filter((piece) => piece.side === "blue" && Number(piece.strength) > 0).length,
    red: match.pieces.filter((piece) => piece.side === "red" && Number(piece.strength) > 0).length,
  };
  // Side-neutral: what each seat TOOK, not what it inherited. The 1942 blue opening holds 40 city
  // sites against red's 23, so "cities held" would hand blue every match before a shot is fired.
  const taken = { blue: citiesEnd.blue - start.blue, red: citiesEnd.red - start.red };
  const lostFewer = (a, b) => (a === b ? null : a < b ? "blue" : "red");
  let verdict;
  if (match.over && (match.winner === "blue" || match.winner === "red")) verdict = match.winner;
  else if (taken.blue !== taken.red) verdict = taken.blue > taken.red ? "blue" : "red";
  else {
    const fewer = lostFewer(capitalsLost.blue, capitalsLost.red);
    if (fewer) verdict = fewer;
    else if (sitesEnd.blue !== sitesEnd.red) verdict = sitesEnd.blue > sitesEnd.red ? "blue" : "red";
    else if (alive.blue !== alive.red) verdict = alive.blue > alive.red ? "blue" : "red";
    else verdict = "draw";
  }
  return {
    match: index,
    seed,
    levels,
    rounds: match.round,
    ended: Boolean(match.over),
    winner: match.winner || null,
    winReason: match.winReason || null,
    verdict,
    citiesStart: start,
    citiesEnd,
    citiesTaken: { blue: citiesEnd.blue - start.blue, red: citiesEnd.red - start.red },
    sitesEnd,
    capitalsLost,
    alive,
    events,
    capBound,
  };
}

// A pairing runs MATCHES games: seeds 1..MATCHES/2, each mirrored across the two side assignments.
function runPair(a, b, matches) {
  const rows = [];
  const seeds = Math.ceil(matches / 2);
  for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
    const seed = SEED_BASE + seedIndex;
    const assignments = [
      { blue: a, red: b },
      { blue: b, red: a },
    ];
    for (const levels of assignments) {
      if (rows.length >= matches) break;
      const row = playMatch({ seed, index: rows.length + 1, levels });
      // Who won, named by LEVEL rather than by side.
      row.winnerLevel = row.verdict === "draw" ? "draw" : String(row.levels[row.verdict]);
      rows.push(row);
    }
  }
  const wins = rows.filter((row) => row.winnerLevel === String(a)).length;
  const losses = rows.filter((row) => row.winnerLevel === String(b)).length;
  const draws = rows.filter((row) => row.winnerLevel === "draw").length;
  const distinct = new Set(rows.map((row) => [row.levels.blue, row.levels.red, row.citiesEnd.blue, row.citiesEnd.red, row.capitalsLost.blue, row.capitalsLost.red].join("|")));
  return {
    pair: String(a) + "v" + String(b),
    matches: rows.length,
    aWins: wins,
    bWins: losses,
    draws,
    winRateA: rows.length ? wins / rows.length : 0,
    required: 0.7,
    meets: rows.length ? wins / rows.length >= 0.7 : false,
    distinctOutcomes: distinct.size,
    rows,
  };
}

function summarise(rows) {
  const sum = { blue: { buy: 0, order: 0, defend: 0 }, red: { buy: 0, order: 0, defend: 0 } };
  for (const row of rows) {
    for (const side of ["blue", "red"]) {
      for (const key of ["buy", "order", "defend"]) sum[side][key] += row.events[side][key];
    }
  }
  return sum;
}

const started = process.hrtime.bigint();
const report = {
  task: "T-032 Part C",
  branch: "t032b-bot-port",
  sha: process.env.T032_SHA || execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
  era: "1942",
  rounds: ROUNDS,
  matchesPerPair: MATCHES,
  verdictRule: "capital-set win, else cities TAKEN by the round limit (side-neutral), else fewer capital losses, else total sites, else live pieces, else draw",
  levers: {
    spareActionBudget: [2, 3, 4, 5].map((level) => [level, spareActionBudget(level)]),
    passCap: spareActionPassCap(),
    dispatchGroupSize: [2, 3, 4, 5].map((level) => [level, dispatchGroupSize(level)]),
    productionCap: "none (T-032 B7: the unitCap lever was withdrawn; nothing can bind)",
  },
  pairs: [],
  c3: null,
};

for (const [a, b] of PAIRS) {
  const pair = runPair(a, b, MATCHES);
  pair.events = summarise(pair.rows);
  report.pairs.push(pair);
  console.log(
    "pair " + pair.pair + ": " + pair.aWins + " / " + pair.matches + " for L" + a +
      " (" + Math.round(pair.winRateA * 1000) / 10 + "%), " + pair.bWins + " losses, " + pair.draws +
      " draws, " + pair.distinctOutcomes + " distinct outcome(s)"
  );
}

if (RUN_C3) {
  // Pre-port bot vs level 3, mirrored. The pre bot plays both sides, so the positional bias is the
  // only asymmetry; the level-3 seat is the shipped bot.
  const rows = [];
  const seeds = Math.ceil(MATCHES / 2);
  for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
    const seed = SEED_BASE + 1000 + seedIndex;
    for (const levels of [{ blue: "pre", red: 3 }, { blue: 3, red: "pre" }]) {
      if (rows.length >= MATCHES) break;
      const row = playMatch({ seed, index: rows.length + 1, levels });
      row.winnerLevel = row.verdict === "draw" ? "draw" : String(row.levels[row.verdict]);
      rows.push(row);
    }
  }
  const preWins = rows.filter((row) => row.winnerLevel === "pre").length;
  const l3Wins = rows.filter((row) => row.winnerLevel === "3").length;
  const draws = rows.filter((row) => row.winnerLevel === "draw").length;
  report.c3 = {
    matches: rows.length,
    preWins,
    l3Wins,
    draws,
    l3WinRate: rows.length ? l3Wins / rows.length : 0,
    required: 0.8,
    meets: rows.length ? l3Wins / rows.length >= 0.8 : false,
    distinctOutcomes: new Set(rows.map((row) => [row.levels.blue, row.levels.red, row.citiesEnd.blue, row.citiesEnd.red].join("|"))).size,
    rows,
  };
  console.log(
    "C3 pre-port vs L3: L3 " + l3Wins + " / " + rows.length + " (" +
      Math.round((rows.length ? l3Wins / rows.length : 0) * 1000) / 10 + "%), pre " + preWins +
      ", draws " + draws + ", " + report.c3.distinctOutcomes + " distinct outcome(s)"
  );
}

const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
report.runMs = Math.round(elapsedMs);
report.finishedAt = new Date().toISOString();
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

// C4's table, one line per match, so the report is readable without the JSON.
report.pairs.concat(report.c3 ? [report.c3] : []).forEach((block) => {
  console.log("-- " + (block.pair || "c3"));
  for (const row of block.rows) {
    console.log(
      "  m" + row.match + " seed " + row.seed + " " + row.levels.blue + "v" + row.levels.red +
        " r" + row.rounds + " -> " + row.verdict + " cities " + row.citiesEnd.blue + "/" + row.citiesEnd.red +
        " (taken " + row.citiesTaken.blue + "/" + row.citiesTaken.red + ")" +
        " capital losses " + row.capitalsLost.blue + "/" + row.capitalsLost.red +
        " buys " + row.events.blue.buy + "/" + row.events.red.buy +
        " capBound " + row.capBound
    );
  }
});
console.log("run " + report.runMs + " ms over " + (report.pairs.length + (report.c3 ? 1 : 0)) + " block(s); wrote " + OUT);
