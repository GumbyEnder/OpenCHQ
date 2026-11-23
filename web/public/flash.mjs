// The flash line and the match result are two different kinds of text.
//
// PB-137: `say()` wrote `#flash.textContent` and nothing ever cleared it, so "Order sent. 1 round to
// walk. Selection cleared." sat on screen for rounds. A flash is an acknowledgement of the last thing
// the player did; it has no business outliving the moment. It now clears itself on a timer, and a new
// flash replaces the old one and restarts that timer.
//
// A finished match is not an acknowledgement. The result sentence has to stay readable until the
// player leaves the match, so it lives in its own element (`#result`) that `say()` cannot touch. The
// timer state machine is here rather than in app.js so a node test can drive it with a fake clock and
// pin both halves without a browser.

export const FLASH_MS = 6000; // well inside PB-137's 8 s ceiling

export function createFlashLine(options = {}) {
  const element = options.element || null;
  const resultElement = options.resultElement || null;
  const ms = Number(options.ms) > 0 ? Number(options.ms) : FLASH_MS;
  const setTimer = options.setTimer || ((fn, delay) => setTimeout(fn, delay));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
  let timer = null;

  // One line at a time: the newest text wins, and the clock restarts with it. A stale timer must not
  // blank a line that replaced it, which is why the pending timer is cancelled before the write.
  function say(text) {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (element) element.textContent = text || "";
    if (!text) return;
    timer = setTimer(() => {
      timer = null;
      if (element) element.textContent = "";
    }, ms);
  }

  function result(text) {
    if (resultElement) resultElement.textContent = text || "";
  }

  // Only a player leaving the match clears it; no timer and no later `say()` does.
  function clearResult() {
    if (resultElement) resultElement.textContent = "";
  }

  // PB-169: the line can be read back and cleared. A late-order warning must come down when the ack
  // arrives instead of sitting out the rest of its timer, and only the order that WROTE it may clear
  // it — hence `text()` to compare before `clear()`.
  function text() {
    return element ? String(element.textContent || "") : "";
  }
  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (element) element.textContent = "";
  }

  return {
    ms,
    say,
    result,
    clearResult,
    text,
    clear,
    pending: () => timer !== null,
  };
}
