// Node test for PB-233 AC (c): nuclear winter is PB-156's, already shipped - this ticket's job is to
// SOURCE the threshold and to prove the rule still reads config rather than a literal 10.
//
// Ghidra: FUN_1eb5_0eae decompiled.c 12193-12197 - `9 < count && rnd < 100 / (20 - count)` sets the
// winter flag and returns; 12198-12199 draws the warning sprite when `4 < count`. Both numbers were
// ported by PB-156 (nukes.winterFrom 10, nukes.warnFrom 5, nukes.winterDivisor 20). The 100 per cent
// clamp at count >= 20 is an EXTRAPOLATION, not a decode, and must stay labelled as one.
//
// What breaks if this node is removed: the config note stops naming the line the numbers came from,
// or winterFrom becomes a literal so a config move silently does nothing.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, TERRAIN } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { resetRules, rules } from "../../server/rules.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { useTool } from "../../server/late.mjs";
import { nukeState, warnFrom, winterChancePercent, winterFrom } from "../../server/nukes.mjs";
import { cellCountry, homeCountriesOf, resolvedCapitals } from "../../server/nukestrike.mjs";
import { assertShippedNukesArmed } from "./_nuke_default.mjs";

export const name = "pb233_winter_source";

const WATER = new Set(["ocean", "docks", "shallows"]);

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
  const dir = mkdtempSync(path.join(tmpdir(), "pb233w-"));
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

function terrainAt(grid, x, y) {
  const id = grid[Number(y) * 320 + ((Number(x) % 320) + 320) % 320];
  return id === undefined || id === null ? null : TERRAIN[Number(id)] || null;
}

function fixture({ detonated = 0, seed = 4242 } = {}) {
  const payload = boardPayload();
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  match.capitalSeed = seed;
  if (detonated > 0) match.nukes = { detonated };
  seedOwners(match);
  return { match, payload };
}

function pickTarget(match, payload) {
  const home = homeCountriesOf(match, "blue") || new Set();
  const capitals = resolvedCapitals(match).list;
  for (let y = 4; y < 132; y += 1) {
    for (let x = 4; x < 316; x += 1) {
      const t = terrainAt(payload.cells, x, y);
      if (!t || WATER.has(t)) continue;
      let near = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= 3 && Math.abs(cap.y - y) <= 3) near = true;
      }
      if (near) continue;
      const here = cellCountry(match, x, y);
      if (!here || here.country === null) continue;
      if (home.has(here.country)) continue;
      return { x, y };
    }
  }
  return null;
}

// Launch once and report whether the winter DRAW was taken off the match's stream. Below the
// threshold the launch takes no draw at all (pb156_nuke pins that), so a moved rngState is exactly
// "the winter branch ran".
function launch(match, at) {
  const before = nukeState(match).rngState;
  const result = useTool(match, "blue", "nuke", at);
  if (result.error) fail("a legal launch was refused: " + result.error);
  return { before, after: nukeState(match).rngState, result };
}

export async function run(ctx) {
  // PB-233 (f): the shipped default is ARMED; a forced-off config still refuses at nukeStatus.
  assertShippedNukesArmed();

  // --- c(i). the provenance AC (d) demands of every number here ------------------------------
  const block = String(rules().nukes.source || "");
  eq("the winter threshold is the archive's 10", winterFrom(), 10);
  eq("the warning threshold is the archive's 5", warnFrom(), 5);
  must(/12193/.test(block), "nukes.source must cite decompiled.c 12193 for the winter roll");
  must(/12198/.test(block), "nukes.source must cite decompiled.c 12198 for the warning");
  must(/0x148c/.test(block), "nukes.source must name the global counter it reads");
  must(/4772/.test(block), "nukes.source must cite the corrected income-gate line, 4772");
  must(/NOT 4763/.test(block), "nukes.source must say that 4763 is the wrong line, not carry it silently");
  must(/EXTRAPOLATION/.test(block), "the n >= 20 clamp must stay labelled an EXTRAPOLATION");
  eq("the winter chance at 10 is the archive's 100/(20-n)", winterChancePercent(10), 100 / 10);
  eq("the clamp at 20 is still the labelled extrapolation", winterChancePercent(20), 100);

  const restore = withNukes(true);
  try {
    let payload;
    try {
      payload = boardPayload();
      must(Boolean(payload && payload.cells), "the board has no terrain grid");
    } catch {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }

    // --- c(ii). below the threshold no winter draw is taken at all ---------------------------
    {
      const { match } = fixture({ detonated: winterFrom() - 2 });
      const target = pickTarget(match, payload);
      must(Boolean(target), "no target cell for the winter arm");
      const shot = launch(match, target);
      eq("one below the threshold takes no winter draw", shot.after, shot.before);
      eq("and emits no winter", (shot.result.events || []).some((event) => event.type === "nuclear_winter"), false);
    }

    // --- c(iii). winterFrom follows config: a literal 10 dies here ---------------------------
    {
      const restoreHigh = withNukes(true, { winterFrom: 12 });
      try {
        eq("winterFrom reads config", winterFrom(), 12);
        const { match } = fixture({ detonated: 10 });
        const target = pickTarget(match, payload);
        must(Boolean(target), "no target cell for the moved-threshold arm");
        const shot = launch(match, target);
        eq("the strike made eleven detonations", nukeState(match).detonated, 11);
        eq("eleven is below a config winterFrom of 12: no draw", shot.after, shot.before);
        eq("and no winter", shot.result.events.some((event) => event.type === "nuclear_winter"), false);
      } finally {
        restoreHigh();
      }
      const restoreLow = withNukes(true, { winterFrom: 11 });
      try {
        const { match } = fixture({ detonated: 10 });
        const target = pickTarget(match, payload);
        must(Boolean(target), "no target cell for the lowered-threshold arm");
        const shot = launch(match, target);
        must(shot.after !== shot.before, "eleven is AT a config winterFrom of 11, but no draw was taken");
        const rolled = (shot.result.events || []).find((event) => event.type === "nuclear_winter"
          || event.type === "nuke_warning");
        must(Boolean(rolled), "the strike emitted neither the warning nor the winter line");
      } finally {
        restoreLow();
      }
    }

    // --- c(iv). the warning threshold still reads config too --------------------------------
    {
      const restoreWarn = withNukes(true, { warnFrom: 7 });
      try {
        eq("warnFrom reads config", warnFrom(), 7);
        const { match } = fixture({ detonated: 5 });
        const target = pickTarget(match, payload);
        must(Boolean(target), "no target cell for the warning arm");
        const shot = launch(match, target);
        eq("six detonations are below a config warnFrom of 7",
          shot.result.events.some((event) => event.type === "nuke_warning"), false);
        eq("but the lower warning line is still the config's", rules().nukes.warnFrom, 7);
      } finally {
        restoreWarn();
      }
    }
  } finally {
    restore();
  }
}
