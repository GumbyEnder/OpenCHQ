import {
  capitalMarkers, cellToPixel, centerOn, clampZoom, fitViewport, legendEntries, MIN_ZOOM, paintMatch,
  panBy, pixelToCell, paintPlacement, rememberSeen, sightTable, statusLine, wrapX, zoomAt,
} from "./render.mjs";
import { unitLabel } from "./units.mjs";
import {
  PICK_HINT,
  ackText,
  airNote,
  alarmText,
  buyMessage,
  cargoNote,
  cellAtEvent,
  missionMessage,
  orderMessage,
  ownPieceAt,
  previewLine,
  purseText,
  refusalText,
  routeRequest,
} from "./command.mjs";
import { chromeGeometry, roundFraction, timeLeftText } from "./chrome.mjs";
import { fitScale, textBitmap, validateAtlas } from "./font.mjs";
// The shell: the strip a match collapses the navigation into, and the box the map may fill.
import { BOARD_H, BOARD_W, debugRows, fitCells, stripInfo } from "./shell.mjs";
// The navigation itself, and the two dialogues this page was missing: buying and the economy.
import { NAV, buyRows, economyModel, navFor, reserveLine, untypedCount } from "./dialogs.mjs";
// Per-type silhouettes: one shape for the map at zoom, the same shape beside the name in Buy.
import { glyphDataUrl } from "./glyphs.mjs";
import { dialogAfter, focusKeyOf, keepView } from "./dialogstate.mjs";
import { formatBillions, formatWholeBillions, purchaseText } from "./command.mjs";
import { createOrderWatch, queuedText } from "./orderwatch.mjs";
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
const orderWatch = createOrderWatch({ onLate: (order) => say(queuedText(order.kind || "order")) });
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
let preview = null;
let hoverKey = "";
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
  flash.textContent = text || "";
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
  if (result && result.reason === "capitals" && result.lastCapital && result.lastCapital.name) {
    const who = result.winner === mine
      ? "You win"
      : result.winner === "blue" ? "Blue wins" : result.winner === "red" ? "Red wins" : "The match is over";
    say(who + ": " + result.lastCapital.name + " fell at round " + result.lastCapital.round + "." + list);
    return;
  }
  const note = typeof room.note === "string" ? room.note.trim() : "";
  if (note) {
    say(note + list);
    return;
  }
  say(room.winner && mine ? (room.winner === mine ? "You have won." : "You lost.") : "The match is over.");
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
  // A hidden band takes no room: reserving its height anyway is how the map ends up smaller than the
  // window for a reason nobody can see on the page.
  const bandH = band && !band.classList.contains("hidden")
    ? Math.round(band.getBoundingClientRect().height)
    : 0;
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
      camera = { ...fit, scale: Math.max(MIN_ZOOM, Math.min(64, old.scale)) };
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
  return camera;
}

// Follow: the selected piece stays in the middle as the clock runs. It is OFF by default and only
// ever runs when the player armed it with the Follow button: a camera that moves because a unit was
// selected, or because a placement is pending, is the camera fighting the player (T-007 AC10).
let following = false;

// Terrain is the original's map; political is the same map with each city coloured by whoever holds
// it. The toggle only changes what is drawn on top, never the camera or the board.
let viewMode = "terrain";

function setViewMode(next) {
  viewMode = next === "political" ? "political" : "terrain";
  const button = document.getElementById("viewToggle");
  if (button) {
    button.classList.toggle("armed", viewMode === "political");
    button.textContent = viewMode === "political" ? "Terrain" : "Political";
  }
  drawMatch();
}

let sawRoom = false;

// Fit shows the whole world, which is what the original game put on the screen: one planet, all of
// it, with a click to zoom. It used to reset to the legible 8 px default, so "Fit" never fitted.
function refit() {
  userCamera = false;
  sizeCanvas();
  const fit = fitViewport(board.width, board.height, boardPayload.width || 320, boardPayload.height || 136, 64);
  camera = { ...fit, scale: Math.max(MIN_ZOOM, fit.scale) };
  drawMatch();
}

function zoomStep(factor) {
  userCamera = true;
  const view = viewForCanvas();
  camera = zoomAt(view, factor, view.viewW / 2, view.viewH / 2);
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

function renderLegend() {
  if (!legendBox) return;
  legendBox.textContent = "";
  for (const entry of legendEntries()) {
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
  const wasHidden = chrome.classList.contains("hidden");
  if (!room || !room.round) {
    chrome.classList.add("hidden");
    if (!wasHidden) applyCanvasCss();
    return;
  }
  chrome.classList.remove("hidden");
  // The band arriving takes room from the map, and this runs after the canvas was sized.
  if (wasHidden) applyCanvasCss();
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
  // The debug window follows the clock at a readable rate rather than on every frame.
  if (debugOpen && Date.now() - debugPaintedAt > 250) {
    debugPaintedAt = Date.now();
    renderDebug();
  }
}

setInterval(tickChrome, 100);

function drawMatch() {
  const ctx = board.getContext("2d");
  let view = viewForCanvas();
  // Follow the selected piece: a zoomed view that leaves the piece behind is a worse camera than
  // no zoom at all.
  // Never while a placement is pending: the cell the player is aiming at must not slide away.
  if (following && selected && !buying && !placement) {
    camera = centerOn(selected, view);
    view = camera;
  }
  const result = paintMatch(ctx, boardPayload, room, {
    view,
    own: room && room.you,
    preview,
    fog: fogFor(view),
    sight: Number(boardPayload.sightCells || 8),
    sightAt: selected,
    viewMode,
    // The original's lettering for city names, once the camera is close enough to read them.
    atlas: fontAtlas,
  });
  // While a unit is armed, the cells the server will accept are painted underneath everything else.
  if (placement) paintPlacement(ctx, placement, view);
  paintChrome(view);
  const camNote = document.getElementById("camNote");
  if (camNote) {
    camNote.textContent = "cell " + (view.scale / dpr()).toFixed(0) + " px · " +
      (following ? "following" : "free");
  }
  // A crossing nobody screens is said out loud, in the seat's own words, before the loss.
  const unscreened = Array.isArray(room && room.unscreened) ? room.unscreened : [];
  const escortNote = unscreened.length === 0 ? ""
    : unscreened.length === 1 ? "A transport is crossing unscreened."
    : unscreened.length + " transports are crossing unscreened.";
  // In the political view the note says what the colours mean, counted from the patches on screen.
  const politicalNote = result.tally
    ? "Political: blue holds " + result.tally.blue + ", red holds " + result.tally.red +
      ", neutral " + result.tally.neutral + "."
    : "";
  boardNote.textContent = politicalNote || escortNote ||
    previewLine(preview) || cargoNote(selected) || airNote(selected) || statusLine(boardPayload, room, result);
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

// The round log. A running clock is dead time unless it reports itself: every line here came
// from the server already filtered to what this seat could see.
let roundLog = [];
const LOG_KEEP = 60;
const LOG_SHOWN = 8;

let logKeys = new Set();

function noteLog(lines) {
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || !line.text) continue;
    // A sighting repeats every round the enemy stays visible. Say it once.
    if (line.key) {
      if (logKeys.has(line.key)) continue;
      logKeys.add(line.key);
    }
    roundLog.push({ round: Number(line.round) || 0, text: String(line.text) });
  }
  if (roundLog.length > LOG_KEEP) roundLog = roundLog.slice(-LOG_KEEP);
  const list = document.getElementById("roundLog");
  if (list) paintLog(list);
}

function clearCommand() {
  selected = null;
  buying = null;
  placement = null;
  preview = null;
  hoverKey = "";
  fogSeen = null;
  fogKey = "";
  drawMatch();
}

function askRoute(cell) {
  if (!selected || !cell) return;
  const key = selected.id + ":" + cell.x + "," + cell.y;
  if (key === hoverKey) return;
  hoverKey = key;
  send(routeRequest(selected, cell));
}

// Click a piece: it is selected and the next click is a destination. Click a cell with a
// piece selected: the order goes to the server as {op:"order",piece,to:{x,y}}.
board.addEventListener("click", (event) => {
  if (!room || !room.you) return;
  const cell = cellAtEvent(event, board, viewForCanvas());
  if (!cell) return;

  // A unit on the build cursor claims the click: the cell has to be one of the seat's own
  // sites, and the server decides whether the purchase is legal.
  if (buying) {
    // The server owns the rule for where a purchase may stand; the page sends the cell the player
    // picked and repeats the refusal in the server's own words when it comes back.
    // The cursor stays armed until a purchase actually lands: a refused cell must not cost the
    // player their place-in-mode, and buying several units in a row is the normal case.
    sendOrder(buyMessage(buying, cell));
    drawMatch();
    return;
  }

  const mine = ownPieceAt(room.pieces, cell, room.you);
  if (mine) {
    selected = mine;
    preview = null;
    hoverKey = mine.id + ":" + mine.x + "," + mine.y;
    // Selecting a piece does not move the camera. It used to centre a zoomed view on the piece,
    // which read as the map jumping under the click that made the selection (T-007 AC10).
    say(PICK_HINT + " Then pick a destination.");
    drawMatch();
    return;
  }
  if (!selected) {
    say(PICK_HINT);
    return;
  }
  // An aircraft is flown, not walked: the cell the player clicks is the strike's target, and the
  // plane's own cell stays its base. Without this the only aim the page had was the plane's base
  // cell, where no enemy ever stands (T-003 hand check 4).
  if (selected.kind === "aircraft" || selected.domain === "air") {
    const mission = missionMessage(selected, "strike", cell);
    if (mission) sendOrder(mission);
    return;
  }
  const message = orderMessage(selected, cell);
  if (message) sendOrder(message);
});

board.addEventListener("mousemove", (event) => {
  if (!room || !room.you || !selected) return;
  askRoute(cellAtEvent(event, board, viewForCanvas()));
});

board.addEventListener("mouseleave", () => {
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

board.addEventListener("wheel", (event) => {
  event.preventDefault();
  const at = screenPoint(event);
  userCamera = true;
  camera = zoomAt(viewForCanvas(), event.deltaY < 0 ? 1.25 : 0.8, at.x, at.y);
  drawMatch();
}, { passive: false });

let panFrom = null;
board.addEventListener("contextmenu", (event) => event.preventDefault());
board.addEventListener("pointerdown", (event) => {
  if (event.button !== 2) return;
  event.preventDefault();
  panFrom = { x: event.clientX, y: event.clientY };
  board.setPointerCapture?.(event.pointerId);
});
board.addEventListener("pointermove", (event) => {
  if (!panFrom) return;
  userCamera = true;
  camera = panBy(viewForCanvas(), event.clientX - panFrom.x, event.clientY - panFrom.y);
  panFrom = { x: event.clientX, y: event.clientY };
  drawMatch();
});
board.addEventListener("pointerup", () => {
  panFrom = null;
});
window.addEventListener("keydown", (event) => {
  // Typing a name or a password is not a command: the shortcuts only apply away from the gate's
  // fields.
  const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  const view = viewForCanvas();
  const step = 8 * view.scale;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  // Escape is the way out of a dialogue, which is what the original's Buy Units menu did too.
  if (event.key === "Escape" && openDialogId) {
    closeDialog();
    return;
  }
  if (event.key === "b" || event.key === "B") return openDialog("buy");
  if (event.key === "e" || event.key === "E") return openDialog("economy");
  if (event.key === "p" || event.key === "P") return setViewMode(viewMode === "political" ? "terrain" : "political");
  if (event.key === "+" || event.key === "=") return zoomStep(1.4);
  if (event.key === "-" || event.key === "_") return zoomStep(0.7);
  if (event.key === "0") return refit();
  if (event.key === "f" || event.key === "F") return setFollow(!following);
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  camera = panBy(view, move[0], move[1]);
  drawMatch();
});

window.addEventListener("resize", () => refit());

document.getElementById("camIn")?.addEventListener("click", () => zoomStep(1.4));
document.getElementById("camOut")?.addEventListener("click", () => zoomStep(0.7));
document.getElementById("camFit")?.addEventListener("click", () => refit());
document.getElementById("viewToggle")?.addEventListener("click", () => setViewMode(viewMode === "political" ? "terrain" : "political"));
document.getElementById("camFollow")?.addEventListener("click", () => setFollow(!following));

async function loadBoard() {
  // A board fetch that loses a race with server startup used to leave the page on the schematic for
  // the rest of its life. Try twice before believing the extract is really absent.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/board", { credentials: "same-origin" });
      const payload = await res.json();
      if (payload && typeof payload === "object") {
        boardPayload = payload;
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
  account.textContent = me + " ";
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

function syncSpeed() {
  const speed = roomSpeed();
  if (speedReadout) {
    speedReadout.textContent = "Speed " + speed + (speed === 0 ? " \u00b7 paused" : "");
  }
  if (speedDown) speedDown.disabled = !room || speed <= 0;
  if (speedUp) speedUp.disabled = !room || speed >= 6;
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
  const info = document.getElementById("stripInfo");
  if (info) info.textContent = stripInfo(room);
  // The purse at a glance: the economy dialogue explains it, this is the number a player wants to
  // see without opening anything.
  const purse = document.getElementById("purseChip");
  if (purse) purse.textContent = room && room.seat ? purseText(room.seat) : "";
  syncGameButtons();
  renderDebug();
  paintDialog();
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
  if (document.body.classList.contains("in-match") !== Boolean(room)) syncShell();
  else {
    const info = document.getElementById("stripInfo");
    if (info) info.textContent = stripInfo(room);
    renderDebug();
  }
  if (room && room.over) sayResult(room);
  syncPauseBanner(room);
  roomBox.className = room ? "" : "room-empty";
  roomBox.textContent = "";
  if (!room) {
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
    purse.textContent = purseText(room.seat);
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

function toolRow(room) {
  const list = Array.isArray(room && room.tools) ? room.tools : [];
  const wanted = list.filter((tool) => TOOL_WORDS[tool.name]);
  if (!wanted.length) return null;
  const row = document.createElement("div");
  row.className = "shop tools";
  // The server's own words for each tool: what it does, what it costs a side, and every stand-in
  // named as one. The page never writes this text itself, so it cannot disagree with the rule.
  const kit = ((room && room.seat && room.seat.kit) || []);
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
    button.addEventListener("click", () => send({ op: "tool", tool: tool.name }));
    row.append(button);
  }
  // The consequences of the kit, in text rather than in a tooltip: a player should be able to read
  // that a nuke paints nothing before they fire one.
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
        button.textContent = mission.label + " (" + mission.rounds + "r)";
        button.disabled = !briefing.ready || !briefing.canFly;
        button.title = !briefing.canFly
          ? "No friendly city, dock or ship in reach."
          : !briefing.ready
            ? "This aircraft is away for " + briefing.roundsLeft + " more rounds."
            : mission.mode === "strike"
              ? "Pick the target cell on the map; the aircraft flies there for " + mission.rounds + " rounds."
              : "Fly it now; the aircraft is gone for " + mission.rounds + " rounds.";
        button.addEventListener("click", () => {
          // A strike hits the cell the player names, not the base the plane sits on. A scramble is
          // a patrol around that base, so its own cell is the right target for it.
          if (mission.mode === "strike") {
            say("Strike: pick the target cell on the map.");
            closeDialog();
            return;
          }
          send({ op: "mission", piece: selected.id, mode: mission.mode, to: { x: selected.x, y: selected.y } });
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

function paintLog(list) {
  list.textContent = "";
  for (const line of roundLog.slice(-LOG_SHOWN)) {
    const item = document.createElement("li");
    item.textContent = "round " + line.round + " \u2014 " + line.text;
    list.append(item);
  }
}

// A delta is the difference since the frame this page already has. If the round does not follow
// on from the one on screen, the page has missed something and asks for the whole room rather
// than patching a guess.
function applyDelta(delta) {
  if (!room || !delta) return;
  const next = Number(delta.round) || 0;
  const here = Number(room.round) || 0;
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
    // The end of a match is a one-round fact, and the delta is the frame most seats see it in. The
    // page used to learn "over" only from a whole frame, so a seat on deltas kept playing past the
    // end - the harness watched one do it for ten minutes.
    over: delta.over === undefined ? room.over : Boolean(delta.over),
    winner: delta.winner === undefined ? room.winner : delta.winner,
    result: delta.result === undefined ? room.result : delta.result,
  };
  if (selected && !byId.has(selected.id)) {
    selected = null;
    preview = null;
    hoverKey = "";
  }
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
function syncPauseBanner(room) {
  const banner = document.getElementById("pauseBanner");
  if (!banner) return;
  const paused = Boolean(room) && !room.over && String(room.clock || "") !== "running";
  banner.textContent = paused ? "Paused - press Play to resume" : "";
  banner.classList.toggle("hidden", !paused);
}

// ---- the debug window ----------------------------------------------------
// Top right, closed by default, and opened by a button that is always there. It reports what the
// page has actually been told - the socket's state, the board's provenance, the room's own fields -
// plus the last frames off the wire, because "the round is not moving" is a wire question first.
const WIRE_KEEP = 40;
const wireLog = [];
let socketState = "closed";
let debugOpen = false;
let debugPaintedAt = 0;
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
  });
  const list = document.getElementById("debugRows");
  list.textContent = "";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
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
  if (!room) {
    say("Start a match first.");
    return;
  }
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
      const icon = document.createElement("img");
      icon.className = "uniticon";
      icon.alt = "";
      icon.src = glyphDataUrl(row.kind, "#bfe3ff");
      // The row names the unit the way the sentence that follows a purchase names it (T-007 AC7).
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
          send({ op: "tool", tool: row.tool });
          say("Use " + row.kind + ".");
          closeDialog();
        });
      } else {
        line.title = "Arm this, then click one of your " + (row.domain === "sea" ? "docks" : "cities") + ".";
        line.addEventListener("click", () => {
          buying = row.kind;
          selected = null;
          preview = null;
          placement = null;
          // Ask the server where this unit may stand, and paint its answer.
          send({ op: "placement", kind: row.kind });
          // The sentence names the rule the server just enforced: a site cell this side owns,
          // not a radius and not coastal water (D-019).
          say("Buy " + row.kind + ": " + (row.domain === "sea"
            ? "click one of the highlighted docks you hold to place it."
            : "click one of the highlighted cities or bases you hold to place it."));
          closeDialog();
        });
      }
      table.append(line);
    }
    body.append(table, note("Seen counts only enemy units this seat can see. Prices are the server's."));
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
    const dl = document.createElement("dl");
    dl.className = "dlgrid";
    definition(dl, "Pool", model.cash === null ? "unknown" : formatWholeBillions(model.cash) + "b");
    definition(dl, "Next payday", model.payIn === null ? "unknown" : "in " + model.payIn + (model.payIn === 1 ? " round" : " rounds"));
    definition(dl, "Payday every", model.payEvery === null ? "unknown" : model.payEvery + (model.payEvery === 1 ? " round" : " rounds"));
    definition(dl, "Payday worth", model.income
      ? formatBillions(model.income.amount) + "b per round · " + model.income.cities + " cities + " + model.income.cashWells + " paying oil"
      : "unknown");
    definition(dl, "Cities held", String(model.held.city));
    definition(dl, "Docks held", String(model.held.dock));
    definition(dl, "Oilfields held", String(model.held.well));
    definition(dl, "Your units", String(model.units.own));
    definition(dl, "Enemy units seen", String(model.units.known));
    body.append(dl);
    if (model.reserves.length) {
      const label = document.createElement("p");
      label.className = "dialoglabels";
      label.textContent = "Stocks";
      const list = document.createElement("ul");
      list.className = "reserves";
      for (const meter of model.reserves) {
        const item = document.createElement("li");
        item.textContent = reserveLine(meter);
        if (meter.kind === "steel") {
          item.title = "Steel is a non-original owner choice (D-003); the 1990 game had oil only.";
        }
        list.append(item);
      }
      body.append(label, list);
    }
    // The rate is read off the state the server sent, never typed here (prices node, grep guard).
    const perCity = model.income && model.income.cities > 0 ? model.income.amount / model.income.cities : null;
    const every = model.payEvery === null || model.payEvery === undefined ? " every round" : (model.payEvery === 1 ? " every round" : " every " + model.payEvery + " rounds");
    body.append(note("Each city pays " + (perCity === null ? "its rate" : formatBillions(perCity) + " billion") + every +
      ". Oilfields give oil, never cash. Bases and capitals pay nothing."));
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
        button.title = "Away for " + mission.rounds + " rounds.";
        button.disabled = !plane.ready;
        button.addEventListener("click", () => {
          // A strike is aimed: the air dialog names the plane and hands the player the map, because
          // the cell the plane sits on is its base and never holds an enemy (T-003).
          if (mission.mode === "strike") {
            const planePiece = (room.pieces || []).find((piece) => piece.id === plane.id);
            if (planePiece) selected = planePiece;
            say("Strike: pick the target cell on the map.");
            closeDialog();
            drawMatch();
            return;
          }
          send({ op: "mission", piece: plane.id, mode: mission.mode, to: { x: plane.x, y: plane.y } });
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
      act("Zoom in", "Bigger cells (+)", () => zoomStep(1.4)),
      act("Zoom out", "Smaller cells (-)", () => zoomStep(0.7)),
      act("Whole world", "Fit the planet (0)", () => refit()),
      act(viewMode === "political" ? "Terrain" : "Political", "Who holds what (P)",
        () => setViewMode(viewMode === "political" ? "terrain" : "political")),
      act(following ? "Stop following" : "Follow piece", "Keep the selected piece centred (F)",
        () => setFollow(!following)),
    );
    const state = document.createElement("p");
    state.className = "dialogfoot";
    state.textContent = "cell " + Math.max(1, Math.round((camera ? camera.scale : 1) / dpr())) +
      " px · " + (following ? "following" : "free") + " · " + viewMode;
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
    if (!roundLog.length) {
      body.append(note("Nothing has happened yet. The clock reports itself here once it runs."));
      return;
    }
    const list = document.createElement("ol");
    list.className = "roundLog";
    body.append(list);
    paintLog(list);
  },
};

function paintDialog() {
  const panel = document.getElementById("dialog");
  const body = document.getElementById("dialogBody");
  if (!panel || !body) return;
  for (const button of document.querySelectorAll(".navbtn")) {
    button.classList.toggle("armed", button.dataset.dialog === openDialogId);
  }
  if (!room) openDialogId = dialogAfter(openDialogId, { type: "refresh", room: false });
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
      // A returning seat gets its room in the welcome, and the room carries its own log.
      if (message.room && Array.isArray(message.room.log) && !roundLog.length) noteLog(message.room.log);
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
        roundLog = [];
        logKeys = new Set();
      }
      room = message.room;
      if (message.reason) say(message.reason);
      if (selected && (!room || !(room.pieces || []).some((piece) => piece.id === selected.id))) {
        selected = null;
        preview = null;
        hoverKey = "";
      }
      // A reload shows the match that has been happening: the room carries its own log.
      if (!roundLog.length && room && Array.isArray(room.log)) noteLog(room.log);
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
      }
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
      placement = { width: message.width, height: message.height, mask: bytes, count: message.count, ready: message.ready, unready: message.unready, domain: message.domain };
      drawMatch();
    } else if (message.op === "route") {
      // Late replies for another piece are not this selection's route.
      if (!selected || message.piece !== selected.id) return;
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
      say(purchaseText(message.kind, message.at, message.cash));
      // One purchase lands, the cursor goes: the next click is a map click again.
      buying = null;
      placement = null;
      drawMatch();
      renderRoom();
    } else if (message.op === "ordered") {
      settleOrder(message.id);
      say(ackText(message));
      // An order is the player's own act, so it belongs in the log beside what the round did.
      noteLog([{ round: room && room.round ? room.round : 0, text: ackText(message).replace(/\.$/, "") }]);
      clearCommand();
    } else if (message.op === "error") {
      // The server's sentence is what the player reads. It is never swallowed, and a queued
      // order that was refused says which one.
      settleOrder(message.id);
      const refusal = refusalText(message);
      say(message.id ? "Order " + message.id + " refused: " + refusal : refusal);
      if (preview) {
        preview = { ...preview, path: [], error: refusal };
        drawMatch();
      }
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

fetch("/api/version")
  .then((res) => res.json())
  .then((data) => {
    const line = document.getElementById("buildCommit");
    if (!line) return;
    // Hidden while booting and empty until the answer: "build unknown" on the way in was the
    // second half of the reload flash (T-007 AC5).
    line.textContent = data && data.short ? "build " + data.short : "";
    line.title = String((data && data.commit) || "");
  })
  .catch(() => {});

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
  outbox: () => outbox.length,
  wire: () => wireLog.slice(),
  board: () => boardPayload,
  // The names the painter puts beside capitals, from the room's own era rows (PB-022). The canvas is
  // pixels, so a screenshot cannot be read back: this is the same call the frame makes.
  capitalLabels: () => capitalMarkers(boardPayload, room).map((c) => ({ name: c.name, x: c.x, y: c.y, side: c.side, color: c.color })),
  log: () => roundLog.slice(),
  state: () => ({
    buying,
    selected: selected ? selected.id : null,
    placement: Boolean(placement),
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
  // the mask byte: 1 a ready city or base, 2 a friendly site that is still unready.
  legalCells(limit = 200) {
    if (!placement || !placement.mask) return [];
    const mask = placement.mask;
    const width = Number(placement.width) || 320;
    const out = [];
    for (let i = 0; i < mask.length && out.length < limit; i++) {
      if (!mask[i]) continue;
      out.push({ x: i % width, y: Math.floor(i / width), ready: mask[i] === 1, unready: mask[i] === 2 });
    }
    return out;
  },
  // Kill the lobby socket the way a dead network would, so the suite can prove a Play clicked while
  // it is down is queued. The page reconnects on its own, exactly as it does after a real drop.
  dropSocket() {
    if (socket) socket.close();
  },
  send: (message) => send(message),
};
