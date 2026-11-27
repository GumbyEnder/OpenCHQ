// pb205_save_slots — Save Game slots and Resume Saved War (manual p.16 l.416, p.36-37 l.1142-1150).
//
// What breaks if this is removed:
//   - the slot body is re-serialized instead of packMatch's own output  -> the resumed board drifts
//     from the room store's restart path, and pieces/round/purse stop matching at the byte level;
//   - a second Save onto one name silently replaces the first         -> two wars in one name;
//   - a resumed room comes back RUNNING, or the resume clears a hold    -> PB-134 regresses;
//   - a two-human save is re-seated with a bot, or a third account can resume it;
//   - pruneRooms() takes named slots with the abandoned autosaves.
//
// Measured over the real HTTP/WS surface against the suite's own server, plus one child process for
// the two module-level facts (prune, round-trip) that must not read this suite's module cache:
//   AC1  save writes the round, every piece (path and strength included) and the seat's purse; a
//        duplicate name is a refusal unless the caller asks to overwrite, and the overwrite keeps
//        the slot's id;
//   AC2  unpackMatch(packMatch(match)) is equal on round, pieces[] and sides[].cash; the resumed
//        room is held and the hold it recorded is still standing (the other seat's `run` refused);
//   AC3  a bot slot resumes with a bot on the far side; a two-human slot restores BOTH accounts and
//        a third account is refused; a bot slot gains no second human; and each seat saves its OWN
//        copy under its own name (manual p.36 l.1145) - one seat's save is not the other's to list
//        or to resume;
//   (c)  a two-player war is saved only when BOTH seats have saved the same moment of it: one copy
//        reports the war incomplete, names the missing seat, and cannot be resumed;
//   (d)  a two-player war restarts only when BOTH seats select it (p.37 l.1146-1150): the first
//        selection returns `waiting` and creates no room, the second opens it for both;
//   AC4  pruneRooms(-1) deletes the room row and keeps the named slot;
//   AC5  the stored slot body equals the room store's packed match, field for field.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb205_save_slots";

// Order-independent comparison: a JSON object's key order is not a fact about a save.
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

function eqJson(actual, expected, label, fail) {
  const a = canonical(actual);
  const b = canonical(expected);
  if (a !== b) {
    fail(label + " differs:\n  actual:   " + a.slice(0, 1200) + "\n  expected: " + b.slice(0, 1200));
  }
}

function lastRoom(sock) {
  const frames = sock.box.filter((m) => m && m.op === "room" && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

function displayOf(sock) {
  const welcome = sock.box.find((m) => m && m.op === "welcome");
  return welcome ? String(welcome.username || "") : "";
}

// Send, then wait for a frame that arrived after the send. The box index is read BEFORE the send,
// so a fast answer cannot be missed and an older frame cannot satisfy the wait.
async function sendWait(sock, message, pred, label) {
  const mark = sock.box.length;
  sock.send(message);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    for (const frame of sock.box.slice(mark)) if (pred(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pb205: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(mark).map((m) => (m && m.op === "room"
      ? { op: "room", id: m.room && m.room.id, clock: m.room && m.room.clock, round: m.room && m.room.round }
      : m && m.op)),
  ));
}

async function waitRoom(sock, pred, label, from = 0) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    for (const message of sock.box.slice(from)) {
      if (message && message.op === "room") {
        const value = message.room || null;
        if (pred(value)) return value;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pb205: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(from).map((m) => (m && m.op === "room"
      ? { op: "room", id: m.room && m.room.id, clock: m.room && m.room.clock, round: m.room && m.room.round }
      : m && m.op)),
  ));
}

// A running clock sends DELTAS between full frames (frameFor), so a round wait has to read both.
async function waitRound(sock, minRound, label, from = 0) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    for (const message of sock.box.slice(from)) {
      const round = message && message.op === "room" && message.room
        ? Number(message.room.round)
        : message && message.op === "delta" && message.delta
          ? Number(message.delta.round)
          : null;
      if (round !== null && round >= minRound) return round;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pb205: " + label + " did not reach round " + minRound + "; frames: " + JSON.stringify(
    sock.box.slice(from).map((m) => (m && m.op === "room"
      ? { op: "room", id: m.room && m.room.id, clock: m.room && m.room.clock, round: m.room && m.room.round }
      : m && m.op === "delta"
        ? { op: "delta", round: m.delta && m.delta.round, clock: m.delta && m.delta.clock }
        : m && m.op)),
  ));
}

async function api(base, token, pathName, body) {
  const res = await fetch(base + pathName, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie: "openchq_session=" + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function roomRow(ctx, id) {
  const db = ctx.sqlite();
  try {
    const row = db.prepare("SELECT state FROM rooms WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.state) : null;
  } finally {
    db.close();
  }
}

function slotRow(ctx, id) {
  const db = ctx.sqlite();
  try {
    const row = db.prepare("SELECT * FROM saves WHERE id = ?").get(String(id));
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state) };
  } finally {
    db.close();
  }
}

// The two module-level facts, in a fresh process and a throwaway data directory. The suite's process
// already imported server modules, so its db.mjs is bound to another file; a child is the only way to
// measure pruneRooms() against a store this test owns.
function childFacts(root) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb205-child-"));
  const data = mkdtempSync(path.join(tmpdir(), "openchq-pb205-child-data-"));
  const script = path.join(dir, "facts.mjs");
  const roomsUrl = JSON.stringify(path.join(root, "web/server/rooms.mjs"));
  const slotsUrl = JSON.stringify(path.join(root, "web/server/slots.mjs"));
  const dbUrl = JSON.stringify(path.join(root, "web/server/db.mjs"));
  writeFileSync(script, `
import { db } from ${dbUrl};
import { saveRoom, pruneRooms, packMatch } from ${roomsUrl};
import { saveSlot, listSlots, roomFromSlot, roundTrip } from ${slotsUrl};

const out = {};
const match = {
  era: "1986", mode: "bot", round: 7, clock: "held", moneyUnit: "millions",
  pieces: [
    { id: "blue:tank:2", side: "blue", domain: "land", kind: "tank", x: 3, y: 4,
      path: [{ x: 5, y: 6 }], strength: 88, entrenched: true, pinned: false, shots: 2,
      fighting: "red:infantry:1", facing: "e", inactive: 0 },
    { id: "red:submarine:1", side: "red", domain: "sea", kind: "submarine", x: 9, y: 2,
      path: [], strength: 100, submerged: true, shots: 0 },
  ],
  sides: { blue: { cash: 123456, fuel: null }, red: { cash: 654321, fuel: null } },
  sites: [{ id: "s1", owner: "blue", readyRound: 0 }, { id: "s2", owner: "red" }],
};
const room = {
  id: "pb205-prune-room", mode: "bot", era: "1986", clock: "held", note: "",
  seats: { blue: { username: "pb205_prune", kind: "human" }, red: { username: "Bot", kind: "bot" } },
  holds: { blue: true, red: false }, holdRoom: false, speed: 2, match,
};
saveRoom(room);
const saved = saveSlot({ username: "pb205_prune", name: "Keep Me", room, side: "blue" });
const stored = db.prepare("SELECT state FROM saves WHERE id = ?").get(saved.slot.id);
const body = JSON.parse(stored.state);
out.slotBodyIsPackMatch = JSON.stringify(body.match) === JSON.stringify(packMatch(match));
out.roomBefore = db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n;
out.pruned = pruneRooms(-1);
out.roomAfter = db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n;
out.slotsAfter = listSlots("pb205_prune").length;

const back = roundTrip(match);
out.roundTrip = {
  round: back.round === 7,
  pieces: JSON.stringify(back.pieces) === JSON.stringify(match.pieces),
  blueCash: back.sides && back.sides.blue && back.sides.blue.cash === 123456,
  redCash: back.sides && back.sides.red && back.sides.red.cash === 654321,
};
const resumed = roomFromSlot({ id: saved.slot.id, name: "Keep Me", era: "1986", mode: "bot" }, body);
out.resumeHeld = resumed.clock === "held" && resumed.match.clock === "held";
out.resumeHolds = resumed.holds.blue === true && resumed.holds.red === false;
out.resumeSeats = resumed.seats.blue.kind === "human" && resumed.seats.red.kind === "bot";
out.resumePieces = JSON.stringify(resumed.match.pieces) === JSON.stringify(match.pieces);
console.log(JSON.stringify(out));
`);
  const run = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, OPENCHQ_WEB_DATA: data },
    encoding: "utf8",
  });
  const stdout = String(run.stdout || "");
  if (run.status !== 0) {
    throw new Error("pb205 child facts failed: " + (run.stderr || stdout || "exit " + run.status));
  }
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

// One legal one-cell order on a held clock, so the saved match carries a real path. Neighbours are
// tried because a destination can be water, a friendly piece or off the walker's terrain.
async function plantOrder(sock, room, fail) {
  const mine = (room.pieces || []).filter((piece) => piece.side === room.you && piece.domain !== "sat");
  let serial = 0;
  for (const piece of mine) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const id = "pb205-order-" + (++serial);
      const answer = await sendWait(
        sock,
        { op: "order", id, piece: piece.id, to: { x: piece.x + dx, y: piece.y + dy } },
        (frame) => (frame && frame.id === id && (frame.op === "ordered" || frame.op === "error")),
        "the order answer for " + piece.id,
      );
      if (answer.op === "ordered") return piece.id;
    }
    if (serial > 16) break;
  }
  fail("pb205 AC1: no one-cell order could be planted, so no saved piece carries a path");
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

  const alice = await ctx.register("pb205_alice");
  const bob = await ctx.register("pb205_bob");
  const charlie = await ctx.register("pb205_charlie");
  const a = ctx.socket(alice.token);
  const b = ctx.socket(bob.token);
  const c = ctx.socket(charlie.token);
  try {
    await a.wait((m) => m.op === "welcome", "alice's welcome");
    await b.wait((m) => m.op === "welcome", "bob's welcome");
    await c.wait((m) => m.op === "welcome", "charlie's welcome");
    // --- AC1: a bot war, one round played and one order queued, saved under a name ----------
    a.send({ op: "bot", era: "1986", side: "blue" });
    let room = await waitRoom(a, (r) => Boolean(r), "the bot room opened");
    a.send({ op: "speed", speed: 6 });
    a.send({ op: "run" });
    await waitRound(a, 1, "one round played");
    // `await sendWait(...).room` would await a PROPERTY of the promise (member access binds first),
    // hand back undefined, and leave the sendWait rejected as an unhandled rejection that kills the
    // suite 15 s later — so the frame is read inside the await.
    const heldFrame = await sendWait(a, { op: "hold" }, (m) => m.op === "room" && m.room && m.room.clock !== "running",
      "the clock is held again");
    room = heldFrame.room;
    if (!room || !room.id) throw new Error("pb205: the held frame carried no room: " + JSON.stringify(heldFrame).slice(0, 400));
    const roomId = room.id;
    const orderedPiece = await plantOrder(a, room, fail);
    room = lastRoom(a);
    const savedRound = Number(room.round);
    const savedCash = Number(room.seat && room.seat.cash);
    const before = roomRow(ctx, roomId);
    if (!before) fail("pb205: the live room has no store row");
    if (!(before.match.pieces || []).some((p) => p.id === orderedPiece && Array.isArray(p.path) && p.path.length)) {
      fail("pb205 AC1: the planted order did not reach the stored room");
    }
    if (!(before.match.pieces || []).some((p) => p.strength !== undefined && p.strength !== null)) {
      fail("pb205 AC1: no stored piece carries a strength");
    }

    const first = await api(ctx.base, alice.token, "/api/slots", { name: "  Front   Line " });
    if (first.status !== 200 || !first.data.ok) fail("pb205 AC1: save refused: " + JSON.stringify(first.data));
    if (first.data.slot.name !== "Front Line") fail("pb205 AC1: the name was not cleaned: " + JSON.stringify(first.data.slot.name));
    const slotId = first.data.slot.id;
    const stored = slotRow(ctx, slotId);
    if (!stored) fail("pb205 AC1: the slot row is missing");
    // AC5: the body IS the room store's packed match, plus the seat/hold/speed fields saveRoom keeps.
    eqJson(stored.state.match, before.match, "pb205 AC5: the slot body is not the room store's packed match", fail);
    eqJson(stored.state.seats, before.seats, "pb205 AC5: the slot does not carry the room's seat table", fail);
    if (stored.state.holds.blue !== Boolean(before.holds && before.holds.blue)) {
      fail("pb205 AC5: the slot does not carry the room's hold table");
    }
    if (stored.state.match.siteOwners === undefined) fail("pb205 AC5: the slot body is not packMatch's (no siteOwners)");
    // AC1: the round, every piece and the purse are in the body.
    if (Number(stored.state.match.round) !== savedRound) {
      fail("pb205 AC1: slot round " + stored.state.match.round + " is not the live round " + savedRound);
    }
    eqJson(stored.state.match.pieces, before.match.pieces, "pb205 AC1: a piece field did not survive the save", fail);
    if (!(stored.state.match.pieces || []).some((p) => p.id === orderedPiece && p.path.length)) {
      fail("pb205 AC1: the saved order's path is not in the slot");
    }
    if (Number(stored.state.match.sides.blue.cash) !== savedCash) {
      fail("pb205 AC1: slot purse " + stored.state.match.sides.blue.cash + " is not the seat's " + savedCash);
    }

    // A duplicate name is a refusal, not a second slot.
    const dup = await api(ctx.base, alice.token, "/api/slots", { name: "front line" });
    if (dup.status !== 400 || !dup.data.exists) fail("pb205 AC1: a duplicate name was accepted: " + JSON.stringify(dup.data));
    if (dup.data.id !== slotId) fail("pb205 AC1: the refusal did not name the existing slot");
    // The explicit overwrite replaces the same row and keeps its id.
    const over = await api(ctx.base, alice.token, "/api/slots", { name: "front line", overwrite: true });
    if (over.status !== 200 || !over.data.ok || over.data.slot.id !== slotId) {
      fail("pb205 AC1: the overwrite did not replace the same slot: " + JSON.stringify(over.data));
    }
    if (!over.data.overwritten) fail("pb205 AC1: the overwrite was not reported as one");
    const list = await api(ctx.base, alice.token, "/api/slots");
    if (list.status !== 200 || list.data.slots.length !== 1) {
      fail("pb205 AC1: the account lists " + (list.data.slots || []).length + " slots after one save");
    }
    if (list.data.slots[0].cash !== savedCash) fail("pb205 AC1: the list purse is not the seat's");
    if (list.data.slots[0].round !== savedRound) fail("pb205 AC1: the list round is not the saved round");

    // --- AC2/AC3: the bot slot belongs to one account and restores as a bot room ------------
    const foreign = await api(ctx.base, bob.token, "/api/slots/resume", { id: slotId });
    if (foreign.status !== 400) fail("pb205 AC3: another account resumed a bot slot: " + JSON.stringify(foreign.data));
    if (!/another player/.test(String(foreign.data.error || ""))) {
      fail("pb205 AC3: the refusal does not say the slot is not theirs: " + JSON.stringify(foreign.data.error));
    }
    const inMatch = await api(ctx.base, alice.token, "/api/slots/resume", { id: slotId });
    if (inMatch.status !== 400) fail("pb205: resuming over a live match was allowed");
    // Every wait below is read from the socket's tip at send time: a scan from index 0 would match
    // the previous match's frames (round 0, or a `null` room from an earlier leave) and pass on
    // evidence that predates the call it is meant to prove.
    let mark = a.box.length;
    a.send({ op: "leave" });
    await waitRoom(a, (r) => r === null, "the live match was left", mark);
    mark = a.box.length;
    const resumed = await api(ctx.base, alice.token, "/api/slots/resume", { id: slotId });
    if (resumed.status !== 200 || !resumed.data.ok) fail("pb205 AC2: the resume was refused: " + JSON.stringify(resumed.data));
    const resumedRoom = await waitRoom(a, (r) => Boolean(r) && r.id === resumed.data.id, "the resumed room frame", mark);
    if (Number(resumedRoom.round) !== savedRound) {
      fail("pb205 AC2: resumed round " + resumedRoom.round + " is not the saved round " + savedRound);
    }
    if (resumedRoom.clock === "running") fail("pb205 AC2: the resumed room came back running");
    if (Number(resumedRoom.seat.cash) !== savedCash) {
      fail("pb205 AC2: resumed purse " + resumedRoom.seat.cash + " is not the saved " + savedCash);
    }
    if (!(resumedRoom.red && resumedRoom.red.kind === "bot")) {
      fail("pb205 AC3: a bot slot came back without a bot on the far side: " + JSON.stringify(resumedRoom.red));
    }
    if (!(resumedRoom.blue && resumedRoom.blue.kind === "human")) {
      fail("pb205 AC3: the seat that saved is not the seat that resumed");
    }
    const resumedRow = roomRow(ctx, resumed.data.id);
    if (!resumedRow) fail("pb205 AC2: the resumed room was not written to the store");
    eqJson(resumedRow.match.pieces, stored.state.match.pieces, "pb205 AC2: the resumed piece set is not the saved one", fail);
    if (Number(resumedRow.match.round) !== savedRound) fail("pb205 AC2: the resumed store row has a different round");
    if (Number(resumedRow.match.sides.blue.cash) !== savedCash) fail("pb205 AC2: the resumed store row has a different purse");

    // --- AC3 + PB-134: a two-human save, both seats restored, a hold survives ---------------
    mark = a.box.length;
    a.send({ op: "leave" });
    await waitRoom(a, (r) => r === null, "the resumed match was left", mark);
    const inviteMark = b.box.length;
    mark = a.box.length;
    a.send({ op: "invite", user: displayOf(b), era: "1986", side: "blue" });
    const inviteFrame = await b.wait((m) => m.op === "invite", "bob was invited", inviteMark);
    b.send({ op: "answer", id: inviteFrame.invite.id, accept: true });
    const twoRoom = await waitRoom(a, (r) => Boolean(r) && r.blue && r.blue.kind === "human" && r.red && r.red.kind === "human",
      "the two-human room opened", mark);
    const twoRoomId = twoRoom.id;
    await waitRoom(b, (r) => Boolean(r), "bob's two-human frame", inviteMark);
    // A 1986 room opens in the COLD WAR and no round runs while it is standing (T-035): the bot
    // seat declares hostilities for itself, but a two-human room has nobody to do it, so a seat
    // must. Begin the war, then run the clock.
    const warMark = a.box.length;
    await sendWait(a, { op: "resume_war" }, (m) => m.op === "room" || m.op === "error", "hostilities began");
    await waitRoom(a, (r) => Boolean(r) && r.id === twoRoomId, "the two-human room after hostilities", warMark);
    a.send({ op: "speed", speed: 6 });
    const roundMark = a.box.length;
    a.send({ op: "run" });
    await waitRound(a, 1, "the two-human round ran", roundMark);
    await sendWait(a, { op: "hold" }, (m) => m.op === "room" && m.room && m.room.clock !== "running",
      "the two-human clock held");
    const twoSaved = await api(ctx.base, alice.token, "/api/slots", { name: "Two Fronts" });
    if (twoSaved.status !== 200) fail("pb205 AC3: the two-human save was refused: " + JSON.stringify(twoSaved.data));
    const twoId = twoSaved.data.slot.id;
    // (c) One seat's copy is not the war: the summary says so and names the seat not yet saved.
    if (!twoSaved.data.slot.war || twoSaved.data.slot.war.complete !== false) {
      fail("pb205 (c): one seat's save was reported as a complete two-player war: " + JSON.stringify(twoSaved.data.slot.war));
    }
    if (!(twoSaved.data.slot.war.waitingOn || []).includes(displayOf(b))) {
      fail("pb205 (c): the incomplete war does not name the second seat: " + JSON.stringify(twoSaved.data.slot.war));
    }
    // Manual p.36 l.1145: "both players must save the game, but they don't have to save the game
    // under the same name." So each seat saves its own copy. Bob held a seat and did NOT save, so
    // alice's copy is not in his list and is not his to resume - the slot is one account's drawer,
    // not a shared handle on the war (a shared slot would be a deviation, and the PM's to rule).
    const bobList = await api(ctx.base, bob.token, "/api/slots");
    if ((bobList.data.slots || []).some((s) => s.id === twoId)) {
      fail("pb205 AC3: the second seat saw a slot only the first seat saved");
    }
    // Bob saves his own copy, under his own name. Same war, its own row and its own name.
    const bobSaved = await api(ctx.base, bob.token, "/api/slots", { name: "Bob's Front" });
    if (bobSaved.status !== 200 || !bobSaved.data.ok) {
      fail("pb205 AC3: the second seat could not save its own copy: " + JSON.stringify(bobSaved.data));
    }
    const bobId = bobSaved.data.slot.id;
    if (bobId === twoId) fail("pb205 AC3: the second seat's save replaced the first seat's row");
    if (!bobSaved.data.slot.war || bobSaved.data.slot.war.complete !== true) {
      fail("pb205 (c): the war is still incomplete after both seats saved: " + JSON.stringify(bobSaved.data.slot.war));
    }
    const bobList2 = await api(ctx.base, bob.token, "/api/slots");
    if (!(bobList2.data.slots || []).some((s) => s.id === bobId)) {
      fail("pb205 AC3: the second seat's own save is not in its list");
    }
    if ((bobList2.data.slots || []).some((s) => s.id === twoId)) fail("pb205 AC3: the first seat's save appeared in the second seat's list");
    const aliceList2 = await api(ctx.base, alice.token, "/api/slots");
    if ((aliceList2.data.slots || []).some((s) => s.id === bobId)) fail("pb205 AC3: the second seat's save appeared in the first seat's list");
    // Bob leaves (that ends the room, and endRoom clears both seats). Both accounts are now out of a
    // match, so nothing below is answered by the "leave your match" guard.
    const endMark = a.box.length;
    b.send({ op: "leave" });
    await waitRoom(a, (r) => r === null, "the two-human room ended", endMark);
    // A third account can resume neither copy.
    const third = await api(ctx.base, charlie.token, "/api/slots/resume", { id: bobId });
    if (third.status !== 400 || !/another player/.test(String(third.data.error || ""))) {
      fail("pb205 AC3: a third account resumed a two-human slot: " + JSON.stringify(third.data));
    }
    // (d) The first selection WAITS: no room is created and no id is handed out.
    const bobResume = await api(ctx.base, bob.token, "/api/slots/resume", { id: bobId });
    if (bobResume.status !== 200 || bobResume.data.ok !== true || bobResume.data.waiting !== true || bobResume.data.id) {
      fail("pb205 (d): the first seat's selection did not wait, or opened a room: " + JSON.stringify(bobResume.data));
    }
    if (!(bobResume.data.waitingOn || []).includes(displayOf(a))) {
      fail("pb205 (d): the waiting claim does not name the other seat: " + JSON.stringify(bobResume.data));
    }
    const bobPending = await api(ctx.base, bob.token, "/api/slots/pending");
    if (bobPending.status !== 200 || bobPending.data.waiting !== true) {
      fail("pb205 (d): the waiting claim is not readable: " + JSON.stringify(bobPending.data));
    }
    // (d) The second seat selects its OWN copy of the same war: now the room opens, for both.
    const bobMark = b.box.length;
    const aMark = a.box.length;
    const aliceResume = await api(ctx.base, alice.token, "/api/slots/resume", { id: twoId });
    if (aliceResume.status !== 200 || aliceResume.data.ok !== true || !aliceResume.data.id) {
      fail("pb205 (d): the second selection did not open the room: " + JSON.stringify(aliceResume.data));
    }
    const bRoom = await waitRoom(b, (r) => Boolean(r) && r.id === aliceResume.data.id, "bob's resumed two-human frame", bobMark);
    const aRoom = await waitRoom(a, (r) => Boolean(r) && r.id === bRoom.id, "the first selector's room frame", aMark);
    if (!(bRoom.blue && bRoom.blue.kind === "human" && bRoom.red && bRoom.red.kind === "human")) {
      fail("pb205 AC3: the two-human slot did not come back two-human: " + JSON.stringify([bRoom.blue, bRoom.red]));
    }
    if (Number(aRoom.round) !== savedRound) {
      fail("pb205 (d): the resumed round " + aRoom.round + " is not the saved " + savedRound);
    }
    if (aRoom.clock === "running") fail("pb205 AC2: the resumed room came back running");
    const bobAfter = await api(ctx.base, bob.token, "/api/slots/pending");
    if (bobAfter.data.waiting !== false) fail("pb205 (d): the claim survived the room it opened");
    // PB-134: Alice held the clock when the war was saved. Bob's `run` must be REFUSED naming her,
    // and the clock must still be held - a resume that lifted the hold would start a war nobody ran.
    const refusal = await sendWait(b, { op: "run" },
      (m) => m.op === "error" || (m.op === "room" && m.room && m.room.clock === "running"),
      "bob's run over alice's hold");
    if (refusal.op !== "error" || !/held by/.test(String(refusal.error || ""))) {
      fail("pb205 AC2: the run was not refused by the saved seat hold: " + JSON.stringify(refusal));
    }
    const afterRefusal = roomRow(ctx, bRoom.id);
    if (!afterRefusal || afterRefusal.clock === "running") fail("pb205 AC2: the resume lifted the saved seat hold");
    const leftMark = a.box.length;
    b.send({ op: "leave" });
    await waitRoom(a, (r) => r === null, "the two-human resumed match was left", leftMark);

    // (c) With only one copy left, the war is incomplete again and must not start.
    const dropDb = ctx.sqlite();
    try { dropDb.prepare("DELETE FROM saves WHERE id = ?").run(bobId); } finally { dropDb.close(); }
    const incomplete = await api(ctx.base, alice.token, "/api/slots/resume", { id: twoId });
    if (incomplete.status !== 400 || !/Both players must save/.test(String(incomplete.data.error || ""))) {
      fail("pb205 (c): a one-copy two-player war was resumed: " + JSON.stringify(incomplete.data));
    }
    const aliceList3 = await api(ctx.base, alice.token, "/api/slots");
    const twoRow = (aliceList3.data.slots || []).find((s) => s.id === twoId);
    if (!twoRow || !twoRow.war || twoRow.war.complete !== false) {
      fail("pb205 (c): the list still reports the war complete with one copy: " + JSON.stringify(twoRow && twoRow.war));
    }

    // --- AC4 + AC2 round-trip, in a child process on its own store --------------------------
    const facts = childFacts(root);
    if (!facts.slotBodyIsPackMatch) fail("pb205 AC5: the child measured a slot body that is not packMatch's output");
    if (facts.roomBefore !== 1 || facts.roomAfter !== 0) {
      fail("pb205 AC4: pruneRooms(-1) removed " + facts.roomBefore + "->" + facts.roomAfter + " room rows (expected 1->0)");
    }
    if (facts.slotsAfter !== 1) fail("pb205 AC4: pruneRooms took the named slot (slots after prune " + facts.slotsAfter + ")");
    for (const key of ["round", "pieces", "blueCash", "redCash"]) {
      if (!facts.roundTrip[key]) fail("pb205 AC2: unpackMatch(packMatch(match)) changed " + key);
    }
    if (!facts.resumeHeld) fail("pb205 AC2: roomFromSlot did not come back held");
    if (!facts.resumeHolds) fail("pb205 AC2: roomFromSlot did not keep the recorded holds");
    if (!facts.resumeSeats) fail("pb205 AC3: roomFromSlot changed a bot seat into a human one");
    if (!facts.resumePieces) fail("pb205 AC2: roomFromSlot changed the piece set");
  } finally {
    a.close();
    b.close();
    c.close();
  }
}
