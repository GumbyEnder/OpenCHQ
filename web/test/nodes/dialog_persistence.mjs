// A dialog is a view of state. The clock arriving must not shut it, and a redraw must not lose
// the player's place: thirty state refreshes later the same panel is open with the same scroll
// and focus, and only the player's own actions close it.
import { dialogAfter, focusKeyOf, keepView } from "../../public/dialogstate.mjs";

export const name = "dialog_persistence";

export async function run(ctx) {
  const { fail } = ctx;

  // Open, then thirty round refreshes.
  let open = dialogAfter(null, { type: "open", id: "buy" });
  if (open !== "buy") fail("opening Buy did not open it: " + open);
  for (let i = 0; i < 30; i++) {
    open = dialogAfter(open, { type: "refresh", room: true });
    if (open !== "buy") fail("a state refresh closed the dialog at update " + (i + 1));
  }

  // The same button toggles; a different one replaces.
  if (dialogAfter("buy", { type: "open", id: "buy" }) !== null) fail("pressing Buy again did not toggle it");
  if (dialogAfter("buy", { type: "open", id: "log" }) !== "log") fail("a different dialog did not replace Buy");

  // Only the player's actions close it.
  for (const type of ["close", "escape"]) {
    if (dialogAfter("buy", { type }) !== null) fail(type + " did not close the dialog");
  }
  if (dialogAfter("buy", { type: "leave" }) !== null) fail("leaving the match did not close the dialog");
  if (dialogAfter("buy", { type: "refresh", room: false }) !== null) fail("a roomless refresh did not close the dialog");

  // Scroll and focus survive the redraw.
  const view = keepView(137, "button:infantry 10b");
  if (view.scrollTop !== 137) fail("the scroll position was not kept: " + view.scrollTop);
  if (view.focusKey !== "button:infantry 10b") fail("the focused control was not kept: " + view.focusKey);
  const fake = { tagName: "BUTTON", textContent: " infantry 10b ", dataset: {} };
  if (focusKeyOf(fake) !== "button:infantry 10b") fail("focusKeyOf produced " + focusKeyOf(fake));

  // The page applies that policy rather than its own copy of it.
  const app = await (await fetch(ctx.base + "/app.js")).text();
  for (const call of ["dialogAfter(openDialogId", "keepView(body.scrollTop", "focusKeyOf(document.activeElement)"]) {
    if (!app.includes(call)) fail("app.js does not use " + call);
  }
  // Esc and the close button are still the exits.
  if (!app.includes('event.key === "Escape" && openDialogId')) fail("Esc is no longer wired to close the dialog");
  if (!app.includes('getElementById("dialogClose")?.addEventListener("click", closeDialog)')) {
    fail("the close button is no longer wired");
  }

  console.log("dialog_persistence: 30 refreshes kept Buy open with scroll 137 and focus kept");
}
