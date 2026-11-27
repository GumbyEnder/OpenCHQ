// PB-262 buy-draw-site census: WHICH site's unit does a bot buy draw from, at level 4 and level 5.
//
// COMMITTED INSTRUMENT, NOT PRODUCT HARNESS. Nothing in the shipped server imports this file and
// `npm test` does not run it. It exists so the PB-262 behavioural arm is reproducible; grade it as an
// artifact beside the card, never as part of the bot-vs-bot path (frodo 9482 §3).
//
// Why a separate census and not the t032 arms: the level only shows when a buy anchors on a THREATENED
// site whose readiness timer is still running. The source (docs/re/AI.md §3, decompiled.c 1632-1635):
//
//   if ( (0x1a0 < 5 && site->0x10ae != 0 && 0x1478 == 0) || (0x1478 == 0 && 0x3f < site) ||
//        calculate_movement_cost(site cell) != 0 )
//        site = FUN_107e_307a(site, 0);     /* ANOTHER of our sites, re-tested 1642-1645 */
//   ... buy at `site`'s cell (FUN_107e_40a8, 1647)
//
// So at levels 2-4 an unready picked site is re-drawn to another of our sites; at level 5 (0x1a0 >= 5)
// the picked site is kept with its timer still running. The discriminator is therefore "did the buy
// draw from a site that was UNREADY when the AI decided", counted per level.
//
// The readiness reading is taken from a SNAPSHOT of site.readyRound at plan time, before either seat's
// rows are filed. Reading the live match at filing time is the defect the first PB-262 census run had
// (/mnt/nas/host-ops/openchq/pb262/buy-census.json, sha 8b4268c): a second buy in the same round reads
// the timer the FIRST buy just pooled and every row is labelled unready (1942 read 22/22 at BOTH
// levels, i.e. no discrimination at all). A buy is "unready" here only if its site's timer was already
// running when the plan was made.
//
// Usage: node tools/pb262-buy-draw-census.mjs [--eras 1942,1986] [--levels 4,5] [--matches 4]
//                                             [--rounds 50] [--out <path>]
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { tickMatch } from "../web/server/tick.mjs";
import { ordersFor, threatenedSites } from "../web/server/bot.mjs";
import { buy, seedOwners } from "../web/server/economy.mjs";
import { issueOrder } from "../web/server/move.mjs";
import { readyRoundOf } from "../web/server/readiness.mjs";

// Identity is resolved from THIS file's repo, never from the caller's cwd: a census run out of a
// mutant worktree while the shell sits in the delivered one hashed the delivered bot.mjs and printed
// it beside the mutant's numbers (the sha happened to match, the blob did not).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (argv) => execSync("git -C " + JSON.stringify(ROOT) + " " + argv, { encoding: "utf8" }).trim();

function arg(name, fallback) {
  const hit = process.argv.find((row) => row.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

const ERAS = String(arg("eras", "1942,1986")).split(",");
const LEVELS = String(arg("levels", "4,5")).split(",").map(Number);
const MATCHES = Math.max(1, Number(arg("matches", 4)));
const ROUNDS = Math.max(1, Number(arg("rounds", 50)));
const SEED_BASE = Number(arg("seed-base", 1942));
import { evidenceDir } from "../tests/e2e/evidence.mjs";
const OUT = String(arg("out", path.join(
  evidenceDir("pb262-buy-draw-census", process.env.CENSUS_OUT || ""),
  "buy-draw-census.json"
)));
const SHA = git("rev-parse HEAD");
// `dirty` must be readable by a grader: `true` / `false` / the string `"unknown"`. The old
// `DIRTY || null` collapsed "clean" and "git status failed" into one token and wrote `null`, which
// reads as neither (frodo 9492 §2). A failed status is not clean evidence.
function workingTreeDirty() {
  try {
    return git("status --porcelain").length > 0;
  } catch {
    return "unknown";
  }
}
const DIRTY = workingTreeDirty();
const FILE_SHA = git("hash-object web/server/bot.mjs");
const ENGINE_SHA = git("rev-parse " + SHA + ":web/server/bot.mjs");

const board = boardPayload();
const clone = (value) => structuredClone(value);

// The site standing on a cell, or null. The buy's plan row names a CELL; the site there is the one
// whose timer governs the draw.
function siteAtCell(match, x, y) {
  return (match.sites || []).find((site) => site && Number(site.x) === Number(x) && Number(site.y) === Number(y)) || null;
}

function runMatch(era, level, seed) {
  const match = openMatch(era, matchSites(era, board), { seed, opponentLevel: level });
  match.seats = { blue: { username: "A", kind: "bot" }, red: { username: "B", kind: "bot" } };
  match.clock = "running";
  seedOwners(match);
  const rows = [];
  while (!match.over && match.round < ROUNDS) {
    const round = Number(match.round) || 0;
    // Plan-time snapshot: the readiness every decision in this round was made against.
    const snap = new Map();
    for (const site of match.sites) if (site) snap.set(String(site.id), readyRoundOf(site));
    const plans = {};
    const anchors = {};
    for (const side of ["blue", "red"]) {
      const plan = clone(match);
      plan.opponentLevel = level;
      const threatened = threatenedSites(plan, side) || [];
      const anchorSite = threatened.length ? threatened[0].site : null;
      anchors[side] = anchorSite
        ? { id: anchorSite.id, name: anchorSite.name, x: Number(anchorSite.x), y: Number(anchorSite.y), readyRound: readyRoundOf(anchorSite) }
        : null;
      plans[side] = { side, level, plan, rows: ordersFor(plan, side) || [] };
    }
    for (const side of ["blue", "red"]) {
      const { plan } = plans[side];
      const remap = new Map();
      for (const row of plans[side].rows) {
        if (row.type === "bot_buy") {
          const at = row.at || {};
          const target = siteAtCell(match, at.x, at.y);
          const readyAtPlan = target ? (snap.has(String(target.id)) ? snap.get(String(target.id)) : readyRoundOf(target)) : 0;
          let filed;
          try {
            // Replay the bot's own decision: the escape travels on the event botBuy emitted, not
            // re-derived here from the level (frodo 9492 §4 - a level key is reachable by any
            // level-5 caller, so the census would then be grading a different rule than the bot).
            filed = buy(match, side, row.kind || "infantry", at.x, at.y, board, level,
              { allowUnreadySite: row.allowUnreadySite === true });
          } catch (err) {
            filed = { error: String((err && err.message) || err) };
          }
          const drawn = filed && filed.ok && filed.site !== null && filed.site !== undefined
            ? (match.sites || []).find((site) => site && String(site.id) === String(filed.site)) || null
            : target;
          rows.push({
            era, level, seed, round, side,
            cell: { x: at.x, y: at.y },
            plannedSiteId: target ? target.id : null,
            plannedSiteName: target ? target.name : null,
            readyRoundAtPlan: readyAtPlan,
            unreadyAtPlan: readyAtPlan > 0 && readyAtPlan > round,
            atAnchorCell: anchors[side] ? Number(at.x) === anchors[side].x && Number(at.y) === anchors[side].y : false,
            anchor: anchors[side],
            filed: Boolean(filed && filed.ok),
            error: filed && filed.error ? filed.error : null,
            drawnSiteId: drawn ? drawn.id : null,
            drawnSiteName: drawn ? drawn.name : null,
            drawnCell: filed && filed.ok && filed.piece ? { x: filed.piece.x, y: filed.piece.y } : null,
            levelReported: filed && filed.ok ? filed.level : null,
          });
          if (filed && filed.ok) remap.set(row.pieceId, filed.piece.id);
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
      if (plan.botRepeatPool && typeof plan.botRepeatPool === "object") {
        if (!match.botRepeatPool || typeof match.botRepeatPool !== "object") match.botRepeatPool = {};
        match.botRepeatPool[side] = plan.botRepeatPool[side];
      }
    }
    tickMatch(match);
  }
  return rows;
}

function summarise(block) {
  const planned = block.rows.length;
  const filed = block.rows.filter((row) => row.filed).length;
  const refused = planned - filed;
  const unready = block.rows.filter((row) => row.unreadyAtPlan);
  const unreadyFiled = unready.filter((row) => row.filed);
  const anchorUnreadyRows = block.rows.filter((row) => row.anchor && row.anchor.readyRound > row.round);
  const elsewhere = block.rows.filter((row) => row.filed && row.drawnCell
    && (Number(row.drawnCell.x) !== Number(row.cell.x) || Number(row.drawnCell.y) !== Number(row.cell.y)));
  return {
    era: block.era, level: block.level, seed: block.seed,
    plannedBuys: planned,
    filedBuys: filed,
    refusedBuys: refused,
    refusedReadiness: block.rows.filter((row) => row.error && /isn't ready/.test(String(row.error))).length,
    unreadyAtPlanBuys: unready.length,
    unreadyAtPlanFiled: unreadyFiled.length,
    unreadyAtPlanAtAnchorCell: unready.filter((row) => row.atAnchorCell).length,
    unreadyAtPlanRefused: unready.filter((row) => !row.filed).length,
    readyBuys: block.rows.filter((row) => !row.unreadyAtPlan).length,
    drawsAtAnchorCell: block.rows.filter((row) => row.filed && row.atAnchorCell).length,
    drawsElsewhere: elsewhere.length,
    anchorUnreadyRounds: anchorUnreadyRows.length,
    anchorUnreadyDrewAnchor: anchorUnreadyRows.filter((row) => row.filed && row.atAnchorCell).length,
    anchorUnreadyDrewElsewhere: anchorUnreadyRows.filter((row) => row.filed && !row.atAnchorCell).length,
    anchorUnreadyRefused: anchorUnreadyRows.filter((row) => !row.filed).length,
    levelsReported: [...new Set(block.rows.map((row) => String(row.levelReported)))],
  };
}

const out = {
  task: "PB-262", sha: SHA, root: ROOT, dirty: DIRTY,
  botBlobWorktree: FILE_SHA, botBlobAtSha: ENGINE_SHA,
  engineDiffersFromSha: FILE_SHA !== ENGINE_SHA,
  rounds: ROUNDS, matches: MATCHES, blocks: [], summary: [],
};
for (const era of ERAS) {
  for (const level of LEVELS) {
    const rows = [];
    for (let index = 0; index < MATCHES; index += 1) {
      // Mirror seating: even indexes blue=A/red=B, odd swapped, so both seats play both roles.
      const seed = SEED_BASE + Math.floor(index / 2);
      rows.push(...runMatch(era, level, seed));
    }
    const block = summarise({ era, level, seed: SEED_BASE, rows });
    out.blocks.push(block);
    out.summary.push(...rows.map((row) => ({
      era: row.era, level: row.level, seed: row.seed, round: row.round, side: row.side,
      plannedSiteId: row.plannedSiteId, readyRoundAtPlan: row.readyRoundAtPlan,
      unreadyAtPlan: row.unreadyAtPlan, atAnchorCell: row.atAnchorCell,
      anchorUnready: row.anchor ? row.anchor.readyRound > row.round : null,
      filed: row.filed, drawnSiteId: row.drawnSiteId, error: row.error,
    })));
    console.log(
      [era, "L" + level].join(" ") +
      ": planned " + block.plannedBuys + ", filed " + block.filedBuys + ", refused " + block.refusedBuys +
      " (readiness " + block.refusedReadiness + "), unreadyAtPlan " + block.unreadyAtPlanBuys +
      " (filed " + block.unreadyAtPlanFiled + ", at anchor cell " + block.unreadyAtPlanAtAnchorCell + ")," +
      " anchor-unready rounds " + block.anchorUnreadyRounds + " -> anchor " + block.anchorUnreadyDrewAnchor +
      " / elsewhere " + block.anchorUnreadyDrewElsewhere + " / refused " + block.anchorUnreadyRefused +
      ", draws elsewhere " + block.drawsElsewhere,
    );
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log("wrote " + OUT + " sha " + SHA + " bot.mjs blob " + FILE_SHA +
  " (at sha " + ENGINE_SHA + (FILE_SHA !== ENGINE_SHA ? ", MUTANT" : "") + ") root " + ROOT +
  " dirty " + (DIRTY === "unknown" ? "unknown" : (DIRTY ? "true" : "false")));
