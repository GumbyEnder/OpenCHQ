// Node test for PB-156: the nuke counter, the launch difference and the two rules that read it.
//
// What breaks if this node is removed: the launch gate goes back to counting one side's total (so a
// side could never answer after three), the global detonation count stops existing, income is paid
// through a nuclear winter, and a war can never end in the winter. Everything here runs with
// `nukes.enabled:true` in a test config, because the shipped default is deliberately inert - so
// this node ALSO proves that the default still changes nothing.
//
// Rules, all decoded (web/server/nukes.mjs, config `nukes.*`):
//   - Manual p.30: at most 3 more launches than the opponent has fired: fired(mine) - fired(theirs) < 3.
//   - FUN_1eb5_0eae: one global count (0x148c). From 5 a warning; from 10 winter if
//     rnd(100) < 100 / (20 - n), ending the war as a loss for both.
//   - Each round income is paid only if rnd(100) >= 5n (decompiled.c 4763).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { configPath, resetRules, rules } from "../../server/rules.mjs";
import { launchEdge, nukeStatus, useTool } from "../../server/late.mjs";
import { detonatedCount, nukeState, incomeSkipPercent, winterChancePercent } from "../../server/nukes.mjs";
import { incomeGate } from "../../server/economy.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "pb156_nuke";

const TRIALS = 2000;

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

// A 1986 board with both capitals parked at the far corners, so a launch at (100,100) is never
// "home ground" and the exclusion guard does not decide this test.
function match(extra = {}) {
  return {
    era: "1986",
    round: 6,
    capitalSeed: 11,
    sides: { blue: { cash: 50000 }, red: { cash: 50000 } },
    pieces: [],
    sites: [],
    capitals: { blue: { x: 0, y: 0 }, red: { x: 300, y: 135 } },
    ...extra,
  };
}

function withNukes(on) {
  const shipped = JSON.parse(JSON.stringify(rules()));
  const custom = JSON.parse(JSON.stringify(shipped));
  custom.nukes = { ...(custom.nukes || {}), enabled: on };
  const dir = mkdtempSync(path.join(tmpdir(), "pb156-"));
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

function fire(m, side, n = 1) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(useTool(m, side, "nuke", { x: 100, y: 100 }));
  return out;
}

export async function run(ctx) {
  const shipped = rules().nukes || {};
  eq("the shipped config leaves nukes inert", shipped.enabled, false);

  const restore = withNukes(true);
  try {
    eq("the test config turned nukes on", rules().nukes.enabled, true);

    // --- 1. Blue may fire 3; a 4th is refused until Red fires one ---------------------------
    {
      const m = match();
      const three = fire(m, "blue", 3);
      for (const [index, result] of three.entries()) {
        if (result.error) fail("launch " + (index + 1) + " of 3 was refused: " + result.error);
      }
      eq("three launches are three detonations", detonatedCount(m), 3);
      const fourth = fire(m, "blue", 1)[0];
      if (!fourth.error) fail("a fourth launch went out with the other side on zero");
      if (detonatedCount(m) !== 3) fail("a refused launch still counted a detonation");
      if (!/3 more launches/.test(fourth.error)) fail("the refusal does not name the rule: " + fourth.error);

      const answer = fire(m, "red", 1)[0];
      if (answer.error) fail("Red's reply was refused: " + answer.error);
      eq("Red's reply leaves Blue two ahead", launchEdge(m, "blue"), 2);
      eq("Red's reply is the fourth detonation", detonatedCount(m), 4);
      const fifth = useTool(m, "blue", "nuke", { x: 100, y: 100 });
      if (fifth.error) fail("Blue could not answer after Red fired one: " + fifth.error);
      eq("five launches, five detonations", detonatedCount(m), 5);
      // From 5 the warning is on the event stream, for both seats.
      const warned = (fifth.events || []).find((event) => event.type === "nuke_warning");
      if (!warned) fail("the fifth detonation raised no warning: " + JSON.stringify(fifth.events));
      eq("the warning carries the global count", warned.detonated, 5);
      for (const side of ["blue", "red"]) {
        const lines = logLines(m, side, fifth.events || []).map((line) => line.text);
        if (!lines.some((line) => /sky is dimming/.test(line))) {
          fail("seat " + side + " was not shown the warning: " + JSON.stringify(lines));
        }
      }
      // A side that is three ahead is refused even when both have fired many.
      const far = match({ late: { launched: { blue: { fired: 9 }, red: { fired: 6 } } } });
      if (nukeStatus(far, "blue").allowed) fail("a side three ahead was allowed to launch");
      if (!nukeStatus(far, "red").allowed) fail("the side three behind was refused");
    }

    // --- 2. n = 4: income is skipped in 20% of seeded rounds, no more, no less ---------------
    {
      const n = 4;
      eq("the skip percentage is 5n", incomeSkipPercent(n), 20);
      let skipped = 0;
      for (let i = 0; i < TRIALS; i += 1) {
        const m = match({ capitalSeed: i, nukes: { detonated: n } });
        if (!incomeGate(m, "blue")) skipped += 1;
      }
      const pct = (skipped / TRIALS) * 100;
      if (Math.abs(pct - 20) > 4) {
        fail("income skipped " + pct.toFixed(2) + "% of " + TRIALS + " seeded rounds at n=4, not 20% +/- 4");
      }
      // Same seed, same answer: a reload replays the round instead of re-rolling it.
      const once = match({ capitalSeed: 4242, nukes: { detonated: n } });
      const twice = match({ capitalSeed: 4242, nukes: { detonated: n } });
      eq("the income roll is seeded", incomeGate(once, "blue"), incomeGate(twice, "blue"));
      // And the roll advances: two calls off one match are two draws, not the same one twice.
      const fresh = match({ capitalSeed: 777, nukes: { detonated: n } });
      const first = fresh.nukes.rngState;
      incomeGate(fresh, "blue");
      if (fresh.nukes.rngState === first) fail("the income roll did not advance the seeded state");
      // n = 0 is paid, whatever the seed: an undeclared war pays normally.
      for (let i = 0; i < 200; i += 1) {
        if (!incomeGate(match({ capitalSeed: i, nukes: { detonated: 0 } }), "blue")) {
          fail("income was skipped with no detonations");
        }
      }
    }

    // --- 3. n = 10: the next launch ends the war for both in about 10% of seeded trials ------
    {
      eq("the winter chance at 10 is 10%", winterChancePercent(10), 10);
      let winters = 0;
      for (let i = 0; i < TRIALS; i += 1) {
        const m = match({ capitalSeed: i, nukes: { detonated: 9 } });
        const result = useTool(m, "blue", "nuke", { x: 100, y: 100 });
        if (result.error) fail("the tenth detonation was refused: " + result.error);
        if (m.over) {
          winters += 1;
          if (m.winner !== null) fail("nuclear winter named a winner");
          if (!m.winReason || m.winReason.kind !== "nuclear_winter") fail("the winter was not recorded: " + JSON.stringify(m.winReason));
          if (!(result.events || []).some((event) => event.type === "nuclear_winter")) {
            fail("a winter match emitted no nuclear_winter event");
          }
        }
      }
      const pct = (winters / TRIALS) * 100;
      if (Math.abs(pct - 10) > 3) {
        fail("nuclear winter ended " + pct.toFixed(2) + "% of " + TRIALS + " seeded trials at n=10, not 10% +/- 3");
      }
      // A winter line reads to both seats, and it does not pretend anyone won.
      const ended = match({ capitalSeed: 3, nukes: { detonated: 9 } });
      const result = useTool(ended, "blue", "nuke", { x: 100, y: 100 });
      if (ended.over) {
        for (const side of ["blue", "red"]) {
          const lines = logLines(ended, side, result.events || []).map((line) => line.text);
          if (!lines.some((line) => /nuclear winter/.test(line))) {
            fail("seat " + side + " was not told the war ended in winter: " + JSON.stringify(lines));
          }
        }
      }
      // Below 10 there is no winter roll at all.
      for (let i = 0; i < 500; i += 1) {
        const m = match({ capitalSeed: i, nukes: { detonated: 8 } });
        useTool(m, "blue", "nuke", { x: 100, y: 100 });
        if (m.over) fail("the war ended in winter at nine detonations");
      }
    }
  } finally {
    restore();
  }

  // --- 4. enabled:false: no behaviour change at all ------------------------------------------
  {
    eq("the shipped config is inert again", rules().nukes.enabled, false);
    for (let i = 0; i < TRIALS; i += 1) {
      if (!incomeGate(match({ capitalSeed: i, nukes: { detonated: 9 } }), "blue")) {
        fail("income was skipped with nukes disabled");
      }
    }
    const m = match();
    const refused = useTool(m, "blue", "nuke", { x: 100, y: 100 });
    if (!refused.error) fail("a nuke launched with the block disabled");
    eq("a refused launch leaves no detonation", detonatedCount(m), 0);
    // The counts are still readable in a match that came back from a save with them set.
    const saved = match({ nukes: { detonated: 7, rngState: 12345 } });
    eq("a restored count is read, not reset", detonatedCount(saved), 7);
    eq("a restored stream keeps its state", nukeState(saved).rngState, 12345);
  }
}
