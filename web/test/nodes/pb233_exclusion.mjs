// Node test for the PB-233 rider: the capital ring is config, and a config that lost it refuses.
//
// Ruled on the PB-229/230 ship word (frodo's M9): `exclusionRadius()` used to answer a literal 2
// when the key was missing, and no arm could see it because the fallback equalled the shipped
// config. The defect needed a config move to show, which is exactly what this ticket makes possible
// - the flag goes on under a config a player's host can change.
//
// What breaks if this node is removed: a host whose config loses `nukes.exclusion` silently gets a
// 2-cell ring that no one wrote, and the sentence the player reads keeps saying "2 cells" while the
// ring is whatever the fallback happens to be.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { resetRules, rules } from "../../server/rules.mjs";
import { useTool } from "../../server/late.mjs";
import { STAND_IN } from "../../server/blast.mjs";
import { assertShippedNukesArmed } from "./_nuke_default.mjs";
import {
  NUKE_EXCLUSION_UNKNOWN, capitalText, exclusionRadius, nukeTarget, resolvedCapitals,
} from "../../server/nukestrike.mjs";

export const name = "pb233_exclusion";

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
  const dir = mkdtempSync(path.join(tmpdir(), "pb233x-"));
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

function fixture() {
  const payload = boardPayload();
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  return match;
}

// The two cells the ring arm needs: one exactly `ring` cells from a capital on the same row, and one
// `ring + 1` cells away. Both are picked off the resolved capital set, not typed in.
function ringCells(match, ring, side = null) {
  const capital = resolvedCapitals(match).list.find((row) => Number.isFinite(row.x) && Number.isFinite(row.y)
    && row.x < 300 && row.y > 4 && row.y < 131 && (side === null || row.side === side));
  if (!capital) return null;
  return {
    capital,
    inside: { x: capital.x + ring, y: capital.y },
    outside: { x: capital.x + ring + 1, y: capital.y },
  };
}

export async function run(ctx) {
  // PB-233 (f): the shipped default is ARMED; a forced-off config still refuses at nukeStatus.
  assertShippedNukesArmed();
  eq("the shipped ring is the stand-in 2", exclusionRadius(), 2);
  must(/2 cells/.test(capitalText()), "the shipped sentence must read the shipped 2: " + capitalText());
  // PB-244: the sentence prints the ring size and hands the player no tag; the stand-in provenance
  // stays in config.nukes.exclusionSource, which the next line still asserts.
  must(!/\b(UNVERIFIED|UNMEASURED|STAND-IN)\b/.test(capitalText()),
    "the ring sentence hands the player a developer tag: " + capitalText());
  must(/decompiled\.c|STAND-IN/.test(String(rules().nukes.exclusionSource)),
    "config nukes.exclusionSource must say where the 2 came from");

  const restore = withNukes(true);
  try {
    let match;
    try {
      match = fixture();
      must(Boolean(match && match.sites && match.sites.length), "the board has no sites");
    } catch {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }

    // --- x(i). the ring size follows config, and the sentence follows the ring ---------------
    {
      const restoreThree = withNukes(true, { exclusion: 3 });
      try {
        eq("the ring reads config", exclusionRadius(), 3);
        must(/3 cells/.test(capitalText()), "the sentence did not move with the config: " + capitalText());
        must(!/2 cells/.test(capitalText()), "the sentence still claims 2 cells at ring 3: " + capitalText());
        const built = fixture();
        // The OUTSIDE cell has to be a legal aim too, so the ring is measured from RED's capital:
        // blue aiming outside Moscow's ring is not on its own home ground (PB-229's b(ii) refusal
        // fires for London and Tokyo, which are blue's).
        const cells = ringCells(built, 3, "red");
        must(Boolean(cells), "no resolved capital to measure the ring from");
        const inside = nukeTarget(built, "blue", cells.inside);
        must(Boolean(inside.error), "a cell inside a 3-cell ring was allowed: " + JSON.stringify(inside));
        must(/capital/.test(String(inside.error)), "the ring refusal lost its sentence: " + inside.error);
        eq("the refusal names the config size", inside.error, capitalText(3));
        // The same cell would have been allowed under the shipped 2: that is the arm's point.
        const before = useTool(built, "blue", "nuke", cells.outside);
        must(!before.error && before.ok, "a legal aim outside the ring was refused: " + JSON.stringify(before));
      } finally {
        restoreThree();
      }
    }

    // --- x(ii). a config that LOST the ring refuses instead of guessing ---------------------
    {
      const restoreGone = withNukes(true, { exclusion: null });
      try {
        eq("a missing ring answers null, not a literal", exclusionRadius(), null);
        // PB-244 dropped the trailing "is a stand-in" clause, so the shape is "cells is its size".
        eq("the sentence does not invent a number", /cells is its size\./.test(capitalText()), true);
        must(/\? cells/.test(capitalText()), "the sentence must not print a number it does not have: " + capitalText());
        const built = fixture();
        const cells = ringCells(built, 2);
        must(Boolean(cells), "no resolved capital for the missing-ring arm");
        const cash = built.sides.blue.cash;
        const refused = useTool(built, "blue", "nuke", cells.outside);
        eq("a launch with no ring configured is refused", refused.error, NUKE_EXCLUSION_UNKNOWN);
        eq("a refused launch costs nothing", built.sides.blue.cash, cash);
        eq("the refusal never reached the strike", built.pieces.length, 0);
      } finally {
        restoreGone();
      }
    }
  } finally {
    restore();
  }
}
