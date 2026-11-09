// The dialog's lifecycle, kept out of the DOM so a state refresh is a thing a test can run.
//
// The live bug was a panel that shut whenever a round arrived. A panel is a view of state, not a
// piece of it: a refresh may redraw its body, but only the player's own actions close it.

export function dialogAfter(current, event) {
  const open = current === undefined ? null : current;
  const type = event && event.type;
  if (type === "open") {
    // The same button toggles its own panel; a different one replaces it.
    return open === event.id ? null : event.id || null;
  }
  if (type === "close" || type === "escape") return null;
  if (type === "leave") return null;
  if (type === "refresh") return event.room === false ? null : open;
  return open;
}

// What the redraw must put back. Scroll belongs to the body; focus is named by a stable key so a
// rebuilt node can be found again. Pure, so the same policy is what the page applies.
export function keepView(scrollTop, focusKey) {
  return {
    scrollTop: Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0,
    focusKey: focusKey ? String(focusKey) : "",
  };
}

export function focusKeyOf(element) {
  if (!element) return "";
  if (element.dataset && element.dataset.focus) return String(element.dataset.focus);
  const tag = element.tagName ? element.tagName.toLowerCase() : "";
  if (!tag) return "";
  return tag + ":" + String(element.textContent || "").trim();
}
