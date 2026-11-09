// The page's shell: the narrow strip the navigation collapses into once a match starts, and the
// full-screen map box under it.
//
// These live in a module rather than in app.js for the same reason the camera and the chrome do:
// the numbers are asserted by a test, so "the map fills the screen" and "the strip is one row" are
// claims the suite checks instead of claims a screenshot hopes for.
//
// Nothing here touches the DOM. app.js reads the boxes off the page and asks this module what to do
// with them.

export const BOARD_W = 320;
export const BOARD_H = 136;

// The strip is one row of text and buttons. It is measured in CSS pixels and the page's reserved
// band at the top of the viewport while a match is up.
export const STRIP_HEIGHT = 34;

// A whole number of CSS pixels per cell, and never more than this: past a dozen the world is bigger
// than any screen anyone plays on, and the arithmetic stops being about filling the screen.
export const MAX_CELLS = 12;

// The largest whole-pixel cell scale that fits both the width and the height it is given. The map
// has to fill the screen *and* fit it: taking the width alone is how a 136-row board overflowed a
// short window and the bottom of the world ended up below the fold.
export function fitCells(availW, availH, opts = {}) {
  const boardW = Number(opts.boardW) > 0 ? Number(opts.boardW) : BOARD_W;
  const boardH = Number(opts.boardH) > 0 ? Number(opts.boardH) : BOARD_H;
  const maxCells = Number(opts.maxCells) > 0 ? Number(opts.maxCells) : MAX_CELLS;
  const across = Math.floor(Math.max(0, Number(availW) || 0) / boardW);
  const down = Math.floor(Math.max(0, Number(availH) || 0) / boardH);
  return Math.max(1, Math.min(maxCells, Math.min(across, down)));
}

// What the strip says while a match is up: who you are, what war this is, where the clock is.
// Empty without a match, which is what tells the page to show the full header instead.
export function stripInfo(room) {
  if (!room) return "";
  const era = String(room.era) === "9999" ? "Concealed" : String(room.era || "");
  const side = room.you || (room.seat && room.seat.side) || "";
  const parts = [];
  if (era) parts.push(era);
  if (side) parts.push(side);
  if (room.round !== undefined && room.round !== null) parts.push("round " + room.round);
  if (room.clock) parts.push(room.clock);
  if (room.over) parts.push(room.winner ? room.winner + " won" : "over");
  return parts.join(" · ");
}

// The debug window's rows, as [label, value] pairs. Pure so the test can assert them, and written
// to describe only what the page has actually been told: the socket's state, the board payload's
// own provenance, the room's own fields.
export function debugRows(state = {}) {
  const room = state.room || null;
  const seat = room && room.seat ? room.seat : null;
  const board = state.board || null;
  const camera = state.camera || null;
  const rows = [];
  rows.push(["who", state.me || "—"]);
  rows.push(["socket", state.socket || "—"]);
  rows.push(["board", board
    ? String(board.source || "?") + " " + (board.width || "?") + "×" + (board.height || "?") +
      (board.cells ? " · " + board.cells + " cells" : "")
    : "—"]);
  rows.push(["room", room ? String(room.id || "?") : "none"]);
  rows.push(["era", room ? String(room.era) : "—"]);
  rows.push(["side", room ? String(room.you || (seat && seat.side) || "—") : "—"]);
  rows.push(["round", room && room.round !== undefined ? String(room.round) : "—"]);
  rows.push(["clock", room ? String(room.clock || "—") : "—"]);
  rows.push(["pieces", room && Array.isArray(room.pieces) ? String(room.pieces.length) : "—"]);
  rows.push(["sites", room && Array.isArray(room.sites) ? String(room.sites.length) : "—"]);
  rows.push(["cash", seat && Number.isFinite(seat.cash) ? String(seat.cash) : "—"]);
  rows.push(["camera", camera
    ? String(camera.scale) + " px/cell" + (camera.follow ? " · following" : " · free")
    : "—"]);
  // Owner-only: the server attaches these to the room for the review account and for nobody
  // else, so a normal player's debug window stays fog-safe.
  const actions = room && Array.isArray(room.botActions) ? room.botActions.slice(-10) : [];
  for (const action of actions) {
    const round = action && action.round !== undefined ? "r" + action.round : "r?";
    if (!action) continue;
    if (action.type === "buy") {
      rows.push(["bot " + round, "buy " + String(action.kind || "unit") + " at " +
        (action.at ? action.at.x + "," + action.at.y : "?")]);
    } else if (action.type === "order") {
      rows.push(["bot " + round, "order " + String(action.piece || "piece") + " -> " +
        (action.to ? action.to.x + "," + action.to.y : "?")]);
    }
  }
  return rows;
}
