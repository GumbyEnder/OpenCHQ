// Shared PB-233 (f) helper: the shipped default is ARMED, and a disabled config still refuses.
//
// The file name starts with `_` so web/test/run.mjs does not treat it as a node of its own.
//
// Why this exists: before the (f) flip every nuke node opened with "the shipped config leaves nukes
// inert". After the flip that sentence is false, but the refusal path it guarded still matters --
// a deployment that turns the block off must keep a nuke unlaunchable. So both facts are proved in
// one call, in this order, whatever the caller's fixtures are:
//
//   1. the shipped config has `nukes.enabled === true`;
//   2. `nukeStatus()` ALLOWS a launch on a quiet board with it;
//   3. a copy of the same config with `enabled:false`, loaded through OPENCHQ_CONFIG + resetRules(),
//      makes `nukeStatus()` refuse with the inert note (that check runs before any board read);
//   4. the shipped config is back afterwards, so the caller's own arms run on shipped rules.
//
// `rules()` is cached, which is exactly why the swap is `resetRules()` and not a re-read.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NUKE_NOTE, nukeStatus } from "../../server/late.mjs";
import { resetRules, rules } from "../../server/rules.mjs";

// Load a full copy of the current rules with the nuke block forced off; returns the restore.
export function withNukesOff() {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.nukes = { ...(custom.nukes || {}), enabled: false };
  const dir = mkdtempSync(path.join(tmpdir(), "pb233f-"));
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

// Both facts about the shipped default, proved in one place.
export function assertShippedNukesArmed(board = {}) {
  const match = board && typeof board === "object" ? board : {};
  const shipped = rules().nukes || {};
  if (shipped.enabled !== true) {
    throw new Error("the shipped config does not arm the nuke: nukes.enabled=" + shipped.enabled);
  }
  const armed = nukeStatus(match, "blue");
  if (armed.allowed !== true) {
    throw new Error("the shipped config does not let nukeStatus allow a launch: " + JSON.stringify(armed));
  }
  const restore = withNukesOff();
  try {
    const off = rules().nukes || {};
    if (off.enabled !== false) throw new Error("the forced-off config did not load: nukes.enabled=" + off.enabled);
    const refused = nukeStatus(match, "blue");
    if (refused.allowed !== false) {
      throw new Error("an enabled:false config still lets nukeStatus allow a launch: " + JSON.stringify(refused));
    }
    if (refused.reason !== NUKE_NOTE) {
      throw new Error("the enabled:false refusal does not carry the inert note: " + JSON.stringify(refused));
    }
  } finally {
    restore();
  }
  if ((rules().nukes || {}).enabled !== true) {
    throw new Error("the shipped config did not come back after the forced-off swap");
  }
}
