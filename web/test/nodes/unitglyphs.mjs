// Node unitglyphs: a bought unit looks like itself, and the strip can end a game.
//
// The original drew one block for every unit on the map and told them apart in the unit monitor. This
// page has no monitor, so each kind gets a silhouette on the board, and the Buy table draws that same
// badge beside the name (T-014). These assertions pin the retired five-cell glyph module, the seam
// wrap, the wire form, and that Buy reaches for the badge and not the glyph.
import { GLYPH_KINDS, GLYPH_MIN_ZOOM, GLYPH_SIZE, GLYPHS, glyphCells, glyphDataUrl, glyphFor } from "../../public/glyphs.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

export const name = "unitglyphs";

export async function run(ctx) {
  eq("a glyph is five cells wide", GLYPH_SIZE, 5);
  eq("a glyph is drawn from two pixels per cell", GLYPH_MIN_ZOOM, 2);
  eq("every unit the shop sells has a glyph", GLYPH_KINDS, ["infantry", "tank", "aircraft", "cruiser", "carrier", "submarine"]);

  // --- every glyph is a full square of rows, and no two are the same shape ---
  const shapes = new Set();
  for (const kind of GLYPH_KINDS) {
    const rows = GLYPHS[kind];
    eq(kind + " has five rows", rows.length, GLYPH_SIZE);
    for (const row of rows) eq(kind + " row width", row.length, GLYPH_SIZE);
    if (!rows.join("").includes("1")) fail(kind + " is empty");
    shapes.add(rows.join("|"));
  }
  eq("no two kinds draw the same silhouette", shapes.size, GLYPH_KINDS.length);

  // --- cells: centred, wrapped, and only the lit ones ------------------------
  const tank = glyphCells(100, 60, "tank", 320);
  eq("the tank's cell count is its bitmap's", tank.length, GLYPHS.tank.join("").split("1").length - 1);
  const hull = tank.filter((c) => c.dy === 1).map((c) => c.dx).sort((a, b) => a - b);
  eq("the tank's hull is the full five cells wide", hull, [-2, -1, 0, 1, 2]);
  const head = tank.filter((c) => c.dy === -2).map((c) => c.dx);
  eq("the tank is one cell wide at the barrel", head, [0]);

  const seam = glyphCells(0, 10, "cruiser", 320);
  for (const cell of seam) {
    if (cell.x < 0 || cell.x >= 320) fail("a wrapped glyph cell left the board at " + cell.x);
  }
  if (!seam.some((c) => c.x === 319)) fail("a glyph on the seam did not wrap into the last column");
  if (!seam.some((c) => c.x === 0)) fail("a glyph on the seam lost its own column");

  // --- an untyped opening piece has no glyph, and says so by having none ----
  eq("no glyph for an untyped piece", glyphFor(null), null);
  eq("no cells for an untyped piece", glyphCells(10, 10, null, 320), []);

  // --- the buy table's icon is a self-contained data URL --------------------
  const url = glyphDataUrl("infantry");
  if (!url.startsWith("data:image/svg+xml")) fail("the icon is not an inline SVG: " + url.slice(0, 40));
  if (!/viewBox="0 0 5 5"/.test(decodeURIComponent(url))) fail("the icon has no 5x5 viewBox");

  // --- the page offers the four buttons, and asks the server -----------------
  const page = await (await fetch(ctx.base + "/")).text();
  for (const id of ["clockBtn", "resignBtn", "newBtn", "quitBtn"]) {
    if (!page.includes('id="' + id + '"')) fail("the strip has no " + id);
  }
  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes('op: "resign"')) fail("the page never sends a resign");
  if (!app.includes('op: "newgame"')) fail("the page never sends a new game");
  if (!app.includes('op: "quit"')) fail("the page never sends a quit");
  if (!app.includes("badgeSvg")) fail("the buy table does not draw the unit badge");
  if (app.includes("glyphDataUrl")) fail("the buy table still falls back to the five-cell glyph");
}
