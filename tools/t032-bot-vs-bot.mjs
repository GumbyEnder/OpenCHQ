// T-032 Part C: headless bot-vs-bot harness. 1942 and 2023 (room 9389 §2).
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
// Verdict rule, stated because the engine has no capital-set win inside 50 rounds on this board.
// PB-257(b): side-neutral only, and it never reads a raw total. The old rule 3 (total sites) gave
// the 1942 blue opening 78 sites to 48 and decided ten C3 rows without a shot fired; it is gone.
//   1. a capital-set win, if the match produced one;
//   2. else CITIES TAKEN (end minus opening) at the round limit;
//   3. else FEWER CAPITALS LOST; 4. else FEWER UNITS LOST (destroyed, not net alive); 5. else a draw.
// PB-258 (PM 9414 §2): rung 4 counts pieces LOST, not pieces alive. Raw alive is a total, and the
// 1942 opening is 29/31, so "more alive" decided matches on the opening the same way total sites did.
// PB-270 (D3, card PB-270; room 9607 §2): `aliveStart - aliveEnd` is NET, so it is negative wherever
// a side produces and rung 4 was awarding production. Rung 4 now reads units LOST only, from the
// ledger in tools/lib/pb270-units.mjs (start + built + capturedIn - lost - capturedOut === end on
// every row). `unitsBuilt` rides beside it; nothing prints a negative "losses" figure.
// PB-258 (PM 9423 §2): a pairing whose two seats are the SAME level prints unmeasurable. winnerLevel
// names a level, so with 3v3 both aWins and bWins count the same rows and the line is not a rate;
// the report keeps a per-seat split and the distinct-outcome count instead.
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
// Era coverage (Part C order, room 9389 §2): 1942 and 2023. The 1942 opening is file data and the
// engine carries no RNG, so a 20-match 1942 pairing samples 2 distinct games and says so. 2023 rolls
// its two capitals from the seed (`capitalSetFor` -> `capitalSet(era, sites, seed)`), so 2023 runs
// `--seeds distinct`: each of the 20 matches gets its own seed, and the side assignment alternates by
// seed parity so both seats still play both levels ten times each.
//
// Usage:
//   node tools/t032-bot-vs-bot.mjs [--era 1918|1942|1986|2023] [--seeds mirror|distinct] [--rounds 50]
//                                 [--matches 20] [--out <path>] [--pairs 3:2,4:3,5:4]
//                                 [--c3] [--seed-base 1942] [--handicap-grid]
//                                 [--handicap-steps -0.3,...,0.3] [--handicap-billions N]
//                                 [--seed-axis]
//
// PB-260: `--handicap-grid` turns the opponent's starting-money spinner (Manual p.17) into a board
// sweep. For every seed it plays 7 steps (-30,-20,-10,0,+10,+20,+30 percent of the era's
// handicapDefault) and seat-pairs every step: A as blue once and A as red once, with the handicap
// on the B level's side in both. In this mode `--matches` counts SEEDS, not matches: rows per block =
// seeds x 7 steps x 2 seats. The grid is a harness flag only; no engine, config or bot RNG changes.
// PB-270(c): `--handicap-steps` and `--handicap-billions` widen that sweep, so a control can put a
// large cash handicap on one seat and show whether the grid can resolve ANY strength axis at an era.
// PB-270(a): `--seed-axis` plays the first pair at step 0, one seat, across `--matches` seeds and
// prints how many DISTINCT row objects those seeds produced (seed and match index excluded). It is
// the measurement behind "the engine carries no RNG": 1 means the seed is provenance, not sampling.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import { ordersFor } from "../web/server/bot.mjs";
import { ordersFor as prePortOrdersFor } from "../web/server/bot-c20dba7.mjs";
import { buy, seedOwners } from "../web/server/economy.mjs";
import { issueOrder } from "../web/server/move.mjs";
import { dispatchRepeatLimit, dispatchRepeatPool, handicapDefault, spareActionBudget, spareActionPassCap } from "../web/server/rules.mjs";
import { distinctCount, resolveVerdict, rowFingerprint, unitLedger } from "./lib/pb270-units.mjs";

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
const ERA = String(arg("era", "1942"));
const SEED_MODE = String(arg("seeds", "mirror"));
if (SEED_MODE !== "mirror" && SEED_MODE !== "distinct") {
  throw new Error("--seeds must be mirror or distinct");
}
const PAIRS = String(arg("pairs", "3:2,4:3,5:4"))
  .split(",")
  .map((row) => row.split(":").map((value) => Number(value)))
  .filter((row) => row.length === 2 && row.every(Number.isInteger));
const RUN_C3 = process.argv.includes("--c3");
// PB-260: symmetric handicap grid. `null` means the flag is off and the harness behaves exactly as
// before (one board per seed, both seats). With the flag on, every seed is played at each step.
const HANDICAP_GRID = process.argv.includes("--handicap-grid");
// PB-270(c): the sweep is data, so a control can put a large cash handicap on one seat. The default
// stays the PB-260 seven steps; `--handicap-steps` names any list (fractions of the era default) and
// `--handicap-billions` overrides the default itself (the spinner value, in billions).
const HANDICAP_STEP_LIST = String(arg("handicap-steps", "-0.3,-0.2,-0.1,0,0.1,0.2,0.3"))
  .split(",").map((value) => Number(value)).filter((value) => Number.isFinite(value));
const HANDICAP_STEPS = HANDICAP_GRID ? HANDICAP_STEP_LIST : [0];
const HANDICAP_BILLIONS_ARG = arg("handicap-billions", null);
const HANDICAP_DEFAULT = HANDICAP_GRID
  ? (HANDICAP_BILLIONS_ARG === null ? handicapDefault(ERA) : Number(HANDICAP_BILLIONS_ARG))
  : null;
const SEED_AXIS = process.argv.includes("--seed-axis");
// PB-270(c): roster control. `--roster-drop N` removes N starting land units from the B level's
// seat before the opening snapshot, i.e. it hands the OTHER seat a known strength edge. It is a
// harness fixture only (the engine never sees a roster lever): the point is to show whether the
// grid can register ANY stronger side at an era whose cash sweep resolves nothing.
const ROSTER_DROP = Math.max(0, Number(arg("roster-drop", 0)) || 0);
if (HANDICAP_GRID && (HANDICAP_DEFAULT === null || !Number.isFinite(HANDICAP_DEFAULT))) {
  throw new Error("--handicap-grid: era " + ERA + " has no handicapDefault");
}
// PB-257(a): which seat's order set is FILED first. Both seats always PLANNED from the same
// pre-round snapshot; this flag only moves the filing order, so `base` vs `swap` is the control that
// shows whether call order still decides the match.
const FILE_ORDER = String(arg("file-order", "base"));
if (FILE_ORDER !== "base" && FILE_ORDER !== "swap") {
  throw new Error("--file-order must be base or swap");
}
const FILE_SEQUENCE = FILE_ORDER === "swap" ? ["red", "blue"] : ["blue", "red"];
const OUT = arg("out", "local/evidence/t032c/bot-vs-bot.json");

const board = boardPayload();
const sites = matchSites(ERA, board);

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

// PB-257(a): the two ordersFor calls read the SAME pre-round snapshot, then both order sets are
// filed. `ordersFor` mutates the match as it files (web/server/bot.mjs:801), so the old loop - ask
// blue, let it file, then ask red - made red read a board blue had already changed, and the
// first-called seat won every match (room 9398). Here each seat plans on its own clone of the
// pre-round match and the rows are replayed into the live match in FILE_SEQUENCE.
const cloneMatch = (value) => (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

function planOrders(match, side, level) {
  const plan = cloneMatch(match);
  let rows;
  if (level === "pre") {
    rows = prePortOrdersFor(plan, side) || [];
  } else {
    // `opponentLevel` is a match field; the harness sets it on the snapshot the seat reads.
    plan.opponentLevel = level;
    rows = ordersFor(plan, side) || [];
  }
  return {
    side,
    level,
    rows,
    pool: plan.botRepeatPool && typeof plan.botRepeatPool === "object" ? plan.botRepeatPool[side] : undefined,
  };
}

// Replay one seat's planned rows onto the live match. Buys go back through economy.buy with the cell
// the plan chose; orders and defends through move.issueOrder. A refusal is recorded, not swallowed:
// a plan that cannot be filed is a measurement, not a silent zero.
function fileOrders(match, plan, filed, builtIds) {
  const side = plan.side;
  const remap = new Map();
  for (const row of plan.rows) {
    if (row.type === "bot_buy") {
      const at = row.at || {};
      let result;
      try {
        // PB-262: the level AND the intent travel into the replay. buy() grew a level argument at
        // 463b45c and, from 1fbafff (4/4), the escape from the readiness refusal is keyed on
        // options.allowUnreadySite, never on the number. botBuy puts that flag on the bot_buy event
        // it emits (bot.mjs "The replay record for tools/pb262-buy-draw-census.mjs"), so a replay
        // that passes only six arguments re-files the plan under the REFUSAL rule: at level 5 the
        // plan may draw from a still-counting-down anchor site and the six-arg replay drops the buy
        // ("Vladivostok isn't ready: it will be ready at round 22.") plus every defend row naming
        // the piece it would have created. Measured at 1fbafff, grid off, 1942: 160 refusals over
        // the 5v2 block (80 buys + 80 cascaded defends) and 610 over 5v1, and the L5 arm then
        // "lost" the block 10/10 to L2 on pieces lost purely from the dropped buys. Carrying
        // row.allowUnreadySite -- exactly as tools/pb262-buy-draw-census.mjs:122 already does --
        // takes every one of those refusals to 0.
        result = buy(match, side, row.kind || "infantry", at.x, at.y, board, plan.level,
          { allowUnreadySite: row.allowUnreadySite === true });
      } catch (err) {
        result = { error: String((err && err.message) || err) };
      }
      if (result && result.ok) {
        remap.set(row.pieceId, result.piece.id);
        // PB-270 D3: a successful buy is a UNIT BUILT. The id goes into the ledger so rung 4 can
        // read losses without treating production as attrition.
        if (builtIds && builtIds[side]) builtIds[side].add(String(result.piece.id));
        filed.buy += 1;
      } else {
        filed.refused.push({ type: row.type, pieceId: row.pieceId, error: (result && result.error) || "refused" });
      }
      continue;
    }
    if (row.type === "bot_order" || row.type === "bot_defend") {
      const pieceId = remap.has(row.pieceId) ? remap.get(row.pieceId) : row.pieceId;
      const to = row.to || {};
      let result;
      try {
        result = issueOrder(match, side, pieceId, to.x, to.y);
      } catch (err) {
        result = { error: String((err && err.message) || err) };
      }
      if (result && result.ok) {
        if (row.type === "bot_order") filed.order += 1;
        else filed.defend += 1;
      } else {
        filed.refused.push({ type: row.type, pieceId: row.pieceId, error: (result && result.error) || "refused" });
      }
      continue;
    }
    if (row.type === "bot_replan") {
      const piece = match.pieces.find((unit) => unit.id === row.pieceId);
      if (piece) {
        piece.path = [];
        piece.holdRounds = 0;
      }
    }
  }
  // The repeat counter was spent on the clone during planning; carry the figure the planner ended
  // with, exactly as an in-place filing would have left it. The pool must be CREATED here if the
  // live match has none yet: leaving it absent re-seeds 2*level-4 on the next round's clone, which
  // is the per-turn refill stand-in the card retired.
  if (plan.pool !== undefined) {
    if (!match.botRepeatPool || typeof match.botRepeatPool !== "object") match.botRepeatPool = {};
    match.botRepeatPool[side] = plan.pool;
  }
  return filed;
}

// One match. `levels` is {blue, red}; a level of "pre" plays the frozen c20dba7 bot.
// PB-260: `handicapLevel` names the seat the spinner handicaps (the B level), `handicapStep` is the
// fraction of the era default applied to that seat's starting cash. With the grid off both are
// undefined and the opening is exactly the pre-PB-260 one.
function playMatch({ seed, index, levels, handicapLevel, handicapStep }) {
  const options = { seed, opponentLevel: 3 };
  let handicapSide = null;
  let handicapBillions = null;
  if (HANDICAP_GRID) {
    handicapSide = String(levels.blue) === String(handicapLevel) ? "blue" : "red";
    handicapBillions = Math.max(0, HANDICAP_DEFAULT * (1 + handicapStep));
    options.handicapSide = handicapSide;
    options.opponentPool = handicapBillions;
  }
  const match = openMatch(ERA, sites, options);
  match.seats = { blue: { username: "Bot A", kind: "bot" }, red: { username: "Bot B", kind: "bot" } };
  match.clock = "running";
  // PB-261b (PM 9468 §3): ownership is seeded BEFORE the opening is measured. `seedOwners` is what
  // writes the era's opening owners (economy.mjs:141) and, for a rolled era, re-draws the capital set
  // from the sites a side already owns; the engine seeds it lazily on the first buy. Snapshotting the
  // start first read 2023 as 0/0 (its owners are rolled, not file data), so every 2023 rung measured
  // "cities taken" against an empty board. Seeding here is idempotent (WeakSet) and changes no rule:
  // the first planOrders/buy of round 1 would have made the same call.
  seedOwners(match);
  // PB-270(c): the roster control drops starting units from the handicap seat BEFORE the opening is
  // measured, so the ledger's `start` is the handicapped opening, not the unmodified board.
  let roster = null;
  if (ROSTER_DROP > 0) {
    const side = String(levels.blue) === String(handicapLevel) ? "blue" : "red";
    const candidates = match.pieces
      .filter((piece) => piece && piece.side === side && piece.domain === "land" && Number(piece.strength) > 0)
      .sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1));
    const dropped = candidates.slice(-ROSTER_DROP).map((piece) => String(piece.id));
    const drop = new Set(dropped);
    match.pieces = match.pieces.filter((piece) => !drop.has(String(piece.id)));
    roster = { side, requested: ROSTER_DROP, dropped: dropped.length, ids: dropped };
  }
  const opening = openingCapitals(match);
  const start = { blue: cityCount(match, "blue"), red: cityCount(match, "red") };
  // PB-257(b) caveat, measured not assumed: a raw "pieces alive" count reads the opening when the
  // seats open with different armies (1942 opens 29/31), so rung 4 compares pieces LOST.
  // aliveStart stays on the row so the subtraction is auditable.
  const aliveOf = (row) => ({
    blue: row.pieces.filter((piece) => piece.side === "blue" && Number(piece.strength) > 0).length,
    red: row.pieces.filter((piece) => piece.side === "red" && Number(piece.strength) > 0).length,
  });
  const aliveStart = aliveOf(match);
  // PB-270 D3: the opening snapshot the ledger needs is the ID set, not just the count. A unit that
  // is dead at the end is LOST; a unit this side bought is BUILT. Nothing here is a net.
  const startSides = new Map(match.pieces
    .filter((piece) => piece && Number(piece.strength) > 0)
    .map((piece) => [String(piece.id), piece.side]));
  const builtIds = { blue: new Set(), red: new Set() };
  const events = {
    blue: { buy: 0, order: 0, defend: 0, repeat: 0 },
    red: { buy: 0, order: 0, defend: 0, repeat: 0 },
  };
  let capBound = 0; // no production cap exists (T-032 B7): nothing can bind. Kept as a printed 0.
  const filing = { refused: [], sequenced: FILE_ORDER };
  const filedCounts = { blue: { buy: 0, order: 0, defend: 0 }, red: { buy: 0, order: 0, defend: 0 } };
  while (!match.over && match.round < ROUNDS) {
    // A repeat spend and the buy's spend are the same counter (0xe94c): record the pool each side
    // actually held at the end so the session column is measured, not inferred.
    // PB-257(a): plan both seats off one snapshot, then file both sets in FILE_SEQUENCE.
    const plans = { blue: planOrders(match, "blue", levels.blue), red: planOrders(match, "red", levels.red) };
    for (const side of FILE_SEQUENCE) {
      const plan = plans[side];
      for (const event of plan.rows) {
        if (event.type === "bot_buy") events[side].buy += 1;
        if (event.type === "bot_order") events[side].order += 1;
        if (event.type === "bot_defend") events[side].defend += 1;
        if (event.repeat === true) events[side].repeat += 1;
      }
      const filed = fileOrders(match, plan, { buy: 0, order: 0, defend: 0, refused: [] }, builtIds);
      filedCounts[side].buy += filed.buy;
      filedCounts[side].order += filed.order;
      filedCounts[side].defend += filed.defend;
      filing.refused.push(...filed.refused.map((row) => ({ ...row, side, round: Number(match.round) || 0 })));
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
  const aliveTaken = { blue: alive.blue - aliveStart.blue, red: alive.red - aliveStart.red };
  // PB-270 D3: units LOST vs units BUILT, from the ledger. `unitsLost` is what rung 4 reads;
  // `unitsBuilt` is printed beside it so a reader can see that production is not attrition.
  // `aliveTaken` stays as the signed delta the D4 grader sums; it is named a delta, not a loss.
  const units = unitLedger({ startSides, builtIds, pieces: match.pieces });
  const unitsLost = units.lost;
  // Side-neutral: what each seat TOOK, not what it inherited. The 1942 blue opening holds 40 city
  // sites against red's 23, so "cities held" would hand blue every match before a shot is fired.
  const taken = { blue: citiesEnd.blue - start.blue, red: citiesEnd.red - start.red };
  const { verdict, rung: verdictRung } = resolveVerdict({
    over: Boolean(match.over && (match.winner === "blue" || match.winner === "red")),
    winner: match.winner,
    citiesTaken: taken,
    capitalsLost,
    unitsLost,
  });
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
    aliveStart,
    alive,
    aliveTaken,
    units,
    unitsLost,
    unitsBuilt: units.built,
    verdictRung,
    filing,
    filed: filedCounts,
    events,
    repeatPoolEnd: match.botRepeatPool && typeof match.botRepeatPool === "object"
      ? { ...match.botRepeatPool }
      : null,
    capBound,
    handicap: HANDICAP_GRID
      ? { step: handicapStep, side: handicapSide, billions: handicapBillions,
          cash: match.sides[handicapSide] ? match.sides[handicapSide].cash : null }
      : null,
    roster,
  };
}

// How the MATCHES are spread over seeds.
//   mirror   - the 1942 shape: MATCHES/2 seeds, each played twice, one per side assignment. 1942's
//              capitals are file data and the engine has no RNG, so this samples 2 distinct games.
//   distinct - one seed per match, side assignment alternating by seed parity, so a rolled era
//              (2023) samples MATCHES distinct games and still plays each seat ten times each.
function seedPlan(a, b, matches, base) {
  const rows = [];
  // PB-260: grid mode treats `matches` as a SEED count; every seed is played at all 7 handicap
  // steps, each step seat-paired, so the row count is seeds x steps x 2.
  if (HANDICAP_GRID) {
    for (let seedIndex = 0; seedIndex < matches; seedIndex++) {
      const seed = base + seedIndex;
      for (const step of HANDICAP_STEPS) {
        for (const levels of [{ blue: a, red: b }, { blue: b, red: a }]) {
          rows.push({ seed, levels, handicapStep: step });
        }
      }
    }
    return rows;
  }
  if (SEED_MODE === "distinct") {
    for (let index = 0; index < matches; index++) {
      const seed = base + index;
      rows.push({ seed, levels: index % 2 === 0 ? { blue: a, red: b } : { blue: b, red: a } });
    }
    return rows;
  }
  const seeds = Math.ceil(matches / 2);
  for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
    const seed = base + seedIndex;
    for (const levels of [{ blue: a, red: b }, { blue: b, red: a }]) {
      if (rows.length >= matches) break;
      rows.push({ seed, levels });
    }
  }
  return rows.slice(0, matches);
}

// A pairing runs MATCHES games over the seed plan above.
// PB-258 (PM 9423 §2): when both seats are the same LEVEL, winnerLevel names no seat - aWins and
// bWins count the same rows, so "20 wins / 20 losses over 20 matches" is not a rate. Such a pair is
// reported UNMEASURABLE; the seat split stays on the rows (row.verdict is blue/red), and row identity
// is the only evidence a same-level pairing can carry.
function runPair(a, b, matches) {
  const sameLevel = String(a) === String(b);
  const rows = [];
  for (const { seed, levels, handicapStep } of seedPlan(a, b, matches, SEED_BASE)) {
    const row = playMatch({ seed, index: rows.length + 1, levels, handicapLevel: b, handicapStep });
    // Who won, named by LEVEL rather than by side.
    row.winnerLevel = row.verdict === "draw" ? "draw" : String(row.levels[row.verdict]);
    rows.push(row);
  }
  const wins = rows.filter((row) => row.winnerLevel === String(a)).length;
  const losses = rows.filter((row) => row.winnerLevel === String(b)).length;
  const draws = rows.filter((row) => row.winnerLevel === "draw").length;
  const bySeat = {
    blue: rows.filter((row) => row.verdict === "blue").length,
    red: rows.filter((row) => row.verdict === "red").length,
  };
  // distinctOutcomes fingerprints every column the verdict reads, rung and unit ledger included, so
  // "2 distinct outcome(s)" is a claim about verdicts rather than about city counts alone. Seed and
  // match index are excluded (PB-270 D2): a fingerprint carrying the seed would manufacture a
  // difference for every seed and re-hide the inert axis.
  const distinct = new Set(rows.map(rowFingerprint));
  return {
    pair: String(a) + "v" + String(b),
    matches: rows.length,
    measurable: !sameLevel,
    unmeasurable: sameLevel ? "both seats are L" + a + ": winnerLevel names no seat, so aWins/bWins are not a rate" : null,
    bySeat,
    aWins: sameLevel ? null : wins,
    bWins: sameLevel ? null : losses,
    draws,
    winRateA: sameLevel ? null : (rows.length ? wins / rows.length : 0),
    required: 0.7,
    meets: sameLevel ? null : (rows.length ? wins / rows.length >= 0.7 : false),
    seeds: rows.map((row) => row.seed),
    distinctSeeds: new Set(rows.map((row) => row.seed)).size,
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
  era: ERA,
  seedMode: SEED_MODE,
  seedBase: SEED_BASE,
  rounds: ROUNDS,
  matchesPerPair: HANDICAP_GRID ? MATCHES * HANDICAP_STEPS.length * 2 : MATCHES,
  seedCount: MATCHES,
  handicapGrid: HANDICAP_GRID
    ? { steps: HANDICAP_STEPS, eraDefaultBillions: HANDICAP_DEFAULT, appliedTo: "the B level's seat" }
    : null,
  verdictRule: "capital-set win, else cities TAKEN by the round limit (side-neutral), else fewer capital losses, else FEWER UNITS LOST (destroyed or zero-strength units; built units are not losses), else draw; no raw total (sites, cities held, pieces alive) is ever read",
  planning: "both seats call ordersFor on their own clone of the same pre-round snapshot, then both order sets are filed into the live match in fileOrder",
  fileOrder: FILE_ORDER,
  levers: {
    spareActionBudget: [2, 3, 4, 5].map((level) => [level, spareActionBudget(level)]),
    passCap: spareActionPassCap(),
    armyRepeatPool: [2, 3, 4, 5].map((level) => [level, dispatchRepeatPool(level)]),
    armyRepeatReachable: [2, 3, 4, 5].map((level) => [level, dispatchRepeatLimit(level)]),
    productionCap: "none (T-032 B7: the unitCap lever was withdrawn; nothing can bind)",
  },
  pairs: [],
  c3: null,
  seedAxis: null,
};

for (const [a, b] of PAIRS) {
  const pair = runPair(a, b, MATCHES);
  pair.events = summarise(pair.rows);
  report.pairs.push(pair);
  console.log(
    pair.measurable
      ? "pair " + pair.pair + " (" + ERA + "): " + pair.aWins + " / " + pair.matches + " for L" + a +
        " (" + Math.round(pair.winRateA * 1000) / 10 + "%), " + pair.bWins + " losses, " + pair.draws +
        " draws, " + pair.distinctSeeds + " seed(s), " + pair.distinctOutcomes + " distinct outcome(s)"
      : "pair " + pair.pair + " (" + ERA + "): unmeasurable - both seats are level " + a +
        ", so no seat is named by winnerLevel and no line here is a rate; " + pair.matches + " match(es), " +
        "blue " + pair.bySeat.blue + " / red " + pair.bySeat.red + " / " + pair.draws + " draw(s), " +
        pair.distinctSeeds + " seed(s), " + pair.distinctOutcomes + " distinct outcome(s); row identity only"
  );
}

if (SEED_AXIS) {
  // PB-270(a): does the seed change the play? One arm, one step, one seat, `--matches` seeds. The
  // fingerprint excludes seed and match index, so this counts BOARD/PLAY bodies, not labels.
  const [a, b] = PAIRS[0];
  const rows = [];
  for (let index = 0; index < MATCHES; index++) {
    const seed = SEED_BASE + index;
    const row = playMatch({
      seed, index: index + 1, levels: { blue: a, red: b },
      handicapLevel: null, handicapStep: HANDICAP_GRID ? 0 : undefined,
    });
    rows.push(row);
  }
  const distinct = distinctCount(rows);
  report.seedAxis = {
    era: ERA,
    pair: String(a) + "v" + String(b),
    seat: "A as blue",
    step: HANDICAP_GRID ? 0 : "off",
    seeds: rows.map((row) => row.seed),
    seedCount: rows.length,
    distinctRows: distinct,
    nEffPerStepSeat: distinct,
    rows,
  };
  console.log("seed axis (" + ERA + ", " + a + "v" + b + ", A=blue): " + rows.length + " seed(s), " +
    distinct + " distinct row object(s) -> n_eff " + distinct + " per step and seat");
}

const allRows = report.pairs.flatMap((pair) => pair.rows);
const ledgerFailures = [];
for (const row of allRows) {
  for (const failure of row.units.identityFailures) ledgerFailures.push({ match: row.match, ...failure });
}
report.unitLedger = { rows: allRows.length, identityFailures: ledgerFailures };
console.log("unit ledger: " + allRows.length + " row(s), " + ledgerFailures.length + " identity failure(s)");

if (RUN_C3) {
  // Pre-port bot vs level 3, over the SAME seed plan as the pairs (PM 9420 §3: "same seeds for every
  // pair"). The C3 block used to run at SEED_BASE + 1000, which made its 2023 capitals a different
  // set of boards from the 3v2/4v3/5v4 blocks; with the offset gone every block on an era samples the
  // same seeds. The pre bot plays both sides, so the positional bias is the only asymmetry; the
  // level-3 seat is the shipped bot.
  const rows = [];
  for (const { seed, levels, handicapStep } of seedPlan("pre", 3, MATCHES, SEED_BASE)) {
    const row = playMatch({ seed, index: rows.length + 1, levels, handicapLevel: "pre", handicapStep });
    row.winnerLevel = row.verdict === "draw" ? "draw" : String(row.levels[row.verdict]);
    rows.push(row);
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
