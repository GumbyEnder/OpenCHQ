// PB-305: Film to Game (manual p.38 l.1170) — the cutover, measured over the real HTTP/WS surface.
//
// During a War Film the player presses Film to Game and the film becomes a SOLO game from the setup
// on screen. What this node pins:
//   (a) the cutover is offered for a finished film and starts a game at ANY frame of the replay
//       (round 0 included), while the closing frame - the film's end screen - is refused with a
//       sentence instead of forking a war that is already decided;
//   (b) the forked state is what the replay was PAINTING: the recorded units on their recorded
//       cells, the frame's strengths, the frame's ownership and its round. A film stores no
//       per-round positions (history.mjs says why), so the fork is that state and not a
//       re-simulation - the leg reads the room store, not the page's filtered view;
//   (c) the human takes the side they held at that machine (both directions: a blue film and a red
//       film), and the other side is the computer;
//   (d) after the cutover it is a real game: an order lands, the clock advances, and the round moves
//       - which also proves round 0's cold-war flag did not travel into a mid-war cutover and freeze
//       it (T-035);
//   (e) no refusal string names a raw piece id;
//   plus the account rules: someone else's film is not found, and a seated account must leave first.

export const name = "pb305_film_to_game";

// The store keeps a room as packMatch's ownership lists, so the leg rebuilds the same full match the
// server loads on a restart - comparing `sites` straight off the row would compare nothing.
import { canonicalJson } from "../../server/history.mjs";
import { gzipSync } from "node:zlib";
import { unpackMatch } from "../../server/rooms.mjs";

// A film with a KNOWN frame. A real early-war frame usually looks exactly like round 0 (no combat
// yet), so an assertion against it cannot tell "strengths were applied" from "start was copied" -
// the PB-304 M4 lesson. This fixture writes a film whose frame 5 differs from its start in strength,
// ownership and one destroyed unit, so every half of the fork has something to fail on.
function plantFilm(ctx, start, { id, user, frame }) {
  const db = ctx.sqlite();
  try {
    db.prepare(
      `INSERT INTO matches (id, era, mode, blue_user, red_user, started_at, ended_at, winner, rounds,
        schema, start_state, final_state, final_digest, stored_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, 0)`,
    ).run(id, String(start.era || "1986"), "bot", user, "Bot",
      "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", "blue", Number(frame.round) || 0,
      gzipSync(Buffer.from(canonicalJson(start), "utf8")));
    const blob = gzipSync(Buffer.from(canonicalJson(frame), "utf8"));
    db.prepare("INSERT OR REPLACE INTO match_rounds (match_id, round, payload) VALUES (?, ?, ?)")
      .run(id, Number(frame.round) || 0, blob);
  } finally {
    db.close();
  }
}


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

function lastRoom(sock) {
  const frames = sock.box.filter((m) => m && m.op === "room" && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

async function waitRoom(sock, pred, label, from = 0) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    for (const message of sock.box.slice(from)) {
      if (message && message.op === "room") {
        const value = message.room || null;
        if (pred(value)) return value;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pb305: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(from).map((m) => (m && m.op === "room"
      ? { op: "room", id: m.room && m.room.id, round: m.room && m.room.round }
      : m && m.op)),
  ));
}

async function waitRound(sock, minRound, label, from = 0) {
  const start = Date.now();
  while (Date.now() - start < 25000) {
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
  throw new Error("pb305: " + label + " did not reach round " + minRound);
}

async function sendWait(sock, message, pred, label) {
  const mark = sock.box.length;
  sock.send(message);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    for (const frame of sock.box.slice(mark)) if (pred(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pb305: " + label + " missing");
}

// One legal one-cell order on a piece this seat holds, so (d) is a real order and not a hand-wave.
async function plantOrder(sock, room, fail) {
  const mine = (room.pieces || []).filter((piece) => piece.side === room.you && piece.domain !== "sat");
  let serial = 0;
  for (const piece of mine) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const id = "pb305-order-" + (++serial);
      const answer = await sendWait(
        sock,
        { op: "order", id, piece: piece.id, to: { x: piece.x + dx, y: piece.y + dy } },
        (frame) => frame && frame.id === id && (frame.op === "ordered" || frame.op === "error"),
        "the order answer for a piece",
      );
      if (answer.op === "ordered") return piece.id;
    }
    if (serial > 24) break;
  }
  fail("pb305 (d): no one-cell order could be planted after the cutover");
  return null;
}

// One finished bot war, ended by Resign (the shortest honest close), then left so the lobby is free.
// Every wait is scoped to a mark taken at the send: the socket's box still holds the PREVIOUS war's
// frames, and a scan from 0 would satisfy "a room opened" with the room that just closed.
async function finishWar(sock, side, era, fail) {
  const mark = sock.box.length;
  sock.send({ op: "bot", era, side });
  const room = await waitRoom(sock, (value) => Boolean(value), "the bot room opened", mark);
  sock.send({ op: "speed", speed: 6 });
  const runFrom = sock.box.length;
  sock.send({ op: "run" });
  await waitRound(sock, 3, "the war ran three rounds", runFrom);
  await sendWait(sock, { op: "hold" }, (m) => m.op === "room" && m.room && m.room.clock !== "running", "the clock held");
  await sendWait(sock, { op: "resign" }, (m) => m.op === "room" && m.room && m.room.over === true, "the resignation landed");
  const id = (lastRoom(sock) || {}).id;
  if (!id || id !== room.id) fail("pb305: the finished war's room id changed under the leg");
  await new Promise((resolve) => setTimeout(resolve, 250));
  return id;
}

async function leaveWar(sock) {
  const mark = sock.box.length;
  sock.send({ op: "leave" });
  await waitRoom(sock, (value) => value === null, "the seat was released", mark);
}

// The frame the page would be showing: the one at `round`, exactly. The page sends `frame.round`
// (not the array index), so that is what the leg sends.
function frameAt(frames, round) {
  return (frames || []).find((row) => Number(row.round) === Number(round)) || null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const alice = await ctx.register("pb305_alice");
  const bob = await ctx.register("pb305_bob");
  const a = ctx.socket(alice.token);
  const b = ctx.socket(bob.token);
  try {
    await a.wait((m) => m.op === "welcome", "alice's welcome");
    await b.wait((m) => m.op === "welcome", "bob's welcome");

    // ---- a real 1986 war, blue seat, ended by Resign ------------------------------------
    const warId = await finishWar(a, "blue", "1986", fail);
    const listed = await api(ctx.base, alice.token, "/api/matches?limit=10");
    const filmRow = (listed.data.matches || []).find((row) => row.id === warId) || null;
    if (!filmRow) fail("pb305 (a): the finished war is not listed as a film");
    const meta = await api(ctx.base, alice.token, "/api/matches/" + warId);
    const film = meta.data.film || {};
    const start = film.start || {};
    const page = await api(ctx.base, alice.token, "/api/matches/" + warId + "/rounds?from=0");
    const frames = Array.isArray(page.data.frames) ? page.data.frames : [];
    if (frames.length < 3) fail("pb305 (a): the film carries " + frames.length + " frames, not a replay");

    // ---- account rules + the closing frame ----------------------------------------------
    // A seated account cannot fork: the room it is in would be orphaned.
    const seated = await api(ctx.base, alice.token, "/api/matches/" + warId + "/to-game", { round: 1 });
    if (seated.status !== 400 || !/Leave the current match first/.test(String(seated.data.error))) {
      fail("pb305: a seated account forked a film: " + JSON.stringify(seated.data));
    }
    // Someone else's film is the same answer as a missing one.
    const foreign = await api(ctx.base, bob.token, "/api/matches/" + warId + "/to-game", { round: 1 });
    if (foreign.status !== 404) fail("pb305: another account forked the film: " + JSON.stringify(foreign.data));

    await leaveWar(a);
    const missing = await api(ctx.base, alice.token, "/api/matches/does-not-exist/to-game", { round: 1 });
    if (missing.status !== 404) fail("pb305: a missing film forked: " + JSON.stringify(missing.data));

    const mid = frameAt(frames, Math.min(2, frames.length - 2)) || frames[Math.min(1, frames.length - 1)];
    const last = frames[frames.length - 1];
    const closing = await api(ctx.base, alice.token, "/api/matches/" + warId + "/to-game", { round: last.round });
    if (closing.status !== 400 || !/last round/.test(String(closing.data.error))) {
      fail("pb305 (a): the closing frame was forked: " + JSON.stringify(closing.data));
    }
    for (const text of [seated.data.error, foreign.data.error, missing.data.error, closing.data.error]) {
      if (/\b(blue|red):[A-Za-z]+:\d+\b/.test(String(text || ""))) {
        fail("pb305 (e): a refusal names a raw piece id: " + text);
      }
    }

    // ---- (a)(b)(c)(d): the cutover at a mid-war frame ------------------------------------
    const markA = a.box.length;
    const forked = await api(ctx.base, alice.token, "/api/matches/" + warId + "/to-game", { round: mid.round });
    if (forked.status !== 200 || !forked.data.ok) fail("pb305 (a): the mid-frame fork was refused: " + JSON.stringify(forked.data));
    if (Number(forked.data.round) !== Number(mid.round)) {
      fail("pb305 (b): the fork starts at round " + forked.data.round + ", the film showed " + mid.round);
    }
    if (forked.data.side !== "blue") fail("pb305 (c): the blue film seated the human on " + forked.data.side);
    const room = await waitRoom(a, (value) => Boolean(value) && value.id === forked.data.id, "the forked room", markA);
    if (room.you !== "blue") fail("pb305 (c): the room says the human is " + room.you);
    if (!room.blue || room.blue.kind !== "human") fail("pb305 (c): the blue seat is not the human");
    if (!room.red || room.red.kind !== "bot") fail("pb305 (c): the far side is not the computer");
    if (room.clock !== "held") fail("pb305 (b): the cutover is not held (clock " + room.clock + ")");
    if (room.over) fail("pb305 (d): the cutover is already over");

    // (b) the state on the board is what the film was painting, read from the store (the page's
    // view is fogged; the store is the fork the server made).
    const stored = roomRow(ctx, forked.data.id);
    if (!stored || !stored.match) fail("pb305 (b): the forked room has no stored match");
    const match = unpackMatch(stored.match);
    if (Number(match.round) !== Number(mid.round)) fail("pb305 (b): the stored round is " + match.round);
    if (match.over === true) fail("pb305 (d): the stored match is over");
    if (String(stored.match.era) !== "1986") fail("pb305 (b): the era changed to " + stored.match.era);
    if (stored.seats.blue.kind !== "human" || stored.seats.red.kind !== "bot") {
      fail("pb305 (c): the stored seats are not human vs bot: " + JSON.stringify(stored.seats));
    }
    const frame = mid.frame || {};
    const strengths = frame.strengths || {};
    const owners = new Map((frame.owners || []).map((row) => [String(row[0]), row[1] ?? null]));
    const startByPiece = new Map((start.pieces || []).map((piece) => [String(piece.id), piece]));
    let strengthChecks = 0;
    for (const piece of match.pieces || []) {
      const key = String(piece.id);
      if (strengths[key] !== undefined) {
        if (Number(piece.strength) !== Number(strengths[key])) {
          fail("pb305 (b): piece " + key + " forked at " + piece.strength + ", the film says " + strengths[key]);
        }
        strengthChecks += 1;
      }
      const from = startByPiece.get(key);
      if (from && (Number(from.x) !== Number(piece.x) || Number(from.y) !== Number(piece.y))) {
        fail("pb305 (b): piece " + key + " forked at " + piece.x + "," + piece.y +
          " but the film recorded " + from.x + "," + from.y + " (a film has no per-round positions)");
      }
    }
    if (!strengthChecks) fail("pb305 (b): no forked piece carried a recorded strength");
    // A unit the frame records at 0 was destroyed; it must not come back as a ghost.
    for (const piece of match.pieces || []) {
      const raw = strengths[String(piece.id)];
      if (raw !== undefined && Number(raw) <= 0) fail("pb305 (b): a destroyed unit forked at strength " + raw);
    }
    let ownerChecks = 0;
    for (const site of match.sites || []) {
      const key = String(site.id);
      if (!owners.has(key)) continue;
      if ((site.owner ?? null) !== owners.get(key)) {
        fail("pb305 (b): site " + key + " forked as " + site.owner + ", the film says " + owners.get(key));
      }
      ownerChecks += 1;
    }
    if (!ownerChecks) fail("pb305 (b): no forked site carried a recorded owner");
    if (match.peace && match.peace.active === true) {
      fail("pb305 (d): a mid-war cutover kept the round-0 cold-war flag; no round could ever run");
    }

    // (d) a real game: an order lands, and the clock advances with a bot on the far side.
    await plantOrder(a, room, fail);
    const beforeRound = Number(room.round);
    a.send({ op: "speed", speed: 6 });
    const runFrom = a.box.length;
    a.send({ op: "run" });
    await waitRound(a, beforeRound + 2, "the forked game ran two rounds", runFrom);
    await sendWait(a, { op: "hold" }, (m) => m.op === "room" && m.room && m.room.clock !== "running", "the forked clock held");
    const after = roomRow(ctx, forked.data.id);
    if (!after || Number(after.match.round) < beforeRound + 2) {
      fail("pb305 (d): the forked game did not advance past round " + beforeRound);
    }
    if (!after.seats || after.seats.red.kind !== "bot") fail("pb305 (d): the far side stopped being a bot");
    const redBefore = new Map((match.pieces || []).filter((p) => p.side === "red").map((p) => [String(p.id), p]));
    const moved = (after.match.pieces || []).some((p) => {
      const was = redBefore.get(String(p.id));
      return p.side === "red" && (!was || Number(was.x) !== Number(p.x) || Number(was.y) !== Number(p.y));
    });
    // Recorded, not asserted: a level-1 bot may spend a round buying instead of marching, and the
    // seat table plus the advancing round is what proves the computer is playing this side.
    console.log("pb305 (d) detail: red pieces moved after the cutover: " + moved);

    await leaveWar(a);

    // ---- (b), exact: a film whose frame differs from its own start ------------------------
    // The real war's early frame can equal round 0 (no combat yet); a leg that forked it could not
    // tell "the frame's strengths were applied" from "the start was copied". This fixture's frame 5
    // changes one strength, destroys one unit and flips one site, so each half has a red to give.
    const synthStart = JSON.parse(JSON.stringify(start));
    const pieces0 = (synthStart.pieces || []).filter((piece) => piece && piece.id !== undefined);
    const blues = pieces0.filter((piece) => piece.side === "blue");
    const change = (blues.length ? blues : pieces0)[0];
    const dead = pieces0.find((piece) => piece !== change) || null;
    const flip = (synthStart.sites || []).find((site) => site && site.owner === "blue")
      || (synthStart.sites || []).find((site) => site && site.owner);
    if (!change || !flip) fail("pb305 (b): the film start carries no piece or site to fork from");
    const frameStrengths = {};
    for (const piece of pieces0) frameStrengths[String(piece.id)] = Number(piece.strength) || 100;
    const changedStrength = Math.max(1, (Number(change.strength) || 100) - 11);
    frameStrengths[String(change.id)] = changedStrength;
    if (dead) frameStrengths[String(dead.id)] = 0;
    const frameOwners = (synthStart.sites || []).map((site) => [
      site.id,
      site && site.id === flip.id ? "red" : (site ? site.owner ?? null : null),
    ]);
    const synthId = "pb305-synth-" + Date.now().toString(36);
    plantFilm(ctx, synthStart, {
      id: synthId,
      user: String(filmRow.blue_user || ""),
      frame: {
        round: 5,
        clock: "running",
        events: [],
        strengths: frameStrengths,
        owners: frameOwners,
      },
    });
    const synthList = await api(ctx.base, alice.token, "/api/matches?limit=20");
    if (!(synthList.data.matches || []).some((row) => row.id === synthId)) {
      fail("pb305 (b): the planted film is not readable by its own account");
    }
    const markSynth = a.box.length;
    const synthFork = await api(ctx.base, alice.token, "/api/matches/" + synthId + "/to-game", { round: 5 });
    if (synthFork.status !== 200 || !synthFork.data.ok) fail("pb305 (b): the planted film was refused: " + JSON.stringify(synthFork.data));
    if (Number(synthFork.data.round) !== 5) fail("pb305 (b): the planted fork starts at round " + synthFork.data.round);
    await waitRoom(a, (value) => Boolean(value) && value.id === synthFork.data.id, "the planted forked room", markSynth);
    const synthStored = roomRow(ctx, synthFork.data.id);
    const synthMatch = synthStored && synthStored.match ? unpackMatch(synthStored.match) : null;
    if (!synthMatch) fail("pb305 (b): the planted fork left no stored match");
    const forked_change = (synthMatch.pieces || []).find((piece) => String(piece.id) === String(change.id));
    if (!forked_change) fail("pb305 (b): the changed unit did not survive the fork");
    if (Number(forked_change.strength) !== changedStrength) {
      fail("pb305 (b): the frame's strength did not land: expected " + changedStrength + ", got " + forked_change.strength);
    }
    if (Number(change.strength) === changedStrength) fail("pb305 (b): the fixture's strength is not a change");
    if (dead && (synthMatch.pieces || []).some((piece) => String(piece.id) === String(dead.id))) {
      fail("pb305 (b): a unit the frame recorded at strength 0 was carried into the game");
    }
    const forked_flip = (synthMatch.sites || []).find((site) => String(site.id) === String(flip.id));
    if (!forked_flip || forked_flip.owner !== "red") {
      fail("pb305 (b): the frame's ownership did not land: " + JSON.stringify(forked_flip && forked_flip.owner));
    }
    if (flip.owner === "red") fail("pb305 (b): the fixture's owner flip is not a change");
    const startByPiece2 = new Map((synthStart.pieces || []).map((piece) => [String(piece.id), piece]));
    for (const piece of synthMatch.pieces || []) {
      const was = startByPiece2.get(String(piece.id));
      if (was && (Number(was.x) !== Number(piece.x) || Number(was.y) !== Number(piece.y))) {
        fail("pb305 (b): the cutover moved a unit the film did not move");
      }
    }
    if (synthMatch.peace && synthMatch.peace.active === true) {
      fail("pb305 (d): a planted mid-war cutover kept the cold war");
    }
    if (!synthMatch.peace && synthStart.peace && synthStart.peace.active === true) {
      // The guard did its job; recorded here so the report can say the start WAS at peace.
      console.log("pb305 (d) detail: the film's start was at peace and the round-5 fork is not");
    }
    await leaveWar(a);


    // ---- (c), the other direction: a red film seats the human on red ---------------------
    const redWar = await finishWar(a, "red", "1986", fail);
    const redPage = await api(ctx.base, alice.token, "/api/matches/" + redWar + "/rounds?from=0");
    const redFrames = Array.isArray(redPage.data.frames) ? redPage.data.frames : [];
    await leaveWar(a);
    const redMid = frameAt(redFrames, Math.min(2, redFrames.length - 2)) || redFrames[0];
    const markRed = a.box.length;
    const redFork = await api(ctx.base, alice.token, "/api/matches/" + redWar + "/to-game", { round: redMid.round });
    if (redFork.status !== 200 || !redFork.data.ok) fail("pb305 (c): the red film was refused: " + JSON.stringify(redFork.data));
    if (redFork.data.side !== "red") fail("pb305 (c): the red film seated the human on " + redFork.data.side);
    const redRoom = await waitRoom(a, (value) => Boolean(value) && value.id === redFork.data.id, "the red forked room", markRed);
    if (redRoom.you !== "red") fail("pb305 (c): the red room says the human is " + redRoom.you);
    if (!redRoom.red || redRoom.red.kind !== "human" || !redRoom.blue || redRoom.blue.kind !== "bot") {
      fail("pb305 (c): the red cutover is not human red / bot blue");
    }
    await leaveWar(a);
  } finally {
    a.close();
    b.close();
  }
}
