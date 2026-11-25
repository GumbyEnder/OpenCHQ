import {
  capitalMarkers, cellToPixel, centerOn, clampZoom, fitViewport, legendEntries, MIN_ZOOM, paintMatch,
  panBy, pixelToCell, paintPlacement, rememberSeen, routePolyline, routeSpan, sightTable, statusLine,
  wrapX, zoomAt, zoomStepBy, badgeAt, renderBadgeSprite,
} from "./render.mjs";
import { BADGE_MIN_PX, badgeHoverText, badgeLegendRows, badgeSvg } from "./badges.mjs";
import { THEMES, DEFAULT_THEME, isThemeId, nextThemeId, resolveTheme, themeById } from "./themes.mjs";
import { createFlashLine } from "./flash.mjs";
import { unitLabel } from "./units.mjs";
import {
  PICK_HINT,
  ackText,
  airNote,
  alarmText,
  bombArmText,
  buyMessage,
  cargoNote,
  cellAtEvent,
  clickIntent,
  missionMessage,
  orderMessage,
  hoverOfferKey,
  hoverOffersOrder,
  ownPieceAt,
  previewLine,
  oilWarning,
  purseSummaryParts,
  purseText,
  refreshSelection,
  refusalGround,
  refusalLine,
  restrictedTargetRefusal,
  routeRequest,
  selectionNote,
  selectionToast,
  siteAtCell,
  siteInspectText,
  siteUnderPiece,
  snapPlacementCell,
} from "./command.mjs";
import { chromeGeometry, roundFraction, timeLeftText } from "./chrome.mjs";
import { scanAddPieces, scanKeepsAcrossRound, scanSpec, scanState } from "./scan.mjs";
import { fitScale, textBitmap, validateAtlas } from "./font.mjs";
// The shell: the strip a match collapses the navigation into, and the box the map may fill.
import { BOARD_H, BOARD_W, debugRows, fitCells, stripInfoParts } from "./shell.mjs";
// The navigation itself, and the two dialogues this page was missing: buying and the economy.
import { NAV, buyRows, economyModel, navFor, oilLine, reserveLine, untypedCount } from "./dialogs.mjs";
// T-031 step 3: the War Films replay. The pure view model lives in film.mjs so the node tests and the
// page toggle the same four shows (Show Red / Blue / Common / Both) with one implementation.
import {
  FILM_SHOWS,
  FILM_SPEED_LABELS,
  FILM_SHOW_LABELS,
  emptyFilm,
  filmEventRows,
  filmRoomAt,
  frameCount,
  frameDelayMs,
  nextSpeed,
  stepFilm,
  toggleShow,
} from "./film.mjs";
// The Log panel's buffer and scroll policy (PB-135): the panel paints every line the page retains
// and a mid-match resync merges instead of being dropped.
import {
  affordanceText,
  appendLog,
  emptyLog,
  isAtBottom,
  paintedLines,
  pendingAfterPaint,
  scrollAfterPaint,
} from "./logview.mjs";
// The buy table's icon is the board's own badge, drawn by the same badgeSvg as the legend, so a
// player picks a unit by the shape they will see on the map. (T-014 gate, room 4035.)
import { dialogAfter, focusKeyOf, keepView } from "./dialogstate.mjs";
import { formatBillions, formatWholeBillions, nextDoorMode, purchaseText } from "./command.mjs";
import { createLateOrders, createOrderWatch, queuedText } from "./orderwatch.mjs";
// How long the page waits to reconnect, and how long one attempt may hang before it is a failure.
// Both numbers are bounded so a 10 s outage cannot cost a minute (PB-025).
import {
  CONNECT_TIMEOUT_MS,
  RECONNECT_TRIES,
  backoffMs,
} from "./reconnect.mjs";

const gate = document.querySelector("#gate");
const play = document.querySelector("#play");
const account = document.querySelector("#account");
const people = document.querySelector("#people");
const invites = document.querySelector("#invites");
const roomBox = document.querySelector("#room");
const flash = document.querySelector("#flash");
// PB-137: the match result has its own line. It is not a flash and never expires under the player,
// so `say()` writes only #flash and `sayResult()` writes only #result.
const resultLine = document.querySelector("#result");
const flashLine = createFlashLine({ element: flash, resultElement: resultLine });
const board = document.querySelector("#board");
const boardNote = document.querySelector("#boardNote");
const alarmStrip = document.querySelector("#alarm");
const legendBox = document.querySelector("#legend");

let socket = null;
// A deploy closes the socket on purpose. The page reconnects on its own rather than leaving the
// player looking at "connection closed" and a paused match.
let reconnectTimer = null;
let reconnectTries = 0;
let wasReconnecting = false;
// The server said it is restarting (op "bye", sent by the drain on SIGTERM). The next close is
// expected and is retried immediately rather than treated as a dead network.
let serverRestarting = false;
// The server's "another tab took this session" close code. This page does not reconnect after
// it: two tabs trading one socket is a toast loop, not a connection.
const TAKEOVER_CODE = 4001;
let replaced = false;
function standDown(reason) {
  if (replaced) return;
  replaced = true;
  socketState = "replaced";
  renderDebug();
  say(reason || "This session was opened in another tab. This tab is no longer connected.");
}
// An order stays pending until the server answers it, and its id makes a resend safe: the server
// applies one id at most once and answers a second copy with an ack. Before this the page removed an
// order from the queue the moment it was written, so an order written into a socket that was already
// dying was never resent and its confirmation was never seen (PB-025's drop leg: the piece landed and
// the page still said nothing). Each entry remembers the room it belongs to, so a reconnect into a
// new match cannot replay a stale purchase.
let orderSeq = 0;
let orderQueue = [];
// An order that gets no ack is not "sent": after ~2 s the page says so. The order is still
// queued and resent, and the server applies one id at most once.
// PB-169: remember WHICH order went unanswered, so its answer can take the line back down. The
// sentence is a warning about one order; leaving it up after the answer arrives tells the player the
// opposite of what just happened.
const lateOrders = createLateOrders(queuedText);
const orderWatch = createOrderWatch({ onLate: (order) => say(lateOrders.note(order)) });
function sendOrder(payload) {
  const message = { ...payload, id: "o" + Date.now().toString(36) + "-" + (++orderSeq) };
  orderQueue.push({ roomId: room && room.id ? String(room.id) : "", message });
  // Long enough for a person's clicks, short enough that a stuck order cannot grow for ever.
  while (orderQueue.length > 40) orderQueue.shift();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  } else {
    say("Connection is down. Your order is queued and will be sent when it returns.");
  }
  // Watch every order, connected or not: a socket can be open and still not deliver.
  orderWatch.watch(message);
  return message;
}
function settleOrder(id) {
  if (id === undefined || id === null) return;
  orderWatch.settle(id);
  const lateLine = lateOrders.settle(id);
  // Only the line THIS order wrote comes down: a newer, unrelated flash stays, and a line that has
  // already timed out clears nothing.
  if (lateLine && flashLine.text() === lateLine) flashLine.clear();
  orderQueue = orderQueue.filter((entry) => entry.message.id !== id);
}
function flushOrders() {
  if (!orderQueue.length || !socket || socket.readyState !== WebSocket.OPEN) return;
  const current = room && room.id ? String(room.id) : "";
  if (current) orderQueue = orderQueue.filter((entry) => !entry.roomId || entry.roomId === current);
  for (const entry of orderQueue) socket.send(JSON.stringify(entry.message));
}
let me = "";
let users = [];
let pending = [];
let room = null;
// Click-to-command: the selected own piece, and the server's plan for the cell the pointer
// is over. The page never invents a route; `preview` is the reply to `op: "route"`.
let selected = null;
// The selected mark breathes. A still frame always carries the ring (casing + accent), so the mark
// does not depend on where the pulse happens to be when a screenshot is taken (T-030 AC1).
let selectPulse = 0;
let selectPulseTimer = null;
function startSelectionPulse() {
  if (selectPulseTimer) return;
  selectPulseTimer = setInterval(() => {
    if (!selected) {
      clearInterval(selectPulseTimer);
      selectPulseTimer = null;
      selectPulse = 0;
      drawMatch();
      return;
    }
    selectPulse = (selectPulse + 0.16) % 1;
    drawMatch();
  }, 90);
}
let preview = null;
// PB-177: the destination the server (or the page's own circle test) has just refused. A reply that
// was already in flight for that cell, and a fresh hover of it, must not put "Click to send the
// order." back on the board note: a refused target offers no order. Cleared when another cell is
// hovered or the selection changes.
let refusedHover = "";

// PB-177: an answered order is a spent offer, so the note has to re-derive rather than keep reading
// the route that used to be under the pointer. Both the ack path and the two refusal paths call this;
// nothing here writes element text, so the result line (PB-137 AC4) stays out of its reach.
function dropHover() {
  preview = null;
  hoverKey = "";
  drawMatch();
}
// The intel scan's sweep (T-022, Q51). `intelIds` are the enemy pieces that are on the board only
// because the scan revealed them: those are bar-local, everything else is untouched. The pass runs
// once per use, at the original's measured speed, and the round's server-side reveal is hidden
// again once the bar has left the board -- the capture shows no persistence past the bar.
let scan = null;
let scanTimer = null;

function intelOnlyIds() {
  if (!room || !room.you || !Array.isArray(room.pieces)) return new Set();
  const width = Number(boardPayload.width) || BOARD_W;
  const sight = Number(boardPayload.sightCells || 8);
  const lit = sightTable(boardPayload, room.pieces.filter((piece) => piece.side === room.you), sight);
  const ids = new Set();
  for (const piece of room.pieces) {
    if (!piece || piece.side === room.you) continue;
    const cell = Math.trunc(Number(piece.y) || 0) * width + wrapX(piece.x, width);
    if (!lit[cell]) ids.add(piece.id);
  }
  return ids;
}

function stopIntelScan() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

function startIntelScan() {
  stopIntelScan();
  if (!room || !room.you) return;
  if (boardPayload && (boardPayload.source === "missing" || !Array.isArray(boardPayload.cells))) return;
  const boardW = Number(boardPayload.width) || BOARD_W;
  const intelIds = intelOnlyIds();
  scan = {
    startedAt: Date.now(),
    boardW,
    round: Number(room.round) || 0,
    side: room.you,
    intelIds,
    // The server's intel reveal lasts one round, but the pass lasts 15.85 s and spans rounds.
    // Keep the enemy list the reveal puts on the board, so the bar still has units to draw after
    // the next round message drops them (T-022, room 7650). The ack usually arrives before the
    // room that carries the reveal, so this is re-merged on every room message below.
    intelPieces: [],
  };
  scanAddPieces(scan, room.pieces, room.you);
  // A pass with nothing to reveal still greys the map: the original charges for the scan and shows
  // the sweep whether or not a unit is under it, and the opponent is told either way.
  const spec = scanSpec(boardW);
  const durationMs = ((spec.boardW + spec.barCells) / spec.cellsPerSecond) * 1000;
  drawMatch();
  scanTimer = setInterval(() => {
    if (!scan) return stopIntelScan();
    const state = scanState(scan.startedAt, Date.now(), scan.boardW);
    drawMatch();
    if (state.done && Date.now() - scan.startedAt >= durationMs) stopIntelScan();
  }, 50);
}
let hoverKey = "";
// The cell under the pointer, in board coordinates, or null when the pointer is off the map. Only
// the debug window reads it (PB-130): a hand check needs to say "cell 118,64" rather than argue
// about which pixel a badge sat on.
let pointerCell = null;
// The last /api/board payload. A missing extract is a normal state here: the
// hosted build never has one, and the page draws the schematic instead.
let boardPayload = {
  source: "missing",
  cells: null,
  width: 320,
  height: 136,
  capitals: null,
  terrain: [],
};

function say(text) {
  flashLine.say(text);
}

// The end of a match said once, in the player's own terms.
//
// The reason and the capital list come off the server's `result`, never off what this page can see:
// the page holds only the pieces in sight, so a list rebuilt here would be a second answer to "who
// holds Berlin" and could disagree with the board that ended the match. A resignation has no capital
// to name, and the server's own sentence is printed for it rather than a guessed cause.
function sayResult(room) {
  if (!room || !room.over) return;
  const mine = room.you || (room.seat && room.seat.side) || "";
  const result = room.result && typeof room.result === "object" ? room.result : null;
  const caps = result && Array.isArray(result.capitals) ? result.capitals : [];
  const list = caps.length
    ? " Capitals: " + caps.map((row) => row.name + " " + (row.owner || "neutral")).join(", ") + "."
    : "";
  // PB-137 AC4: the result is written to its own line, not to the flash. It stays there until the
  // player leaves the match; a later `say()` cannot overwrite or clear it.
  // PB-200: a cease fire ends the match with no winner, and the server's own sentence for it is the
  // `room.note` below - resultNote(): "The war ended by cease fire at round N. Neither side won." The
  // page does not write a second version of that sentence.
  if (result && result.reason === "capitals" && result.lastCapital && result.lastCapital.name) {
    const who = result.winner === mine
      ? "You win"
      : result.winner === "blue" ? "Blue wins" : result.winner === "red" ? "Red wins" : "The match is over";
    flashLine.result(who + ": " + result.lastCapital.name + " fell at round " + result.lastCapital.round + "." + list);
    return;
  }
  const note = typeof room.note === "string" ? room.note.trim() : "";
  if (note) {
    flashLine.result(note + list);
    return;
  }
  flashLine.result(room.winner && mine ? (room.winner === mine ? "You have won." : "You lost.") : "The match is over.");
}

function eraName(era) {
  return String(era) === "9999" ? "Concealed" : String(era);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// A request sent before the socket is up is kept, not refused. The page connects after /api/me
// answers, so a player who clicks "Play a bot" the instant the lobby paints used to get
// "The lobby is not connected" and had to click again (T-007 AC4). The queue is short on purpose:
// it holds what a person can press in the second before the socket opens, never a backlog.
let outbox = [];
function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return;
  }
  outbox.push(message);
  if (outbox.length > 20) outbox.shift();
  say("Connecting to the lobby - your request is queued and will be sent as soon as it answers.");
}

function flushOutbox() {
  if (!outbox.length || !socket || socket.readyState !== WebSocket.OPEN) return;
  const queued = outbox;
  outbox = [];
  for (const message of queued) socket.send(JSON.stringify(message));
}

// Canvas is sized to whole cells: 320x136 at scale 2 is 640x272. The camera zooms and pans on
// top of that fit; it starts at the fit and follows the selected piece.
let camera = null;
// True once the player zooms or pans: from then on the camera is theirs. Until then every resize
// and every frame recomputes the whole-world fit, which is what the original put on the screen.
let userCamera = false;
let fogSeen = null;
let fogKey = "";

// The canvas is the original screen's map area and nothing else: 320 cells wide by 136 tall, at the
// largest whole number of device pixels that fits the width it has. It used to take the width and a
// fixed share of the window height instead, which is how the world ended up a small island of
// terrain in a field of black - the fit then had to drop to one pixel a cell to make 136 rows fit a
// 270 px box, and the map stopped looking like the original's at all.
function dpr() {
  return Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
}

const SCREEN_W = BOARD_W;
const SCREEN_H = BOARD_H;

// The box the map may occupy. In a match that is what is left of the window after the strip, the
// monitor band and its own borders; before a match it is the panel's width and a sane share of the
// height. Measured, not remembered: the match layout is a flex column, so the stage's own rect is
// the only honest answer to "how much room is there".
function mapBox() {
  const stage = document.getElementById("mapStage");
  const band = document.getElementById("chrome");
  // PB-136: in a match the band's box is reserved from the first frame of the match (visibility, not
  // display), so the measured height IS the reserved height and the band arriving is a paint, never a
  // layout change. Out of a match the band is display:none and measures 0.
  const bandH = band ? Math.round(band.getBoundingClientRect().height) : 0;
  if (document.body.classList.contains("in-match") && stage) {
    const rect = stage.getBoundingClientRect();
    return {
      availW: Math.max(SCREEN_W, Math.floor(rect.width - 8)),
      availH: Math.max(SCREEN_H, Math.floor(rect.height - bandH - 8)),
    };
  }
  const width = board.parentElement ? board.parentElement.clientWidth : 640;
  return {
    availW: Math.max(SCREEN_W, Math.floor(width - 8)),
    availH: Math.max(SCREEN_H, Math.floor(window.innerHeight - 300)),
  };
}

function sizeCanvas() {
  const box = mapBox();
  // The original's screen is 320x200 with the map in the top 136 rows; the rest of the screen is the
  // monitor band, which is DOM here. So the canvas is exactly the map, at a whole-pixel cell - and
  // at the largest whole-pixel cell that fits both the width and the height, so a match fills the
  // window instead of leaving the world as an island in a field of black.
  const cellsAcross = fitCells(box.availW, box.availH);
  const w = Math.round(SCREEN_W * cellsAcross * dpr());
  const h = Math.round(SCREEN_H * cellsAcross * dpr());
  if (board.width !== w || board.height !== h) {
    board.width = w;
    board.height = h;
    // A resize is a new viewport. An untouched camera refits to the whole world; a camera the
    // player has zoomed keeps its zoom and stays on the same cell.
    const old = camera;
    if (!userCamera || !old) {
      camera = null;
      viewForCanvas();
    } else {
      const fit = fitViewport(board.width, board.height, boardPayload.width || 320, boardPayload.height || 136, 64);
      const midX = (old.left + old.viewW / 2) / old.scale;
      const midY = (old.top + old.viewH / 2) / old.scale;
      camera = { ...fit, scale: Math.max(fit.scale, MIN_ZOOM, Math.min(64, old.scale)) };
      camera.minScale = Math.max(MIN_ZOOM, fit.scale);
      camera.left = Math.round(camera.viewW / 2 - midX * camera.scale);
      camera.top = Math.round(camera.viewH / 2 - midY * camera.scale);
    }
  }
  // CSS size fills the box the shell gives it, at the board's aspect: the backing store stays a
  // whole number of device pixels per cell (crisp stems, deterministic camera) while the page shows
  // the map as large as the window allows. `image-rendering: pixelated` keeps the cells square.
  applyCanvasCss();
}

// The canvas's on-screen size on its own, because the monitor band appearing or going away changes
// the box the map may use and that happens after the paint, not before it.
function applyCanvasCss() {
  const box = mapBox();
  const fitW = Math.max(SCREEN_W, Math.min(box.availW, Math.round(box.availH * SCREEN_W / SCREEN_H)));
  board.style.width = Math.round(fitW) + "px";
  board.style.height = Math.round(fitW * SCREEN_H / SCREEN_W) + "px";
}

function viewForCanvas() {
  sizeCanvas();
  const canvas = board;
  const fit = fitViewport(canvas.width, canvas.height, boardPayload.width || 320, boardPayload.height || 136, 64);
  if (!userCamera || !camera) {
    // The default view is the whole world, as the original's was: the planet reads at a glance and
    // the zoom is for detail, not for finding the map.
    camera = { ...fit, scale: Math.max(MIN_ZOOM, fit.scale) };
  }
  // The whole-world fit is the camera's floor (PB-067): below it the board is a small island in the
  // margins and the seam copies of the route lines are drawn in the empty space beside it.
  camera.minScale = Math.max(MIN_ZOOM, fit.scale);
  return camera;
}

// Follow: the selected piece stays in the middle as the clock runs. It is OFF by default and only
// ever runs when the player armed it with the Follow button: a camera that moves because a unit was
// selected, or because a placement is pending, is the camera fighting the player (T-007 AC10).
let following = false;

// ---- map theme (T-019) ----------------------------------------------------------------------
// A per-player, client-side preference (D-022): cosmetic only, never match state, never sent to the
// server. A first load with nothing saved opens on the dark tactical theme; a saved id this build
// does not ship falls back to that default rather than to a blank board.
const THEME_KEY = "openchq.theme";
// D-022: an empty (or unreadable) localStorage opens on the dark tactical theme. `resolveTheme` is
// the same rule the node pin grades, so the page cannot drift from it.
let themeId = (() => {
  try {
    return resolveTheme(localStorage.getItem(THEME_KEY));
  } catch (err) {
    return resolveTheme(null);
  }
})();

function currentTheme() {
  return themeById(themeId);
}

function paintThemeControl() {
  const theme = currentTheme();
  const button = document.getElementById("themeToggle");
  if (button) {
    // The label names the theme that is ON, and the title names the one the click will switch to.
    // That is the opposite of the old ownership button, which named the view you would get while
    // the status line said something else (PB-063).
    button.textContent = "Map: " + theme.label;
    button.title = "Switch to " + themeById(nextThemeId(themeId)).label + " (T)";
  }
}

// One click, no reload, no gameplay change: the same room frame is repainted in the other theme.
function setTheme(next) {
  const id = String(next ?? "").toUpperCase();
  themeId = isThemeId(id) ? id : DEFAULT_THEME;
  try {
    localStorage.setItem(THEME_KEY, themeId);
  } catch (err) {
    // A private-mode page without storage still gets the switch; it just will not remember it.
  }
  paintThemeControl();
  drawMatch();
}

function cycleTheme() {
  setTheme(nextThemeId(themeId));
}

// Terrain is the original's map; ownership is the original's other view (manual printed p.32):
// countries filled in the owner's colour over the same grid, units still on top. The toggle only
// changes what is drawn under the units, never the camera or the board.
//
// PB-224 AC5 adds the original's third view (manual p.29 L924): "Show Satellites" draws the orbital
// picture - every satellite of BOTH sides with the circle it scans, and the insert box with its
// fuel. p.12 shows both satellites at once, so this view hides nothing the board did not already
// carry: the server ships both sides' satellites to both seats.
const VIEW_MODES = ["terrain", "political", "satellites"];
const VIEW_LABEL = { terrain: "Terrain", political: "Ownership", satellites: "Satellites" };
let viewMode = "terrain";

function setViewMode(next) {
  viewMode = VIEW_MODES.includes(next) ? next : "terrain";
  const button = document.getElementById("viewToggle");
  if (button) {
    button.classList.toggle("armed", viewMode !== "terrain");
    // PB-063: the label names the view that is ON, and the status line names the same thing.
    button.textContent = VIEW_LABEL[viewMode];
    button.setAttribute("aria-pressed", viewMode !== "terrain" ? "true" : "false");
    const order = VIEW_MODES[(VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length];
    button.title = viewMode === "terrain" ? "Showing terrain; click for who holds what (P)"
      : viewMode === "political" ? "Showing who holds what; click for satellites (P)"
        : "Showing satellites of both sides; click for terrain (P)";
    button.setAttribute("data-next", order);
  }
  drawMatch();
}

function cycleViewMode() {
  setViewMode(VIEW_MODES[(VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length]);
}

// PB-224: a satellite flies ABOVE the board, so the server keeps it in `room.satellites` and it
// never enters the ground piece list (it must not block a cell, capture a city or be shot at). The
// page paints and selects it like any other piece, so one merge feeds every reader.
function piecesOnScreen() {
  const ground = room && Array.isArray(room.pieces) ? room.pieces : [];
  const sats = room && Array.isArray(room.satellites) ? room.satellites : [];
  if (!sats.length) return ground;
  return ground.concat(sats.map((sat) => ({ ...sat, sat: true, strength: 1, maxStrength: 1 })));
}

let sawRoom = false;
// What the last frame actually painted (layers, fog rects, tally), for the E2E hook. The canvas is
// pixels; a shot script cannot read the fog count back out of them, so the painter's own return
// value rides here.
let lastPaint = null;

// Fit shows the whole world, which is what the original game put on the screen: one planet, all of
// it, with a click to zoom. It used to reset to the legible 8 px default, so "Fit" never fitted.
function refit() {
  userCamera = false;
  sizeCanvas();
  const fit = fitViewport(board.width, board.height, boardPayload.width || 320, boardPayload.height || 136, 64);
  camera = { ...fit, scale: Math.max(MIN_ZOOM, fit.scale), minScale: Math.max(MIN_ZOOM, fit.scale) };
  drawMatch();
}

// One key press is one whole cell of zoom (PB-066 follow-up): the press is a direction, not a
// factor, so '+' off the fit and '-' back down each move exactly one step and hold at the ends.
function zoomStep(direction) {
  userCamera = true;
  const view = viewForCanvas();
  camera = zoomStepBy(view, direction, view.viewW / 2, view.viewH / 2);
  drawMatch();
}

function setFollow(on) {
  following = Boolean(on);
  const button = document.getElementById("camFollow");
  if (button) button.setAttribute("aria-pressed", following ? "true" : "false");
  if (button) button.classList.toggle("armed", following);
  drawMatch();
}

// The sight table is rebuilt when the round or the seat's own pieces change, and the memory of
// what has been seen accumulates across rounds.
// Fog is the concealed scenario's rule, not the game's default. The original showed the whole
// earth and hid only the enemy's pieces, which the server's view already does: the map is a map,
// the enemy is a secret. Only the 9999 "Concealed" era darkens the ground itself.
function concealedEra() {
  const era = String((room && room.era) || (boardPayload && boardPayload.era) || "");
  return era === "9999";
}

function fogFor(view) {
  if (!concealedEra()) return null;
  if (!room || !Array.isArray(room.pieces)) return null;
  const sight = Number(boardPayload.sightCells || 8);
  const key = String(room.round) + "|" + room.pieces.map((piece) => piece.id + piece.x + "," + piece.y).join(";");
  if (key !== fogKey) {
    fogKey = key;
    const lit = sightTable(boardPayload, room.pieces.filter((piece) => piece.side === room.you), sight);
    fogSeen = rememberSeen(fogSeen, lit);
    fogKey = key;
    fogFor.lit = lit;
  }
  return { lit: fogFor.lit, seen: fogSeen };
}

// The unit legend: one row per type, the badge the board actually draws, both sides. Built from
// the same badgeSvg the mockup sheet used, so the legend cannot drift from the map.
function unitLegend() {
  const wrap = document.createElement("div");
  wrap.className = "badgelegend";
  const head = document.createElement("p");
  head.className = "dialogfoot";
  head.textContent = "On the board: one silhouette per type. Blue is a square frame, red has cut " +
    "corners, so the two sides differ without colour. The bar under a badge is its strength; the " +
    "disc is how many friendly units share that footprint.";
  wrap.append(head);
  for (const row of badgeLegendRows()) {
    if (row.side !== "blue") continue;
    const line = document.createElement("div");
    line.className = "badgerow";
    const blue = document.createElement("span");
    blue.innerHTML = badgeSvg({ kind: row.kind, side: "blue", px: 18, transport: row.transport, title: row.label + " blue" });
    const red = document.createElement("span");
    red.innerHTML = badgeSvg({ kind: row.kind, side: "red", px: 18, transport: row.transport, title: row.label + " red" });
    const name = document.createElement("span");
    name.className = "badgename";
    name.textContent = row.label;
    line.append(blue, red, name);
    wrap.append(line);
  }
  return wrap;
}

// The static half of a badge is one drawing per (kind, side, pixel size), so it is painted once into
// an offscreen canvas and blitted after that. Without this the zoomed view pays for ~15 path fills a
// unit every frame and comes out slower than the 3x3 blocks it replaced (measured: 1.24-1.39x the
// baseline at scale 11). The cache is bounded: twelve kinds, two sides, and the handful of sizes a
// camera produces.
const badgeSprites = (() => {
  const cache = new Map();
  return {
    get(kind, side, size, transport) {
      const px = Math.max(1, Math.ceil(Number(size) || BADGE_MIN_PX));
      const key = kind + "|" + side + "|" + px + "|" + (transport ? "t" : "k");
      let sprite = cache.get(key);
      if (sprite) return sprite;
      if (cache.size > 120) cache.clear();
      sprite = document.createElement("canvas");
      sprite.width = px;
      sprite.height = px;
      renderBadgeSprite(sprite.getContext("2d"), { kind, side, size: px, transport });
      cache.set(key, sprite);
      return sprite;
    },
  };
})();

function renderLegend() {
  if (!legendBox) return;
  legendBox.textContent = "";
  for (const entry of legendEntries(currentTheme(), { viewMode })) {
    const item = document.createElement("span");
    item.className = "swatch";
    const chip = document.createElement("i");
    chip.style.background = entry.color;
    const label = document.createElement("span");
    label.textContent = entry.label;
    item.append(chip, label);
    legendBox.append(item);
  }
  const side = room && room.you ? room.you : "";
  if (side) {
    const item = document.createElement("span");
    item.className = "swatch you";
    item.textContent = "you are " + side;
    legendBox.append(item);
  }
}

// Redraws the board and every piece the room view carries. Enemy pieces are
// only ever the ones the server put in `room.pieces`; nothing is inferred.
// The bottom band is the original's, sized from the map: 87/320 of the map width wide, 50/320 tall.
// The bar runs down with the round the server reports, so the clock stops being dead time.
let roundStartedAt = Date.now();
let paintedRound = -1;

// The original's lettering arrives from /api/fonts, which answers source "missing" on a host
// without the extract. That is not an error: the label falls back to the system font it has always
// used, and the bar keeps working either way.
let fontAtlas = null;
let fontAsked = false;

async function loadFontAtlas() {
  if (fontAsked) return;
  fontAsked = true;
  try {
    const res = await fetch("/api/fonts", { credentials: "same-origin" });
    const payload = await res.json();
    fontAtlas = validateAtlas(payload).ok ? payload : null;
  } catch {
    fontAtlas = null;
  }
  paintChrome(camera);
}

function drawChromeLabel(text, boxWidth) {
  const span = document.getElementById("timeLabel");
  const canvas = document.getElementById("timeLabelArt");
  if (!span || !canvas) return;
  if (!fontAtlas) {
    span.classList.remove("hidden");
    canvas.classList.add("hidden");
    span.textContent = text;
    return;
  }
  // Whole-pixel sizes only: an integer cell scale keeps a one-pixel stem one pixel wide.
  const scale = fitScale(fontAtlas, text, Math.max(8, boxWidth - 12));
  const bitmap = textBitmap(fontAtlas, text, scale);
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  for (let y = 0; y < bitmap.height; y++) {
    const row = bitmap.rows[y];
    for (let x = 0; x < bitmap.width; x++) {
      if (row[x] === "1") ctx.fillRect(x, y, 1, 1);
    }
  }
  canvas.classList.remove("hidden");
  span.classList.add("hidden");
}

function paintChrome(view) {
  const box = document.getElementById("timebox");
  const bar = document.getElementById("timeFill");
  const text = document.getElementById("timeText");
  const chrome = document.getElementById("chrome");
  if (!box || !bar || !text || !chrome) return;
  // PB-136: the band's 56 px are the stage's from the first frame of a match. Out of a match the band
  // is display:none; in a match it keeps its box and only its ink waits for the first round
  // (`.bandwait`), so the band arriving never resizes the stage or re-fits the camera under a pointer.
  const inMatch = document.body.classList.contains("in-match");
  const hasRound = Boolean(room && room.round);
  chrome.classList.toggle("hidden", !inMatch);
  chrome.classList.toggle("bandwait", inMatch && !hasRound);
  if (!hasRound) return;
  // The map's width on screen, not its width in the backing store: the canvas is a whole number of
  // device pixels per cell and the browser scales it to the container, so 320*scale would put the
  // band short of the map's right edge.
  const rect = board.getBoundingClientRect();
  const mapWidthPx = Math.round(rect.width || board.clientWidth || (Number(boardPayload.width) || 320) * (view ? view.scale : 1));
  const geometry = chromeGeometry(mapWidthPx);
  box.style.width = geometry.boxWidth + "px";
  box.style.height = geometry.boxHeight + "px";
  box.style.left = geometry.boxLeft + "px";
  drawChromeLabel(geometry.label, geometry.boxWidth);
  text.textContent = timeLeftText(room.seat, room.roundSeconds);
  const running = room.clock && room.clock !== "held";
  const fraction = running ? roundFraction(room.roundSeconds, Date.now() - roundStartedAt) : 1;
  bar.style.width = Math.round(fraction * 100) + "%";
  bar.style.background = fraction < 0.2 ? "#ff5555" : "#55ffff";
}

function tickChrome() {
  if (!room || !room.round) return;
  if (paintedRound !== room.round) {
    paintedRound = room.round;
    roundStartedAt = Date.now();
  }
  paintChrome(camera);
  // The debug window repaints whenever its rows would change; the camera is one of those rows, so
  // a zoom shows up in the panel the frame it lands rather than on a clock.
  if (debugOpen) renderDebug();
}

setInterval(tickChrome, 100);

function drawMatch() {
  // T-031 step 3: a film is painted instead of the room. The live room, the socket and the clock are
  // untouched while a film is open - the film's own frames are the whole truth on screen.
  if (film) {
    drawFilmFrame();
    return;
  }
  const ctx = board.getContext("2d");
  let view = viewForCanvas();
  // Follow the selected piece: a zoomed view that leaves the piece behind is a worse camera than
  // no zoom at all.
  // Never while a placement is pending: the cell the player is aiming at must not slide away.
  if (following && selected && !buying && !placement) {
    camera = centerOn(selected, view);
    view = camera;
  }
  // PB-224: the orbital list is merged in for painting and hit-testing only; `room.satellites`
  // stays the payload's own array so the Show Satellites box reads fuel and radius unmodified.
  const screenPieces = piecesOnScreen();
  const satellites = room && Array.isArray(room.satellites) ? room.satellites : [];
  const result = paintMatch(ctx, boardPayload, room ? { ...room, pieces: screenPieces } : room, {
    view,
    own: room && room.you,
    satellites,
    // The PM's floor is a screen size; the canvas draws in device pixels, so the floor is scaled by
    // the same ratio the cells are.
    badgeMinPx: BADGE_MIN_PX * dpr(),
    badgeSprites,
    selectedId: selected ? selected.id : null,
    selectedPulse: selectPulse,
    preview,
    fog: fogFor(view),
    sight: Number(boardPayload.sightCells || 8),
    sightAt: selected,
    viewMode,
    // The map theme: a table of inks the painter reads (T-019). Cosmetic, per player, never sent to
    // the server and never part of a room frame.
    theme: currentTheme(),
    // The original's lettering for city names, once the camera is close enough to read them.
    atlas: fontAtlas,
    // The intel sweep (T-022): the bar and the shade live while the pass runs; the ids that the
    // scan put on the board stay gated by the bar for as long as this scan state is armed.
    scan: scan ? (() => {
      const state = scanState(scan.startedAt, Date.now(), scan.boardW);
      return { state, active: !state.done, intelIds: scan.intelIds, pieces: scan.intelPieces };
    })() : null,
  });
  lastPaint = {
    mode: result.mode,
    layers: result.layers ? result.layers.slice() : [],
    fogged: result.fogged || 0,
    political: result.political || 0,
    painted: result.painted || 0,
    tally: result.tally || null,
    // PB-224 AC5: what the Show Satellites layer actually drew (rings, and rows in the insert box).
    satelliteRings: result.satelliteRings || 0,
    satellites: result.satellites || 0,
  };
  // While a unit is armed, the cells the server will accept are painted underneath everything else.
  if (placement) paintPlacement(ctx, placement, view);
  paintChrome(view);
  const camNote = document.getElementById("camNote");
  if (camNote) {
    camNote.textContent = "cell " + (view.scale / dpr()).toFixed(0) + " px · " +
      (following ? "following" : "free") + " · " + currentTheme().label;
  }
  // A zoom or a pan is a debug row changing with no message on the wire, so the panel is offered
  // the new camera here as well as on the tick.
  if (debugOpen) renderDebug();
  // A crossing nobody screens is said out loud, in the seat's own words, before the loss.
  const unscreened = Array.isArray(room && room.unscreened) ? room.unscreened : [];
  const escortNote = unscreened.length === 0 ? ""
    : unscreened.length === 1 ? "A transport is crossing unscreened."
    : unscreened.length + " transports are crossing unscreened.";
  // In Show Ownership the note says what the colours mean, counted from the same regions the map
  // filled: regions held, not cells painted, so a zoom cannot change the numbers.
  const politicalNote = result.tally
    ? "Ownership: blue holds " + result.tally.blue + ", red holds " + result.tally.red +
      ", neutral " + result.tally.neutral + "."
    : "";
  // PB-224 AC5: in Show Satellites the note counts the orbital picture, from the same list the box
  // and the rings read.
  const satelliteNote = viewMode === "satellites"
    ? "Satellites: blue " + satellites.filter((sat) => sat.side === "blue" && sat.orbit !== false).length +
      ", red " + satellites.filter((sat) => sat.side === "red" && sat.orbit !== false).length + "."
    : "";
  // While a piece is selected, the note keeps naming it (T-030 AC8 item 4). A route hover or a
  // refusal speaks first, because it is about the cell under the pointer; after that the selection
  // wins over the political tally, the crossing warning and the generic grid line, all of which used
  // to overwrite the selection while the ring was still on the board.
  const selectionLine = [selectionNote(selected), cargoNote(selected) || airNote(selected)].filter(Boolean).join(" ");
  boardNote.textContent = previewLine(preview) || selectionLine || satelliteNote || politicalNote || escortNote ||
    statusLine(boardPayload, room, result);
  // A capital under threat is the loudest thing on the page, and it stays up until the threat
  // passes: the last ten rounds of a match are not the time to be quiet.
  if (alarmStrip) {
    // A finished match is not under threat; the result replaces the alarm rather than sitting
    // under it.
    const finished = boardPayload && boardPayload.over;
    const alarm = finished ? "" : alarmText(boardPayload && boardPayload.alarm);
    alarmStrip.textContent = alarm;
    alarmStrip.classList.toggle("hidden", !alarm);
  }
  renderLegend();
}

// Which unit the player has put on the build cursor, if any. The next click on a friendly city
// (or a dock, for a ship) buys it there; anything else cancels.
let buying = null;
// The cells the server says a purchase may stand on: {width, height, mask}. The page paints this and
// never works the rule out for itself.
let placement = null;
// Which air order the next map click sends for a selected aircraft: "strike" (the default, and
// what every pre-T-021 click meant) or "transfer", which rebases the plane on the cell clicked.
let pendingMission = "strike";
// PB-226: the tool whose picker is armed, or null. Foreign aid names its city (Manual p.30), so
// its button arms this instead of spending blind; the next map click is the target and Escape
// disarms. One slot for every picker tool, so two doors cannot arm different modes at once.
let pendingTool = null;

// The round log. A running clock is dead time unless it reports itself: every line here came
// from the server already filtered to what this seat could see. LOG_KEEP matches the room's own
// server-side cap (lobby.mjs trims the same figure); the panel is a scroll container over all of
// it, so the retained rounds are reachable and not just the newest six (PB-135).
let log = emptyLog();
// Where the reader is in the panel. Pinned means "at the bottom, follow new lines"; a reader who
// scrolled up keeps their place and gets a jump affordance instead (PB-135 AC2).
const logView = { pinned: true, scrollTop: 0, pending: 0 };

function noteLog(lines) {
  const added = appendLog(log, lines);
  if (!added) return;
  logView.pending = pendingAfterPaint(logView, added);
  const list = document.getElementById("roundLog");
  if (list) paintLog(list);
}

function clearCommand() {
  selected = null;
  buying = null;
  placement = null;
  preview = null;
  hoverKey = "";
  refusedHover = "";
  fogSeen = null;
  fogKey = "";
  // PB-193: Escape and every other clear also disarm the door, so a bomb kept armed through a
  // refusal cannot outlive the selection that armed it.
  pendingMission = nextDoorMode(pendingMission, "cleared");
  // PB-226: the tool picker answers to the same Escape, for the same reason.
  pendingTool = null;
  drawMatch();
}

function askRoute(cell) {
  if (!selected || !cell) return;
  const key = hoverOfferKey(selected.id, cell);
  if (key === hoverKey) return;
  // PB-177: a different cell is a new offer, so the refusal marker lapses; the refused cell itself
  // stays silent - it already has its answer and the click it invites would be refused again.
  if (refusedHover && key !== refusedHover) refusedHover = "";
  hoverKey = key;
  if (!hoverOffersOrder(key, refusedHover)) return;
  send(routeRequest(selected, cell));
}

// Click a piece: it is selected and the next click is a destination. Click a cell with a
// piece selected: the order goes to the server as {op:"order",piece,to:{x,y}}.
board.addEventListener("click", (event) => {
  // The click that ends a pan is not an order: the pointer travelled past PAN_SLOP, and the
  // camera moved under it. Swallow exactly that one click.
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  // PB-145: a finished match takes no orders. room.you survives the result, so the seat guard alone
  // left the order branch and the build cursor live after the end: each click put a frame on the wire
  // for the server to refuse. This is the same click path both arms share, so one guard closes both.
  if (!room || !room.you || room.over) return;
  let cell = cellAtEvent(event, board, viewForCanvas());
  if (!cell) return;

  // PB-226: an armed tool takes this click as its target and is spent either way - a refused
  // cell clears the mode too, so one intent is never two clicks. The server answers with the
  // sentence (the refusal or the aid's own line), and the page repeats it verbatim.
  if (pendingTool) {
    const tool = pendingTool;
    pendingTool = null;
    send({ op: "tool", tool, to: { x: cell.x, y: cell.y } });
    return;
  }

  // A unit on the build cursor claims the click: the cell has to be one of the seat's own
  // sites, and the server decides whether the purchase is legal.
  if (buying) {
    // The server owns the rule for where a purchase may stand; the page sends the cell the player
    // picked and repeats the refusal in the server's own words when it comes back.
    // The cursor stays armed until a purchase actually lands: a refused cell must not cost the
    // player their place-in-mode, and buying several units in a row is the normal case.
    //
    // The click target is forgiving by T-017: within the radius the server sent with the mask, the
    // nearest legal cell (ready or unready, this domain only) takes the click. Outside it the raw
    // cell goes to the server and is refused there, so a far click is still a refusal and not a
    // silent redirect.
    const snapped = snapPlacementCell(cell, placement, viewForCanvas());
    if (snapped) cell = { x: snapped.x, y: snapped.y };
    sendOrder(buyMessage(buying, cell));
    drawMatch();
    return;
  }

  // A click selects a piece by its ICON, not by the one cell under the pointer (T-028, PB-050):
  // the same badge box the hover uses, nearest icon centre wins, and a stack at one cell cycles.
  // The point is taken in device pixels, which is the frame the badge size is drawn in.
  //
  // clickIntent decides the precedence: a click that resolves to the ALREADY selected piece is not
  // a re-selection unless it lands on that piece's own cell - it is a destination for it. Without
  // that, the selected badge's box covers its neighbours and a selected unit has no one-cell move
  // anywhere (the regression T-028 shipped and the standing move-order leg caught).
  const point = screenPoint(event);
  const intent = clickIntent(piecesOnScreen(), viewForCanvas(), point.x, point.y, {
    side: room.you,
    selectedId: selected ? selected.id : null,
    badgeMinPx: BADGE_MIN_PX * dpr(),
    cell,
    // PB-191: one whole CSS pixel of pointer error, expressed in the canvas's own pixels. A mouse
    // event reports whole CSS pixels, so a click aimed at the selected piece's own cell edge can
    // arrive a pixel short of it; without this the click resolved to the neighbour and spent a
    // round marching the unit to the cell it already stood on.
    ownCellSlop: canvasScale(),
  });
  // PB-175: at the world fit a unit's badge is wider than its cell, so a city with a garrison could
  // never be inspected - every click on it resolved to the piece, and PB-163's site line only ran
  // when nothing was selected. The rule is a CYCLE, and it is chosen over "the city wins the first
  // click" because that would take the unit's own click away (PB-143):
  //   1st click on a friendly city cell: selects the unit exactly as before;
  //   2nd click on that same cell with that same unit still selected: says the city's own inspect
  //   line (Ready / "Unready - ready at round N") and keeps the unit selected.
  // The cell test is the piece's own cell, not the badge box, so a click on a neighbouring cell is
  // still a move order at every zoom (PB-146).
  if (intent && intent.kind === "piece") {
    // PB-191: the site is looked up on the PIECE's own cell, not on the floored cell the event
    // produced. Once clickIntent has said "this piece" the click is the piece's own cell by
    // definition (the own-cell rule is the only branch that returns the selected piece), and the
    // floored cell can be one cell over by the pointer's own pixel error - re-testing it here is
    // what made a corner click reselect instead of naming the city it stands on.
    const reclickSite = selected && String(intent.piece.id) === String(selected.id)
      ? siteUnderPiece(room.sites, intent.piece,
        { x: Number(intent.piece.x), y: Number(intent.piece.y) }, viewForCanvas().boardW)
      : null;
    if (reclickSite) {
      say(siteInspectText(reclickSite, room.round));
      return;
    }
    selected = intent.piece;
    preview = null;
    refusedHover = "";
    hoverKey = selected.id + ":" + selected.x + "," + selected.y;
    // Selecting a piece does not move the camera. It used to centre a zoomed view on the piece,
    // which read as the map jumping under the click that made the selection (T-007 AC10).
    //
    // The toast names the piece now: it used to say "Select one of your pieces" AFTER a selection,
    // while the board note named the selected route, and the two lines disagreed (PB-053, T-030).
    say(selectionToast(selected));
    startSelectionPulse();
    drawMatch();
    return;
  }
  if (!selected) {
    // PB-163: outside Buy mode a click on a city names it and its readiness, read from the site
    // record the server sent. Nothing is bought here: the buy arm above is the only path that
    // sends a buy, so an inspect click on a ready city costs no money.
    const site = siteAtCell(room.sites, cell);
    if (site) {
      say(siteInspectText(site, room.round));
      return;
    }
    say(PICK_HINT);
    return;
  }
  // An aircraft is flown, not walked: the cell the player clicks is the strike's target, and the
  // plane's own cell stays its base. Without this the only aim the page had was the plane's base
  // cell, where no enemy ever stands (T-003 hand check 4).
  if (selected.kind === "aircraft" || selected.domain === "air") {
    const mode = pendingMission === "transfer" || pendingMission === "bomb" ? pendingMission : "strike";
    // PB-178 + PB-188: a mission's target must lie inside the restricted air radius (manual p.25),
    // and the circle belongs to the air layer, not to the Bomb button: a strike is a mission too.
    // Refused here, with the circle named, so the click never becomes an order at all - the
    // server would refuse it too, but a refusal the player can see before the wire is the point.
    if (mode === "bomb" || mode === "strike") {
      const briefing = ((room && room.seat && room.seat.air) || []).find((plane) => plane.id === selected.id);
      const refusal = briefing
        ? restrictedTargetRefusal(selected, cell, briefing.restrictedReach, briefing.reach, BOARD_W, mode)
        : null;
      if (refusal) {
        say(refusal);
        // PB-177 item 4: same re-derive as a refusal from the server - the refused cell offers no
        // order and no route on the board note, so the toast and the note cannot disagree about an
        // order that never went.
        refusedHover = hoverOfferKey(selected.id, cell);
        dropHover();
        // PB-193: a refusal keeps the door armed for the order it refused - a bombing run is not a
        // strike, and the player has not asked for one.
        pendingMission = nextDoorMode(pendingMission, "refused");
        return;
      }
    }
    const mission = missionMessage(selected, mode, cell);
    if (mission) sendOrder(mission);
    // Back to the everyday meaning of a click on an aircraft's map.
    pendingMission = nextDoorMode(pendingMission, "sent");
    return;
  }
  const message = orderMessage(selected, cell);
  // PB-191: the page never sends a march to the cell the piece already stands on. The own-cell
  // rule in clickIntent decides the click, so this is the last guard on the wire: a resolved
  // destination equal to the piece's own cell is the cell's own inspect/re-select, and the server
  // refuses the order anyway ("That piece is already on that cell."). The wrap is the seam's.
  if (selected && message && wrapX(Number(selected.x), BOARD_W) === wrapX(Number(cell.x), BOARD_W)
    && Number(selected.y) === Number(cell.y)) {
    const site = siteUnderPiece(room.sites, selected, cell, BOARD_W);
    if (site) {
      say(siteInspectText(site, room.round));
      return;
    }
    say(selectionToast(selected));
    return;
  }
  if (message) sendOrder(message);
});

// Hover names the unit under the pointer: type and strength, or the whole stack when a footprint
// holds several (T-014 AC6). It is a DOM tip rather than a board note because the note is where a
// refusal and a route plan speak, and a hover must not overwrite either.
const badgeTip = document.getElementById("badgeTip");

function hideBadgeTip() {
  if (!badgeTip) return;
  badgeTip.classList.add("hidden");
}

function hoverBadge(event) {
  if (!badgeTip) return;
  // PB-224: a satellite is hoverable and selectable like any other badge.
  const pieces = piecesOnScreen();
  if (!pieces.length) return hideBadgeTip();
  const view = viewForCanvas();
  const at = screenPoint(event);
  const group = badgeAt(pieces, view, at.x, at.y, { badgeMinPx: BADGE_MIN_PX * dpr() });
  if (!group) return hideBadgeTip();
  const text = badgeHoverText(group);
  if (!text) return hideBadgeTip();
  if (badgeTip.textContent !== text) badgeTip.textContent = text;
  badgeTip.classList.remove("hidden");
  const stage = document.getElementById("mapStage");
  const rect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const width = badgeTip.offsetWidth || 160;
  const height = badgeTip.offsetHeight || 18;
  const left = Math.max(4, Math.min(rect.width - width - 6, event.clientX - rect.left + 12));
  const top = Math.max(4, event.clientY - rect.top - height - 10);
  badgeTip.style.left = Math.round(left) + "px";
  badgeTip.style.top = Math.round(top) + "px";
}

board.addEventListener("mousemove", (event) => {
  // A pan is not a hover: while the pointer is down the badge tip and the route preview stay put.
  if (panFrom) return;
  hoverBadge(event);
  const cell = room ? cellAtEvent(event, board, viewForCanvas()) : null;
  const moved = cell
    ? !pointerCell || pointerCell.x !== cell.x || pointerCell.y !== cell.y
    : Boolean(pointerCell);
  if (moved) {
    pointerCell = cell ? { x: cell.x, y: cell.y } : null;
    renderDebug();
  }
  if (!room || !room.you || !selected || !cell) return;
  askRoute(cell);
});

board.addEventListener("mouseleave", () => {
  hideBadgeTip();
  if (pointerCell) {
    pointerCell = null;
    renderDebug();
  }
  if (!preview) return;
  preview = null;
  hoverKey = "";
  drawMatch();
});

// --- camera: wheel zooms about the cursor, right-drag pans, arrows nudge -------------------
// At 2x a piece is about four pixels, so the board is unreadable without this. Zoom is whole
// cells and the X pan may run past the edge: the painter tiles the board across the seam.
function screenPoint(event) {
  const rect = board.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (board.width / Math.max(1, rect.width)),
    y: (event.clientY - rect.top) * (board.height / Math.max(1, rect.height)),
  };
}

// PB-148: a wheel GESTURE belongs to the surface it began on. The browser hit-tests every notch
// separately, so a reader who scrolls the round-log list and lets the pointer drift a few pixels
// past the panel's border was scrolling the panel and zooming the camera in one continuous gesture
// (PB-135 AC6). Latch the surface at the first notch and hold it until the notches stop: a gesture
// that starts on a panel stays with that panel, a gesture that starts on the map keeps zooming, and
// neither one also drives the other when the pointer wanders across the border mid-gesture.
const WHEEL_GESTURE_GAP = 250; // ms without a notch that ends a gesture
let wheelGesture = { surface: "", at: -Infinity, scroller: null };

// The last notch, as this page saw it: which element it was hit-tested against, its client point,
// and the surface the gesture latched to. The debug window prints it (PB-148) so a hand check that
// sees the camera move can read whether the notch targeted the canvas or a panel.
let lastWheel = null;

function wheelTargetName(node) {
  if (!(node instanceof Element)) return "?";
  return node.id || node.tagName;
}

function wheelScroller(node) {
  let el = node instanceof Element ? node : null;
  while (el && el !== document.documentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}

// The panel keeps its own scroll when the pointer has drifted onto the map: the event no longer
// targets the panel, so the browser will not scroll it for us and the page must do it here.
function scrollLatchedPanel(event) {
  const scroller = wheelGesture.scroller;
  if (!scroller) return;
  const perUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
  scroller.scrollTop += event.deltaY * perUnit;
}

function zoomAtCursor(event) {
  const at = screenPoint(event);
  userCamera = true;
  camera = zoomAt(viewForCanvas(), event.deltaY < 0 ? 1.25 : 0.8, at.x, at.y);
  drawMatch();
}

window.addEventListener("wheel", (event) => {
  if (!room) return; // the lobby has no camera to zoom and no panel to latch
  const onBoard = event.target instanceof Element && Boolean(event.target.closest("#board"));
  const now = event.timeStamp;
  if (!(now - wheelGesture.at < WHEEL_GESTURE_GAP)) {
    wheelGesture = onBoard
      ? { surface: "board", at: now, scroller: null }
      : { surface: "panel", at: now, scroller: wheelScroller(event.target) };
  }
  wheelGesture.at = now;
  lastWheel = {
    target: wheelTargetName(event.target),
    x: event.clientX,
    y: event.clientY,
    surface: wheelGesture.surface,
  };
  renderDebug();
  if (wheelGesture.surface === "board") {
    event.preventDefault(); // a map gesture never scrolls a panel it drifts over
    zoomAtCursor(event);
    return;
  }
  if (onBoard) {
    // Latched to the panel. The notch is still the panel's scroll, not a zoom, even though the
    // pointer is over the canvas now.
    event.preventDefault();
    scrollLatchedPanel(event);
  }
}, { passive: false, capture: true });

// A drag pans: primary, middle or right button. The primary button is the only one a trackpad
// offers, which is why "right-drag" existed in code and no drag panned in a hand-check (PB-083).
// A click is still a click - the pan only starts once the pointer has travelled PAN_SLOP device
// pixels - and the click that follows a pan is swallowed, so aiming a unit is never also a pan.
const PAN_SLOP = 4;
let panFrom = null;
let panTravel = 0;
let panButton = -1;
let suppressClick = false;
// PB-145: the over frame clears the command state once, not on every frame the result re-renders.
let overCleared = false;

// CSS pixels to canvas (device) pixels. The camera is in device pixels, so a drag measured in
// client coordinates has to be scaled or the map lags the cursor by the device pixel ratio:
// at dpr 2 a 120 px drag moved the camera 120 device px, i.e. 60 CSS px on screen.
function canvasScale() {
  const rect = board.getBoundingClientRect();
  return board.width / Math.max(1, rect.width);
}

board.addEventListener("contextmenu", (event) => event.preventDefault());
board.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
  panFrom = { x: event.clientX, y: event.clientY };
  panTravel = 0;
  panButton = event.button;
  suppressClick = false;
  if (event.button !== 0) event.preventDefault();
  board.setPointerCapture?.(event.pointerId);
});
board.addEventListener("pointermove", (event) => {
  if (!panFrom) return;
  const dx = event.clientX - panFrom.x;
  const dy = event.clientY - panFrom.y;
  panTravel += Math.abs(dx) + Math.abs(dy);
  if (panTravel < PAN_SLOP) return;
  userCamera = true;
  const ratio = canvasScale();
  camera = panBy(viewForCanvas(), dx * ratio, dy * ratio);
  panFrom = { x: event.clientX, y: event.clientY };
  drawMatch();
});
board.addEventListener("pointerup", (event) => {
  const travelled = panTravel;
  const button = panButton;
  panFrom = null;
  panTravel = 0;
  panButton = -1;
  // One travel test for every button: past the slop it was a pan (swallow the click that
  // follows), under it, the primary button's click runs the normal select/order path and a
  // right-click that stayed put clears the selection (T-030 AC3).
  if (travelled >= PAN_SLOP) {
    suppressClick = true;
    return;
  }
  if (event && button === 2 && travelled < PAN_SLOP && selected) {
    clearCommand();
    say("Selection cleared.");
  }
});
window.addEventListener("keydown", (event) => {
  // Typing a name or a password is not a command: the shortcuts only apply away from the gate's
  // fields.
  const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  // Ctrl+V is the original's Alternate Function for the oil columns (Monitor Four, manual p.27):
  // it swaps the readout to the other side. Resist the browser's paste gesture here.
  if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === "v" || event.key === "V")) {
    event.preventDefault();
    toggleOilAlternate();
    return;
  }
  const view = viewForCanvas();
  const step = 8 * view.scale;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  // Escape is the way out of a dialogue, which is what the original's Buy Units menu did too.
  if (event.key === "Escape" && openDialogId) {
    closeDialog();
    return;
  }
  // PB-226: an armed tool picker is a mode, and Escape disarms it. It sits ahead of the build
  // cursor because arming a tool clears the cursor: the player's Escape is for the mode on screen.
  if (event.key === "Escape" && pendingTool) {
    const off = TOOL_PICK_OFF[pendingTool] || "Tool off.";
    clearCommand();
    say(off);
    return;
  }
  // PB-047: an armed purchase is a mode, and Escape gets out of it even with no dialogue open.
  // Before this, the only way off the build cursor was to open the Buy menu again and close it.
  if (event.key === "Escape" && buying) {
    clearCommand();
    say("Build cursor off.");
    return;
  }
  // T-030 AC3: Escape clears a selection, and clearing is not an order. It is the same handler
  // that closes a dialogue and drops the build cursor, so PB-047 and this close together.
  if (event.key === "Escape" && selected) {
    clearCommand();
    say("Selection cleared.");
    return;
  }
  if (event.key === "b" || event.key === "B") return openDialog("buy");
  if (event.key === "e" || event.key === "E") return openDialog("economy");
  if (event.key === "p" || event.key === "P") return cycleViewMode();
  // Manual p.12: "Press Satellite." One key, straight to the orbital view (PB-224 AC5).
  if (event.key === "s" || event.key === "S") {
    return setViewMode(viewMode === "satellites" ? "terrain" : "satellites");
  }
  if (event.key === "t" || event.key === "T") return cycleTheme();
  if (event.key === "+" || event.key === "=") return zoomStep(1);
  if (event.key === "-" || event.key === "_") return zoomStep(-1);
  if (event.key === "0") return refit();
  if (event.key === "f" || event.key === "F") return setFollow(!following);
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  camera = panBy(view, move[0], move[1]);
  drawMatch();
});

// The theme control is on screen before the first frame of a match: the saved preference (or the
// dark tactical default) has to be named in the button, not only applied to the canvas.
paintThemeControl();

window.addEventListener("resize", () => refit());

// PB-173: the strip's clock word goes in a slot of its own (see .stripinfo .phase in app.css), so
// the painter builds the line out of nodes instead of assigning one string. textContent throughout —
// these are room fields, and a name is not markup.
function paintStripInfo(room) {
  const info = document.getElementById("stripInfo");
  if (!info) return;
  const pieces = stripInfoParts(room);
  info.textContent = "";
  pieces.forEach((piece, i) => {
    if (i) info.appendChild(document.createTextNode(" \u00b7 "));
    if (piece.phase) {
      const slot = document.createElement("span");
      slot.className = "phase";
      slot.textContent = piece.text;
      info.appendChild(slot);
    } else {
      info.appendChild(document.createTextNode(piece.text));
    }
  });
}

document.getElementById("camIn")?.addEventListener("click", () => zoomStep(1));
document.getElementById("camOut")?.addEventListener("click", () => zoomStep(-1));
document.getElementById("camFit")?.addEventListener("click", () => refit());
document.getElementById("viewToggle")?.addEventListener("click", () => cycleViewMode());
document.getElementById("camFollow")?.addEventListener("click", () => setFollow(!following));
document.getElementById("themeToggle")?.addEventListener("click", () => cycleTheme());

async function loadBoard() {
  // A board fetch that loses a race with server startup used to leave the page on the schematic for
  // the rest of its life. Try twice before believing the extract is really absent.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/board", { credentials: "same-origin" });
      const payload = await res.json();
      if (payload && typeof payload === "object") {
        boardPayload = payload;
        // PB-125: the pre-room frame draws the lobby's SELECTED era's capitals, so the payload
        // carries the year on show. render.mjs prefers room.era once a match exists.
        boardPayload.era = eraSelect ? String(eraSelect.value || "") : "";
        if (payload.source !== "missing") break;
      }
    } catch (err) {
      boardPayload = { ...boardPayload, source: "missing", cells: null };
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
  }
  drawMatch();
}

function renderAccount() {
  account.textContent = "";
  if (!me) return;
  // PB-187b: the handle lives in its own span so the ellipsis can only eat the name. While the
  // name and the Sign out button shared one clipping box, a long handle clipped the button itself.
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = me;
  account.append(who);
  const button = document.createElement("button");
  button.className = "ghost";
  button.type = "button";
  button.textContent = "Sign out";
  button.addEventListener("click", signOut);
  account.append(button);
}

function renderPeople() {
  people.textContent = "";
  const launch = document.querySelector("#launch");
  for (const user of users) {
    if (user.username === me) continue;
    const row = document.createElement("li");
    row.className = "person";
    const name = document.createElement("span");
    name.textContent = user.username;
    if (user.busy) name.className = "busy";
    row.append(name);
    if (!user.busy && !room) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Invite";
      button.addEventListener("click", () => {
        const fields = new FormData(launch);
        send({ op: "invite", user: user.username, era: fields.get("era"), side: fields.get("side") });
      });
      row.append(button);
    }
    people.append(row);
  }
  if (!people.childElementCount) {
    const empty = document.createElement("li");
    empty.className = "fine";
    empty.textContent = "Nobody else is online.";
    people.append(empty);
  }
}

function renderInvites() {
  invites.textContent = "";
  for (const invite of pending) {
    if (invite.to !== me) continue;
    const row = document.createElement("div");
    row.className = "invite";
    const text = document.createElement("span");
    text.textContent = invite.from + " invited you. " + eraName(invite.era) + ".";
    row.append(text);
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = "Accept";
    yes.addEventListener("click", () => send({ op: "answer", id: invite.id, accept: true }));
    const no = document.createElement("button");
    no.type = "button";
    no.className = "ghost";
    no.textContent = "Decline";
    no.addEventListener("click", () => {
      pending = pending.filter((item) => item.id !== invite.id);
      send({ op: "answer", id: invite.id, accept: false });
      renderInvites();
    });
    row.append(yes, no);
    invites.append(row);
  }
}

// The shell changes shape the moment there is a match: the masthead becomes one narrow strip and
// the map takes the window. The class on <body> is the whole switch; the stylesheet does the rest.
// A shell change moves the map's box, so the camera is refitted - but only on the transition, or
// every delta would throw away a camera the player set up.
// Play/Pause, Resign, New and Quit. The clock button mirrors the room's own state, so it cannot say
// "pause" while the server is running the clock. The three game commands are destructive, so each
// asks once before sending.
const clockBtn = document.getElementById("clockBtn");
const resignBtn = document.getElementById("resignBtn");
const newBtn = document.getElementById("newBtn");
const quitBtn = document.getElementById("quitBtn");
const speedDown = document.getElementById("speedDown");
const speedUp = document.getElementById("speedUp");
const speedReadout = document.getElementById("speedReadout");

// The speed the server says the room is at (manual p.34-35). The readout shows the room's number,
// never a local counter: the other seat can change it, and a control that disagrees with the clock
// is worse than no control.
function roomSpeed() {
  const value = Number(room && room.speed);
  return Number.isFinite(value) ? value : 1;
}

// PB-164: the speed pair and the hold button are two different things, and the header has to say
// so. A held clock is paused; speed 0 is a pause the number itself carries (Manual p.34-35). The
// defect the card names - "- does nothing while paused" - was read off a header that showed a bare
// "Speed 1" over a paused board, with both arrows live but no sentence saying a step still applies.
// So: the readout names the hold, the arrows keep working at a hold (the server applies the step
// and the clock stays held), and each arrow's title says what it will do and why it is disabled at
// an end of the range. The readout stays within the fixed slot's longest string ("Speed 0 ·
// paused"): "· held" is shorter, so the strip's geometry - measured by the e2e row leg - does not
// move.
function roomHeld() {
  return Boolean(room) && !room.over && String(room.clock || "running") !== "running";
}

function syncSpeed() {
  const speed = roomSpeed();
  const held = roomHeld();
  if (speedReadout) {
    const suffix = speed === 0 ? " \u00b7 paused" : held ? " \u00b7 held" : "";
    speedReadout.textContent = "Speed " + speed + suffix;
  }
  if (speedDown) speedDown.disabled = !room || speed <= 0;
  if (speedUp) speedUp.disabled = !room || speed >= 6;
  if (speedDown) {
    speedDown.title = !room || speed <= 0
      ? "Slower (speed -): already at 0, the slowest. Press + to raise it."
      : held
        ? "Slower (speed -): applies now, and is the speed it runs at when you press Play"
        : "Slower (speed -)";
  }
  if (speedUp) {
    speedUp.title = !room || speed >= 6
      ? "Faster (speed +): already at 6, the fastest. Press - to lower it."
      : held
        ? "Faster (speed +): applies now, and is the speed it runs at when you press Play"
        : "Faster (speed +)";
  }
}

function syncGameButtons() {
  const running = Boolean(room && room.clock === "running");
  if (clockBtn) {
    clockBtn.textContent = running ? "\u275A\u275A" : "\u25B6";
    clockBtn.setAttribute("aria-pressed", running ? "true" : "false");
    clockBtn.title = running ? "Pause the clock" : "Play the clock";
  }
  for (const button of [resignBtn, newBtn, quitBtn]) if (button) button.disabled = !room;
  syncSpeed();
}

// PB-147: the Buy control carries the match's own state. A finished match has nothing to sell, so the
// button is disabled on the over frame and enabled again by the next match; the click path, the panel
// row and this control all read the same room.over byte, so the control cannot offer what they refuse.
function syncBuyNav() {
  const button = document.querySelector('.navbtn[data-dialog="buy"]');
  if (button) button.disabled = Boolean(room && room.over);
}

clockBtn?.addEventListener("click", () => {
  if (!room) return;
  send({ op: room.clock === "running" ? "hold" : "run" });
});
speedDown?.addEventListener("click", () => {
  if (!room) return;
  send({ op: "speed", delta: -1 });
});
speedUp?.addEventListener("click", () => {
  if (!room) return;
  send({ op: "speed", delta: 1 });
});
resignBtn?.addEventListener("click", () => {
  if (!room) return;
  if (!confirm("Resign this game? The other side wins.")) return;
  send({ op: "resign" });
});
newBtn?.addEventListener("click", () => {
  if (!room) return;
  if (!confirm("Start a new game? This one is abandoned.")) return;
  send({ op: "newgame" });
});
quitBtn?.addEventListener("click", () => {
  if (!room) return;
  if (!confirm("Quit this game and return to the lobby? It is not kept.")) return;
  send({ op: "quit" });
});

function syncShell() {
  // Called on every room frame: the strip's purse moves when a purchase lands, and the refit inside
  // only runs on the in-match transition.
  const inMatch = Boolean(room);
  const changed = document.body.classList.contains("in-match") !== inMatch;
  if (changed) {
    document.body.classList.toggle("in-match", inMatch);
    refit();
  }
  paintStripInfo(room);
  // The purse at a glance: the economy dialogue explains it, this is the number a player wants to
  // see without opening anything.
  const purse = document.getElementById("purseChip");
  if (purse) paintPurse(purse, room && room.seat ? room.seat : null, "strip");
  syncGameButtons();
  renderDebug();
  paintDialog();
}

// T-033 / Manual p.27 Alternate Function: the original's oil monitor swaps sides on Ctrl+V
// (Monitor Four's alternate readout, DS:0xe184 = 5). One flag, drawn in the purse chip, so the
// opponent's In/Out/reserve is one key away and never silently replaces the player's own numbers.
let oilFoe = false;

// PB-180 (PM 8316 §1, option (a)): the strip draws a two-leg SUMMARY — the player's cash in whole
// billions, then income per round — because that is what the original's main display shows (p.27).
// The long economy string (oil in/out, reserves, the payday countdown) moves into the chip's TITLE,
// and the Economy dialogue keeps printing the same numbers. `mode` is "strip" for #purseChip and
// "full" for the room panel's paragraph, which has the height for the long line.
function paintPurse(el, seat, mode = "full") {
  if (!el) return;
  const full = seat ? purseText(seat, oilFoe) : "";
  const summary = seat
    ? purseSummaryParts(seat, oilFoe && room && room.opponent ? room.opponent.income : null)
    : null;
  if (mode === "strip" && summary) {
    el.textContent = "";
    if (summary.cash) {
      const cash = document.createElement("span");
      cash.className = "cash";
      cash.textContent = summary.cash;
      el.append(cash);
    }
    if (summary.income) {
      const inc = document.createElement("span");
      inc.className = "inc";
      inc.textContent = summary.income;
      el.append(inc);
    }
  } else {
    el.textContent = full;
  }
  const budget = seat ? (oilFoe ? seat.foeOil : seat.oil) : null;
  el.classList.toggle("oilshort", Boolean(budget && budget.short === true));
  const hint = oilFoe
    ? "Alternate Function (manual p.27): the opponent's oil. Click or Ctrl+V to show your own."
    : "Click, or press Ctrl+V, for the opponent's oil (manual p.27 Alternate Function).";
  // PB-180: the full economy string is one hover/long-press away, and the income leg is always in the
  // title even when the narrow strip drops it — so the summary is never the only place a number
  // lives. The opponent's cash is never in either string: `full` and `summary` are built from this
  // seat's own cash field.
  const titleParts = [];
  if (summary) titleParts.push((summary.cash + summary.income).trim());
  if (full) titleParts.push(full);
  titleParts.push(hint);
  el.title = titleParts.filter(Boolean).join(" · ");
  el.setAttribute("data-oil-side", oilFoe ? "foe" : "own");
  const warn = oilWarning(budget);
  if (warn) el.setAttribute("aria-label", el.textContent + " — " + warn);
  else el.removeAttribute("aria-label");
  el.onclick = () => toggleOilAlternate();
}

function toggleOilAlternate() {
  oilFoe = !oilFoe;
  const purse = document.getElementById("purseChip");
  if (purse) paintPurse(purse, room && room.seat ? room.seat : null, "strip");
}

function seatRow(label, seat, yours) {
  const row = document.createElement("div");
  row.className = "seat " + label.toLowerCase();
  const who = seat.kind === "bot" ? "Bot" : seat.username;
  row.textContent = label + " · " + who + (yours ? " · you" : "");
  return row;
}

function renderRoom() {
  // The strip's numbers and the clock button follow every room frame, not only the frame that enters
  // or leaves a match: a purchase changes the purse, and a run/hold changes the button.
  syncShell();
  syncGameButtons();
  syncBuyNav();
  if (document.body.classList.contains("in-match") !== Boolean(room)) syncShell();
  else {
    paintStripInfo(room);
    renderDebug();
  }
  if (room && room.over) {
    sayResult(room);
    // PB-145: a finished match has no order to give. The selection, the route preview and the build
    // cursor die on the frame the result lands, so the board stops offering "Click to send the
    // order". clearCommand() only nulls page-local command state and writes no element text, which is
    // what keeps #result (PB-137 AC4) out of this clear's reach.
    if (!overCleared) {
      overCleared = true;
      clearCommand();
      // PB-147: an open Buy panel closes with the result. Leaving it up would list units whose row
      // click arms a purchase the server refuses. closeDialog() only paints the panel; it writes no
      // result text, so #result (PB-137 AC4) stays untouched.
      if (openDialogId === "buy") closeDialog();
    }
  } else {
    overCleared = false;
  }
  syncPauseBanner(room);
  roomBox.className = room ? "" : "room-empty";
  roomBox.textContent = "";
  if (!room) {
    // PB-137 AC4: the result line lives as long as the match does. Leaving is what ends it.
    flashLine.clearResult();
    roomBox.textContent = "Start a bot match, or invite someone who is online.";
    return;
  }
  const seats = document.createElement("div");
  seats.className = "seats";
  seats.append(seatRow("Blue", room.blue, room.you === "blue"));
  seats.append(seatRow("Red", room.red, room.you === "red"));
  const meta = document.createElement("p");
  meta.textContent = eraName(room.era) + " · " + (room.mode === "bot" ? "Bot match" : "Human match") + " · clock " + room.clock;
  const note = document.createElement("p");
  note.className = "fine";
  note.textContent = room.note || "";
  const actions = document.createElement("div");
  actions.className = "actions";
  const run = document.createElement("button");
  run.type = "button";
  run.textContent = room.clock === "running" ? "Hold" : "Run";
  run.addEventListener("click", () => send({ op: room.clock === "running" ? "hold" : "run" }));
  const leave = document.createElement("button");
  leave.type = "button";
  leave.className = "ghost";
  leave.textContent = "Leave";
  leave.addEventListener("click", () => send({ op: "leave" }));
  actions.append(run, leave);

  // The wallet, in one line. Buying, the kit and the round log each have a dialogue of their own now,
  // so this box carries only what a player wants at a glance.
  roomBox.append(seats, meta, note, actions);
  if (room.seat) {
    const purse = document.createElement("p");
    purse.className = "purse";
    paintPurse(purse, room.seat);
    roomBox.append(purse);
  }
  if (!sawRoom && room) {
    // A match that opens below the fold is a match the player does not see open.
    sawRoom = true;
    setTimeout(() => document.getElementById("board")?.scrollIntoView({ block: "center" }), 60);
  }
  // Whatever dialogue is open follows the round: a price table that stops updating is a table the
  // player is reading instead of the game.
  paintDialog();
}

// The late kit is a set of decisions, and a decision with no button is not a decision. Each era
// says which tools it has; a nuke says why it is refused instead of hiding.
const TOOL_WORDS = {
  intel: "Intel",
  satellite: "Satellite",
  aid: "Foreign aid",
  ceasefire: "Cease-fire",
  nuke: "Nuke",
  oil: "Oil",
};

// PB-226: foreign aid names its city (Manual L382 + p.30), so its button arms a picker instead of
// spending blind. Both doors (the Kit row and the Buy table's tool row) go through this one
// function, so the sentence and the armed mode cannot drift apart.
const AID_PICK_HINT = "Foreign aid: pick the city you want to sway - an enemy's or a neutral one. It moves that city's nation one step, and a nation with more cities takes more gifts. Escape cancels.";

// PB-229: a nuke is aimed the same way - arm, then click the ground. It is ONE click, not a purchase
// then a spend: the 10b leaves the pool only when the launch is ACCEPTED, so an aim the player
// abandons with Escape never spends and needs no refund path. The three refusals (a capital's ring,
// the firer's own home country, the three-launch lead) come back as the server's own sentences.
const NUKE_PICK_HINT = "Nuke: pick the ground you want to hit. The price leaves your pool only when the launch is accepted; a capital's ring, your own home country and the three-launch lead are refused. Escape cancels.";

const TOOL_PICK_HINT = { aid: AID_PICK_HINT, nuke: NUKE_PICK_HINT };
const TOOL_PICK_OFF = { aid: "Foreign aid off.", nuke: "Nuke off." };
// Which tools name a cell on the wire. Everything else is spent on the button itself.
const TOOL_PICKERS = new Set(["aid", "nuke"]);

function armTool(tool) {
  pendingTool = tool;
  selected = null;
  buying = null;
  placement = null;
  preview = null;
  hoverKey = "";
  say(TOOL_PICK_HINT[tool] || "Pick a cell.");
  closeDialog();
  drawMatch();
}

function toolRow(room) {
  const list = Array.isArray(room && room.tools) ? room.tools : [];
  const wanted = list.filter((tool) => TOOL_WORDS[tool.name]);
  if (!wanted.length) return null;
  const row = document.createElement("div");
  row.className = "shop tools";
  // The server's own words for each tool: what it does, what it costs a side, and every stand-in
  // named as one. The page never writes this text itself, so it cannot disagree with the rule.
  const kit = ((room && room.seat && room.seat.kit) || []);
  // PB-200: the cease fire on the table, as the server reads it for this seat. The offer is answered
  // by the other side, so the row says which half of the offer this seat holds instead of printing a
  // button that pretends the war already ended.
  const truce = (room && room.seat && room.seat.ceasefire) || null;
  for (const tool of wanted) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "buy";
    button.textContent = TOOL_WORDS[tool.name];
    const brief = kit.find((entry) => entry.name === tool.name);
    if (tool.allowed === false) {
      button.title = String(tool.reason || (brief && brief.reason) || "Refused in this match.");
      button.disabled = true;
    } else {
      // An aircraft on the ground is the other half of this row: a mission is a piece order.
      button.title = brief ? brief.text : "Send it now.";
    }
    if (tool.name === "ceasefire" && truce) {
      if (truce.canAnswer) {
        button.textContent = "Accept cease-fire";
        button.title = "Both sides agree and the war ends. Declining leaves the board as it is.";
      } else if (truce.status === "pending") {
        button.textContent = "Cease-fire proposed";
        button.title = "Your opponent must agree. The war continues until they do.";
        button.disabled = true;
      } else if (truce.status === "declined") {
        button.title = "Your offer was declined, and the war goes on. You can offer again.";
      }
    }
    button.addEventListener("click", () => {
      // PB-200: an offer this seat may answer is answered, not re-proposed.
      if (tool.name === "ceasefire" && truce && truce.canAnswer) {
        send({ op: "ceasefire_answer", accept: true });
        return;
      }
      // PB-226: a tool that names a cell arms the picker; everything else is spent on the click.
      if (TOOL_PICKERS.has(tool.name)) return armTool(tool.name);
      send({ op: "tool", tool: tool.name });
    });
    row.append(button);
    if (tool.name === "ceasefire" && truce && truce.canAnswer) {
      const decline = document.createElement("button");
      decline.type = "button";
      decline.className = "buy";
      decline.textContent = "Decline cease-fire";
      decline.title = "Refuse the offer. The war goes on, and nothing on the board changes.";
      decline.addEventListener("click", () => send({ op: "ceasefire_answer", accept: false }));
      row.append(decline);
    }
  }
  // The consequences of the kit, in text rather than in a tooltip: a player should be able to read
  // the kill zone, the wasteland and the three refusals before they fire one (PB-230).
  const nuke = kit.find((entry) => entry.name === "nuke");
  if (nuke) {
    const note = document.createElement("p");
    note.className = "kitNote";
    note.textContent = nuke.text;
    row.append(note);
  }
  // A selected piece can dig in or repair: those are its own orders, not the era's tools.
  if (selected && selected.side === (room && room.you)) {
    for (const [kind, label] of [["entrench", "Dig in"], ["repair", "Repair"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "buy";
      button.textContent = label;
      button.title = kind === "entrench" ? "Infantry only, and it must be standing still."
        : "Repair needs a city and money.";
      button.addEventListener("click", () => send({ op: kind, piece: selected.id }));
      row.append(button);
    }
    // An aircraft's missions are choices with a price in rounds, and the price comes from the
    // server's briefing so the page cannot disagree with what a mission actually costs.
    const briefing = ((room && room.seat && room.seat.air) || []).find((plane) => plane.id === selected.id);
    if (briefing) {
      for (const mission of briefing.missions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "buy";
        // A transfer's round cost is config's air.transferRounds, tagged UNVERIFIED
        // (air.transferRoundsSource): the manual names the sites, never a price. So the label
        // shows a price only when the file sets one, and a transfer never needs a base in reach -
        // it moves the base.
        const needsBase = mission.mode !== "transfer";
        button.textContent = mission.rounds > 0
          ? mission.label + " (" + mission.rounds + "r)"
          : mission.label;
        button.disabled = !briefing.ready || (needsBase && !briefing.canFly);
        button.title = !briefing.ready
          ? "This aircraft is away for " + briefing.roundsLeft + " more rounds."
          : needsBase && !briefing.canFly
            ? "No friendly city, dock or ship in reach."
            : mission.mode === "strike"
              ? "Pick the target cell on the map inside the restricted air radius ("
                + (briefing.restrictedReach || "?") + " cells); the aircraft flies there for "
                + mission.rounds + " rounds."
              : mission.mode === "bomb"
                ? "Pick an empty enemy city, base, oil field or capital inside the restricted air radius (" + (briefing.restrictedReach || "?") + " cells); the owner loses 125 M and the site is unready 5 rounds (1000 oil for an oil field). The aircraft is away for " + mission.rounds + " rounds."
              : mission.mode === "transfer"
                ? "Pick a friendly city, base or carrier cell within the stand-in reach (UNMEASURED); the aircraft rebases there. The round cost is UNVERIFIED."
                : "Fly it now; the aircraft is gone for " + mission.rounds + " rounds.";
        button.addEventListener("click", () => {
          // A strike hits the cell the player names, not the base the plane sits on. A transfer
          // names the berth the plane moves to. A scramble is a patrol around that base, so its
          // own cell is the right target for it.
          if (mission.mode === "strike" || mission.mode === "transfer" || mission.mode === "bomb") {
            pendingMission = mission.mode;
            say(mission.mode === "transfer"
              ? "Transfer: pick a friendly city, base or carrier cell (stand-in reach, UNMEASURED)."
              : mission.mode === "bomb"
                ? bombArmText(briefing.restrictedReach)
                : "Strike: pick the target cell inside the restricted air radius ("
                  + (briefing.restrictedReach || "?") + " cells).");
            closeDialog();
            return;
          }
          // PB-172: a panel mission is an order too, so it takes an id and can be settled and deduped
          // exactly like a board-click mission.
          sendOrder({ op: "mission", kind: "mission", piece: selected.id, mode: mission.mode, to: { x: selected.x, y: selected.y } });
        });
        row.append(button);
      }
    }

    // A transport crossing with no warship able to see it is the sink rule waiting to happen. The
    // server says which transports are in that state; this puts the selected warship on one.
    const unscreened = Array.isArray(room.unscreened) ? room.unscreened : [];
    if (unscreened.length && selected.domain === "sea" && selected.transport !== true) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "buy";
      button.textContent = "Escort";
      button.title = unscreened.length === 1
        ? "Travel with your unscreened transport."
        : "Travel with your unscreened transports, nearest first.";
      button.addEventListener("click", () => send({ op: "escort", ship: selected.id, transport: unscreened[0] }));
      row.append(button);
    }
  }
  return row;
}

function syncLogJump(list) {
  const text = affordanceText(logView.pending);
  const parent = list && list.parentNode;
  if (!parent) return;
  let jump = document.getElementById("logJump");
  if (!text) {
    if (jump) jump.classList.add("hidden");
    return;
  }
  if (!jump) {
    jump = document.createElement("button");
    jump.type = "button";
    jump.id = "logJump";
    jump.className = "ghost logjump";
    jump.addEventListener("click", () => {
      logView.pinned = true;
      logView.pending = 0;
      const now = document.getElementById("roundLog");
      if (now) {
        now.scrollTop = now.scrollHeight;
        logView.scrollTop = now.scrollTop;
        syncLogJump(now);
      }
    });
    parent.insertBefore(jump, list.nextSibling);
  }
  jump.textContent = text;
  jump.classList.remove("hidden");
}

// Paint every line the page retains, oldest first, and keep the reader's place. A reader at the
// bottom follows the newest line; a reader scrolled up stays put and is told how many lines arrived
// under a visible jump control (PB-135 AC1, AC2).
function paintLog(list) {
  const lines = paintedLines(log);
  list.textContent = "";
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = "round " + line.round + " \u2014 " + line.text;
    list.append(item);
  }
  list.scrollTop = scrollAfterPaint(logView, { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight });
  logView.scrollTop = list.scrollTop;
  syncLogJump(list);
}

// A delta is the difference since the frame this page already has. If the round does not follow
// on from the one on screen, the page has missed something and asks for the whole room rather
// than patching a guess.
function applyDelta(delta) {
  if (!room || !delta) return;
  const next = Number(delta.round) || 0;
  const here = Number(room.round) || 0;
  const advanced = next !== here;
  if (next !== here + 1 && next !== here) {
    send({ op: "sync" });
    return;
  }
  const byId = new Map((room.pieces || []).map((piece) => [piece.id, piece]));
  for (const piece of delta.pieces || []) byId.set(piece.id, piece);
  for (const id of delta.gone || []) byId.delete(id);
  const routes = { ...(room.routes || {}), ...(delta.routes || {}) };
  const sites = (room.sites || []).map((site) => {
    const hit = (delta.sites || []).find((change) => change.id === site.id);
    return hit ? { ...site, owner: hit.owner } : site;
  });
  room = {
    ...room,
    round: next,
    clock: delta.clock,
    note: delta.note,
    pieces: [...byId.values()],
    routes,
    sites,
    seat: delta.seatChanged ? delta.seat : room.seat,
    // The alarm is not a "changed" field: it rides every delta, because the sentence is only
    // useful in the round it becomes true.
    alarm: delta.alarm === undefined ? room.alarm : delta.alarm,
    roundSeconds: delta.roundSeconds === undefined ? room.roundSeconds : delta.roundSeconds,
    speed: delta.speed === undefined ? room.speed : delta.speed,
    // Which of this seat's transports are crossing naked rides every delta for the same reason the
    // alarm does: the warning is only worth anything in the round it is true.
    unscreened: Array.isArray(delta.unscreened) ? delta.unscreened : (room.unscreened || []),
    capitals: delta.capitalsChanged ? delta.capitals : room.capitals,
    capitalList: delta.capitalList === undefined ? room.capitalList : delta.capitalList,
    // Who holds each region rides whole when the site table moves, so a capture recolours the
    // ground on the same frame the city changes hands (T-018 AC4).
    ownership: delta.ownership === undefined ? room.ownership : delta.ownership,
    // PB-224: the orbital list rides every delta whole. It is at most a few rows, and a satellite
    // that moved without its row would paint a ring in the wrong place for a whole frame window.
    satellites: Array.isArray(delta.satellites) ? delta.satellites : room.satellites,
    // The end of a match is a one-round fact, and the delta is the frame most seats see it in. The
    // page used to learn "over" only from a whole frame, so a seat on deltas kept playing past the
    // end - the harness watched one do it for ten minutes.
    over: delta.over === undefined ? room.over : Boolean(delta.over),
    winner: delta.winner === undefined ? room.winner : delta.winner,
    result: delta.result === undefined ? room.result : delta.result,
  };
  // PB-170b: the same re-bind the whole-room branch does (PB-170), because this branch also
  // replaces the piece objects. Before this, an id that was still on the board kept the
  // click-time object, so its `inactive` count froze: the note read "Away ... 8 rounds" for every
  // delta-only round and only corrected itself when a full frame happened to land (the PM's live
  // read on 6d4ecd3, rounds 37-48). Re-point by id; a vanished id still clears the selection.
  selected = refreshSelection(piecesOnScreen(), selected);
  if (!selected) {
    preview = null;
    hoverKey = "";
  }
  // PB-182: `placement` is a SNAPSHOT taken once, when the row was armed. Its mask bytes carry the
  // readiness of that instant, so a unit kept armed across a round boundary painted its old boxes
  // (long -> soon -> ready all frozen) until the player disarmed and re-armed. The mask is only
  // re-requested by the arm click, so the round delta has to ask again: the server recomputes the
  // box per cell from the readiness timer and the next "placement" frame repaints it in place.
  if (advanced && placement && buying) send({ op: "placement", kind: buying });
  renderRoom();
  drawMatch();
}

function showPlay(on) {
  gate.classList.toggle("hidden", on);
  play.classList.toggle("hidden", !on);
  renderAccount();
  syncShell();
}

// The page starts in a "checking your session" state instead of painting the sign-in form and
// swapping it out when /api/me answers (T-007 AC5): the flash of the gate read as being signed
// out mid-match. `body.booting` hides the gate, the lobby and the build stamp; the stylesheet
// draws the waiting line.
function bootDone() {
  document.body.classList.remove("booting");
}

// A match whose clock is not running is paused, and a reloaded page must say so rather than look
// frozen (T-007 AC11). The banner follows every room frame: Play hides it, Pause brings it back.
//
// PB-136: "hides it" is visibility in a match, not display. The banner is a flex item in .match, so
// taking its row out of the flow when the clock starts shrank the stage by its height and pulled the
// map up under a resting pointer. The sentence stays in the element (same font, same padding) and the
// stylesheet hides the ink, so the row's height is identical before and after Play.
function syncPauseBanner(room) {
  const banner = document.getElementById("pauseBanner");
  if (!banner) return;
  const paused = Boolean(room) && !room.over && String(room.clock || "") !== "running";
  banner.textContent = "Paused - press Play to resume";
  banner.classList.toggle("paused", paused);
  banner.classList.toggle("hidden", !room);
}

// ---- the debug window ----------------------------------------------------
// Top right, closed by default, and opened by a button that is always there. It reports what the
// page has actually been told - the socket's state, the board's provenance, the room's own fields -
// plus the last frames off the wire, because "the round is not moving" is a wire question first.
const WIRE_KEEP = 40;
const wireLog = [];
let socketState = "closed";
let debugOpen = false;
// The last painted rows, so a repaint that would change nothing is skipped.
let debugSignature = "";
try {
  debugOpen = localStorage.getItem("openchq.debug") === "1";
} catch {
  debugOpen = false;
}

function wireLabel(message) {
  if (!message || !message.op) return "?";
  if (message.op === "delta") return "delta · round " + (message.delta && message.delta.round);
  if (message.op === "room") return "room · round " + (message.room && message.room.round);
  if (message.op === "ack") return "ack · " + ((message.events && message.events.length) || 0) + " event(s)";
  if (message.op === "presence") return "presence · " + ((message.users || []).length) + " online";
  if (message.op === "route") return "route · " + (message.error ? message.error : (message.rounds + " rounds"));
  if (message.op === "error") return "error · " + (message.error || message.reason || "");
  return String(message.op);
}

function noteWire(text) {
  wireLog.push(String(text));
  while (wireLog.length > WIRE_KEEP) wireLog.shift();
  if (debugOpen) paintWire();
}

function paintWire() {
  const list = document.getElementById("debugWire");
  if (!list) return;
  list.textContent = "";
  for (const line of wireLog) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

function renderDebug() {
  const panel = document.getElementById("debugPanel");
  if (!panel || !debugOpen) return;
  const rows = debugRows({
    me,
    socket: socketState,
    board: {
      source: boardPayload.source,
      width: boardPayload.width,
      height: boardPayload.height,
      cells: Array.isArray(boardPayload.cells) ? boardPayload.cells.length : 0,
    },
    room,
    camera: camera ? { scale: Math.max(1, Math.round(camera.scale / dpr())), follow: following } : null,
    wheel: lastWheel,
    pointer: pointerCell,
    selected,
  });
  // The panel is repainted whenever its text would actually change, not on a 250 ms clock: the
  // pointer cell and the camera move between ticks, and a row that trails the map is the row a
  // hand check ends up quoting (PB-130).
  const signature = rows.map((row) => row[0] + "=" + row[1]).join("\u0001");
  if (signature === debugSignature) return;
  debugSignature = signature;
  const list = document.getElementById("debugRows");
  list.textContent = "";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  // The pointer and the selection move under the clock-less parts of the page (a hover, a zoom),
  // so the panel is painted from the events that move them, not only from the clock's tick.
  paintWire();
}

function setDebug(on) {
  debugOpen = Boolean(on);
  const panel = document.getElementById("debugPanel");
  const button = document.getElementById("debugToggle");
  if (panel) panel.classList.toggle("hidden", !debugOpen);
  if (button) button.setAttribute("aria-expanded", debugOpen ? "true" : "false");
  try {
    localStorage.setItem("openchq.debug", debugOpen ? "1" : "0");
  } catch {
    // A private window with no storage still gets a debug window.
  }
  renderDebug();
}

document.getElementById("debugToggle")?.addEventListener("click", () => setDebug(!debugOpen));
document.getElementById("debugClose")?.addEventListener("click", () => setDebug(false));
setDebug(debugOpen);

// ---- the navigation, and the dialogues it opens ---------------------------
// The original hid these commands behind a menu bar that appeared when the controller entered the
// strip at the top of the screen. A browser has buttons instead, and one dialogue over the map.
let openDialogId = null;
// PB-152: the economy dialogue's Alternate Function. "own" is this seat; "opponent" shows the
// other side's payday and their cash as ???. Reset whenever a new match opens, so a shared screen
// never starts on someone else's page.
let economyView = "own";

function note(text) {
  const p = document.createElement("p");
  p.className = "dialogfoot";
  p.textContent = text;
  return p;
}

function cell(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function definition(dl, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

function closeDialog() {
  if (openDialogId === null) return;
  openDialogId = dialogAfter(openDialogId, { type: "close" });
  paintDialog();
}

function openDialog(id) {
  // T-031: the film list is a LOBBY dialogue - it is where a player goes between wars, so it opens
  // without a room. Every other panel is a view of a live match and still refuses without one.
  if (!room && id !== "films") {
    say("Start a match first.");
    return;
  }
  // PB-147: a finished match sells nothing. The click path already refuses the order, so an armed row
  // would offer a purchase that can never land. The refusal is a silent return: 7285 says the refusal
  // surface does not widen, and a disabled control is its own explanation.
  if (id === "buy" && room.over) return;
  openDialogId = dialogAfter(openDialogId, { type: "open", id });
  paintDialog();
}

const DIALOG_PAINTERS = {
  // The purchase menu, with the original's own columns: what it is, how many you hold, how many you
  // have seen, what it costs. Arming a row and then clicking your city or dock is the whole order.
  buy(body) {
    const rows = buyRows(room);
    if (!rows.length) {
      body.append(note("This scenario sells nothing."));
      return;
    }
    const table = document.createElement("div");
    table.className = "buytable";
    const head = document.createElement("div");
    head.className = "buyrow head";
    head.append(cell("Unit"), cell("Yours"), cell("Seen"), cell("Cost"));
    table.append(head);
    for (const row of rows) {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "buyrow" + (buying === row.kind ? " armed" : "");
      const name = cell("");
      // The board's own badge, in this player's colours: the Buy row and the piece you get on the
      // map are one drawing (T-014, DESIGN.md "the Buy table and the Kit legend use the same badge").
      const icon = document.createElement("span");
      icon.className = "buybadge";
      icon.innerHTML = badgeSvg({
        kind: row.kind, side: room.you === "red" ? "red" : "blue", px: 16,
        title: unitLabel(row.kind),
      });
      name.append(icon, document.createTextNode(unitLabel(row.kind)));
      line.dataset.kind = row.kind;
      line.append(name, cell(String(row.own)), cell(String(row.known)),
        cell(row.price === null ? "—" : formatBillions(row.price) + "b"));
      if (row.refused) {
        line.disabled = true;
        line.title = row.refused;
      } else if (!row.affordable) {
        line.disabled = true;
        line.title = "Not enough in the pool.";
      } else if (row.domain === "tool") {
        line.title = "Use this now: the price is charged from the pool.";
        line.addEventListener("click", () => {
          // PB-226: the same picker the Kit row arms, so the Buy table cannot spend aid blind.
          if (row.tool === "aid") return armTool("aid");
          send({ op: "tool", tool: row.tool });
          say("Use " + row.kind + ".");
          closeDialog();
        });
      } else {
        // PB-046: a hull is not placed on docks alone - D-025 added coastal cities and bases - and a
        // land unit goes on a city or a base, so the prompt names the cells the mask actually paints.
        // PB-224: a satellite is aimed anywhere on the map, not at a friendly site. The mask the
        // server returns is the whole board, so the whole board is what the row promises.
        line.title = row.domain === "sat"
          ? "Arm this, then click any point on the map to put the satellite over it."
          : "Arm this, then click one of your " + (row.domain === "sea"
            ? "highlighted docks, or a coastal city or base"
            : "highlighted cities or bases") + ".";
        line.addEventListener("click", () => {
          // PB-147: the over frame can land between the panel's paint and this click. Arming here
          // would put a placement frame on the wire for a match that takes none, so the row reads the
          // same byte as the click path. Silent: no new refusal sentence (7285).
          if (room && room.over) return;
          buying = row.kind;
          selected = null;
          preview = null;
          placement = null;
          // Ask the server where this unit may stand, and paint its answer.
          send({ op: "placement", kind: row.kind });
          // The sentence names the rule the server just enforced: a site cell this side owns,
          // not a radius and not coastal water (D-019).
          // PB-046: the prompt says what is highlighted, not one outdated word for it.
          say(row.domain === "sat"
            ? "Buy " + row.kind + ": click the point on the map you want the satellite over."
            : "Buy " + row.kind + ": " + (row.domain === "sea"
              ? "click one of the highlighted docks, or a coastal city or base, to place it."
              : "click one of the highlighted cities or bases you hold to place it."));
          closeDialog();
        });
      }
      table.append(line);
    }
    // A refused row is off *and* says why in the panel, not only in its tooltip: the manual's
    // sentence ("You hold no dock, so a hull cannot be bought.", p.27) is a rule the player has to
    // be able to read, and a hover title on a dimmed button is not readable on a touch screen or in
    // a screenshot. The sentences come from the server's shop rows, so the page cannot invent one.
    const refusedRows = rows.filter((row) => row.refused);
    if (refusedRows.length) {
      const why = document.createElement("ul");
      why.className = "buyrefusals";
      for (const row of refusedRows) {
        const item = document.createElement("li");
        item.textContent = unitLabel(row.kind) + ": " + row.refused;
        why.append(item);
      }
      body.append(table, why);
    } else {
      body.append(table);
    }
    body.append(note("Seen counts only enemy units this seat can see. Prices are the server's."));
    const untyped = untypedCount(room);
    if (untyped > 0) {
      body.append(note(untyped === 1
        ? "One of your units has no type recorded: it is part of the opening force, whose order of battle was never recovered."
        : untyped + " of your units have no type recorded: they are part of the opening force, whose order of battle was never recovered."));
    }
  },

  // The economy: the pool, when the next payday lands, what it is worth and what is burning. Every
  // figure here came off the seat the server sent.
  economy(body) {
    const model = economyModel(room);
    // PB-152: the manual's Alternate Function (p.27). A second view shows the other side's
    // payday; their balance is ??? because the original does not show it, and the payload does
    // not carry it either. The toggle only exists when the server sent an opponent block.
    if (model.opponent) {
      const bar = document.createElement("div");
      bar.className = "econview";
      for (const [id, label] of [["own", "Your economy"], ["opponent", "Opponent"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "navbtn" + (economyView === id ? " armed" : "");
        button.dataset.economyView = id;
        button.textContent = label;
        button.addEventListener("click", () => {
          economyView = id;
          paintDialog();
        });
        bar.append(button);
      }
      body.append(bar);
    }
    if (economyView === "opponent" && model.opponent) {
      const foe = document.createElement("dl");
      foe.className = "dlgrid";
      definition(foe, "Opponent income", formatBillions(model.opponent.income.amount) + "b per round");
      definition(foe, "Opponent cities paid", String(model.opponent.income.cities));
      definition(foe, "Opponent balance", "???");
      body.append(foe);
      body.append(note("The Alternate Function shows the other side's income. Their balance prints ??? there, and this panel shows nothing else of theirs."));
      return;
    }
    const dl = document.createElement("dl");
    dl.className = "dlgrid";
    definition(dl, "Pool", model.cash === null ? "unknown" : formatWholeBillions(model.cash) + "b");
    definition(dl, "Next payday", model.payIn === null ? "unknown" : "in " + model.payIn + (model.payIn === 1 ? " round" : " rounds"));
    definition(dl, "Payday every", model.payEvery === null ? "unknown" : model.payEvery + (model.payEvery === 1 ? " round" : " rounds"));
    definition(dl, "Payday worth", model.income
      ? formatBillions(model.income.amount) + "b per round · " + model.income.cities + " cities + " + model.income.cashWells + " paying oil"
      : "unknown");
    // PB-162: every count below is by the site SUBTYPE, not by the asset list's `kind`. 1986 Blue
    // holds 29 type-4 cities, 3 capitals (one with kind "capital", two drawn as "city"), 6 type-3
    // bases and 11 type-5 oil fields - so "37 cities" was counting bases and capitals as cities
    // while the payday pays 31, and "5 oilfields" was counting world.json sketch wells.
    definition(dl, "Paying cities", model.income ? String(model.income.cities) : "unknown");
    definition(dl, "Cities held", String(model.held.city));
    definition(dl, "Capitals held", String(model.held.capital));
    definition(dl, "Bases held", String(model.held.base));
    definition(dl, "Docks held", String(model.held.dock));
    definition(dl, "Oilfields held", String(model.held.oilfield));
    definition(dl, "Your units", String(model.units.own));
    definition(dl, "Enemy units seen", String(model.units.known));
    body.append(dl);
    // Stocks: the real oil budget on its own line, then every other resource kind. PB-162: the
    // generic "fuel" meter used to sit beside a reserve of 3000 saying "unknown held · rate
    // unknown", because its held value is a cache nothing primes and its rate was never recovered.
    const stocks = [];
    if (model.oil) stocks.push({ text: oilLine(model.oil), title: "T-033's oil budget: the reserve, and the next round's In and Out." });
    for (const meter of model.reserves) {
      stocks.push({
        text: reserveLine(meter),
        title: meter.kind === "steel" ? "Steel is a non-original owner choice (D-003); the 1990 game had oil only." : "",
      });
    }
    if (stocks.length) {
      const label = document.createElement("p");
      label.className = "dialoglabels";
      label.textContent = "Stocks";
      const list = document.createElement("ul");
      list.className = "reserves";
      for (const stock of stocks) {
        const item = document.createElement("li");
        item.textContent = stock.text;
        if (stock.title) item.title = stock.title;
        list.append(item);
      }
      body.append(label, list);
    }
    // The rate is read off the state the server sent, never typed here (prices node, grep guard).
    // PB-233: the server sends the raw per-city rate, so the dialogue prints the rate rather than
    // deriving one from a figure some other effect may have moved.
    const rate = model.income && Number.isFinite(Number(model.income.perCity)) ? Number(model.income.perCity) : null;
    const perCity = rate !== null ? rate
      : (model.income && model.income.cities > 0 ? model.income.amount / model.income.cities : null);
    const every = model.payEvery === null || model.payEvery === undefined ? " every round" : (model.payEvery === 1 ? " every round" : " every " + model.payEvery + " rounds");
    body.append(note("Each city pays " + (perCity === null ? "its rate" : formatBillions(perCity) + " billion") + every +
      ". Your first capital is free, and each capital after the first pays like one city. Bases, docks and oil fields pay nothing."));
  },

  // The fleet. Every aircraft this seat owns, where it is based, how many rounds it is away, and a
  // button per mission the era allows. Without this an aircraft is only findable by clicking a marker
  // on a world map, which is exactly what the original's "Show Air Power" command existed to prevent.
  air(body) {
    const planes = room && room.seat && Array.isArray(room.seat.air) ? room.seat.air : [];
    if (!planes.length) {
      body.append(note("No aircraft. Buy one in Buy; it appears here once you hold it."));
      return;
    }
    const table = document.createElement("div");
    table.className = "buytable airtable";
    const head = document.createElement("div");
    head.className = "buyrow head";
    head.append(cell("Plane"), cell("Base"), cell("Away"), cell("Missions"));
    table.append(head);
    for (const plane of planes) {
      const line = document.createElement("div");
      line.className = "buyrow";
      const acts = cell("");
      acts.className = "airmissions";
      for (const mission of Array.isArray(plane.missions) ? plane.missions : []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = mission.label;
        // PB-178: the Bomb door names the restricted air radius before the player aims, because a
        // target outside that circle is refused - the player should learn the rule from the door,
        // not from a refusal after a wasted click. The number is the briefing's, so it is the same
        // circle the server charges.
        button.title = !plane.ready
          ? "Away for " + plane.roundsLeft + " more rounds."
          : mission.mode === "bomb"
            ? "Pick an empty enemy city, base, oil field or capital inside the restricted air radius ("
              + (plane.restrictedReach || "?") + " cells); away for " + mission.rounds + " rounds."
            : mission.mode === "strike"
              ? "Pick the target cell inside the restricted air radius ("
                + (plane.restrictedReach || "?") + " cells); away for " + mission.rounds + " rounds."
              : mission.rounds > 0
              ? "Away for " + mission.rounds + " rounds."
              : "Pick a friendly city, base or carrier cell within the stand-in reach (UNMEASURED); the aircraft rebases there. The round cost is UNVERIFIED.";
        button.disabled = !plane.ready;
        button.addEventListener("click", () => {
          // A strike, a bombing run or a transfer is aimed: the air dialog names the plane and
          // hands the player the map, because the cell the plane sits on is its base, not the
          // cell meant (T-003). PB-157a: the panel used to omit "bomb", so Air > Bomb sent the
          // mission at the plane's own cell and the server refused every time ("That site is
          // yours." / "needs an enemy site"). The Kit panel's toolRow already armed it; this is
          // the same three arms, so the two doors give one result.
          if (mission.mode === "strike" || mission.mode === "transfer" || mission.mode === "bomb") {
            const planePiece = (room.pieces || []).find((piece) => piece.id === plane.id);
            if (planePiece) {
              selected = planePiece;
              startSelectionPulse();
            }
            pendingMission = mission.mode;
            say(mission.mode === "transfer"
              ? "Transfer: pick a friendly city, base or carrier cell (stand-in reach, UNMEASURED)."
              : mission.mode === "bomb"
                ? bombArmText(plane.restrictedReach)
                : "Strike: pick the target cell inside the restricted air radius ("
                  + (plane.restrictedReach || "?") + " cells).");
            closeDialog();
            drawMatch();
            return;
          }
          sendOrder({ op: "mission", kind: "mission", piece: plane.id, mode: mission.mode, to: { x: plane.x, y: plane.y } });
          say(plane.id + ": " + mission.label + " ordered.");
          closeDialog();
        });
        acts.append(button);
      }
      line.append(cell(plane.id), cell(plane.base || "—"),
        cell(plane.ready ? "ready" : String(plane.roundsLeft) + " rounds"), acts);
      table.append(line);
    }
    body.append(table, note("A mission puts the aircraft out of action for its own number of rounds; that number is the config's, not this page's."));
  },

  kit(body) {
    const tools = toolRow(room);
    body.append(tools || note("This scenario has no late-war tools."));
    // The unit legend (T-014 AC6). It lives here rather than under the map because the map's own
    // legend is terrain, and a player looking up "what is that shape" is already in a panel.
    body.append(unitLegend());
  },

  map(body) {
    const group = document.createElement("div");
    group.className = "dialogbuttons";
    const act = (label, title, run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.addEventListener("click", () => {
        run();
        paintDialog();
      });
      return button;
    };
    group.append(
      act("Zoom in", "Bigger cells (+)", () => zoomStep(1)),
      act("Zoom out", "Smaller cells (-)", () => zoomStep(-1)),
      act("Whole world", "Fit the planet (0)", () => refit()),
      act(viewMode === "political" ? "Ownership: on" : "Ownership: off", "Who holds what (P)",
        () => setViewMode(viewMode === "political" ? "terrain" : "political")),
      act("Map: " + currentTheme().label, "Switch to " + themeById(nextThemeId(themeId)).label + " (T)",
        () => cycleTheme()),
      act(following ? "Stop following" : "Follow piece", "Keep the selected piece centred (F)",
        () => setFollow(!following)),
    );
    const state = document.createElement("p");
    state.className = "dialogfoot";
    state.textContent = "cell " + Math.max(1, Math.round((camera ? camera.scale : 1) / dpr())) +
      " px · " + (following ? "following" : "free") + " · " + viewMode +
      " · theme " + currentTheme().label;
    body.append(group, state);
  },

  war(body) {
    const dl = document.createElement("dl");
    dl.className = "dlgrid";
    definition(dl, "Blue", room.blue ? (room.blue.kind === "bot" ? "Bot" : room.blue.username) : "—");
    definition(dl, "Red", room.red ? (room.red.kind === "bot" ? "Bot" : room.red.username) : "—");
    definition(dl, "You", room.you || "—");
    definition(dl, "Era", eraName(room.era));
    definition(dl, "Clock", room.clock || "—");
    definition(dl, "Round", String(room.round));
    body.append(dl);
    // The era's capitals, with the holder the server's site records carry, and - once the match is
    // over - which of them fell last. This is the same list the end screen reads, so a player can
    // check the sentence against the board without leaving the panel.
    const capitals = Array.isArray(room.capitalList) && room.capitalList.length
      ? room.capitalList
      : (room.result && Array.isArray(room.result.capitals) ? room.result.capitals : null);
    if (capitals && capitals.length) {
      const reason = room.result && room.result.lastCapital;
      const label = document.createElement("p");
      label.className = "dialoglabels";
      label.textContent = reason && reason.name
        ? "Capitals — " + reason.name + " fell last, round " + reason.round
        : "Capitals";
      const list = document.createElement("ul");
      list.className = "reserves";
      for (const capital of capitals) {
        const item = document.createElement("li");
        item.textContent = capital.name + " — " + (capital.owner || "neutral");
        list.append(item);
      }
      body.append(label, list);
    }
    const group = document.createElement("div");
    group.className = "dialogbuttons";
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = room.clock === "running" ? "Hold the clock" : "Run the clock";
    run.addEventListener("click", () => send({ op: room.clock === "running" ? "hold" : "run" }));
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "ghost";
    leave.textContent = "Leave the match";
    leave.addEventListener("click", () => send({ op: "leave" }));
    group.append(run, leave);
    body.append(group);
    if (room.note) body.append(note(room.note));
  },

  log(body) {
    if (!log.lines.length) {
      body.append(note("Nothing has happened yet. The clock reports itself here once it runs."));
      return;
    }
    const list = document.createElement("ol");
    list.className = "roundLog";
    list.id = "roundLog";
    // The reader's own scrolling is the only thing that unpins the view: arriving state never does.
    list.addEventListener("scroll", () => {
      logView.scrollTop = list.scrollTop;
      logView.pinned = isAtBottom({ scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight });
      if (logView.pinned) logView.pending = 0;
      syncLogJump(list);
    });
    body.append(list);
    paintLog(list);
  },

  // T-031 step 3: the War Films list. A film opens only when a match is over, which is the server's
  // rule (room 7683 condition 1): the list it answers with contains finished wars only.
  films(body) {
    if (filmListError) body.append(note(filmListError));
    if (!filmList) {
      body.append(note("Reading your films…"));
      loadFilmList().then(() => {
        if (openDialogId === "films") paintDialog();
      });
      return;
    }
    if (!filmList.length) {
      body.append(note("No finished wars yet. A film opens when a match is over; a live match has none."));
      return;
    }
    const list = document.createElement("div");
    list.className = "filmList";
    for (const row of filmList) {
      const line = document.createElement("div");
      line.className = "filmRow";
      const when = String(row.ended_at || "").slice(0, 16).replace("T", " ");
      const who = [row.blue_user || "?", row.red_user || "?"].join(" v ");
      const text = document.createElement("span");
      text.textContent = (row.era || "?") + " · " + who + " · " + when +
        " · " + (Number(row.rounds) || 0) + " rounds · " + (row.winner ? row.winner + " won" : "no winner");
      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "buy";
      watch.textContent = "Watch";
      watch.dataset.film = String(row.id);
      watch.addEventListener("click", () => openFilmById(row.id));
      line.append(text, watch);
      list.append(line);
    }
    body.append(list, note("A film is the war as it was recorded: every round, both sides. Show Red / Show Blue / Show Common / Show Both are the original's own view toggles (manual p.35, p.38)."));
  },
};

// ---- War Films: the replay state, the transport and the four toggles (T-031 step 3) ----------
// A film is a REPLAY. It does not touch the live room, the socket or the clock: `film` is non-null
// only while one is being watched, and drawMatch() paints the film instead of the room in that state.
// The view model (what a frame paints, what each Show means) lives in film.mjs, where the node tests
// drive the same functions - so the toggle cannot mean one thing on the page and another in a test.
let film = null;
let filmList = null;
let filmListError = "";
let filmTimer = null;
let filmBarEl = null;
let filmMoreFrames = 0;

async function loadFilmList(force = false) {
  if (filmList && !force) return filmList;
  filmListError = "";
  try {
    const response = await fetch("/api/matches?limit=50", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      filmListError = "Sign in to see your films.";
      filmList = [];
      return filmList;
    }
    const body = await response.json();
    filmList = Array.isArray(body && body.matches) ? body.matches : [];
    return filmList;
  } catch (err) {
    filmListError = "Could not read your films: " + (err && err.message ? err.message : String(err));
    filmList = [];
    return filmList;
  }
}

function openFilms() {
  openDialogId = "films";
  paintDialog();
}

async function openFilmById(id) {
  const name = String(id || "");
  if (!name) return;
  try {
    const metaResponse = await fetch("/api/matches/" + encodeURIComponent(name), { headers: { accept: "application/json" } });
    if (metaResponse.status !== 200) throw new Error("HTTP " + metaResponse.status);
    const meta = await metaResponse.json();
    const pageResponse = await fetch("/api/matches/" + encodeURIComponent(name) + "/rounds?from=0", { headers: { accept: "application/json" } });
    if (pageResponse.status !== 200) throw new Error("HTTP " + pageResponse.status);
    const page = await pageResponse.json();
    film = emptyFilm();
    film.meta = meta.film;
    film.start = meta.film && meta.film.start ? meta.film.start : {};
    film.frames = (Array.isArray(page && page.frames) ? page.frames : []).map((row) => row.frame);
    filmMoreFrames = Number(page && page.rounds) || film.frames.length;
    film.at = 0;
    closeDialog();
    buildFilmBar();
    syncFilmBar();
    drawMatch();
  } catch (err) {
    say("That film could not be opened: " + (err && err.message ? err.message : String(err)));
  }
}

// A 400-round war is three windows of 200 frames, and the reader must not have to know that. The
// next window is fetched when playback reaches the end of the one it holds.
async function loadMoreFrames() {
  if (!film || !film.meta) return false;
  if (frameCount(film) >= filmMoreFrames) return false;
  try {
    const response = await fetch("/api/matches/" + encodeURIComponent(film.meta.id) + "/rounds?from=" + frameCount(film),
      { headers: { accept: "application/json" } });
    if (response.status !== 200) return false;
    const page = await response.json();
    const more = (Array.isArray(page && page.frames) ? page.frames : []).map((row) => row.frame);
    if (!more.length) {
      filmMoreFrames = frameCount(film);
      return false;
    }
    film.frames.push(...more);
    return true;
  } catch {
    return false;
  }
}

function scheduleFilm() {
  clearTimeout(filmTimer);
  filmTimer = null;
  if (!film || !film.playing) return;
  filmTimer = setTimeout(async () => {
    if (!film || !film.playing) return;
    if (film.at + 1 < frameCount(film) || await loadMoreFrames()) {
      film.at += 1;
      drawMatch();
      syncFilmBar();
      scheduleFilm();
      return;
    }
    film.playing = false;
    syncFilmBar();
  }, frameDelayMs(film.speed));
}

function filmPlay() {
  if (!film) return;
  if (film.playing) {
    film.playing = false;
    clearTimeout(filmTimer);
    filmTimer = null;
  } else {
    if (film.at + 1 >= frameCount(film)) film.at = 0;
    film.playing = true;
    scheduleFilm();
  }
  syncFilmBar();
  drawMatch();
}

function filmStep(delta) {
  if (!film) return;
  stepFilm(film, delta);
  clearTimeout(filmTimer);
  filmTimer = null;
  syncFilmBar();
  drawMatch();
}

function filmSpeed() {
  if (!film) return;
  film.speed = nextSpeed(film.speed);
  syncFilmBar();
  if (film.playing) scheduleFilm();
}

function filmShow(show) {
  if (!film) return;
  toggleShow(film, show);
  syncFilmBar();
  drawMatch();
}

function exitFilm() {
  if (!film) return;
  film.playing = false;
  clearTimeout(filmTimer);
  filmTimer = null;
  film = null;
  if (filmBarEl) filmBarEl.classList.add("hidden");
  // The lobby owns the page again; the film borrowed the in-match layout to show the map.
  document.body.classList.remove("filming");
  if (!room) {
    document.body.classList.remove("in-match");
    const ctx = board.getContext("2d");
    paintMatch(ctx, boardPayload, null, {
      view: viewForCanvas(), satellites: [], theme: currentTheme(), atlas: fontAtlas,
      badgeMinPx: BADGE_MIN_PX * dpr(), badgeSprites,
    });
    return;
  }
  drawMatch();
}

function filmButton(label, title, run, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "navbtn";
  button.textContent = label;
  button.title = title;
  if (id) button.id = id;
  button.addEventListener("click", run);
  return button;
}

function buildFilmBar() {
  if (filmBarEl) {
    filmBarEl.classList.remove("hidden");
    document.body.classList.add("in-match", "filming");
    return;
  }
  const bar = document.createElement("div");
  bar.id = "filmbar";
  bar.className = "filmbar";
  const label = document.createElement("span");
  label.id = "filmLabel";
  label.className = "filmLabel";
  const log = document.createElement("ol");
  log.id = "filmLog";
  log.className = "filmLog";
  const row = document.createElement("div");
  row.className = "filmControls";
  row.append(
    filmButton("\u25C0", "Previous round", () => filmStep(-1), "filmPrev"),
    filmButton("Play", "Play or pause the film", filmPlay, "filmPlay"),
    filmButton("\u25B6", "Next round", () => filmStep(1), "filmNext"),
    filmButton("1x", "Playback speed", filmSpeed, "filmSpeed"),
  );
  for (const show of FILM_SHOWS) {
    const button = filmButton(FILM_SHOW_LABELS[show], "The original's film view toggles (manual p.35)", () => filmShow(show),
      "filmShow" + show.charAt(0).toUpperCase() + show.slice(1));
    button.dataset.show = show;
    row.append(button);
  }
  row.append(filmButton("Close film", "Leave the film and go back to the lobby", exitFilm, "filmExit"));
  bar.append(label, row, log);
  document.body.append(bar);
  document.body.classList.add("in-match", "filming");
  filmBarEl = bar;
}

function syncFilmBar() {
  if (!filmBarEl || !film) return;
  const play = document.getElementById("filmPlay");
  if (play) play.textContent = film.playing ? "Pause" : "Play";
  const speed = document.getElementById("filmSpeed");
  if (speed) speed.textContent = FILM_SPEED_LABELS[film.speed] || String(film.speed) + "x";
  for (const show of FILM_SHOWS) {
    const button = document.getElementById("filmShow" + show.charAt(0).toUpperCase() + show.slice(1));
    if (button) {
      button.classList.toggle("armed", film.show === show);
      button.setAttribute("aria-pressed", film.show === show ? "true" : "false");
    }
  }
  const label = document.getElementById("filmLabel");
  if (label) {
    const room0 = filmRoomAt(film, film.at);
    const end = room0.over ? " · the last round" : "";
    label.textContent = "Film · " + String(room0.era || "?") + " · round " + room0.round +
      " · frame " + (film.at + 1) + " of " + frameCount(film) + end;
  }
  // The film's log is the recorded events up to this frame, rendered as recorded - never re-derived.
  const log = document.getElementById("filmLog");
  if (log) {
    log.textContent = "";
    const rows = [];
    for (let i = 0; i <= film.at && i < frameCount(film); i += 1) rows.push(...filmEventRows(film.frames[i]));
    for (const row of rows.slice(-40)) {
      const line = document.createElement("li");
      line.textContent = "r" + row.round + " · " + row.text;
      log.append(line);
    }
  }
}

function drawFilmFrame() {
  const ctx = board.getContext("2d");
  const view = viewForCanvas();
  const frameRoom = filmRoomAt(film, film.at);
  const result = paintMatch(ctx, boardPayload, frameRoom, {
    view,
    own: null,
    satellites: [],
    badgeMinPx: BADGE_MIN_PX * dpr(),
    badgeSprites,
    theme: currentTheme(),
    atlas: fontAtlas,
    viewMode: "terrain",
  });
  lastPaint = {
    mode: "film",
    layers: result.layers ? result.layers.slice() : [],
    painted: result.painted || 0,
    political: 0,
    fogged: 0,
  };
}

document.getElementById("filmsBtn")?.addEventListener("click", openFilms);

function paintDialog() {
  const panel = document.getElementById("dialog");
  const body = document.getElementById("dialogBody");
  if (!panel || !body) return;
  for (const button of document.querySelectorAll(".navbtn")) {
    button.classList.toggle("armed", button.dataset.dialog === openDialogId);
    // PB-147: the Buy control is disabled while the match is over, and enabled again by the next
    // match. The panel repaint carries the same rule as renderRoom, so a close and a frame agree.
    if (button.dataset.dialog === "buy") button.disabled = Boolean(room && room.over);
  }
  // A state refresh closes a panel that is a view of a match the page no longer has. The film list is
  // a lobby panel, so it survives having no room (T-031); it is closed by the player, like every other
  // panel (dialogstate's own rule).
  if (!room && openDialogId !== "films") openDialogId = dialogAfter(openDialogId, { type: "refresh", room: false });
  if (!openDialogId) {
    panel.classList.add("hidden");
    return;
  }
  const item = navFor(openDialogId);
  const painter = DIALOG_PAINTERS[openDialogId];
  document.getElementById("dialogTitle").textContent = item ? item.title : openDialogId;
  document.getElementById("dialogHint").textContent = item ? item.hint : "";
  // A state refresh redraws the body, so put back what the player was looking at: the scroll
  // position and the focused control. Closing is the player's decision, not the clock's.
  const view = keepView(body.scrollTop, document.activeElement && body.contains(document.activeElement)
    ? focusKeyOf(document.activeElement)
    : "");
  body.textContent = "";
  panel.classList.remove("hidden");
  if (!painter) return;
  // A dialogue that throws used to leave an empty panel with no explanation. Draw the failure instead:
  // the player gets a sentence, and the console keeps the stack.
  try {
    painter(body);
  } catch (err) {
    body.textContent = "";
    body.append(note("This panel failed to draw: " + (err && err.message ? err.message : String(err))));
    throw err;
  }
  body.scrollTop = view.scrollTop;
  if (view.focusKey) {
    const again = [...body.querySelectorAll("*")].find((element) => focusKeyOf(element) === view.focusKey);
    if (again && typeof again.focus === "function") again.focus({ preventScroll: true });
  }
}

function buildNav() {
  const box = document.getElementById("nav");
  if (!box) return;
  for (const item of NAV) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "navbtn";
    button.dataset.dialog = item.id;
    button.textContent = item.label;
    button.title = item.hint;
    button.addEventListener("click", () => openDialog(item.id));
    box.append(button);
  }
}

document.getElementById("dialogClose")?.addEventListener("click", closeDialog);
buildNav();

// One reconnect policy for both ways a socket can fail: it closed, or it never opened. Kept in one
// function because the second way used to be invisible — see the connect watchdog in connect().
function scheduleReconnect() {
  if (!me || replaced) return;
  if (reconnectTimer) return;
  if (reconnectTries >= RECONNECT_TRIES) {
    say("Lobby connection closed. Reload the page to rejoin.");
    return;
  }
  reconnectTries += 1;
  wasReconnecting = true;
  // Backoff 0.5, 1, 2, then 4 s and no higher (reconnect.mjs). It used to climb to 15 s, which is
  // money a dropped wifi cannot spend: the player is watching a frozen board. One toast only: a
  // cycle of toasts is noise, and the board already says the connection is down by not moving.
  const wait = backoffMs(reconnectTries);
  if (reconnectTries === 1) say("Connection lost. Reconnecting\u2026");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function connect() {
  // Every reconnect is also an opportunity to be told what build is answering now: a deploy is
  // exactly a socket that closed and a welcome that came back from a new container (PB-118).
  loadVersion();
  // A deliberate connect (sign-in, or a reconnect this page decided on) clears the take-down
  // state: the only way back into a replaced tab is a reload or a new sign-in.
  replaced = false;
  // Drop the old socket without letting its close event schedule another reconnect: only the
  // socket that is still the current one gets to do that.
  const previous = socket;
  socket = null;
  if (previous) {
    try {
      previous.close();
    } catch {
      // Already closed.
    }
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(proto + "://" + location.host + "/ws");
  const selfSocket = socket;
  // A connect whose SYN goes into a black hole never settles. The page used to sit inside one such
  // attempt long after the network was back (PB-025: 63 s to recover from a 10 s drop), because a
  // socket that has not opened yet raises no event and the retry schedule never advanced. Cap the
  // attempt: not open after CONNECT_TIMEOUT_MS is a failed try, not a pending one.
  let connectTimer = setTimeout(() => {
    connectTimer = null;
    if (socket !== selfSocket) return;
    if (selfSocket.readyState === WebSocket.OPEN) return;
    socketState = "closed";
    renderDebug();
    try {
      selfSocket.close();
    } catch {
      // Already closed.
    }
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    noteWire(wireLabel(message));
    if (message.op === "welcome") {
      serverRestarting = false;
      // The session check is over: the lobby is behind us, so the "checking" state goes away.
      bootDone();
      if (wasReconnecting) {
        // Say it once, then let the board talk: nothing is worse than a stale "reconnecting".
        wasReconnecting = false;
        say("Reconnected. The match is where you left it.");
      }
      // A returning seat gets its room in the welcome, and the room carries its own log. It MERGES
      // into what this page already holds: a reconnect must not drop rounds already on screen.
      if (message.room && Array.isArray(message.room.log)) noteLog(message.room.log);
      me = message.username;
      users = message.users || [];
      room = message.room;
      showPlay(true);
      renderPeople();
      renderRoom();
      drawMatch();
      flushOrders();
      flushOutbox();
    } else if (message.op === "replaced") {
      // The server handed this session's socket to another tab. Say it once and stand down:
      // reconnecting from here would take the socket back and start the ping-pong again.
      standDown(message.reason);
    } else if (message.op === "bye") {
      // The server is going away on purpose (a deploy drains its sockets). That is not a lost
      // connection, and it must not turn into one: the close that follows is expected, so it is
      // answered with an immediate reconnect instead of the backoff meant for a dead network.
      serverRestarting = true;
      say(message.reason || "The server is restarting. Your match is saved; this page reconnects by itself.");
    } else if (message.op === "presence") {
      users = message.users || [];
      renderPeople();
    } else if (message.op === "invite") {
      pending = pending.filter((item) => item.id !== message.invite.id);
      pending.push(message.invite);
      renderInvites();
      say(message.invite.from + " invited you.");
    } else if (message.op === "invited") {
      say("Invite sent to " + message.invite.to + ".");
    } else if (message.op === "declined") {
      say(message.by + " declined.");
    } else if (message.op === "room") {
      if (!room || !message.room || room.id !== message.room.id) {
        log = emptyLog();
        logView.pinned = true;
        logView.pending = 0;
        // PB-152: a different room starts the economy dialogue on your own page.
        economyView = "own";
      }
      room = message.room;
      // A new round normally drops the previous scan -- the server's reveal is a per-round mark.
      // But the original is continuous real time: a pass that has STARTED must finish even if a
      // remake round ticks under it, so only a finished pass is cleared here (T-022, room 7630).
      if (scan && !scanKeepsAcrossRound(scan, room.round, Date.now(), scan.boardW)) {
        stopIntelScan();
        scan = null;
      }
      // The reveal usually lands in the room message AFTER the ack, so the pass learns its ids and
      // its unit snapshot here as well, and keeps both when a later round drops the reveal.
      if (scan) {
        for (const id of intelOnlyIds()) scan.intelIds.add(id);
        scanAddPieces(scan, room.pieces, room.you);
      }
      if (message.reason) say(message.reason);
      // PB-170: re-point the selection at THIS frame's own piece object. `selected` is a snapshot
      // taken from the frame the click landed on, and a later frame replaces room.pieces, so the
      // old object kept the old `inactive` count and the board note went on saying "Away ... 8
      // rounds" after the aircraft was ready again. Find the piece by id; no piece under that id
      // means nothing is selected any more.
      if (selected) {
        selected = refreshSelection(room && piecesOnScreen(), selected);
        if (!selected) {
          preview = null;
          hoverKey = "";
        }
      }
      // A reload shows the match that has been happening: the room carries its own log. This is also
      // the `sync` frame (15 lines per side): it MERGES into the buffer, deduped, instead of replacing
      // it, so a mid-match resync never shrinks what the reader already has (PB-135 AC3).
      if (room && Array.isArray(room.log)) noteLog(room.log);
      pending = [];
      renderInvites();
      renderPeople();
      renderRoom();
      drawMatch();
    } else if (message.op === "ack") {
      settleOrder(message.id);
      // What a command actually did, in the server's own words.
      for (const event of message.events || []) {
        if (event.note) say(String(event.note));
        if (event.type && event.reveals !== undefined) noteLog([{ round: event.round, text: String(event.note || event.type) }]);
        // My own intel scan: run the measured sweep (Q51). The satellite pass keeps the quiet,
        // instant reveal it already had -- the original's satellite did not shade the map.
        if (event.type === "intel" && room && event.side === room.you) startIntelScan();
      }
      // PB-177 item 1: a mission answers {op:"ack"} rather than {op:"ordered"}, so without this the
      // board note kept offering "Route: N rounds. Click to send the order." over the cell whose
      // order had already gone, until the pointer happened to move. The order is spent: drop the
      // offer and let the note re-derive.
      if (preview) dropHover();
    } else if (message.op === "delta") {
      applyDelta(message.delta);
    } else if (message.op === "placement") {
      if (!buying || String(message.kind) !== String(buying)) return;
      if (message.error || !message.mask) {
        placement = null;
        say(message.error || "Nowhere to place that unit.");
        return;
      }
      const binary = atob(message.mask);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      placement = { width: message.width, height: message.height, mask: bytes, count: message.count, ready: message.ready, unready: message.unready, domain: message.domain, snap: message.snap || null, box: message.box || null };
      drawMatch();
    } else if (message.op === "route") {
      // Late replies for another piece are not this selection's route.
      if (!selected || message.piece !== selected.id) return;
      // PB-177: a reply that was already in flight when the cell was refused (or when the order went)
      // must not put that cell's offer back on the note. The page asked, the answer is stale.
      if (!hoverOffersOrder(hoverOfferKey(selected.id, message.to), refusedHover)) return;
      preview = {
        from: { x: selected.x, y: selected.y },
        to: message.to,
        path: Array.isArray(message.path) ? message.path : [],
        rounds: message.rounds,
        error: message.error || "",
      };
      drawMatch();
    } else if (message.op === "log") {
      noteLog(message.lines);
    } else if (message.op === "bought") {
      settleOrder(message.id);
      say(purchaseText(message.kind, message.site ? { site: message.site } : message.at, message.cash));
      // One purchase lands, the cursor goes: the next click is a map click again (PB-047). A buy
      // that is REFUSED keeps the cursor armed - a mis-click must not cost the mode - but a landed
      // purchase is the end of the arming, exactly like closing the menu.
      buying = null;
      placement = null;
      drawMatch();
      renderRoom();
    } else if (message.op === "ordered") {
      settleOrder(message.id);
      // An accepted order clears the selection (the PM's ruling, 2026-11-15) - and it says so, so a
      // player who thought they were selecting a piece is not left clicking at nothing with the
      // generic hint (T-030 AC8 items 2 and 5). The path that just went on the wire stays drawn.
      const hadSelection = Boolean(selected);
      say(ackText(message) + (hadSelection ? " Selection cleared." : ""));
      // An order is the player's own act, so it belongs in the log beside what the round did.
      noteLog([{ round: room && room.round ? room.round : 0, text: ackText(message).replace(/\.$/, "") }]);
      clearCommand();
    } else if (message.op === "speed") {
      // The server's own speed frame is the authority for the readout and both guards. Before this
      // the header moved only because a room frame happened to follow, and a step the server treated
      // as a no-op (the top of the range) could leave the header and the room disagreeing about the
      // same number (PB-129).
      if (room) room.speed = Number(message.speed);
      syncSpeed();
    } else if (message.op === "error") {
      // The server's sentence is what the player reads. It is never swallowed, and a queued
      // order that was refused says which one.
      settleOrder(message.id);
      // PB-242 AC2: the sentence the server sent stays byte-identical and is what the player reads;
      // the ground the aim read is appended as its own clause on the SAME line, because a lake and
      // the open sea both refusing with one sentence is the defect this ticket is about. The field
      // arrived dead before the lobby copy-through: main.mjs forwarded reason/terrain as null and
      // this handler had nothing to print. Naming the ground inside the sentence itself is PB-240's.
      const refusal = refusalLine(message);
      // PB-044 (T-021 AC8): the player reads the sentence, never the internal order id. The id
      // stays in the console, where a developer can still trace a queued order.
      if (message.id) console.debug("[order " + message.id + "] " + refusal);
      say(refusal);
      // The Log panel keeps a line for the refusal too, so it survives the flash going away.
      const ground = refusalGround(message);
      if (ground) noteLog([{ round: room && room.round ? room.round : 0, text: ground }]);
      // PB-177 item 4: the refusal re-derives the note instead of leaving the previous offer up, and
      // the hovered cell is remembered by key so a route reply still in flight cannot restore it.
      refusedHover = hoverKey || (preview && preview.to
        ? hoverOfferKey(selected && selected.id, preview.to)
        : "");
      dropHover();
    }
  });
  socket.addEventListener("close", (event) => {
    if (socket !== selfSocket) return;
    clearTimeout(connectTimer);
    socketState = "closed";
    renderDebug();
    // A takeover is not a dropped connection: the other tab has the socket on purpose. Say
    // the one sentence and stay off. Before this, the older tab reconnected and the two tabs
    // took the socket back and forth every couple of seconds.
    if ((event && Number(event.code) === TAKEOVER_CODE) || replaced) {
      standDown();
      return;
    }
    // A deploy, a sleeping laptop or a dropped wifi all look the same from here. Reconnect by
    // itself, backing off, and let the welcome message restore the room and its log. The tries
    // cap, the in-flight guard and the "reload the page" sentence all live in scheduleReconnect.
    // A deploy told us it was leaving (op "bye"): retry at once, without the network backoff and
    // without the "Connection lost" sentence, because nothing was lost. Before this the drain's
    // own message was overwritten 400 ms later by "Connection lost. Reconnecting…" and the page
    // waited up to 15 s while the new container booted (T-007 AC3(a)).
    if (serverRestarting) {
      wasReconnecting = true;
      say("The server is restarting. Reconnecting…");
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 250);
      }
      return;
    }
    scheduleReconnect();
  });
  socket.addEventListener("open", () => {
    clearTimeout(connectTimer);
    reconnectTries = 0;
    socketState = "open";
    renderDebug();
    flushOutbox();
  });
}

async function signOut() {
  await post("/api/logout");
  if (socket) socket.close();
  me = "";
  room = null;
  users = [];
  pending = [];
  showPlay(false);
  drawMatch();
  say("");
  flashLine.clearResult();
}

document.querySelector("#login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  try {
    await post("/api/login", { username: fields.get("username"), password: fields.get("password") });
    connect();
  } catch (err) {
    say(err.message);
  }
});

document.querySelector("#register").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  try {
    await post("/api/register", { username: fields.get("username"), password: fields.get("password") });
    connect();
  } catch (err) {
    say(err.message);
  }
});

// A password that cannot be changed is a password that cannot be un-leaked.
document.querySelector("#password").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  try {
    const result = await post("/api/password", {
      current: fields.get("current"),
      next: fields.get("next"),
    });
    event.target.reset();
    say("Password changed." + (result && result.ended ? " " + result.ended + " other session(s) ended." : ""));
  } catch (err) {
    say(err.message);
  }
});

// The opponent's starting-money spinner (Manual p.17). Its per-era default, range and step come
// from config/game.json through /api/setup; the page types none of them. In 2023 the original had
// no spinner at all, so the field is disabled and the bot starts on the same large pool.
const launchForm = document.querySelector("#launch");
const eraSelect = launchForm ? launchForm.querySelector('select[name="era"]') : null;
const handicapInput = launchForm ? launchForm.querySelector('input[name="handicap"]') : null;
const handicapNote = document.getElementById("handicapNote");
let setupTable = null;

function applyHandicap() {
  if (!setupTable || !eraSelect || !handicapInput) return;
  const spec = setupTable.handicap || {};
  const defaults = spec.defaults || {};
  const value = defaults[String(eraSelect.value)];
  handicapInput.min = String(Number.isFinite(Number(spec.min)) ? spec.min : 0);
  handicapInput.max = String(Number.isFinite(Number(spec.max)) ? spec.max : 999);
  handicapInput.step = String(Number.isFinite(Number(spec.step)) ? spec.step : 1);
  const hasSpinner = value !== null && value !== undefined && Number.isFinite(Number(value));
  handicapInput.disabled = !hasSpinner;
  handicapInput.value = hasSpinner ? String(value) : "";
  if (handicapNote) {
    handicapNote.textContent = hasSpinner
      ? "The original's spinner (manual p.17) sets what your opponent starts with, in whole billions, as a handicap. Your own opening pool comes from the era."
      : "This era has no opponent spinner (manual p.16): both sides open on the same large pool.";
  }
}

if (eraSelect) eraSelect.addEventListener("change", applyHandicap);
// PB-125: the lobby preview is era-aware, so changing the era redraws the pre-room frame with that
// year's own capitals. Purely local: no room exists yet, and the payload already carries every
// file era's rows.
if (eraSelect) {
  eraSelect.addEventListener("change", () => {
    boardPayload.era = String(eraSelect.value || "");
    drawMatch();
  });
}
fetch("/api/setup")
  .then((res) => res.json())
  .then((data) => {
    setupTable = data;
    applyHandicap();
  })
  .catch(() => {});

document.querySelector("#launch").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  const message = { op: "bot", era: fields.get("era"), side: fields.get("side") };
  // A disabled field sends nothing: the server then uses the era's default, which is the same
  // number the field would have carried.
  if (handicapInput && !handicapInput.disabled && String(handicapInput.value).trim() !== "") {
    message.handicap = Number(handicapInput.value);
  }
  send(message);
});

// Keep the capitals labelled even before a room exists.
renderLegend();

loadBoard();
loadFontAtlas();

// The footer names the build this page is talking to. It is a fetch, not a baked string, so a tab
// that outlives a deploy can be told what it is served now instead of naming the build it loaded
// (PB-118). One function, three call sites: startup, the top of connect() (the single funnel a
// first connect and every reconnect pass through — scheduleReconnect() only schedules a connect()),
// and a window focus, which is the cheapest way to notice a deploy on a tab that never dropped.
//
// The sequence number is not decoration: a focus during a slow reconnect puts two reads in flight,
// and without it the older answer could land last and put a dead build back in the footer.
let versionSeq = 0;
// PB-140: one warn per outage episode, not one per 250 ms reconnect retry (C1/C2 — module scope, so
// a retry does not re-initialise it; cleared only by a successful read, so a second outage warns).
let versionOutageWarned = false;
function loadVersion() {
  const seq = ++versionSeq;
  fetch("/api/version", { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then((data) => {
      if (seq !== versionSeq) return;
      // C3 (PM 7144 symmetric variant): clear immediately after the success guard, BEFORE the footer
      // lookup, so a page with no #buildCommit resets too — the SET/warn sits above that same lookup.
      versionOutageWarned = false;
      const line = document.getElementById("buildCommit");
      if (!line) return;
      // Hidden while booting and empty until the answer: "build unknown" on the way in was the
      // second half of the reload flash (T-007 AC5). A FAILED read is not that case — it is said
      // out loud below, and it never flashes because it replaces a footer that was already blank.
      line.textContent = data && data.short ? "build " + data.short : "";
      line.title = String((data && data.commit) || "");
      delete line.dataset.build;
    })
    .catch((err) => {
      // A footer that silently keeps naming a build the server no longer serves is exactly the
      // defect this exists to end, so a failed read says so where a player can see it. A tooltip
      // alone is not a signal (nobody hovers a footer), so the text changes too, and the console
      // keeps the reason for whoever is looking.
      if (seq !== versionSeq) return;
      // C1/AC3: the flag ALONE gates the warn — not coupled to `unknown`, or a tab holding a sha
      // would stay silent for the whole outage and m2 could not red.
      if (!versionOutageWarned) {
        versionOutageWarned = true;
        console.warn("PB-118: /api/version could not be read:", err && err.message ? err.message : err);
      }
      const line = document.getElementById("buildCommit");
      if (!line) return;
      const unknown = line.textContent === "" || line.dataset.build === "error";
      // C1: never overwrite a sha this page already has. A tab that outlives a deploy keeps naming
      // the build it is talking to; only a footer that knows nothing gets the failure text.
      if (unknown) {
        line.textContent = "build unknown";
        line.title = "Could not read /api/version: " + (err && err.message ? err.message : String(err));
        line.dataset.build = "error";
      }
    });
}

loadVersion();

// A deploy does not have to drop the socket to be noticed: coming back to a tab is the moment a
// player asks what they are looking at, so the stamp is re-read then too.
window.addEventListener("focus", () => loadVersion());

// The session check decides what the page is: a signed-in lobby or the sign-in form. Until it
// answers the page stays in its "checking" state, so neither flashes (T-007 AC5).
function startSession() {
  fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.user) {
        connect();
        return;
      }
      showPlay(false);
      bootDone();
    })
    .catch(() => {
      // A server that cannot answer is not a signed-in session: show the form.
      showPlay(false);
      bootDone();
    });
}
startSession();

// ---- the E2E hook ---------------------------------------------------------
// The Playwright suite drives this page like a player: it clicks the lobby, the Buy rows and the
// canvas. Two things it cannot guess are where a cell is on screen and which cells the server has
// said a purchase may stand on, so the page answers those from its own camera and its own mask.
// Nothing here changes a rule or a state; every action still goes through the same send() path a
// click uses.
window.__chq = {
  me: () => me,
  users: () => users.slice(),
  room: () => room,
  socketState: () => socketState,
  toast: () => flash.textContent || "",
  // PB-137: the match-over line, which is not a flash and must outlive the flash timer.
  result: () => (resultLine && resultLine.textContent) || "",
  // The board's own one-liner. It sits under the canvas and used to disagree with the toast
  // (PB-053), so the e2e reads both (T-030 AC4).
  note: () => (boardNote && boardNote.textContent) || "",
  // The drawn span of the hovered route, measured the way the painter draws it (T-030 AC5).
  previewSpan: () => {
    const span = routeSpan(preview, viewForCanvas());
    const points = routePolyline(preview, viewForCanvas());
    const boardW = Number(viewForCanvas().boardW) || 320;
    return {
      has: Boolean(preview),
      rounds: preview ? Number(preview.rounds) || 0 : 0,
      crossing: points.some((p) => p.x >= boardW || p.x < 0),
      ...span,
    };
  },
  selectPulse: () => selectPulse,
  outbox: () => outbox.length,
  wire: () => wireLog.slice(),
  board: () => boardPayload,
  // The last frame's own report: the layer order, how many fog rects were painted, the ownership
  // tally. T-019's shot leg asserts fog presence and the fill-under-fog order from this, not from
  // a screenshot.
  paintReport: () => lastPaint,
  // The names the painter puts beside capitals, from the room's own era rows (PB-022). The canvas is
  // pixels, so a screenshot cannot be read back: this is the same call the frame makes.
  capitalLabels: () => capitalMarkers(boardPayload, room).map((c) => ({ name: c.name, x: c.x, y: c.y, side: c.side, color: c.color })),
  log: () => log.lines.slice(),
  state: () => ({
    buying,
    selected: selected ? selected.id : null,
    placement: Boolean(placement),
    placementSnap: placement ? placement.snap : null,
    placementBox: placement ? placement.box : null,
    following,
    camera: camera ? { scale: camera.scale, left: camera.left, top: camera.top } : null,
  }),
  cellToScreen(x, y) {
    const view = viewForCanvas();
    const rect = board.getBoundingClientRect();
    const px = cellToPixel(wrapX(Number(x), view.boardW), Number(y), view);
    const ratio = board.width / Math.max(1, rect.width);
    return { x: rect.left + px.x / ratio, y: rect.top + px.y / ratio };
  },
  screenToCell(x, y) {
    const view = viewForCanvas();
    const rect = board.getBoundingClientRect();
    const ratio = board.width / Math.max(1, rect.width);
    return pixelToCell((Number(x) - rect.left) * ratio, (Number(y) - rect.top) * ratio, view);
  },
  // The cells the server's own placement mask allows, as a list. `placement.mask` is already a
  // Uint8Array here (the socket's base64 is decoded on arrival), so index it directly. `ready` is
  // the mask byte: 1 a ready city or base, 2 a friendly site that is ready soon, 3 one that is a
  // long way off (PB-165: the original's three readiness box colours, manual p.14).
  legalCells(limit = 200) {
    if (!placement || !placement.mask) return [];
    const mask = placement.mask;
    const width = Number(placement.width) || 320;
    const out = [];
    for (let i = 0; i < mask.length && out.length < limit; i++) {
      if (!mask[i]) continue;
      out.push({ x: i % width, y: Math.floor(i / width), ready: mask[i] === 1, unready: mask[i] > 1, box: mask[i] });
    }
    return out;
  },
  // Kill the lobby socket the way a dead network would, so the suite can prove a Play clicked while
  // it is down is queued. The page reconnects on its own, exactly as it does after a real drop.
  dropSocket() {
    if (socket) socket.close();
  },
  send: (message) => send(message),
  // Time one full paint of the frame that is on screen, in milliseconds (T-014 AC5). The canvas is
  // pixels: a screenshot cannot be read back, and timing a click would fold in the camera change.
  // The one-pixel readback is what makes the number include rasterisation rather than only the JS
  // that builds the frame.
  paint() {
    const ctx = board.getContext("2d");
    const t0 = performance.now();
    drawMatch();
    ctx.getImageData(0, 0, 1, 1);
    return performance.now() - t0;
  },
};
