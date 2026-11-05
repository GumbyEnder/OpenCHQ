import { randomBytes } from "node:crypto";

const ERAS = new Set(["1918", "1942", "1986", "2023", "9999"]);

function eraOf(value) {
  const era = String(value ?? "1986");
  return ERAS.has(era) ? era : "1986";
}

function sideOf(value) {
  return value === "red" ? "red" : "blue";
}

export function createLobby() {
  const sockets = new Map();
  const invites = new Map();
  const rooms = new Map();
  const seatOf = new Map();

  function presence() {
    const users = [];
    for (const [username, peer] of sockets) {
      users.push({ username, busy: seatOf.has(username), roomId: seatOf.get(username) ?? "" });
    }
    users.sort((a, b) => a.username.localeCompare(b.username));
    return users;
  }

  function broadcast(value, skip = "") {
    for (const [username, peer] of sockets) {
      if (username === skip) continue;
      peer.send(value);
    }
  }

  function sendPresence() {
    broadcast({ op: "presence", users: presence() });
  }

  function roomView(room, username) {
    const you = room.seats.blue.username === username ? "blue" : "red";
    return {
      id: room.id,
      mode: room.mode,
      era: room.era,
      clock: room.clock,
      you,
      blue: { username: room.seats.blue.username, kind: room.seats.blue.kind },
      red: { username: room.seats.red.username, kind: room.seats.red.kind },
      note: room.note,
    };
  }

  function tellRoom(room) {
    for (const seat of [room.seats.blue, room.seats.red]) {
      if (seat.kind !== "human") continue;
      const peer = sockets.get(seat.username);
      if (peer) peer.send({ op: "room", room: roomView(room, seat.username) });
    }
  }

  function endRoom(room, reason) {
    room.note = reason;
    rooms.delete(room.id);
    for (const seat of [room.seats.blue, room.seats.red]) {
      if (seat.kind !== "human") continue;
      seatOf.delete(seat.username);
      const peer = sockets.get(seat.username);
      if (peer) peer.send({ op: "room", room: null, reason });
    }
    sendPresence();
  }

  function join(username, peer) {
    const previous = sockets.get(username);
    sockets.set(username, peer);
    if (previous && previous !== peer) previous.close();
    peer.onclose = () => {
      if (sockets.get(username) !== peer) return;
      sockets.delete(username);
      const roomId = seatOf.get(username);
      if (roomId && rooms.has(roomId)) endRoom(rooms.get(roomId), username + " left the match.");
      for (const [id, invite] of invites) {
        if (invite.from === username || invite.to === username) invites.delete(id);
      }
      sendPresence();
    };
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    peer.send({
      op: "welcome",
      username,
      users: presence(),
      room: room ? roomView(room, username) : null,
    });
    sendPresence();
  }

  function leave(username) {
    const roomId = seatOf.get(username);
    if (!roomId || !rooms.has(roomId)) return { error: "You are not in a match." };
    endRoom(rooms.get(roomId), username + " left the match.");
    return { ok: true };
  }

  function startBot(username, era, side) {
    if (seatOf.has(username)) return { error: "Leave the current match first." };
    const mine = sideOf(side);
    const other = mine === "blue" ? "red" : "blue";
    const room = {
      id: randomBytes(8).toString("hex"),
      mode: "bot",
      era: eraOf(era),
      clock: "held",
      note: "Clock held. The rules worker is not attached, so pieces do not move yet. The bot will use the desktop opponent when it is.",
      seats: {
        blue: { username: "Bot", kind: "bot" },
        red: { username: "Bot", kind: "bot" },
      },
    };
    room.seats[mine] = { username, kind: "human" };
    room.seats[other] = { username: "Bot", kind: "bot" };
    rooms.set(room.id, room);
    seatOf.set(username, room.id);
    tellRoom(room);
    sendPresence();
    return { ok: true };
  }

  function invite(from, toName, era, side) {
    if (from === toName) return { error: "Invite someone else." };
    if (!sockets.has(toName)) return { error: "That player is not online." };
    if (seatOf.has(from) || seatOf.has(toName)) return { error: "One of you is already in a match." };
    const id = randomBytes(8).toString("hex");
    const inviteRow = {
      id,
      from,
      to: toName,
      era: eraOf(era),
      side: sideOf(side),
    };
    for (const [oldId, old] of invites) {
      if (old.from === from && old.to === toName) invites.delete(oldId);
    }
    invites.set(id, inviteRow);
    sockets.get(toName).send({ op: "invite", invite: publicInvite(inviteRow) });
    sockets.get(from).send({ op: "invited", invite: publicInvite(inviteRow) });
    return { ok: true };
  }

  function answer(username, inviteId, accept) {
    const inviteRow = invites.get(String(inviteId ?? ""));
    if (!inviteRow || inviteRow.to !== username) return { error: "That invite is gone." };
    invites.delete(inviteRow.id);
    const sender = sockets.get(inviteRow.from);
    if (!accept) {
      if (sender) sender.send({ op: "declined", by: username });
      return { ok: true };
    }
    if (!sender) return { error: "That player left." };
    if (seatOf.has(username) || seatOf.has(inviteRow.from)) return { error: "One of you is already in a match." };
    const mine = inviteRow.side;
    const other = mine === "blue" ? "red" : "blue";
    const room = {
      id: randomBytes(8).toString("hex"),
      mode: "human",
      era: inviteRow.era,
      clock: "held",
      note: "Clock held. The rules worker is not attached, so pieces do not move yet.",
      seats: { blue: null, red: null },
    };
    room.seats[mine] = { username: inviteRow.from, kind: "human" };
    room.seats[other] = { username, kind: "human" };
    rooms.set(room.id, room);
    seatOf.set(inviteRow.from, room.id);
    seatOf.set(username, room.id);
    tellRoom(room);
    sendPresence();
    return { ok: true };
  }

  function setClock(username, running) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return { error: "You are not in a match." };
    room.clock = running ? "running" : "held";
    room.note = running
      ? "Clock marked running. The rules worker is not attached, so pieces do not move yet."
      : "Clock held. The rules worker is not attached, so pieces do not move yet.";
    tellRoom(room);
    return { ok: true };
  }

  function handle(username, message) {
    const op = String(message.op ?? "");
    if (op === "bot") return startBot(username, message.era, message.side);
    if (op === "invite") return invite(username, String(message.user ?? ""), message.era, message.side);
    if (op === "answer") return answer(username, message.id, Boolean(message.accept));
    if (op === "run") return setClock(username, true);
    if (op === "hold") return setClock(username, false);
    if (op === "leave") return leave(username);
    return { error: "Unknown request." };
  }

  return { join, handle, presence };
}

function publicInvite(invite) {
  return {
    id: invite.id,
    from: invite.from,
    to: invite.to,
    era: invite.era,
    side: invite.side,
  };
}
