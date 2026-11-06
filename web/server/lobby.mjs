import { randomBytes } from "node:crypto";
import { deleteRoom, flushRooms, flushWindow, loadRooms, pruneRooms, saveRoom } from "./rooms.mjs";
import { tickMatch } from "./tick.mjs";
import { forSeat } from "./view.mjs";
import { ordersFor as botOrders } from "./bot.mjs";
import { matchSites } from "./board.mjs";
import { eraOf, openMatch, piecesFor } from "./match.mjs";
import { issueOrder } from "./move.mjs";
import { roundSeconds } from "./rules.mjs";

function sideOf(value) {
  return value === "red" ? "red" : "blue";
}

// The seat table the match carries. bot.mjs reads `match.seats[side].kind`, so the room
// stamps it whenever seats are assigned or restored: a human seat is refused bot orders by
// the module itself, not only by the caller.
function stampSeats(room) {
  if (!room || !room.match || !room.seats) return;
  room.match.seats = {
    blue: { kind: room.seats.blue ? room.seats.blue.kind : null },
    red: { kind: room.seats.red ? room.seats.red.kind : null },
  };
}

// The one seat a username holds. A socket may act as this seat and no other, so the side is
// never read from the message body.
function seatUsername(room, username) {
  if (!room || !room.seats) return null;
  for (const side of ["blue", "red"]) {
    const seat = room.seats[side];
    if (seat && seat.kind === "human" && seat.username === username) return side;
  }
  return null;
}

export function createLobby() {
  const sockets = new Map();
  const invites = new Map();
  const rooms = new Map();
  const seatOf = new Map();

  // The site list a match plays on: cities and capitals from the asset list, docks from the
  // painted terrain, wells from the oil layer. Missing extract -> no sites, the hosted case.
  function sitesForMatch(era) {
    try {
      return matchSites(era);
    } catch {
      return [];
    }
  }

  // Rooms outlive the process. Restore every stored game paused, and seat its humans again so
  // a returning player lands back in their own match. Games nobody touched for a day go away.
  pruneRooms();
  for (const room of loadRooms()) {
    // A stored room from before the match module has seats but no match. Open one for its
    // era so an old row still shows its side's opening pieces.
    if (!room.match) {
      room.match = openMatch(room.era, sitesForMatch(room.era));
      saveRoom(room);
    }
    stampSeats(room);
    rooms.set(room.id, room);
    for (const seat of Object.values(room.seats ?? {})) {
      if (seat && seat.kind === "human" && seat.username) seatOf.set(seat.username, room.id);
    }
  }

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
    const seen = room.match ? forSeat(room.match, you) : null;
    return {
      id: room.id,
      mode: room.mode,
      era: room.era,
      clock: room.clock,
      you,
      blue: { username: room.seats.blue.username, kind: room.seats.blue.kind },
      red: { username: room.seats.red.username, kind: room.seats.red.kind },
      round: room.match ? room.match.round : 0,
      pieces: seen ? seen.pieces : piecesFor(room.match),
      routes: seen ? seen.routes : {},
      sites: seen ? seen.sites : [],
      capitals: seen ? seen.capitals : null,
      over: room.match ? Boolean(room.match.over) : false,
      winner: room.match ? room.match.winner : null,
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

  // A disconnect pauses the game; it does not destroy it. The seat stays reserved for the
  // account, the room stays in the store, and the clock stops so nothing runs unwatched.
  function holdRoom(room, note) {
    room.clock = "held";
    if (room.match) room.match.clock = "held";
    room.note = note;
    saveRoom(room);
    tellRoom(room);
  }

  function endRoom(room, reason) {
    room.note = reason;
    rooms.delete(room.id);
    deleteRoom(room.id);
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
      if (roomId && rooms.has(roomId)) {
        holdRoom(rooms.get(roomId), username + " disconnected. The match is paused and still yours.");
      }
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
      note: "Clock held. The board is waiting for orders.",
      seats: {
        blue: { username: "Bot", kind: "bot" },
        red: { username: "Bot", kind: "bot" },
      },
      match: openMatch(eraOf(era), sitesForMatch(eraOf(era))),
    };
    room.seats[mine] = { username, kind: "human" };
    room.seats[other] = { username: "Bot", kind: "bot" };
    stampSeats(room);
    rooms.set(room.id, room);
    saveRoom(room);
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
      note: "Clock held. The board is waiting for orders.",
      seats: { blue: null, red: null },
      match: openMatch(inviteRow.era, sitesForMatch(inviteRow.era)),
    };
    room.seats[mine] = { username: inviteRow.from, kind: "human" };
    room.seats[other] = { username, kind: "human" };
    stampSeats(room);
    rooms.set(room.id, room);
    saveRoom(room);
    seatOf.set(inviteRow.from, room.id);
    seatOf.set(username, room.id);
    tellRoom(room);
    sendPresence();
    return { ok: true };
  }

  // A socket orders its own seat and nothing else. The side is derived from the seat table,
  // never taken from the message; a side sent in the message must match or the order is
  // refused before the match is touched. move.issueOrder re-checks piece ownership, so a
  // forged piece id fails at the second gate too.
  function order(username, message) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const claimed = message.side === undefined || message.side === null ? mine : String(message.side);
    if (claimed !== mine) {
      return { error: "That side is not yours. You hold " + mine + "." };
    }
    const pieceId = String(message.piece ?? message.pieceId ?? "");
    if (!pieceId) return { error: "An order needs a piece id." };
    let result;
    try {
      result = issueOrder(room.match, mine, pieceId, message.x, message.y);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "The order was refused." };
    saveRoom(room);
    tellRoom(room);
    return { ok: true };
  }

  function setClock(username, running) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return { error: "You are not in a match." };
    room.clock = running ? "running" : "held";
    if (room.match) room.match.clock = room.clock;
    room.note = running
      ? "Clock running. Pieces move one cell a round."
      : "Clock held. The board is waiting for orders.";
    saveRoom(room);
    tellRoom(room);
    return { ok: true };
  }

  // The server owns the clock. main.mjs calls this once per configured round; every room whose
  // clock is running advances exactly one round and is marked dirty. The store takes a slice
  // of the dirty rooms each round (rooms.flushRooms), so 1000 running rooms are all durable
  // within a few rounds without any single round paying for all of them. A held, finished or
  // unwatched room costs nothing.
  let flushCursor = 0;
  function tickRooms() {
    const events = [];
    for (const room of rooms.values()) {
      if (!room.match || room.match.over || room.clock !== "running") continue;
      // Bot orders belong to bot seats, never to a room mode. A human room has no bot seat,
      // so neither side is given orders there; a bot seat in any room is still a bot.
      for (const side of ["blue", "red"]) {
        const seat = room.seats[side];
        if (!seat || seat.kind !== "bot") continue;
        if (!room.match.seats) stampSeats(room);
        try {
          botOrders(room.match, side);
        } catch (err) {
          console.error("bot orders failed:", err && err.message ? err.message : err);
        }
      }
      const result = tickMatch(room.match);
      room.match = result.match;
      room.dirty = true;
      tellRoom(room);
      if (result.events && result.events.length) events.push({ roomId: room.id, events: result.events });
      if (room.match.over) {
        room.clock = "held";
        room.note = "The match is over.";
        saveRoom(room);
        room.dirty = false;
        tellRoom(room);
        const winner = room.match.winner;
        for (const seat of [room.seats.blue, room.seats.red]) {
          if (seat.kind !== "human") continue;
          const peer = sockets.get(seat.username);
          if (peer) peer.send({ op: "over", roomId: room.id, winner });
        }
      }
    }
    // The round's store work is one bounded slice, not every room that moved. The window is
    // a couple of seconds of rounds, so a 5 s round writes everything and a 0.14 s round
    // writes a slice; no room waits longer than that to be durable.
    flushCursor = flushRooms([...rooms.values()], flushCursor, flushWindow(roundSeconds())).cursor;
    return events;
  }

  function handle(username, message) {
    const op = String(message.op ?? "");
    if (op === "bot") return startBot(username, message.era, message.side);
    if (op === "invite") return invite(username, String(message.user ?? ""), message.era, message.side);
    if (op === "answer") return answer(username, message.id, Boolean(message.accept));
    if (op === "order") return order(username, message);
    if (op === "run") return setClock(username, true);
    if (op === "hold") return setClock(username, false);
    if (op === "leave") return leave(username);
    return { error: "Unknown request." };
  }

  return { join, handle, presence, tickRooms };
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
