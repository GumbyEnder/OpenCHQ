import { capitalMarkers, fitViewport, legendEntries, paintMatch, statusLine } from "./render.mjs";
import {
  PICK_HINT,
  ackText,
  cellAtEvent,
  orderMessage,
  ownPieceAt,
  previewLine,
  refusalText,
  routeRequest,
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

// Canvas is sized to whole cells: 320x136 at scale 2 is 640x272.
function viewForCanvas() {
  const canvas = board;
  return fitViewport(canvas.width, canvas.height, boardPayload.width || 320, boardPayload.height || 136);
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
  const result = paintMatch(ctx, boardPayload, room, {
    view: viewForCanvas(),
    own: room && room.you,
    preview,
  });
  boardNote.textContent = previewLine(preview) || statusLine(boardPayload, room, result);
  renderLegend();
}

function clearCommand() {
  selected = null;
  preview = null;
  hoverKey = "";
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
  const mine = ownPieceAt(room.pieces, cell, room.you);
  if (mine) {
    selected = mine;
    preview = null;
    hoverKey = mine.id + ":" + mine.x + "," + mine.y;
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
  roomBox.append(seats, meta, note, actions);
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
