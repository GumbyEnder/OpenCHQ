import { randomBytes } from "node:crypto";
import { deleteRoom, flushRooms, flushWindow, loadRooms, pruneRooms, saveRoom, unpackMatch } from "./rooms.mjs";
import { tickMatch } from "./tick.mjs";
import { forSeat, resultNote, resultOf, capitalListOf } from "./view.mjs";
import { botCeasefireAnswer, citiesHeld, ordersFor as botOrders } from "./bot.mjs";
import { boardPayload, matchSites } from "./board.mjs";
import { eraOf, openMatch, piecesFor } from "./match.mjs";
import { entrench, issueOrder, launchStartingDestinations, planOrder, repair, setStartingDestination, transferPiece } from "./move.mjs";
import { sendMission } from "./air.mjs";
import { orderEscort } from "./escort.mjs";
import { AID_HELD_MID_WAR, answerCeasefire, CEASEFIRE_NOTE, nukeStatus, toolOpensWhileHeld, toolsForEra, useTool } from "./late.mjs";
import { peaceActive, peaceOf, resumeWar } from "./peace.mjs";
import { buy, peacePay, seedOwners } from "./economy.mjs";
import { friendlySites, maskBase64, placementMask } from "./placement.mjs";
import { logLines } from "./log.mjs";
// T-031 step 1: the War Films recorder. A film is a recording of a finished match; nothing here is
// read by a live page, and every call is wrapped so a storage fault can never stop a match.
import { appendFrame, armRestoredFilm, closeFilm, filmFor, forkPackedMatch, framesOf, startFilm } from "./history.mjs";
import { scanActiveFor, scanAnyActive } from "./scan.mjs";
import { handicapDefault, handicapSpec, roundSeconds, speedSeconds, speedDue, clampSpeed, SPEED_MIN, SPEED_MAX, defaultOpponentLevel, noOpponentSeatName, isNoOpponent, opponentLevelOf, opponentName, startPool } from "./rules.mjs";
import { isSatelliteKind, shopFor } from "./shop.mjs";
import { buySatellite, orderSatellite, planSatellite, satelliteById } from "./satellite.mjs";
import { compatUnitKind } from "./migrate.mjs";
import { TAKEOVER_CLOSE_CODE as TAKEOVER_CODE } from "./ws.mjs";
import { displayNames, localName } from "./names.mjs";
// PB-205: named save slots. The store and the resume room live in slots.mjs; the lobby owns the
// live room, the seats and the sockets, so the two ops that touch them live here.
import { humanSeatsOf, listSlots, roomFromSlot, saveSlot, slotFor, warOf } from "./slots.mjs";
// PB-304: Layout Armies and Saved Layouts (manual p.16 l.417, p.37 l.1151-1164). A layout is a
// pregame setup, not a war body: the store keeps the side's pieces and purse, and the lobby owns
// the sandbox room.
import { applyLayout, layoutFor, listLayouts, saveLayout } from "./layouts.mjs";

// PB-304 (d): a layout room is a setup, not a match. Nothing ticks it, no clock op starts it, and
// therefore neither producer of money (the round income and the cold-war peace tick) can pay it.
// One predicate for both gates, so the rule cannot drift between them.
function isLayoutRoom(room) {
  return Boolean(room && room.mode === "layout");
}

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
    if (room.match && room.match.over) closeFilmNow(room);
  } catch (err) {
    console.warn(`[history] frame not recorded for room ${room && room.id}: ${err && err.message ? err.message : err}`);
  }
}

// PB-248: the ONE seam every transition to `over` goes through. Resign, an accepted cease-fire and a
// nuclear winter all end the war OUTSIDE the tick, and the round loop skips a room that is already
// over - so the old recorder never ran and the film stayed open for ever (frodo 9162 §3, PM 9159).
// `closeFilm` appends the closing frame (with any events still queued) and writes the digest; the
// flag goes down here because the room is the recorder's own state, not the store's.
function closeFilmNow(room, events = []) {
  try {
    const closed = closeFilm(room, events);
    if (closed) room.film = false;
    return closed;
  } catch (err) {
    console.warn(`[history] film not closed for room ${room && room.id}: ${err && err.message ? err.message : err}`);
    return null;
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

// PB-273: chat is a message between the two humans, not part of the match. The cap and the escaping
// live here, on the server, beside the other limits: a client that never loads cannot inject past
// them. The same sentence is put on the wire in two forms — `text` for the page's textContent sinks
// and for the Log, `html` for any sink that parses markup — so neither half can be skipped by a
// client, and neither form is produced in the page.
export const CHAT_CAP = 200;
export function cleanChat(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_CAP);
}
export function escapeChat(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  // PB-273: chat is state a delta can carry, but only when it changed — a message that already rode
  // one frame must not be re-sent on every round.
  const chatChanged = last.chat !== signature(view.chat || null);
  const delta = {
    round: view.round,
    ...(chatChanged && view.chat ? { chat: view.chat } : {}),
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
    // PB-250/PB-251: the peace state rides the delta too, and whole. A bot answers a cease fire
    // between rounds - the seat's own `ceasefire` flips on a delta - so a peace that only appeared
    // in whole frames left the strip printing "cease-fire, war may resume" and the enemy still on
    // the board until the next FULL_EVERY (20) frame. Same argument as `result`: a seat that missed
    // one delta must not keep a peace it has already left.
    peace: view.peace || null,
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
  // PB-310: Show Common is a VIEW mode, not a rule. It belongs to one seat's connection in one room,
  // so it lives here and is never written onto the match or the room — the opponent's frames are
  // built for their own side and cannot carry it, which is the "opponent sees nothing" proof.
  const commonSeats = new Map(); // room id -> side -> true
  function commonFor(room, side) {
    const perRoom = commonSeats.get(room.id);
    return Boolean(perRoom && perRoom[side]);
  }
  function setCommon(room, side, on) {
    let perRoom = commonSeats.get(room.id);
    if (!perRoom) { perRoom = {}; commonSeats.set(room.id, perRoom); }
    if (on) perRoom[side] = true;
    else delete perRoom[side];
  }
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
    // PB-273: the chat entry rides the SEAT frame. It is passed into forSeat rather than stored on
    // the match, so the non-seat (spectator/harness) branch — which builds its own object and never
    // reads it — cannot carry a word of it.
    const seen = room.match ? forSeat(room.match, you, Date.now(), room.chat || null, commonFor(room, you)) : null;
    return {
      id: room.id,
      mode: room.mode,
      era: room.era,
      clock: room.clock,
      you,
      blue: { username: room.seats.blue.kind === "bot" ? "Bot" : nameOf(room.seats.blue.username), kind: room.seats.blue.kind },
      red: { username: room.seats.red.kind === "bot" ? "Bot" : nameOf(room.seats.red.username), kind: room.seats.red.kind },
      round: room.match ? room.match.round : 0,
      // PB-273: the last message between the two humans, and whether this room has a chat surface at
      // all. Both are the server's answer: the page does not decide from a seat name it guessed.
      chat: seen ? (seen.chat || null) : null,
      // PB-310: the seat's Show Common answer, ABSENT in Normal mode. Ids of this seat's pieces the
      // enemy can see - never an enemy position, a range, or a count of hidden pieces.
      ...(seen && seen.showCommon ? { showCommon: seen.showCommon } : {}),
      chatOpen: Boolean(room.seats.blue && room.seats.red
        && room.seats.blue.kind === "human" && room.seats.red.kind === "human"),
      // T-032 B1: which of the five opponents this bot room seated, so the page and a hand-check
      // read the same name the server acts on.
      bot: room.match && Number.isInteger(room.match.opponentLevel)
        ? { level: room.match.opponentLevel, name: opponentName(room.match.opponentLevel) }
        : null,
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
      // cannot see is a rule they cannot use, which is why this rides with the room. PB-304: the
      // layout sandbox has no tools at all (manual p.37 l.1158), so the list is empty there and the
      // server refuses a forged op as well.
      tools: isLayoutRoom(room) ? [] : toolsForEra(room.era).map((tool) => ({
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
      // PB-245: the peace state (manual p.31). Both seats read the same object; `over` above stays
      // false through a cease fire, which is the whole difference between a state and an ending.
      peace: room.match ? peaceOf(room.match) : null,
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
      chat: signature(view.chat || null),
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
    // PB-310: the toggle changes the DRAWN SET, so a delta taken against the shadow of the other
    // mode would hand the page a filtered picture it cannot merge — the same trap the scan path
    // below avoids. A seat in Show Common gets whole frames until it toggles back.
    if (commonFor(room, side)) return { op: "room", room: view };
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
      // A claim to resume staked from a page that is now gone is not a selection: dropping it keeps
      // a disconnecting seat from pairing a room it never reached.
      dropPending(username);
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
    if (isLayoutRoom(room)) return { error: "This is a layout, not a war. Save the setup or leave it." };
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
    // PB-248: the war ended outside a tick, so the film is closed here; without this the header
    // stayed open and the war never appeared in War Films (PM 9159, frodo 9162).
    closeFilmNow(room);
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
    if (isLayoutRoom(room)) return { error: "This is a layout, not a war. Save the setup or leave it." };
    const era = room.era;
    // A new game keeps the handicap the player chose, unless the era has no spinner.
    const spinner = room.match && room.match.handicap ? room.match.handicap.billions : undefined;
    // ... and the opponent level, so "New game" does not silently re-seat a different opponent.
    const level = room.match ? room.match.opponentLevel : undefined;
    endRoom(room, nameOf(username) + " started a new game.");
    return startBot(username, era, mine, spinner, level);
  }

  function startBot(username, era, side, handicap, level, layoutId) {
    if (seatOf.has(username)) return { error: "Leave the current match first." };
    const mine = sideOf(side);
    const other = mine === "blue" ? "red" : "blue";
    const year = eraOf(era);
    // PB-304 (f): a 1986 war may open with a saved layout instead of the standard setup. The layout
    // is the account's own and was drawn for one side; a layout drawn for red cannot open a blue
    // war, because the pieces would be on the wrong half of the board.
    let layout = null;
    if (layoutId !== undefined && layoutId !== null && String(layoutId) !== "") {
      if (year !== "1986") return { error: "Saved layouts are for 1986 wars only." };
      const found = layoutFor(username, layoutId);
      if (found.error) return found;
      if (found.side !== mine) {
        return { error: "That layout was drawn for the " + found.side + " side. Pick " + found.side + " or draw a new layout." };
      }
      layout = found;
    }
    // T-032 B1: the original's setup lists five computer opponents (DS:0x4fea order). A request
    // naming none gets the lobby default; a request naming something that is not one of the five
    // is refused rather than coerced, because "level 9" silently becoming level 3 is a different
    // game than the one the player picked.
    //
    // PB-312 (manual p.35 l.1126-1137): "no opponent" is its own setup choice, named by the
    // config's own sentinel and never by a level number. In that game the machine is given NO seat,
    // so neither side is ever ordered by it - which is what makes the manual's second Switch Sides
    // case a real game rather than a level-1 computer that happens to stand still.
    const noOpponent = isNoOpponent(level);
    let opponentLevel = defaultOpponentLevel();
    if (!noOpponent && level !== undefined && level !== null && String(level) !== "") {
      const wanted = opponentLevelOf(level);
      if (wanted === null) {
        return { error: "The opponent must be one of the five computer levels (1 to 5), or no opponent." };
      }
      opponentLevel = wanted;
    }
    // The original's setup asked for the OPPONENT'S STARTING MONEY with a three-digit spinner and
    // used it as a handicap (Manual p.17, all scenarios). The lobby asks the same question with the
    // era's default, 2023 included; only an era whose config records no default refuses the value.
    const spec = handicapSpec();
    const hasSpinner = handicapDefault(year) !== null;
    let spinner = null;
    if (handicap !== undefined && handicap !== null && String(handicap) !== "") {
      // PB-312: the spinner is the OPPONENT'S starting money (manual p.17). With no opponent there
      // is nobody to give it to, so the request is answered with a sentence rather than silently
      // opening the era's standard pools behind a number the caller thinks it set.
      if (noOpponent) {
        return { error: "A game with no opponent has nobody to give the starting money to. Leave that field empty." };
      }
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
      // PB-312: a no-opponent game is a live war like any other; it is the SEAT that says the
      // machine is not playing. `mode` keeps its two values (bot / human) so films, saves and the
      // layout gate read exactly what they read before.
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
      match: opened(year, sitesForMatch(year), {
        ...(spinner === null ? {} : { handicapSide: other, opponentPool: spinner }),
        // No opponent: the match carries no opponent level at all, so nothing downstream can
        // re-open this room as a bot game on the strength of a number that was never chosen.
        ...(noOpponent ? {} : { opponentLevel }),
      }),
    };
    room.seats[mine] = { username, kind: "human" };
    room.seats[other] = noOpponent
      ? { username: noOpponentSeatName(), kind: "none" }
      : { username: "Bot", kind: "bot" };
    if (noOpponent) {
      room.note = "No opponent: the computer gives no orders on either side. " +
        "Press Switch Sides to hand the seat over.";
    }
    if (layout) {
      const applied = applyLayout(room.match, mine, layout);
      if (applied.error) return applied;
      room.note = "Saved layout \"" + layout.row.name + "\" opened " + mine + " with " +
        applied.count + " units. The clock is held.";
    }
    stampSeats(room);
    openFilm(room);
    rooms.set(room.id, room);
    saveRoom(room);
    seatOf.set(username, room.id);
    tellRoom(room);
    sendPresence();
    return { ok: true };
  }

  // PB-304 (a)(b): Lay Out Armies (manual p.16 l.417, p.37). A special pregame setup for 1986 only:
  // one human seat, no opponent, a held clock and no film. It reuses the match board, so a unit
  // moved inside friendly territory, a destination and a purchase are the ordinary ops; the mode
  // is what makes the clock, the tools and Save Setup answer differently.
  function startLayout(username, era, side) {
    if (seatOf.has(username)) return { error: "Leave the current match first." };
    const year = eraOf(era);
    if (year !== "1986") {
      return { error: "Lay Out Armies is for 1986 wars only. The other eras open on the standard setup." };
    }
    const mine = sideOf(side);
    const other = mine === "blue" ? "red" : "blue";
    const room = {
      id: randomBytes(8).toString("hex"),
      mode: "layout",
      era: "1986",
      clock: "held",
      holds: { blue: false, red: false },
      holdRoom: true,
      speed: 1,
      note: "Layout mode. Move units inside your own ground, give destinations, and buy with your opening funds. No round runs.",
      seats: {
        blue: { username: "Layout", kind: "none" },
        red: { username: "Layout", kind: "none" },
      },
      match: opened("1986", sitesForMatch("1986"), {}),
    };
    room.seats[mine] = { username, kind: "human" };
    room.seats[other] = { username: "Layout", kind: "none" };
    stampSeats(room);
    rooms.set(room.id, room);
    saveRoom(room);
    seatOf.set(username, room.id);
    tellRoom(room);
    sendPresence();
    return { ok: true };
  }

  // Save Setup (manual p.37 l.1160-1161): the named layout rules are Saved Games' own - cleaned,
  // case-folded, explicit overwrite - and the body is the sandbox's pieces plus the side's purse.
  function saveLayoutOp(username, message) {
    const room = roomFor(username);
    if (!room) return { error: "Lay out armies first." };
    if (!isLayoutRoom(room)) return { error: "Save Setup is only for a layout you are drawing." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this layout." };
    const asked = message && message.overwrite;
    const result = saveLayout({
      username,
      name: message && message.name,
      room,
      side: mine,
      overwrite: asked === true || asked === "true" || asked === 1,
    });
    if (result && result.ok && result.layout) {
      result.note = (result.overwritten ? "Overwrote saved layout \"" : "Saved layout \"")
        + result.layout.name + "\" with " + result.layout.pieces + " units.";
    }
    return result;
  }

  function listLayoutOp(username) {
    return { ok: true, layouts: listLayouts(username) };
  }

  // PB-305: Film to Game (manual p.38 l.1170). During a replay the player may press Film to Game at
  // any point and the film becomes a SOLO game from the setup on screen. The film is read per
  // account (filmFor), the frame is the round the page is showing, and the state is the fork the
  // film was painting: recorded units and cells, the frame's strengths and owners, its round. The
  // human takes the side they were playing at that machine; the other side is the computer.
  //
  // The closing frame is refused: the frame that carries `state.over` is the film's end screen, and
  // a game forked from a decided board would either end on its first tick or ignore the result.
  // Every other frame in the replay is fair game, including round 0.
  //
  // Getting the room back to the page is a `sync`, exactly like Resume Saved War - this op only
  // creates the room and seats the caller (resumeSlotOp's shape), so a socket that missed the
  // frame can ask again without forking twice.
  function forkFilmOp(username, id, atRound) {
    if (seatOf.has(username)) return { error: "Leave the current match first." };
    const film = filmFor(username, String(id || ""));
    if (!film) return { error: "No such film.", notFound: true };
    // PB-312: Film to Game opens a game against the COMPUTER (PB-305's own definition). A film of a
    // war against "no opponent" has no computer in it, so forking it would silently seat a bot on the
    // side nobody held and call the result the same war. Refused with a sentence instead.
    if (String(film.blue_user || "") === noOpponentSeatName() || String(film.red_user || "") === noOpponentSeatName()) {
      return {
        error: "That film is a war against no opponent. Film to Game opens a game against the computer, and that war had none.",
      };
    }
    const frames = framesOf(film.id, undefined, 0, Number.MAX_SAFE_INTEGER);
    if (!frames.length) return { error: "That film has no rounds to play." };
    const wanted = Number(atRound);
    const hasWanted = Number.isFinite(wanted);
    let picked = hasWanted ? frames.find((row) => Number(row.round) === Math.trunc(wanted)) || null : null;
    if (!picked && hasWanted) {
      for (const row of frames) if (Number(row.round) <= Math.trunc(wanted)) picked = row;
    }
    if (!picked) picked = frames[0];
    const frame = picked.frame || {};
    if (frame.state && frame.state.over) return { error: "That is the war's last round; there is nothing left to play." };
    const mine = String(film.blue_user || "") === String(username) ? "blue"
      : String(film.red_user || "") === String(username) ? "red"
        : null;
    if (!mine) return { error: "You did not hold a side in that war." };
    const packed = forkPackedMatch(film.start, frame);
    const match = packed ? unpackMatch(packed) : null;
    if (!match) return { error: "That film's round cannot be played." };
    // The film's start state keeps each seat's PURSE and nothing else about the seat (history's
    // packMatch reduces `sides` to cash). Rebuild the rest to the shape a fresh match opens with,
    // so the economy and the view read a whole seat instead of `undefined`; a film that recorded no
    // purse opens on the era's pool, which is what a fresh match does.
    for (const side of ["blue", "red"]) {
      const seat = (match.sides && match.sides[side]) || {};
      match.sides = match.sides || {};
      match.sides[side] = {
        cash: Number.isFinite(Number(seat.cash)) ? Number(seat.cash) : startPool(match.era),
        fuel: null,
        dry: false,
        cities: [],
        wells: [],
        bought: 0,
      };
    }
    match.clock = "held";
    match.foughtRound = -1;
    if (!Number.isFinite(Number(match.roundSeconds)) || Number(match.roundSeconds) <= 0) {
      match.roundSeconds = roundSeconds();
    }
    const other = mine === "blue" ? "red" : "blue";
    const room = {
      id: randomBytes(8).toString("hex"),
      mode: "bot",
      era: String(match.era),
      clock: "held",
      holds: { blue: false, red: false },
      holdRoom: false,
      speed: 1,
      note: "Film to Game: " + String(match.era) + " from round " + (Number(match.round) || 0) +
        ". The clock is held.",
      seats: {
        blue: { username: "Bot", kind: "bot" },
        red: { username: "Bot", kind: "bot" },
      },
      match,
      forkedFrom: String(film.id),
      forkedRound: Number(match.round) || 0,
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
    return { ok: true, id: room.id, round: Number(match.round) || 0, era: match.era, side: mine };
  }

  // PB-205: Save Game (manual p.16 l.416). The body is saveRoom's own state - packMatch plus the
  // seat table, holds and speed - under a name the player typed. The name is per account and
  // case-folded; an existing name is only replaced when the caller asked for the overwrite, so the
  // page's confirmation dialog is the decision and the store can never grow a silent twin.
  function saveSlotOp(username, message) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "Start a match first." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    // PB-304: a layout is a setup, not a war. Save Game would file it among resumable wars, so the
    // two doors are kept apart and Save Setup is the layout's own.
    if (isLayoutRoom(room)) return { error: "This is a layout, not a war. Use Save Setup." };
    // A finished war is War Films' record, not a save: resuming it would show an end screen with a
    // fresh film header and nothing to play.
    if (room.match.over) return { error: "That war is over. War Films keeps its record." };
    const asked = message && message.overwrite;
    const result = saveSlot({
      username,
      name: message && message.name,
      room,
      side: mine,
      overwrite: asked === true || asked === "true" || asked === 1,
    });
    if (result && result.ok && result.slot) {
      result.note = (result.overwritten ? "Overwrote saved war \"" : "Saved war \"")
        + result.slot.name + "\" at round " + result.slot.round + ".";
    }
    return result;
  }

  function listSlotOp(username) {
    return { ok: true, slots: listSlots(username) };
  }

  // Resume Saved War (manual p.36-37). A slot's own seats come back: a bot side stays a bot, and a
  // two-human war comes back with both accounts bound (AC3). The room comes back held and keeps the
  // holds it recorded - a resume is not a play command (PB-134).
  //
  // A two-seat war is not started by the first player to click it. The manual saves it as one war
  // both seats must save (p.36 l.1145) and restarts it only when both have selected it (p.37
  // l.1146-1150), so a two-human resume stakes a claim and answers `waiting`; the room is created
  // by the second seat's claim, and a claim that is never answered creates nothing. A bot war is a
  // one-account save and resumes at once.
  const pendingResume = new Map(); // war id -> Map(username -> { slotId, at, name, waitingOn })
  const PENDING_MINUTES = 10;

  function prunePending() {
    const cutoff = Date.now() - PENDING_MINUTES * 60 * 1000;
    for (const [war, picks] of pendingResume) {
      for (const [user, pick] of picks) if (pick.at < cutoff) picks.delete(user);
      if (!picks.size) pendingResume.delete(war);
    }
  }

  function dropPending(username) {
    for (const [war, picks] of pendingResume) {
      picks.delete(String(username));
      if (!picks.size) pendingResume.delete(war);
    }
  }

  function openSlotRoom(row, state) {
    const room = roomFromSlot(row, state);
    stampSeats(room);
    if (!room.match.over) openFilm(room);
    rooms.set(room.id, room);
    saveRoom(room);
    for (const side of ["blue", "red"]) {
      const seat = room.seats[side];
      if (seat && seat.kind === "human" && seat.username) seatOf.set(seat.username, room.id);
    }
    tellRoom(room);
    sendPresence();
    return { ok: true, id: room.id, round: room.match ? room.match.round : 0, name: row.name };
  }

  function resumeSlotOp(username, id) {
    if (seatOf.has(username)) return { error: "Leave the current match first." };
    const found = slotFor(username, id);
    if (found.error) return found;
    const { row, state } = found;
    const seats = state.seats && typeof state.seats === "object" ? state.seats : {};
    const humans = humanSeatsOf(seats);
    for (const seat of humans) {
      if (seat.username !== username && seatOf.has(seat.username)) {
        return { error: nameOf(seat.username) + " is in another match. Resume this war once that match is left." };
      }
    }
    const war = warOf(row, state);
    if (humans.length < 2) {
      const result = openSlotRoom(row, state);
      return { ...result, war: war.id };
    }
    // (c) A two-player war is not saved until BOTH seats have saved it.
    if (!war.complete) {
      if (war.waitingOn.length) {
        return {
          error: "Both players must save the war before it can be resumed. Waiting on " + war.waitingOn.join(" and ") + ".",
          war,
        };
      }
      return {
        error: "Both players have saved this war, but not the same moment of it. Save again with the clock held.",
        war,
      };
    }
    // (d) Both seats must select the same war. The first claim waits; the second opens the room.
    prunePending();
    dropPending(username);
    const picks = pendingResume.get(war.id) || new Map();
    const waitingOn = humans.filter((seat) => seat.username !== username).map((seat) => nameOf(seat.username));
    picks.set(String(username), { slotId: row.id, at: Date.now(), name: row.name, waitingOn });
    pendingResume.set(war.id, picks);
    if (picks.size < humans.length) {
      return { ok: true, waiting: true, war: war.id, name: row.name, round: Number(row.round) || 0, waitingOn };
    }
    pendingResume.delete(war.id);
    return { ...openSlotRoom(row, state), war: war.id, waitingOn: [] };
  }

  // What a staked claim is waiting for, so the page can say it. No room is created by this read.
  function pendingSlotOp(username) {
    prunePending();
    for (const [war, picks] of pendingResume) {
      const pick = picks.get(String(username));
      if (!pick) continue;
      return { ok: true, waiting: true, war, name: pick.name, waitingOn: pick.waitingOn };
    }
    return { ok: true, waiting: false };
  }

  function cancelSlotOp(username) {
    dropPending(username);
    return { ok: true, waiting: false };
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
    // PB-304 (c) (manual p.37 l.1158): the layout sandbox has no intel and no foreign aid. Each
    // tool gets its own sentence, because the generic clock line below ("Start the clock first.")
    // would be true and useless in a mode where the clock never starts.
    if (isLayoutRoom(room)) {
      if (String(message.tool ?? "") === "scan") {
        return { error: "Intel scans are unavailable while you lay out armies." };
      }
      if (String(message.tool ?? "") === "aid") {
        return { error: "Foreign aid is unavailable while you lay out armies." };
      }
    }
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
    // escort order and a mission do. PB-200 AC4: the event carries that SAME round, so the event a
    // seat is handed and the line it reads in the log name one round instead of two. The old shape
    // stamped the event with the round it was used in and logged it at the next one, which is how a
    // cease fire read as event r1 and log r2.
    queueEvents(room, result.events);
    // PB-248: a nuke can end the war (nuclear winter) inside a tool call, and the tick that would
    // have recorded the round never runs for a finished room. Close the film here; the queued
    // events ride into the closing frame instead of being dropped.
    if (room.match.over) closeFilmNow(room);
    touch(room);
    tellRoom(room);
    return { ok: true, events: result.events || [] };
  }

  // PB-200 AC4: one queue helper for every between-rounds event (a tool, an answer). The ROUND it
  // is logged in is not stamped here any more: `event.round` is the round the fact happened in and
  // is pinned by other cards (PB-235 pins a pre-game gift at round 0), so the agreement with the log
  // is made where the line is built (log.mjs reads the event's own round for the line's round).
  function queueEvents(room, events) {
    if (!Array.isArray(events) || !events.length) return events || [];
    if (!Array.isArray(room.match.pendingEvents)) room.match.pendingEvents = [];
    room.match.pendingEvents.push(...events);
    return events;
  }

  // The clock is dead time without a log. Each human seat gets one beat's events as it could see
  // them, which is the view's own sight rule applied to events instead of pieces.
  // PB-196: this runs EVERY round, including one with no events, because logLines refreshes the
  // seat's sight memory inside the builder; a skipped call would make a stationary unit's cell look
  // "lost from sight" and re-report it next round. T-035 calls it from the peacetime beat too: that
  // beat runs no round but still carries events (a truce answered, the money tick).
  function deliverSeatLog(room, beatEvents) {
    for (const side of ["blue", "red"]) {
      const seat = room.seats[side];
      if (!seat || seat.kind !== "human") continue;
      const lines = logLines(room.match, side, beatEvents || [], room.match.round);
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
  }

  // PB-200 AC1-AC3: the opponent answers a cease fire from the kit. It is not a spend, so it is
  // allowed on a held clock (a seat cannot be held hostage by a pause), and it is only ever the
  // OTHER seat's to send. Accept ends the match here rather than at the next tick: the tick skips a
  // finished room, so a pending "the war is over" event would never be flushed or logged.
  function ceasefireAnswerOp(username, message) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const accept = message.accept !== false && message.accept !== 0 && message.accept !== "false";
    const result = answerCeasefire(room.match, mine, accept);
    if (!result || result.error) return { error: (result && result.error) || "There is no cease fire to answer." };
    if (!result.accepted) {
      // Declined: nothing on the board changed, so the line is queued for the next round like any
      // other between-rounds fact, and the war runs on.
      queueEvents(room, result.events);
      touch(room);
      tellRoom(room);
      return { ok: true, accepted: false, events: result.events };
    }
    // Agreed: PB-245. The war is at PEACE, not over (manual p.31). The clock keeps running, `over`
    // stays false, and no film closes - PB-248's seam keys on a transition to `over`, which this
    // event does not make. Both human seats get the same note and their own log line.
    room.note = CEASEFIRE_NOTE;
    queueEvents(room, result.events);
    saveRoom(room);
    room.dirty = false;
    tellRoom(room);
    for (const side of ["blue", "red"]) {
      const seat = room.seats[side];
      if (!seat || seat.kind !== "human") continue;
      const peer = sockets.get(seat.username);
      if (!peer) continue;
      const lines = logLines(room.match, side, result.events, room.match.round);
      if (lines.length) {
        if (!room.log) room.log = { blue: [], red: [] };
        if (!Array.isArray(room.log[side])) room.log[side] = [];
        room.log[side].push(...lines);
        peer.send({ op: "log", roomId: room.id, round: room.match.round, lines });
      }
    }
    return { ok: true, accepted: true, peace: result.peace || peaceOf(room.match), events: result.events };
  }

  // PB-245: leave the peace. The clock was never stopped, so this writes the state, one line to
  // each seat and nothing else; a refusal before the mandatory counter hits zero changes nothing.
  function resumeWarOp(username) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    // PB-307 (frodo 10049 item 3 / 10057 item 6): a layout is a pregame sandbox, so there is no
    // agreement to leave. Without this line the press broke the 1986 cold war on a room that has no
    // war yet: peace went {active:true} -> {active:false, brokenBy:"blue"} while the round stayed 0.
    if (isLayoutRoom(room)) return { error: "This is a layout, not a war. Save the setup or leave it." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const result = resumeWar(room.match, mine, room.match.round);
    if (!result || result.error) {
      return { error: (result && result.error) || "That was refused.", remaining: (result && result.remaining) || 0 };
    }
    // PB-245b (frodo 9236 §5): the note the agreement left behind - "Cease fire accepted. The war is
    // at peace." - used to outlive the restart, so the War panel went on announcing a peace that no
    // longer stood. It is CLEARED, not rewritten: the break already has one line in each seat's log,
    // and a second sentence here would be the page telling the same act twice.
    room.note = "";
    queueEvents(room, result.events);
    // PB-245b (p.31): "A unit can be given a destination to which it will start to move the moment
    // war begins." The launch runs inside the press that begins the war, for BOTH seats, and its
    // lines ride the same queue as the broken-peace line.
    const launch = launchStartingDestinations(room.match);
    if (launch.events.length) queueEvents(room, launch.events);
    saveRoom(room);
    room.dirty = false;
    tellRoom(room);
    for (const side of ["blue", "red"]) {
      const seat = room.seats[side];
      if (!seat || seat.kind !== "human") continue;
      const peer = sockets.get(seat.username);
      if (!peer) continue;
      const lines = logLines(room.match, side, result.events, room.match.round);
      if (!lines.length) continue;
      if (!room.log) room.log = { blue: [], red: [] };
      if (!Array.isArray(room.log[side])) room.log[side] = [];
      room.log[side].push(...lines);
      peer.send({ op: "log", roomId: room.id, round: room.match.round, lines });
    }
    return { ok: true, peace: peaceOf(room.match), events: result.events };
  }

  // PB-309 (manual p.35 l.1126-1127): "you can actually switch sides during a game. To do this,
  // press Switch Sides. This only works in a solo game or a game against 'no opponent.'"
  //
  // The remake has the solo half of that only, so this does the solo half: the human's seat and the
  // computer's seat trade places, on the room and on the match's own seat table. bot.mjs reads that
  // table every beat (`seatKind`), so the computer plays the side just left without a second mover
  // and the human's orders are authorised on the side they now hold (`seatUsername`). Nothing is
  // moved between the sides: the purses, the pieces and every path in flight belong to the MATCH, so
  // a player who switches takes the other side's purse and units as they stand.
  //
  // What the ORIGINAL did with cash, fog, intel and orders already in flight across a switch is
  // UNVERIFIED. This comment claims only what this build does; the ticket records the measurements.
  function switchSidesOp(username) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    if (isLayoutRoom(room)) return { error: "This is a layout, not a war. Save the setup or leave it." };
    if (room.match.over) return { error: "The war is over. There is no side left to switch." };
    const other = mine === "blue" ? "red" : "blue";
    const theirs = room.seats[other];
    // (b): a two-human war keeps its sides - the manual's own limit ("only ... a solo game"). The
    // refusal is a sentence on the wire, never a silent no-op.
    //
    // PB-312: the manual's second case, a game against "no opponent", switches too. Its partner
    // seat is `none` (nobody holds it), not a bot, and that seat stays empty across the swap: the
    // machine must not inherit a side merely because a player left it.
    const machineSeat = theirs && theirs.kind === "bot";
    const emptySeat = theirs && theirs.kind === "none";
    if (!machineSeat && !emptySeat) {
      return {
        error: "Switch Sides only works in a solo game or against no opponent. In a two-player game each player keeps the side they started with (manual p.35).",
      };
    }
    room.seats[mine] = emptySeat
      ? { username: noOpponentSeatName(), kind: "none" }
      : { username: "Bot", kind: "bot" };
    room.seats[other] = { username, kind: "human" };
    stampSeats(room);
    // A seat's shadow is a picture of the side it held. After the swap both shadows describe the
    // OTHER side's fog, so a delta against them would carry the wrong side's pieces and hide the
    // new side's: drop both, and the next frame is a whole room for each seat.
    forgetSeat(room, "blue");
    forgetSeat(room, "red");
    // A hold belongs to the SEAT, not the side; the human's hold follows them across, and the
    // computer never holds. Without this the human's next "Run the clock" would be refused by a
    // hold the computer had inherited.
    const holds = holdsOf(room);
    const humanHeld = holds[mine] === true;
    holds[mine] = false;
    holds[other] = humanHeld;
    room.note = emptySeat
      ? "You are now the " + other + " side. No opponent plays " + mine + "."
      : "You are now the " + other + " side. The computer plays " + mine + ".";
    saveRoom(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) peer.send({ op: "switched", side: other, left: mine, text: room.note });
    return { ok: true, side: other, left: mine };
  }

  // PB-310 (manual p.35 l.1115-1120): "By pressing Toggle Show-Who, you can switch to 'Show Common'
  // mode, which displays only those enemy units in scanning range - and only those of your units that
  // are in the scanning range of an enemy!"
  //
  // The toggle is VIEW state: it changes what this seat is sent and nothing else. No order, purse,
  // clock or piece moves, and because the map is keyed by room and SIDE, the opponent's frames are
  // built without it. The mode lives on this lobby's map (never on the room), so a reload starts the
  // seat back in Normal - a session view, which is exactly the scope the card asks for.
  function showCommonOp(username) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const side = seatUsername(room, username);
    if (!side) return { error: "You do not hold a seat in this match." };
    if (isLayoutRoom(room)) return { error: "This is a layout, not a war. Save the setup or leave it." };
    if (room.match.over) return { error: "The war is over. There is nothing left to show." };
    const on = !commonFor(room, side);
    setCommon(room, side, on);
    // The drawn set just changed, so the shadow this seat holds describes the other mode: drop it and
    // the next frame (and every frame while the mode is on) is the whole room.
    forgetSeat(room, side);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) peer.send({ op: "show_common", on, text: on
      ? "Show Common: only the units each side can see are drawn."
      : "Show Common off: your own units and the enemy units you can see." });
    return { ok: true, on };
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

  // PB-273: one message, both surfaces. The live half is the message strip at the bottom of each
  // screen; the durable half is one line in each seat's Log, pushed through the same `log` frame the
  // round events use so a reload replays it from the room rather than from the page.
  //
  // Two-human rooms only: the bot has no chat surface (the manual's sentence is about an opponent
  // who replies, p.32), so a bot room refuses here rather than opening a bar nobody answers.
  function chatOp(username, message) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const otherSide = mine === "blue" ? "red" : "blue";
    const other = room.seats[otherSide];
    if (!other || other.kind !== "human") {
      return { error: "Chat is for two-player games: a bot does not answer messages." };
    }
    const text = cleanChat(message.text !== undefined ? message.text : message.message);
    if (!text) return { error: "An empty message is not sent." };
    const entry = {
      side: mine,
      from: nameOf(username),
      round: Number(room.match.round) || 0,
      text,
      html: escapeChat(text),
    };
    const sideWord = mine === "blue" ? "Blue" : "Red";
    const line = { round: entry.round, text: sideWord + " (" + entry.from + "): " + text };
    room.chat = entry;
    if (!room.log) room.log = { blue: [], red: [] };
    for (const side of ["blue", "red"]) {
      const seat = room.seats[side];
      if (!seat || seat.kind !== "human") continue;
      if (!Array.isArray(room.log[side])) room.log[side] = [];
      room.log[side].push(line);
      const peer = sockets.get(seat.username);
      if (!peer) continue;
      peer.send({ op: "chat", roomId: room.id, round: entry.round, chat: entry });
      peer.send({ op: "log", roomId: room.id, round: entry.round, lines: [line] });
    }
    saveRoom(room);
    return { ok: true, chat: entry };
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
    // PB-240(a): the ack carries the moving piece's KIND and DOMAIN, so the page can choose a verb
    // ("to fly" for a satellite, "to walk" for anything on the ground) without keeping its own copy
    // of the satellite kind list. The server already has the piece in hand here.
    const sat = satelliteById(room.match, pieceId);
    const moving = sat || (Array.isArray(room.match.pieces) ? room.match.pieces.find((p) => String(p.id) === String(pieceId)) : null);
    let result;
    try {
      // PB-224: a satellite is a unit with its own destination order (manual p.12). It never touches
      // the ground walker: no terrain, no lanes, no collision.
      result = sat
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
      const reply = { op: "ordered", id: message.id ?? null, piece: pieceId, to, rounds: result.rounds ?? 0,
        kind: moving && moving.kind ? moving.kind : null,
        domain: sat ? "sat" : (moving && moving.domain) || null };
      peer.send(reply);
      rememberReply(username, message.id, reply);
    }
    return { ok: true };
  }

  // PB-245 AC5: a peacetime transfer. The click shape is an order's (piece + destination) and the
  // rule is not: it lands in the same round with no round cost and no readiness cost (manual
  // printed p.31). The server owns both refusals - the war is on, and the ground is neutral or
  // enemy - so every client gets the same answer; move.transferPiece is the only implementation
  // and the page sends no order of its own for it.
  function transferOp(username, message) {
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
    if (!pieceId) return { error: "A transfer needs a piece id." };
    const to = destinationOf(message);
    let result;
    try {
      result = transferPiece(room.match, mine, pieceId, to.x, to.y);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "The transfer was refused." };
    touch(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) {
      const reply = { op: "transferred", id: message.id ?? null, piece: pieceId, to: result.to, rounds: 0 };
      peer.send(reply);
      rememberReply(username, message.id, reply);
    }
    // The moving seat reads its own line. The other seat reads nothing while the peace stands -
    // log.mjs gates the enemy arm on the war being on, which is the AC4 invisibility rule.
    const lines = logLines(room.match, mine, result.events, room.match.round);
    if (lines.length) {
      if (!room.log) room.log = { blue: [], red: [] };
      if (!Array.isArray(room.log[mine])) room.log[mine] = [];
      room.log[mine].push(...lines);
      if (peer) peer.send({ op: "log", roomId: room.id, round: room.match.round, lines });
    }
    return { ok: true, events: result.events || [] };
  }

  // PB-245b (p.31): "A unit can be given a destination to which it will start to move the moment war
  // begins ... select it twice, then select its destination." The page's double-click is what sends
  // this op; the server stores the cell on the piece and nothing is queued. A destination is a
  // peacetime fact, so the war-is-on refusal and the air refusal are the server's sentences.
  function destinationOp(username, message) {
    const room = roomFor(username);
    if (!room || !room.match) return { error: "You are not in a match." };
    const mine = seatUsername(room, username);
    if (!mine) return { error: "You do not hold a seat in this match." };
    const claimed = message.side === undefined || message.side === null ? mine : String(message.side);
    if (claimed !== mine) {
      return { error: "That side is not yours. You hold " + mine + "." };
    }
    const pieceId = String(message.piece ?? message.pieceId ?? "");
    if (!pieceId) return { error: "A destination needs a piece id." };
    const to = destinationOf(message);
    let result;
    try {
      result = setStartingDestination(room.match, mine, pieceId, to.x, to.y);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.error) return { error: (result && result.error) || "That destination was refused." };
    touch(room);
    tellRoom(room);
    const peer = sockets.get(username);
    if (peer) {
      const reply = { op: "destination", id: message.id ?? null, piece: pieceId, to: result.to, rounds: result.rounds ?? 0 };
      peer.send(reply);
      rememberReply(username, message.id, reply);
    }
    const lines = logLines(room.match, mine, result.events, room.match.round);
    if (lines.length) {
      if (!room.log) room.log = { blue: [], red: [] };
      if (!Array.isArray(room.log[mine])) room.log[mine] = [];
      room.log[mine].push(...lines);
      if (peer) peer.send({ op: "log", roomId: room.id, round: room.match.round, lines });
    }
    return { ok: true, events: result.events || [] };
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
    // PB-304 (d): a layout is a pregame setup. The clock never runs in it, so no round - and no
    // income, round or peace tick - can pass while a player is drawing.
    if (isLayoutRoom(room)) {
      return { error: "Layout mode is a pregame setup. The clock does not run and money does not accrue." };
    }
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
      if (!room.match || room.match.over || room.clock !== "running" || isLayoutRoom(room)) continue;
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
      // T-035: the money tick is paced by the room's own beat, so the beat's length is read once.
      const beatMs = Math.max(20, Math.round(speedSeconds(speedOf(room)) * 1000));
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
        const ms = beatMs;
        room.tickedAt = lastAt + Math.floor((stamp - lastAt) / ms) * ms;
      }
      // Bot orders belong to bot seats, never to a room mode. A human room has no bot seat,
      // so neither side is given orders there; a bot seat in any room is still a bot.
      for (const side of ["blue", "red"]) {
        const seat = room.seats[side];
        if (!seat || seat.kind !== "bot") continue;
        if (!room.match.seats) stampSeats(room);
        // PB-200: a cease fire on the table is answered by the bot seat. How the original's AI
        // decided whether to accept is UNVERIFIED (it needs disassembly; the card records this), so
        // the answer is a stated PORT DECISION - bot.mjs's botCeasefireAnswer: it accepts only when
        // it holds fewer cities than the proposer. The answer is queued before tickMatch, so the
        // line lands in this round's log like every other between-rounds fact.
        if (room.match.ceasefire && room.match.ceasefire.status === "pending" && room.match.ceasefire.by !== side) {
          // PB-250: the rule is deterministic, so a game log can say why the bot said yes or no.
          const accept = botCeasefireAnswer(room.match, side);
          const truce = answerCeasefire(room.match, side, accept);
          if (truce && !truce.error) {
            queueEvents(room, truce.events);
            // A human who accepts gets CEASEFIRE_NOTE on the room; the bot's accept is the same
            // state, so it carries the same sentence rather than a second wording of it.
            if (truce.accepted) room.note = CEASEFIRE_NOTE;
            if (!Array.isArray(room.botActions)) room.botActions = [];
            room.botActions.push({ round: Number(room.match.round) + 1, type: "ceasefire", accept });
            if (room.botActions.length > 10) room.botActions = room.botActions.slice(-10);
            console.log(
              `bot ${room.id} r${Number(room.match.round) + 1} cease fire ${accept ? "accepted" : "declined"}` +
              ` (cities ${side} ${citiesHeld(room.match, side)} vs ${room.match.ceasefire.by} ${citiesHeld(room.match, room.match.ceasefire.by)})`
            );
          }
        }
        // PB-245b: a bot seat in the cold war begins hostilities as soon as the mandatory counter
        // allows it (p.31 "after that, either player can start the war"). Without this a 1986/2023
        // bot game would open at peace and never leave it - enemy invisible, oil frozen, no fight -
        // which is a broken game rather than a faithful one. The launch runs here too, so a HUMAN
        // seat's starting destinations fire when the BOT is the one who presses the button.
        //
        // PB-250: the cold war is the only peace a bot breaks. The counter is spent from round 0 in
        // the shipped config (no mandatory length), so a bot that accepted a truce would otherwise
        // re-declare the war in the very next tick and the accept would read as a no-op. A cease
        // fire is a question the bot answered; having said yes, it keeps its word.
        const standing = peaceOf(room.match);
        if (standing && standing.active && standing.coldWar && standing.canResume) {
          const declared = resumeWar(room.match, side, room.match.round);
          if (declared && !declared.error) {
            queueEvents(room, declared.events);
            const launch = launchStartingDestinations(room.match);
            if (launch.events.length) queueEvents(room, launch.events);
            if (!Array.isArray(room.botActions)) room.botActions = [];
            room.botActions.push({ round: Number(room.match.round) + 1, type: "hostilities" });
            if (room.botActions.length > 10) room.botActions = room.botActions.slice(-10);
          }
        }
        let issued = [];
        // T-035 (RE-E4): no round runs in the cold war, so a bot seat issues no orders there either -
        // a queued destination would pile up against a round that never comes. The hostilities
        // declaration just above still runs, because that is how a cold war ends.
        if (!peaceActive(room.match)) {
          try {
            issued = botOrders(room.match, side) || [];
          } catch (err) {
            console.error("bot orders failed:", err && err.message ? err.message : err);
          }
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
      // T-035 (RE-E4 §1-2): THE COLD WAR RUNS NO ROUND. Capture A's round counter stayed 0 for 150 s
      // while cash rose on the money tick, so a peacetime room pays that tick and returns: nothing
      // advances, no fight resolves, no site is taken, no readiness write and no oil charge happens
      // (upkeep and readiness gate on the same flag), and `match.round` stays where it was. A bot seat
      // above may have declared hostilities in this beat; then the peace is already over and the
      // round below runs normally.
      if (peaceActive(room.match)) {
        const seconds = (stamp === null ? Math.round(roomSeconds(room) * 1000) : beatMs) / 1000;
        // Anything queued during this beat (a cease fire the bot just answered, a note a seat
        // wrote) belongs to the beat that carried it: take it off the buffer and hand it to the log
        // here, because no round will run to flush it. The tick's own income rides the same list.
        const queued = Array.isArray(room.match.pendingEvents) ? room.match.pendingEvents.splice(0) : [];
        const beat = queued.concat(peacePay(room.match, seconds));
        if (beat.length) {
          recordFilm(room, beat);
          room.dirty = true;
          tellRoom(room);
          events.push({ roomId: room.id, events: beat });
          deliverSeatLog(room, beat);
        }
        continue;
      }
      const result = tickMatch(room.match);
      room.match = result.match;
      // T-031: the round is recorded from the tick's OWN events, before anything else reads them.
      recordFilm(room, result.events);
      room.dirty = true;
      tellRoom(room);
      if (result.events && result.events.length) events.push({ roomId: room.id, events: result.events });
      deliverSeatLog(room, result.events || []);
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
  const DEDUPE_OPS = new Set(["buy", "order", "mission", "transfer", "destination"]);
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
    if (op === "bot") return startBot(username, message.era, message.side, message.handicap, message.level, message.layout);
    // PB-304: the 1986-only pregame sandbox (manual p.16 l.417, p.37).
    if (op === "layout") return startLayout(username, message.era, message.side);
    if (op === "invite") return invite(username, String(message.user ?? ""), message.era, message.side);
    if (op === "answer") return answer(username, message.id, Boolean(message.accept));
    if (op === "order") return order(username, message);
    // PB-245 AC5: the peacetime transfer is its own op, never an order with a short path.
    if (op === "transfer") return transferOp(username, message);
    // PB-245b: a starting destination is its own op too - it queues nothing.
    if (op === "destination") return destinationOp(username, message);
    if (op === "buy") return buyOp(username, message);
    if (op === "route") return routeFor(username, message);
    if (op === "placement") return placementOp(username, message);
    if (op === "tool") return toolOp(username, message);
    // PB-200: the opponent's answer to a cease fire proposal. `accept:false` (or 0/"false") declines.
    if (op === "ceasefire_answer") return ceasefireAnswerOp(username, message);
    // PB-245: Begin Hostilities/Cease Fire (manual p.32 War Status) - the other way into the state,
    // legal only once the mandatory peace has elapsed.
    if (op === "resume_war") return resumeWarOp(username, message);
    // PB-309 (manual p.35 l.1126-1127): the solo game's Switch Sides.
    if (op === "switch_sides") return switchSidesOp(username);
    // PB-310 (manual p.35 l.1115-1120): the live match's Show Common toggle.
    if (op === "show_common") return showCommonOp(username);
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
    if (op === "chat") return chatOp(username, message);
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

  return { join, handle, presence, tickRooms, beginDrain, flushAll, broadcast, debugRoom, saveSlotOp, listSlotOp, resumeSlotOp, pendingSlotOp, cancelSlotOp, saveLayoutOp, listLayoutOp, forkFilmOp };
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


