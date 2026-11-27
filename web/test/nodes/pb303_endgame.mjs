// pb303_endgame — the end of the game, as the tick writes it and as the seat reads it.
// Manual p.6 l.114 ("the game ends when one side holds every capital"), p.17 l.475 (and not one
// capital before it; a neutral capital blocks both sides), l.442 (in the concealed year the enemy's
// capital is hidden from the seat's board - the end check still reads the REAL capitals).
//
// PB-294 pins the producer: checkWin() over the file eras, the neutral-capital rule, and the
// concealed year's real-set read. This module is the delivery twin, the way PB-302 is the lane-and-
// step twin of PB-283: one tick that a player could produce, then everything a player is TOLD.
//
// What breaks if this is removed:
//   - the match ends, but the seat is never told which capital fell   -> an end screen with no cause;
//   - the losing seat is not told the war is over                     -> a seat plays on past the end;
//   - a plane alone over a capital, or a contested capital, ends it    -> a win the ground disagrees with;
//   - a finished war comes back from the store with no result         -> the end screen after a restart.
//
// Deterministic by construction: every arm places one piece and runs exactly ONE tick. No sweep, no
// wander, no clock left running across arms.
import { warMatch } from "../wartime.mjs";
import { matchSites } from "../../server/board.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { forSeat, resultOf, resultNote } from "../../server/view.mjs";
import { saveRoom, loadRooms } from "../../server/rooms.mjs";

export const name = "pb303_endgame";

const FOLDED = /(blue|red):[a-z]/;
const capitalsOf = (match) => (match.capitalSet && Array.isArray(match.capitalSet.list) ? match.capitalSet.list : []);
const siteOf = (match, capital) => (match.sites || []).find((site) => Number(site.id) === Number(capital.siteId));

function board(era) {
  const match = warMatch(era, matchSites(era));
  seedOwners(match);
  match.pieces = [];
  match.round = 5;
  match.clock = "running";
  if (!capitalsOf(match).length) throw new Error("pb303: " + era + " carries no capital set");
  return match;
}

function foot(side, x, y, tag) {
  return {
    id: side + ":inf:" + tag, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1,
    facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100,
  };
}

function plane(side, x, y, tag) {
  return {
    id: side + ":air:" + tag, side, domain: "air", kind: "aircraft", x, y, path: [], pace: 1,
    facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100,
  };
}

export async function run(ctx) {
  const { fail } = ctx;

  // ---- l.114: the round that takes the last capital ends the war, and says which one ----------
  for (const era of ["1942", "1986"]) {
    const match = board(era);
    const capitals = capitalsOf(match);
    if (capitals.length < 2) fail("pb303: " + era + " carries " + capitals.length + " capitals; the arm needs a set");
    for (const capital of capitals) siteOf(match, capital).owner = "blue";
    const last = capitals[capitals.length - 1];
    const target = siteOf(match, last);
    target.owner = "red";
    match.pieces = [foot("blue", target.x, target.y, "last")];
    const beforeRound = match.round;
    const { events } = tickMatch(match);
    if (match.round !== beforeRound + 1) {
      fail("pb303 l.114: " + era + " one tick moved the round " + beforeRound + " -> " + match.round + " (expected exactly one)");
    }
    if (match.over !== true || match.winner !== "blue") {
      fail("pb303 l.114: " + era + " taking " + target.name + " did not end the war (over " + JSON.stringify(match.over)
        + ", winner " + JSON.stringify(match.winner) + ")");
    }
    const reason = match.winReason || {};
    if (reason.kind !== "capitals" || Number(reason.siteId) !== Number(last.siteId) || String(reason.name) !== String(target.name)) {
      fail("pb303 l.114: " + era + " the end named " + JSON.stringify(reason) + ", not " + last.siteId + " " + target.name);
    }
    if (Number(reason.round) !== match.round) {
      fail("pb303 l.114: " + era + " the end is dated round " + JSON.stringify(reason.round) + ", the board is at " + match.round);
    }
    if (!events.some((event) => event && event.type === "win" && Number(event.site) === Number(last.siteId))) {
      fail("pb303 l.114: " + era + " the round emitted no win event naming site " + last.siteId + ": " + JSON.stringify(events.map((e) => e && e.type)));
    }

    // The player's copy: the result and the one sentence, off the same match.
    const result = resultOf(match);
    if (!result || result.reason !== "capitals" || result.winner !== "blue") {
      fail("pb303 l.114: " + era + " the seat's result is " + JSON.stringify(result));
    }
    if (!result.lastCapital || String(result.lastCapital.name) !== String(target.name)) {
      fail("pb303 l.114: " + era + " the seat's result names " + JSON.stringify(result.lastCapital) + ", not " + target.name);
    }
    if (result.capitals.length !== capitals.length || result.capitals.some((row) => row.owner !== "blue")) {
      fail("pb303 l.114: " + era + " the result's capital list is not every capital held by blue: " + JSON.stringify(result.capitals));
    }
    const note = resultNote(match);
    const want = "wins: " + target.name + " fell at round " + match.round;
    if (!note.includes(want)) {
      fail("pb303 l.114: " + era + " the end sentence \"" + note + "\" does not carry \"" + want + "\"");
    }
    if (!new RegExp("holds every capital \\(" + capitals.length + " of " + capitals.length + "\\)").test(note)) {
      fail("pb303 l.114: " + era + " the end sentence does not count the set: " + note);
    }
    // The LOSER is told, and told the same cause - a seat that plays on past the end is a defect of
    // its own (the served page has been seen playing on for ten minutes).
    const loser = forSeat(match, "red");
    if (loser.over !== true || loser.winner !== "blue") {
      fail("pb303 l.114: " + era + " the losing seat reads over " + JSON.stringify(loser.over) + " winner " + JSON.stringify(loser.winner));
    }
    if (!loser.result || loser.result.reason !== "capitals" || !loser.result.lastCapital
      || String(loser.result.lastCapital.name) !== String(target.name)) {
      fail("pb303 l.114: " + era + " the losing seat is not told which capital fell: " + JSON.stringify(loser.result));
    }
    // AC6: nothing on the new surfaces carries a raw unit id.
    if (FOLDED.test(note) || FOLDED.test(JSON.stringify(result))) {
      fail("pb303 AC6: " + era + " a player-facing end-of-game string carries a side:kind id");
    }
    // A finished war is frozen: the next tick moves neither the round nor anything else.
    const frozenRound = match.round;
    const second = tickMatch(match);
    if (match.round !== frozenRound || (second.events || []).length) {
      fail("pb303 l.114: " + era + " a finished war still ran a round (" + frozenRound + " -> " + match.round + ", "
        + (second.events || []).length + " events)");
    }
    console.log("pb303 arm (l.114) ok: " + era + " — one round took " + target.name
      + ", ended the war blue, named it to both seats, and froze");
  }

  // ---- a plane alone over the last capital does not take it, and does not end the war ---------
  {
    const match = board("1986");
    const capitals = capitalsOf(match);
    for (const capital of capitals) siteOf(match, capital).owner = "blue";
    const last = capitals[capitals.length - 1];
    const target = siteOf(match, last);
    target.owner = "red";
    // An aircraft shares a cell (T-021) but does not hold its streets: occupy counts the GROUND layer.
    match.pieces = [plane("blue", target.x, target.y, "over")];
    tickMatch(match);
    if (target.owner !== "red") {
      fail("pb303: a plane alone over " + target.name + " flipped the site to " + JSON.stringify(target.owner));
    }
    if (match.over) fail("pb303: a plane alone over the last capital ended the war");
    console.log("pb303 arm (air) ok: a plane over " + target.name + " neither takes the cell nor ends the war");
  }

  // ---- a contested capital is not taken, and does not end the war -----------------------------
  {
    const match = board("1986");
    const capitals = capitalsOf(match);
    for (const capital of capitals) siteOf(match, capital).owner = "blue";
    const last = capitals[capitals.length - 1];
    const target = siteOf(match, last);
    target.owner = "red";
    match.pieces = [foot("blue", target.x, target.y, "contest"), foot("red", target.x, target.y, "hold")];
    tickMatch(match);
    if (target.owner !== "red") {
      fail("pb303: a contested capital (" + target.name + ") changed hands to " + JSON.stringify(target.owner));
    }
    if (match.over) fail("pb303: a contested capital ended the war for a side that does not hold it");
    console.log("pb303 arm (contest) ok: blue and red on " + target.name + " leave it red and the war running");
  }

  // ---- l.442: the concealed year - the capital is hidden, the end still reads the real set -----
  {
    const match = board("9999");
    const capitals = capitalsOf(match);
    if (capitals.length !== 2) fail("pb303 l.442: the concealed year drew " + capitals.length + " capitals, expected the pair");
    if (match.capitalSet.source !== "rolled") {
      fail("pb303 l.442: the concealed year's set is " + JSON.stringify(match.capitalSet.source) + ", expected the rolled draw");
    }
    const [home, enemy] = capitals;
    siteOf(match, home).owner = "blue";
    siteOf(match, enemy).owner = "red";
    const enemySite = siteOf(match, enemy);
    // Blue has nothing anywhere near red's capital: the seat's board must not show it.
    const far = { x: (Number(enemySite.x) + 40) % 320, y: Number(enemySite.y) };
    match.pieces = [foot("blue", far.x, far.y, "away"), foot("red", enemySite.x, enemySite.y, "hidden")];
    const idsBefore = capitals.map((capital) => String(capital.siteId)).join(",");
    const before = forSeat(match, "blue");
    if ((before.pieces || []).some((piece) => piece && piece.side === "red")) {
      fail("pb303 l.442: the concealed seat saw a red piece on red's hidden capital");
    }
    if (!(before.notes || []).some((line) => /has not been found/.test(String(line)))) {
      fail("pb303 l.442: the concealed seat's notes do not say the other side is unfound: " + JSON.stringify(before.notes));
    }
    // One round later the same seat holds both capitals - the end names the capital it was never shown.
    match.pieces = [foot("blue", enemySite.x, enemySite.y, "takes")];
    tickMatch(match);
    if (!match.over || match.winner !== "blue") {
      fail("pb303 l.442: taking the concealed capital did not end the war (over " + JSON.stringify(match.over)
        + ", winner " + JSON.stringify(match.winner) + ")");
    }
    const concealedReason = match.winReason || {};
    if (concealedReason.kind !== "capitals" || Number(concealedReason.siteId) !== Number(enemy.siteId)
      || String(concealedReason.name) !== String(enemySite.name)) {
      fail("pb303 l.442: the concealed year's end named " + JSON.stringify(concealedReason) + ", not the real capital "
        + enemy.siteId + " " + enemySite.name);
    }
    const concealedResult = resultOf(match);
    if (!concealedResult || concealedResult.reason !== "capitals" || !concealedResult.lastCapital
      || String(concealedResult.lastCapital.name) !== String(enemySite.name)) {
      fail("pb303 l.442: the concealed year's seat result names " + JSON.stringify(concealedResult && concealedResult.lastCapital));
    }
    const after = forSeat(match, "blue");
    if (!after.over || after.winner !== "blue") fail("pb303 l.442: the seat that won the concealed war is not told");
    const idsAfter = capitalsOf(match).map((capital) => String(capital.siteId)).join(",");
    if (idsBefore !== idsAfter) fail("pb303 l.442: building the seat's view changed the capital set (" + idsBefore + " -> " + idsAfter + ")");
    console.log("pb303 arm (l.442) ok: blue never saw red's capital, took it in one round, and the end named "
      + enemySite.name + " from the real set");
  }

  // ---- the store: a finished war comes back finished, with its cause ---------------------------
  {
    const match = board("1986");
    const capitals = capitalsOf(match);
    for (const capital of capitals) siteOf(match, capital).owner = "blue";
    const last = capitals[capitals.length - 1];
    const target = siteOf(match, last);
    target.owner = "red";
    match.pieces = [foot("blue", target.x, target.y, "store")];
    tickMatch(match);
    if (!match.over) fail("pb303 store: the fixture did not end before the store arm");
    const roomId = "pb303-finished-" + Date.now().toString(36);
    saveRoom({
      id: roomId, mode: "bot", era: "1986", clock: match.clock, note: "",
      seats: { blue: { username: "pb303_store", kind: "human" }, red: { username: "Bot", kind: "bot" } },
      holds: { blue: false, red: false }, holdRoom: false, speed: 1, match,
    });
    const reloaded = loadRooms().find((room) => room.id === roomId);
    if (!reloaded) fail("pb303 store: saveRoom wrote a row loadRooms did not return");
    const back = reloaded.match;
    if (!back || back.over !== true || back.winner !== "blue") {
      fail("pb303 store: the finished war came back over " + JSON.stringify(back && back.over)
        + " winner " + JSON.stringify(back && back.winner));
    }
    const backReason = back.winReason || {};
    if (backReason.kind !== "capitals" || Number(backReason.siteId) !== Number(last.siteId)) {
      fail("pb303 store: the reloaded war lost its cause: " + JSON.stringify(backReason));
    }
    const backResult = resultOf(back);
    const backNote = resultNote(back);
    if (!backResult || backResult.reason !== "capitals" || !backResult.lastCapital
      || String(backResult.lastCapital.name) !== String(target.name)) {
      fail("pb303 store: the reloaded result names " + JSON.stringify(backResult && backResult.lastCapital));
    }
    if (!backNote.includes(target.name + " fell at round")) {
      fail("pb303 store: the reloaded end sentence lost the capital: " + backNote);
    }
    console.log("pb303 arm (store) ok: the finished war reloaded over/winner/cause intact - \"" + backNote + "\"");
  }
}
