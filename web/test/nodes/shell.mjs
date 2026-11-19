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
  // PB-142: speed 0 stops time without holding the clock, so the clock word alone is not the whole
  // answer. The strip has to read the speed the room is at, or it argues with the readout two
  // pixels away. The held clock is a different pause and keeps its own word.
  eq("speed 0 reads as paused while the clock still runs",
    stripInfo({ era: 1942, you: "blue", round: 5, clock: "running", speed: 0 }),
    "1942 · blue · round 5 · paused");
  eq("a held clock stays held at speed 0", stripInfo({ era: 1942, you: "blue", round: 5, clock: "held", speed: 0 }),
    "1942 · blue · round 5 · held");
  eq("speed 1 keeps reading running at the same clock",
    stripInfo({ era: 1942, you: "blue", round: 5, clock: "running", speed: 1 }),
    "1942 · blue · round 5 · running");

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

  // --- the pointer and the selection, as cells (PB-130) ----------------------
  // A hand check that cannot name the cell under the pointer argues "the badge is on the wrong
  // cell" from a screenshot. These two rows are the shared number: board cells, not pixels.
  eq("an empty map has no pointer cell", idle.pointer, "—");
  eq("nothing selected reads as none", idle.selected, "none");
  const aimed = Object.fromEntries(debugRows({
    pointer: { x: 118, y: 64 },
    selected: { id: "blue-tank-2", x: 117, y: 65 },
  }));
  eq("the hovered cell is reported", aimed.pointer, "118,64");
  eq("the selected unit's cell is reported", aimed.selected, "blue-tank-2 @ 117,65");
  // A position that is not a whole cell is unknown, not a plausible-looking 0,0.
  const unplaced = Object.fromEntries(debugRows({
    pointer: { x: 12.5, y: 4 },
    selected: { id: "blue-inf-1" },
  }));
  eq("a fractional pointer is unknown", unplaced.pointer, "—");
  eq("a unit with no cell reads as unknown", unplaced.selected, "blue-inf-1 @ ?");

  // --- the last wheel notch, exactly as the page hit-tested it (PB-148) -------
  // A hand check that sees the camera move needs to know whether the notch that moved it was
  // targeted at the canvas or at a panel: a wheel event is hit-tested per notch, so a notch whose
  // target is the panel cannot reach the camera handler. The row is the discriminator between a
  // code defect and an input-frame offset, so it reports the target, the page's own client point
  // and the surface the gesture latched to - in that order, on one line.
  eq("no notch yet, no wheel row", idle.wheel, undefined);
  const panelNotch = Object.fromEntries(debugRows({
    wheel: { target: "LI", x: 957, y: 300, surface: "panel" },
  }));
  eq("a panel notch reports target, point and the latched surface", panelNotch.wheel, "LI 957,300 panel");
  const titleNotch = Object.fromEntries(debugRows({
    wheel: { target: "dialogTitle", x: 739, y: 64, surface: "panel" },
  }));
  eq("a target id is reported by id", titleNotch.wheel, "dialogTitle 739,64 panel");
  const boardNotch = Object.fromEntries(debugRows({
    wheel: { target: "board", x: 640, y: 300, surface: "board" },
  }));
  eq("a board notch reports the board surface", boardNotch.wheel, "board 640,300 board");
  const unlatched = Object.fromEntries(debugRows({
    wheel: { target: "body", x: 1, y: 2, surface: "" },
  }));
  eq("a notch with no latched surface reads as unknown", unlatched.wheel, "body 1,2 —");
  const noPoint = Object.fromEntries(debugRows({
    wheel: { target: "LI", surface: "panel" },
  }));
  eq("a notch with no point does not invent 0,0", noPoint.wheel, "LI ?,? panel");

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
  // PB-130: the rows have to be fed from the live page, not only exist in the module.
  if (!app.includes("pointer: pointerCell")) fail("app.js never feeds the hovered cell to the debug window");
  if (!/pointerCell\s*=\s*cell \?/.test(app)) fail("app.js never tracks the pointer's cell");
}
