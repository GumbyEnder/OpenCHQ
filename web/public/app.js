const gate = document.querySelector("#gate");
const play = document.querySelector("#play");
const account = document.querySelector("#account");
const people = document.querySelector("#people");
const invites = document.querySelector("#invites");
const roomBox = document.querySelector("#room");
const flash = document.querySelector("#flash");
const board = document.querySelector("#board");

let socket = null;
let me = "";
let users = [];
let pending = [];
let room = null;

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

function drawBoard() {
  const ctx = board.getContext("2d");
  const w = board.width;
  const h = board.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#081018";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#1a2740";
  ctx.lineWidth = 1;
  for (let x = 0; x <= 320; x += 20) {
    ctx.beginPath();
    ctx.moveTo(x * 2, 0);
    ctx.lineTo(x * 2, h);
    ctx.stroke();
  }
  for (let y = 0; y <= 142; y += 20) {
    ctx.beginPath();
    ctx.moveTo(0, y * 2);
    ctx.lineTo(w, y * 2);
    ctx.stroke();
  }
  mark(ctx, 79, 44, "#3d7ec9", "Washington");
  mark(ctx, 183, 25, "#c4473a", "Moscow");
}

function mark(ctx, x, y, color, label) {
  const px = x * 2;
  const py = y * 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e4ecff";
  ctx.font = "14px Palatino, Georgia, serif";
  ctx.fillText(label, px + 10, py - 8);
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
      pending = [];
      renderInvites();
      renderPeople();
      renderRoom();
    } else if (message.op === "error") {
      say(message.error);
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

drawBoard();

fetch("/api/me", { credentials: "same-origin" })
  .then((res) => res.json())
  .then((data) => {
    if (data.user) connect();
  })
  .catch(() => {});
