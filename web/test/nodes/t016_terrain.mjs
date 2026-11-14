// t016_terrain — every original terrain effect, tagged and wired from config (T-016).
//
// What fails if this is removed:
//   - a terrain value exists in code and not in config             -> a tuning edit silently
//     misses the runtime, and the report's AC1 table stops matching the tree
//   - a config row has no tag or no citation                        -> a disassembly guess becomes
//     lore the moment nobody can see where it came from
//   - the walker's cost bytes / limit are a second copy in code      -> editing config.terrain
//     .pathCost would change nothing (the T-016 failure mode)
//   - cover arithmetic drifts from FUN_194c_000e                     -> 20 stops being 13 in a
//     city and 15 on a mountain
//   - auto dig-in ignores DS:0x1996 bit 0x20                         -> infantry entrenches on a
//     city/ capital cell, which is not a dig-in terrain
//   - a per-pass attrition row is presented as the runtime rate       -> lake 3/pass would be
//     read as 3/round, an 11x rate change nobody gated
//
// The arithmetic below is written as literal arithmetic (`20-(20+1)/3`), not as the configured
// factor, because a test that reads the same constant the code reads stays green with the branch
// deleted.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configPath, resetRules, rules } from "../../server/rules.mjs";
import {
  digInIds,
  landPace,
  pathCostFor,
  terrainTables,
  walkCostLimit,
} from "../../server/rules.mjs";
import { walkLine } from "../../server/move.mjs";
import { coverFor, damageFor } from "../../server/combat.mjs";

export const name = "t016_terrain";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..", "..", "server");
const source = (file) => readFileSync(path.join(serverDir, file), "utf8");

const TAGS = new Set(["measured", "disassembly", "unverified"]);

export async function run(ctx) {
  const { fail } = ctx;
  const must = (ok, why) => { if (!ok) fail(why); };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  // ---- AC1: every row tagged and cited -----------------------------------------------------
  const block = rules().terrain || {};
  const rows = ["pathCost", "crawlPace", "cover", "digIn", "attritionPerPass", "shoreFire"];
  for (const key of rows) {
    const entry = block[key];
    must(entry && typeof entry === "object", `config.terrain.${key} is missing`);
    if (key === "attritionPerPass") {
      // Per-terrain tags: every row carries its own measured / disassembly label, which is
      // stronger than one tag for the block (lake and polar are measured, desert and jungle are
      // not).
      const tags = entry.tags || {};
      const named = Object.keys(entry.value || {});
      must(named.length > 0, "config.terrain.attritionPerPass has no rows");
      for (const terrain of named) {
        must(TAGS.has(String(tags[terrain])),
          `config.terrain.attritionPerPass.${terrain} has no measured/disassembly/unverified tag`);
      }
    } else {
      must(TAGS.has(String(entry.tag)), `config.terrain.${key} has no measured/disassembly/unverified tag (${entry.tag})`);
    }
    must(typeof entry.source === "string" && entry.source.length > 40,
      `config.terrain.${key} has no real source sentence`);
    must(typeof entry.evidenceRef === "string" && entry.evidenceRef.length > 0,
      `config.terrain.${key} names no evidence file`);
  }
  must(block.coverage === undefined, "a `coverage` row was invented; the tag lives on each row");

  // ---- AC6, machine-enforced: every citation resolves to a real file ------------------------
  // frodo #4467 finding 2: b875077 fixed three citations by hand and nothing stopped the next
  // one going stale. Tokenise each evidenceRef and require every repo-relative docs/ or web/
  // path to exist; a comma list after a path is read as siblings in that path's directory
  // ("q6-jungle.txt, q6-polar.txt"). Absolute /mnt/nas references name the reference tree, which
  // a CI box does not have: checked when the file is present, otherwise printed as skipped so
  // "not checked here" is visible instead of green.
  const repoRoot = path.resolve(here, "..", "..", "..");
  const missingAbs = [];
  const cited = [];
  for (const key of rows) {
    const ref = String(block[key].evidenceRef || "");
    let found = 0;
    for (const clause of ref.split(";")) {
      const text = clause.trim();
      if (!text) continue;
      // Absolute reference-tree citations first: the path may itself contain docs/, so it is
      // removed from the clause before the repo-relative scan looks for docs/ or web/.
      let rest = text;
      const absolute = text.match(/\/mnt\/nas\/[^\n;]+/);
      if (absolute) {
        const candidate = absolute[0]
          .replace(/[,(].*$/, "")
          .trim()
          .replace(/\s+section\s+\S+$/i, "")
          .trim();
        if (existsSync(candidate)) { cited.push(candidate); found += 1; }
        else missingAbs.push(`${key}: ${candidate}`);
        rest = text.replace(absolute[0], " ");
      }
      const rels = rest.match(/\b(?:docs|web)\/[A-Za-z0-9_./-]+/g) || [];
      for (const rel of rels) {
        const target = path.join(repoRoot, rel);
        must(existsSync(target), `config.terrain.${key}.evidenceRef cites ${rel}, which does not exist`);
        cited.push(rel);
        found += 1;
      }
      if (rels.length) {
        const dir = path.dirname(path.join(repoRoot, rels[0]));
        for (const sibling of rest.match(/,\s*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) || []) {
          const file = sibling.replace(/^,\s*/, "");
          must(existsSync(path.join(dir, file)),
            `config.terrain.${key}.evidenceRef cites ${file} beside ${rels[0]}, which does not exist`);
          cited.push(path.join(path.dirname(rels[0]), file));
          found += 1;
        }
      }
    }
    must(found > 0, `config.terrain.${key}.evidenceRef names no path this test can resolve`);
  }
  // A tokeniser that matches nothing must not read as a pass.
  must(cited.length >= rows.length, `only ${cited.length} citations resolved across ${rows.length} rows`);
  if (missingAbs.length) {
    console.log("t016_terrain: absolute citations not present on this host (skipped): " + missingAbs.join(" | "));
  }

  // ---- no second copy of a recovered table in code -----------------------------------------
  const moveSrc = source("move.mjs");
  const rulesSrc = source("rules.mjs");
  must(!/PATH_COST\s*=/.test(moveSrc), "move.mjs still exports a PATH_COST table");
  must(!/WALK_COST_LIMIT\s*=\s*\d+/.test(moveSrc), "move.mjs still hard-codes the walk cost limit");
  must(!/new Set\(\[9,\s*10,\s*12,\s*13\]\)/.test(rulesSrc), "rules.mjs still carries the slow-terrain id set");
  must(/pathCostFor\(/.test(moveSrc), "the walker does not read the config's path-cost bytes");
  must(/walkCostLimit\(\)/.test(moveSrc), "the walker does not read the config's cost limit");

  // ---- path cost: the recovered bytes, by id ----------------------------------------------
  eq(pathCostFor(8), 0, "plain costs 0");
  eq(pathCostFor(11), 3, "desert costs 3 (DS:0x011C)");
  eq(pathCostFor(12), 9, "jungle costs 9");
  eq(pathCostFor(13), 13, "polar costs 13");
  eq(pathCostFor(14), 77, "wasteland costs 77");
  eq(walkCostLimit(), 100, "the walk fails at a sum of 100");

  // A class-3 walk over 34 desert cells sums to 102 and must be refused at the crossing; 33
  // desert cells (99) still passes.
  const desertRow = (x) => (x >= 1 ? 11 : 8);
  const walk = walkLine({ x: 0, y: 4 }, { x: 34, y: 4 }, 3, desertRow);
  eq(walk.ok, false, "a 34-cell desert leg (34 x 3 = 102) was accepted");
  eq(walk.fail, "cost", "the desert leg failed for the wrong reason");
  must(walk.cost >= 100, `the refused leg's cost was ${walk.cost}, not >= 100`);
  const shortWalk = walkLine({ x: 0, y: 4 }, { x: 33, y: 4 }, 3, desertRow);
  eq(shortWalk.ok, true, "a 33-cell desert leg (33 x 3 = 99) was refused");

  // ---- cover arithmetic, per FUN_194c_000e ------------------------------------------------
  // Ids come from config, not from this file: capital 4, base 5, city 6, mountain 10.
  const city = 6;
  const mountain = 10;
  eq(coverFor(20, city, "infantry"), 20 - Math.floor((20 + 1) / 3), "city cover, infantry (20 -> 13)");
  eq(coverFor(20, city, "tank"), 20 - Math.floor(20 / 5), "city cover, tank (20 -> 16)");
  eq(coverFor(26, city, "tank"), 26 - Math.floor(26 / 5), "city cover, tank on 26 (26 -> 21)");
  eq(coverFor(17, city, "infantry"), 17 - Math.floor((17 + 1) / 3), "city cover, infantry on 17 (17 -> 11)");
  eq(coverFor(20, mountain, "infantry"), 20 - (20 >> 2), "mountain cover, infantry (20 -> 15)");
  eq(coverFor(20, mountain, "tank"), 20 - Math.floor(20 / 6), "mountain cover, tank (20 -> 17)");
  eq(coverFor(26, mountain, "tank"), 26 - Math.floor(26 / 6), "mountain cover, tank on 26 (26 -> 22)");
  eq(coverFor(20, 8, "infantry"), 20, "plain must not cover (20 stays 20)");
  eq(coverFor(20, 3, "infantry"), 20, "lake must not cover (20 stays 20)");
  eq(coverFor(20, 11, "tank"), 20, "desert must not cover (20 stays 20)");

  const tables = terrainTables();
  must(tables.cityLike.has(4) && tables.cityLike.has(5) && tables.cityLike.has(6),
    "config.terrain.cover.cityLike lost capital/base/city");
  must(tables.mountain.has(10) && !tables.mountain.has(9), "config.terrain.cover.mountain is not exactly mountain");

  // ---- dig-in terrains are DS:0x1996 bit 0x20 ----------------------------------------------
  const dug = digInIds();
  for (const id of [7, 8, 9, 10, 11, 12]) must(dug.has(id), `terrain ${id} has bit 0x20 but is not in config.terrain.digIn`);
  for (const id of [0, 1, 2, 3, 4, 5, 6, 13, 14]) must(!dug.has(id), `terrain ${id} has no bit 0x20 but is in config.terrain.digIn`);
  must(/digInIds\(\)/.test(source("combat.mjs")), "tickEntrench no longer consults the dig-in terrain list");
  must(/digInIds\(\)/.test(moveSrc), "the entrench order no longer consults the dig-in terrain list");

  // ---- crawl pace: Q5 measured forest/mountain, labelled stand-in for jungle/polar ----------
  // Q5 DOSBox legs (notes/t016/q5-*.txt): forest is 1 beat, exactly like plain; mountain is 2
  // beats at speed 1 and ~1.33 average at speed 6. The archive's 2-beat stand-in was wrong for
  // forest. Jungle and polar were never walked, so they keep the stand-in labelled unverified.
  eq(landPace(8), 1, "plain pace");
  eq(landPace(9), 1, "forest is NOT slower than plain (Q5 measured)");
  eq(landPace(10), 2, "mountain is two beats");
  eq(landPace(12), 2, "jungle keeps the labelled stand-in (Q5 not walked)");
  eq(landPace(13), 2, "polar keeps the labelled stand-in (Q5 not walked)");
  eq(landPace(14), -1, "wasteland is refused");
  eq(landPace(0), 2, "ocean is a transport pace");
  eq(String(block.crawlPace.tags.forest), "measured", "forest beats are Q5-measured");
  eq(String(block.crawlPace.tags.mountain), "measured", "mountain beats are Q5-measured");
  eq(String(block.crawlPace.tags.jungle), "unverified", "jungle beats are unverified");
  eq(String(block.crawlPace.tags.polar), "unverified", "polar beats are unverified");

  // ---- attrition: per PASS rows, labelled, not the runtime rate ---------------------------
  const perPass = block.attritionPerPass || {};
  eq(perPass.wired, false, "attritionPerPass claims to be wired; the runtime is still per-round");
  eq(Number(perPass.value.lake), 3, "lake attrition is 3 per pass (measured)");
  eq(Number(perPass.value.polar), 5, "polar attrition is 5 per pass (measured)");
  eq(Number(perPass.value.desert), 3, "desert attrition is 3 per pass (disassembly)");
  eq(Number(perPass.value.jungle), 3, "jungle attrition is 3 per pass (disassembly)");
  eq(Number(perPass.value.wasteland), 31, "wasteland attrition is the dumped byte 31 (0x1f)");
  eq(String(perPass.tags.lake), "measured", "lake is measured");
  eq(String(perPass.tags.desert), "measured", "desert is Q6-measured (3/pass, desert cell)");
  eq(String(perPass.tags.jungle), "measured", "jungle is Q6-measured (3/pass, jungle cell)");
  eq(String(perPass.tags.wasteland), "disassembly", "wasteland is disassembly until Q6 can place a cell");
  must(/attritionPerRound/.test(moveSrc) && !/attritionPerPass/.test(moveSrc),
    "attritionStep changed its rate source; the per-round stand-in is the runtime until D-017 is ruled");

  // ---- shore fire: wired behind a disassembly label, arithmetic pinned ---------------------
  eq(block.shoreFire.wired, true, "shoreFire is wired in T-016");
  eq(block.shoreFire.tag, "disassembly", "shore fire is disassembly only, never measured");
  eq(Number(block.shoreFire.range), 2, "shore fire starts beyond 2 cells");
  {
    const land = (strength, id) => ({ x: 4, y: 4, strength, kind: "infantry", domain: "land", id });
    // The probe ship must be a kind the damage table HAS a row for: `battleship` has no
    // `damageKind` entry, so `baseDamageFor` returns 0 and every comparison below was 0 against 0
    // — an assertion that stays green with the shore-fire branch deleted. A `cruiser` reads base
    // 12 and covered 12 against land, so the numbers are real.
    const ship = (x) => ({ x, y: 4, kind: "cruiser", domain: "sea", id: "hull" });
    const close = damageFor(ship(2), land(100, "near"));
    eq(close.shoreFire, false, "a 2-cell shot was treated as shore fire");
    eq(close.amount, close.covered, "a 2-cell shot was capped");
    eq(close.base, 12, "the probe cruiser no longer reads its table damage; the block below is vacuous");
    const beyond = damageFor(ship(0), land(100, "far"));
    eq(beyond.shoreFire, true, "a 6-cell sea shot did not take the shore-fire path");
    eq(beyond.amount, Math.min(beyond.covered, 100 - 30), "long shot did not cap at strength-30");
    eq(beyond.amount, 12, "a long shot at full strength is not the full covered damage");
    const half = damageFor(ship(0), land(20, "wounded"));
    eq(half.amount, half.covered / 2, "a shot at a 20-strength target was not halved");
    eq(half.amount, 6, "the halved shot is not half of the cruiser base");
    // 25-30 is an immunity band, not a floor: at strength >= halveBelow (25) the cap branch wins
    // and max(0, strength - 30) is zero. Assert the band by number so a change to either clause
    // moves a value instead of emptying a comparison.
    for (const s of [25, 26, 27, 28, 29, 30]) {
      const band = damageFor(ship(0), land(s, "band" + s));
      eq(band.shoreFire, true, `a shot at a ${s}-strength target did not take the shore-fire path`);
      eq(band.amount, 0, `a ${s}-strength target took ${band.amount} shore fire; 25-30 is an immunity band`);
    }
    const just = damageFor(ship(0), land(31, "just"));
    eq(just.amount, 1, "a 31-strength target did not take exactly strength-30");
    const healthy = damageFor(ship(0), land(45, "healthy"));
    eq(healthy.amount, healthy.covered, "a 45-strength target was capped but sits inside strength-30");
  }

  // ---- a config edit moves the runtime ----------------------------------------------------
  // The whole point of AC1: change the file and the walker must change with it. This runs last
  // and always restores the shipped path.
  const shipped = configPath();
  const dir = mkdtempSync(path.join(tmpdir(), "chq-t016-"));
  try {
    const cfg = JSON.parse(readFileSync(shipped, "utf8"));
    cfg.terrain.pathCost.value.desert = 100;
    cfg.terrain.pathCost.limit = 100;
    cfg.terrain.crawlPace.refused = ["wasteland", "polar"];
    cfg.terrain.digIn.value = ["plain"];
    cfg.terrain.shoreFire.range = 10;
    cfg.terrain.crawlPace.beats.forest = 3;
    const alt = path.join(dir, "game.json");
    writeFileSync(alt, JSON.stringify(cfg, null, 2));
    process.env.OPENCHQ_CONFIG = alt;
    resetRules();
    eq(pathCostFor(11), 100, "a configured desert cost of 100 did not reach pathCostFor");
    eq(walkLine({ x: 0, y: 4 }, { x: 4, y: 4 }, 3, (x) => (x >= 1 ? 11 : 8)).ok, false,
      "a one-cell desert crossing at cost 100 was accepted");
    eq(landPace(13), -1, "a configured polar refusal did not reach landPace");
    eq(landPace(9), 3, "a configured forest beat count did not reach landPace");
    must(!digInIds().has(10), "a narrowed dig-in list did not reach digInIds");
    const wide = damageFor({ x: 0, y: 4, kind: "cruiser", domain: "sea", id: "hull" },
      { x: 6, y: 4, strength: 100, kind: "infantry", domain: "land", id: "dug" });
    eq(wide.shoreFire, false, "a configured shore-fire range of 10 did not reach combat.damageFor");
    eq(wide.amount, wide.covered, "a shot inside the configured range was still capped");
  } finally {
    if (shipped) process.env.OPENCHQ_CONFIG = shipped;
    else delete process.env.OPENCHQ_CONFIG;
    resetRules();
    rmSync(dir, { recursive: true, force: true });
  }
}
