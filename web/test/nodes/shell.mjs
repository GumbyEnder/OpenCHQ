// Node shell: the top strip a match collapses into, the full-screen map box, and the debug window.
//
// The layout itself is CSS, so what is asserted here is the arithmetic behind it (a whole number of
// cells that fits BOTH the window's width and its height), the words the strip carries, the rows the
// debug window shows, and - over the served page - that the pieces those depend on actually ship:
// the strip, the hidden-by-default debug panel, and the in-match rules in the stylesheet.
import { BOARD_H, BOARD_W, STRIP_HEIGHT, debugRows, fitCells, stripInfo } from "../../public/shell.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}

export const name = "shell";

export async function run(ctx) {
  // --- the map fills the screen, and fits it ---------------------------------
  eq("the board is the original's", BOARD_W + "x" + BOARD_H, "320x136");
  eq("the strip is one row", STRIP_HEIGHT, 34);

  // A 1440x900 window: the width allows four cells, the height five, so the width binds.
  eq("1440x900 fills four cells across", fitCells(1432, 720), 4);
  // A short window binds on height instead: 1900 wide but 300 tall fits two rows of 136.
  eq("a short window binds on height", fitCells(1900, 300), 2);
  // A tall narrow phone binds on width.
  eq("a narrow window binds on width", fitCells(300, 2000), 1);
  // Nothing is ever zero cells, and the ceiling holds.
  eq("no space is still one cell", fitCells(0, 0), 1);
  eq("a huge window is capped", fitCells(20000, 20000), 12);
  // The fit is whole cells, never a fraction: the map is one pixel per cell.
  for (const [w, h] of [[1100, 500], [1600, 900], [801, 449], [2560, 1440]]) {
    const cells = fitCells(w, h);
    if (!Number.isInteger(cells)) fail("fitCells(" + w + "," + h + ") is not whole: " + cells);
    if (cells * BOARD_W > w) fail("fitCells(" + w + "," + h + ") overflows the width at " + cells);
    if (cells * BOARD_H > h) fail("fitCells(" + w + "," + h + ") overflows the height at " + cells);
  }

  // --- what the strip says ---------------------------------------------------
  eq("no match, no strip line", stripInfo(null), "");
  const room = { era: 1986, you: "blue", round: 12, clock: "running" };
  eq("the strip carries era, side, round and clock", stripInfo(room), "1986 · blue · round 12 · running");
  eq("the concealed era is named in words", stripInfo({ era: 9999, you: "red", round: 1, clock: "held" }),
    "Concealed · red · round 1 · held");
  eq("a finished match says who won", stripInfo({ era: 1918, you: "blue", round: 259, clock: "held", over: true, winner: "red" }),
    "1918 · blue · round 259 · held · red won");

  // --- what the debug window reports ----------------------------------------
  const empty = debugRows({});
  eq("the debug window always has rows", empty.length > 0, true);
  for (const row of empty) {
    if (!Array.isArray(row) || row.length !== 2) fail("a debug row is not [label, value]: " + JSON.stringify(row));
  }
  const idle = Object.fromEntries(empty);
  eq("no room reads as none", idle.room, "none");
  eq("no seat reads as unknown", idle.side, "—");
  eq("no board reads as unknown", idle.board, "—");

  const live = Object.fromEntries(debugRows({
    me: "shane@veanox.com",
    socket: "open",
    board: { source: "bundled", width: 320, height: 136, cells: 43520 },
    room: { id: "room-1", era: 1986, you: "blue", round: 42, clock: "running", pieces: [{}, {}, {}], sites: [{}, {}], seat: { side: "blue", cash: 120 } },
    camera: { scale: 4, follow: true },
  }));
  eq("the socket state is reported", live.socket, "open");
  eq("the board's provenance is reported", live.board, "bundled 320×136 · 43520 cells");
  eq("the room id is reported", live.room, "room-1");
  eq("the round is reported", live.round, "42");
  eq("the seat side is reported", live.side, "blue");
  eq("the purse is reported", live.cash, "120");
  eq("the piece count is reported", live.pieces, "3");
  eq("the camera is reported in cells, not backing pixels", live.camera, "4 px/cell · following");

  // --- what the page actually ships -----------------------------------------
  const html = await (await fetch(ctx.base + "/")).text();
  for (const id of ["strip", "stripInfo", "debugToggle", "debugPanel", "debugRows", "debugWire", "mapStage", "lobby"]) {
    if (!html.includes('id="' + id + '"')) fail("the served page has no #" + id);
  }
  // Closed by default is the requirement, and it has to be true in the markup, not only in script.
  if (!/id="debugPanel"[^>]*class="debugpanel hidden"/.test(html)) {
    fail("the debug panel is not hidden by default in the markup");
  }

  const css = await (await fetch(ctx.base + "/app.css")).text();
  if (!css.includes("body.in-match")) fail("the stylesheet has no in-match shell");
  if (!/body\.in-match #strip\s*\{[^}]*position:\s*fixed/.test(css)) {
    fail("the strip is not pinned to the top in a match");
  }
  if (!/body\.in-match #lobby\s*\{\s*display:\s*none/.test(css)) {
    fail("the lobby is not put away in a match");
  }

  const app = await (await fetch(ctx.base + "/app.js")).text();
  if (!app.includes("./shell.mjs")) fail("app.js does not use the shell module");
  if (!app.includes('classList.toggle("in-match"')) fail("app.js never switches the match shell on");
}
