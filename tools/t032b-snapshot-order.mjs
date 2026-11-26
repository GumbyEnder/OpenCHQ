// T-032 part C follow-up, PB-261b (PM 9468 §3): the start snapshot must be taken AFTER the era's
// ownership is seeded, not before.
//
// The defect this pins: tools/t032-bot-vs-bot.mjs read `const start = cityCount(...)` straight after
// openMatch, while `seedOwners` only ran lazily on the first buy. The file years (1918/1942/1986)
// arrive with their opening owners already on the site rows, so pre-seed and post-seed agreed there.
// 2023 rolls its owners, so its pre-seed board is ownerless: start 0/0, and every 2023 row's
// "cities taken" was measured against an empty board (rung 2 read 13/10 as 13/10 taken).
//
// Two arms, both required:
//   1. ORDER (static, over the harness source): `seedOwners(match);` appears before
//      `openingCapitals(match)` and before the `const start = {` snapshot inside playMatch.
//   2. BOARD (behavioural, over the engine): for each era, the pre-seed count vs the post-seed count.
//      2023 seed 2023 must read 0/0 before and 13/10 after; a second seedOwners call must not move a
//      single owner (the engine seeds once per match object, WeakSet-guarded).
//
// Node-only, no deps, no server: run with `node tools/t032b-snapshot-order.mjs`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { boardPayload, matchSites } from "../web/server/board.mjs";
import { openMatch } from "../web/server/match.mjs";
import { seedOwners } from "../web/server/economy.mjs";

const CITY_KINDS = new Set(["city", "capital"]);
const cityCount = (match, side) =>
  match.sites.filter((site) => site && site.owner === side && CITY_KINDS.has(String(site.kind))).length;
const counts = (match) => ({ blue: cityCount(match, "blue"), red: cityCount(match, "red") });
const labels = (c) => c.blue + "/" + c.red;

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

// ---- arm 1: the harness must seed before it snapshots --------------------------------------------
const harnessPath = path.join(import.meta.dirname, "t032-bot-vs-bot.mjs");
const source = readFileSync(harnessPath, "utf8");
const body = source.slice(source.indexOf("function playMatch("));
const atSeed = body.indexOf("seedOwners(match);");
const atCapitals = body.indexOf("const opening = openingCapitals(match);");
const atStart = body.indexOf("const start = { blue: cityCount(match, \"blue\")");
console.log("arm 1 (order, tools/t032-bot-vs-bot.mjs playMatch):");
console.log("  seedOwners(match) at +" + atSeed + ", openingCapitals at +" + atCapitals + ", start snapshot at +" + atStart);
check(atSeed >= 0, "playMatch never calls seedOwners");
check(atCapitals > atSeed && atStart > atSeed,
  "seedOwners(match) must precede openingCapitals and the start snapshot (seed +" + atSeed +
  ", capitals +" + atCapitals + ", start +" + atStart + ")");
check(atSeed < atCapitals, "the capital-set baseline is read before ownership is seeded");
console.log(atSeed >= 0 && atCapitals > atSeed && atStart > atSeed ? "  PASS" : "  FAIL");

// ---- arm 2: what the two orders actually read, per era ------------------------------------------
const board = boardPayload();
const ERAS = ["1918", "1942", "1986", "2023"];
const SEED = 2023; // the seed the PB-261 census used for 2023's rolled board
const measured = {};
// The capital pair the opening map records (frodo 9475 §3a): the start snapshot is not the only
// pre-seed read - `openingCapitals` is above it, and capitalLosses diffs against that map. A rolled
// era's pre-seed set is a different PAIR, not just null owners, so the seed has to go above both.
const capitalPair = (match) => (match.capitalSet && Array.isArray(match.capitalSet.list) ? match.capitalSet.list : [])
  .map((capital) => {
    const site = match.sites.find((row) => String(row.id) === String(capital.siteId));
    return [String(capital.siteId), site ? site.owner : "(missing)"];
  });
console.log("arm 2 (board, pre-seed vs post-seed city counts, seed " + SEED + "):");
for (const era of ERAS) {
  const match = openMatch(era, matchSites(era, board), { seed: SEED, opponentLevel: 3 });
  const before = counts(match);
  const capitalsBefore = capitalPair(match);
  seedOwners(match);
  const after = counts(match);
  const capitalsAfter = capitalPair(match);
  const again = (seedOwners(match), counts(match));
  const owners = match.sites.filter((site) => site && (site.owner === "blue" || site.owner === "red")).length;
  const capitals = match.capitalSet && Array.isArray(match.capitalSet.list) ? match.capitalSet.list.length : 0;
  measured[era] = { before, after, again, owners, capitals, capitalsBefore, capitalsAfter,
    source: match.capitalSet && match.capitalSet.source };
  const pairText = (pair) => "[" + pair.map((row) => row[0] + ":" + (row[1] || "null")).join(", ") + "]";
  console.log("  " + era + " pre-seed " + labels(before) + " -> post-seed " + labels(after) +
    " (re-seed " + labels(again) + "), owned sites " + owners + ", capitals " + capitals +
    " (" + (measured[era].source || "?") + "), pair " + pairText(capitalsBefore) + " -> " + pairText(capitalsAfter));
  check(measured[era].after.blue + measured[era].after.red > 0, era + " still has no owned city after seeding");
  check(labels(after) === labels(again), era + " re-seed moved an owner: " + labels(after) + " -> " + labels(again));
}

// The AC's literal figure: 2023's seeded opening is 13/10, and the pre-seed reading is the 0/0 defect.
const y2023 = measured["2023"];
check(labels(y2023.before) === "0/0", "2023 pre-seed must read 0/0 (the defect this ticket fixes), read " + labels(y2023.before));
check(labels(y2023.after) === "13/10", "2023 seeded opening must read 13/10, read " + labels(y2023.after));
// The capital pair is the second pre-seed read (frodo 9475 §3a): pre-seed it is the pair rolled on an
// ownerless board (22/32, both null); post-seed it is the pair the match actually uses (28 blue, 13 red).
// Seeding between openingCapitals and the start snapshot would fix citiesStart and leave this wrong.
const pairIds = (pair) => pair.map((row) => row[0]).join(",");
const pairOwners = (pair) => pair.map((row) => (row[1] === null || row[1] === undefined ? "null" : row[1])).join(",");
check(pairIds(y2023.capitalsAfter) === "28,13" && pairOwners(y2023.capitalsAfter) === "blue,red",
  "2023 post-seed capital pair must be 28 blue / 13 red, read " + pairIds(y2023.capitalsAfter) + " (" + pairOwners(y2023.capitalsAfter) + ")");
check(pairIds(y2023.capitalsBefore) !== pairIds(y2023.capitalsAfter),
  "2023 pre-seed capital PAIR equals the post-seed pair, so this arm would not discriminate order");
check(pairOwners(y2023.capitalsBefore) === "null,null",
  "2023 pre-seed capital owners must both be null, read " + pairOwners(y2023.capitalsBefore));
// The file years must be untouched by the move: their owners are on the site rows before seeding.
for (const era of ["1918", "1942", "1986"]) {
  check(labels(measured[era].before) === labels(measured[era].after),
    era + " pre-seed and post-seed disagree (" + labels(measured[era].before) + " vs " + labels(measured[era].after) +
    "): the move changes a file year's baseline");
}

console.log(failures.length === 0 ? "PASS 2/2 arms" : "FAIL " + failures.length + " check(s)");
for (const row of failures) console.log("  - " + row);
process.exit(failures.length === 0 ? 0 : 1);
