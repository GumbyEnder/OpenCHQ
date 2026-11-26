// PB-263: the Message Level control (Manual p.32, "Menu Command Summary"; p.19, "The Message Bar").
//
// "Use this command to scroll between warning message levels. Level three warns of all threats to
// friendly cities, and of enemy units spotted; level two warns of threats only; level one warns of
// only 'serious' threats; level zero gives no warning messages." (p.32)
//
// The levels filter WARNINGS only. A capture, a fight, a payday or a lost unit is news the player's
// own seat earned, not a warning, and no level hides it. So a log line carries a tag only when it is
// a warning:
//
//   "spotted"  - an enemy unit is in sight (level 3 only)
//   "threat"   - enemy land troops closing on a friendly city (levels 3 and 2)
//   "serious"  - a threat to a capital, or an enemy on/next to a friendly city (all levels above 0)
//
// A line with no tag is always painted. The tags are set by the server (web/server/log.mjs) so both
// seats read the same warning and the page never has to guess from the sentence.
//
// "Serious" is a PORT DECISION, UNVERIFIED: the manual names the level but never defines the word,
// and the RE recovered only the "message level" string and the warning sentences themselves
// (docs/re/SYSTEMS.md §21). A threat to a capital -- the object of every scenario (Manual p.18) --
// or an enemy land unit on or next to a friendly city is what this port calls serious.

export const MESSAGE_LEVELS = [3, 2, 1, 0];
export const DEFAULT_MESSAGE_LEVEL = 3;

// What the level means, in the manual's own words, for the control's tooltip and the readout.
export const MESSAGE_LEVEL_MEANING = {
  3: "all warnings and enemy units spotted",
  2: "all threats to friendly cities",
  1: "serious threats only",
  0: "no warning messages",
};

export function normalizeMessageLevel(value) {
  // `Number(null)` is 0, which is a real level: a missing setting must fall back to the default,
  // never to "no warnings".
  if (value === null || value === undefined || value === "") return DEFAULT_MESSAGE_LEVEL;
  const level = Number(value);
  return MESSAGE_LEVELS.includes(level) ? level : DEFAULT_MESSAGE_LEVEL;
}

// The manual's command "scrolls between" the four levels; the port cycles 3 -> 2 -> 1 -> 0 -> 3.
export function nextMessageLevel(level) {
  const at = MESSAGE_LEVELS.indexOf(normalizeMessageLevel(level));
  return MESSAGE_LEVELS[(at + 1) % MESSAGE_LEVELS.length];
}

// Is this line painted at this level? An untagged line is not a warning and always is.
export function showsLineAt(level, tag) {
  if (!tag) return true;
  const at = normalizeMessageLevel(level);
  if (at === 0) return false;
  if (at === 1) return tag === "serious";
  if (at === 2) return tag === "threat" || tag === "serious";
  return true;
}

export function filterLogLines(lines, level) {
  return (Array.isArray(lines) ? lines : []).filter((line) => line && showsLineAt(level, line.tag));
}

export function messageLevelReadout(level) {
  return "Msg " + normalizeMessageLevel(level);
}

export function messageLevelTitle(level) {
  const at = normalizeMessageLevel(level);
  return "Message level " + at + " of 3: " + MESSAGE_LEVEL_MEANING[at] + ". Click to cycle. " +
    "The manual states no default level: 3 is this port's choice. " +
    "Port decision: what counts as 'serious' is a capital alarm, or an enemy on a friendly city's " +
    "doorstep (manual p.32, Message Level).";
}
