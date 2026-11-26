// Node test for PB-233 AC (b): the manual's 25 per cent, made LEGIBLE - not a second cut.
//
// Manual p.30: "After a certain number of nukes have been dropped, the overall deleterious effect on
// the Earth's biosphere begins to be felt. All city production is reduced by 25 per cent or more
// when this occurs."
//
// Frodo's ruling (room 8983 §4) is what this arm grades: web/server/nukes.mjs computes
// pct = incomeSkipPerDetonation * n = 5n, so at the fifth detonation the gate IS 25 and the manual's
// "or more" is the growth past it. FUN_1eb5_0eae has no *0.75 anywhere, so a flat cut would be a
// second, invented arithmetic stacked on a number nobody measured. The flat-cut branch is STRUCK,
// not deferred: no productionCutPercent, no productionCutFrom, no multiply on the payday.
//
// What breaks if this node is removed: a second cut creeps back onto the payday; a skipped payday
// goes back to being a silent empty purse; the line names the wrong side's cities; or the legibility
// read draws its own roll and moves PB-156's pinned draw order.
//
// NO NEW ARITHMETIC. The only income arithmetic here is PB-156's decoded 5n gate; this arm asserts
// the payday is the gross and that the gate's skip is legible, not that anything is multiplied.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { resetRules, rules, payEvery } from "../../server/rules.mjs";
import { pay, payoutFor, seedOwners } from "../../server/economy.mjs";
import { atWar } from "../wartime.mjs";
import { logLines } from "../../server/log.mjs";
import { siteTypeOf } from "../../server/sitetype.mjs";
import { nukeRoll, nukeState } from "../../server/nukes.mjs";
import { assertShippedNukesArmed } from "./_nuke_default.mjs";

export const name = "pb233_production";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function must(ok, message) {
  if (!ok) fail(message);
}

function withNukes(on, patch = {}) {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.nukes = { ...(custom.nukes || {}), enabled: on };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete custom.nukes[key];
    else custom.nukes[key] = value;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pb233p-"));
  const file = path.join(dir, "game.json");
  writeFileSync(file, JSON.stringify(custom, null, 2));
  const previous = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = file;
  resetRules();
  return () => {
    if (previous === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = previous;
    resetRules();
    rmSync(dir, { recursive: true, force: true });
  };
}

function fixture({ detonated = 0, seed = 4242 } = {}) {
  const payload = boardPayload();
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = Math.max(1, Number(payEvery()) || 1);
  // T-035 (RE-E4): 1986 opens in the cold war, where no round runs and cash comes from the money
  // tick; this fixture measures the WARTIME payday, so it begins hostilities first (p.31).
  atWar(match);
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  match.capitalSeed = seed;
  if (detonated > 0) match.nukes = { detonated };
  seedOwners(match);
  return { match, payload };
}

// The side's paying cities, straight off the board - the arm's independent list, not the server's.
// Same shape as incomeCounts: type-4 cities plus every capital after the first.
function payingNames(match, side) {
  const cities = [];
  const capitals = [];
  for (const site of match.sites) {
    if (!site || site.owner !== side) continue;
    const type = Number(siteTypeOf(site));
    if (type === 4) cities.push(site);
    else if (type === 1 || type === 2) capitals.push(site);
  }
  const rows = cities.concat(capitals.slice(1));
  return rows
    .map((site) => (typeof site.name === "string" && site.name.trim() ? site.name.trim() : null))
    .filter(Boolean);
}

export async function run(ctx) {
  // --- b(i). the flat cut is STRUCK in config and in the block sentence ---------------------
  // PB-233 (f): the shipped default is ARMED; a forced-off config still refuses at nukeStatus.
  assertShippedNukesArmed();
  must(!("productionCutPercent" in (rules().nukes || {})),
    "nukes.productionCutPercent must not exist: frodo 8983 §4 struck the flat cut");
  must(!("productionCutFrom" in (rules().nukes || {})),
    "nukes.productionCutFrom must not exist: frodo 8983 §4 struck the flat cut");
  const block = String(rules().nukes.source || "");
  must(/8983/.test(block), "nukes.source must name the ruling that struck the flat cut");
  must(/25/.test(block), "nukes.source must say what the manual's 25 per cent became");
  must(/not a second cut|NOT ported as arithmetic|no production multiply/i.test(block),
    "nukes.source must say the 25 per cent is the 5n gate, not a second multiply");

  const restore = withNukes(true);
  try {
    let ready = false;
    try {
      const probe = boardPayload();
      must(Boolean(probe && probe.sites), "the board has no sites");
      ready = true;
    } catch {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }
    if (!ready) return;

    // --- b(ii). a paid payday is the GROSS: no second arithmetic ------------------------------
    {
      let found = null;
      for (let seed = 1; seed < 500 && !found; seed += 1) {
        const built = fixture({ detonated: 3, seed });
        const events = pay(built.match);
        const income = events.filter((event) => event.type === "income");
        if (income.length === 2) found = { match: built.match, events, income, seed };
      }
      must(Boolean(found), "no seed in 500 paid both sides with 3 detonations on the board");
      for (const event of found.income) {
        eq("the payday is the gross, with nothing multiplied off it", event.amount, event.gross);
        eq("the gross is the city count at the rate", event.gross, event.cities * rules().money.cityIncome);
        must(event.productionCut === undefined && event.cutPercent === undefined && event.cutFrom === undefined,
          "an income event still carries a cut field: " + JSON.stringify(event));
      }
      const payout = payoutFor(found.match, "blue");
      must(payout.cutPercent === undefined && payout.cutFrom === undefined,
        "payoutFor still carries cut fields: " + JSON.stringify(payout));
      eq("the dialogue's figure is the payday", payout.amount, payout.gross);
    }

    // --- b(iii). a skipped payday NAMES the cities the gate took ----------------------------
    {
      let gated = null;
      for (let seed = 1; seed < 800 && !gated; seed += 1) {
        const built = fixture({ detonated: 5, seed });
        const before = { blue: Number(built.match.sides.blue.cash), red: Number(built.match.sides.red.cash) };
        const events = pay(built.match);
        const skips = events.filter((event) => event.type === "income_skipped" && event.reason === "gate");
        if (skips.length === 1 && events.filter((event) => event.type === "income").length === 1) {
          gated = { match: built.match, events, skip: skips[0], before, seed };
        }
      }
      must(Boolean(gated), "no seed in 800 skipped exactly one side's payday at 5 detonations");
      const { match, skip, before } = gated;
      const side = skip.side;
      const other = side === "blue" ? "red" : "blue";

      eq("the gate's per cent is 5n", skip.percent, 5 * 5);
      must(Number.isFinite(skip.roll) && skip.roll < skip.percent,
        "the skip must carry the roll that lost: " + JSON.stringify(skip));
      eq("the detonation count rides along", skip.detonated, 5);
      eq("the skipped payday credited nothing", Number(match.sides[side].cash), before[side]);
      must(before[other] < Number(match.sides[other].cash), "the other side's payday did not land");

      const expected = payingNames(match, side);
      must(expected.length > 0, "the skipped side holds no paying city to name");
      eq("the event names every paying city of the skipped side", skip.cityNames, expected);
      eq("the count is the paying count", skip.cities, payoutFor(match, side).cities);

      // The names must be the SKIPPED side's, not the other seat's: a line that reads the wrong
      // list looks legible and is exactly the mutation this arm exists for.
      const otherNames = new Set(payingNames(match, other));
      for (const city of skip.cityNames) {
        must(!otherNames.has(city), "the note named the other side's city " + city);
      }
      must(skip.note.includes("rolled " + skip.roll), "the note must print the roll it lost on: " + skip.note);
      must(skip.note.includes(expected[0]), "the note must name the first skipped city: " + skip.note);

      // The visible round log, which is the surface the player actually reads.
      const lines = logLines(match, side, [skip], match.round) || [];
      const texts = lines.map((entry) => (entry && typeof entry === "object" ? String(entry.text || "") : String(entry)));
      const line = texts.find((entry) => entry.includes(expected[0]));
      must(Boolean(line), "the round log did not carry the skipped city's name: " + JSON.stringify(lines));
      must(/detonation/.test(String(line)), "the round-log line must say what the skip is: " + line);
    }

    // --- b(iv). legibility draws NO extra roll: one draw per side, exactly -------------------
    {
      const played = fixture({ detonated: 5, seed: 77 });
      pay(played.match);
      const twin = fixture({ detonated: 5, seed: 77 });
      nukeRoll(twin.match);
      nukeRoll(twin.match);
      eq("pay() consumed exactly the two payday draws, no more",
        nukeState(played.match).rngState, nukeState(twin.match).rngState);
    }
  } finally {
    restore();
  }
}
