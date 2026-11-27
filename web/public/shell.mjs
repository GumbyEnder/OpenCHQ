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
//
// PB-173: the pieces come back as objects, not as one string, because ONE of them — the clock word —
// has to be laid out in a slot of its own. "running" (7), "paused" (6) and "held" (4) are three
// different widths, and the strip is a flex row: the word alone moved the speed control 10.65 px
// left on a Pause press, which is a button that walks out from under the pointer. The slot is CSS;
// the split is here so it can exist without app.js parsing a sentence apart.
// PB-323b: the strip is one row of a fixed height, and its budget is smaller than the widest
// sentence it can print. Measured on 30a4275: the 1986 cold-war line
// "1986 · blue · round 0 · held · cold war, war may resume" is 318.88 px of text and the box is
// 297 px at 1280x800 and 268.5 px at 1024x768, so the last clause is cut mid-word. PB-323 fixed the
// 1942 line only, because its page leg launched 1942 only.
//
// The card rule (PM 10334 §2) for the PAINTED readout:
//   - era, side, "round N" and the clock word are always painted in full;
//   - cold war paints "cold war" at every width; the title carries ", war may resume";
//   - cease-fire over 1100 px paints the count ("cease-fire, 3 rounds left"); at 1100 px and below
//     it paints "cease-fire" and the count lives in the title (PB-245's counter, moved not dropped).
// `opts.width` selects that painted form. WITHOUT it this function returns the full sentence, which
// is what `stripInfo()` and every node pin that predates PB-323b read - the title is built from it.
//
// `opts.tier` is the safety ladder app.js walks when even the painted form does not fit: it may only
// shorten the suffix, never the head.
//   0  the card form
//   1  cease-fire over 1100: the count's unit goes ("3 rounds left" -> "3")
//   2  cease-fire over 1100: the count goes ("3" -> condition only)
//   3  over: the winner's capital detail goes
//   4  the peace copy goes entirely (emergency; the leg reds if a ruled state ever needs it)
export const STRIP_CEASEFIRE_WIDTH = 1100;
export const STRIP_TIER_MAX = 4;

// "blue" stays "blue": PM 10334 §2 makes the painted head mandatory in full. Kept as a named helper
// so no future tier can quietly reintroduce PB-323's "B".
function paintedSide(side) {
  return String(side);
}

// The peace portion. `width === null` is the full sentence (the title); otherwise the card rule.
function peaceText(peace, tier, width) {
  const left = Math.max(0, Math.trunc(Number(peace.remaining) || 0));
  const counter = left > 0 ? (left === 1 ? "1 round left" : left + " rounds left") : "";
  if (peace.coldWar) {
    if (tier >= 4) return "";
    if (width === null) return "cold war, " + (counter || "war may resume");
    return "cold war";
  }
  if (tier >= 4) return "";
  if (width !== null && width <= STRIP_CEASEFIRE_WIDTH) return "cease-fire";
  if (!counter) return width === null ? "cease-fire, war may resume" : "cease-fire";
  if (tier >= 2) return "cease-fire";
  if (tier >= 1) return "cease-fire, " + left;
  return "cease-fire, " + counter;
}

export function stripInfoParts(room, opts = {}) {
  if (!room) return [];
  const painted = opts.width !== undefined && opts.width !== null;
  const width = painted ? Number(opts.width) : null;
  const wanted = Number(opts.tier);
  const tier = Math.max(0, Math.min(STRIP_TIER_MAX, Number.isFinite(wanted) ? Math.trunc(wanted) : 0));
  const era = String(room.era) === "9999" ? "Concealed" : String(room.era || "");
  const side = room.you || (room.seat && room.seat.side) || "";
  // PB-311 (PM 10093 item 2): a layout sandbox is not a war. The peace block below is copy about a
  // war that is not running ("cold war, war may resume"), which the PM read on live 50758d6 in a
  // layout at both widths. Name the layout in the strip instead, so the reader is told what they are
  // looking at; era, side, round and the held clock are true there and stay.
  const layout = String(room.mode || "") === "layout";
  const parts = [];
  if (era) parts.push({ text: era });
  if (side) parts.push({ text: painted ? paintedSide(side) : side });
  if (layout) parts.push({ text: "layout" });
  if (room.round !== undefined && room.round !== null) parts.push({ text: "round " + room.round });
  if (room.clock) {
    // PB-142: speed 0 accepts orders and lets no time pass, and the server keeps the clock at
    // "running" for exactly that reason (lobby.mjs tickRooms skips the tick when speed is 0). So the
    // clock word alone is not the whole answer and the strip argued with the readout two pixels
    // away. Read the speed the room is at; a held clock is a different pause and keeps its word.
    // PB-323b: mandatory at every tier - no branch above or below may drop this part.
    const paused = room.clock === "running" && Number(room.speed) === 0;
    parts.push({ text: paused ? "paused" : room.clock, phase: true });
  }
  // PB-245 (manual printed p.31): "A counter in Monitor One tells you how much time remains in
  // mandatory peace; after that, either player can start the war by pressing Begin Hostilities/
  // Cease Fire" (p.32 War Status). This strip is the page's monitor row, so the counter rides it.
  const peace = room.peace;
  if (!layout && peace && peace.active) {
    const text = peaceText(peace, tier, width);
    if (text) parts.push({ text });
  }
  if (room.over) {
    // The reason belongs in the strip too: the round bar stops for a resignation and for a capital
    // win alike, and "blue won" alone is the same sentence for both.
    const last = room.result && room.result.lastCapital;
    const detail = last && last.name && tier < 3 ? " (" + last.name + ", round " + last.round + ")" : "";
    parts.push({ text: room.winner ? room.winner + " won" + detail : "over" });
  }
  return parts;
}

// The same line as one string, for the tests and for anything that only wants to read it.
// PB-323b: `opts` is the tier ladder's {tier}; omitted, this is the full sentence (tier 0).
export function stripInfo(room, opts = {}) {
  return stripInfoParts(room, opts).map((part) => part.text).join(" · ");
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
  // The last wheel notch exactly as this page hit-tested it (PB-148): the element the notch was
  // targeted at, the page's own client point, and the surface the gesture latched to. A wheel event
  // is hit-tested per notch, so a notch whose target is a panel never reaches the camera; this row
  // is what tells a hand check which of the two it got. Display-only, and absent until a notch.
  if (state.wheel) rows.push(["wheel", wheelText(state.wheel)]);
  // Where the pointer is and where the selection stands, both in board cells. A hand check that
  // cannot say which cell it is pointing at argues "the badge is on the wrong cell" from a
  // screenshot; these two rows make it a number both sides read off the same panel (PB-130).
  rows.push(["pointer", cellText(state.pointer) || "—"]);
  const picked = state.selected || null;
  rows.push(["selected", picked ? String(picked.id || "?") + " @ " + (cellText(picked) || "?") : "none"]);
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

// A cell as "x,y". Whole numbers only: a pointer outside the board and a piece with no stored
// position both read as unknown rather than as a plausible 0,0.
function cellText(target) {
  if (!target) return "";
  const x = Number(target.x);
  const y = Number(target.y);
  return Number.isInteger(x) && Number.isInteger(y) ? x + "," + y : "";
}

// The last wheel notch on one line: "<target> <clientX,clientY> <latched surface>". The target is
// the element's id when it has one (a panel's `dialogTitle`) and its tag name otherwise (`LI`), which
// is how a browser reports it and how a hand check names it. A notch that carried no point reads
// `?,?` rather than an invented 0,0, and a gesture with no surface yet reads an em dash.
function wheelText(notch) {
  if (!notch) return "";
  const target = notch.target ? String(notch.target) : "?";
  const x = Math.round(Number(notch.x));
  const y = Math.round(Number(notch.y));
  const at = Number.isFinite(x) && Number.isFinite(y) ? x + "," + y : "?,?";
  const surface = notch.surface ? String(notch.surface) : "—";
  return target + " " + at + " " + surface;
}

