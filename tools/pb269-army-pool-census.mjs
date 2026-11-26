// PB-269 E1 army-pool census: WHO spends 0xe94c, and does the buy count move?
//
// COMMITTED INSTRUMENT, NOT PRODUCT HARNESS. Nothing in the shipped server imports this file and
// `npm test` does not run it. Grade it as an artifact beside the PB-269 card, never as part of the
// bot-vs-bot path.
//
// PM 9581 §2 orders one read before any strength number: E1 (bot.portArmyPool) must change WHO
// spends the match-long counter, not HOW MUCH the bot buys. So every block emits the buy count
// beside the pool accounting, and the off/on buy counts are compared cell for cell.
//
// What is counted, per (era, level, seed) block, for each side:
//   buysPlanned   bot_buy rows the planner emitted
//   buysFiled     buys the engine accepted
//   buyRefuses    planned buys the engine refused (cash, readiness, slot)
//   armyRepeats   bot_order rows whose repeat flag is true (the dispatch drew on the counter)
//   armyRecords   bot_order rows whose recorded flag is true (counter was 0, cell struck out)
//   buyPoolSpends pool decrements attributable to the buy: poolStart - poolEnd - armyRepeats
//   repeatAtDefendedCell  army repeats landing on a cell holding an enemy piece or an enemy site
//                         (the concentration witness PM 9581 §2 asks for; "defended" is defined here
//                         as enemy-occupied, not as a combat roll)
//   poolStart / poolEnd  the counter at the block's first and last round
//   rowDigest     sha256 over the canonical JSON of every planner row, in order - the whole-row
//                 equality D1 reads (flag off vs the base tree must match it exactly)
//
// Run (one process per config, because rules.mjs resolves OPENCHQ_CONFIG once per load):
//   OPENCHQ_CONFIG=<cfg> node tools/pb269-army-pool-census.mjs \
//     --eras 1918,1942,1986,2023 --levels 1,2,3,4,5 --seeds 10 --rounds 50 \
//     --out <path.json> [--rows <path.jsonl>] [--tag off|on|base]
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import { ordersFor } from "../web/server/bot.mjs";
import { buy, seedOwners } from "../web/server/economy.mjs";
import { issueOrder } from "../web/server/move.mjs";
import { configPath, resetRules, rules } from "../web/server/rules.mjs";

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
const FLAG = BOT.portArmyPool === true;
const LEVEL_THRESHOLD = 3;

const board = boardPayload();
const clone = (value) => structuredClone(value);
const rowFile = ROWS_OUT ? openSync(ROWS_OUT, "w") : null;

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
      buyPoolSpends: 0, repeatAtDefendedCell: 0, poolStart: null, poolEnd: null },
    red: { buysPlanned: 0, buysFiled: 0, buyRefuses: 0, armyRepeats: 0, armyRecords: 0,
      buyPoolSpends: 0, repeatAtDefendedCell: 0, poolStart: null, poolEnd: null },
  };
  const digest = createHash("sha256");
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
      const rows = ordersFor(plan, side) || [];
      const poolAfter = plan.botRepeatPool && Number.isInteger(plan.botRepeatPool[side])
        ? plan.botRepeatPool[side] : null;
      if (stats[side].poolStart === null) stats[side].poolStart = poolBefore;
      if (poolAfter !== null) stats[side].poolEnd = poolAfter;
      const armyRepeats = rows.filter((row) => row.type === "bot_order" && row.repeat === true);
      stats[side].armyRepeats += armyRepeats.length;
      stats[side].armyRecords += rows.filter((row) => row.type === "bot_order" && row.recorded === true).length;
      if (poolBefore !== null && poolAfter !== null) {
        stats[side].buyPoolSpends += Math.max(0, poolBefore - poolAfter - armyRepeats.length);
      }
      for (const row of armyRepeats) {
        const to = row.to || {};
        if (enemyOccupied(plan, side, { x: to.x, y: to.y })) stats[side].repeatAtDefendedCell += 1;
      }
      stats[side].buysPlanned += rows.filter((row) => row.type === "bot_buy").length;
      plans[side] = { plan, rows, round: Number(match.round) || 0 };
    }
    for (const side of ["blue", "red"]) {
      const { plan, rows, round } = plans[side];
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
  return { era, level, seed, rounds, digest: digest.digest("hex"),
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

const totals = {};
for (const block of blocks) {
  const key = block.era + "|" + block.level;
  if (!totals[key]) {
    totals[key] = { era: block.era, level: block.level, matches: 0,
      buysPlanned: 0, buysFiled: 0, buyRefuses: 0, armyRepeats: 0, armyRecords: 0,
      buyPoolSpends: 0, repeatAtDefendedCell: 0, poolStartSum: 0, poolEndSum: 0, blocks: 0 };
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
    t.repeatAtDefendedCell += s.repeatAtDefendedCell;
    t.poolStartSum += s.poolStart === null ? 0 : s.poolStart;
    t.poolEndSum += s.poolEnd === null ? 0 : s.poolEnd;
  }
}

const out = {
  instrument: "tools/pb269-army-pool-census.mjs",
  claim: "E1 changes WHO spends 0xe94c, not how much the bot buys",
  tag: TAG,
  engine: { sha: SHA, branch: BRANCH, worktreeDirty: DIRTY, botBlob: BOT_BLOB, configPath: CFG, configActivated: FLAG ? "on" : "off", levelThreshold: LEVEL_THRESHOLD, seatFlags: SEAT_FLAGS, offConfig: OFF_CFG },
  params: { eras: ERAS, levels: LEVELS, seeds: SEEDS, seedBase: SEED_BASE, rounds: ROUNDS },
  blocks: blocks.map((b) => ({ era: b.era, level: b.level, seed: b.seed, rounds: b.rounds, digest: b.digest, end: b.end, ...b.stats })),
  totals: Object.values(totals).sort((a, b) => (a.era === b.era ? a.level - b.level : a.era < b.era ? -1 : 1)),
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ tag: TAG, out: OUT, rows: ROWS_OUT || null, blocks: blocks.length, flag: FLAG, sha: SHA, dirty: DIRTY }, null, 1));
