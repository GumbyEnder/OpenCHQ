// The Log panel's buffer and its scroll policy (PB-135).
//
// The page keeps the lines the server already filtered to this seat, and the panel is a SCROLL
// container over all of them: the six-round window PB-121 introduced is still what a fresh reader
// lands on (the list opens at the newest line), but the rounds the page already holds are reachable
// instead of being dead weight. One append rule serves the live `log` frame, the initial seed and a
// mid-match `sync`, so a resync MERGES into the buffer and a line is never painted twice.

export const LOG_KEEP = 240;

export function emptyLog() {
  return { lines: [], keys: new Set(), signatures: new Set() };
}

function signature(line) {
  return (Number(line.round) || 0) + "\u0000" + String(line.text);
}

function prune(state) {
  state.keys = new Set();
  state.signatures = new Set();
  for (const line of state.lines) {
    if (line.key) state.keys.add(line.key);
    else state.signatures.add(signature(line));
  }
}

// Append server lines to the buffer. A line keyed by the server is deduped on the key; an unkeyed
// line on round+text. Returns how many lines were actually added, which is what the panel's "new
// lines" affordance counts.
export function appendLog(state, lines, keep = LOG_KEEP) {
  let added = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || !line.text) continue;
    if (line.key) {
      if (state.keys.has(line.key)) continue;
      state.keys.add(line.key);
    } else {
      const sig = signature(line);
      if (state.signatures.has(sig)) continue;
      state.signatures.add(sig);
    }
    const entry = { round: Number(line.round) || 0, text: String(line.text) };
    if (line.key) entry.key = String(line.key);
    state.lines.push(entry);
    added += 1;
  }
  if (state.lines.length > keep) {
    state.lines = state.lines.slice(-keep);
    prune(state);
  }
  return added;
}

export function resetLog(state) {
  state.lines = [];
  state.keys = new Set();
  state.signatures = new Set();
}

// What the panel paints: every retained line, oldest first. Not a round window.
export function paintedLines(state) {
  return state.lines.slice();
}

// ---- scroll policy -------------------------------------------------------------------------
// A reader at the bottom follows new lines; a reader who scrolled up keeps their place and is
// offered a jump instead of being yanked.

export function isAtBottom({ scrollTop, clientHeight, scrollHeight }) {
  return scrollHeight - scrollTop - clientHeight <= 4;
}

export function scrollAfterPaint(view, { clientHeight, scrollHeight }) {
  const floor = Math.max(0, scrollHeight - clientHeight);
  return view.pinned ? floor : Math.min(Math.max(0, view.scrollTop), floor);
}

export function pendingAfterPaint(view, added) {
  if (view.pinned) return 0;
  return Math.max(0, view.pending) + Math.max(0, added);
}

export function affordanceText(pending) {
  if (!pending) return "";
  return pending + (pending === 1 ? " new line" : " new lines") + " \u2193";
}
