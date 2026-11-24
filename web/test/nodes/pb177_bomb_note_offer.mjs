// PB-177 — the board note may not offer an order that has already gone, and both Bomb doors must
// hand the player the same sentence.
//
// What breaks if this node is removed: the note is a one-line string built from page-local state, so
// nothing else in the suite sees it. Two defects lived here at b5d02f1 and neither was a rendering
// bug — the state was simply never dropped:
//   1. a MISSION order answers {op:"ack"} (main.mjs:330), not {op:"ordered"}, and the ack branch
//      never cleared the hover preview, so the note kept reading "Route: N rounds. Click to send the
//      order." over a cell whose order had already gone, until the pointer moved;
//   2. a refusal left the same offer up: the client-side circle refusal returned with the preview
//      intact, and a route reply still in flight could restore it after a server refusal.
// Both are now keyed off one string (hoverOfferKey) and one predicate (hoverOffersOrder), which is
// what this file pins: the pure helpers behave, the note re-derives, and both doors read the radius
// from the same function instead of carrying a literal each.
import { bombArmText, hoverOfferKey, hoverOffersOrder, previewLine, selectionNote } from "../../public/command.mjs";

export const name = "pb177_bomb_note_offer";

function eq(fail, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

function ok(fail, label, value) {
  if (!value) fail(label);
}

export async function run(ctx) {
  const { fail, base } = ctx;

  // ---- 1. one Bomb sentence, built from the briefing's own radius -------------------------
  eq(fail, "the armed Bomb sentence names the radius",
    bombArmText(6),
    "Bomb: pick an empty enemy city, base, oil field or capital inside the restricted air radius (6 cells).");
  ok(fail, "a mission sentence has no invented radius", bombArmText(undefined).includes("(? cells)"));
  ok(fail, "a zero or negative radius is not printed as a number",
    bombArmText(0).includes("(? cells)") && bombArmText(-4).includes("(? cells)"));

  // The two doors, as served: exactly two call sites, and no copy of the radius-less literal left.
  const app = await (await fetch(base + "/app.js")).text();
  eq(fail, "both Bomb doors read the one sentence", (app.match(/bombArmText\(/g) || []).length, 2);
  eq(fail, "the Kit door no longer carries a radius-less Bomb sentence",
    (app.match(/"Bomb: pick an empty enemy city, base, oil field or capital\."/g) || []).length, 0);
  eq(fail, "neither door hand-builds the radius sentence any more",
    (app.match(/"Bomb: pick an empty enemy city, base, oil field or capital inside the restricted air radius \("/g) || []).length, 0);

  // ---- 2. the offer key and the refusal test ---------------------------------------------
  eq(fail, "the hover key is one string per destination", hoverOfferKey("blue:land", { x: 80, y: 44 }), "blue:land:80,44");
  eq(fail, "no piece or no cell is no offer", hoverOfferKey(null, { x: 1, y: 1 }) + "|" + hoverOfferKey("p", null), "|");
  ok(fail, "a refused cell offers no order", hoverOffersOrder("p:1,1", "p:1,1") === false);
  ok(fail, "another cell still offers its own order", hoverOffersOrder("p:1,2", "p:1,1") === true);
  ok(fail, "with nothing refused every hovered cell offers", hoverOffersOrder("p:1,1", "") === true);
  ok(fail, "an empty key never offers", hoverOffersOrder("", "") !== true);

  // ---- 3. the note re-derives instead of repeating a spent offer -------------------------
  ok(fail, "a live hover speaks in the note", previewLine({ rounds: 3, path: [] }).includes("Click to send the order"));
  eq(fail, "no preview is no route line", previewLine(null), "");
  const piece = { id: "blue:land", kind: "infantry" };
  const derived = previewLine(null) || selectionNote(piece);
  ok(fail, "after a send or a refusal the note stops offering an order", !/Click to send the order/.test(derived));
  ok(fail, "and it still says which piece is selected", derived.includes("selected"));

  // ---- 4. the page keeps both halves wired ------------------------------------------------
  // Structural on purpose: the two defects above were both "the state was never dropped", so a
  // refactor that deletes the drop reds here rather than only on a live page.
  ok(fail, "the ack path drops the spent offer", /if \(preview\) dropHover\(\);/.test(app));
  ok(fail, "a refusal remembers the refused cell by key", /refusedHover = hoverOfferKey\(selected\.id, cell\);/.test(app));
  ok(fail, "a refusal from the server remembers its cell too", /refusedHover = hoverKey \|\|/.test(app));
  ok(fail, "a route reply for a refused cell is dropped",
    /if \(!hoverOffersOrder\(hoverOfferKey\(selected\.id, message\.to\), refusedHover\)\) return;/.test(app));
  ok(fail, "a fresh selection forgets the refusal", /refusedHover = "";/.test(app));
}
