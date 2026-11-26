// PB-269 E2 focus-band census: does the bounded per-piece focus DIVERGE, and by how much?
//
// COMMITTED INSTRUMENT, NOT PRODUCT HARNESS. Nothing in the shipped server imports this file and
// `npm test` does not run it. Grade it as an artifact beside the PB-269 card, never as part of the
// bot-vs-bot path.
//
// Derived from tools/pb269-army-pool-census.mjs (E1), unchanged except for one witness: bot.mjs's
// `setFocusBandTrace` fires once per marching piece that opened a band decision, and this instrument
// counts, per block, how many of those landed INSIDE the band (the per-piece focus was used) and how
// many fell OUTSIDE (the army-wide focus stood). `dist` is the histogram of Chebyshev distances
// between the piece's own focus and the army-wide one, so a re-grader can see whether the band is
// binding or whether the two focuses simply coincide.
//
// The row digest is computed exactly as E1's instrument computed it (canonical JSON of every planner
// row, in order), so D1 parity against a base tree is comparable across the two instruments.
//
// Run (one process per config, because rules.mjs resolves OPENCHQ_CONFIG once per load):
//   OPENCHQ_CONFIG=<cfg> node tools/pb269-e2-focus-band-census.mjs \\
//     --eras 1918,1942,1986,2023 --levels 1,2,3,4,5 --seeds 10 --rounds 50 --out <path.json> --tag on
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import * as botModule from "../web/server/bot.mjs";
import { buy, seedOwners } from "../web/server/economy.mjs";
import { issueOrder } from "../web/server/move.mjs";
import { configPath, dispatchRepeatPool, resetRules, rules } from "../web/server/rules.mjs";

const ordersFor = botModule.ordersFor;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (argv) => {
  try {
    return execSync("git -C " + JSON.stringify(ROOT) + " " + argv, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

function arg(name, fallback) {
  const hit = process.argv.find((row) => row.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

const ERAS = String(arg("eras", "1918,1942,1986,2023")).split(",");
const LEVELS = String(arg("levels", "1,2,3,4,5")).split(",").map(Number);
const SEEDS = Math.max(1, Number(arg("seeds", 10)));
const SEED_BASE = Number(arg("seed-base", 1942));
const ROUNDS = Math.max(1, Number(arg("rounds", 50)));
const OUT = arg("out", null);
if (!OUT) {
  console.error("--out is required: this instrument's JSON is the artifact");
  process.exit(2);
}
const ROWS_OUT = arg("rows", null);
const TRACE_OUT = arg("trace", null);
const TAG = String(arg("tag", "unknown"));
// Per-seat activation, for the direction arm: `--seat-flags blue:on,red:off` plans each seat under
// its own config, so one match is a legged seat against a faithful seat and the mirror is the same
// run with the flags swapped. rules() is memoised per load; resetRules() is its documented switch.
const OFF_CFG = arg("off-config", null);
const SEAT_FLAGS = (() => {
  const raw = arg("seat-flags", null);
  const out = { blue: null, red: null };
  if (!raw) return out;
  for (const part of String(raw).split(",")) {
    const [seat, value] = part.split(":");
    if ((seat === "blue" || seat === "red") && (value === "on" || value === "off")) out[seat] = value;
  }
  if ((out.blue === "off" || out.red === "off") && !OFF_CFG) {
    console.error("--seat-flags with off needs --off-config <path>");
    process.exit(2);
  }
  return out;
})();
function activate(seat) {
  const want = SEAT_FLAGS[seat];
  if (!want) return;
  process.env.OPENCHQ_CONFIG = want === "off" ? OFF_CFG : path.resolve(ROOT, "config", "game.json");
  resetRules();
}

const SHA = git("rev-parse HEAD");
const BRANCH = git("rev-parse --abbrev-ref HEAD");
let DIRTY;
try {
  DIRTY = git("status --porcelain").length > 0;
} catch {
  DIRTY = "unknown";
}
const BOT_BLOB = git("hash-object web/server/bot.mjs");
const CFG = configPath();
const BOT = rules().bot || {};
// Which lever this arm switches. E1 was portArmyPool; E2 is portFocusBand. Reading the E1 key here
// made the ON arm's own header print configActivated "off" and the stdout row print flag:false while
// the band was live — the trace, not this field, is what proved the config was active. Report the key
// name beside the value so a re-grader never has to guess which lever the boolean refers to.
const LEVER_KEY = "portFocusBand";
const BAND = BOT[LEVER_KEY];
const FLAG = BAND !== undefined && BAND !== null && BAND !== false;
const LEVEL_THRESHOLD = 3;

const board = boardPayload();
const clone = (value) => structuredClone(value);
const rowFile = ROWS_OUT ? openSync(ROWS_OUT, "w") : null;
const traceFile = TRACE_OUT ? openSync(TRACE_OUT, "w") : null;
// The pool ledger. bot.mjs exposes an out-of-band collector (added in the same commit as this
// switch); without it every mutation is invisible and the buy/army split can only be inferred from
// a delta, which is exactly what the trace exists to replace. Fail loudly rather than emit a delta.
const TRACE_READY = typeof botModule.setPoolTrace === "function";
if (TRACE_OUT && !TRACE_READY) {
  console.error("--trace requested but this tree's web/server/bot.mjs has no setPoolTrace export");
  process.exit(2);
}
let turnEvents = [];
if (TRACE_READY) botModule.setPoolTrace((event) => { turnEvents.push(event); });

function siteAtCell(match, x, y) {
  return (match.sites || []).find((site) => site && Number(site.x) === Number(x) && Number(site.y) === Number(y)) || null;
}

// End-of-block board, for the direction arm: cities held per seat, pieces alive per seat, and which
// side owns each capital at the final round. `capitalHeld` is true when the seat's own capital is
// still its own.
function outcomes(match, startBlue, startRed, boughtBlue, boughtRed) {
  const sites = (match.sites || []).filter(Boolean);
  const cities = (side) => sites.filter((site) => site.owner === side).length;
  const units = (side) => (match.pieces || []).filter((unit) => unit && unit.side === side).length;
  const capital = {};
  for (const side of ["blue", "red"]) {
    const at = match.capitals && match.capitals[side];
    const site = at ? siteAtCell(match, at.x, at.y) : null;
    capital[side] = { owner: site ? site.owner : null, held: Boolean(site && site.owner === side) };
  }
  return {
    round: Number(match.round) || 0,
    over: Boolean(match.over),
    citiesBlue: cities("blue"), citiesRed: cities("red"),
    piecesBlue: units("blue"), piecesRed: units("red"),
    capitalsLostBlue: capital.blue.held ? 0 : 1,
    capitalsLostRed: capital.red.held ? 0 : 1,
    // pieces lost = seeded at open + bought along the way - alive at the final round.
    piecesLostBlue: startBlue + boughtBlue - units("blue"),
    piecesLostRed: startRed + boughtRed - units("red"),
  };
}

function enemyOccupied(match, side, cell) {
  const foe = side === "blue" ? "red" : "blue";
  const piece = (match.pieces || []).find((unit) => unit && unit.side === foe
    && Number(unit.x) === Number(cell.x) && Number(unit.y) === Number(cell.y));
  if (piece) return true;
  const site = siteAtCell(match, cell.x, cell.y);
  return Boolean(site && site.owner === foe);
}

function runBlock(era, level, seed) {
  const match = openMatch(era, matchSites(era, board), { seed, opponentLevel: level });
  match.seats = { blue: { username: "A", kind: "bot" }, red: { username: "B", kind: "bot" } };
  match.clock = "running";
  seedOwners(match);
  const stats = {
    blue: { buysPlanned: 0, buysFiled: 0, buyRefuses: 0, armyRepeats: 0, armyRecords: 0,
      buyPoolSpends: 0, armyPoolSpends: 0, repeatAtDefendedCell: 0, poolSeed: null, poolStart: null, poolEnd: null },
    red: { buysPlanned: 0, buysFiled: 0, buyRefuses: 0, armyRepeats: 0, armyRecords: 0,
      buyPoolSpends: 0, armyPoolSpends: 0, repeatAtDefendedCell: 0, poolSeed: null, poolStart: null, poolEnd: null },
  };
  for (const side of ["blue", "red"]) stats[side].poolSeed = dispatchRepeatPool(level);
  const digest = createHash("sha256");
  const focus = { decisions: 0, inBand: 0, outOfBand: 0, dist: new Map() };
  botModule.setFocusBandTrace((event) => {
    focus.decisions += 1;
    if (event.inBand) focus.inBand += 1;
    else focus.outOfBand += 1;
    const key = String(event.dist);
    focus.dist.set(key, (focus.dist.get(key) || 0) + 1);
  });
  let rounds = 0;
  const startPieces = {
    blue: (match.pieces || []).filter((unit) => unit && unit.side === "blue").length,
    red: (match.pieces || []).filter((unit) => unit && unit.side === "red").length,
  };
  while (!match.over && match.round < ROUNDS) {
    rounds += 1;
    const plans = {};
    for (const side of ["blue", "red"]) {
      activate(side);
      const plan = clone(match);
      plan.opponentLevel = level;
      const poolBefore = plan.botRepeatPool && Number.isInteger(plan.botRepeatPool[side])
        ? plan.botRepeatPool[side] : null;
      turnEvents = [];
      const rows = ordersFor(plan, side) || [];
      const turnPoolEvents = turnEvents;
      turnEvents = [];
      const poolAfter = plan.botRepeatPool && Number.isInteger(plan.botRepeatPool[side])
        ? plan.botRepeatPool[side] : null;
      if (stats[side].poolStart === null) stats[side].poolStart = poolBefore;
      if (poolAfter !== null) stats[side].poolEnd = poolAfter;
      const armyRepeats = rows.filter((row) => row.type === "bot_order" && row.repeat === true);
      stats[side].armyRepeats += armyRepeats.length;
      stats[side].armyRecords += rows.filter((row) => row.type === "bot_order" && row.recorded === true).length;
      // With the ledger installed, attribute every decrement at its call site. Without it, fall
      // back to the arithmetic residual and say so in the artifact (`ledger` below).
      if (TRACE_READY) {
        for (const event of turnPoolEvents) {
          if (!(event.poolAfter < event.poolBefore)) continue;
          if (event.spender === "buy") stats[side].buyPoolSpends += event.poolBefore - event.poolAfter;
          else stats[side].armyPoolSpends += event.poolBefore - event.poolAfter;
        }
      } else if (poolBefore !== null && poolAfter !== null) {
        stats[side].buyPoolSpends += Math.max(0, poolBefore - poolAfter - armyRepeats.length);
      }
      for (const row of armyRepeats) {
        const to = row.to || {};
        if (enemyOccupied(plan, side, { x: to.x, y: to.y })) stats[side].repeatAtDefendedCell += 1;
      }
      stats[side].buysPlanned += rows.filter((row) => row.type === "bot_buy").length;
      plans[side] = { plan, rows, round: Number(match.round) || 0, turnPoolEvents };
    }
    for (const side of ["blue", "red"]) {
      const { plan, rows, round, turnPoolEvents } = plans[side];
      if (traceFile !== null) {
        writeSync(traceFile, JSON.stringify({
          era, level, seed, side, round,
          poolSeed: stats[side].poolSeed,
          turnStart: turnPoolEvents.length ? turnPoolEvents[0].poolBefore : null,
          turnEnd: turnPoolEvents.length ? turnPoolEvents[turnPoolEvents.length - 1].poolAfter : null,
          events: turnPoolEvents,
        }) + "\n");
      }
      const canonical = JSON.stringify({ era, level, seed, side, round, rows });
      digest.update(canonical);
      digest.update("\n");
      if (rowFile !== null) writeSync(rowFile, canonical + "\n");
      const remap = new Map();
      for (const row of rows) {
        if (row.type === "bot_buy") {
          const at = row.at || {};
          let filed = null;
          try {
            filed = buy(match, side, row.kind || "infantry", at.x, at.y, board, level,
              { allowUnreadySite: row.allowUnreadySite === true });
          } catch {
            filed = null;
          }
          if (filed && filed.ok) {
            stats[side].buysFiled += 1;
            if (filed.piece) remap.set(row.pieceId, filed.piece.id);
          } else {
            stats[side].buyRefuses += 1;
          }
          continue;
        }
        if (row.type === "bot_order" || row.type === "bot_defend") {
          const id = remap.get(row.pieceId) || row.pieceId;
          const to = row.to || {};
          try { issueOrder(match, side, id, to.x, to.y); } catch { /* refusal is not this census */ }
          continue;
        }
        if (row.type === "bot_replan") {
          const piece = match.pieces.find((unit) => unit.id === row.pieceId);
          if (piece) { piece.path = []; piece.holdRounds = 0; }
        }
      }
      // The counter is match-long: carry the planner's post-decision value back onto the live match.
      if (plan.botRepeatPool && typeof plan.botRepeatPool === "object") {
        if (!match.botRepeatPool || typeof match.botRepeatPool !== "object") match.botRepeatPool = {};
        match.botRepeatPool[side] = plan.botRepeatPool[side];
      }
    }
    tickMatch(match);
  }
  botModule.setFocusBandTrace(null);
  return { era, level, seed, rounds, digest: digest.digest("hex"),
    focus: { decisions: focus.decisions, inBand: focus.inBand, outOfBand: focus.outOfBand,
      dist: Object.fromEntries([...focus.dist].sort((a, b) => Number(a[0]) - Number(b[0]))) },
    end: outcomes(match, startPieces.blue, startPieces.red, stats.blue.buysFiled, stats.red.buysFiled), stats };
}

const blocks = [];
for (const era of ERAS) {
  for (const level of LEVELS) {
    for (let i = 0; i < SEEDS; i += 1) {
      const seed = SEED_BASE + i;
      const block = runBlock(era, level, seed);
      blocks.push(block);
      process.stderr.write(`[${TAG}] ${era} L${level} seed ${seed} buys ${block.stats.blue.buysFiled}/${block.stats.red.buysFiled} `
        + `repeats ${block.stats.blue.armyRepeats}/${block.stats.red.armyRepeats}\n`);
    }
  }
}

if (rowFile !== null) closeSync(rowFile);
if (traceFile !== null) closeSync(traceFile);

const totals = {};
for (const block of blocks) {
  const key = block.era + "|" + block.level;
  if (!totals[key]) {
    totals[key] = { era: block.era, level: block.level, matches: 0,
      buysPlanned: 0, buysFiled: 0, buyRefuses: 0, armyRepeats: 0, armyRecords: 0,
      buyPoolSpends: 0, armyPoolSpends: 0, repeatAtDefendedCell: 0,
      poolSeedSum: 0, poolStartSum: 0, poolEndSum: 0, blocks: 0 };
  }
  const t = totals[key];
  t.matches += 1;
  t.blocks += 1;
  for (const side of ["blue", "red"]) {
    const s = block.stats[side];
    t.buysPlanned += s.buysPlanned;
    t.buysFiled += s.buysFiled;
    t.buyRefuses += s.buyRefuses;
    t.armyRepeats += s.armyRepeats;
    t.armyRecords += s.armyRecords;
    t.buyPoolSpends += s.buyPoolSpends;
    t.armyPoolSpends += s.armyPoolSpends;
    t.repeatAtDefendedCell += s.repeatAtDefendedCell;
    t.poolSeedSum += s.poolSeed === null ? 0 : s.poolSeed;
    t.poolStartSum += s.poolStart === null ? 0 : s.poolStart;
    t.poolEndSum += s.poolEnd === null ? 0 : s.poolEnd;
  }
}

const out = {
  instrument: "tools/pb269-e2-focus-band-census.mjs",
  claim: "E2 changes WHICH point each piece aims at, only within R hexes of the army-wide focus",
  tag: TAG,
  engine: { sha: SHA, branch: BRANCH, worktreeDirty: DIRTY, botBlob: BOT_BLOB, configPath: CFG, leverFlag: LEVER_KEY, configActivated: FLAG ? "on" : "off", focusBand: BAND ?? null, levelThreshold: LEVEL_THRESHOLD, seatFlags: SEAT_FLAGS, offConfig: OFF_CFG },
  params: { eras: ERAS, levels: LEVELS, seeds: SEEDS, seedBase: SEED_BASE, rounds: ROUNDS },
  ledger: TRACE_READY ? "call-site" : "delta-residual",
  trace: TRACE_OUT || null,
  blocks: blocks.map((b) => ({ era: b.era, level: b.level, seed: b.seed, rounds: b.rounds, digest: b.digest, end: b.end, focus: b.focus || null, ...b.stats })),
  totals: Object.values(totals).sort((a, b) => (a.era === b.era ? a.level - b.level : a.era < b.era ? -1 : 1)),
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ tag: TAG, out: OUT, rows: ROWS_OUT || null, blocks: blocks.length, leverFlag: LEVER_KEY, flag: FLAG, sha: SHA, dirty: DIRTY }, null, 1));
