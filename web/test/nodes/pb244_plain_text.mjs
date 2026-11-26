// Node test: PB-244 — no developer note in a player's sentence, and the provenance is not lost.
//
// The rule (PM 9063 §2): a title, a toast, a briefing or a refusal is written for a player. Tags that
// exist to warn a maintainer - UNVERIFIED, UNMEASURED, STAND-IN, "the archive's note" - belong in
// config, where the next person reading the tunable will find them.
//
// This node is the guard for the whole class, not one sentence:
//   1. every player-facing source file, COMMENTS STRIPPED, is free of the tags. Comments may say
//      anything; a string a player can read may not.
//   2. the builders that produce those sentences return plain text (kit briefings for both seats and
//      both late eras, the capital-ring refusal, the transfer note, the out-of-range error).
//   3. the provenance still exists in config - the tag moved, it was not deleted.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kitBriefing } from "../../server/late.mjs";
import { capitalText } from "../../server/nukestrike.mjs";
import { TRANSFER_NOTE } from "../../server/air.mjs";
import { openMatch } from "../../server/match.mjs";

export const name = "pb244_plain_text";

function fail(message) {
  throw new Error(message);
}

// frodo 9108 §7: "never recovered" is the same class of defect as a tag — a note about the port in a
// sentence a player reads — so the guard names the wording we actually found, not only the labels.
const TAG = /\b(UNVERIFIED|UNMEASURED|STAND-IN)\b|archive's (own )?note|never recovered/i;

// Strip // and /* */ comments while respecting strings and template literals, and drop REGEX
// LITERALS. Small on purpose: the files under test are plain ES modules.
//   - A tag inside a template literal still counts as player text, so the stripper must not cut there.
//   - A tag inside a regex literal is CODE, not a sentence: aftermath.mjs and rules.mjs both test a
//     config string against /STAND-IN/ to validate provenance. A widened walk that kept regex
//     literals would red the tree it graded (frodo 9108 §5's implementation note), which is why the
//     walk and this arm land together.
function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  // The last emitted token decides whether a `/` opens a regex or divides. After a value (identifier,
  // number, string, `)`, `]`, `}`) it divides; after an operator, a bracket that opens, or a keyword
  // like `return`, it opens a pattern.
  let prev = "";
  const KEYWORDS = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  const regexAllowed = () => {
    if (prev === "") return true;
    if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)) return true;
    return KEYWORDS.test(prev);
  };
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      // Scan the pattern; a raw newline before the closing `/` means this was division after all.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = source[j];
        if (ch === "\n") break;
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { closed = true; j += 1; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(source[j])) j += 1; // flags
        i = j;
        prev = "`";
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") { out += source[i] + (source[i + 1] || ""); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      prev = "`";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = (prev + c).slice(-24);
    i += 1;
  }
  return out;
}

export async function run() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // THE WHOLE PLAYER SURFACE, WALKED — not a hand-kept list. frodo 9108 §5 put a tag into
  // index.html's boot line and the suite stayed green, because the guard named 13 files and the page
  // a player reads before the lobby loads was not one of them. A list is a claim about which files
  // can reach a player; a directory walk cannot go stale when a module is added.
  // public/: everything the page loads (.js, .mjs, .html). server/: every module that builds a
  // sentence. web/test and tests/ are excluded on purpose — a test may say the tag.
  const files = [];
  for (const [dir, pattern] of [["public/", /\.(?:js|mjs|html)$/], ["server/", /\.mjs$/]]) {
    for (const entry of readdirSync(root + dir, { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) files.push(dir + entry.name);
    }
  }
  if (files.length < 50) fail("the player-surface walk found only " + files.length + " files: " + files.join(","));
  for (const file of files) {
    const source = readFileSync(root + file, "utf8");
    // A bare `export const STAND_IN = "STAND-IN";` is not a sentence: it is the handle the tests use
    // to compare config's own provenance against the tag it records. Drop those definitions only.
    const code = stripComments(source).replace(/^\s*export const [A-Z_0-9]+ = "(?:UNVERIFIED|UNMEASURED|STAND-IN)";\s*$/gm, "");
    const hit = code.match(TAG);
    if (hit) {
      const at = code.indexOf(hit[0]);
      const line = code.slice(0, at).split("\n").length;
      fail(file + " line ~" + line + " shows a developer tag to a player: " + hit[0]);
    }
  }

  // ---- the sentences themselves -------------------------------------------------------
  for (const era of ["1986", "2023"]) {
    for (const side of ["blue", "red"]) {
      const match = openMatch(era, []);
      const briefing = kitBriefing(match, side);
      const rows = Array.isArray(briefing) ? briefing : (briefing && briefing.rows) || [];
      if (!rows.length) fail(era + " " + side + " kit briefing came back empty");
      for (const row of rows) {
        for (const field of ["label", "text", "refused", "note"]) {
          const text = row && row[field];
          if (typeof text === "string" && TAG.test(text)) {
            fail(era + " " + side + " " + (row.kind || "?") + "." + field + " carries a tag: " + text);
          }
        }
      }
    }
  }
  const ring = capitalText();
  if (TAG.test(ring)) fail("the capital-ring refusal still carries a tag: " + ring);
  if (!/cells is its size\.$/.test(ring)) fail("the capital-ring refusal lost its shape: " + ring);
  if (TAG.test(TRANSFER_NOTE)) fail("the transfer note still carries a tag: " + TRANSFER_NOTE);
  if (!/rebases to the base you pick\.$/.test(TRANSFER_NOTE)) fail("the transfer note lost its sentence: " + TRANSFER_NOTE);

  // ---- the provenance moved, it did not evaporate --------------------------------------
  // ONE KEY AT A TIME. The first version of this arm asked whether the tag appeared "somewhere in
  // config", and a mutant that blanked one sentence's provenance survived it, because a second key
  // still carried the word. A key that loses its doubt is the actual defect, so each number the
  // sweep touched is checked at the key that owns it.
  const config = JSON.parse(readFileSync(root + "../config/game.json", "utf8"));
  const wants = [
    ["air.reachSource", config.air && config.air.reachSource, /UNMEASURED|STAND-IN/],
    ["air.transferRoundsSource", config.air && config.air.transferRoundsSource, /UNVERIFIED/],
    // PB-293: the manual's "a CAP flown while inactive is less effective" has no recovered amount.
    // The factor is a config lever and this is where its provenance is required to live.
    ["air.inactivePatrolFactorSource", config.air && config.air.inactivePatrolFactorSource, /UNVERIFIED/],
    ["air.restrictedReachSource", config.air && config.air.restrictedReachSource, /UNVERIFIED|STAND-IN/],
    ["nukes.exclusionSource", config.nukes && config.nukes.exclusionSource, /STAND-IN|decompiled|UNVERIFIED/],
    ["blast.source", config.blast && config.blast.source, /STAND-IN|NOT recovered|not recovered|UNVERIFIED/],
    ["satellite.note", config.satellite && config.satellite.note, /STAND-IN|UNMEASURED|UNVERIFIED/],
    ["resources.steel.choice", config.resources && config.resources.steel && config.resources.steel.choice, /non-original/],
    ["sources.prices.killerSat", config.sources && config.sources.prices && config.sources.prices.killerSat, /UNVERIFIED/],
    // frodo 9108 §6, his m4b: the aid briefing's doubt lives at these two keys, and nothing asserted
    // them — blanking both skipped the sentence check entirely and the suite stayed green. One key at
    // a time, like every arm above.
    ["loyalty.note", config.loyalty && config.loyalty.note, /STAND-IN|UNVERIFIED/],
    ["sources.loyalty", config.sources && config.sources.loyalty, /STAND-IN|UNVERIFIED/],
    // frodo 9108 §7: the opening force's order of battle was never recovered. That clause used to be in
    // the Buy panel's sentence; it is a maintainer's note about the port, so PB-244 moved it here.
    ["notes.openingRoster", config.notes && config.notes.openingRoster, /never recovered/],
  ];
  for (const [key, value, pattern] of wants) {
    if (typeof value !== "string" || !pattern.test(value)) {
      fail("config " + key + " no longer records what was never recovered (the tag moved, it must land)");
    }
  }
}
