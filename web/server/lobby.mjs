import { randomBytes } from "node:crypto";
import { deleteRoom, flushRooms, flushWindow, loadRooms, pruneRooms, saveRoom } from "./rooms.mjs";
import { tickMatch } from "./tick.mjs";
import { forSeat, resultNote, resultOf, capitalListOf } from "./view.mjs";
import { ordersFor as botOrders } from "./bot.mjs";
import { boardPayload, matchSites } from "./board.mjs";
import { eraOf, openMatch, piecesFor } from "./match.mjs";
import { entrench, issueOrder, planOrder, repair } from "./move.mjs";
import { sendMission } from "./air.mjs";
import { orderEscort } from "./escort.mjs";
import { AID_HELD_MID_WAR, nukeStatus, toolOpensWhileHeld, toolsForEra, useTool } from "./late.mjs";
import { buy, seedOwners } from "./economy.mjs";
import { friendlySites, maskBase64, placementMask } from "./placement.mjs";
import { logLines } from "./log.mjs";
// T-031 step 1: the War Films recorder. A film is a recording of a finished match; nothing here is
// read by a live page, and every call is wrapped so a storage fault can never stop a match.
import { appendFrame, armRestoredFilm, finishFilm, startFilm } from "./history.mjs";
import { scanActiveFor, scanAnyActive } from "./scan.mjs";
import { handicapDefault, handicapSpec, roundSeconds, speedSeconds, speedDue, clampSpeed, SPEED_MIN, SPEED_MAX } from "./rules.mjs";
import { isSatelliteKind, shopFor } from "./shop.mjs";
import { buySatellite, orderSatellite, planSatellite, satelliteById } from "./satellite.mjs";
import { compatUnitKind } from "./migrate.mjs";
import { TAKEOVER_CLOSE_CODE as TAKEOVER_CODE } from "./ws.mjs";
import { displayNames, localName } from "./names.mjs";

// A player action during a running clock marks the room dirty instead of committing it: the tick
// writes dirty rooms within FLUSH_SECONDS anyway, and a commit per order is what turned a 0.12 s
// round into three seconds when two seats sent a few hundred orders a round. A held clock, a
// create, a leave or a win still saves at once, because those are the changes a player notices.
function touch(room) {
  if (room && room.clock === "running") {
    room.dirty = true;
    return;
  }
  saveRoom(room);
}

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
// One place that talks to the store, so the match loop carries one line and not four. A storage
// error is LOGGED with a prefix a log search can find; it is never swallowed into silence, because a
// finished match with no film is worse than a stated failure (frodo's condition 5, room 7697).
function recordFilm(room, events) {
  try {
    if (!room || !room.film) return;
    appendFrame(room, events);
    if (room.match && room.match.over) {
      finishFilm(room);
      room.film = false;
    }
  } catch (err) {
    console.warn(`[history] frame not recorded for room ${room && room.id}: ${err && err.message ? err.message : err}`);
  }
}

function openFilm(room) {
  try {
    const started = startFilm(room);
    room.film = Boolean(started);
  } catch (err) {
    room.film = false;
    console.warn(`[history] film not opened for room ${room && room.id}: ${err && err.message ? err.message : err}`);
  }
}

function seatUsername(room, username) {
  if (!room || !room.seats) return null;
  for (const side of ["blue", "red"]) {
    const seat = room.seats[side];
    if (seat && seat.kind === "human" && seat.username === username) return side;
  }
  return null;
}

// The owner's review account(s). An owner-only debug view is the one place the bot's decisions
// are visible; a normal seat's room view never carries them, so fog is unchanged for players.
function isOwner(username) {
  const list = String(process.env.OPENCHQ_OWNER || "shane")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(username || "").toLowerCase());
}

// The room's clock speed (T-004): 0-6, where 0 accepts orders and lets no time pass (Manual
// p.34-35). A row or a message that carries nothing usable plays at 1, which is the old single
// round length - a bad speed must not invent a clock.
function speedOf(room) {
  const whole = clampSpeed(room && room.speed);
  return whole === null ? 1 : whole;
}

// A room's round length in seconds, read from config.speeds. Speed 0 is 0: time does not pass.
function roomSeconds(room) {
  return speedSeconds(speedOf(room));
}

// The difference between the last frame a seat got (its shadow) and the view now. Exported so a
// node test can pin the ownership carry without standing up a socket: the shadow shape is the one
// setSeatShadow writes below, and `signature` is the same JSON serialisation.
export function deltaBetween(last, view) {
  const signature = (value) => JSON.stringify(value);
  if (!last) return null;
  const pieces = [];
  const routes = {};
  const gone = [];
  const pieceSigs = {};
  for (const piece of view.pieces || []) {
    const sig = signature(piece);
    pieceSigs[piece.id] = sig;
    if (last.pieces[piece.id] !== sig) pieces.push(piece);
  }
  for (const id of Object.keys(last.pieces)) {
    if (!(id in pieceSigs)) gone.push(id);
  }
  for (const [id, steps] of Object.entries(view.routes || {})) {
    const sig = signature(steps);
    if (last.routes[id] !== sig) routes[id] = steps;
  }
  for (const id of Object.keys(last.routes)) {
    if (!(id in (view.routes || {}))) routes[id] = [];
  }
  const sites = [];
  for (const site of view.sites || []) {
    if (last.sites[site.id] !== (site.owner ?? null)) {
      sites.push({ id: site.id, owner: site.owner ?? null, name: site.name, kind: site.kind });
    }
  }
  const delta = {
    round: view.round,
    // The alarm rides the delta too. It only ever appeared in a whole frame, and a whole frame
    // may be twenty-five rounds away — long enough for the capital to fall first.
    alarm: view.alarm || null,
    roundSeconds: view.roundSeconds || null,
    speed: view.speed,
    over: Boolean(view.over),
    winner: view.winner || null,
    // The delta is the frame most seats see at the moment a match ends, so the result has to
    // ride it. It rides whole (six rows), not as a change flag: a page that missed one delta
    // and then syncs would otherwise hold a result from the round before.
    result: view.result || null,
    clock: view.clock,
    note: view.note,
    pieces,
    gone,
    routes,
    sites,
    // PB-224: satellites are not ground pieces (they fly above the board), so they ride the delta as
    // their own whole list rather than through the piece diff.
    satellites: view.satellites || [],
    unscreened: view.unscreened || [],
    seatChanged: last.seat !== signature(view.seat),
    capitalsChanged: last.capitals !== signature(view.capitals),
    capitalListChanged: last.capitalList !== signature(view.capitalList || null),
    // A capture changes who holds a region in the same tick the site changes hands, and the
    // delta is the frame a seat usually sees it in (T-018 AC4). It rides whole, like the result,
    // so a seat that missed a delta cannot keep a stale fill after a sync.
    ownershipChanged: last.ownership !== signature(view.ownership || null),
  };
  if (delta.seatChanged) delta.seat = view.seat;
  if (delta.capitalsChanged) delta.capitals = view.capitals;
  if (delta.capitalListChanged) delta.capitalList = view.capitalList || null;
  if (delta.ownershipChanged) delta.ownership = view.ownership || null;
  return delta;
}

export function createLobby() {
  const sockets = new Map();
  const invites = new Map();
  const rooms = new Map();
  const seatOf = new Map();
  // account -> the name another player sees, and the reverse. Built here, never sent out of the
  // handle: `names.mjs` owns the rule, this keeps it stable while the account is online.
  const displayOf = new Map();

  function nameOf(account) {
    if (!account) return "";
    return displayOf.get(account) || localName(account);
  }

  function claimName(account) {
    if (displayOf.has(account)) return displayOf.get(account);
    const got = displayNames([account], displayOf).get(account);
    displayOf.set(account, got);
    return got;
  }

  function releaseName(account) {
    const name = displayOf.get(account);
    displayOf.delete(account);
    return name;
  }

  // A display name (what a client sends when it invites) back to the account that holds it.
  function accountFor(name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return "";
    for (const [account, display] of displayOf) {
      if (String(display).toLowerCase() === wanted) return account;
    }
    // A caller that already holds a real handle (a test harness, an owner tool) still works.
    return sockets.has(name) ? name : "";
  }

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
    // T-031 (frodo 9117 §5): a room that comes back from the store must keep filming, or the film
    // stops at the deploy and `finishFilm` never runs, so the war never appears in the player's
    // films. This re-arms the recorder ONLY when its header row already exists - see
    // armRestoredFilm: re-opening would rewrite round 0's paint.
    armRestoredFilm(room);
    rooms.set(room.id, room);
    for (const seat of Object.values(room.seats ?? {})) {
      if (seat && seat.kind === "human" && seat.username) seatOf.set(seat.username, room.id);
    }
  }

  function presence() {
    const users = [];
    for (const [username, peer] of sockets) {
      users.push({ username: nameOf(username), busy: seatOf.has(username), roomId: seatOf.get(username) ?? "" });
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
      blue: { username: room.seats.blue.kind === "bot" ? "Bot" : nameOf(room.seats.blue.username), kind: room.seats.blue.kind },
      red: { username: room.seats.red.kind === "bot" ? "Bot" : nameOf(room.seats.red.username), kind: room.seats.red.kind },
      round: room.match ? room.match.round : 0,
      // The speed this room runs at, and the round length that follows from it. Both seats see the
      // number, because either seat may change it (Manual p.34: the game speed is an agreed
      // setting, not a hidden one).
      speed: speedOf(room),
      // The round the server is running, so the page draws the same clock the server does instead
      // of keeping a copy of a tunable. Without it the TIME LEFT bar had nothing to run down.
      roundSeconds: roomSeconds(room),
      // Which of this seat's transports are crossing with no warship able to see them. The page
      // cannot work this out for itself without keeping a second copy of the sight rule.
      unscreened: seen && Array.isArray(seen.unscreened) ? seen.unscreened : [],
      pieces: seen ? seen.pieces : piecesFor(room.match),
      // PB-224: the orbital picture rides every frame and every delta. Both sides' satellites are
      // public (manual p.12 shows the blue one over the Atlantic and the red one over Europe), so
      // this is not filtered by seat; what a satellite SEES is still gated inside view.forSeat.
      satellites: seen && Array.isArray(seen.satellites) ? seen.satellites : [],
      routes: seen ? seen.routes : {},
      sites: seen ? seen.sites : [],
      capitals: seen ? seen.capitals : null,
      // The era's capitals and who holds each one right now. Sent from round 0: the map labels the
      // capitals anyway, and the War panel must be able to show the list before a match ends.
      capitalList: seen ? (seen.capitalList || null) : null,
      // The shop: what this era sells and at what price. Prices come from config, never from
      // the page, so the panel cannot disagree with what economy.buy charges. A side that holds no
      // dock gets its hull rows refused here, with the manual's reason, instead of arming a unit
      // that can never be placed (placement.mjs is the same rule, so the two cannot drift).
      shop: shopFor(room.era, {
        // D-025: a coastal city or base is a berth too, so the row is only refused when the side
        // holds neither a dock nor a coastal settlement.
        seaRefusal: room.match && friendlySites(room.match, you, "sea", boardPayload()) === 0
          ? "You hold no coastal city or dock, so a hull cannot be bought."
          : "",
      }),
      // The late kit this era offers, and whether a nuke is even possible. A tool a player
      // cannot see is a rule they cannot use, which is why this rides with the room.
      tools: toolsForEra(room.era).map((tool) => ({
        name: tool,
        ...(tool === "nuke" ? nukeStatus(room.match, you) : {}),
      })),
      // Cash, fuel and the rounds until the next payment. The page needs them to draw a
      // countdown; without them the clock is dead time and a player cannot plan a purchase.
      seat: seen ? seen.seat : null,
      // PB-152: the other side's payday, for the Economy dialog's Alternate Function. The object
      // is shaped in view.mjs and carries income only - never a purse, reserve or fuel.
      opponent: seen ? (seen.opponent || null) : null,
      // Show Ownership reads who holds each of the 184 regions from here, not from the city cells
      // (T-018 AC4/AC5). It rides the room like the capital list does: both seats see the same
      // ground, and it is a view of the site table, never a second source of truth.
      ownership: seen ? (seen.ownership || null) : null,
      // The round log travels with the room so a reload does not erase what happened. It is
      // already this seat's own lines, filtered when they were made.
      log: Array.isArray(room.log && room.log[you]) ? room.log[you] : [],
      over: room.match ? Boolean(room.match.over) : false,
      winner: room.match ? room.match.winner : null,
      // Who won, why, and the capital list the server's own site records carry. The end screen
      // draws this instead of guessing a cause from the clock having stopped.
      result: room.match ? resultOf(room.match) : null,
      note: room.note,
      // The bot's last decisions, for the owner's review only. A normal seat never sees this,
      // so fog is untouched for players.
      ...(isOwner(username) ? { botActions: Array.isArray(room.botActions) ? room.botActions.slice(-10) : [] } : {}),
    };
  }

  // A full frame per seat per round is what 1000 live rooms cost: the pieces, the site list and
  // every route, sent again because one piece moved. What follows sends the difference instead,
  // and a full frame only when the page could have lost its place: on connect, every
  // FULL_EVERY rounds, when the clock changes, and when more than half the board moved anyway.
  const FULL_EVERY = 20;
  const shadows = new Map(); // room id -> seat -> last frame sent
  // A seat may ask for whole frames: tests read a board by waiting for it, and a debugger wants
  // the same. It costs this seat bandwidth, nobody else's.
  const verbose = new Set();

  function signature(value) {
    return JSON.stringify(value);
  }

  // A seat that arrives fresh has no shadow: the next frame must be the whole room.
  function forgetSeat(room, side) {
    const perRoom = shadows.get(room.id);
    if (perRoom) delete perRoom[side];
  }

  function seatShadow(room, side) {
    let perRoom = shadows.get(room.id);
    if (!perRoom) {
      perRoom = {};
      shadows.set(room.id, perRoom);
    }
    return perRoom[side] || null;
  }

  function setSeatShadow(room, side, view) {
    let perRoom = shadows.get(room.id);
    if (!perRoom) {
      perRoom = {};
      shadows.set(room.id, perRoom);
    }
    const pieces = {};
    for (const piece of view.pieces || []) pieces[piece.id] = signature(piece);
    const routes = {};
    for (const [id, steps] of Object.entries(view.routes || {})) routes[id] = signature(steps);
    const sites = {};
    for (const site of view.sites || []) sites[site.id] = site.owner ?? null;
    perRoom[side] = {
      round: view.round,
      clock: view.clock,
      note: view.note,
      seat: signature(view.seat),
      capitals: signature(view.capitals),
      capitalList: signature(view.capitalList || null),
      ownership: signature(view.ownership || null),
      pieces,
      routes,
      sites,
    };
  }

  // The difference between the last frame this seat got and the view now.
  function deltaFor(room, side, view) {
    const last = seatShadow(room, side);
    if (!last) return null;
    return deltaBetween(last, view);
  }

  function frameFor(room, side, view, username) {
    if (verbose.has(username)) return { op: "room", room: view };
    // PB-158: while an intel pass runs, the reader gets the FULL view. A delta would carry the
    // newly scanned piece but the page's scan snapshot only merges `room` frames, so a delta
    // would hand the scanner a unit it never draws.
    if (scanActiveFor(room.match, side, Date.now())) return { op: "room", room: view };
    const full = !seatShadow(room, side);
    if (full) return { op: "room", room: view };
    if (Number(view.round) % FULL_EVERY === 0) return { op: "room", room: view };
    const last = seatShadow(room, side);
    if (last.clock !== view.clock) return { op: "room", room: view };
    if (Number(view.round) !== Number(last.round) + 1) return { op: "room", room: view };
    const delta = deltaFor(room, side, view);
    if (!delta) return { op: "room", room: view };
    // If most of the board moved, the difference is not smaller than the frame.
    const moved = delta.pieces.length + delta.gone.length;
    if (moved * 2 >= (view.pieces || []).length + moved) return { op: "room", room: view };
    return { op: "delta", roomId: room.id, delta };
  }

  function tellRoom(room, skip = "") {
    for (const seat of [room.seats.blue, room.seats.red]) {
      if (seat.kind !== "human") continue;
      if (seat.username === skip) continue;
      const peer = sockets.get(seat.username);
      if (!peer) continue;
      const side = room.seats.blue.username === seat.username ? "blue" : "red";
      const view = roomView(room, seat.username);
      const frame = frameFor(room, side, view, seat.username);
      setSeatShadow(room, side, view);
      peer.send(frame);
    }
  }

  // A disconnect pauses the game; it does not destroy it. The seat stays reserved for the
  // account, the room stays in the store, and the clock stops so nothing runs unwatched.
  //
  // PB-134 (openchq-pm 7439): this stop is the ROOM's, and it CLEARS the dropped seat's hold. A
  // room hold is never a refusal: the present seat's `run` is accepted, so an absent seat can never
  // gate the clock. The hold's only job is to say why the clock is stopped and to keep a rejoin from
  // starting it on its own.
  function holdRoom(room, note, seat) {
    // A deploy is not the player's pause. While the process is draining, a disconnect is ours,
    // so the room is marked to resume instead of being stopped and saved as stopped.
    if (room.resume) {
      room.note = note;
      saveRoom(room);
      return;
    }
    if (seat) holdsOf(room)[seat] = false;
    room.clock = "held";
    room.holdRoom = true;
    if (room.match) room.match.clock = "held";
    room.note = note;
    saveRoom(room);
    tellRoom(room);
  }

  // A rejoin restores the seat and clears the room hold, but it does NOT start the clock: a game
  // resumes on an explicit `run`, never on a connect (seatView). If the present seat never ran while
  // the other side was gone, the clock is still held when that seat comes back.
  function wakeRoomHold(room) {
    if (!room || room.holdRoom !== true) return;
    room.holdRoom = false;
    saveRoom(room);
  }

  function endRoom(room, reason) {
    room.note = reason;
    shadows.delete(room.id);
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
      // A rejoin never starts the clock (wakeRoomHold): the note is replaced with the state both
      // seats are actually in.
      if (room.clock === "held") room.note = "Both seats are present. The clock is still held.";
      saveRoom(room);
    }
    return roomView(room, username);
  }

  // A second tab on one session takes the socket over, one way only. Before this the older
  // peer was closed with 1000, which the older tab read as "the server went away" and answered
  // by reconnecting: two tabs then traded the socket every couple of seconds, each showing
  // "Connection lost" and "Reconnected" in turn. The replacement now says so explicitly and
  // closes with 4001, which the page treats as final for that tab.
  function replace(previous) {
    if (!previous || previous.closed) return;
    previous.send({ op: "replaced", reason: "This session was opened in another tab." });
    previous.close(TAKEOVER_CODE);
  }

  function join(username, peer) {
    claimName(username);
    const previous = sockets.get(username);
    sockets.set(username, peer);
    if (previous && previous !== peer) replace(previous);
    peer.onclose = () => {
      if (sockets.get(username) !== peer) return;
      sockets.delete(username);
      const roomId = seatOf.get(username);
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const seat = seatUsername(room, username);
        holdRoom(room, nameOf(username) + " disconnected. The match is paused and still yours.", seat);
      }
      for (const [id, invite] of invites) {
        if (invite.from === username || invite.to === username) invites.delete(id);
      }
      // The name is released only once the account is really offline: a takeover keeps it.
      if (!seatOf.has(username)) releaseName(username);
      sendPresence();
    };
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    // PB-134: a rejoin is the one thing that clears a disconnect's room hold.
    wakeRoomHold(room);
    const view = seatView(room, username);
    // Whatever this seat was sent before it disconnected is not in its browser any more: the
    // welcome is a full frame, so the next one must be too.
    if (room) forgetSeat(room, room.seats.blue.username === username ? "blue" : "red");
    peer.send({
      op: "welcome",
      username: nameOf(username),
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
    endRoom(rooms.get(roomId), nameOf(username) + " left the match.");
    return { ok: true };
  }

  // Resigning is a loss with a name: the other side wins, the clock stops, and the room stays so the
  // result can be read. It is not `leave`, which throws the game away without a winner.
  function resignOp(username) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    if (room.match.over) return { error: "The match is already over." };
    const other = mine === "blue" ? "red" : "blue";
    room.match.over = true;
    room.match.winner = other;
    room.clock = "held";
    // PB-134: this stop belongs to the result, not to a seat. A seat hold left over from before the
    // resignation would make the next `run` read as "held by <seat>" over a finished match.
    room.holds = { blue: false, red: false };
    room.match.clock = "held";
    room.note = nameOf(username) + " resigned. " + other + " wins.";
    saveRoom(room);
    tellRoom(room);
    return { ok: true };
  }

  // A new game in the same era on the same side. The old room is closed for good: a player asking for
  // a new game is done with the old one, and two live rooms for one seat is how a seat gets torn.
  function newGameOp(username) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const era = room.era;
    // A new game keeps the handicap the player chose, unless the era has no spinner.
    const spinner = room.match && room.match.handicap ? room.match.handicap.billions : undefined;
    endRoom(room, nameOf(username) + " started a new game.");
    return startBot(username, era, mine, spinner);
  }

  function startBot(username, era, side, handicap) {
    if (seatOf.has(username)) return { error: "Leave the current match first." };
    const mine = sideOf(side);
    const other = mine === "blue" ? "red" : "blue";
    const year = eraOf(era);
    // The original's setup asked for the OPPONENT'S STARTING MONEY with a three-digit spinner and
    // used it as a handicap (Manual p.17). The lobby asks the same question with the era's
    // recovered default. 2023 has no spinner at all, so a value sent for it is ignored rather than
    // turning a large-pool scenario into a hidden handicap.
    const spec = handicapSpec();
    const hasSpinner = handicapDefault(year) !== null;
    let spinner = null;
    if (handicap !== undefined && handicap !== null && String(handicap) !== "") {
      const value = Number(handicap);
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
        return {
          error: "The opponent's starting money must be a whole number from " +
            spec.min + " to " + spec.max + " billion.",
        };
      }
      if (hasSpinner) spinner = value;
    }
    const room = {
      id: randomBytes(8).toString("hex"),
      mode: "bot",
      era: year,
      clock: "held",
      // The bot never sends a clock op, so its seat never holds: human+bot stays as it was (AC2).
      holds: { blue: false, red: false },
      holdRoom: false,
      // T-004: a room carries its own clock speed (0-6). 1 is the old single 5 s round.
      speed: 1,
      note: "Clock held. The board is waiting for orders.",
      seats: {
        blue: { username: "Bot", kind: "bot" },
        red: { username: "Bot", kind: "bot" },
      },
      match: opened(year, sitesForMatch(year),
        spinner === null ? {} : { handicapSide: other, opponentPool: spinner }),
    };
    room.seats[mine] = { username, kind: "human" };
    room.seats[other] = { username: "Bot", kind: "bot" };
    stampSeats(room);
    openFilm(room);
    rooms.set(room.id, room);
    saveRoom(room);
    seatOf.set(username, room.id);
    tellRoom(room);
    sendPresence();
    return { ok: true };
  }

  // An invite names a display name; the server resolves it back to the one account, so the real
  // handle is never asked for and never echoed.
  function invite(from, toName, era, side) {
    const to = accountFor(toName);
    if (!to) return { error: "That player is not online." };
    if (from === to) return { error: "Invite someone else." };
    if (seatOf.has(from) || seatOf.has(to)) return { error: "One of you is already in a match." };
    const id = randomBytes(8).toString("hex");
    const inviteRow = {
      id,
      from,
      to,
      era: eraOf(era),
      side: sideOf(side),
    };
    for (const [oldId, old] of invites) {
      if (old.from === from && old.to === to) invites.delete(oldId);
    }
    invites.set(id, inviteRow);
    sockets.get(to).send({ op: "invite", invite: publicInvite(inviteRow) });
    sockets.get(from).send({ op: "invited", invite: publicInvite(inviteRow) });
    return { ok: true };
  }

  // What an invite looks like off the server: display names only.
  function publicInvite(inviteRow) {
    return {
      id: inviteRow.id,
      from: nameOf(inviteRow.from),
      to: nameOf(inviteRow.to),
      era: inviteRow.era,
      side: inviteRow.side,
    };
  }

  function answer(username, inviteId, accept) {
    const inviteRow = invites.get(String(inviteId ?? ""));
    if (!inviteRow || inviteRow.to !== username) return { error: "That invite is gone." };
    invites.delete(inviteRow.id);
    const sender = sockets.get(inviteRow.from);
    if (!accept) {
      if (sender) sender.send({ op: "declined", by: nameOf(username) });
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
      // PB-134: a fresh room has no seat holding it, and no disconnect stopping it.
      holds: { blue: false, red: false },
      holdRoom: false,
      speed: 1,
      note: "Clock held. The board is waiting for orders.",
      seats: { blue: null, red: null },
      match: opened(inviteRow.era, sitesForMatch(inviteRow.era)),
    };
    room.seats[mine] = { username: inviteRow.from, kind: "human" };
    room.seats[other] = { username, kind: "human" };
    stampSeats(room);
    openFilm(room);
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
    // PB-224: a selected satellite previews its own flight, not a ground walk.
    const plan = satelliteById(room.match, pieceId)
      ? planSatellite(room.match, mine, pieceId, to.x, to.y)
      : planOrder(room.match, mine, pieceId, to.x, to.y);
    const reply = plan && plan.error
      ? { op: "route", piece: pieceId, to, error: plan.error }
      : { op: "route", piece: pieceId, to, path: plan.path, rounds: plan.rounds };
    if (peer) peer.send(reply);
    return { ok: true };
  }

  // Where a purchase may stand. The page asks for this when a unit is armed and paints the mask, so
  // the highlight is the server's own rule rather than a second copy of it in the browser.
  function placementOp(username, message) {
    const room = roomFor(username);
    const peer = sockets.get(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const kind = String(message.kind ?? "");
    const mask = placementMask(room.match, mine, kind, boardPayload());
    if (mask.error) {
      if (peer) peer.send({ op: "placement", kind, error: mask.error });
      return { ok: true };
    }
    if (peer) {
      peer.send({
        op: "placement",
        kind,
        width: mask.width,
        height: mask.height,
        count: mask.count,
        ready: mask.ready,
        unready: mask.unready,
        domain: mask.domain,
        rule: mask.rule,
        snap: mask.snap,
        box: mask.box,
        mask: maskBase64(mask.mask),
      });
    }
    return { ok: true };
  }

  // The late kit and the air were in the engine and reachable by nobody: no op, no button. These
  // two ops are the door. They take the same seat checks as an order, so a forged side is still
  // refused by the module and by seatUsername, not by the page.
  function toolOp(username, message) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    if (room.clock !== "running" && !toolOpensWhileHeld(room.match, String(message.tool ?? ""))) {
      // A held clock is not a reason to lose a satellite pass, and PB-235 lets aid into the pre-game
      // (round 0, the clock not yet started; manual p.14). Every other tool stays refused while the
      // clock is held: spending money into a mid-war pause is how a pause becomes a free turn. Aid
      // gets its own sentence here (AC4): the generic clock line cannot tell a player why the one
      // tool the manual puts in the pre-game is unavailable after the war has started.
      return {
        error: String(message.tool ?? "") === "aid" ? AID_HELD_MID_WAR : "Start the clock first.",
      };
    }
    const result = useTool(room.match, mine, String(message.tool ?? ""), message.to || null);
    if (!result || result.error) {
      // PB-242 AC2: a refusal carries WHY it refused (`reason`) and, for a cell the territory map
      // leaves unassigned, whether the ground was water or land (`terrain`). Rebuilding the reply
      // with only `error` here dropped both fields, so main.mjs's passthrough forwarded two nulls
      // and a lake read to a player exactly like the open sea - the one distinction this ticket is
      // about. Copy them through; the sentence itself is not touched (its wording is PB-240's).
      return {
        error: (result && result.error) || "That tool was refused.",
        reason: (result && result.reason) ?? null,
        terrain: (result && result.terrain) ?? null,
      };
    }
    // A tool is used between rounds; its line belongs to the round that follows it, the same way an
    // escort order and a mission do.
    if (Array.isArray(result.events) && result.events.length) {
      if (!Array.isArray(room.match.pendingEvents)) room.match.pendingEvents = [];
      room.match.pendingEvents.push(...result.events);
    }
    touch(room);
    tellRoom(room);
    return { ok: true, events: result.events || [] };
  }

  function missionOp(username, message) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const plane = String(message.piece ?? message.pieceId ?? "");
    if (!plane) return { error: "A mission needs an aircraft." };
    const result = sendMission(room.match, mine, plane, String(message.mode ?? ""), message.to || null);
    if (!result || result.error) return { error: (result && result.error) || "That mission was refused." };
    // A mission is flown between rounds, like an escort order: its line belongs to the round that
    // follows it, and without this the round log never mentioned a scramble at all.
    if (Array.isArray(result.events) && result.events.length) {
      if (!Array.isArray(room.match.pendingEvents)) room.match.pendingEvents = [];
      room.match.pendingEvents.push(...result.events);
    }
    touch(room);
    tellRoom(room);
    return { ok: true, events: result.events || [] };
  }

  // Digging in and repairing are a piece's own orders, so they take a piece id and nothing else.
  function pieceOp(username, message, kind) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const pieceId = String(message.piece ?? message.pieceId ?? "");
    if (!pieceId) return { error: "That needs a piece id." };
    const result = kind === "entrench"
      ? entrench(room.match, mine, pieceId)
      : repair(room.match, mine, pieceId);
    if (!result || result.error) return { error: (result && result.error) || "That was refused." };
    touch(room);
    tellRoom(room);
    return { ok: true, events: result.events || [] };
  }

  function roomFor(username) {
    const roomId = seatOf.get(username);
    return roomId ? rooms.get(roomId) : null;
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
      // PB-224: a satellite is a unit with its own destination order (manual p.12). It never touches
      // the ground walker: no terrain, no lanes, no collision.
      result = satelliteById(room.match, pieceId)
        ? orderSatellite(room.match, mine, pieceId, to.x, to.y)
        : issueOrder(room.match, mine, pieceId, to.x, to.y);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "The order was refused." };
    touch(room);
    tellRoom(room);
    // The seat hears its own order back: the page acknowledges in place instead of guessing
    // that a silent socket meant success.
    const peer = sockets.get(username);
    if (peer) {
      const reply = { op: "ordered", id: message.id ?? null, piece: pieceId, to, rounds: result.rounds ?? 0 };
      peer.send(reply);
      rememberReply(username, message.id, reply);
    }
    return { ok: true };
  }

  // An escort is a decision, not a movement: the warship is told to travel with the transport and
  // the ship trails it one cell a round. Passing no transport releases the ship.
  function escortOp(username, message) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const claimed = message.side === undefined || message.side === null ? mine : String(message.side);
    if (claimed !== mine) return { error: "That side is not yours. You hold " + mine + "." };

    const shipId = String(message.ship ?? message.piece ?? message.pieceId ?? "");
    if (!shipId) return { error: "An escort needs a ship id." };
    const transportId = message.transport === undefined ? null : message.transport;

    const result = orderEscort(room.match, mine, shipId, transportId);
    if (!result || result.error) return { error: (result && result.error) || "The escort was refused." };
    touch(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) peer.send({ op: "escorted", ship: result.ship, transport: result.transport ?? null });
    return { ok: true };
  }

  // PB-134: the clock is held PER SEAT, and `run` releases only the sender's own hold.
  //
  // A hold from either seat takes effect at once: the clock is held while any seat holds, and the
  // other seat cannot lift it. If both seats hold, a run releases the sender's own hold and is then
  // refused naming the seat that still holds - so the clock starts when the last holder runs, and
  // never because one seat asked twice.
  //
  // A dropped socket is not a seat's hold and is never a REFUSAL (openchq-pm 7439): the drop clears
  // that seat's hold and marks the room held, and the present seat's `run` is then accepted, so an
  // absent seat can never gate the clock. There is only one refusal string - the seat-hold one.
  //
  // The refusal text is owned by the ticket and is quoted there verbatim; frodo's AC4 arm 2 diffs
  // the served string against that line, so do not reword it here alone.
  const SEAT_HOLD_REFUSAL = (seat) => "The clock is held by " + seat + ". Only " + seat + " can resume it.";

  // A room written before PB-134 carries no hold table: an empty one is the same clock it had.
  function holdsOf(room) {
    if (!room.holds || typeof room.holds !== "object") room.holds = { blue: false, red: false };
    return room.holds;
  }

  function setClock(username, running) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return { error: "You are not in a match." };
    // The same seat test every other seat-scoped op uses: the side is never read from the message.
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const holds = holdsOf(room);
    if (!running) {
      // A hold is never refused, and both seats see it on the next frame.
      holds[mine] = true;
      room.clock = "held";
      if (room.match) room.match.clock = "held";
      room.note = "Clock held. The board is waiting for orders.";
      saveRoom(room);
      tellRoom(room);
      return { ok: true, clock: room.clock };
    }
    // A run releases the sender's own hold first, then looks at what is left.
    holds[mine] = false;
    // A room hold left by a dropped seat is cleared by a present seat's run, never refused: the
    // absent seat cannot be asked, and a dead socket must not gate the clock (openchq-pm 7439).
    if (room.holdRoom === true) room.holdRoom = false;
    const other = mine === "blue" ? "red" : "blue";
    if (holds[other] === true) {
      // The sender's own hold is now cleared; the other seat's is not theirs to clear.
      saveRoom(room);
      const seat = nameOf(room.seats[other] && room.seats[other].username);
      return { error: SEAT_HOLD_REFUSAL(seat) };
    }
    room.clock = "running";
    // A started clock begins its own round now, not at whatever the last held room left behind.
    room.tickedAt = Date.now();
    if (room.match) room.match.clock = room.clock;
    room.note = "Clock running. Pieces move one cell a round.";
    saveRoom(room);
    tellRoom(room);
    return { ok: true, clock: room.clock };
  }

  // Manual p.34-35: the game speed is 0 through 6, and speed 0 still accepts orders and air
  // strikes while game time does not pass. Either seat may change it - the simplest reading of an
  // agreed setting - and both seats see the same number, because the room's view carries it.
  function setSpeed(username, message) {
    const room = roomFor(username);
    if (!room) return { error: "You are not in a match." };
    if (!seatUsername(room, username)) return { error: "You do not hold a seat in this match." };
    const current = speedOf(room);
    const sentence = "The speed must be a whole number from " + SPEED_MIN + " to " + SPEED_MAX + ".";
    let wanted = message && message.speed !== undefined ? clampSpeed(message.speed) : null;
    if (wanted === null && message && message.delta !== undefined) {
      const delta = Number(message.delta);
      if (!Number.isFinite(delta) || delta === 0) {
        return { error: sentence };
      }
      const next = current + Math.sign(delta);
      if (next < SPEED_MIN || next > SPEED_MAX) {
        // A step past the end of the range is a no-op, not a refusal (PB-129). The page disables
        // the button at the top and the bottom, but a script-dispatched click, a tab a deploy
        // behind, or the other seat moving the end at the same instant can still send it — and
        // "The speed must be a whole number from 0 to 6." is not something the player did. The
        // seat that asked still hears the room's real number, so a readout that drifted (the other
        // seat changed the speed) catches up without a room frame being owed to it.
        const peer = sockets.get(username);
        if (peer) {
          peer.send({ op: "speed", speed: room.speed, roundSeconds: roomSeconds(room), clock: room.clock, unchanged: true });
        }
        return { ok: true, speed: room.speed, unchanged: true };
      }
      wanted = clampSpeed(next);
    }
    if (wanted === null) {
      return { error: sentence };
    }
    room.speed = wanted;
    // A change of speed restarts the room's round clock, so a slow round already half spent does
    // not make a fast speed look slow for one beat.
    if (room.clock === "running") room.tickedAt = Date.now();
    room.note = wanted === 0
      ? "Speed 0. Orders are accepted; game time does not pass."
      : "Speed " + wanted + ".";
    touch(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) {
      peer.send({ op: "speed", speed: room.speed, roundSeconds: roomSeconds(room), clock: room.clock });
    }
    return { ok: true, speed: room.speed };
  }

  // The server owns the clock. main.mjs calls this once per configured round; every room whose
  // clock is running advances exactly one round and is marked dirty. The store takes a slice
  // of the dirty rooms each round (rooms.flushRooms), so 1000 running rooms are all durable
  // within a few rounds without any single round paying for all of them. A held, finished or
  // unwatched room costs nothing.
  let flushCursor = 0;
  // `now` is the wall clock in ms. Without it every call is one round - the shape the whole test
  // suite and every harness was written against - and with it the room advances only when its own
  // speed's round length has elapsed (T-004, Manual p.34-35).
  function tickRooms(now) {
    const stamp = now === undefined || now === null ? null : Number(now);
    const events = [];
    for (const room of rooms.values()) {
      if (!room.match || room.match.over || room.clock !== "running") continue;
      // PB-158: a running intel pass is sampled faster than the round clock (250 ms), because
      // the bar crosses the board in 15.85 s while a round at the shipped speed is 5 s. Only a
      // room with an armed pass pays this cost, and the span sent is still the bar's own.
      if (stamp !== null && scanAnyActive(room.match, stamp)) {
        const lastScanSend = Number(room.scanSentAt) || 0;
        if (stamp - lastScanSend >= 250) {
          room.scanSentAt = stamp;
          tellRoom(room);
        }
      }
      if (stamp !== null) {
        const speed = speedOf(room);
        // Speed 0: orders and air strikes are still accepted, but game time does not pass.
        if (speedSeconds(speed) <= 0) {
          room.tickedAt = stamp;
          continue;
        }
        const lastAt = Number(room.tickedAt);
        if (!Number.isFinite(lastAt) || lastAt <= 0) {
          room.tickedAt = stamp;
          continue;
        }
        if (!speedDue(speed, stamp - lastAt)) continue;
        // Exactly one round per due call, and no backlog: the base interval is 50 ms, so a
        // process that stalled must not fast-forward a match by minutes of rounds.
        const ms = Math.max(20, Math.round(speedSeconds(speed) * 1000));
        room.tickedAt = lastAt + Math.floor((stamp - lastAt) / ms) * ms;
      }
      // Bot orders belong to bot seats, never to a room mode. A human room has no bot seat,
      // so neither side is given orders there; a bot seat in any room is still a bot.
      for (const side of ["blue", "red"]) {
        const seat = room.seats[side];
        if (!seat || seat.kind !== "bot") continue;
        if (!room.match.seats) stampSeats(room);
        let issued = [];
        try {
          issued = botOrders(room.match, side) || [];
        } catch (err) {
          console.error("bot orders failed:", err && err.message ? err.message : err);
        }
        // Every bot decision is a line an operator can read without opening a browser, and the
        // owner's debug view keeps the last ten. Silent bots are indistinguishable from fog.
        if (issued.length) {
          if (!Array.isArray(room.botActions)) room.botActions = [];
          for (const event of issued) {
            if (event.type === "bot_buy") {
              console.log(`bot ${room.id} r${Number(room.match.round) + 1} buy ${event.kind} at ${event.at ? event.at.x + "," + event.at.y : "?"}`);
              room.botActions.push({ round: Number(room.match.round) + 1, type: "buy", kind: event.kind, at: event.at || null });
            } else if (event.type === "bot_order") {
              console.log(`bot ${room.id} r${Number(room.match.round) + 1} order ${event.pieceId} -> ${event.to ? event.to.x + "," + event.to.y : "?"}`);
              room.botActions.push({ round: Number(room.match.round) + 1, type: "order", piece: event.pieceId, to: event.to || null });
            }
          }
          if (room.botActions.length > 10) room.botActions = room.botActions.slice(-10);
        }
      }
      const result = tickMatch(room.match);
      room.match = result.match;
      // T-031: the round is recorded from the tick's OWN events, before anything else reads them.
      recordFilm(room, result.events);
      room.dirty = true;
      tellRoom(room);
      if (result.events && result.events.length) events.push({ roomId: room.id, events: result.events });
      // The clock is dead time without a log. Each human seat gets the round as it could see it,
      // which is the view's own sight rule applied to events instead of pieces.
      // PB-196: this loop runs EVERY round, including one with no events, because logLines
      // refreshes the seat's sight memory inside the builder; a skipped call would make a
      // stationary unit's cell look "lost from sight" and re-report it next round.
      for (const side of ["blue", "red"]) {
        const seat = room.seats[side];
        if (!seat || seat.kind !== "human") continue;
        const lines = logLines(room.match, side, result.events || [], room.match.round);
        if (lines.length) {
          // The log outlives the socket: it is part of the room, so a reload shows the match
          // that has been happening instead of an empty window.
          if (!room.log) room.log = { blue: [], red: [] };
          if (!Array.isArray(room.log[side])) room.log[side] = [];
          room.log[side].push(...lines);
          // The page draws a window of ROUNDS (dialogs.logWindow). A chatty round is a dozen
          // contact lines, so a 60-line buffer held only the newest round; keep enough for six
          // (PB-121) and keep this figure equal to the page's LOG_KEEP.
          if (room.log[side].length > 240) room.log[side] = room.log[side].slice(-240);
        }
        const peer = sockets.get(seat.username);
        if (!peer || !lines.length) continue;
        peer.send({ op: "log", roomId: room.id, round: room.match.round, lines });
      }
      if (room.match.over) {
        room.clock = "held";
        room.note = resultNote(room.match);
        saveRoom(room);
        room.dirty = false;
        tellRoom(room);
        const winner = room.match.winner;
        const result = resultOf(room.match);
        for (const seat of [room.seats.blue, room.seats.red]) {
          if (seat.kind !== "human") continue;
          const peer = sockets.get(seat.username);
          if (peer) peer.send({ op: "over", roomId: room.id, winner, result, note: room.note });
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
      // PB-224 (PM 8905 §2): a recon satellite is bought at the point the player picks, not placed
      // on a friendly city. Its own module owns the rule; everything else still goes through buy().
      result = isSatelliteKind(message.kind)
        ? buySatellite(room.match, mine, at.x, at.y)
        : buy(room.match, mine, message.kind, at.x, at.y, boardPayload());
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "The purchase was refused." };
    touch(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) {
      const reply = {
        op: "bought",
        id: message.id ?? null,
        kind: result.piece.kind,
        piece: result.piece.id,
        at: { x: result.piece.x, y: result.piece.y },
        // PB-044: the line names the site ("Bought an infantry at Kharkov"), never the cell.
        // A satellite has no site; the page falls back to its point.
        site: result.label || null,
        cash: room.match.sides && room.match.sides[mine] ? room.match.sides[mine].cash : null,
      };
      peer.send(reply);
      rememberReply(username, message.id, reply);
    }
    return { ok: true };
  }

  // An order carries an id so a resend after a reconnect cannot apply twice. The first copy
  // runs; a later copy of the same id is answered with the reply the first copy got, not applied
  // again. That reply matters: a page that lost the socket after writing an order used to learn
  // only "duplicate", so the purchase landed with no confirmation on screen (PB-025).
  const seenOrderIds = new Map();
  const orderReplies = new Map();
  // PB-172: a mission is an order too. The page stamps every order with an id, and the mission ack
  // used to carry none, so a mission was never settled and its id stayed in the page's queue until
  // the next socket open replayed it — where the server, seeing the plane already away, answered
  // "That aircraft is inactive for N more rounds." and the page painted that as a refusal. A
  // replayed buy or move is idempotent; a replayed mission is not, so "mission" joins the set and a
  // replay is answered from orderReplies with the ack the first copy earned.
  const DEDUPE_OPS = new Set(["buy", "order", "mission"]);
  function rememberReply(username, id, reply) {
    if (id === undefined || id === null) return;
    const key = username + "|" + String(id);
    orderReplies.set(key, reply);
    if (orderReplies.size > 1000) orderReplies.delete(orderReplies.keys().next().value);
  }
  function handle(username, message) {
    const op = String(message.op ?? "");
    const dedupe = DEDUPE_OPS.has(op) && message.id !== undefined && message.id !== null;
    const key = dedupe ? username + "|" + String(message.id) : "";
    if (dedupe && seenOrderIds.has(key)) {
      const peer = sockets.get(username);
      if (peer) {
        const reply = orderReplies.get(key);
        peer.send(reply ? { ...reply, duplicate: true } : { op: "ack", id: message.id, duplicate: true });
      }
      // main.mjs sends nothing more for this one: the replay's answer is the one already sent.
      return { ok: true, answered: true };
    }
    const result = dispatch(username, message);
    if (dedupe && result && !result.error) {
      seenOrderIds.set(key, Date.now());
      // A mission's reply is the ack main.mjs writes, so the memory has to be the ack itself —
      // otherwise a replay is answered with a bare `{op:"ack", duplicate}` that says nothing
      // about the run that landed.
      if (op === "mission") {
        rememberReply(username, message.id, { op: "ack", id: message.id, events: Array.isArray(result.events) ? result.events : [] });
      }
      if (seenOrderIds.size > 1000) {
        const oldest = seenOrderIds.keys().next().value;
        seenOrderIds.delete(oldest);
      }
    }
    return result;
  }

  function dispatch(username, message) {
    const op = String(message.op ?? "");
    // The older wire name for a hull survives as an alias so an existing page or script does not
    // lose a purchase when the roster split hulls into cruiser and carrier. The alias lives in
    // migrate.mjs, next to the save migration that does the same rename.
    if (message) message.kind = compatUnitKind(message.kind);
    if (op === "bot") return startBot(username, message.era, message.side, message.handicap);
    if (op === "invite") return invite(username, String(message.user ?? ""), message.era, message.side);
    if (op === "answer") return answer(username, message.id, Boolean(message.accept));
    if (op === "order") return order(username, message);
    if (op === "buy") return buyOp(username, message);
    if (op === "route") return routeFor(username, message);
    if (op === "placement") return placementOp(username, message);
    if (op === "tool") return toolOp(username, message);
    if (op === "mission") return missionOp(username, message);
    if (op === "entrench") return pieceOp(username, message, "entrench");
    if (op === "repair") return pieceOp(username, message, "repair");
    if (op === "escort") return escortOp(username, message);
    if (op === "run") return setClock(username, true);
    if (op === "hold") return setClock(username, false);
    if (op === "speed") return setSpeed(username, message);
    if (op === "sync") return syncSeat(username);
    if (op === "fullframes") {
      if (message.on === false) verbose.delete(username);
      else verbose.add(username);
      return { ok: true, on: verbose.has(username) };
    }
    if (op === "leave") return leave(username);
    if (op === "quit") return leave(username);
    if (op === "resign") return resignOp(username);
    if (op === "newgame") return newGameOp(username);
    return { error: "Unknown request." };
  }

  // A page that notices a missing round asks for the whole room instead of guessing.
  function syncSeat(username) {
    const roomId = seatOf.get(username);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return { error: "You are not in a match." };
    const side = room.seats.blue.username === username ? "blue" : "red";
    forgetSeat(room, side);
    const peer = sockets.get(username);
    const view = roomView(room, username);
    if (peer) peer.send({ op: "room", room: view });
    setSeatShadow(room, side, view);
    return { ok: true };
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

  // A read-only dump of what the server holds for one room. main.mjs serves it only when
  // OPENCHQ_DEBUG=1, so a public host never exposes it; it exists so a stalled leg can be
  // diagnosed from the server's own state instead of the seat's filtered view. It answers the
  // questions a freeze raises: which round, is the clock held, what is every piece's next step,
  // who is fighting whom, what did the bot last do, and what did the log say.
  function debugRoom(id) {
    const room = rooms.get(id);
    if (!room) return null;
    const match = room.match || {};
    const pieces = (match.pieces || []).slice(0, 600).map((p) => ({
      id: p.id, side: p.side, domain: p.domain, kind: p.kind, x: p.x, y: p.y,
      steps: Array.isArray(p.path) ? p.path.length : 0,
      next: Array.isArray(p.path) && p.path.length ? p.path[0] : null,
      fighting: p.fighting ?? null, shots: p.shots ?? 0,
      // PB-211 (D-030): the beat is per pair now, so a flat bar has a visible reason. DEBUG only -
      // main.mjs serves this dump only under OPENCHQ_DEBUG=1 and view.mjs never projects the field.
      lastShotRound: p.lastShotRound ?? -1,
      strength: p.strength ?? null, entrenched: p.entrenched === true, pinned: p.pinned === true,
    }));
    return {
      id: room.id,
      round: match.round ?? null,
      clock: room.clock ?? match.clock ?? null,
      speed: room.speed ?? null,
      over: Boolean(match.over),
      winner: match.winner ?? null,
      note: room.note || "",
      seats: {
        blue: room.seats && room.seats.blue ? room.seats.blue.kind : null,
        red: room.seats && room.seats.red ? room.seats.red.kind : null,
      },
      pendingEvents: Array.isArray(match.pendingEvents) ? match.pendingEvents.slice(-20) : [],
      botActions: Array.isArray(room.botActions) ? room.botActions.slice(-10) : [],
      log: {
        blue: ((room.log && room.log.blue) || []).slice(-15),
        red: ((room.log && room.log.red) || []).slice(-15),
      },
      pieces,
      pieceCount: (match.pieces || []).length,
      capitals: capitalListOf(match),
      capitalSet: match.capitalSet ? { size: (match.capitalSet.list || []).length, missing: match.capitalSet.missing || [] } : null,
    };
  }

  return { join, handle, presence, tickRooms, beginDrain, flushAll, broadcast, debugRoom };
}

// What an era sells lives in shop.mjs; it is pure so the roster test can read it without a
// database. The prices are config and the era gates are the archive's.

// A match opens with its countries already owned. Ownership used to be seeded lazily on the
// first purchase, which meant a 2023 board showed no friendly city at all and the empty era
// could not be played: there was nothing to click. Seeding at open is the same rule, applied
// early enough for the view to carry it.
function opened(era, sites, options = {}) {
  const match = openMatch(eraOf(era), sites, options);
  seedOwners(match);
  return match;
}


