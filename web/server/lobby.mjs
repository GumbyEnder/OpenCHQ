import { randomBytes } from "node:crypto";
import { deleteRoom, flushRooms, flushWindow, loadRooms, pruneRooms, saveRoom } from "./rooms.mjs";
import { tickMatch } from "./tick.mjs";
import { forSeat } from "./view.mjs";
import { ordersFor as botOrders } from "./bot.mjs";
import { matchSites } from "./board.mjs";
import { eraOf, openMatch, piecesFor } from "./match.mjs";
import { issueOrder, planOrder } from "./move.mjs";
import { buy, seedOwners } from "./economy.mjs";
import { logLines } from "./log.mjs";
import { roundSeconds, rules } from "./rules.mjs";

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
    } catch (err) {
      // A silent [] here is a board with no cities: nothing to own, nothing to capture, and a
      // 2023 match nobody can buy into. Say so once instead of hiding it in the room.
      if (!sitesForMatch.warned) {
        sitesForMatch.warned = true;
        console.error("sitesForMatch(" + era + ") failed:", err && err.stack ? err.stack : err);
      }
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
      room.match = opened(room.era, sitesForMatch(room.era));
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
      // The shop: what this era sells and at what price. Prices come from config, never from
      // the page, so the panel cannot disagree with what economy.buy charges.
      shop: shopFor(room.era),
      // Cash, fuel and the rounds until the next payment. The page needs them to draw a
      // countdown; without them the clock is dead time and a player cannot plan a purchase.
      seat: seen ? seen.seat : null,
      // The round log travels with the room so a reload does not erase what happened. It is
      // already this seat's own lines, filtered when they were made.
      log: Array.isArray(room.log && room.log[you]) ? room.log[you] : [],
      over: room.match ? Boolean(room.match.over) : false,
      winner: room.match ? room.match.winner : null,
      note: room.note,
    };
  }

  function tellRoom(room, skip = "") {
    for (const seat of [room.seats.blue, room.seats.red]) {
      if (seat.kind !== "human") continue;
      if (seat.username === skip) continue;
      const peer = sockets.get(seat.username);
      if (peer) peer.send({ op: "room", room: roomView(room, seat.username) });
    }
  }

  // A disconnect pauses the game; it does not destroy it. The seat stays reserved for the
  // account, the room stays in the store, and the clock stops so nothing runs unwatched.
  function holdRoom(room, note) {
    // A deploy is not the player's pause. While the process is draining, a disconnect is ours,
    // so the room is marked to resume instead of being stopped and saved as stopped.
    if (room.resume) {
      room.note = note;
      saveRoom(room);
      return;
    }
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

  // A returning socket lands back in the seat that was reserved for it, with the same
  // filtered view it had before it dropped: its own pieces and full routes, sight drawn from
  // those pieces, and the enemy's first enemyRouteSteps steps. The view comes from the same
  // `forSeat` the live rooms use, so a reconnect cannot be a second, looser view.
  //
  // The clock stays held. A game resumes on an explicit `run`, never on a connect: a player
  // who comes back may not want the clock moving yet, and nothing may run a game nobody asked
  // to resume. What does not change is the board: the seat's standing orders were never
  // dropped (holdRoom stored the whole match, routes included), so a route queued before the
  // drop is still on the piece and still steps on the next running round.
  function seatView(room, username) {
    if (!room) return null;
    // The seat is occupied again, so the note the drop left behind is stale.
    if (/disconnected/.test(String(room.note || ""))) {
      room.note = "Both seats are present. The clock is still held.";
      saveRoom(room);
    }
    return roomView(room, username);
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
    const view = seatView(room, username);
    peer.send({
      op: "welcome",
      username,
      users: presence(),
      room: view,
    });
    // The seat beside a returning player is told the game is whole again.
    if (room && view) tellRoom(room, username);
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
      match: opened(era, sitesForMatch(eraOf(era))),
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
      match: opened(inviteRow.era, sitesForMatch(inviteRow.era)),
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
  // The page sends the destination as {to:{x,y}}; older harness calls send x/y flat. Both
  // name the same cell, and neither is trusted for the side.
  function destinationOf(message) {
    const to = message.to && typeof message.to === "object" ? message.to : {};
    const x = message.x ?? to.x;
    const y = message.y ?? to.y;
    return { x, y };
  }

  // Hover: the same planner the order uses, but read-only. A player who previews a route
  // gets the route they would actually walk, and a refusal reads the way the order's would.
  function routeFor(username, message) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    const peer = sockets.get(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const pieceId = String(message.piece ?? message.pieceId ?? "");
    if (!pieceId) return { error: "A route needs a piece id." };
    const to = destinationOf(message);
    const plan = planOrder(room.match, mine, pieceId, to.x, to.y);
    const reply = plan && plan.error
      ? { op: "route", piece: pieceId, to, error: plan.error }
      : { op: "route", piece: pieceId, to, path: plan.path, rounds: plan.rounds };
    if (peer) peer.send(reply);
    return { ok: true };
  }

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
    const to = destinationOf(message);
    let result;
    try {
      result = issueOrder(room.match, mine, pieceId, to.x, to.y);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "The order was refused." };
    saveRoom(room);
    tellRoom(room);
    // The seat hears its own order back: the page acknowledges in place instead of guessing
    // that a silent socket meant success.
    const peer = sockets.get(username);
    if (peer) peer.send({ op: "ordered", piece: pieceId, to, rounds: result.rounds ?? 0 });
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
      // The clock is dead time without a log. Each human seat gets the round as it could see it,
      // which is the view's own sight rule applied to events instead of pieces.
      if (result.events && result.events.length) {
        for (const side of ["blue", "red"]) {
          const seat = room.seats[side];
          if (!seat || seat.kind !== "human") continue;
          const peer = sockets.get(seat.username);
          if (!peer) continue;
          const lines = logLines(room.match, side, result.events, room.match.round);
          if (!lines.length) continue;
          // The log outlives the socket: it is part of the room, so a reload shows the match
          // that has been happening instead of an empty window.
          if (!room.log) room.log = { blue: [], red: [] };
          if (!Array.isArray(room.log[side])) room.log[side] = [];
          room.log[side].push(...lines);
          if (room.log[side].length > 60) room.log[side] = room.log[side].slice(-60);
          peer.send({ op: "log", roomId: room.id, round: room.match.round, lines });
        }
      }
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

  // A deploy closes the listener under live sockets. Everything the store has not written yet
  // is written here, in one pass, and every running room with a human seat is marked to resume
  // so the reconnect finds the match still running instead of a paused one.
  function beginDrain() {
    const marked = [];
    for (const room of rooms.values()) {
      if (!room.match || room.match.over) continue;
      const humans = [room.seats.blue, room.seats.red].some((seat) => seat && seat.kind === "human");
      if (!humans) continue;
      if (room.clock !== "running") continue;
      room.resume = true;
      marked.push(room);
    }
    return marked;
  }

  function flushAll() {
    let written = 0;
    for (const room of rooms.values()) {
      room.dirty = false;
      saveRoom(room);
      written += 1;
    }
    return written;
  }

  // Buying is an order with a price: the same seat checks as "order", then economy.buy does the
  // rules. A purchase answers with the new cash so the page can redraw without guessing.
  function buyOp(username, message) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const claimed = message.side === undefined || message.side === null ? mine : String(message.side);
    if (claimed !== mine) {
      return { error: "That side is not yours. You hold " + mine + "." };
    }
    const at = destinationOf(message);
    let result;
    try {
      result = buy(room.match, mine, message.kind, at.x, at.y);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "The purchase was refused." };
    saveRoom(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) {
      peer.send({
        op: "bought",
        kind: result.piece.kind,
        piece: result.piece.id,
        at: { x: result.piece.x, y: result.piece.y },
        cash: room.match.sides && room.match.sides[mine] ? room.match.sides[mine].cash : null,
      });
    }
    return { ok: true };
  }

  function handle(username, message) {
    const op = String(message.op ?? "");
    if (op === "bot") return startBot(username, message.era, message.side);
    if (op === "invite") return invite(username, String(message.user ?? ""), message.era, message.side);
    if (op === "answer") return answer(username, message.id, Boolean(message.accept));
    if (op === "order") return order(username, message);
    if (op === "buy") return buyOp(username, message);
    if (op === "route") return routeFor(username, message);
    if (op === "run") return setClock(username, true);
    if (op === "hold") return setClock(username, false);
    if (op === "leave") return leave(username);
    return { error: "Unknown request." };
  }

  // Every connected seat, for the one message a drain has to deliver.
  function broadcast(message) {
    let sent = 0;
    for (const peer of sockets.values()) {
      try {
        peer.send(message);
        sent += 1;
      } catch {
        // A socket already gone is not a reason to stop telling the rest.
      }
    }
    return sent;
  }

  return { join, handle, presence, tickRooms, beginDrain, flushAll, broadcast };
}

// What an era sells. The prices are config; the era gates are the archive's - aircraft exist
// from 1942 on, and a nuke is never on the shelf (economy refuses it and says so).
const LAND_KINDS = ["infantry", "tank"];
const SEA_KINDS = ["ship", "submarine"];

export function shopFor(era) {
  const key = String(era ?? "1986");
  const seats = (rules().prices || {});
  const kinds = [...LAND_KINDS];
  if (key !== "1918") kinds.push("aircraft");
  const all = [...kinds, ...SEA_KINDS];
  const shop = [];
  for (const kind of all) {
    if (!Object.hasOwn(seats, kind)) continue;
    shop.push({
      kind,
      price: Number(seats[kind]),
      domain: kind === "ship" || kind === "submarine" ? "sea" : "land",
    });
  }
  shop.push({ kind: "nuke", price: Object.hasOwn(seats, "nuke") ? Number(seats.nuke) : null, domain: "land", refused: "A nuke is refused." });
  return shop;
}

// A match opens with its countries already owned. Ownership used to be seeded lazily on the
// first purchase, which meant a 2023 board showed no friendly city at all and the empty era
// could not be played: there was nothing to click. Seeding at open is the same rule, applied
// early enough for the view to carry it.
function opened(era, sites) {
  const match = openMatch(eraOf(era), sites);
  seedOwners(match);
  return match;
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
