// PB-135: the Log panel reaches the buffer it already holds, a mid-match resync merges, and a reader
// who scrolled up is not yanked.
//
// The page paints `paintedLines(log)` - every retained line - inside a scroll container, not the
// six-round window `logWindow()` cuts. This drives twenty rounds of lines through the same append
// rule `noteLog` uses, more than LOG_KEEP, then resyncs the last fifteen lines the way the server's
// `sync` frame does (room.log = 15 per side) and requires the buffer to be unchanged: merged, not
// replaced, and not painted twice.
import { logWindow } from "../../public/dialogs.mjs";
import {
  affordanceText,
  appendLog,
  emptyLog,
  isAtBottom,
  LOG_KEEP,
  paintedLines,
  pendingAfterPaint,
  scrollAfterPaint,
} from "../../public/logview.mjs";

export const name = "pb135_log_scroll";

export async function run(ctx) {
  const { fail } = ctx;

  // ---- AC1/AC5: retention, not the painted window --------------------------------------------
  // Twenty rounds x 15 lines = 300 retained lines, which is more than LOG_KEEP and the shape of a
  // chatty round. The buffer trims to the cap; the panel paints all of the cap.
  const log = emptyLog();
  const feed = [];
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 15; i++) feed.push({ round, text: "r" + round + " event " + i });
  }
  const added = appendLog(log, feed);
  if (added !== feed.length) fail("every fresh line should append: added " + added + " of " + feed.length);
  if (log.lines.length !== LOG_KEEP) fail("buffer should trim to LOG_KEEP " + LOG_KEEP + ", got " + log.lines.length);

  const painted = paintedLines(log);
  if (painted.length !== log.lines.length) {
    fail("the panel paints " + painted.length + " of " + log.lines.length + " retained lines");
  }
  const firstRetained = log.lines[0].round;
  const firstPainted = painted[0].round;
  if (firstPainted !== firstRetained) {
    fail("scroll-back cannot reach the oldest retained round: first painted " + firstPainted + ", retained " + firstRetained);
  }
  const lastRound = feed[feed.length - 1].round;
  if (lastRound - firstPainted < 12) {
    fail("scroll-back reaches only " + (lastRound - firstPainted) + " rounds, AC1 asks for at least 12");
  }
  // PB-121's six-round window is still the opening view: the panel paints MORE than that window and
  // the window itself is its tail, so the newest six rounds remain exactly what a fresh reader sees.
  const window = logWindow(log.lines);
  if (painted.length < window.length) fail("the panel paints fewer lines than the six-round window");
  const tail = painted.slice(painted.length - window.length);
  if (JSON.stringify(tail) !== JSON.stringify(window)) fail("the six-round window is not the tail of the painted buffer");

  // ---- AC3/AC5: a mid-match sync MERGES -------------------------------------------------------
  // The server's sync frame is room.log: the last 15 lines per side. Re-delivering lines the page
  // already holds must add nothing, and must not shrink the buffer.
  const resync = feed.slice(-15);
  const before = log.lines.length;
  const firstBefore = log.lines[0].round;
  const addedAgain = appendLog(log, resync);
  if (addedAgain !== 0) fail("a resync re-painted " + addedAgain + " line(s) the buffer already held");
  if (log.lines.length !== before) fail("a resync changed the buffer: " + before + " -> " + log.lines.length);
  if (log.lines[0].round !== firstBefore) fail("a resync dropped the oldest retained round");
  if (paintedLines(log).length !== painted.length) fail("the painted window shrank across a resync");

  // A sync that DOES carry a round the page missed appends it, deduped by round+text.
  const fresh = appendLog(log, [{ round: 20, text: "r20 new contact" }, { round: 20, text: "r20 new contact" }]);
  if (fresh !== 1) fail("an unkeyed duplicate was not deduped: appended " + fresh + " of 2");
  // A keyed line is deduped on its key, as the server's sighting lines are.
  const keyed = appendLog(log, [{ round: 21, text: "seen", key: "sight:1" }, { round: 21, text: "seen", key: "sight:1" }]);
  if (keyed !== 1) fail("a keyed duplicate was not deduped: appended " + keyed + " of 2");

  // ---- AC2: the reader who scrolled up is not yanked ------------------------------------------
  const tall = { clientHeight: 400, scrollHeight: 1200 };
  const pinned = { pinned: true, scrollTop: 0, pending: 0 };
  if (scrollAfterPaint(pinned, tall) !== 800) fail("a pinned reader should land at the bottom, got " + scrollAfterPaint(pinned, tall));
  if (pendingAfterPaint(pinned, 7) !== 0) fail("a pinned reader should not accumulate a jump affordance");

  const away = { pinned: false, scrollTop: 120, pending: 0 };
  if (scrollAfterPaint(away, tall) !== 120) fail("a scrolled-up reader lost their place: " + scrollAfterPaint(away, tall));
  const pending = pendingAfterPaint(away, 5);
  if (pending !== 5) fail("a scrolled-up reader was not told about new lines: " + pending);
  if (affordanceText(pending) !== "5 new lines \u2193") fail("affordance text: " + affordanceText(pending));
  if (affordanceText(1) !== "1 new line \u2193") fail("singular affordance text: " + affordanceText(1));
  if (affordanceText(0) !== "") fail("no pending lines should show no control");
  // A reader who scrolls back to the bottom is pinned again, and the count clears.
  if (!isAtBottom({ scrollTop: 800, clientHeight: 400, scrollHeight: 1200 })) fail("at-bottom was not detected");
  const back = { pinned: true, scrollTop: 800, pending: 5 };
  if (pendingAfterPaint(back, 2) !== 0) fail("reaching the bottom did not clear the count");

  // ---- the page applies this policy, and keeps a scroll container ---------------------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  const css = await (await fetch(ctx.base + "/app.css")).text();
  for (const call of [
    // PB-263: the panel paints the buffer through the message-level filter; the claim here is that
    // it paints all of what it retains, so the call is named with the level it now takes.
    "paintedLines(log, messageLevel)",
    'list.id = "roundLog"',
    "scrollAfterPaint(logView",
    "pendingAfterPaint(logView",
    'list.addEventListener("scroll"',
    "syncLogJump(list)",
  ]) {
    if (!app.includes(call)) fail("app.js does not use " + call);
  }
  if (app.includes("logWindow(roundLog")) fail("paintLog still draws the six-round window over the buffer");
  if (app.includes("!roundLog.length && room")) fail("a resync is still taken only into an empty buffer");
  if (!/\.roundLog\s*\{[^}]*overflow-y:\s*auto/.test(css)) fail("the log list has no scrolling CSS");
  if (!/\.roundLog\s*\{[^}]*max-height:/.test(css)) fail("the log list has no height cap to scroll within");

  console.log(
    "pb135_log_scroll: " + log.lines.length + " retained painted in full (oldest round " + firstPainted +
      ", " + (lastRound - firstPainted) + " rounds reachable); resync merged 0 new; scrolled-up reader kept 120 and saw \"5 new lines\""
  );
}
