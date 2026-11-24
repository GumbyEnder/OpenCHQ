// Node test for PB-233 AC (d): every number cites a Ghidra function, a manual page, or says
// STAND-IN - and the numbers this ticket added must not hide behind PB-156's block-level sentence.
//
// What breaks if this node is removed: a new tunable ships with a bare value, and the next reader
// cannot tell a decoded constant from a port decision. The guard is the general form of PB-230's
// one-key `killRadiusSource` check.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetRules, rules } from "../../server/rules.mjs";
import {
  OWN_SOURCE_KEYS, missingSources, ownSourceMissing, sourceFor, unlabelledSources,
} from "../../server/aftermath.mjs";

export const name = "pb233_sources";

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

// Same config swap the other PB-233 nodes use. A null in the patch DELETES the key, so "the config
// lost a source" is testable - the whole point of a provenance guard is that it can fail.
function withConfig(patch = {}) {
  const custom = JSON.parse(JSON.stringify(rules()));
  for (const [name, value] of Object.entries(patch)) {
    const [block, key] = name.split(".");
    if (key === undefined) continue;
    custom[block] = custom[block] || {};
    if (value === null) delete custom[block][key];
    else custom[block][key] = value;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pb233d-"));
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

export async function run() {
  const nukes = rules().nukes || {};

  // --- d(i). the shipped block is fully sourced --------------------------------------------
  eq("every numeric nukes key resolves to a source", missingSources(), []);
  eq("every key this ticket added carries its OWN source", ownSourceMissing(), []);
  eq("every source sentence names an anchor or says STAND-IN", unlabelledSources(), []);
  must(String(nukes.source || "").trim().length > 200,
    "the block-level source is too short to name what it covers");

  // The seven keys AC (d) is about, each present in the shipped config and each cited.
  for (const key of OWN_SOURCE_KEYS) {
    must(typeof nukes[key] === "number", "nukes." + key + " is not a number in the shipped config");
    const text = String(nukes[key + "Source"] || "");
    must(text.trim().length > 40, "nukes." + key + "Source is not a sentence");
    must(/Ghidra|decompiled\.c|FUN_[0-9a-f]+|STAND-IN|Manual p\.\d+|RULED/.test(text),
      "nukes." + key + "Source names no anchor: " + text);
  }
  eq("the registration order of the owned keys is stable", OWN_SOURCE_KEYS.length, 5);
  must(/0x13be/.test(String(nukes.attitudeShiftSource)), "the attitude source must name the nibble it stands in for");
  must(/0x13e4/.test(String(nukes.attitudeShiftSource)), "the attitude source must name the byte the ledger ports");
  // frodo 8983 §4 struck the flat production cut; the keys are gone, not merely unsourced, and the
  // block sentence carries the corrected 5n citation instead of a second arithmetic.
  must(!("productionCutFrom" in nukes) && !("productionCutPercent" in nukes),
    "the struck production-cut keys must not exist");
  must(/4772/.test(String(nukes.source)), "the block source must cite the 4772 gate line");

  // --- d(ii). the guard can fail: a deleted own source is caught ----------------------------
  {
    const restore = withConfig({ "nukes.attitudeShiftSource": null });
    try {
      eq("a missing own source is reported", ownSourceMissing(), ["attitudeShift"]);
      // The block sentence still exists, so the WEAKER guard stays green - which is exactly why
      // both guards are in this node.
      eq("the block-level sentence still resolves the key", missingSources(), []);
      eq("the key still resolves to the block sentence", sourceFor("attitudeShift"), rules().nukes.source);
    } finally {
      restore();
    }
  }

  // --- d(iii). with no block sentence either, the missing provenance is caught ---------------
  {
    const restore = withConfig({ "nukes.source": null });
    try {
      const missing = missingSources();
      must(missing.includes("launchLead"), "a numeric key with no source at all was not reported: " + missing);
      must(missing.includes("winterFrom"), "a numeric key with no source at all was not reported: " + missing);
      must(!missing.includes("attitudeShift"), "a key with its own source was reported as missing");
    } finally {
      restore();
    }
  }

  // --- d(iv). a sentence that names nothing is worse than a missing key --------------------
  {
    const restore = withConfig({ "nukes.switchChanceSource": "It is what it is." });
    try {
      const unlabelled = unlabelledSources();
      must(unlabelled.includes("switchChanceSource"),
        "a source sentence with no anchor was accepted: " + unlabelled);
    } finally {
      restore();
    }
  }

  // --- d(v). the block sentence is the one that carries the corrected citation --------------
  must(/4772/.test(String(rules().nukes.source)) && /NOT 4763/.test(String(rules().nukes.source)),
    "the block source must carry the 4763 -> 4772 correction, not the old line");
}
