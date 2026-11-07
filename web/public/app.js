import {
  capitalMarkers, centerOn, clampZoom, fitViewport, legendEntries, paintMatch, panBy,
  rememberSeen, sightTable, statusLine, zoomAt,
} from "./render.mjs";
import {
  PICK_HINT,
  ackText,
  buyMessage,
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

const gate = document.querySelector("#gate");
const play = document.querySelector("#play");
const account = document.querySelector("#account");
const people = document.querySelector("#people");
const invites = document.querySelector("#invites");
const roomBox = document.querySelector("#room");
const flash = document.querySelector("#flash");
const board = document.querySelector("#board");
const boardNote = document.querySelector("#boardNote");
const legendBox = document.querySelector("#legend");

let socket = null;
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
let fogSeen = null;
let fogKey = "";

function viewForCanvas() {
  const canvas = board;
  const fit = fitViewport(canvas.width, canvas.height, boardPayload.width || 320, boardPayload.height || 136);
  if (!camera) camera = { ...fit, scale: clampZoom(fit.scale * 2) };
  return camera;
}

// The sight table is rebuilt when the round or the seat's own pieces change, and the memory of
// what has been seen accumulates across rounds.
function fogFor(view) {
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
function drawMatch() {
  const ctx = board.getContext("2d");
  const view = viewForCanvas();
  const result = paintMatch(ctx, boardPayload, room, {
    view,
    own: room && room.you,
    preview,
    fog: fogFor(view),
    sight: Number(boardPayload.sightCells || 8),
    sightAt: selected,
  });
  boardNote.textContent = previewLine(preview) || statusLine(boardPayload, room, result);
  renderLegend();
}

// Which unit the player has put on the build cursor, if any. The next click on a friendly city
// (or a dock, for a ship) buys it there; anything else cancels.
let buying = null;

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
      say("Buy a " + buying + ": that cell is not a site. Click one of your cities.");
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
    camera = centerOn(mine, viewForCanvas());
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
  camera = panBy(viewForCanvas(), event.clientX - panFrom.x, event.clientY - panFrom.y);
  panFrom = { x: event.clientX, y: event.clientY };
  drawMatch();
});
board.addEventListener("pointerup", () => {
  panFrom = null;
});
window.addEventListener("keydown", (event) => {
  const step = 8 * viewForCanvas().scale;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  camera = panBy(viewForCanvas(), move[0], move[1]);
  drawMatch();
});

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
        say("Buy a " + entry.kind + ": click one of your " + (entry.domain === "sea" ? "docks" : "cities") + ".");
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
}

function showPlay(on) {
  gate.classList.toggle("hidden", on);
  play.classList.toggle("hidden", !on);
  renderAccount();
}

function connect() {
  if (socket) socket.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(proto + "://" + location.host + "/ws");
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.op === "welcome") {
      me = message.username;
      users = message.users || [];
      room = message.room;
      showPlay(true);
      renderPeople();
      renderRoom();
      drawMatch();
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
      room = message.room;
      if (message.reason) say(message.reason);
      if (selected && (!room || !(room.pieces || []).some((piece) => piece.id === selected.id))) {
        selected = null;
        preview = null;
        hoverKey = "";
      }
      pending = [];
      renderInvites();
      renderPeople();
      renderRoom();
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
    } else if (message.op === "bought") {
      say("Bought an " + message.kind + " at " + message.at.x + "," + message.at.y + (message.cash !== null && message.cash !== undefined ? ". Pool " + message.cash + "." : "."));
    } else if (message.op === "ordered") {
      say(ackText(message));
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
    if (me) say("Lobby connection closed.");
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
