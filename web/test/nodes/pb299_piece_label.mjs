// PB-299: the Air panel's PLANE column names the plane, and nothing a player reads carries the
// wire id. This is the tree-level half of the pin (PM 9891 §4); the page half is
// tests/e2e/pb299-plane-label.mjs, which reads the rendered dialog through a real browser.
//
// The helper is exercised out of the served file rather than re-implemented here: if app.js stops
// carrying a label mapping, this node goes red on the file it actually ships.
import { readFileSync } from "node:fs";

export const name = "pb299_piece_label";

export async function run(ctx) {
  const { fail } = ctx;
  const src = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");

  // 1. the helper exists and is one function, not three ad-hoc rewrites.
  const from = src.indexOf("const PIECE_NOUNS");
  const to = src.indexOf("function cell(text)");
  if (from < 0 || to < 0 || to <= from) fail("pb299: app.js no longer carries PIECE_NOUNS/pieceLabel before cell()");
  const block = from >= 0 && to > from ? src.slice(from, to) : "";
  let label = null;
  try {
    label = new Function(block + "\nreturn pieceLabel;")();
  } catch (err) {
    fail("pb299: the label block does not evaluate: " + String(err && err.message || err));
  }
  if (typeof label !== "function") {
    fail("pb299: pieceLabel is not a function in app.js");
  } else {
    const cases = [
      ["blue:aircraft:1", "Aircraft 1"],
      ["red:aircraft:20", "Aircraft 20"],
      ["blue:infantry:12", "Infantry 12"],
      ["blue:carrier:3", "Carrier 3"],
    ];
    for (const [id, want] of cases) {
      const got = label(id);
      if (got !== want) fail("pb299: pieceLabel(" + JSON.stringify(id) + ") = " + JSON.stringify(got) + ", wanted " + JSON.stringify(want));
    }
    if (/^\w+:\w+:\d+$/.test(label("blue:aircraft:1"))) fail("pb299: pieceLabel still returns a wire id for an aircraft");
  }

  // 2. the Air table's PLANE cell goes through it, and the wire id is kept on the element.
  if (!/const planeName = cell\(pieceLabel\(plane\.id\)\);/.test(src)) {
    fail("pb299: the Air table's PLANE cell is not built by pieceLabel(plane.id)");
  }
  if (!/planeName\.dataset\.piece = String\(plane\.id\);/.test(src)) {
    fail("pb299: the PLANE cell does not keep the wire id in data-piece (the page legs pin rows by it)");
  }

  // 3. no visible plane id is composed directly any more: neither a table cell nor the order toast.
  if (/cell\(plane\.id\)/.test(src)) fail("pb299: app.js still builds a cell from plane.id");
  if (/say\(plane\.id \+/.test(src)) fail("pb299: app.js still opens a toast with plane.id");
  if (/say\("(Loaded|Dropping) " \+ piece\.id/.test(src)) fail("pb299: a load/drop toast still opens with piece.id");

  console.log("pb299_piece_label: label mapping pinned off app.js, Air PLANE cell and toast go through it, wire id kept in data-piece");
}
