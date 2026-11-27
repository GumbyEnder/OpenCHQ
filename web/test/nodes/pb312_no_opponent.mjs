// pb312_no_opponent — a game against "No Opponent" (manual p.35 l.1126-1137):
// "you can actually switch sides during a game. To do this, press Switch Sides. This only works in a
// solo game or a game against 'no opponent.'"
//
// What breaks if this is removed:
//   - the lobby offers no such choice, or the server refuses the word -> the manual's third setup
//     choice is unreachable and PB-309's Switch Sides has only half of its own rule (M2);
//   - the machine is given a seat anyway                          -> it orders a side the player
//                                                                   thought was theirs (M1);
//   - the machine inherits the side a player switches away from   -> the hand-over is a bot game
//                                                                   wearing a "no opponent" label;
//   - five running rounds move a piece nobody ordered             -> the seat is not really empty;
//   - a two-human war starts honouring Switch Sides               -> the manual's own limit is gone;
//   - Show Common is refused there                                -> PB-310's toggle is missing from
//                                                                   the one game the manual names
//                                                                   beside the solo one;
//   - saves or films refuse the war without saying so, or report two players -> the war cannot be
//     kept.
//
// Everything is read from the STORE (the room the server persisted) or from the wire. The bot's own
// decisions are the thing under test, so this leg never asks bot.mjs what it would do: it reads what
// moved.

export const name = "pb312_no_opponent";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFrame(sock, pred, label, from = 0, deadline = 20000) {
  const start = Date.now();
  while (Date.now() - start < deadline) {
    for (const message of sock.box.slice(from)) if (message && pred(message)) return message;
    await sleep(20);
  }
  throw new Error("pb312: " + label + " missing; frames: " + JSON.stringify(
    sock.box.slice(from).map((m) => (m && m.op === "room"
      ? { op: "room", you: m.room && m.room.you, round: m.room && m.room.round }
      : m && m.op)),
  ));
}

async function sendWait(sock, message, pred, label) {
  const mark = sock.box.length;
  sock.send(message);
  return waitFrame(sock, pred, label, mark);
}

async function fire(sock, message) {
  sock.send(message);
  await sleep(250);
}

function storedRoom(ctx, id) {
  const db = ctx.sqlite();
  try {
    const row = db.prepare("SELECT state FROM rooms WHERE id = ?").get(String(id));
    return row ? JSON.parse(row.state) : null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function noRawId(value) {
  return !/(blue|red):[a-z]+:/.test(JSON.stringify(value));
}

// A piece's position and its queued path, in one comparable string. An order that a bot issued
// shows up here as a moved x/y or a non-empty path; a piece nobody ordered is byte-identical.
function place(pieces) {
  return (pieces || [])
    .map((p) => [p.id, p.side, p.x, p.y, (p.path || []).length].join(":"))
    .sort()
    .join("|");
}

async function httpPost(ctx, pathName, body, token) {
  const res = await fetch(ctx.base + pathName, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "openchq_session=" + token },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function httpGet(ctx, pathName, token) {
  const res = await fetch(ctx.base + pathName, {
    headers: token ? { cookie: "openchq_session=" + token } : {},
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Five rounds with the clock running and NO order sent by this leg. Returns the stored room and the
// round it reached.
async function runRounds(sock, ctx, roomId, want, label) {
  await sendWait(sock, { op: "speed", speed: 6 }, (m) => m.op === "room", label + ": the speed frame");
  const from = Number((storedRoom(ctx, roomId) || { match: {} }).match.round) || 0;
  // The mark matters: this socket has carried earlier rooms at higher rounds, and a scan from zero
  // finds THEIR frame and returns a stored room that never advanced.
  const mark = sock.box.length;
  sock.send({ op: "run" });
  await waitFrame(sock, (m) => m.op === "room" && m.room && String(m.room.id) === String(roomId)
    && m.room.clock === "running" && Number(m.room.round) >= from + want,
  label + ": " + want + " rounds", mark, 40000);
  await fire(sock, { op: "hold" });
  const stored = storedRoom(ctx, roomId);
  if (!stored || !stored.match) throw new Error("pb312: " + label + ": the room is not in the store");
  return stored;
}

export async function run(ctx) {
  const { fail } = ctx;

  // ---- (a) the lobby offers it, and the word comes from the config table --------------------
  const setup = (await httpGet(ctx, "/api/setup")).data;
  const noneSpec = setup && setup.bot && setup.bot.none;
  if (!noneSpec || !noneSpec.value) {
    fail("pb312 (a): /api/setup offers no 'no opponent' entry; the lobby has nothing to put in the "
      + "Opponent select. bot keys: " + JSON.stringify(Object.keys((setup && setup.bot) || {})));
  }
  if (!/NO OPPONENT/i.test(String(noneSpec.name))) {
    fail("pb312 (a): the served no-opponent entry is not named NO OPPONENT: " + JSON.stringify(noneSpec));
  }
  const noneValue = String(noneSpec.value);
  if (Number.isInteger(Number(noneValue))) {
    fail("pb312 (a): the no-opponent sentinel is a number, so it collides with the computer levels: " + noneValue);
  }

  const player = await ctx.register("pb312_none");
  const rival = await ctx.register("pb312_rival");
  const sock = ctx.socket(player.token);
  const rivalSock = ctx.socket(rival.token);
  try {
    await sock.wait((m) => m.op === "welcome", "the welcome");
    await rivalSock.wait((m) => m.op === "welcome", "the rival's welcome");
    await fire(sock, { op: "fullframes", on: true });
    await fire(rivalSock, { op: "fullframes", on: true });

    // The opponent's starting-money spinner belongs to an opponent. With none there is nobody to
    // give it to, and the request is answered with a sentence rather than silently ignored.
    const spin = await sendWait(sock, { op: "bot", era: "1942", side: "blue", level: noneValue, handicap: 60 },
      (m) => m.op === "room" || m.op === "error", "the spinner refusal");
    if (spin.op !== "error" || !/nobody to give/i.test(String(spin.error || ""))) {
      fail("pb312 (a): a no-opponent game accepted the opponent's starting money: " + JSON.stringify(spin).slice(0, 300));
    }
    if (!noRawId(spin.error)) fail("pb312 (f): the spinner refusal carries a raw piece id: " + spin.error);

    // ---- (a)(b) the room: no seat for the machine ------------------------------------------
    // 1942 opens at war (match.mjs: 1918/1942 carry no opening peace), so rounds can run without
    // anyone declaring hostilities - the clock, not a bot, is the only mover here.
    const opened = await sendWait(sock, { op: "bot", era: "1942", side: "blue", level: noneValue },
      (m) => m.op === "room" && m.room && m.room.mode === "bot", "the no-opponent room");
    const before = opened.room;
    if (before.you !== "blue" || !before.blue || before.blue.kind !== "human") {
      fail("pb312 (a): the player does not hold the blue seat: " + JSON.stringify({ you: before.you, blue: before.blue }));
    }
    if (!before.red || before.red.kind !== "none") {
      fail("pb312 (a): the other seat is not empty - the machine is in the game: " + JSON.stringify(before.red));
    }
    if (!/no opponent/i.test(String(before.red.username || ""))) {
      fail("pb312 (f): the empty seat is not named in words: " + JSON.stringify(before.red));
    }
    if (!/no opponent/i.test(String(before.note || ""))) {
      fail("pb312 (a): the room does not say the war has no opponent: " + JSON.stringify(before.note));
    }
    if (!noRawId(before.note)) fail("pb312 (f): the room note carries a raw piece id: " + before.note);
    if (before.bot) fail("pb312 (a): the room reports a bot opponent: " + JSON.stringify(before.bot));

    const opening = storedRoom(ctx, before.id);
    if (!opening) fail("pb312 (a): the room is not in the store: " + before.id);
    if (!opening.seats || opening.seats.red.kind !== "none" || opening.seats.blue.kind !== "human") {
      fail("pb312 (a): the stored room seats the machine: " + JSON.stringify(opening.seats));
    }
    if (!opening.match.seats || opening.match.seats.red.kind !== "none") {
      fail("pb312 (a): the MATCH seat table seats the machine: " + JSON.stringify(opening.match.seats));
    }
    if (Number.isInteger(opening.match.opponentLevel)) {
      fail("pb312 (a): a no-opponent match carries an opponent level: " + opening.match.opponentLevel);
    }

    // ---- (b) five running rounds, and nothing the player did not order moves ---------------
    const placeBefore = place(opening.match.pieces);
    const five = await runRounds(sock, ctx, before.id, 5, "(b) first five rounds");
    const placeAfter = place(five.match.pieces);
    if (Number(five.match.round) < 5) {
      fail("pb312 (b): fewer than five rounds ran: round " + five.match.round);
    }
    if (placeAfter !== placeBefore) {
      const moved = (five.match.pieces || []).filter((p) => {
        const was = (opening.match.pieces || []).find((old) => old.id === p.id);
        if (!was) return true;
        return Number(p.x) !== Number(was.x) || Number(p.y) !== Number(was.y)
          || (p.path || []).length !== (was.path || []).length;
      });
      fail("pb312 (b): a piece moved over five rounds with no order given - the machine ordered it: "
        + JSON.stringify(moved.map((p) => ({ id: p.id, side: p.side, x: p.x, y: p.y, path: (p.path || []).length }))).slice(0, 500));
    }
    const botActions = Array.isArray(five.botActions) ? five.botActions : [];
    if (botActions.length) {
      fail("pb312 (b): a seat was played by a bot: " + JSON.stringify(botActions).slice(0, 400));
    }
    console.log("pb312 (b): round " + five.match.round + ", five rounds, no order sent, pieces unchanged ("
      + (five.match.pieces || []).length + " on the board), botActions " + botActions.length);

    // ---- (c) Switch Sides works there, both ways -------------------------------------------
    const flipped = await sendWait(sock, { op: "switch_sides" },
      (m) => m.op === "switched" || m.op === "error", "the no-opponent switch");
    if (flipped.op !== "switched" || flipped.side !== "red" || flipped.left !== "blue") {
      fail("pb312 (c): Switch Sides was refused in a no-opponent game: " + JSON.stringify(flipped).slice(0, 300));
    }
    const swap = storedRoom(ctx, before.id);
    if (!swap || swap.seats.red.kind !== "human" || swap.seats.blue.kind !== "none") {
      fail("pb312 (c): the switch gave the machine the side the player left: " + JSON.stringify(swap && swap.seats));
    }
    if (!/no opponent/i.test(String(flipped.text || ""))) {
      fail("pb312 (c): the switch sentence claims the computer plays the side left behind: " + JSON.stringify(flipped.text));
    }
    if (!noRawId(flipped.text)) fail("pb312 (f): the switch sentence carries a raw piece id: " + flipped.text);

    // A human order on the NEW side is accepted; nothing moves on the side left behind.
    const redPieces = (swap.match.pieces || []).filter((p) => p.side === "red");
    let accepted = null;
    for (const piece of redPieces.slice(0, 5)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const answer = await sendWait(sock, { op: "order", piece: piece.id, to: { x: piece.x + dx, y: piece.y + dy } },
          (m) => m.op === "ordered" || m.op === "error", "the red order");
        if (answer.op === "ordered") { accepted = { piece, answer }; break; }
      }
      if (accepted) break;
    }
    if (!accepted) fail("pb312 (c): the player cannot give an order on the side they switched to");
    const placeHeld = place((storedRoom(ctx, before.id) || {}).match.pieces);

    // Five more rounds: nothing on the side left behind (blue) may move, and no bot may act.
    const seven = await runRounds(sock, ctx, before.id, 5, "(c) five rounds after the switch");
    const blueBefore = (swap.match.pieces || []).filter((p) => p.side === "blue");
    const blueAfter = (seven.match.pieces || []).filter((p) => p.side === "blue");
    const blueMoved = blueAfter.filter((p) => {
      const was = blueBefore.find((old) => old.id === p.id);
      if (!was) return true;
      return Number(p.x) !== Number(was.x) || Number(p.y) !== Number(was.y);
    });
    if (blueMoved.length) {
      fail("pb312 (c): the side nobody holds was played after the switch: "
        + JSON.stringify(blueMoved.map((p) => ({ id: p.id, x: p.x, y: p.y }))).slice(0, 400));
    }
    if (Array.isArray(seven.botActions) && seven.botActions.length) {
      fail("pb312 (c): a bot acted after the switch: " + JSON.stringify(seven.botActions).slice(0, 400));
    }
    console.log("pb312 (c): after the switch round " + seven.match.round + ", blue (nobody's) units unchanged: "
      + blueAfter.length + "; the human's red order landed on " + accepted.piece.id.replace(/.*:/, "") + "");

    // Back the other way.
    const flippedBack = await sendWait(sock, { op: "switch_sides" },
      (m) => m.op === "switched" || m.op === "error", "the switch back");
    if (flippedBack.op !== "switched" || flippedBack.side !== "blue" || flippedBack.left !== "red") {
      fail("pb312 (c): Switch Sides did not work back to blue: " + JSON.stringify(flippedBack).slice(0, 300));
    }
    const back = storedRoom(ctx, before.id);
    if (!back || back.seats.blue.kind !== "human" || back.seats.red.kind !== "none") {
      fail("pb312 (c): the switch back did not leave an empty seat: " + JSON.stringify(back && back.seats));
    }

    // ---- (c) Show Common (PB-310) works in this game ---------------------------------------
    const commonOn = await sendWait(sock, { op: "show_common" },
      (m) => m.op === "show_common" || m.op === "error", "the show common press");
    if (commonOn.op !== "show_common" || commonOn.on !== true) {
      fail("pb312 (c): Show Common was refused in a no-opponent game: " + JSON.stringify(commonOn).slice(0, 300));
    }
    const commonFrame = await waitFrame(sock,
      (m) => m.op === "room" && m.room && m.room.showCommon && m.room.showCommon.on === true,
      "the common room frame", 0, 5000);
    if (!Array.isArray(commonFrame.room.showCommon.spotted)) {
      fail("pb312 (c): the Common frame carries no spotted set: " + JSON.stringify(commonFrame.room.showCommon).slice(0, 300));
    }
    const commonOff = await sendWait(sock, { op: "show_common" },
      (m) => m.op === "show_common" || m.op === "error", "the show common press off");
    if (commonOff.op !== "show_common" || commonOff.on !== false) {
      fail("pb312 (c): Show Common could not be turned off: " + JSON.stringify(commonOff).slice(0, 300));
    }
    if (!noRawId(commonOn.text) || !noRawId(commonOff.text)) {
      fail("pb312 (f): the Show Common sentence carries a raw piece id");
    }
    console.log("pb312 (c): Show Common on/off in the no-opponent war, spotted ids "
      + commonFrame.room.showCommon.spotted.length);

    // ---- (e) saves keep working ------------------------------------------------------------
    const saved = await httpPost(ctx, "/api/slots", { name: "pb312 no opponent" }, player.token);
    if (saved.status !== 200 || !saved.data || !saved.data.ok) {
      fail("pb312 (e): saving a no-opponent war failed without a usable answer: "
        + JSON.stringify(saved.data).slice(0, 400));
    }
    const slots = await httpGet(ctx, "/api/slots", player.token);
    const slot = (slots.data && Array.isArray(slots.data.slots) ? slots.data.slots : [])
      .find((row) => /pb312 no opponent/i.test(String(row.name)));
    if (!slot) fail("pb312 (e): the saved war is not listed: " + JSON.stringify(slots.data).slice(0, 400));
    const players = Array.isArray(slot.players) ? slot.players : [];
    const humans = players.filter((p) => p.kind === "human");
    if (humans.length !== 1) {
      fail("pb312 (e): the saved war claims " + humans.length + " human players: " + JSON.stringify(players));
    }
    const empty = players.filter((p) => p.kind === "none");
    if (empty.length !== 1 || !/no opponent/i.test(String(empty[0].name))) {
      fail("pb312 (e): the saved war does not name the empty seat: " + JSON.stringify(players));
    }
    console.log("pb312 (e): saved at round " + slot.round + "; players " + JSON.stringify(players.map((p) => p.kind + ":" + p.name)));

    // ---- (e) films keep working: a finished war is listed ---------------------------------
    await sendWait(sock, { op: "resign" }, (m) => m.op === "room" && m.room && m.room.over === true,
      "the resignation");
    await sleep(400);
    const films = await httpGet(ctx, "/api/matches", player.token);
    const list = Array.isArray(films.data) ? films.data
      : Array.isArray(films.data && films.data.matches) ? films.data.matches : [];
    const film = list.find((row) => String(row.id) === String(before.id));
    if (!film) {
      fail("pb312 (e): the finished no-opponent war is not in War Films: " + JSON.stringify(films.data).slice(0, 400));
    }
    if (!/no opponent/i.test(String(film.red_user || film.redUser || ""))
      && !/no opponent/i.test(JSON.stringify(film).slice(0, 600))) {
      fail("pb312 (e): the film does not record the empty seat in words: " + JSON.stringify(film).slice(0, 400));
    }
    console.log("pb312 (e): the film is listed at round " + (film.rounds ?? film.round) + ", mode " + film.mode);
    await fire(sock, { op: "leave" });

    // PB-312 (e): Film to Game is "a game against the computer" (PB-305). A no-opponent film has no
    // computer in it, so the fork is refused with a sentence instead of silently seating a bot on the
    // side nobody held. Measured, not read from the diff.
    const fork = await httpPost(ctx, "/api/matches/" + before.id + "/to-game", { round: 0 }, player.token);
    if (fork.status === 200) {
      fail("pb312 (e): a no-opponent film forked into a game - the side nobody held was given to a bot: "
        + JSON.stringify(fork.data).slice(0, 300));
    }
    if (!/no opponent/i.test(String((fork.data && fork.data.error) || ""))) {
      fail("pb312 (e): the Film to Game refusal does not say why: " + JSON.stringify(fork.data).slice(0, 300));
    }
    if (!noRawId(fork.data && fork.data.error)) fail("pb312 (f): the Film to Game refusal carries a raw piece id");
    console.log("pb312 (e): Film to Game on that film: " + fork.status + " " + fork.data.error);

    // ---- (b2) MEASURED: the opening destinations in a no-opponent war ------------------------
    // The card's open question: do the pre-placed opening destinations still move? This build never
    // pre-places one for the computer - a starting destination is only ever a player's own op. What
    // is measured here is the launch rule itself: both sides' starting destinations become orders at
    // Begin Hostilities, the empty seat's included, because the human set that one while holding the
    // side. 1986 opens at the cold war, so the press is the human's (there is no bot to press it).
    const cold = await sendWait(sock, { op: "bot", era: "1986", side: "blue", level: noneValue },
      (m) => m.op === "room" && m.room && m.room.mode === "bot", "the 1986 no-opponent war");
    const coldRoom = cold.room;
    const coldStored = storedRoom(ctx, coldRoom.id);
    if (!coldStored || !coldStored.match.peace || coldStored.match.peace.active !== true) {
      fail("pb312 (b2): the 1986 war did not open at the cold war: "
        + JSON.stringify(coldStored && coldStored.match.peace));
    }
    // A destination the server accepts, on the side this seat holds.
    async function placeDestination(side) {
      const stored = storedRoom(ctx, coldRoom.id);
      const pieces = (stored.match.pieces || []).filter((p) => p.side === side && !p.path.length);
      for (const piece of pieces.slice(0, 8)) {
        for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0], [0, -2], [0, 2], [2, 0], [-2, 0]]) {
          const answer = await sendWait(sock, { op: "destination", piece: piece.id, to: { x: piece.x + dx, y: piece.y + dy } },
            (m) => m.op === "destination" || m.op === "error", "the " + side + " destination");
          if (answer.op === "destination") return { piece, answer };
        }
      }
      return null;
    }
    const blueDest = await placeDestination("blue");
    if (!blueDest) fail("pb312 (b2): no blue starting destination could be set");
    await sendWait(sock, { op: "switch_sides" }, (m) => m.op === "switched", "the 1986 switch to red");
    const redDest = await placeDestination("red");
    if (!redDest) fail("pb312 (b2): no red starting destination could be set while holding red");
    await sendWait(sock, { op: "switch_sides" }, (m) => m.op === "switched", "the 1986 switch back");
    const beforeLaunch = storedRoom(ctx, coldRoom.id);
    const pending = (beforeLaunch.match.pieces || []).filter((p) => p.startingDestination).length;
    if (pending < 2) fail("pb312 (b2): the two destinations did not both stick: " + pending);
    const declared = await sendWait(sock, { op: "resume_war" },
      (m) => (m.op === "room" && m.room && m.room.peace && m.room.peace.active === false) || m.op === "error",
      "the Begin Hostilities press in a no-opponent war");
    if (declared.op === "error") fail("pb312 (b2): Begin Hostilities was refused: " + JSON.stringify(declared).slice(0, 300));
    const launched = storedRoom(ctx, coldRoom.id);
    const launchedPieces = launched.match.pieces || [];
    const blueLaunched = launchedPieces.find((p) => p.id === blueDest.piece.id) || {};
    const redLaunched = launchedPieces.find((p) => p.id === redDest.piece.id) || {};
    if (!(blueLaunched.path || []).length || !(redLaunched.path || []).length) {
      fail("pb312 (b2): a starting destination did not become an order at Begin Hostilities: "
        + JSON.stringify({ blue: (blueLaunched.path || []).length, red: (redLaunched.path || []).length }));
    }
    const launchedRun = await runRounds(sock, ctx, coldRoom.id, 2, "(b2) two rounds after the launch");
    const afterLaunch = launchedRun.match.pieces || [];
    const blueAfterLaunch = afterLaunch.find((p) => p.id === blueDest.piece.id) || {};
    const redAfterLaunch = afterLaunch.find((p) => p.id === redDest.piece.id) || {};
    const movedAfterLaunch = [blueAfterLaunch, redAfterLaunch].filter((p, i) => {
      const was = i === 0 ? blueDest.piece : redDest.piece;
      return Number(p.x) !== Number(was.x) || Number(p.y) !== Number(was.y);
    }).length;
    console.log("pb312 (b2): starting destinations " + pending + " pending at the press; launched blue "
      + (blueLaunched.path || []).length + " / red " + (redLaunched.path || []).length + " step(s); after "
      + launchedRun.match.round + " rounds " + movedAfterLaunch + " of 2 units had left their opening cell");
    if (movedAfterLaunch < 2) {
      fail("pb312 (b2): a launched starting destination did not move its unit: "
        + JSON.stringify({ blue: blueAfterLaunch, red: redAfterLaunch }).slice(0, 400));
    }
    await fire(sock, { op: "leave" });

    // ---- (d) a two-human war still refuses Switch Sides ------------------------------------
    const invite = await sendWait(rivalSock, { op: "invite", user: player.user.username, era: "1942", side: "red" },
      (m) => m.op === "invited" || m.op === "error", "the invite");
    if (invite.op !== "invited") fail("pb312 (d): the invite was refused: " + JSON.stringify(invite).slice(0, 200));
    const offer = await sock.wait((m) => m.op === "invite", "the invite frame");
    await sendWait(sock, { op: "answer", id: offer.invite.id, accept: true }, (m) => m.op === "room", "the two-human room");
    const two = (sock.box.filter((m) => m && m.op === "room" && m.room).pop() || {}).room;
    if (!two || two.mode !== "human") fail("pb312 (d): the invite did not open a human room: " + JSON.stringify(two && two.mode));
    const refused = await sendWait(sock, { op: "switch_sides" },
      (m) => m.op === "switched" || m.op === "error", "the 2P refusal");
    if (refused.op !== "error" || !/only works in a solo game/i.test(String(refused.error || ""))) {
      fail("pb312 (d): a two-human war did not refuse Switch Sides: " + JSON.stringify(refused).slice(0, 300));
    }
    if (!/two-player/i.test(String(refused.error || ""))) {
      fail("pb312 (d): the refusal does not say why: " + refused.error);
    }
    if (!noRawId(refused.error)) fail("pb312 (f): the refusal carries a raw piece id: " + refused.error);
    console.log("pb312 (d): the two-human refusal: " + refused.error);
    await fire(sock, { op: "leave" });
    await fire(rivalSock, { op: "leave" });
  } finally {
    try { sock.close(); } catch { /* already closed */ }
    try { rivalSock.close(); } catch { /* already closed */ }
  }
}
