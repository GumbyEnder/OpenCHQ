import {
  capitalMarkers, centerOn, clampZoom, fitViewport, legendEntries, MIN_ZOOM, paintMatch, panBy,
  rememberSeen, sightTable, statusLine, zoomAt,
} from "./render.mjs";
import {
  PICK_HINT,
  ackText,
  airNote,
  alarmText,
  buyMessage,
  cargoNote,
  cellAtEvent,
  orderMessage,
  ownPieceAt,
  previewLine,
  purseText,
  refusalText,
  routeRequest,
  shopDisabled,
  shopLabel,
} from "./command.mjs";
import { chromeGeometry, roundFraction, timeLeftText } from "./chrome.mjs";

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
const RECONNECT_TRIES = 8;
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
function sayResult(room) {
  if (!room || !room.over) return;
  const mine = room.you || (room.seat && room.seat.side);
  say(room.winner && mine ? (room.winner === mine ? "You have won. Both capitals." : "The enemy holds both capitals.")
    : "The match is over.");
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

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    say("The lobby is not connected.");
    return;
  }
  socket.send(JSON.stringify(message));
}

// Canvas is sized to whole cells: 320x136 at scale 2 is 640x272. The camera zooms and pans on
// top of that fit; it starts at the fit and follows the selected piece.
let camera = null;
// True once the player zooms or pans: from then on the camera is theirs. Until then every resize
// and every frame recomputes the whole-world fit, which is what the original put on the screen.
let userCamera = false;
let fogSeen = null;
let fogKey = "";

// The canvas is sized by the page, not by a number in the HTML: at 640x272 fixed, a cell was four
// CSS pixels on a laptop and the map sat below the fold. It now takes the width it has and about
// two thirds of the window height, at the device pixel ratio, and a cell is ~8 px by default.
function dpr() {
  return Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
}

function sizeCanvas() {
  const availW = Math.max(320, Math.floor(board.parentElement ? board.parentElement.clientWidth : 640));
  const availH = Math.max(240, Math.floor((window.innerHeight || 800) * 0.62));
  const w = Math.round(availW * dpr());
  const h = Math.round(availH * dpr());
  if (board.width !== w || board.height !== h) {
    board.width = w;
    board.height = h;
    board.style.height = Math.round(availH) + "px";
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

// Follow: the selected piece stays in the middle as the clock runs. Without it, a zoomed view
// walks off the piece every time it steps.
let following = true;

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

function paintChrome(view) {
  const box = document.getElementById("timebox");
  const bar = document.getElementById("timeFill");
  const text = document.getElementById("timeText");
  if (!box || !bar || !text) return;
  if (!room || !room.round) {
    document.getElementById("chrome").classList.add("hidden");
    return;
  }
  document.getElementById("chrome").classList.remove("hidden");
  const mapWidthPx = (Number(boardPayload.width) || 320) * (view ? view.scale : 1);
  const geometry = chromeGeometry(mapWidthPx);
  box.style.width = geometry.boxWidth + "px";
  box.style.height = geometry.boxHeight + "px";
  box.style.left = geometry.boxLeft + "px";
  const label = document.getElementById("timeLabel");
  if (label) label.textContent = geometry.label;
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
}

setInterval(tickChrome, 100);

function drawMatch() {
  const ctx = board.getContext("2d");
  let view = viewForCanvas();
  // Follow the selected piece: a zoomed view that leaves the piece behind is a worse camera than
  // no zoom at all.
  if (following && selected) {
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
  });
  paintChrome(view);
  const camNote = document.getElementById("camNote");
  if (camNote) {
    camNote.textContent = "cell " + (view.scale / dpr()).toFixed(0) + " px · " +
      (following ? "following" : "free");
  }
  boardNote.textContent =
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
    const site = (room.sites || []).find((place) => place.x === cell.x && place.y === cell.y);
    if (!site) {
      say("Buy " + buying + ": " + cell.x + "," + cell.y + " is not a site. Click one of your cities.");
      return;
    }
    send(buyMessage(buying, cell));
    buying = null;
    renderRoom();
    return;
  }

  const mine = ownPieceAt(room.pieces, cell, room.you);
  if (mine) {
    selected = mine;
    preview = null;
    hoverKey = mine.id + ":" + mine.x + "," + mine.y;
    // At the whole-world fit there is nothing to centre; once the player has zoomed, selecting a
    // piece brings it into the middle.
    if (userCamera) camera = centerOn(mine, viewForCanvas());
    say(PICK_HINT + " Then pick a destination.");
    drawMatch();
    return;
  }
  if (!selected) {
    say(PICK_HINT);
    return;
  }
  const message = orderMessage(selected, cell);
  if (message) send(message);
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
  const view = viewForCanvas();
  const step = 8 * view.scale;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
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
document.getElementById("camFollow")?.addEventListener("click", () => setFollow(!following));

async function loadBoard() {
  try {
    const res = await fetch("/api/board", { credentials: "same-origin" });
    const payload = await res.json();
    boardPayload = payload && typeof payload === "object" ? payload : boardPayload;
  } catch (err) {
    boardPayload = { ...boardPayload, source: "missing", cells: null };
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

function seatRow(label, seat, yours) {
  const row = document.createElement("div");
  row.className = "seat " + label.toLowerCase();
  const who = seat.kind === "bot" ? "Bot" : seat.username;
  row.textContent = label + " · " + who + (yours ? " · you" : "");
  return row;
}

function renderRoom() {
  if (room && room.over) sayResult(room);
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

  // The wallet and the payment countdown: without them the clock is dead time, because a
  // player cannot see that money is coming or when.
  let purseEl = null;
  let shopEl = null;
  if (room.seat) {
    const purse = document.createElement("p");
    purse.className = "purse";
    purse.textContent = purseText(room.seat);
    purseEl = purse;
  }

  // The shop. Prices come from the server, so the panel cannot disagree with what it charges.
  if (Array.isArray(room.shop) && room.shop.length) {
    const shop = document.createElement("div");
    shop.className = "shop";
    const cash = room.seat && Number.isFinite(room.seat.cash) ? room.seat.cash : null;
    for (const entry of room.shop) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "buy";
      button.textContent = shopLabel(entry);
      button.disabled = shopDisabled(entry, cash);
      button.title = entry.refused || (button.disabled
        ? "Not enough in the pool."
        : "Click, then click a friendly " + (entry.domain === "sea" ? "dock" : "city") + ".");
      button.addEventListener("click", () => {
        if (entry.refused) {
          say(entry.refused);
          return;
        }
        buying = entry.kind;
        selected = null;
        preview = null;
        say("Buy " + entry.kind + ": click one of your " + (entry.domain === "sea" ? "docks" : "cities") + ".");
        renderRoom();
      });
      if (buying === entry.kind) button.className += " armed";
      shop.append(button);
    }
    shopEl = shop;
  }

  roomBox.append(seats, meta, note, actions);
  if (purseEl) roomBox.append(purseEl);
  if (shopEl) roomBox.append(shopEl);
  if (!sawRoom && room) {
    // A match that opens below the fold is a match the player does not see open.
    sawRoom = true;
    setTimeout(() => document.getElementById("board")?.scrollIntoView({ block: "center" }), 60);
  }
  const tools = toolRow(room);
  if (tools) roomBox.append(tools);

  // What the last rounds actually did. Empty until the clock runs.
  if (roundLog.length) {
    const heading = document.createElement("p");
    heading.className = "logHeading";
    heading.textContent = "Last rounds";
    const list = document.createElement("ol");
    list.className = "roundLog";
    list.id = "roundLog";
    roomBox.append(heading, list);
    paintLog(list);
  }
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
  for (const tool of wanted) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "buy";
    button.textContent = TOOL_WORDS[tool.name];
    // An aircraft on the ground is the other half of this row: a mission is a piece order.
    if (tool.name === "nuke" && tool.allowed === false) {
      button.title = String(tool.reason || "A nuke is refused in this match.");
    } else {
      button.title = "Send it now.";
    }
    button.addEventListener("click", () => send({ op: "tool", tool: tool.name }));
    row.append(button);
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
    capitals: delta.capitalsChanged ? delta.capitals : room.capitals,
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
}

function connect() {
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
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.op === "welcome") {
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
    } else if (message.op === "bye") {
      // The server is going away on purpose: say so, and keep the room on screen.
      say(message.reason || "The server is restarting.");
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
      // What a command actually did, in the server's own words.
      for (const event of message.events || []) {
        if (event.note) say(String(event.note));
        if (event.type && event.reveals !== undefined) noteLog([{ round: event.round, text: String(event.note || event.type) }]);
      }
    } else if (message.op === "delta") {
      applyDelta(message.delta);
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
      say("Bought an " + message.kind + " at " + message.at.x + "," + message.at.y + (message.cash !== null && message.cash !== undefined ? ". Pool " + message.cash + "." : "."));
    } else if (message.op === "ordered") {
      say(ackText(message));
      // An order is the player's own act, so it belongs in the log beside what the round did.
      noteLog([{ round: room && room.round ? room.round : 0, text: ackText(message).replace(/\.$/, "") }]);
      clearCommand();
    } else if (message.op === "error") {
      // The server's sentence is what the player reads. It is never swallowed.
      say(refusalText(message));
      if (preview) {
        preview = { ...preview, path: [], error: refusalText(message) };
        drawMatch();
      }
    }
  });
  socket.addEventListener("close", () => {
    if (socket !== selfSocket) return;
    // A deploy, a sleeping laptop or a dropped wifi all look the same from here. Reconnect by
    // itself, backing off, and let the welcome message restore the room and its log.
    if (!me) return;
    if (reconnectTimer) return;
    if (reconnectTries >= RECONNECT_TRIES) {
      say("Lobby connection closed. Reload the page to rejoin.");
      return;
    }
    reconnectTries += 1;
    wasReconnecting = true;
    const wait = Math.min(8000, 500 * 2 ** (reconnectTries - 1));
    say("Connection lost. Reconnecting" + (reconnectTries > 1 ? " (try " + reconnectTries + ")" : "") + "\u2026");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  });
  socket.addEventListener("open", () => {
    reconnectTries = 0;
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

document.querySelector("#launch").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = new FormData(event.target);
  send({ op: "bot", era: fields.get("era"), side: fields.get("side") });
});

// Keep the capitals labelled even before a room exists.
renderLegend();

loadBoard();

fetch("/api/me", { credentials: "same-origin" })
  .then((res) => res.json())
  .then((data) => {
    if (data.user) connect();
  })
  .catch(() => {});
